import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { DelegationConfig } from './config.js';
import { canonicalJsonSha256 } from './canonical-json.js';
import {
  CancellationRequestedError,
} from './durable-record-store.js';
import { DurableExecutionCoordinator } from './durable-execution.js';
import { isTerminalStatus } from './execution-status.js';
import { DurableEventSubscription } from './durable-subscription.js';
import { artifactReadIdentity } from './artifact-read.js';
import { assertJsonMetadata } from './metadata.js';
import {
  MAX_PROMPT_BYTES,
  RecordSizeLimitError,
  assertTextLimit,
  limitErrorDetails,
  limitEventData,
  utf8Bytes,
} from './record-limits.js';
import { buildQualityReviewPrompt, parseQualityReview } from './quality-review.js';
import { composeDelegationPlan, validateTaskAssessment } from './delegation-policy.js';
import {
  isOrchestrationDelegationOverride,
  type AgentKnotDelegationMetadata,
  type ArtifactValidationIdentity,
  type OrchestrationArtifactValidation,
  type OrchestrationArtifactReview,
  type OrchestrationChild,
  type OrchestrationEvent,
  type OrchestrationEventType,
  type OrchestrationRecord,
  type OrchestrationRequest,
  type OrchestrationQualityReview,
  type OrchestrationStore,
  type PlannedSubtask,
  type StartOrchestrationResult,
} from './orchestration-types.js';
import { JobPersistenceError, type Orchestrator } from './orchestrator.js';
import { Semaphore } from './semaphore.js';
import type { JobRecord } from './types.js';

export interface OrchestrationServiceOptions {
  config: DelegationConfig;
  jobs: Orchestrator;
  store: OrchestrationStore;
  now?: () => Date;
  leaseTtlMs?: number;
  leaseHeartbeatMs?: number;
}

interface ActiveChild {
  child: OrchestrationChild;
  cancel: () => Promise<void>;
  completion: Promise<{ job?: JobRecord; error?: unknown }>;
}

interface ActiveOrchestration {
  completion: Promise<OrchestrationRecord>;
  cancel: (source: string) => Promise<void>;
}

interface PersistedRecordMutation {
  apply: () => void;
  rollback: () => void;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Orchestration cancelled');
}

function delayWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Orchestration recovery aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeRequest(request: OrchestrationRequest): OrchestrationRequest {
  if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
    throw new Error('Orchestration prompt must be a non-empty string');
  }
  if (typeof request.workspace !== 'string' || request.workspace.trim() === '') {
    throw new Error('Orchestration workspace must be a non-empty string');
  }
  if (request.assessment === undefined) {
    throw new Error('Orchestration controller assessment is required');
  }
  const assessment = validateTaskAssessment(request.assessment);
  assertTextLimit('Orchestration prompt', request.prompt, MAX_PROMPT_BYTES);
  if (
    request.delegation !== undefined &&
    !isOrchestrationDelegationOverride(request.delegation)
  ) {
    throw new Error('Orchestration delegation must be "inherit", "never", "suggest", or "force"');
  }
  if (request.metadata !== undefined) assertJsonMetadata(request.metadata);
  if (request.idempotencyKey !== undefined) {
    if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.trim() === '') {
      throw new Error('Orchestration idempotencyKey must be a non-empty string');
    }
    assertTextLimit('Orchestration idempotencyKey', request.idempotencyKey, 256);
  }
  return {
    prompt: request.prompt,
    workspace: path.resolve(request.workspace),
    assessment,
    ...(request.source === undefined ? {} : { source: request.source }),
    ...(request.metadata === undefined ? {} : { metadata: structuredClone(request.metadata) }),
    ...(request.delegation === undefined ? {} : { delegation: request.delegation }),
    ...(request.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: request.idempotencyKey }),
  };
}

export class OrchestrationService {
  readonly #config: DelegationConfig;
  readonly #jobs: Orchestrator;
  readonly #store: OrchestrationStore;
  readonly #now: () => Date;
  readonly #runtimeId = randomUUID();
  readonly #artifactValidationSlots = new Semaphore(1);
  readonly #recordMutations = new Map<string, Promise<void>>();
  readonly #activeOrchestrations = new Map<string, ActiveOrchestration>();
  readonly #durability: DurableExecutionCoordinator<OrchestrationRecord>;
  readonly #subscriptions: DurableEventSubscription<OrchestrationEvent, OrchestrationRecord>;

  constructor(options: OrchestrationServiceOptions) {
    if (options.config.mode !== 'off' && options.jobs.workspaceIsolationMode() !== 'git-worktree') {
      throw new Error('Automatic orchestration requires a job orchestrator with git-worktree isolation');
    }
    this.#config = structuredClone(options.config);
    this.#jobs = options.jobs;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#durability = new DurableExecutionCoordinator(this.#store, {
      now: this.#now,
      ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
      ...(options.leaseHeartbeatMs === undefined
        ? {}
        : { leaseHeartbeatMs: options.leaseHeartbeatMs }),
    });
    this.#subscriptions = new DurableEventSubscription(this.#store, (record) =>
      isTerminalStatus(record.status)
    );
  }

  policy(): DelegationConfig {
    return structuredClone(this.#config);
  }

  async get(id: string): Promise<OrchestrationRecord | undefined> {
    return this.#store.get(id);
  }

  async list(): Promise<OrchestrationRecord[]> {
    return this.#store.list();
  }

  async wait(
    id: string,
    timeoutMs = 5_000,
    signal?: AbortSignal
  ): Promise<OrchestrationRecord | undefined> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
      throw new Error('Orchestration wait timeout must be an integer between 0 and 60000');
    }
    return this.#subscriptions.wait(id, timeoutMs, signal === undefined ? {} : { signal });
  }

  eventsAfter(id: string, sequence: number): Promise<OrchestrationEvent[]> {
    return this.#subscriptions.eventsAfter(id, sequence);
  }

  subscribe(
    id: string,
    afterSequence = 0,
    signal?: AbortSignal
  ): AsyncIterable<OrchestrationEvent> {
    return this.#subscriptions.subscribe(
      id,
      afterSequence,
      signal === undefined ? {} : { signal }
    );
  }

  async cancel(id: string, source = 'controller'): Promise<boolean> {
    const current = await this.#store.get(id);
    if (current === undefined || isTerminalStatus(current.status)) return false;
    const active = this.#activeOrchestrations.get(id);
    if (active !== undefined) {
      await active.cancel(source);
      return true;
    }
    if (this.#durability.enabled) {
      const accepted = await this.#durability.requestCancellation(id, source);
      if (accepted === undefined) return false;
      return true;
    }
    return false;
  }

  async shutdown(): Promise<void> {
    const active = [...this.#activeOrchestrations.values()];
    await Promise.allSettled(active.map((item) => item.cancel('kernel-shutdown')));
    await Promise.allSettled(active.map((item) => item.completion));
  }

  hasActiveOrchestrations(): boolean {
    return this.#activeOrchestrations.size > 0;
  }

  async #waitUntilTerminal(id: string): Promise<OrchestrationRecord> {
    const record = await this.#subscriptions.awaitTerminal(id);
    if (record === undefined) throw new Error(`Orchestration ${id} disappeared while waiting`);
    return record;
  }

  async #save(record: OrchestrationRecord): Promise<void> {
    await this.#durability.save(record);
    this.#subscriptions.notifyPersisted(record.id);
  }

  #startLeaseMonitor(
    record: OrchestrationRecord,
    controller: AbortController,
    cancel: (source: string, requestedAt: string, persist: boolean) => Promise<void>
  ): () => Promise<void> {
    return this.#durability.monitor(record.id, controller, (cancellation) =>
      cancel(cancellation.source, cancellation.requestedAt, false)
    );
  }

  async recoverInterruptedOrchestrations(
    options: { waitForLease?: boolean; signal?: AbortSignal } = {}
  ): Promise<OrchestrationRecord[]> {
    if (!this.#durability.enabled) {
      throw new Error('Orchestration recovery requires a durable execution store');
    }
    const recovered: OrchestrationRecord[] = [];
    for (const listed of await this.#store.list()) {
      if (!['queued', 'planning', 'dispatching'].includes(listed.status)) continue;
      if (this.#activeOrchestrations.has(listed.id)) continue;
      const lease = await this.#claimRecoveryLease(listed.id, options);
      if (lease === undefined) continue;
      let record = listed;
      let activated = false;
      try {
        const current = await this.#store.get(record.id);
        if (current === undefined) {
          throw new Error(`Orchestration ${record.id} disappeared after its recovery lease was claimed`);
        }
        if (isTerminalStatus(current.status)) continue;
        record = current;
        const previousStatus = record.status;
        const previousExecution = record.execution;
        if (
          previousStatus === 'planning' ||
          record.plan === undefined ||
          (record.plan.willDispatch && record.workspaceSnapshot === undefined)
        ) {
          const message =
            previousStatus === 'planning'
              ? 'Historical planning-state Orchestration cannot be recovered without an admitted plan boundary'
              : 'Orchestration has no immutable admitted plan and workspace boundary for recovery';
          await this.#settleRecoveryFailure(record, message, previousStatus);
          recovered.push(structuredClone(record));
          continue;
        }
        record.execution = {
          runtimeId: this.#runtimeId,
          pid: process.pid,
          startedAt: this.#now().toISOString(),
        };
        await this.#appendEvent(record, 'orchestration.recovery.started', {
          previousStatus,
          previousRuntimeId: previousExecution.runtimeId,
          recoveryFence: lease.fence,
          planHash: record.plan.planHash,
        });
        const controller = new AbortController();
        const cancellation = await this.#durability.getCancellation(record.id);
        if (cancellation !== undefined) {
          record.cancelRequestedAt = cancellation.requestedAt;
          await this.#appendEvent(
            record,
            'orchestration.cancel.requested',
            { source: cancellation.source },
            cancellation.requestedAt
          );
          controller.abort(new Error('Orchestration cancelled before recovery'));
        }
        const started = this.#activate(record, controller);
        activated = true;
        recovered.push(started.orchestration);
      } finally {
        if (!activated) await this.#durability.release(record.id);
      }
    }
    return recovered;
  }

  async #claimRecoveryLease(
    recordId: string,
    options: { waitForLease?: boolean; signal?: AbortSignal }
  ): Promise<Awaited<ReturnType<DurableExecutionCoordinator<OrchestrationRecord>['claim']>>> {
    while (true) {
      if (options.signal?.aborted) throw options.signal.reason;
      const claimed = await this.#durability.claim(recordId, this.#runtimeId);
      if (claimed !== undefined || options.waitForLease !== true) return claimed;
      const current = await this.#durability.getLease(recordId);
      const expiresAt = current === undefined ? NaN : Date.parse(current.expiresAt);
      const waitMs = Number.isFinite(expiresAt)
        ? Math.max(1, expiresAt - this.#now().getTime())
        : 1;
      await delayWithSignal(waitMs, options.signal);
    }
  }

  async #settleRecoveryFailure(
    record: OrchestrationRecord,
    message: string,
    previousStatus: OrchestrationRecord['status']
  ): Promise<void> {
    for (const child of record.children) {
      if (isTerminalStatus(child.status)) continue;
      const job = await this.#jobs.get(child.jobId);
      if (job === undefined || !isTerminalStatus(job.status)) continue;
      child.status = job.status;
      if (job.result !== undefined) child.output = job.result.output;
      if (job.error !== undefined) child.error = structuredClone(job.error);
    }
    if (record.qualityReview?.status === 'pending') {
      await this.#unavailableQualityReview(record, {
        route: record.qualityReview.route,
        childJobId: record.qualityReview.childJobId,
        reviewerJobId: record.qualityReview.reviewerJobId,
        reason: 'runtime-restart',
      });
    }
    if (record.artifactValidation?.status === 'pending') {
      await this.#unavailableArtifactValidation(record, {
        childJobId: record.artifactValidation.childJobId,
        artifact: structuredClone(record.artifactValidation.artifact),
        reason: 'runtime-restart',
        cleanup: 'not-confirmed',
      });
    }
    record.status = 'failed';
    record.completedAt = this.#now().toISOString();
    record.error = { name: 'RecoveryStateError', message };
    delete record.result;
    await this.#appendEvent(
      record,
      'orchestration.failed',
      { name: 'RecoveryStateError', message, reason: 'recovery-state-unavailable', previousStatus },
      record.completedAt
    );
  }

  async run(request: OrchestrationRequest): Promise<OrchestrationRecord> {
    return (await this.start(request)).completion;
  }

  async start(request: OrchestrationRequest): Promise<StartOrchestrationResult> {
    const normalized = normalizeRequest(request);
    const workspace = await stat(normalized.workspace).catch(() => undefined);
    if (!workspace?.isDirectory()) {
      throw new Error(`Orchestration workspace is not a directory: ${normalized.workspace}`);
    }

    const now = this.#now().toISOString();
    const id = `orchestration_${randomUUID()}`;
    const plan = composeDelegationPlan(normalized, normalized.assessment, this.#config);
    let workspaceSnapshot: OrchestrationRecord['workspaceSnapshot'];
    if (plan.willDispatch && plan.subtasks.length > 0) {
      workspaceSnapshot = await this.#jobs.captureWorkspaceSnapshot(normalized.workspace, id);
    }
    const record: OrchestrationRecord = {
      id,
      schemaVersion: 1,
      status: 'queued',
      request: normalized,
      policy: structuredClone(this.#config),
      createdAt: now,
      updatedAt: now,
      execution: { runtimeId: this.#runtimeId, pid: process.pid, startedAt: now },
      events: [
        {
          sequence: 1,
          orchestrationId: id,
          at: now,
          type: 'orchestration.queued',
          data: { source: normalized.source ?? 'unknown', mode: this.#config.mode },
        },
      ],
      plan,
      ...(workspaceSnapshot === undefined ? {} : { workspaceSnapshot }),
      children: [],
    };
    const controller = new AbortController();
    let admitted = true;
    let admittedRecord = record;
    try {
      if (this.#durability.enabled) {
        const result = await this.#durability.admit(record, {
          ownerId: this.#runtimeId,
          ...(normalized.idempotencyKey === undefined
            ? {}
            : {
                idempotency: {
                  scope: 'orchestration-admission-v1',
                  key: normalized.idempotencyKey,
                  requestHash: canonicalJsonSha256(normalized),
                },
              }),
        });
        if (result === undefined) throw new Error('Durable Orchestration admission is unavailable');
        admitted = result.created;
        admittedRecord = result.record;
      } else if (normalized.idempotencyKey !== undefined) {
        if (this.#store.createIdempotent === undefined) {
          throw new Error('The selected Orchestration store does not support idempotent admission');
        }
        const result = await this.#store.createIdempotent(
          'orchestration-admission-v1',
          normalized.idempotencyKey,
          canonicalJsonSha256(normalized),
          record
        );
        admitted = result.created;
        admittedRecord = result.record;
      } else {
        await this.#store.create(record);
      }
    } catch (error) {
      if (workspaceSnapshot !== undefined) {
        await this.#jobs.discardWorkspaceSnapshot(id).catch(() => undefined);
      }
      throw error;
    }
    if (admitted) this.#subscriptions.notifyPersisted(admittedRecord.id);
    if (!admitted) {
      if (workspaceSnapshot !== undefined) await this.#jobs.discardWorkspaceSnapshot(id);
      const active = this.#activeOrchestrations.get(admittedRecord.id);
      if (active !== undefined) {
        return {
          orchestration: structuredClone(admittedRecord),
          completion: active.completion,
          cancel: async () => active.cancel('idempotent-controller'),
        };
      }
      return {
        orchestration: structuredClone(admittedRecord),
        completion: isTerminalStatus(admittedRecord.status)
          ? Promise.resolve(structuredClone(admittedRecord))
          : this.#waitUntilTerminal(admittedRecord.id),
        cancel: async () => {
          await this.cancel(admittedRecord.id, 'idempotent-controller');
        },
      };
    }
    return this.#activate(record, controller);
  }

  #activate(
    record: OrchestrationRecord,
    controller: AbortController
  ): StartOrchestrationResult {
    let cancellation: Promise<void> | undefined;
    const cancelWithEvidence = (
      source: string,
      requestedAt: string,
      persist: boolean
    ): Promise<void> => {
      cancellation ??= (async () => {
        if (controller.signal.aborted || isTerminalStatus(record.status)) return;
        const previousCancelRequestedAt = record.cancelRequestedAt;
        try {
          if (persist) {
            await this.#durability.requestCancellation(record.id, source, new Date(requestedAt));
          }
          record.cancelRequestedAt = requestedAt;
          await this.#appendEvent(
            record,
            'orchestration.cancel.requested',
            { source },
            requestedAt
          );
        } catch (error) {
          if (previousCancelRequestedAt === undefined) delete record.cancelRequestedAt;
          else record.cancelRequestedAt = previousCancelRequestedAt;
          throw error;
        } finally {
          controller.abort(new Error('Orchestration cancelled by controller'));
        }
      })();
      return cancellation;
    };
    const cancelForSource = (source: string) =>
      cancelWithEvidence(source, this.#now().toISOString(), true);
    const cancel = () => cancelForSource('controller');
    const stopLeaseMonitor = this.#startLeaseMonitor(
      record,
      controller,
      cancelWithEvidence
    );

    const completion = this.#execute(record, controller.signal)
      .catch(async (error: unknown) => {
        if (error instanceof CancellationRequestedError) {
          record.status = record.plan?.willDispatch ? 'dispatching' : 'queued';
          delete record.completedAt;
          delete record.result;
          await cancelWithEvidence(
            error.request.source,
            error.request.requestedAt,
            false
          );
        }
        if (error instanceof JobPersistenceError || error instanceof RecordSizeLimitError) throw error;
        if (record.status !== 'failed' && record.status !== 'cancelled') {
          const details = limitErrorDetails(error);
          record.status = controller.signal.aborted ? 'cancelled' : 'failed';
          record.completedAt = this.#now().toISOString();
          record.error = details;
          await this.#appendEvent(
            record,
            controller.signal.aborted ? 'orchestration.cancelled' : 'orchestration.failed',
            details,
            record.completedAt
          );
        }
        return structuredClone(record);
      })
      .finally(async () => {
        await stopLeaseMonitor();
        await this.#durability.release(record.id);
      });
    this.#activeOrchestrations.set(record.id, { completion, cancel: cancelForSource });
    void completion.then(
      () => this.#activeOrchestrations.delete(record.id),
      () => this.#activeOrchestrations.delete(record.id)
    );

    return {
      orchestration: structuredClone(record),
      completion,
      cancel,
    };
  }

  async #execute(record: OrchestrationRecord, signal: AbortSignal): Promise<OrchestrationRecord> {
    record.startedAt = this.#now().toISOString();
    throwIfAborted(signal);

    const plan = record.plan;
    if (plan === undefined) {
      throw new Error(`Orchestration ${record.id} has no persisted delegation plan`);
    }
    if (!record.events.some((event) => event.type === 'orchestration.handoff.accepted')) {
      await this.#appendEvent(
        record,
        'orchestration.handoff.accepted',
        {
          mode: plan.mode,
          decision: plan.decision,
          willDispatch: plan.willDispatch,
          subtaskCount: plan.subtasks.length,
        },
        record.startedAt
      );
    }
    throwIfAborted(signal);

    if (!plan.willDispatch || plan.subtasks.length === 0) {
      if (record.policy.qualityReview !== undefined) {
        await this.#skipQualityReview(record, 'not-delegated');
      }
      if (record.policy.artifactValidation !== undefined) {
        await this.#skipArtifactValidation(record, 'not-delegated');
      }
      record.status = 'succeeded';
      record.completedAt = this.#now().toISOString();
      record.result = {
        action: plan.mode === 'suggest' && plan.decision !== 'upstream' ? 'suggested' : 'upstream',
        children: [],
      };
      delete record.error;
      await this.#appendEvent(
        record,
        'orchestration.succeeded',
        { action: record.result.action },
        record.completedAt
      );
      return structuredClone(record);
    }

    const dispatchConcurrency = plan.assessment.parallelizable
      ? record.policy.dispatch.maxConcurrency
      : 1;
    if (!record.events.some((event) => event.type === 'orchestration.dispatching')) {
      record.status = 'dispatching';
      await this.#appendEvent(record, 'orchestration.dispatching', {
        subtaskCount: plan.subtasks.length,
        configuredConcurrency: record.policy.dispatch.maxConcurrency,
        effectiveConcurrency: dispatchConcurrency,
      });
    }
    await this.#dispatch(record, plan.subtasks, dispatchConcurrency, signal);
    throwIfAborted(signal);

    const artifactReview = await this.#reviewChildArtifacts(record.children);
    const postChild = await Promise.allSettled([
      this.#runQualityReview(record, signal),
      this.#runArtifactValidation(record, signal),
    ]);
    const rejected = postChild.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    );
    if (rejected !== undefined) throw rejected.reason;
    throwIfAborted(signal);

    record.result = {
      action: 'delegated',
      children: structuredClone(record.children),
      artifactReview,
    };
    const failedChildren = record.children.filter((child) => child.status !== 'succeeded');
    record.completedAt = this.#now().toISOString();
    if (failedChildren.length > 0) {
      record.status = 'failed';
      record.error = {
        name: 'ChildJobError',
        message: `${failedChildren.length} of ${record.children.length} delegated child jobs did not succeed`,
      };
      await this.#appendEvent(
        record,
        'orchestration.failed',
        { name: record.error.name, message: record.error.message },
        record.completedAt
      );
    } else {
      record.status = 'succeeded';
      delete record.error;
      await this.#appendEvent(
        record,
        'orchestration.succeeded',
        { action: 'delegated', childCount: record.children.length },
        record.completedAt
      );
    }
    return structuredClone(record);
  }

  async #reviewChildArtifacts(
    children: OrchestrationChild[]
  ): Promise<OrchestrationArtifactReview> {
    const ownersByPath = new Map<string, string[]>();
    const unavailable: OrchestrationArtifactReview['unavailable'] = [];

    for (const child of children) {
      const job = await this.#jobs.get(child.jobId);
      if (!job) {
        unavailable.push({
          subtaskId: child.subtaskId,
          jobId: child.jobId,
          reason: 'job-not-found',
        });
        continue;
      }
      const changedFiles = job.completionSummary?.changedFiles;
      if (
        !changedFiles ||
        (changedFiles.status !== 'captured' && changedFiles.status !== 'unavailable')
      ) {
        unavailable.push({
          subtaskId: child.subtaskId,
          jobId: child.jobId,
          reason: 'completion-summary-unavailable',
        });
        continue;
      }
      if (changedFiles.status === 'unavailable') {
        unavailable.push({
          subtaskId: child.subtaskId,
          jobId: child.jobId,
          reason: changedFiles.reason,
        });
        continue;
      }
      if (
        !Array.isArray(changedFiles.paths) ||
        !changedFiles.paths.every((item) => typeof item === 'string')
      ) {
        unavailable.push({
          subtaskId: child.subtaskId,
          jobId: child.jobId,
          reason: 'artifact-paths-unavailable',
        });
        continue;
      }
      for (const changedPath of new Set(changedFiles.paths)) {
        const owners = ownersByPath.get(changedPath) ?? [];
        owners.push(child.subtaskId);
        ownersByPath.set(changedPath, owners);
      }
    }

    const conflicts = [...ownersByPath]
      .filter(([, subtaskIds]) => subtaskIds.length > 1)
      .map(([changedPath, subtaskIds]) => ({ path: changedPath, subtaskIds }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return {
      status: unavailable.length === 0 ? 'checked' : 'incomplete',
      conflicts,
      unavailable,
    };
  }

  async #skipArtifactValidation(
    record: OrchestrationRecord,
    reason: Extract<OrchestrationArtifactValidation, { status: 'skipped' }>['reason']
  ): Promise<void> {
    if (record.policy.artifactValidation === undefined) return;
    await this.#setEvidenceAndAppend(
      record,
      'artifactValidation',
      { status: 'skipped', reason },
      'orchestration.artifact-validation.skipped',
      { reason }
    );
  }

  async #unavailableArtifactValidation(
    record: OrchestrationRecord,
    value: Omit<Extract<OrchestrationArtifactValidation, { status: 'unavailable' }>, 'status'>
  ): Promise<void> {
    await this.#setEvidenceAndAppend(
      record,
      'artifactValidation',
      { status: 'unavailable', ...value },
      'orchestration.artifact-validation.unavailable',
      {
        reason: value.reason,
        cleanup: value.cleanup,
        ...(value.childJobId === undefined ? {} : { childJobId: value.childJobId }),
        ...(value.command === undefined
          ? {}
          : { commandOutcome: value.command.outcome, exitCode: value.command.exitCode }),
        ...(value.error === undefined ? {} : { error: value.error }),
      }
    );
  }

  async #runArtifactValidation(
    record: OrchestrationRecord,
    signal: AbortSignal
  ): Promise<void> {
    const config = record.policy.artifactValidation;
    const plan = record.plan;
    if (config === undefined || plan === undefined) return;
    if (record.children.length !== 1 || plan.subtasks.length !== 1) {
      await this.#skipArtifactValidation(record, 'child-count-not-one');
      return;
    }
    const child = record.children[0]!;
    if (child.status !== 'succeeded') {
      await this.#skipArtifactValidation(record, 'child-not-succeeded');
      return;
    }
    const childJob = await this.#jobs.get(child.jobId);
    if (!childJob || childJob.status !== 'succeeded' || !childJob.result) {
      await this.#skipArtifactValidation(record, 'child-job-unavailable');
      return;
    }
    const verification = await this.#jobs.verifyArtifacts(child.jobId);
    if (!verification || verification.artifacts.length !== 1) {
      await this.#skipArtifactValidation(record, 'artifact-count-not-one');
      return;
    }
    const verified = verification.artifacts[0]!;
    if (!verification.valid || !verified.valid) {
      await this.#skipArtifactValidation(record, 'artifact-invalid');
      return;
    }
    if (verified.artifact.size === 0) {
      await this.#skipArtifactValidation(record, 'artifact-empty');
      return;
    }
    const artifact: ArtifactValidationIdentity = {
      attempt: verified.artifact.attempt,
      size: verified.artifact.size,
      sha256: verified.artifact.sha256,
      baseCommit: verified.artifact.baseCommit,
      ...(verified.artifact.baseTree === undefined ? {} : { baseTree: verified.artifact.baseTree }),
    };
    await this.#setEvidenceAndAppend(
      record,
      'artifactValidation',
      { status: 'pending', childJobId: child.jobId, artifact },
      'orchestration.artifact-validation.started',
      { childJobId: child.jobId, artifact }
    );

    let releaseSlot: () => void;
    try {
      releaseSlot = await this.#artifactValidationSlots.acquire(signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      await this.#unavailableArtifactValidation(record, {
        childJobId: child.jobId,
        artifact,
        reason: 'parent-cancelled',
        cleanup: 'not-started',
      });
      throwIfAborted(signal);
      return;
    }

    let execution: Awaited<ReturnType<Orchestrator['validateArtifact']>>;
    try {
      execution = await this.#jobs.validateArtifact(
        child.jobId,
        verified.artifact.attempt,
        config,
        signal
      );
    } catch (error) {
      await this.#unavailableArtifactValidation(record, {
        childJobId: child.jobId,
        artifact,
        reason: signal.aborted ? 'parent-cancelled' : 'validation-start-failed',
        cleanup: 'not-confirmed',
        error: limitErrorDetails(error),
      });
      throwIfAborted(signal);
      return;
    } finally {
      releaseSlot();
    }

    if (execution === undefined) {
      await this.#unavailableArtifactValidation(record, {
        childJobId: child.jobId,
        artifact,
        reason: 'validation-start-failed',
        cleanup: 'not-started',
      });
      return;
    }
    if (signal.aborted) {
      await this.#unavailableArtifactValidation(record, {
        childJobId: child.jobId,
        artifact,
        reason: 'parent-cancelled',
        cleanup: execution.cleanup,
        ...(execution.command === undefined ? {} : { command: execution.command }),
      });
      throwIfAborted(signal);
      return;
    }
    if (execution.status === 'unavailable') {
      await this.#unavailableArtifactValidation(record, {
        childJobId: child.jobId,
        artifact,
        reason: execution.reason,
        cleanup: execution.cleanup,
        ...(execution.command === undefined ? {} : { command: execution.command }),
        ...(execution.error === undefined ? {} : { error: limitErrorDetails(execution.error) }),
      });
      return;
    }

    const outcome = execution.command.outcome === 'passed' ? 'passed' : 'failed';
    await this.#setEvidenceAndAppend(
      record,
      'artifactValidation',
      {
        status: 'completed',
        childJobId: child.jobId,
        artifact,
        outcome,
        command: execution.command,
        cleanup: 'cleaned',
      },
      'orchestration.artifact-validation.completed',
      {
        childJobId: child.jobId,
        outcome,
        commandOutcome: execution.command.outcome,
        exitCode: execution.command.exitCode,
        durationMs: execution.command.durationMs,
      }
    );
  }

  async #skipQualityReview(
    record: OrchestrationRecord,
    reason: Extract<OrchestrationQualityReview, { status: 'skipped' }>['reason']
  ): Promise<void> {
    const route = record.policy.qualityReview?.route;
    if (route === undefined) return;
    await this.#setEvidenceAndAppend(
      record,
      'qualityReview',
      { status: 'skipped', route, reason },
      'orchestration.review.skipped',
      { route, reason }
    );
  }

  async #unavailableQualityReview(
    record: OrchestrationRecord,
    value: Omit<Extract<OrchestrationQualityReview, { status: 'unavailable' }>, 'status'>
  ): Promise<void> {
    await this.#setEvidenceAndAppend(
      record,
      'qualityReview',
      { status: 'unavailable', ...value },
      'orchestration.review.unavailable',
      {
        route: value.route,
        reason: value.reason,
        ...(value.childJobId === undefined ? {} : { childJobId: value.childJobId }),
        ...(value.reviewerJobId === undefined ? {} : { reviewerJobId: value.reviewerJobId }),
        ...(value.error === undefined ? {} : { error: value.error }),
      }
    );
  }

  async #runQualityReview(record: OrchestrationRecord, signal: AbortSignal): Promise<void> {
    const config = record.policy.qualityReview;
    const plan = record.plan;
    if (config === undefined || plan === undefined) return;
    if (!config.complexities.includes(plan.assessment.complexity)) {
      await this.#skipQualityReview(record, 'complexity-not-selected');
      return;
    }
    if (record.children.length !== 1 || plan.subtasks.length !== 1) {
      await this.#skipQualityReview(record, 'child-count-not-one');
      return;
    }
    const child = record.children[0]!;
    const subtask = plan.subtasks[0]!;
    const pendingReview =
      record.qualityReview?.status === 'pending' ? record.qualityReview : undefined;
    if (child.status !== 'succeeded') {
      await this.#skipQualityReview(record, 'child-not-succeeded');
      return;
    }
    const childJob = await this.#jobs.get(child.jobId);
    if (!childJob || childJob.status !== 'succeeded' || !childJob.result) {
      await this.#skipQualityReview(record, 'child-job-unavailable');
      return;
    }
    const verification = await this.#jobs.verifyArtifacts(child.jobId);
    if (!verification || verification.artifacts.length !== 1) {
      await this.#skipQualityReview(record, 'artifact-count-not-one');
      return;
    }
    const verified = verification.artifacts[0]!;
    if (!verification.valid || !verified.valid) {
      await this.#skipQualityReview(record, 'artifact-invalid');
      return;
    }
    if (verified.artifact.size === 0) {
      await this.#skipQualityReview(record, 'artifact-empty');
      return;
    }
    const prompt = buildQualityReviewPrompt({
      parentGoal: record.request.prompt,
      subtask,
      childJob,
      artifact: verified.artifact,
    });
    if (utf8Bytes(prompt) > MAX_PROMPT_BYTES) {
      await this.#skipQualityReview(record, 'handoff-too-large');
      return;
    }

    let started: Awaited<ReturnType<Orchestrator['start']>>;
    try {
      started = await this.#startDelegatedJob(record, {
        prompt,
        workspace: record.request.workspace,
        route: config.route,
        artifactReadGrant: {
          schemaVersion: 1,
          sourceJobId: child.jobId,
          artifact: artifactReadIdentity(verified.artifact),
        },
        idempotencyKey: `${record.id}:reviewer:${child.jobId}:${plan.planHash}`,
        ...(record.request.source === undefined ? {} : { source: record.request.source }),
        metadata: {
          ...(record.request.metadata ?? {}),
          agentknotDelegation: {
            orchestrationId: record.id,
            role: 'reviewer',
            depth: 1,
            childJobId: child.jobId,
            planHash: plan.planHash,
            policyVersion: plan.policyVersion,
          } satisfies AgentKnotDelegationMetadata,
        },
      });
    } catch (error) {
      if (error instanceof JobPersistenceError) throw error;
      await this.#unavailableQualityReview(record, {
        route: config.route,
        childJobId: child.jobId,
        reason: 'reviewer-start-failed',
        error: limitErrorDetails(error),
      });
      return;
    }

    if (pendingReview !== undefined && pendingReview.reviewerJobId !== started.job.id) {
      await Promise.allSettled([started.cancel(), started.completion]);
      throw new Error(`Orchestration ${record.id} resolved a different reviewer identity`);
    }
    if (pendingReview === undefined) {
      try {
        await this.#setEvidenceAndAppend(
          record,
          'qualityReview',
          {
            status: 'pending',
            route: config.route,
            childJobId: child.jobId,
            reviewerJobId: started.job.id,
          },
          'orchestration.review.started',
          {
            route: config.route,
            childJobId: child.jobId,
            reviewerJobId: started.job.id,
          }
        );
      } catch (error) {
        await Promise.allSettled([started.cancel(), started.completion]);
        throw error;
      }
    } else if (!isTerminalStatus(started.job.status)) {
      await this.#jobs.recoverInterruptedJob(started.job.id, {
        waitForLease: true,
        signal,
      });
    }

    const reviewerJob = await this.#awaitJob(started, signal);
    if (signal.aborted) {
      await this.#unavailableQualityReview(record, {
        route: config.route,
        childJobId: child.jobId,
        reviewerJobId: reviewerJob.id,
        reason: 'parent-cancelled',
      });
      throwIfAborted(signal);
    }
    if (reviewerJob.status !== 'succeeded' || !reviewerJob.result) {
      await this.#unavailableQualityReview(record, {
        route: config.route,
        childJobId: child.jobId,
        reviewerJobId: reviewerJob.id,
        reason: 'reviewer-failed',
        ...(reviewerJob.error === undefined
          ? {}
          : { error: { name: reviewerJob.error.name, message: reviewerJob.error.message } }),
      });
      return;
    }
    if (reviewerJob.result.outputTruncation !== undefined) {
      await this.#unavailableQualityReview(record, {
        route: config.route,
        childJobId: child.jobId,
        reviewerJobId: reviewerJob.id,
        reason: 'reviewer-output-truncated',
      });
      return;
    }
    try {
      const review = parseQualityReview(reviewerJob.result.output);
      await this.#setEvidenceAndAppend(
        record,
        'qualityReview',
        {
          status: 'completed',
          route: config.route,
          childJobId: child.jobId,
          reviewerJobId: reviewerJob.id,
          verdict: review.verdict,
          summary: review.summary,
          findings: review.findings,
        },
        'orchestration.review.completed',
        {
          route: config.route,
          childJobId: child.jobId,
          reviewerJobId: reviewerJob.id,
          verdict: review.verdict,
          findingCount: review.findings.length,
        }
      );
    } catch (error) {
      await this.#unavailableQualityReview(record, {
        route: config.route,
        childJobId: child.jobId,
        reviewerJobId: reviewerJob.id,
        reason: 'reviewer-output-invalid',
        error: limitErrorDetails(error),
      });
    }
  }

  async #awaitJob(
    started: Awaited<ReturnType<Orchestrator['start']>>,
    signal: AbortSignal
  ): Promise<JobRecord> {
    let cancellation: Promise<void> | undefined;
    const cancel = () => (cancellation ??= started.cancel());
    const onAbort = () => {
      void cancel().catch(() => undefined);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      const job = await started.completion;
      if (cancellation !== undefined) await cancellation;
      return job;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  #startDelegatedJob(
    record: OrchestrationRecord,
    request: Parameters<Orchestrator['start']>[0]
  ): ReturnType<Orchestrator['start']> {
    if (record.workspaceSnapshot === undefined) {
      throw new Error(`Orchestration ${record.id} has no immutable admitted workspace snapshot`);
    }
    return this.#jobs.startFromWorkspaceSnapshot(
      request,
      record.id,
      record.workspaceSnapshot
    );
  }

  #workerIdempotencyKey(record: OrchestrationRecord, subtask: PlannedSubtask): string {
    const plan = record.plan;
    if (plan === undefined) throw new Error('Cannot identify a child without a persisted plan');
    return `${record.id}:worker:${subtask.id}:${plan.planHash}`;
  }

  #workerRequest(
    record: OrchestrationRecord,
    subtask: PlannedSubtask
  ): Parameters<Orchestrator['start']>[0] {
    const plan = record.plan;
    if (plan === undefined) throw new Error('Cannot construct a child without a persisted plan');
    const delegationMetadata: AgentKnotDelegationMetadata = {
      orchestrationId: record.id,
      role: 'worker',
      subtaskId: subtask.id,
      depth: 1,
      planHash: plan.planHash,
      policyVersion: plan.policyVersion,
      taskKind: subtask.kind,
      parentComplexity: plan.assessment.complexity,
      ...(subtask.routeSelection === undefined
        ? {}
        : { routeSelection: subtask.routeSelection }),
    };
    return {
      prompt: subtask.executionPrompt,
      workspace: record.request.workspace,
      route: subtask.route,
      idempotencyKey: this.#workerIdempotencyKey(record, subtask),
      ...(record.request.source === undefined ? {} : { source: record.request.source }),
      metadata: {
        ...(record.request.metadata ?? {}),
        agentknotDelegation: delegationMetadata,
      },
    };
  }

  async #waitForJobId(jobId: string, signal: AbortSignal): Promise<JobRecord> {
    let cancellation: Promise<boolean> | undefined;
    const cancel = () => (cancellation ??= this.#jobs.cancel(jobId, 'parent-orchestration'));
    const onAbort = () => {
      void cancel().catch(() => undefined);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        const job = await this.#jobs.wait(jobId, 60_000);
        if (job === undefined) throw new Error(`Delegated Job ${jobId} disappeared`);
        if (isTerminalStatus(job.status)) {
          if (cancellation !== undefined) await cancellation;
          return job;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async #dispatch(
    record: OrchestrationRecord,
    subtasks: PlannedSubtask[],
    maxConcurrency: number,
    signal: AbortSignal
  ): Promise<void> {
    const plan = record.plan;
    if (!plan) throw new Error('Cannot dispatch orchestration children without a persisted plan');
    const subtasksById = new Map(subtasks.map((subtask) => [subtask.id, subtask]));
    const childrenBySubtask = new Map<string, OrchestrationChild>();
    for (const child of record.children) {
      const subtask = subtasksById.get(child.subtaskId);
      if (
        subtask === undefined ||
        childrenBySubtask.has(child.subtaskId) ||
        child.planHash !== plan.planHash ||
        child.policyVersion !== plan.policyVersion
      ) {
        throw new Error(`Orchestration ${record.id} has inconsistent persisted child identity`);
      }
      childrenBySubtask.set(child.subtaskId, child);
    }
    const active: ActiveChild[] = [];
    let nextIndex = 0;

    const launch = async (subtask: PlannedSubtask): Promise<ActiveChild | undefined> => {
      let child = childrenBySubtask.get(subtask.id);
      if (child !== undefined && isTerminalStatus(child.status)) {
        const job = await this.#jobs.get(child.jobId);
        if (job === undefined || !isTerminalStatus(job.status) || job.status !== child.status) {
          throw new Error(`Orchestration ${record.id} has inconsistent terminal child ${child.jobId}`);
        }
        return undefined;
      }
      try {
        const request = this.#workerRequest(record, subtask);
        let started: Awaited<ReturnType<Orchestrator['start']>> | undefined;
        let job =
          child === undefined
            ? await this.#jobs.findIdempotent(request.idempotencyKey as string)
            : await this.#jobs.get(child.jobId);
        if (child !== undefined && job === undefined) {
          throw new Error(`Persisted child Job ${child.jobId} was not found`);
        }
        if (job === undefined) {
          started = await this.#startDelegatedJob(record, request);
          job = started.job;
        }
        if (child === undefined) {
          child = {
            subtaskId: subtask.id,
            jobId: job.id,
            planHash: plan.planHash,
            policyVersion: plan.policyVersion,
            status: job.status,
            route: structuredClone(job.route),
            ...(job.routePoolSelection === undefined
              ? {}
              : { routePoolSelection: structuredClone(job.routePoolSelection) }),
          };
          record.children.push(child);
          childrenBySubtask.set(subtask.id, child);
          try {
            await this.#appendEvent(record, 'orchestration.child.started', {
              subtaskId: subtask.id,
              jobId: job.id,
              route: subtask.route,
              planHash: plan.planHash,
              policyVersion: plan.policyVersion,
            });
          } catch (error) {
            await this.#jobs.cancel(job.id, 'parent-persistence-failure').catch(() => undefined);
            const terminalJob =
              started === undefined
                ? await this.#waitForJobId(job.id, signal).catch(() => undefined)
                : await started.completion.catch(() => undefined);
            if (terminalJob !== undefined) {
              child.status = terminalJob.status;
              if (terminalJob.result !== undefined) child.output = terminalJob.result.output;
              if (terminalJob.error !== undefined) child.error = structuredClone(terminalJob.error);
            }
            throw error;
          }
        } else if (job.id !== child.jobId) {
          throw new Error(`Orchestration ${record.id} resolved a different child identity`);
        }
        if (started === undefined && !isTerminalStatus(job.status)) {
          await this.#jobs.recoverInterruptedJob(job.id, {
            waitForLease: true,
            signal,
          });
        }
        let cancellation: Promise<void> | undefined;
        const cancel = () =>
          (cancellation ??= this.#jobs
            .cancel(job.id, 'parent-orchestration')
            .then(() => undefined));
        const onAbort = () => {
          void cancel().catch(() => undefined);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        return {
          child,
          cancel,
          completion: (started?.completion ?? this.#waitForJobId(job.id, signal))
            .then(async (job) => {
              if (cancellation !== undefined) await cancellation;
              return { job };
            })
            .catch((error: unknown) => ({ error }))
            .finally(() => {
              signal.removeEventListener('abort', onAbort);
            }),
        };
      } catch (error) {
        throw error;
      }
    };

    const settleNext = async (): Promise<void> => {
      const settled = await Promise.race(
        active.map((item) => item.completion.then((outcome) => ({ item, outcome })))
      );
      active.splice(active.indexOf(settled.item), 1);
      if (settled.outcome.job) {
        settled.item.child.status = settled.outcome.job.status;
        if (settled.outcome.job.result) settled.item.child.output = settled.outcome.job.result.output;
        if (settled.outcome.job.error) settled.item.child.error = structuredClone(settled.outcome.job.error);
      } else {
        if (settled.outcome.error instanceof JobPersistenceError) throw settled.outcome.error;
        const details = limitErrorDetails(settled.outcome.error);
        settled.item.child.status = signal.aborted ? 'cancelled' : 'failed';
        settled.item.child.error = { ...details, attempt: 0, retryable: false };
      }
      await this.#appendEvent(record, 'orchestration.child.completed', {
        subtaskId: settled.item.child.subtaskId,
        jobId: settled.item.child.jobId,
        status: settled.item.child.status,
      });
    };

    try {
      while (nextIndex < subtasks.length || active.length > 0) {
        while (
          !signal.aborted &&
          nextIndex < subtasks.length &&
          active.length < maxConcurrency
        ) {
          const launched = await launch(subtasks[nextIndex] as PlannedSubtask);
          if (launched !== undefined) active.push(launched);
          nextIndex += 1;
        }
        if (active.length === 0) break;
        await settleNext();
      }
    } catch (error) {
      await Promise.allSettled(active.map((item) => item.cancel()));
      while (active.length > 0) await settleNext();
      throw error;
    }
  }

  async #appendEvent(
    record: OrchestrationRecord,
    type: OrchestrationEventType,
    data?: Record<string, unknown>,
    at = this.#now().toISOString(),
    mutation?: PersistedRecordMutation
  ): Promise<OrchestrationEvent> {
    let appended: OrchestrationEvent | undefined;
    const previous = this.#recordMutations.get(record.id) ?? Promise.resolve();
    const current = previous.then(async () => {
      const previousUpdatedAt = record.updatedAt;
      mutation?.apply();
      const event: OrchestrationEvent = {
        sequence: record.events.length + 1,
        orchestrationId: record.id,
        at,
        type,
        ...(data === undefined ? {} : { data: limitEventData(data) }),
      };
      appended = event;
      record.events.push(event);
      record.updatedAt = at;
      try {
        await this.#save(record);
      } catch (error) {
        if (record.events.at(-1) === event) record.events.pop();
        mutation?.rollback();
        record.updatedAt = previousUpdatedAt;
        throw error;
      }
    });
    this.#recordMutations.set(record.id, current);
    try {
      await current;
    } finally {
      if (this.#recordMutations.get(record.id) === current) this.#recordMutations.delete(record.id);
    }
    return appended as OrchestrationEvent;
  }

  async #setEvidenceAndAppend<K extends 'qualityReview' | 'artifactValidation'>(
    record: OrchestrationRecord,
    field: K,
    value: OrchestrationRecord[K],
    type: OrchestrationEventType,
    data: Record<string, unknown>
  ): Promise<void> {
    let hadPrevious = false;
    let previous: OrchestrationRecord[K];
    await this.#appendEvent(record, type, data, this.#now().toISOString(), {
      apply: () => {
        hadPrevious = Object.hasOwn(record, field);
        previous = record[field];
        record[field] = value;
      },
      rollback: () => {
        if (hadPrevious) record[field] = previous;
        else delete record[field];
      },
    });
  }
}

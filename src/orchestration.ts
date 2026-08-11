import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { DelegationConfig } from './config.js';
import { canonicalJsonSha256 } from './canonical-json.js';
import {
  CancellationRequestedError,
} from './durable-record-store.js';
import { DurableExecutionCoordinator } from './durable-execution.js';
import { MAX_ARTIFACT_VALIDATION_PATCH_BYTES } from './artifact-validation.js';
import { isExecutorProcessAlive } from './execution.js';
import { assertJsonMetadata } from './metadata.js';
import {
  MAX_PROMPT_BYTES,
  RecordSizeLimitError,
  assertTextLimit,
  limitErrorDetails,
  limitEventData,
  utf8Bytes,
} from './record-limits.js';
import {
  MAX_QUALITY_REVIEW_PATCH_BYTES,
  buildQualityReviewPrompt,
  parseQualityReview,
} from './quality-review.js';
import { composeDelegationPlan, validateTaskAssessment } from './delegation-policy.js';
import type {
  AgentKnotDelegationMetadata,
  ArtifactValidationIdentity,
  OrchestrationArtifactValidation,
  OrchestrationArtifactReview,
  OrchestrationChild,
  OrchestrationEvent,
  OrchestrationEventType,
  OrchestrationRecord,
  OrchestrationRequest,
  OrchestrationQualityReview,
  OrchestrationStore,
  PlannedSubtask,
  StartOrchestrationResult,
} from './orchestration-types.js';
import { JobPersistenceError, type Orchestrator } from './orchestrator.js';
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

interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

interface PersistedRecordMutation {
  apply: () => void;
  rollback: () => void;
}

class Semaphore {
  #available: number;
  readonly #waiters: SemaphoreWaiter[] = [];

  constructor(capacity: number) {
    this.#available = capacity;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Orchestration cancelled'));
    }
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#releaseHandle());
    }
    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index !== -1) this.#waiters.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error('Orchestration cancelled'));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.resolve(this.#releaseHandle());
      } else {
        this.#available += 1;
      }
    };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Orchestration cancelled');
}

function terminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    !['inherit', 'never', 'suggest', 'force'].includes(request.delegation)
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
  readonly #dispatchSlots: Semaphore;
  readonly #artifactValidationSlots = new Semaphore(1);
  readonly #recordMutations = new Map<string, Promise<void>>();
  readonly #activeOrchestrations = new Map<string, ActiveOrchestration>();
  readonly #durability: DurableExecutionCoordinator<OrchestrationRecord>;

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
    this.#dispatchSlots = new Semaphore(this.#config.dispatch.maxConcurrency);
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

  async wait(id: string, timeoutMs = 5_000): Promise<OrchestrationRecord | undefined> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
      throw new Error('Orchestration wait timeout must be an integer between 0 and 60000');
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = await this.#store.get(id);
      if (current === undefined || terminal(current.status) || Date.now() >= deadline) return current;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }

  async cancel(id: string, source = 'controller'): Promise<boolean> {
    const current = await this.#store.get(id);
    if (current === undefined || terminal(current.status)) return false;
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

  async #waitUntilTerminal(id: string): Promise<OrchestrationRecord> {
    while (true) {
      const record = await this.#store.get(id);
      if (record === undefined) throw new Error(`Orchestration ${id} disappeared while waiting`);
      if (terminal(record.status)) return record;
      await delay(100);
    }
  }

  #save(record: OrchestrationRecord): Promise<void> {
    return this.#durability.save(record);
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

  async reconcileInterruptedOrchestrations(
    options: { exclusiveOwner?: boolean } = {}
  ): Promise<OrchestrationRecord[]> {
    const reconciled: OrchestrationRecord[] = [];
    for (const record of await this.#store.list()) {
      // `planning` is accepted only for historical schemaVersion 1 snapshots.
      if (!['queued', 'planning', 'dispatching'].includes(record.status)) continue;
      if (!options.exclusiveOwner && isExecutorProcessAlive(record.execution)) continue;

      const previousStatus = record.status;
      const message =
        'A new AgentKnot runtime found this orchestration without a terminal state; v1 does not resume or redispatch interrupted plans';
      record.status = 'failed';
      record.completedAt = this.#now().toISOString();
      record.error = { name: 'ExecutionInterruptedError', message };
      delete record.result;
      for (const child of record.children) {
        const job = await this.#jobs.get(child.jobId);
        if (!job) {
          child.status = 'failed';
          child.error = {
            name: 'MissingChildJobError',
            message: `Child job record was not found during restart reconciliation: ${child.jobId}`,
            attempt: 0,
            retryable: false,
          };
          delete child.output;
          continue;
        }
        child.status = job.status;
        if (job.result) child.output = job.result.output;
        else delete child.output;
        if (job.error) child.error = structuredClone(job.error);
        else delete child.error;
      }
      if (record.qualityReview?.status === 'pending') {
        record.qualityReview = {
          status: 'unavailable',
          route: record.qualityReview.route,
          childJobId: record.qualityReview.childJobId,
          reviewerJobId: record.qualityReview.reviewerJobId,
          reason: 'runtime-restart',
        };
        await this.#appendEvent(record, 'orchestration.review.unavailable', {
          reviewerJobId: record.qualityReview.reviewerJobId,
          reason: record.qualityReview.reason,
        });
      }
      if (record.artifactValidation?.status === 'pending') {
        record.artifactValidation = {
          status: 'unavailable',
          childJobId: record.artifactValidation.childJobId,
          artifact: record.artifactValidation.artifact,
          reason: 'runtime-restart',
          cleanup: 'not-confirmed',
        };
        await this.#appendEvent(record, 'orchestration.artifact-validation.unavailable', {
          childJobId: record.artifactValidation.childJobId,
          reason: record.artifactValidation.reason,
        });
      }
      await this.#appendEvent(
        record,
        'orchestration.failed',
        { name: 'ExecutionInterruptedError', message, reason: 'runtime_restart', previousStatus },
        record.completedAt
      );
      reconciled.push(structuredClone(record));
    }
    return reconciled;
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
        completion: terminal(admittedRecord.status)
          ? Promise.resolve(structuredClone(admittedRecord))
          : this.#waitUntilTerminal(admittedRecord.id),
        cancel: async () => {
          await this.cancel(admittedRecord.id, 'idempotent-controller');
        },
      };
    }
    let cancellation: Promise<void> | undefined;
    const cancelWithEvidence = (
      source: string,
      requestedAt: string,
      persist: boolean
    ): Promise<void> => {
      cancellation ??= (async () => {
        if (controller.signal.aborted || terminal(record.status)) return;
        const previousCancelRequestedAt = record.cancelRequestedAt;
        try {
          if (persist) {
            await this.#durability.requestCancellation(record.id, source, new Date(requestedAt));
          }
          const previousCancelRequestedAt = record.cancelRequestedAt;
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
    this.#activeOrchestrations.set(id, { completion, cancel: cancelForSource });
    void completion.then(
      () => this.#activeOrchestrations.delete(id),
      () => this.#activeOrchestrations.delete(id)
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

    record.status = 'dispatching';
    const dispatchConcurrency = plan.assessment.parallelizable
      ? record.policy.dispatch.maxConcurrency
      : 1;
    await this.#appendEvent(record, 'orchestration.dispatching', {
      subtaskCount: plan.subtasks.length,
      configuredConcurrency: record.policy.dispatch.maxConcurrency,
      effectiveConcurrency: dispatchConcurrency,
    });
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
    if (verified.artifact.size > MAX_ARTIFACT_VALIDATION_PATCH_BYTES) {
      await this.#skipArtifactValidation(record, 'artifact-too-large');
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
    if (verified.artifact.size > MAX_QUALITY_REVIEW_PATCH_BYTES) {
      await this.#skipQualityReview(record, 'artifact-too-large');
      return;
    }
    const preview = await this.#jobs.previewArtifact(child.jobId, verified.artifact.attempt);
    if (!preview || !preview.verification.valid || preview.content === null) {
      await this.#skipQualityReview(record, 'artifact-invalid');
      return;
    }
    if (preview.truncated) {
      await this.#skipQualityReview(record, 'artifact-truncated');
      return;
    }
    if (preview.content.trim() === '') {
      await this.#skipQualityReview(record, 'artifact-empty');
      return;
    }
    const prompt = buildQualityReviewPrompt({
      parentGoal: record.request.prompt,
      subtask,
      childJob,
      preview,
    });
    if (utf8Bytes(prompt) > MAX_PROMPT_BYTES) {
      await this.#skipQualityReview(record, 'handoff-too-large');
      return;
    }

    let releaseSlot: () => void;
    try {
      releaseSlot = await this.#dispatchSlots.acquire(signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      await this.#unavailableQualityReview(record, {
        route: config.route,
        childJobId: child.jobId,
        reason: 'parent-cancelled',
      });
      throwIfAborted(signal);
      return;
    }
    let started: Awaited<ReturnType<Orchestrator['start']>>;
    try {
      started = await this.#startDelegatedJob(record, {
        prompt,
        workspace: record.request.workspace,
        route: config.route,
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
      releaseSlot();
      if (error instanceof JobPersistenceError) throw error;
      await this.#unavailableQualityReview(record, {
        route: config.route,
        childJobId: child.jobId,
        reason: 'reviewer-start-failed',
        error: limitErrorDetails(error),
      });
      return;
    }

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
      releaseSlot();
      throw error;
    }

    let reviewerJob: JobRecord;
    try {
      reviewerJob = await this.#awaitJob(started, signal);
    } finally {
      releaseSlot();
    }
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

  async #dispatch(
    record: OrchestrationRecord,
    subtasks: PlannedSubtask[],
    maxConcurrency: number,
    signal: AbortSignal
  ): Promise<void> {
    const plan = record.plan;
    if (!plan) throw new Error('Cannot dispatch orchestration children without a persisted plan');
    const active: ActiveChild[] = [];
    let nextIndex = 0;

    const launch = async (subtask: PlannedSubtask): Promise<ActiveChild> => {
      const releaseSlot = await this.#dispatchSlots.acquire(signal);
      try {
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
        const started = await this.#startDelegatedJob(record, {
          prompt: subtask.executionPrompt,
          workspace: record.request.workspace,
          route: subtask.route,
          idempotencyKey: `${record.id}:worker:${subtask.id}:${plan.planHash}`,
          ...(record.request.source === undefined ? {} : { source: record.request.source }),
          metadata: {
            ...(record.request.metadata ?? {}),
            agentknotDelegation: delegationMetadata,
          },
        });
        const child: OrchestrationChild = {
          subtaskId: subtask.id,
          jobId: started.job.id,
          planHash: plan.planHash,
          policyVersion: plan.policyVersion,
          status: started.job.status,
          route: structuredClone(started.job.route),
          ...(started.job.routePoolSelection === undefined
            ? {}
            : { routePoolSelection: structuredClone(started.job.routePoolSelection) }),
        };
        record.children.push(child);
        try {
          await this.#appendEvent(record, 'orchestration.child.started', {
            subtaskId: subtask.id,
            jobId: started.job.id,
            route: subtask.route,
            planHash: plan.planHash,
            policyVersion: plan.policyVersion,
          });
        } catch (error) {
          const [, completed] = await Promise.allSettled([
            started.cancel(),
            started.completion,
          ]);
          if (completed.status === 'rejected') throw completed.reason;
          const job = completed.value;
          child.status = job.status;
          if (job.result) child.output = job.result.output;
          if (job.error) child.error = structuredClone(job.error);
          throw error;
        }
        let cancellation: Promise<void> | undefined;
        const cancel = () => (cancellation ??= started.cancel());
        const onAbort = () => {
          void cancel().catch(() => undefined);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        return {
          child,
          cancel,
          completion: started.completion
            .then(async (job) => {
              if (cancellation !== undefined) await cancellation;
              return { job };
            })
            .catch((error: unknown) => ({ error }))
            .finally(() => {
              signal.removeEventListener('abort', onAbort);
              releaseSlot();
            }),
        };
      } catch (error) {
        releaseSlot();
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
          active.push(await launch(subtasks[nextIndex] as PlannedSubtask));
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

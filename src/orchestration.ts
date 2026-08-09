import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { DelegationConfig } from './config.js';
import { isExecutorProcessAlive } from './execution.js';
import { assertJsonMetadata } from './metadata.js';
import {
  MAX_PROMPT_BYTES,
  RecordSizeLimitError,
  assertTextLimit,
  limitErrorDetails,
  limitEventData,
} from './record-limits.js';
import {
  buildPlannerPrompt,
  composeDelegationPlan,
  parseTaskAssessment,
  rehashDelegationPlan,
  skippedTaskAssessment,
} from './delegation-policy.js';
import type {
  AgentKnotDelegationMetadata,
  DelegationPlan,
  OrchestrationArtifactReview,
  OrchestrationChild,
  OrchestrationEvent,
  OrchestrationEventType,
  OrchestrationRecord,
  OrchestrationRequest,
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
}

interface ActiveChild {
  child: OrchestrationChild;
  cancel: () => void;
  completion: Promise<{ job?: JobRecord; error?: unknown }>;
}

interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
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

function errorDetails(error: unknown): { name: string; message: string } {
  return limitErrorDetails(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Orchestration cancelled');
}

function normalizeRequest(request: OrchestrationRequest): OrchestrationRequest {
  if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
    throw new Error('Orchestration prompt must be a non-empty string');
  }
  if (typeof request.workspace !== 'string' || request.workspace.trim() === '') {
    throw new Error('Orchestration workspace must be a non-empty string');
  }
  assertTextLimit('Orchestration prompt', request.prompt, MAX_PROMPT_BYTES);
  if (
    request.delegation !== undefined &&
    !['inherit', 'never', 'suggest', 'force'].includes(request.delegation)
  ) {
    throw new Error('Orchestration delegation must be "inherit", "never", "suggest", or "force"');
  }
  if (request.metadata !== undefined) assertJsonMetadata(request.metadata);
  return {
    prompt: request.prompt,
    workspace: path.resolve(request.workspace),
    ...(request.source === undefined ? {} : { source: request.source }),
    ...(request.metadata === undefined ? {} : { metadata: structuredClone(request.metadata) }),
    ...(request.delegation === undefined ? {} : { delegation: request.delegation }),
  };
}

export class OrchestrationService {
  readonly #config: DelegationConfig;
  readonly #jobs: Orchestrator;
  readonly #store: OrchestrationStore;
  readonly #now: () => Date;
  readonly #runtimeId = randomUUID();
  readonly #dispatchSlots: Semaphore;
  readonly #recordMutations = new Map<string, Promise<void>>();

  constructor(options: OrchestrationServiceOptions) {
    if (options.config.mode !== 'off' && options.jobs.workspaceIsolationMode() !== 'git-worktree') {
      throw new Error('Automatic orchestration requires a job orchestrator with git-worktree isolation');
    }
    this.#config = structuredClone(options.config);
    this.#jobs = options.jobs;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
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

  async reconcileInterruptedOrchestrations(
    options: { exclusiveOwner?: boolean } = {}
  ): Promise<OrchestrationRecord[]> {
    const reconciled: OrchestrationRecord[] = [];
    for (const record of await this.#store.list()) {
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
      children: [],
    };
    const controller = new AbortController();
    await this.#store.create(record);

    const completion = this.#execute(record, controller.signal).catch(async (error: unknown) => {
      if (error instanceof JobPersistenceError || error instanceof RecordSizeLimitError) throw error;
      if (record.status !== 'failed' && record.status !== 'cancelled') {
        const details = errorDetails(error);
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
    });

    return {
      orchestration: structuredClone(record),
      completion,
      cancel: async () => {
        if (controller.signal.aborted || ['succeeded', 'failed', 'cancelled'].includes(record.status)) return;
        const requestedAt = this.#now().toISOString();
        const previousCancelRequestedAt = record.cancelRequestedAt;
        record.cancelRequestedAt = requestedAt;
        try {
          await this.#appendEvent(
            record,
            'orchestration.cancel.requested',
            { source: 'controller' },
            requestedAt
          );
        } catch (error) {
          if (previousCancelRequestedAt === undefined) delete record.cancelRequestedAt;
          else record.cancelRequestedAt = previousCancelRequestedAt;
          throw error;
        } finally {
          controller.abort(new Error('Orchestration cancelled by controller'));
        }
      },
    };
  }

  async #execute(record: OrchestrationRecord, signal: AbortSignal): Promise<OrchestrationRecord> {
    record.status = 'planning';
    record.startedAt = this.#now().toISOString();
    await this.#appendEvent(record, 'orchestration.planning', undefined, record.startedAt);
    throwIfAborted(signal);

    const plan = await this.#plan(record, signal);
    record.plan = plan;
    await this.#appendEvent(record, 'orchestration.planned', {
      mode: plan.mode,
      decision: plan.decision,
      willDispatch: plan.willDispatch,
      subtaskCount: plan.subtasks.length,
    });
    throwIfAborted(signal);

    if (!plan.willDispatch || plan.subtasks.length === 0) {
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

    record.result = {
      action: 'delegated',
      children: structuredClone(record.children),
      artifactReview: await this.#reviewChildArtifacts(record.children),
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

  async #plan(record: OrchestrationRecord, signal: AbortSignal): Promise<DelegationPlan> {
    if (record.policy.mode === 'off' || record.request.delegation === 'never') {
      return composeDelegationPlan(
        record.request,
        skippedTaskAssessment(
          record.policy.mode === 'off'
            ? 'Automatic delegation is disabled by configuration.'
            : 'The request disabled delegation.'
        ),
        record.policy
      );
    }

    const releaseSlot = await this.#dispatchSlots.acquire(signal);
    let plannerJob: JobRecord;
    try {
      const started = await this.#jobs.start({
        prompt: buildPlannerPrompt(record.request, record.policy),
        workspace: record.request.workspace,
        route: record.policy.planner.route,
        ...(record.request.source === undefined ? {} : { source: record.request.source }),
        metadata: {
          ...(record.request.metadata ?? {}),
          agentknotDelegation: { orchestrationId: record.id, role: 'planner', depth: 0 },
        },
      });
      record.plannerJobId = started.job.id;
      try {
        await this.#appendEvent(record, 'orchestration.planner.started', { jobId: started.job.id });
      } catch (error) {
        started.cancel();
        await started.completion;
        throw error;
      }
      plannerJob = await this.#awaitJob(started, signal);
      await this.#appendEvent(record, 'orchestration.planner.completed', {
        jobId: plannerJob.id,
        status: plannerJob.status,
      });
      throwIfAborted(signal);
    } finally {
      releaseSlot();
    }

    try {
      if (plannerJob.status !== 'succeeded' || !plannerJob.result) {
        throw new Error(plannerJob.error?.message ?? `Planner job ended with status ${plannerJob.status}`);
      }
      return composeDelegationPlan(
        record.request,
        parseTaskAssessment(plannerJob.result.output),
        record.policy
      );
    } catch (error) {
      if (record.policy.fallback === 'fail') {
        throw new Error(`Delegation planner failed: ${errorDetails(error).message}`, { cause: error });
      }
      const details = errorDetails(error);
      return rehashDelegationPlan({
        ...composeDelegationPlan(
          { ...record.request, delegation: 'never' },
          skippedTaskAssessment(`Delegation planner failed: ${details.message}`),
          record.policy
        ),
        plannerError: { ...details, jobId: plannerJob.id },
      });
    }
  }

  async #awaitJob(
    started: Awaited<ReturnType<Orchestrator['start']>>,
    signal: AbortSignal
  ): Promise<JobRecord> {
    const onAbort = () => started.cancel();
    if (signal.aborted) started.cancel();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await started.completion;
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
        const started = await this.#jobs.start({
          prompt: subtask.executionPrompt,
          workspace: record.request.workspace,
          route: subtask.route,
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
          started.cancel();
          const job = await started.completion;
          child.status = job.status;
          if (job.result) child.output = job.result.output;
          if (job.error) child.error = structuredClone(job.error);
          throw error;
        }
        const onAbort = () => started.cancel();
        if (signal.aborted) started.cancel();
        else signal.addEventListener('abort', onAbort, { once: true });
        return {
          child,
          cancel: started.cancel,
          completion: started.completion
            .then((job) => ({ job }))
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
        const details = errorDetails(settled.outcome.error);
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
      for (const item of active) item.cancel();
      while (active.length > 0) await settleNext();
      throw error;
    }
  }

  async #appendEvent(
    record: OrchestrationRecord,
    type: OrchestrationEventType,
    data?: Record<string, unknown>,
    at = this.#now().toISOString()
  ): Promise<OrchestrationEvent> {
    let appended: OrchestrationEvent | undefined;
    const previous = this.#recordMutations.get(record.id) ?? Promise.resolve();
    const current = previous.then(async () => {
      const previousUpdatedAt = record.updatedAt;
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
        await this.#store.save(record);
      } catch (error) {
        if (record.events.at(-1) === event) record.events.pop();
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
}

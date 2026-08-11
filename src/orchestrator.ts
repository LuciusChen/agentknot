import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentKnotConfig, ArtifactValidationConfig } from './config.js';
import { canonicalJsonSha256 } from './canonical-json.js';
import { resolveRoute } from './config.js';
import type { ArtifactValidationExecution } from './artifact-validation.js';
import {
  CancellationRequestedError,
} from './durable-record-store.js';
import { DurableExecutionCoordinator } from './durable-execution.js';
import { isTerminalStatus } from './execution-status.js';
import { DurableEventSubscription } from './durable-subscription.js';
import {
  capturedChangedFilesSummary,
  workerReportedSummary,
} from './completion-summary.js';
import { assertJsonMetadata } from './metadata.js';
import {
  MAX_CALLBACK_BODY_BYTES,
  MAX_METADATA_BYTES,
  MAX_PROMPT_BYTES,
  MAX_RESULT_OUTPUT_BYTES,
  MAX_WORKER_EVENTS,
  assertTextLimit,
  limitErrorDetails,
  limitEventData,
  limitObjectData,
  limitText,
  utf8Bytes,
} from './record-limits.js';
import {
  ArtifactSizeLimitError,
  WorkspaceIsolationManager,
  workspaceIsolationMode,
  type IsolatedWorkspace,
  type WorkspaceInspection,
} from './workspace-isolation.js';
import type {
  JobArtifactList,
  JobArtifactPreview,
  JobArtifactVerificationReport,
  JobCompletionSummary,
  JobEvent,
  JobEventType,
  JobExecution,
  JobRecord,
  JobRequest,
  JobRoutePoolSelection,
  JobStore,
  RouteDiagnostic,
  StartJobResult,
  WorkerAdapter,
  WorkerEventSink,
} from './types.js';

export type JobEventListener = (event: JobEvent, job: JobRecord) => Promise<void> | void;

export type JobPersistencePhase = 'admission' | 'event' | 'artifact' | 'terminal';

export class JobPersistenceError extends Error {
  readonly name = 'JobPersistenceError';

  constructor(
    readonly phase: JobPersistencePhase,
    readonly eventType: JobEventType | undefined,
    cause: unknown
  ) {
    const details = limitErrorDetails(cause);
    super(
      `Job persistence failed during ${phase}${eventType === undefined ? '' : ` (${eventType})`}: ${details.message}`,
      { cause }
    );
  }
}

class WorkerToolCallLimitError extends Error {
  readonly name = 'WorkerToolCallLimitError';
}

export const ROUTE_DIAGNOSTIC_TIMEOUT_MS = 30_000;

export interface RouteDiagnosticOptions {
  live?: boolean;
  signal?: AbortSignal;
}

interface LiveProbeOutcome {
  checked: boolean;
  status: RouteDiagnostic['liveInference']['status'];
  message: string;
}

interface RouteReservation {
  route: ReturnType<typeof resolveRoute>;
  selection?: JobRoutePoolSelection;
  release: () => void;
}

interface ActiveJob {
  completion: Promise<JobRecord>;
  cancel: () => void;
}

function delayWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface OrchestratorOptions {
  config: AgentKnotConfig;
  /** Base for relative config paths when constructed by the runtime. */
  baseDirectory?: string;
  store: JobStore;
  adapters: Map<string, WorkerAdapter>;
  onEvent?: JobEventListener;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  /** The production default is the fixed 30-second control-plane probe timeout. */
  diagnosticTimeoutMs?: number;
  /** Stage 3 execution lease duration. Production defaults to 15 seconds. */
  leaseTtlMs?: number;
  /** Durable cancellation/lease observation interval. Production defaults to 2 seconds. */
  leaseHeartbeatMs?: number;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof signal.reason === 'string' && signal.reason !== '') return new Error(signal.reason);
  return new Error('Operation aborted');
}

function normalizeRequest(request: JobRequest): JobRequest {
  if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
    throw new Error('Job prompt must be a non-empty string');
  }
  if (typeof request.workspace !== 'string' || request.workspace.trim() === '') {
    throw new Error('Job workspace must be a non-empty string');
  }
  assertTextLimit('Job prompt', request.prompt, MAX_PROMPT_BYTES);
  if (request.callbackUrl !== undefined) {
    const callback = new URL(request.callbackUrl);
    if (callback.protocol !== 'http:' && callback.protocol !== 'https:') {
      throw new Error('callbackUrl must use http or https');
    }
  }
  if (request.metadata !== undefined) assertJsonMetadata(request.metadata);
  if (request.idempotencyKey !== undefined) {
    if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.trim() === '') {
      throw new Error('Job idempotencyKey must be a non-empty string');
    }
    assertTextLimit('Job idempotencyKey', request.idempotencyKey, 256);
  }
  return {
    prompt: request.prompt,
    workspace: path.resolve(request.workspace),
    ...(request.route === undefined ? {} : { route: request.route }),
    ...(request.source === undefined ? {} : { source: request.source }),
    ...(request.callbackUrl === undefined ? {} : { callbackUrl: request.callbackUrl }),
    ...(request.metadata === undefined ? {} : { metadata: structuredClone(request.metadata) }),
    ...(request.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: request.idempotencyKey }),
  };
}

export class Orchestrator {
  readonly #config: AgentKnotConfig;
  readonly #store: JobStore;
  readonly #adapters: Map<string, WorkerAdapter>;
  readonly #onEvent: JobEventListener | undefined;
  readonly #now: () => Date;
  readonly #fetch: typeof globalThis.fetch;
  readonly #workspaceIsolation: WorkspaceIsolationManager;
  readonly #execution: JobExecution;
  readonly #diagnosticTimeoutMs: number;
  readonly #recordMutations = new Map<string, Promise<void>>();
  readonly #routeActivity = new Map<string, number>();
  readonly #routePoolCursor = new Map<string, number>();
  readonly #activeJobs = new Map<string, ActiveJob>();
  readonly #durability: DurableExecutionCoordinator<JobRecord>;
  readonly #subscriptions: DurableEventSubscription<JobEvent, JobRecord>;

  constructor(options: OrchestratorOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#adapters = options.adapters;
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? (() => new Date());
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#workspaceIsolation = new WorkspaceIsolationManager(options.config, options.baseDirectory);
    this.#diagnosticTimeoutMs = options.diagnosticTimeoutMs ?? ROUTE_DIAGNOSTIC_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#diagnosticTimeoutMs) ||
      this.#diagnosticTimeoutMs < 1 ||
      this.#diagnosticTimeoutMs > ROUTE_DIAGNOSTIC_TIMEOUT_MS
    ) {
      throw new Error(
        `diagnosticTimeoutMs must be an integer between 1 and ${ROUTE_DIAGNOSTIC_TIMEOUT_MS}`
      );
    }
    this.#durability = new DurableExecutionCoordinator(this.#store, {
      now: this.#now,
      ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
      ...(options.leaseHeartbeatMs === undefined
        ? {}
        : { leaseHeartbeatMs: options.leaseHeartbeatMs }),
    });
    this.#subscriptions = new DurableEventSubscription(this.#store, (job) =>
      isTerminalStatus(job.status)
    );
    this.#execution = {
      runtimeId: randomUUID(),
      pid: process.pid,
      startedAt: this.#now().toISOString(),
    };
  }

  routes(): Array<{ name: string; worker: string; provider: string; model: string }> {
    return Object.keys(this.#config.routes).map((name) => {
      const route = resolveRoute(this.#config, name);
      return { name, worker: route.worker, provider: route.provider, model: route.model };
    });
  }

  workspaceIsolationMode(): ReturnType<typeof workspaceIsolationMode> {
    return workspaceIsolationMode(this.#config);
  }

  async doctor(routeName?: string, options: RouteDiagnosticOptions = {}): Promise<RouteDiagnostic> {
    const live = options.live === true;
    const route = resolveRoute(this.#config, routeName);
    const adapter = this.#adapters.get(route.worker);
    if (!adapter) {
      return {
        ok: false,
        message: `No adapter for worker "${route.worker}"; live inference was not checked`,
        route: route.name,
        liveInference: { checked: false, status: 'not-checked' },
      };
    }

    const health = await adapter.doctor(route);
    if (!live) {
      return {
        ...health,
        route: route.name,
        message: `${health.message}; live inference was not checked`,
        liveInference: { checked: false, status: 'not-checked' },
      };
    }
    if (!health.ok) {
      return {
        ...health,
        route: route.name,
        message: `${health.message}; live inference was not checked because the configuration/credential check failed`,
        liveInference: { checked: false, status: 'not-checked' },
      };
    }
    if (!adapter.probe) {
      return {
        ok: false,
        message: `Live inference probe is unsupported for worker "${adapter.name}"`,
        route: route.name,
        ...(health.details === undefined ? {} : { details: { ...health.details } }),
        liveInference: { checked: false, status: 'unsupported' },
      };
    }

    const probe = await this.#runLiveProbe(adapter.probe.bind(adapter), route, options.signal);
    if (probe.status === 'succeeded') {
      return {
        ...health,
        ok: true,
        route: route.name,
        message: `${health.message}; live inference succeeded for ${route.provider}/${route.model} (thinking level ${route.thinkingLevel ?? 'default'})`,
        ...(health.details === undefined
          ? {}
          : { details: { ...health.details, liveInference: 'succeeded' } }),
        liveInference: { checked: probe.checked, status: probe.status },
      };
    }
    return {
      ok: false,
      message: probe.message,
      route: route.name,
      ...(health.details === undefined
        ? {}
        : { details: { ...health.details, liveInference: probe.status } }),
      liveInference: { checked: probe.checked, status: probe.status },
    };
  }

  async #runLiveProbe(
    adapterProbe: NonNullable<WorkerAdapter['probe']>,
    route: ReturnType<typeof resolveRoute>,
    outerSignal: AbortSignal | undefined
  ): Promise<LiveProbeOutcome> {
    if (outerSignal?.aborted) {
      return {
        checked: false,
        status: 'aborted',
        message: `Live inference probe aborted: ${abortError(outerSignal).message}`,
      };
    }

    const controller = new AbortController();
    let timedOut = false;
    let resolveCancellation!: (outcome: { kind: 'timeout' | 'aborted' }) => void;
    const cancellation = new Promise<{ kind: 'timeout' | 'aborted' }>((resolve) => {
      resolveCancellation = resolve;
    });
    const onAbort = () => {
      controller.abort(abortError(outerSignal as AbortSignal));
      resolveCancellation({ kind: 'aborted' });
    };
    outerSignal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Live inference probe timed out after ${this.#diagnosticTimeoutMs}ms`));
      resolveCancellation({ kind: 'timeout' });
    }, this.#diagnosticTimeoutMs);

    const probe = Promise.resolve()
      .then(() => adapterProbe({ route, signal: controller.signal }))
      .then(
        () => ({ kind: 'completed' as const }),
        (error: unknown) => ({ kind: 'failed' as const, error })
      );

    try {
      const outcome = await Promise.race([probe, cancellation]);
      if (outcome.kind === 'timeout' || timedOut) {
        // A supported adapter must settle after abort. Waiting here keeps process and temporary
        // workspace cleanup inside the diagnostic lifecycle instead of detaching it.
        await probe;
        return {
          checked: true,
          status: 'timeout',
          message: `Live inference probe timed out after ${this.#diagnosticTimeoutMs}ms`,
        };
      }
      if (outcome.kind === 'aborted' || outerSignal?.aborted) {
        await probe;
        const reason = outerSignal?.aborted ? abortError(outerSignal) : abortError(controller.signal);
        return {
          checked: true,
          status: 'aborted',
          message: `Live inference probe aborted: ${reason.message}`,
        };
      }
      if (outcome.kind === 'failed') {
        return {
          checked: true,
          status: 'failed',
          message: `Live inference probe failed: ${limitErrorDetails(outcome.error).message}`,
        };
      }
      return { checked: true, status: 'succeeded', message: '' };
    } finally {
      clearTimeout(timeout);
      outerSignal?.removeEventListener('abort', onAbort);
      // The adapter receives the abort signal and owns its process/resource cleanup.
    }
  }

  #completionSummary(
    job: JobRecord,
    outcome: JobCompletionSummary['outcome'],
    retainedNormalResult: boolean,
    workerReport: unknown
  ): JobCompletionSummary {
    return {
      schemaVersion: 1,
      outcome,
      attempt: job.attempt,
      changedFiles: capturedChangedFilesSummary(
        this.#workspaceIsolation.mode === 'git-worktree',
        job.artifacts,
        job.attempt
      ),
      workerReported: workerReportedSummary(workerReport, retainedNormalResult),
    };
  }

  async get(id: string): Promise<JobRecord | undefined> {
    return this.#store.get(id);
  }

  async list(): Promise<JobRecord[]> {
    return this.#store.list();
  }

  async wait(
    id: string,
    timeoutMs = 5_000,
    signal?: AbortSignal
  ): Promise<JobRecord | undefined> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
      throw new Error('Job wait timeout must be an integer between 0 and 60000');
    }
    return this.#subscriptions.wait(id, timeoutMs, signal === undefined ? {} : { signal });
  }

  eventsAfter(id: string, sequence: number): Promise<JobEvent[]> {
    return this.#subscriptions.eventsAfter(id, sequence);
  }

  subscribe(
    id: string,
    afterSequence = 0,
    signal?: AbortSignal
  ): AsyncIterable<JobEvent> {
    return this.#subscriptions.subscribe(
      id,
      afterSequence,
      signal === undefined ? {} : { signal }
    );
  }

  async cancel(id: string, source = 'controller'): Promise<boolean> {
    const current = await this.#store.get(id);
    if (current === undefined || isTerminalStatus(current.status)) return false;
    const active = this.#activeJobs.get(id);
    try {
      if (this.#durability.enabled) {
        const accepted = await this.#durability.requestCancellation(id, source);
        if (accepted === undefined) return false;
      } else if (active === undefined) {
        return false;
      }
    } catch (error) {
      active?.cancel();
      throw error;
    }
    active?.cancel();
    return true;
  }

  async shutdown(): Promise<void> {
    const active = [...this.#activeJobs.entries()];
    await Promise.allSettled(active.map(([id]) => this.cancel(id, 'kernel-shutdown')));
    await Promise.allSettled(active.map(([, item]) => item.completion));
  }

  hasActiveJobs(): boolean {
    return this.#activeJobs.size > 0;
  }

  async #waitUntilTerminal(id: string): Promise<JobRecord> {
    const record = await this.#subscriptions.awaitTerminal(id);
    if (record === undefined) throw new Error(`Job ${id} disappeared while waiting`);
    return record;
  }

  async #save(job: JobRecord): Promise<void> {
    await this.#durability.save(job);
    this.#subscriptions.notifyPersisted(job.id);
  }

  #startLeaseMonitor(job: JobRecord, controller: AbortController): () => Promise<void> {
    return this.#durability.monitor(job.id, controller);
  }

  async listArtifacts(id: string): Promise<JobArtifactList | undefined> {
    const job = await this.#store.get(id);
    if (!job) return undefined;
    return { jobId: job.id, artifacts: structuredClone(job.artifacts ?? []) };
  }

  async verifyArtifacts(id: string): Promise<JobArtifactVerificationReport | undefined> {
    const job = await this.#store.get(id);
    if (!job) return undefined;
    const artifacts = await this.#workspaceIsolation.verifyArtifacts(
      job.id,
      job.request.workspace,
      job.artifacts ?? []
    );
    return {
      jobId: job.id,
      artifacts,
      valid: artifacts.every((artifact) => artifact.valid),
    };
  }

  async previewArtifact(id: string, attempt: number): Promise<JobArtifactPreview | undefined> {
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error('Artifact attempt must be a positive integer');
    }
    const job = await this.#store.get(id);
    if (!job) return undefined;
    const artifact = (job.artifacts ?? []).find((candidate) => candidate.attempt === attempt);
    if (!artifact) return undefined;
    const preview = await this.#workspaceIsolation.previewArtifact(
      job.id,
      job.request.workspace,
      artifact
    );
    return {
      jobId: job.id,
      artifact: structuredClone(artifact),
      format: 'git-patch',
      encoding: 'utf-8',
      ...preview,
    };
  }

  async validateArtifact(
    id: string,
    attempt: number,
    config: ArtifactValidationConfig,
    signal: AbortSignal
  ): Promise<ArtifactValidationExecution | undefined> {
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error('Artifact attempt must be a positive integer');
    }
    const job = await this.#store.get(id);
    if (!job) return undefined;
    const artifact = (job.artifacts ?? []).find((candidate) => candidate.attempt === attempt);
    if (!artifact) return undefined;
    return this.#workspaceIsolation.validateArtifact(
      job.id,
      job.request.workspace,
      artifact,
      config,
      signal
    );
  }

  async recoverInterruptedJobs(
    options: { waitForLease?: boolean; signal?: AbortSignal; skipDelegated?: boolean } = {}
  ): Promise<JobRecord[]> {
    if (!this.#durability.enabled) {
      throw new Error('Job recovery requires a durable execution store');
    }
    const recovered: JobRecord[] = [];
    for (const job of await this.#store.list()) {
      if (job.status !== 'queued' && job.status !== 'running') continue;
      if (options.skipDelegated === true && this.#delegatedParentId(job) !== undefined) continue;
      const current = await this.#recoverInterruptedJob(job, options);
      if (current !== undefined) recovered.push(current);
    }
    return recovered;
  }

  async recoverInterruptedJob(
    id: string,
    options: { waitForLease?: boolean; signal?: AbortSignal } = {}
  ): Promise<JobRecord | undefined> {
    if (!this.#durability.enabled) {
      throw new Error('Job recovery requires a durable execution store');
    }
    const job = await this.#store.get(id);
    if (job === undefined || isTerminalStatus(job.status)) return job;
    return this.#recoverInterruptedJob(job, options);
  }

  findIdempotent(idempotencyKey: string): Promise<JobRecord | undefined> {
    if (this.#store.findIdempotent === undefined) {
      throw new Error('Job idempotency lookup requires a durable execution store');
    }
    return this.#store.findIdempotent('job-admission-v1', idempotencyKey);
  }

  async #recoverInterruptedJob(
    listedJob: JobRecord,
    options: { waitForLease?: boolean; signal?: AbortSignal }
  ): Promise<JobRecord | undefined> {
    let job = listedJob;
    if (job.status !== 'queued' && job.status !== 'running') return structuredClone(job);
    if (this.#activeJobs.has(job.id)) return structuredClone(job);

    const lease = await this.#claimRecoveryLease(job.id, options);
    if (lease === undefined) return undefined;
    let activated = false;
    try {
      const current = await this.#store.get(job.id);
      if (current === undefined) {
        throw new Error(`Job ${job.id} disappeared after its recovery lease was claimed`);
      }
      if (isTerminalStatus(current.status)) return structuredClone(current);
      if (current.status !== 'queued' && current.status !== 'running') {
        throw new Error(`Job ${current.id} has unsupported recovery status ${current.status}`);
      }
      job = current;
      const cancellation = await this.#durability.getCancellation(job.id);
      if (cancellation !== undefined) {
        await this.#settleRecoveredJob(job, 'cancelled', {
          name: 'CancellationRequestedError',
          message: `Job cancellation was requested by ${cancellation.source}`,
          reason: 'cancellation-requested-before-recovery',
          source: cancellation.source,
          requestedAt: cancellation.requestedAt,
        });
        return structuredClone(job);
      }

      const previousStatus = job.status;
      const previousExecution = job.execution;
      job.execution = structuredClone(this.#execution);
      let startAttempt = 1;
      if (previousStatus === 'running') {
        const retryable = job.attempt < job.route.maxAttempts;
        const message = `Worker attempt ${job.attempt} lost its execution owner before a terminal result was persisted`;
        job.error = {
          name: 'ExecutionLeaseLostError',
          message,
          attempt: job.attempt,
          retryable,
        };
        await this.#emit(job, 'job.attempt.lost', {
          attempt: job.attempt,
          reason: 'lease-expired',
          previousRuntimeId: previousExecution?.runtimeId ?? 'unknown',
          recoveryFence: lease.fence,
          retryable,
        });
        if (!retryable) {
          await this.#settleRecoveredJob(job, 'failed', {
            name: 'ExecutionLeaseLostError',
            message,
            reason: 'recovery-attempts-exhausted',
          });
          return structuredClone(job);
        }
        startAttempt = job.attempt + 1;
      } else if (job.attempt !== 0) {
        await this.#settleRecoveredJob(job, 'failed', {
          name: 'RecoveryStateError',
          message: `Queued Job ${job.id} has invalid attempt ${job.attempt}`,
          reason: 'invalid-queued-attempt',
        });
        return structuredClone(job);
      }

      const adapter = this.#adapters.get(job.route.worker);
      if (adapter === undefined) {
        await this.#settleRecoveredJob(job, 'failed', {
          name: 'RecoveryAdapterUnavailableError',
          message: `Persisted worker adapter "${job.route.worker}" is unavailable during recovery`,
          reason: 'worker-adapter-unavailable',
        });
        return structuredClone(job);
      }

      if (this.#workspaceIsolation.mode !== 'git-worktree' || job.workspaceSnapshot === undefined) {
        await this.#settleRecoveredJob(job, 'failed', {
          name: 'RecoverySnapshotUnavailableError',
          message: 'The Job has no immutable admitted workspace snapshot for recovery',
          reason: 'workspace-snapshot-unavailable',
        });
        return structuredClone(job);
      }
      let inspection: WorkspaceInspection;
      try {
        inspection = await this.#workspaceIsolation.restoreAdmissionSnapshot(
          job.id,
          job.request.workspace,
          job.workspaceSnapshot
        );
      } catch (error) {
        const details = limitErrorDetails(error);
        await this.#settleRecoveredJob(job, 'failed', {
          name: 'RecoverySnapshotUnavailableError',
          message: details.message,
          reason: 'workspace-snapshot-invalid',
        });
        return structuredClone(job);
      }

      job.attempt = startAttempt;
      await this.#emit(job, 'job.recovery.started', {
        previousStatus,
        previousRuntimeId: previousExecution?.runtimeId ?? 'unknown',
        recoveryFence: lease.fence,
        nextAttempt: startAttempt,
      });
      const reservation = this.#reservePersistedRoute(job);
      const controller = new AbortController();
      const started = this.#activate(
        job,
        adapter,
        controller,
        inspection,
        reservation,
        startAttempt
      );
      activated = true;
      return started.job;
    } finally {
      if (!activated) await this.#durability.release(job.id);
    }
  }

  #delegatedParentId(job: JobRecord): string | undefined {
    const delegated = job.request.metadata?.agentknotDelegation;
    if (typeof delegated !== 'object' || delegated === null || Array.isArray(delegated)) return undefined;
    const value = delegated as Record<string, unknown>;
    return value.depth === 1 &&
      (value.role === 'worker' || value.role === 'reviewer') &&
      typeof value.orchestrationId === 'string'
      ? value.orchestrationId
      : undefined;
  }

  async #claimRecoveryLease(
    recordId: string,
    options: { waitForLease?: boolean; signal?: AbortSignal }
  ): Promise<Awaited<ReturnType<DurableExecutionCoordinator<JobRecord>['claim']>>> {
    while (true) {
      if (options.signal?.aborted) throw abortError(options.signal);
      const claimed = await this.#durability.claim(recordId, this.#execution.runtimeId);
      if (claimed !== undefined || options.waitForLease !== true) return claimed;
      const current = await this.#durability.getLease(recordId);
      const expiresAt = current === undefined ? NaN : Date.parse(current.expiresAt);
      const waitMs = Number.isFinite(expiresAt)
        ? Math.max(1, expiresAt - this.#now().getTime())
        : 1;
      await delayWithSignal(waitMs, options.signal);
    }
  }

  async #settleRecoveredJob(
    job: JobRecord,
    outcome: 'failed' | 'cancelled',
    details: { name: string; message: string; reason: string; [key: string]: unknown }
  ): Promise<void> {
    job.status = outcome;
    job.completedAt = this.#now().toISOString();
    delete job.result;
    delete job.callback;
    job.error = {
      name: details.name,
      message: details.message,
      attempt: job.attempt,
      retryable: false,
    };
    job.completionSummary = this.#completionSummary(job, outcome, false, undefined);
    await this.#emit(
      job,
      outcome === 'cancelled' ? 'job.cancelled' : 'job.failed',
      { ...details, attempt: job.attempt },
      job.completedAt
    );
    await this.#deliverCallback(job);
  }

  async run(request: JobRequest): Promise<JobRecord> {
    const started = await this.start(request);
    return started.completion;
  }

  #reserveRoute(targetName?: string): RouteReservation {
    const target = targetName ?? this.#config.defaultRoute;
    const pool = this.#config.routePools?.[target];
    let routeName = target;
    let selection: JobRoutePoolSelection | undefined;

    if (pool) {
      const activeBefore = Object.fromEntries(
        pool.routes.map((candidate) => [candidate, this.#routeActivity.get(candidate) ?? 0])
      );
      const minimum = Math.min(...Object.values(activeBefore));
      const cursor = this.#routePoolCursor.get(target) ?? 0;
      let selectedIndex = -1;
      for (let offset = 0; offset < pool.routes.length; offset += 1) {
        const index = (cursor + offset) % pool.routes.length;
        const candidate = pool.routes[index]!;
        if (activeBefore[candidate] === minimum) {
          selectedIndex = index;
          break;
        }
      }
      if (selectedIndex < 0) throw new Error(`Route pool "${target}" has no selectable member`);
      routeName = pool.routes[selectedIndex]!;
      this.#routePoolCursor.set(target, (selectedIndex + 1) % pool.routes.length);
      selection = {
        pool: target,
        strategy: pool.strategy,
        candidates: [...pool.routes],
        selectedRoute: routeName,
        activeBefore,
        cursorBefore: cursor,
        selectedMemberIndex: selectedIndex,
        tieBreak: 'rotating-order',
      };
    }

    const route = resolveRoute(this.#config, routeName);
    return this.#durability.routePoolAdmissionEnabled && selection === undefined
      ? { route, release: () => undefined }
      : this.#trackRoute(route, selection);
  }

  #trackRoute(
    route: RouteReservation['route'],
    selection?: JobRoutePoolSelection
  ): RouteReservation {
    this.#routeActivity.set(route.name, (this.#routeActivity.get(route.name) ?? 0) + 1);
    let released = false;
    return {
      route,
      ...(selection === undefined ? {} : { selection }),
      release: () => {
        if (released) return;
        released = true;
        const active = this.#routeActivity.get(route.name) ?? 0;
        if (active <= 1) this.#routeActivity.delete(route.name);
        else this.#routeActivity.set(route.name, active - 1);
      },
    };
  }

  #reservePersistedRoute(job: JobRecord): RouteReservation {
    const route = structuredClone(job.route);
    return this.#durability.routePoolAdmissionEnabled
      ? { route, release: () => undefined }
      : this.#trackRoute(route);
  }

  async captureWorkspaceSnapshot(
    workspace: string,
    executionId: string
  ): Promise<NonNullable<JobRecord['workspaceSnapshot']>> {
    if (this.#workspaceIsolation.mode !== 'git-worktree') {
      throw new Error('Immutable parent workspace admission requires git-worktree isolation');
    }
    const resolved = path.resolve(workspace);
    const workspaceStat = await stat(resolved).catch(() => undefined);
    if (!workspaceStat?.isDirectory()) throw new Error(`Workspace is not a directory: ${resolved}`);
    const inspection = await this.#workspaceIsolation.inspect(resolved);
    return this.#workspaceIsolation.persistAdmissionSnapshot(inspection, executionId);
  }

  discardWorkspaceSnapshot(executionId: string): Promise<void> {
    return this.#workspaceIsolation.discardAdmissionSnapshot(executionId);
  }

  async startFromWorkspaceSnapshot(
    request: JobRequest,
    executionId: string,
    snapshot: NonNullable<JobRecord['workspaceSnapshot']>
  ): Promise<StartJobResult> {
    if (this.#workspaceIsolation.mode !== 'git-worktree') {
      throw new Error('Immutable child workspace admission requires git-worktree isolation');
    }
    const normalized = normalizeRequest(request);
    const inspection = await this.#workspaceIsolation.restoreAdmissionSnapshot(
      executionId,
      normalized.workspace,
      snapshot
    );
    return this.#startInspected(normalized, inspection);
  }

  async start(request: JobRequest): Promise<StartJobResult> {
    const normalized = normalizeRequest(request);
    const workspaceStat = await stat(normalized.workspace).catch(() => undefined);
    if (!workspaceStat?.isDirectory()) {
      throw new Error(`Workspace is not a directory: ${normalized.workspace}`);
    }
    const inspection =
      this.#workspaceIsolation.mode === 'git-worktree'
        ? await this.#workspaceIsolation.inspect(normalized.workspace)
        : undefined;
    return this.#startInspected(normalized, inspection);
  }

  async #startInspected(
    normalized: ReturnType<typeof normalizeRequest>,
    inspection: WorkspaceInspection | undefined
  ): Promise<StartJobResult> {
    const now = this.#now().toISOString();
    const id = `job_${randomUUID()}`;
    let snapshotPersisted = false;
    let workspaceSnapshot: JobRecord['workspaceSnapshot'];
    try {
      if (inspection !== undefined) {
        workspaceSnapshot = await this.#workspaceIsolation.persistAdmissionSnapshot(inspection, id);
        snapshotPersisted = workspaceSnapshot.size > 0;
      }
    } catch (error) {
      throw new JobPersistenceError('admission', undefined, error);
    }
    const controller = new AbortController();
    let reservation: RouteReservation | undefined;
    let adapter: WorkerAdapter | undefined;
    let job: JobRecord | undefined;
    let admitted = true;
    let admittedRecord: JobRecord | undefined;
    const idempotency =
      normalized.idempotencyKey === undefined
        ? undefined
        : {
            scope: 'job-admission-v1',
            key: normalized.idempotencyKey,
            requestHash: canonicalJsonSha256(normalized),
          };
    try {
      const target = normalized.route ?? this.#config.defaultRoute;
      const pool = this.#config.routePools?.[target];
      if (pool !== undefined && this.#durability.routePoolAdmissionEnabled) {
        const result = await this.#durability.admitRoutePool({
          ownerId: this.#execution.runtimeId,
          cursorKey: canonicalJsonSha256({
            pool: target,
            strategy: pool.strategy,
            candidates: pool.routes,
          }),
          candidates: pool.routes,
          ...(idempotency === undefined ? {} : { idempotency }),
          createRecord: (choice) => {
            const route = resolveRoute(this.#config, choice.selectedRoute);
            const selectedAdapter = this.#adapters.get(route.worker);
            if (selectedAdapter === undefined) {
              throw new Error(`No adapter registered for worker "${route.worker}"`);
            }
            adapter = selectedAdapter;
            reservation = {
              route,
              selection: {
                pool: target,
                strategy: pool.strategy,
                candidates: [...pool.routes],
                selectedRoute: choice.selectedRoute,
                activeBefore: choice.activeBefore,
                cursorBefore: choice.cursorBefore,
                selectedMemberIndex: choice.selectedMemberIndex,
                tieBreak: 'rotating-order',
              },
              release: () => undefined,
            };
            job = this.#queuedJob(id, now, normalized, reservation, workspaceSnapshot);
            return job;
          },
        });
        if (result === undefined) throw new Error('Durable Job admission is unavailable');
        admitted = result.created;
        admittedRecord = result.record;
      } else {
        reservation = this.#reserveRoute(normalized.route);
        adapter = this.#adapters.get(reservation.route.worker);
        if (adapter === undefined) {
          throw new Error(`No adapter registered for worker "${reservation.route.worker}"`);
        }
        job = this.#queuedJob(id, now, normalized, reservation, workspaceSnapshot);
        admittedRecord = job;
        if (this.#durability.enabled) {
          const result = await this.#durability.admit(job, {
            ownerId: this.#execution.runtimeId,
            ...(idempotency === undefined ? {} : { idempotency }),
          });
          if (result === undefined) throw new Error('Durable Job admission is unavailable');
          admitted = result.created;
          admittedRecord = result.record;
        } else if (idempotency !== undefined) {
          if (this.#store.createIdempotent === undefined) {
            throw new Error('The selected Job store does not support idempotent admission');
          }
          const result = await this.#store.createIdempotent(
            idempotency.scope,
            idempotency.key,
            idempotency.requestHash,
            job
          );
          admitted = result.created;
          admittedRecord = result.record;
        } else {
          await this.#store.create(job);
        }
      }
    } catch (error) {
      if (snapshotPersisted) {
        await this.#workspaceIsolation.discardAdmissionSnapshot(id).catch(() => undefined);
      }
      reservation?.release();
      throw new JobPersistenceError('admission', undefined, error);
    }
    if (admittedRecord === undefined) {
      throw new JobPersistenceError('admission', undefined, new Error('Job admission returned no record'));
    }
    if (admitted) this.#subscriptions.notifyPersisted(admittedRecord.id);
    if (!admitted) {
      if (snapshotPersisted) {
        await this.#workspaceIsolation.discardAdmissionSnapshot(id);
      }
      reservation?.release();
      const active = this.#activeJobs.get(admittedRecord.id);
      if (active !== undefined) {
        return {
          job: structuredClone(admittedRecord),
          completion: active.completion,
          cancel: async () => {
            await this.cancel(admittedRecord.id, 'idempotent-controller');
          },
        };
      }
      return {
        job: structuredClone(admittedRecord),
        completion: isTerminalStatus(admittedRecord.status)
          ? Promise.resolve(structuredClone(admittedRecord))
          : this.#waitUntilTerminal(admittedRecord.id),
        cancel: async () => {
          await this.cancel(admittedRecord.id, 'idempotent-controller');
        },
      };
    }
    if (job === undefined || adapter === undefined || reservation === undefined) {
      await this.#durability.release(admittedRecord.id);
      throw new JobPersistenceError(
        'admission',
        undefined,
        new Error('New Job admission did not retain its selected execution route')
      );
    }
    try {
      await this.#notifyObserver(job, job.events[0]!);
    } catch (error) {
      await this.#durability.release(job.id);
      reservation.release();
      throw error;
    }

    return this.#activate(job, adapter, controller, inspection, reservation, 1);
  }

  #queuedJob(
    id: string,
    now: string,
    request: ReturnType<typeof normalizeRequest>,
    reservation: RouteReservation,
    workspaceSnapshot: JobRecord['workspaceSnapshot']
  ): JobRecord {
    return {
      id,
      schemaVersion: 1,
      status: 'queued',
      request,
      route: reservation.route,
      ...(reservation.selection === undefined
        ? {}
        : { routePoolSelection: structuredClone(reservation.selection) }),
      createdAt: now,
      updatedAt: now,
      attempt: 0,
      events: [
        {
          sequence: 1,
          jobId: id,
          at: now,
          type: 'job.queued',
          data: { source: request.source ?? 'unknown' },
        },
      ],
      execution: structuredClone(this.#execution),
      ...(workspaceSnapshot === undefined ? {} : { workspaceSnapshot }),
    };
  }

  #activate(
    job: JobRecord,
    adapter: WorkerAdapter,
    controller: AbortController,
    inspection: WorkspaceInspection | undefined,
    reservation: RouteReservation,
    startAttempt: number
  ): StartJobResult {
    const stopLeaseMonitor = this.#startLeaseMonitor(job, controller);
    const execution = this.#execute(
      job,
      adapter,
      controller.signal,
      inspection,
      startAttempt
    ).catch(
      async (error: unknown) => {
        const cancellation =
          error instanceof JobPersistenceError &&
          error.cause instanceof CancellationRequestedError
            ? error.cause.request
            : undefined;
        if (cancellation !== undefined) {
          controller.abort(error);
          job.status = 'cancelled';
          job.completedAt = this.#now().toISOString();
          delete job.result;
          job.error = {
            name: 'CancellationRequestedError',
            message: `Job cancellation was requested by ${cancellation.source}`,
            attempt: job.attempt,
            retryable: false,
          };
          job.completionSummary = this.#completionSummary(job, 'cancelled', false, undefined);
          await this.#emit(job, 'job.cancelled', {
            source: cancellation.source,
            requestedAt: cancellation.requestedAt,
          });
          return;
        }
        if (error instanceof JobPersistenceError) throw error;
        if (job.status !== 'failed' && job.status !== 'cancelled') {
          const details = limitErrorDetails(error);
          job.status = controller.signal.aborted ? 'cancelled' : 'failed';
          job.completedAt = this.#now().toISOString();
          job.error = {
            ...details,
            attempt: job.attempt,
            retryable: false,
          };
          const outcome = controller.signal.aborted ? 'cancelled' : 'failed';
          job.completionSummary = this.#completionSummary(job, outcome, false, undefined);
          await this.#emit(job, controller.signal.aborted ? 'job.cancelled' : 'job.failed', details);
        }
      }
    );
    const completion = execution
      .then(async () => {
        await this.#deliverCallback(job);
        return structuredClone(job);
      })
      .finally(async () => {
        await stopLeaseMonitor();
        await this.#durability.release(job.id);
        reservation.release();
      });

    const localCancel = () => controller.abort(new Error('Job cancelled by controller'));
    const cancel = async () => {
      await this.cancel(job.id, 'start-handle');
    };
    this.#activeJobs.set(job.id, { completion, cancel: localCancel });
    void completion.then(
      () => this.#activeJobs.delete(job.id),
      () => this.#activeJobs.delete(job.id)
    );

    return {
      job: structuredClone(job),
      completion,
      cancel,
    };
  }

  async #execute(
    job: JobRecord,
    adapter: WorkerAdapter,
    jobSignal: AbortSignal,
    inspection: WorkspaceInspection | undefined,
    startAttempt: number
  ): Promise<void> {
    if (job.status === 'queued') {
      const previousAttempt = job.attempt;
      job.attempt = startAttempt;
      job.status = 'running';
      job.startedAt = this.#now().toISOString();
      try {
        await this.#emit(job, 'job.started', {
          route: job.route.name,
          worker: job.route.worker,
          provider: job.route.provider,
          model: job.route.model,
        });
      } catch (error) {
        job.attempt = previousAttempt;
        throw error;
      }
    }

    for (let attempt = startAttempt; attempt <= job.route.maxAttempts; attempt += 1) {
      if (job.attempt !== attempt) {
        throw new Error(
          `Job ${job.id} attempt reservation ${job.attempt} does not match execution attempt ${attempt}`
        );
      }
      const attemptController = new AbortController();
      const onJobAbort = () => attemptController.abort(jobSignal.reason);
      if (jobSignal.aborted) attemptController.abort(jobSignal.reason);
      else jobSignal.addEventListener('abort', onJobAbort, { once: true });
      const timeout = setTimeout(
        () => attemptController.abort(new Error(`Worker timed out after ${job.route.timeoutMs}ms`)),
        job.route.timeoutMs
      );
      let attemptActive = true;
      let toolCalls = 0;
      const workerEmit: WorkerEventSink = async (type, data) => {
        if (!attemptActive) return;
        if (type === 'worker.tool.started' && job.route.maxToolCalls !== undefined) {
          toolCalls += 1;
          if (toolCalls > job.route.maxToolCalls) {
            const error = new WorkerToolCallLimitError(
              `Worker exceeded route ${job.route.name} tool-call limit of ${job.route.maxToolCalls}`
            );
            attemptController.abort(error);
            throw error;
          }
        }
        await this.#emit(job, type, data);
      };
      let isolated: IsolatedWorkspace | undefined;
      let result: Awaited<ReturnType<WorkerAdapter['run']>> | undefined;
      let failure: unknown;

      try {
        if (inspection) isolated = await this.#workspaceIsolation.create(inspection, job.id, attempt);
        if (attemptController.signal.aborted) {
          throw attemptController.signal.reason instanceof Error
            ? attemptController.signal.reason
            : new Error('Job cancelled');
        }
        result = await adapter.run(
          {
            jobId: job.id,
            prompt: job.request.prompt,
            workspace: isolated?.path ?? job.request.workspace,
            route: job.route,
            attempt,
            signal: attemptController.signal,
          },
          workerEmit
        );
        if (attemptController.signal.aborted) {
          throw attemptController.signal.reason instanceof Error
            ? attemptController.signal.reason
            : new Error('Worker attempt aborted');
        }
      } catch (error) {
        failure = error;
      } finally {
        attemptActive = false;
        clearTimeout(timeout);
        jobSignal.removeEventListener('abort', onJobAbort);
        if (isolated) {
          try {
            const artifact = await this.#workspaceIsolation.capturePatch(isolated, job.id, attempt);
            const previousArtifacts = job.artifacts;
            job.artifacts = [...(job.artifacts ?? []), artifact];
            try {
              await this.#emit(job, 'job.artifact', { ...artifact });
            } catch (error) {
              if (error instanceof JobPersistenceError && error.eventType === 'job.artifact') {
                if (previousArtifacts === undefined) delete job.artifacts;
                else job.artifacts = previousArtifacts;
                try {
                  await this.#workspaceIsolation.discardPatch(job.id, artifact);
                } catch (cleanupError) {
                  throw new JobPersistenceError(
                    'artifact',
                    'job.artifact',
                    new AggregateError([error, cleanupError], 'Artifact persistence and cleanup failed')
                  );
                }
              }
              throw error;
            }
          } catch (error) {
            if (failure === undefined) failure = error;
          } finally {
            try {
              await this.#workspaceIsolation.cleanup(isolated);
            } catch (error) {
              if (failure === undefined) failure = error;
            }
          }
        }
      }

      if (failure === undefined && result !== undefined) {
        const boundedOutput = limitText(result.output, MAX_RESULT_OUTPUT_BYTES);
        job.status = 'succeeded';
        job.completedAt = this.#now().toISOString();
        job.result = {
          output: boundedOutput.value,
          ...(boundedOutput.truncation === undefined
            ? {}
            : { outputTruncation: boundedOutput.truncation }),
          attempt,
          worker: job.route.worker,
          provider: job.route.provider,
          model: job.route.model,
          ...(result.metadata === undefined
            ? {}
            : { metadata: limitObjectData(result.metadata, 'result.metadata', MAX_METADATA_BYTES) }),
        };
        delete job.error;
        job.completionSummary = this.#completionSummary(job, 'succeeded', true, result.completionReport);
        await this.#emit(job, 'job.succeeded', { attempt });
        return;
      }

      if (failure instanceof JobPersistenceError) throw failure;

      const details = limitErrorDetails(failure ?? new Error('Worker returned no result'));
      const retryable =
        !(failure instanceof ArtifactSizeLimitError) &&
        !(failure instanceof WorkerToolCallLimitError) &&
        !jobSignal.aborted &&
        attempt < job.route.maxAttempts;
      job.error = { ...details, attempt, retryable };
      if (!retryable) {
        const outcome = jobSignal.aborted ? 'cancelled' : 'failed';
        job.status = outcome;
        job.completedAt = this.#now().toISOString();
        job.completionSummary = this.#completionSummary(job, outcome, false, undefined);
        await this.#emit(job, jobSignal.aborted ? 'job.cancelled' : 'job.failed', {
          ...details,
          attempt,
        });
        return;
      }
      const nextAttempt = attempt + 1;
      job.attempt = nextAttempt;
      try {
        await this.#emit(job, 'job.retrying', { ...details, attempt, nextAttempt });
      } catch (error) {
        job.attempt = attempt;
        throw error;
      }
    }
  }

  async #emit(
    job: JobRecord,
    type: JobEventType,
    data?: Record<string, unknown>,
    at?: string
  ): Promise<void> {
    const event = await this.#appendEvent(job, type, data, at);
    if (!event) return;
    await this.#notifyObserver(job, event);
  }

  async #notifyObserver(job: JobRecord, event: JobEvent): Promise<void> {
    if (!this.#onEvent) return;
    try {
      await this.#onEvent(structuredClone(event), structuredClone(job));
    } catch (error) {
      await this.#appendEvent(job, 'job.observer.failed', {
        observedEventSequence: event.sequence,
        observedEventType: event.type,
        ...limitErrorDetails(error),
      });
    }
  }

  async #appendEvent(
    job: JobRecord,
    type: JobEventType,
    data?: Record<string, unknown>,
    at = this.#now().toISOString()
  ): Promise<JobEvent | undefined> {
    let appended: JobEvent | undefined;
    const previous = this.#recordMutations.get(job.id) ?? Promise.resolve();
    const current = previous.then(async () => {
      let appendedType = type;
      let appendedData = data;
      if (type.startsWith('worker.')) {
        const workerEventCount = job.events.filter((event) => event.type.startsWith('worker.')).length;
        if (workerEventCount >= MAX_WORKER_EVENTS) {
          if (job.events.some((event) => event.type === 'job.worker.events.truncated')) return;
          appendedType = 'job.worker.events.truncated';
          appendedData = { maxEvents: MAX_WORKER_EVENTS, firstDroppedEventType: type };
        }
      }
      const previousUpdatedAt = job.updatedAt;
      const event: JobEvent = {
        sequence: job.events.length + 1,
        jobId: job.id,
        at,
        type: appendedType,
        ...(appendedData === undefined ? {} : { data: limitEventData(appendedData) }),
      };
      appended = event;
      job.events.push(event);
      job.updatedAt = at;
      try {
        await this.#save(job);
      } catch (error) {
        if (job.events.at(-1) === event) job.events.pop();
        job.updatedAt = previousUpdatedAt;
        const phase: JobPersistencePhase =
          appendedType === 'job.artifact'
            ? 'artifact'
            : appendedType === 'job.succeeded' || appendedType === 'job.failed' || appendedType === 'job.cancelled'
              ? 'terminal'
              : 'event';
        throw new JobPersistenceError(phase, appendedType, error);
      }
    });
    this.#recordMutations.set(job.id, current);
    try {
      await current;
    } finally {
      if (this.#recordMutations.get(job.id) === current) this.#recordMutations.delete(job.id);
    }
    return appended;
  }

  async #deliverCallback(job: JobRecord): Promise<void> {
    if (!job.request.callbackUrl) return;
    const body = JSON.stringify(job);
    const bodyBytes = utf8Bytes(body);
    if (bodyBytes > MAX_CALLBACK_BODY_BYTES) {
      job.callback = {
        delivered: false,
        error: `Callback payload is ${bodyBytes} bytes; maximum is ${MAX_CALLBACK_BODY_BYTES} bytes`,
      };
      job.updatedAt = this.#now().toISOString();
      await this.#save(job);
      return;
    }
    try {
      const response = await this.#fetch(job.request.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      job.callback = { delivered: response.ok, status: response.status };
    } catch (error) {
      job.callback = { delivered: false, error: limitErrorDetails(error).message };
    }
    job.updatedAt = this.#now().toISOString();
    await this.#save(job);
  }
}

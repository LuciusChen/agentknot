import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentKnotConfig } from './config.js';
import { resolveRoute } from './config.js';
import { isExecutorProcessAlive } from './execution.js';
import {
  capturedChangedFilesSummary,
  workerReportedSummary,
} from './completion-summary.js';
import { assertJsonMetadata } from './metadata.js';
import {
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
  JobStore,
  RouteDiagnostic,
  StartJobResult,
  WorkerAdapter,
  WorkerEventSink,
} from './types.js';

export type JobEventListener = (event: JobEvent, job: JobRecord) => Promise<void> | void;

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
}

function errorDetails(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
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
  if (request.callbackUrl !== undefined) {
    const callback = new URL(request.callbackUrl);
    if (callback.protocol !== 'http:' && callback.protocol !== 'https:') {
      throw new Error('callbackUrl must use http or https');
    }
  }
  if (request.metadata !== undefined) assertJsonMetadata(request.metadata);
  return {
    prompt: request.prompt,
    workspace: path.resolve(request.workspace),
    ...(request.route === undefined ? {} : { route: request.route }),
    ...(request.source === undefined ? {} : { source: request.source }),
    ...(request.callbackUrl === undefined ? {} : { callbackUrl: request.callbackUrl }),
    ...(request.metadata === undefined ? {} : { metadata: structuredClone(request.metadata) }),
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
          message: `Live inference probe failed: ${errorDetails(outcome.error).message}`,
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

  async reconcileInterruptedJobs(): Promise<JobRecord[]> {
    const reconciled: JobRecord[] = [];
    for (const job of await this.#store.list()) {
      if (job.status !== 'queued' && job.status !== 'running') continue;
      if (isExecutorProcessAlive(job.execution)) continue;

      const previousStatus = job.status;
      const message =
        'A new AgentKnot runtime found this job without a terminal state; the previous execution cannot be resumed';
      const completedAt = this.#now().toISOString();
      job.status = 'failed';
      job.completedAt = completedAt;
      job.error = {
        name: 'ExecutionInterruptedError',
        message,
        attempt: job.attempt,
        retryable: false,
      };
      delete job.result;
      delete job.callback;
      job.completionSummary = this.#completionSummary(job, 'failed', false, undefined);
      await this.#appendEvent(
        job,
        'job.failed',
        {
          name: 'ExecutionInterruptedError',
          message,
          attempt: job.attempt,
          reason: 'runtime_restart',
          previousStatus,
        },
        completedAt
      );
      reconciled.push(structuredClone(job));
    }
    return reconciled;
  }

  async run(request: JobRequest): Promise<JobRecord> {
    const started = await this.start(request);
    return started.completion;
  }

  async start(request: JobRequest): Promise<StartJobResult> {
    const normalized = normalizeRequest(request);
    const workspace = await stat(normalized.workspace).catch(() => undefined);
    if (!workspace?.isDirectory()) throw new Error(`Workspace is not a directory: ${normalized.workspace}`);
    const inspection =
      this.#workspaceIsolation.mode === 'git-worktree'
        ? await this.#workspaceIsolation.inspect(normalized.workspace)
        : undefined;

    const route = resolveRoute(this.#config, normalized.route);
    const adapter = this.#adapters.get(route.worker);
    if (!adapter) throw new Error(`No adapter registered for worker "${route.worker}"`);

    const now = this.#now().toISOString();
    const job: JobRecord = {
      id: `job_${randomUUID()}`,
      schemaVersion: 1,
      status: 'queued',
      request: normalized,
      route,
      createdAt: now,
      updatedAt: now,
      attempt: 0,
      events: [],
      execution: structuredClone(this.#execution),
    };
    const controller = new AbortController();
    await this.#store.create(job);
    await this.#emit(job, 'job.queued', { source: normalized.source ?? 'unknown' });

    const execution = this.#execute(job, adapter, controller.signal, inspection).catch(
      async (error: unknown) => {
        if (job.status !== 'failed' && job.status !== 'cancelled') {
          const details = errorDetails(error);
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
    const completion = execution.then(async () => {
      await this.#deliverCallback(job);
      return structuredClone(job);
    });

    return {
      job: structuredClone(job),
      completion,
      cancel: () => controller.abort(new Error('Job cancelled by controller')),
    };
  }

  async #execute(
    job: JobRecord,
    adapter: WorkerAdapter,
    jobSignal: AbortSignal,
    inspection?: WorkspaceInspection
  ): Promise<void> {
    job.status = 'running';
    job.startedAt = this.#now().toISOString();
    await this.#emit(job, 'job.started', {
      route: job.route.name,
      worker: job.route.worker,
      provider: job.route.provider,
      model: job.route.model,
    });

    for (let attempt = 1; attempt <= job.route.maxAttempts; attempt += 1) {
      job.attempt = attempt;
      const attemptController = new AbortController();
      const onJobAbort = () => attemptController.abort(jobSignal.reason);
      if (jobSignal.aborted) attemptController.abort(jobSignal.reason);
      else jobSignal.addEventListener('abort', onJobAbort, { once: true });
      const timeout = setTimeout(
        () => attemptController.abort(new Error(`Worker timed out after ${job.route.timeoutMs}ms`)),
        job.route.timeoutMs
      );
      const workerEmit: WorkerEventSink = (type, data) => this.#emit(job, type, data);
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
        clearTimeout(timeout);
        jobSignal.removeEventListener('abort', onJobAbort);
        if (isolated) {
          try {
            const artifact = await this.#workspaceIsolation.capturePatch(isolated, job.id, attempt);
            job.artifacts = [...(job.artifacts ?? []), artifact];
            await this.#emit(job, 'job.artifact', { ...artifact });
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
        job.status = 'succeeded';
        job.completedAt = this.#now().toISOString();
        job.result = {
          output: result.output,
          attempt,
          worker: job.route.worker,
          provider: job.route.provider,
          model: job.route.model,
          ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
        };
        delete job.error;
        job.completionSummary = this.#completionSummary(job, 'succeeded', true, result.completionReport);
        await this.#emit(job, 'job.succeeded', { attempt });
        return;
      }

      const details = errorDetails(failure ?? new Error('Worker returned no result'));
      const retryable = !jobSignal.aborted && attempt < job.route.maxAttempts;
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
      await this.#emit(job, 'job.retrying', { ...details, attempt, nextAttempt: attempt + 1 });
    }
  }

  async #emit(job: JobRecord, type: JobEventType, data?: Record<string, unknown>): Promise<void> {
    const event = await this.#appendEvent(job, type, data);
    if (!this.#onEvent) return;
    try {
      await this.#onEvent(structuredClone(event), structuredClone(job));
    } catch (error) {
      await this.#appendEvent(job, 'job.observer.failed', {
        observedEventSequence: event.sequence,
        observedEventType: event.type,
        ...errorDetails(error),
      });
    }
  }

  async #appendEvent(
    job: JobRecord,
    type: JobEventType,
    data?: Record<string, unknown>,
    at = this.#now().toISOString()
  ): Promise<JobEvent> {
    let appended: JobEvent | undefined;
    const previous = this.#recordMutations.get(job.id) ?? Promise.resolve();
    const current = previous.then(async () => {
      appended = {
        sequence: job.events.length + 1,
        jobId: job.id,
        at,
        type,
        ...(data === undefined ? {} : { data }),
      };
      job.events.push(appended);
      job.updatedAt = at;
      await this.#store.save(job);
    });
    this.#recordMutations.set(job.id, current);
    try {
      await current;
    } finally {
      if (this.#recordMutations.get(job.id) === current) this.#recordMutations.delete(job.id);
    }
    return appended as JobEvent;
  }

  async #deliverCallback(job: JobRecord): Promise<void> {
    if (!job.request.callbackUrl) return;
    try {
      const response = await this.#fetch(job.request.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(10_000),
      });
      job.callback = { delivered: response.ok, status: response.status };
    } catch (error) {
      job.callback = { delivered: false, error: errorDetails(error).message };
    }
    job.updatedAt = this.#now().toISOString();
    await this.#store.save(job);
  }
}

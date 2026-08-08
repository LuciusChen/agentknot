import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentKnotConfig } from './config.js';
import { resolveRoute } from './config.js';
import { WorkspaceIsolationManager, type IsolatedWorkspace, type WorkspaceInspection } from './workspace-isolation.js';
import type {
  JobEvent,
  JobEventType,
  JobExecution,
  JobRecord,
  JobRequest,
  JobStore,
  StartJobResult,
  WorkerAdapter,
  WorkerEventSink,
  WorkerHealth,
} from './types.js';

export type JobEventListener = (event: JobEvent, job: JobRecord) => Promise<void> | void;

export interface OrchestratorOptions {
  config: AgentKnotConfig;
  /** Base for relative config paths when constructed by the runtime. */
  baseDirectory?: string;
  store: JobStore;
  adapters: Map<string, WorkerAdapter>;
  onEvent?: JobEventListener;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
}

function errorDetails(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
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
  return {
    prompt: request.prompt,
    workspace: path.resolve(request.workspace),
    ...(request.route === undefined ? {} : { route: request.route }),
    ...(request.source === undefined ? {} : { source: request.source }),
    ...(request.callbackUrl === undefined ? {} : { callbackUrl: request.callbackUrl }),
    ...(request.metadata === undefined ? {} : { metadata: structuredClone(request.metadata) }),
  };
}

function isExecutorProcessAlive(execution: JobExecution | undefined): boolean {
  if (!execution || !Number.isSafeInteger(execution.pid) || execution.pid <= 0) return false;
  try {
    process.kill(execution.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
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

  constructor(options: OrchestratorOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#adapters = options.adapters;
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? (() => new Date());
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#workspaceIsolation = new WorkspaceIsolationManager(options.config, options.baseDirectory);
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

  async doctor(routeName?: string): Promise<WorkerHealth & { route: string }> {
    const route = resolveRoute(this.#config, routeName);
    const adapter = this.#adapters.get(route.worker);
    if (!adapter) return { ok: false, message: `No adapter for worker "${route.worker}"`, route: route.name };
    return { ...(await adapter.doctor(route)), route: route.name };
  }

  async get(id: string): Promise<JobRecord | undefined> {
    return this.#store.get(id);
  }

  async list(): Promise<JobRecord[]> {
    return this.#store.list();
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

    const completion = this.#execute(job, adapter, controller.signal, inspection)
      .then(async () => {
        await this.#deliverCallback(job);
        return structuredClone(job);
      })
      .catch(async (error: unknown) => {
        if (job.status !== 'failed' && job.status !== 'cancelled') {
          const details = errorDetails(error);
          job.status = controller.signal.aborted ? 'cancelled' : 'failed';
          job.completedAt = this.#now().toISOString();
          job.error = {
            ...details,
            attempt: job.attempt,
            retryable: false,
          };
          await this.#emit(job, controller.signal.aborted ? 'job.cancelled' : 'job.failed', details);
        }
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
        await this.#emit(job, 'job.succeeded', { attempt });
        return;
      }

      const details = errorDetails(failure ?? new Error('Worker returned no result'));
      const retryable = !jobSignal.aborted && attempt < job.route.maxAttempts;
      job.error = { ...details, attempt, retryable };
      if (!retryable) {
        job.status = jobSignal.aborted ? 'cancelled' : 'failed';
        job.completedAt = this.#now().toISOString();
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
    const event: JobEvent = {
      sequence: job.events.length + 1,
      jobId: job.id,
      at,
      type,
      ...(data === undefined ? {} : { data }),
    };
    job.events.push(event);
    job.updatedAt = at;
    await this.#store.save(job);
    return event;
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

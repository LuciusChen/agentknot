import path from 'node:path';
import { access } from 'node:fs/promises';

import { createAdapters } from './adapters/index.js';
import { loadConfig, resolveDelegationConfig, type DelegationConfig } from './config.js';
import { OrchestrationService } from './orchestration.js';
import {
  FileOrchestrationStore,
  SqliteOrchestrationStore,
} from './orchestration-store.js';
import { durableStorePath } from './durable-record-store.js';
import type {
  OrchestrationRecord,
  OrchestrationRequest,
  StartOrchestrationResult,
} from './orchestration-types.js';
import {
  Orchestrator,
  type JobEventListener,
  type RouteDiagnosticOptions,
} from './orchestrator.js';
import { FileJobStore, SqliteJobStore } from './store.js';
import {
  acquireRuntimeOwnership,
  RuntimeOwnershipError,
  type RuntimeOwnership,
} from './runtime-ownership.js';
import type {
  JobArtifactList,
  JobArtifactPreview,
  JobArtifactVerificationReport,
  JobRecord,
  JobEvent,
  JobRequest,
  RouteDiagnostic,
  StartJobResult,
  WorkerControlCapabilities,
  WorkerControlReceipt,
  WorkerControlRequest,
} from './types.js';
import { buildUsageReport, type UsageReport } from './usage-report.js';

export interface CreateRuntimeOptions {
  configPath?: string;
  onEvent?: JobEventListener;
  /** Defaults to true. Read-only callers must disable startup reconciliation explicitly. */
  reconcileOnStartup?: boolean;
}

export class AgentKnotRuntime {
  readonly #ownership: RuntimeOwnership | undefined;
  readonly #executionEnabled: boolean;
  readonly #active = new Set<Promise<unknown>>();
  readonly #recoveries = new Set<Promise<unknown>>();
  readonly #recoveryControllers = new Set<AbortController>();
  readonly #resources: Array<{ close(): Promise<void> }>;

  constructor(
    readonly jobs: Orchestrator,
    readonly orchestrations: OrchestrationService,
    options: {
      ownership?: RuntimeOwnership;
      executionEnabled?: boolean;
      resources?: Array<{ close(): Promise<void> }>;
    } = {}
  ) {
    this.#ownership = options.ownership;
    this.#executionEnabled = options.executionEnabled ?? true;
    this.#resources = options.resources ?? [];
  }

  #assertExecutionOwner(): void {
    if (!this.#executionEnabled) {
      throw new Error('This runtime was created for read-only access and cannot execute or reconcile work');
    }
    this.#ownership?.assertHeld();
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.#active.delete(tracked));
    this.#active.add(tracked);
    return tracked;
  }

  routes(): ReturnType<Orchestrator['routes']> {
    return this.jobs.routes();
  }

  doctor(routeName?: string, options?: RouteDiagnosticOptions): Promise<RouteDiagnostic> {
    return this.jobs.doctor(routeName, options);
  }

  get(id: string): Promise<JobRecord | undefined> {
    return this.jobs.get(id);
  }

  waitForJob(id: string, timeoutMs?: number, signal?: AbortSignal): Promise<JobRecord | undefined> {
    return this.jobs.wait(id, timeoutMs, signal);
  }

  jobEventsAfter(id: string, sequence: number): Promise<JobEvent[]> {
    return this.jobs.eventsAfter(id, sequence);
  }

  subscribeToJob(id: string, afterSequence = 0, signal?: AbortSignal): AsyncIterable<JobEvent> {
    return this.jobs.subscribe(id, afterSequence, signal);
  }

  cancelJob(id: string, source?: string): Promise<boolean> {
    this.#assertExecutionOwner();
    return this.jobs.cancel(id, source);
  }

  workerControlCapabilities(id: string): Promise<WorkerControlCapabilities | undefined> {
    return this.jobs.controlCapabilities(id);
  }

  controlJob(
    id: string,
    request: WorkerControlRequest
  ): Promise<WorkerControlReceipt | undefined> {
    this.#assertExecutionOwner();
    return this.#track(this.jobs.control(id, request));
  }

  list(): Promise<JobRecord[]> {
    return this.jobs.list();
  }

  listArtifacts(id: string): Promise<JobArtifactList | undefined> {
    return this.jobs.listArtifacts(id);
  }

  verifyArtifacts(id: string): Promise<JobArtifactVerificationReport | undefined> {
    return this.jobs.verifyArtifacts(id);
  }

  previewArtifact(id: string, attempt: number): Promise<JobArtifactPreview | undefined> {
    return this.jobs.previewArtifact(id, attempt);
  }

  run(request: JobRequest): Promise<JobRecord> {
    this.#assertExecutionOwner();
    return this.#track(this.jobs.run(request));
  }

  start(request: JobRequest): Promise<StartJobResult> {
    this.#assertExecutionOwner();
    return this.#track(
      this.jobs.start(request).then((started) => ({
        ...started,
        completion: this.#track(started.completion),
      }))
    );
  }

  recoverInterruptedJobs(): ReturnType<Orchestrator['recoverInterruptedJobs']> {
    this.#assertExecutionOwner();
    const controller = new AbortController();
    this.#recoveryControllers.add(controller);
    const recovery = this.jobs
      .recoverInterruptedJobs({ signal: controller.signal })
      .finally(() => {
        this.#recoveryControllers.delete(controller);
        this.#recoveries.delete(recovery);
      });
    this.#recoveries.add(recovery);
    return recovery;
  }

  recoverInterruptedOrchestrations(): Promise<OrchestrationRecord[]> {
    this.#assertExecutionOwner();
    return this.#track(this.orchestrations.recoverInterruptedOrchestrations());
  }

  delegationPolicy(): DelegationConfig {
    return this.orchestrations.policy();
  }

  getOrchestration(id: string): Promise<OrchestrationRecord | undefined> {
    return this.orchestrations.get(id);
  }

  waitForOrchestration(
    id: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<OrchestrationRecord | undefined> {
    return this.orchestrations.wait(id, timeoutMs, signal);
  }

  orchestrationEventsAfter(
    id: string,
    sequence: number
  ): ReturnType<OrchestrationService['eventsAfter']> {
    return this.orchestrations.eventsAfter(id, sequence);
  }

  subscribeToOrchestration(
    id: string,
    afterSequence = 0,
    signal?: AbortSignal
  ): ReturnType<OrchestrationService['subscribe']> {
    return this.orchestrations.subscribe(id, afterSequence, signal);
  }

  cancelOrchestration(id: string, source?: string): Promise<boolean> {
    this.#assertExecutionOwner();
    return this.orchestrations.cancel(id, source);
  }

  listOrchestrations(): Promise<OrchestrationRecord[]> {
    return this.orchestrations.list();
  }

  async usage(): Promise<UsageReport> {
    const [jobs, orchestrations] = await Promise.all([this.list(), this.listOrchestrations()]);
    return buildUsageReport(jobs, orchestrations);
  }

  orchestrate(request: OrchestrationRequest): Promise<OrchestrationRecord> {
    this.#assertExecutionOwner();
    return this.#track(this.orchestrations.run(request));
  }

  startOrchestration(request: OrchestrationRequest): Promise<StartOrchestrationResult> {
    this.#assertExecutionOwner();
    return this.#track(
      this.orchestrations.start(request).then((started) => ({
        ...started,
        completion: this.#track(started.completion),
      }))
    );
  }

  async shutdown(): Promise<void> {
    this.#assertExecutionOwner();
    for (const controller of this.#recoveryControllers) {
      controller.abort(new Error('Runtime shutdown interrupted Job recovery'));
    }
    await Promise.allSettled([...this.#recoveries]);
    await this.orchestrations.shutdown();
    await this.jobs.shutdown();
  }

  async close(): Promise<void> {
    if (
      this.#ownership !== undefined &&
      (this.#active.size > 0 || this.#recoveries.size > 0 || this.jobs.hasActiveJobs())
    ) {
      throw new RuntimeOwnershipError('Cannot release runtime storage ownership while work is active');
    }
    const failures: unknown[] = [];
    for (const resource of this.#resources) {
      try {
        await resource.close();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.#ownership?.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Failed to close AgentKnot runtime');
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function createRuntime(options: CreateRuntimeOptions = {}): Promise<AgentKnotRuntime> {
  const loaded = await loadConfig(options.configPath ?? process.env.AGENTKNOT_CONFIG ?? 'agentknot.config.json');
  if (path.resolve(loaded.storageDirectory) === path.resolve(loaded.orchestrationStorageDirectory)) {
    throw new RuntimeOwnershipError(
      `Job and orchestration storage directories must be distinct: ${loaded.storageDirectory}`
    );
  }
  const executionEnabled = options.reconcileOnStartup !== false;
  const ownership = executionEnabled
    ? await acquireRuntimeOwnership([
        loaded.storageDirectory,
        loaded.orchestrationStorageDirectory,
      ])
    : undefined;
  let jobStore: FileJobStore | SqliteJobStore | undefined;
  let orchestrationStore: FileOrchestrationStore | SqliteOrchestrationStore | undefined;
  try {
    if (executionEnabled || (await exists(durableStorePath(loaded.storageDirectory)))) {
      jobStore = await SqliteJobStore.open(loaded.storageDirectory, {
        readOnly: !executionEnabled,
        importLegacy: executionEnabled,
      });
    } else {
      jobStore = new FileJobStore(loaded.storageDirectory);
    }
    if (
      executionEnabled ||
      (await exists(durableStorePath(loaded.orchestrationStorageDirectory)))
    ) {
      orchestrationStore = await SqliteOrchestrationStore.open(
        loaded.orchestrationStorageDirectory,
        { readOnly: !executionEnabled, importLegacy: executionEnabled }
      );
    } else {
      orchestrationStore = new FileOrchestrationStore(loaded.orchestrationStorageDirectory);
    }
    const jobs = new Orchestrator({
      config: loaded.config,
      baseDirectory: loaded.baseDirectory,
      store: jobStore,
      adapters: createAdapters(loaded.config),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    if (executionEnabled) {
      await jobs.recoverInterruptedJobs({ waitForLease: true });
    }
    const orchestrations = new OrchestrationService({
      config: resolveDelegationConfig(loaded.config),
      jobs,
      store: orchestrationStore,
    });
    if (executionEnabled) {
      await orchestrations.recoverInterruptedOrchestrations({ waitForLease: true });
    }
    return new AgentKnotRuntime(jobs, orchestrations, {
      ...(ownership === undefined ? {} : { ownership }),
      executionEnabled,
      resources: [jobStore, orchestrationStore].filter(
        (store): store is SqliteJobStore | SqliteOrchestrationStore => 'close' in store
      ),
    });
  } catch (error) {
    if (jobStore && 'close' in jobStore) await jobStore.close().catch(() => undefined);
    if (orchestrationStore && 'close' in orchestrationStore) {
      await orchestrationStore.close().catch(() => undefined);
    }
    await ownership?.close();
    throw error;
  }
}

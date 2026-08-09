import path from 'node:path';

import { createAdapters } from './adapters/index.js';
import { loadConfig, resolveDelegationConfig, type DelegationConfig } from './config.js';
import { OrchestrationService } from './orchestration.js';
import { FileOrchestrationStore } from './orchestration-store.js';
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
import { FileJobStore } from './store.js';
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
  JobRequest,
  RouteDiagnostic,
  StartJobResult,
} from './types.js';

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

  constructor(
    readonly jobs: Orchestrator,
    readonly orchestrations: OrchestrationService,
    options: { ownership?: RuntimeOwnership; executionEnabled?: boolean } = {}
  ) {
    this.#ownership = options.ownership;
    this.#executionEnabled = options.executionEnabled ?? true;
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

  reconcileInterruptedJobs(): ReturnType<Orchestrator['reconcileInterruptedJobs']> {
    this.#assertExecutionOwner();
    return this.jobs.reconcileInterruptedJobs();
  }

  reconcileInterruptedOrchestrations(): Promise<OrchestrationRecord[]> {
    this.#assertExecutionOwner();
    return this.orchestrations.reconcileInterruptedOrchestrations();
  }

  delegationPolicy(): DelegationConfig {
    return this.orchestrations.policy();
  }

  getOrchestration(id: string): Promise<OrchestrationRecord | undefined> {
    return this.orchestrations.get(id);
  }

  listOrchestrations(): Promise<OrchestrationRecord[]> {
    return this.orchestrations.list();
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

  async close(): Promise<void> {
    if (this.#ownership !== undefined && this.#active.size > 0) {
      throw new RuntimeOwnershipError('Cannot release runtime storage ownership while work is active');
    }
    await this.#ownership?.close();
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
  try {
    const jobs = new Orchestrator({
      config: loaded.config,
      baseDirectory: loaded.baseDirectory,
      store: new FileJobStore(loaded.storageDirectory),
      adapters: createAdapters(loaded.config),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    if (executionEnabled) {
      await jobs.reconcileInterruptedJobs({ exclusiveOwner: true });
    }
    const orchestrations = new OrchestrationService({
      config: resolveDelegationConfig(loaded.config),
      jobs,
      store: new FileOrchestrationStore(loaded.orchestrationStorageDirectory),
    });
    if (executionEnabled) {
      await orchestrations.reconcileInterruptedOrchestrations({ exclusiveOwner: true });
    }
    return new AgentKnotRuntime(jobs, orchestrations, {
      ...(ownership === undefined ? {} : { ownership }),
      executionEnabled,
    });
  } catch (error) {
    await ownership?.close();
    throw error;
  }
}

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
  constructor(
    readonly jobs: Orchestrator,
    readonly orchestrations: OrchestrationService
  ) {}

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
    return this.jobs.run(request);
  }

  start(request: JobRequest): Promise<StartJobResult> {
    return this.jobs.start(request);
  }

  reconcileInterruptedJobs(): ReturnType<Orchestrator['reconcileInterruptedJobs']> {
    return this.jobs.reconcileInterruptedJobs();
  }

  reconcileInterruptedOrchestrations(): Promise<OrchestrationRecord[]> {
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
    return this.orchestrations.run(request);
  }

  startOrchestration(request: OrchestrationRequest): Promise<StartOrchestrationResult> {
    return this.orchestrations.start(request);
  }
}

export async function createRuntime(options: CreateRuntimeOptions = {}): Promise<AgentKnotRuntime> {
  const loaded = await loadConfig(options.configPath ?? process.env.AGENTKNOT_CONFIG ?? 'agentknot.config.json');
  const jobs = new Orchestrator({
    config: loaded.config,
    baseDirectory: loaded.baseDirectory,
    store: new FileJobStore(loaded.storageDirectory),
    adapters: createAdapters(loaded.config),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  if (options.reconcileOnStartup !== false) {
    await jobs.reconcileInterruptedJobs();
  }
  const orchestrations = new OrchestrationService({
    config: resolveDelegationConfig(loaded.config),
    jobs,
    store: new FileOrchestrationStore(loaded.orchestrationStorageDirectory),
  });
  if (options.reconcileOnStartup !== false) {
    await orchestrations.reconcileInterruptedOrchestrations();
  }
  return new AgentKnotRuntime(jobs, orchestrations);
}

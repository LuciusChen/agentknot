import { createAdapters } from './adapters/index.js';
import { loadConfig, resolveDelegationConfig, type DelegationConfig } from './config.js';
import { OrchestrationService } from './orchestration.js';
import { FileOrchestrationStore } from './orchestration-store.js';
import type {
  OrchestrationRecord,
  OrchestrationRequest,
  StartOrchestrationResult,
} from './orchestration-types.js';
import { Orchestrator, type JobEventListener } from './orchestrator.js';
import { FileJobStore } from './store.js';
import type { JobRecord, JobRequest, StartJobResult, WorkerHealth } from './types.js';

export interface CreateRuntimeOptions {
  configPath?: string;
  onEvent?: JobEventListener;
}

export class AgentKnotRuntime {
  constructor(
    readonly jobs: Orchestrator,
    readonly orchestrations: OrchestrationService
  ) {}

  routes(): ReturnType<Orchestrator['routes']> {
    return this.jobs.routes();
  }

  doctor(routeName?: string): Promise<WorkerHealth & { route: string }> {
    return this.jobs.doctor(routeName);
  }

  get(id: string): Promise<JobRecord | undefined> {
    return this.jobs.get(id);
  }

  list(): Promise<JobRecord[]> {
    return this.jobs.list();
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
  await jobs.reconcileInterruptedJobs();
  const orchestrations = new OrchestrationService({
    config: resolveDelegationConfig(loaded.config),
    jobs,
    store: new FileOrchestrationStore(loaded.orchestrationStorageDirectory),
  });
  await orchestrations.reconcileInterruptedOrchestrations();
  return new AgentKnotRuntime(jobs, orchestrations);
}

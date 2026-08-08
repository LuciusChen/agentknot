import { createAdapters } from './adapters/index.js';
import { loadConfig } from './config.js';
import { Orchestrator, type JobEventListener } from './orchestrator.js';
import { FileJobStore } from './store.js';

export interface CreateRuntimeOptions {
  configPath?: string;
  onEvent?: JobEventListener;
}

export async function createRuntime(options: CreateRuntimeOptions = {}): Promise<Orchestrator> {
  const loaded = await loadConfig(options.configPath ?? process.env.AGENTKNOT_CONFIG ?? 'agentknot.config.json');
  const orchestrator = new Orchestrator({
    config: loaded.config,
    baseDirectory: loaded.baseDirectory,
    store: new FileJobStore(loaded.storageDirectory),
    adapters: createAdapters(loaded.config),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  await orchestrator.reconcileInterruptedJobs();
  return orchestrator;
}

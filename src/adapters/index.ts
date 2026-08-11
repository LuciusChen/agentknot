import type { AgentKnotConfig } from '../config.js';
import type { WorkerAdapter } from '../types.js';
import { MockWorkerAdapter } from './mock.js';
import { PiRpcWorkerAdapter } from './pi-rpc.js';

export function createAdapters(config: AgentKnotConfig): Map<string, WorkerAdapter> {
  const adapters = new Map<string, WorkerAdapter>();
  for (const [name, worker] of Object.entries(config.workers)) {
    switch (worker.adapter) {
      case 'mock':
        adapters.set(name, new MockWorkerAdapter(name, worker));
        break;
      case 'pi-rpc':
        adapters.set(name, new PiRpcWorkerAdapter(name, worker));
        break;
    }
  }
  return adapters;
}

export { MockWorkerAdapter } from './mock.js';
export { PiRpcWorkerAdapter } from './pi-rpc.js';

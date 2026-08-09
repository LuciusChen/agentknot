import { MockWorkerAdapter } from '../src/adapters/mock.js';
import type { ResolvedRoute } from '../src/types.js';
import { registerWorkerAdapterConformanceTests } from './worker-adapter-conformance.js';

const route: ResolvedRoute = {
  name: 'mock-conformance',
  worker: 'mock',
  provider: 'mock-provider',
  model: 'mock-model',
  requiredEnv: [],
  maxAttempts: 1,
  timeoutMs: 10_000,
};

registerWorkerAdapterConformanceTests({
  name: 'MockWorkerAdapter',
  createAdapter: () =>
    new MockWorkerAdapter('mock', {
      adapter: 'mock',
      responsePrefix: 'Conformance completed',
    }),
  route,
  expectedOutput: 'Conformance completed: Conformance prompt for MockWorkerAdapter',
});

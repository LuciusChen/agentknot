import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig, resolveRoute } from '../src/config.js';

test('parseConfig keeps worker and provider as independent routing dimensions', () => {
  const config = parseConfig({
    version: 1,
    defaultRoute: 'luna',
    storage: { directory: '.agentknot/jobs' },
    workers: {
      pi: { adapter: 'pi-rpc', command: 'pi' },
    },
    routes: {
      luna: {
        worker: 'pi',
        provider: 'opencode-go',
        model: 'gpt-5.6-luna',
        thinkingLevel: 'high',
        requiredEnv: ['OPENCODE_API_KEY'],
      },
    },
  });

  assert.deepEqual(resolveRoute(config), {
    name: 'luna',
    worker: 'pi',
    provider: 'opencode-go',
    model: 'gpt-5.6-luna',
    thinkingLevel: 'high',
    requiredEnv: ['OPENCODE_API_KEY'],
    maxAttempts: 1,
    timeoutMs: 1_800_000,
  });
});

test('parseConfig rejects routes pointing to a missing worker', () => {
  assert.throws(
    () =>
      parseConfig({
        version: 1,
        defaultRoute: 'bad',
        storage: { directory: '.agentknot/jobs' },
        workers: { mock: { adapter: 'mock' } },
        routes: { bad: { worker: 'missing', provider: 'x', model: 'y' } },
      }),
    /unknown worker/
  );
});

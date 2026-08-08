import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { PiRpcWorkerAdapter } from '../src/adapters/pi-rpc.js';
import type { JobEventType, ResolvedRoute } from '../src/types.js';

const route: ResolvedRoute = {
  name: 'fake-pi',
  worker: 'pi',
  provider: 'opencode-go',
  model: 'gpt-5.6-luna',
  thinkingLevel: 'high',
  requiredEnv: [],
  maxAttempts: 1,
  timeoutMs: 10_000,
};

test('PiRpcWorkerAdapter speaks JSONL RPC and normalizes Pi events', async () => {
  const fixture = path.resolve('test/fixtures/fake-pi.mjs');
  const adapter = new PiRpcWorkerAdapter('pi', {
    adapter: 'pi-rpc',
    command: process.execPath,
    commandArgs: [fixture],
    noSession: true,
  });
  const controller = new AbortController();
  const events: JobEventType[] = [];

  const result = await adapter.run(
    {
      jobId: 'job_test',
      prompt: 'do work',
      workspace: process.cwd(),
      route,
      attempt: 1,
      signal: controller.signal,
    },
    (type) => {
      events.push(type);
    }
  );

  assert.equal(result.output, 'fake result');
  assert.ok(events.includes('worker.started'));
  assert.ok(events.includes('worker.tool.started'));
  assert.ok(events.includes('worker.tool.completed'));
  assert.equal(events.filter((event) => event === 'worker.text.delta').length, 2);
});

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdapters } from '../src/adapters/index.js';
import type { AgentKnotConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryJobStore } from '../src/store.js';

const config: AgentKnotConfig = {
  version: 1,
  defaultRoute: 'mock',
  storage: { directory: '.agentknot/jobs' },
  workers: { mock: { adapter: 'mock', responsePrefix: 'done' } },
  routes: {
    mock: { worker: 'mock', provider: 'mock-provider', model: 'mock-model', maxAttempts: 1 },
  },
};

test('Orchestrator persists a complete evented job without knowing the controller vendor', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-orchestrator-'));
  const store = new MemoryJobStore();
  const orchestrator = new Orchestrator({ config, store, adapters: createAdapters(config) });

  const job = await orchestrator.run({
    prompt: 'implement the feature',
    workspace,
    source: 'claude',
  });

  assert.equal(job.status, 'succeeded');
  assert.equal(job.request.source, 'claude');
  assert.equal(job.result?.output, 'done: implement the feature');
  assert.deepEqual(
    job.events.map((event) => event.type),
    ['job.queued', 'job.started', 'worker.started', 'worker.text.delta', 'job.succeeded']
  );
  assert.deepEqual(
    job.events.map((event) => event.sequence),
    [1, 2, 3, 4, 5]
  );
  assert.equal((await store.get(job.id))?.status, 'succeeded');
});

test('Orchestrator sends the terminal job to an optional callback', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-callback-'));
  const requests: Array<{ url: string; body: string }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), body: String(init?.body) });
    return new Response(null, { status: 204 });
  };
  const orchestrator = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: createAdapters(config),
    fetch: fakeFetch,
  });

  const job = await orchestrator.run({
    prompt: 'callback test',
    workspace,
    source: 'codex',
    callbackUrl: 'https://controller.invalid/jobs',
  });

  assert.equal(job.callback?.delivered, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://controller.invalid/jobs');
  assert.equal(JSON.parse(requests[0]?.body ?? '{}').status, 'succeeded');
});

test('Orchestrator records observer failures without retrying or failing worker execution', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-observer-'));
  const store = new MemoryJobStore();
  const observed: string[] = [];
  const orchestrator = new Orchestrator({
    config,
    store,
    adapters: createAdapters(config),
    onEvent: (event) => {
      observed.push(event.type);
      if (event.type === 'worker.started') throw new Error('observer unavailable');
    },
  });

  const job = await orchestrator.run({
    prompt: 'observer isolation test',
    workspace,
    source: 'codex',
  });

  assert.equal(job.status, 'succeeded');
  assert.equal(job.attempt, 1);
  assert.equal(job.result?.output, 'done: observer isolation test');
  assert.deepEqual(observed, [
    'job.queued',
    'job.started',
    'worker.started',
    'worker.text.delta',
    'job.succeeded',
  ]);
  assert.deepEqual(
    job.events.map((event) => event.type),
    [
      'job.queued',
      'job.started',
      'worker.started',
      'job.observer.failed',
      'worker.text.delta',
      'job.succeeded',
    ]
  );
  assert.deepEqual(
    job.events.map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6]
  );
  assert.deepEqual(job.events[3]?.data, {
    observedEventSequence: 3,
    observedEventType: 'worker.started',
    name: 'Error',
    message: 'observer unavailable',
  });
  assert.deepEqual((await store.get(job.id))?.events, job.events);
});

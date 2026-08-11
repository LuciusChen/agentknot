import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdapters } from '../src/adapters/index.js';
import type { AgentKnotConfig } from '../src/config.js';
import { JobPersistenceError, Orchestrator } from '../src/orchestrator.js';
import { FileJobStore, MemoryJobStore, SqliteJobStore } from '../src/store.js';
import type { JobStore, WorkerAdapter, WorkerEventSink } from '../src/types.js';

const config: AgentKnotConfig = {
  version: 1,
  defaultRoute: 'mock',
  storage: { directory: '.agentknot/jobs' },
  workers: { mock: { adapter: 'mock', responsePrefix: 'done' } },
  routes: {
    mock: { worker: 'mock', provider: 'mock-provider', model: 'mock-model', maxAttempts: 1 },
  },
};

function failEventSave(delegate: MemoryJobStore, type: string): JobStore {
  let failed = false;
  return {
    create: (job) => delegate.create(job),
    save: async (job) => {
      if (job.events.at(-1)?.type === type && !failed) {
        failed = true;
        throw new Error(`${type} persistence unavailable`);
      }
      await delegate.save(job);
    },
    get: (id) => delegate.get(id),
    list: () => delegate.list(),
  };
}

function assertPersistenceError(
  error: unknown,
  phase: JobPersistenceError['phase'],
  eventType?: JobPersistenceError['eventType']
): boolean {
  assert.ok(error instanceof JobPersistenceError);
  assert.equal(error.phase, phase);
  assert.equal(error.eventType, eventType);
  return true;
}

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

test('Job admission atomically creates the queued event or starts no worker', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-admission-failure-'));
  let runs = 0;
  let admitted: Parameters<JobStore['create']>[0] | undefined;
  const adapter: WorkerAdapter = {
    name: 'mock',
    async doctor() {
      return { ok: true, message: 'ready' };
    },
    async run() {
      runs += 1;
      return { output: 'unexpected' };
    },
  };
  const store: JobStore = {
    async create(job) {
      admitted = structuredClone(job);
      throw new Error('admission persistence unavailable');
    },
    async save() {
      throw new Error('unexpected save');
    },
    async get() {
      return undefined;
    },
    async list() {
      return [];
    },
  };
  const orchestrator = new Orchestrator({
    config,
    store,
    adapters: new Map([['mock', adapter]]),
  });

  await assert.rejects(
    orchestrator.run({ prompt: 'admission failure', workspace }),
    (error) => assertPersistenceError(error, 'admission')
  );
  assert.equal(runs, 0);
  assert.equal(admitted?.status, 'queued');
  assert.deepEqual(admitted?.events.map((event) => event.type), ['job.queued']);
  assert.equal(admitted?.events[0]?.jobId, admitted?.id);
});

test('event persistence failure is not retried or rewritten as worker failure', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-event-store-failure-'));
  const delegate = new MemoryJobStore();
  let runs = 0;
  let callbacks = 0;
  const adapter: WorkerAdapter = {
    name: 'mock',
    async doctor() {
      return { ok: true, message: 'ready' };
    },
    async run(_input, emit) {
      runs += 1;
      await emit('worker.started');
      return { output: 'unexpected' };
    },
  };
  const retryConfig = structuredClone(config);
  retryConfig.routes.mock!.maxAttempts = 2;
  const orchestrator = new Orchestrator({
    config: retryConfig,
    store: failEventSave(delegate, 'worker.started'),
    adapters: new Map([['mock', adapter]]),
    fetch: async () => {
      callbacks += 1;
      return new Response(null, { status: 204 });
    },
  });
  const started = await orchestrator.start({
    prompt: 'event failure',
    workspace,
    callbackUrl: 'https://controller.invalid/jobs',
  });

  await assert.rejects(started.completion, (error) =>
    assertPersistenceError(error, 'event', 'worker.started')
  );
  const persisted = await delegate.get(started.job.id);
  assert.equal(runs, 1);
  assert.equal(callbacks, 0);
  assert.equal(persisted?.status, 'running');
  assert.deepEqual(persisted?.events.map((event) => event.type), ['job.queued', 'job.started']);
});

test('terminal persistence failure preserves the last good running snapshot', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-terminal-store-failure-'));
  const delegate = new MemoryJobStore();
  let runs = 0;
  const adapter: WorkerAdapter = {
    name: 'mock',
    async doctor() {
      return { ok: true, message: 'ready' };
    },
    async run() {
      runs += 1;
      return { output: 'worker succeeded' };
    },
  };
  const orchestrator = new Orchestrator({
    config,
    store: failEventSave(delegate, 'job.succeeded'),
    adapters: new Map([['mock', adapter]]),
  });
  const started = await orchestrator.start({ prompt: 'terminal failure', workspace });

  await assert.rejects(started.completion, (error) =>
    assertPersistenceError(error, 'terminal', 'job.succeeded')
  );
  const persisted = await delegate.get(started.job.id);
  assert.equal(runs, 1);
  assert.equal(persisted?.status, 'running');
  assert.equal(persisted?.result, undefined);
  assert.deepEqual(persisted?.events.map((event) => event.type), ['job.queued', 'job.started']);
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

test('callback bookkeeping persistence failure does not rewrite or redeliver a successful job', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-callback-store-failure-'));
  const delegate = new MemoryJobStore();
  let failedCallbackSave = false;
  const store: JobStore = {
    create: (job) => delegate.create(job),
    save: async (job) => {
      if (job.callback !== undefined && !failedCallbackSave) {
        failedCallbackSave = true;
        throw new Error('callback bookkeeping persistence unavailable');
      }
      await delegate.save(job);
    },
    get: (id) => delegate.get(id),
    list: () => delegate.list(),
  };
  const requests: Array<{ url: string; body: string }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), body: String(init?.body) });
    return new Response(null, { status: 204 });
  };
  const orchestrator = new Orchestrator({
    config,
    store,
    adapters: createAdapters(config),
    fetch: fakeFetch,
  });

  await assert.rejects(
    orchestrator.run({
      prompt: 'callback persistence test',
      workspace,
      source: 'codex',
      callbackUrl: 'https://controller.invalid/jobs',
    }),
    /callback bookkeeping persistence unavailable/
  );

  const [persisted] = await delegate.list();
  assert.equal(failedCallbackSave, true);
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0]?.body ?? '{}').status, 'succeeded');
  assert.equal(persisted?.status, 'succeeded');
  assert.equal(persisted?.callback, undefined);
  assert.equal(persisted?.events.at(-1)?.type, 'job.succeeded');
  assert.equal(
    persisted?.events.filter((event) => event.type === 'worker.started').length,
    1
  );
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

test('Orchestrator serializes concurrent worker events in the file store', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-concurrent-events-workspace-'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-concurrent-events-store-'));
  const adapter: WorkerAdapter = {
    name: 'mock',
    async doctor() {
      return { ok: true, message: 'burst adapter ready' };
    },
    async run(_input, emit) {
      await Promise.all(
        Array.from({ length: 100 }, (_, index) => emit('worker.raw', { index }))
      );
      return { output: 'burst complete' };
    },
  };
  const store = new FileJobStore(directory);
  const orchestrator = new Orchestrator({
    config,
    store,
    adapters: new Map([['mock', adapter]]),
  });

  const job = await orchestrator.run({ prompt: 'emit concurrently', workspace });
  const persisted = await store.get(job.id);

  assert.equal(job.status, 'succeeded');
  assert.equal(job.events.filter((event) => event.type === 'worker.raw').length, 100);
  assert.deepEqual(
    job.events.map((event) => event.sequence),
    Array.from({ length: job.events.length }, (_, index) => index + 1)
  );
  assert.deepEqual(persisted, job);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('worker event sinks stop accepting events after their attempt settles', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-stale-event-sink-'));
  const store = new MemoryJobStore();
  const emits: WorkerEventSink[] = [];
  const adapter: WorkerAdapter = {
    name: 'mock',
    async doctor() {
      return { ok: true, message: 'stale-event adapter ready' };
    },
    async run(input, emit) {
      emits.push(emit);
      if (input.attempt === 1) throw new Error('retry once');
      await emits[0]?.('worker.raw', { source: 'stale-attempt' });
      await emit('worker.raw', { source: 'active-attempt' });
      return { output: 'completed on attempt two' };
    },
  };
  const retryConfig = structuredClone(config);
  retryConfig.routes.mock!.maxAttempts = 2;
  const orchestrator = new Orchestrator({
    config: retryConfig,
    store,
    adapters: new Map([['mock', adapter]]),
  });

  const job = await orchestrator.run({ prompt: 'contain stale events', workspace });
  const terminalEvents = structuredClone(job.events);
  await Promise.all(emits.map((emit) => emit('worker.raw', { source: 'post-terminal' })));

  assert.equal(job.status, 'succeeded');
  assert.equal(job.attempt, 2);
  assert.deepEqual(
    job.events.filter((event) => event.type === 'worker.raw').map((event) => event.data?.source),
    ['active-attempt']
  );
  assert.deepEqual((await store.get(job.id))?.events, terminalEvents);
  assert.equal(job.events.at(-1)?.type, 'job.succeeded');
});

test('independent durable runtime observes cancellation and terminal state by Job identity', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-cancel-workspace-'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-cancel-store-'));
  const firstStore = await SqliteJobStore.open(directory);
  const secondStore = await SqliteJobStore.open(directory, { importLegacy: false });
  let runs = 0;
  const adapter: WorkerAdapter = {
    name: 'mock',
    async doctor() {
      return { ok: true, message: 'waiting adapter ready' };
    },
    async run(input) {
      runs += 1;
      await new Promise<void>((_resolve, reject) => {
        const rejectAbort = () =>
          reject(input.signal.reason instanceof Error ? input.signal.reason : new Error('aborted'));
        if (input.signal.aborted) rejectAbort();
        else input.signal.addEventListener('abort', rejectAbort, { once: true });
      });
      return { output: 'unreachable' };
    },
  };
  const first = new Orchestrator({
    config,
    store: firstStore,
    adapters: new Map([['mock', adapter]]),
    leaseTtlMs: 200,
    leaseHeartbeatMs: 25,
  });
  const second = new Orchestrator({
    config,
    store: secondStore,
    adapters: new Map([['mock', adapter]]),
    leaseTtlMs: 200,
    leaseHeartbeatMs: 25,
  });

  try {
    const request = {
      prompt: 'wait for durable cancellation',
      workspace,
      idempotencyKey: 'controller-session:turn-1',
    };
    const started = await first.start(request);
    const duplicate = await second.start(request);
    assert.equal(duplicate.job.id, started.job.id);
    await assert.rejects(
      second.start({ ...request, prompt: 'different request' }),
      (error: unknown) => assertPersistenceError(error, 'admission')
    );
    await started.cancel();
    const [terminal, duplicateTerminal] = await Promise.all([
      started.completion,
      duplicate.completion,
    ]);
    assert.equal(terminal.status, 'cancelled');
    assert.equal(duplicateTerminal.id, terminal.id);
    assert.equal(duplicateTerminal.status, 'cancelled');
    assert.equal(runs, 1);
    assert.equal(terminal.events.at(-1)?.type, 'job.cancelled');
    assert.equal((await second.wait(started.job.id, 500))?.status, 'cancelled');
    assert.equal((await secondStore.getCancellation(started.job.id))?.source, 'start-handle');
    assert.equal(await secondStore.getLease(started.job.id), undefined);
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(directory, { recursive: true, force: true }),
    ]);
  }
});

test('durable cancellation accepted while a worker settles wins the terminal success race', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-cancel-race-workspace-'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-cancel-race-store-'));
  const firstStore = await SqliteJobStore.open(directory);
  const secondStore = await SqliteJobStore.open(directory, { importLegacy: false });
  let workerStarted!: () => void;
  let settleWorker!: () => void;
  const startedWorker = new Promise<void>((resolve) => {
    workerStarted = resolve;
  });
  const workerMaySettle = new Promise<void>((resolve) => {
    settleWorker = resolve;
  });
  const adapter: WorkerAdapter = {
    name: 'mock',
    async doctor() {
      return { ok: true, message: 'race adapter ready' };
    },
    async run() {
      workerStarted();
      await workerMaySettle;
      return { output: 'late success' };
    },
  };
  const first = new Orchestrator({
    config,
    store: firstStore,
    adapters: new Map([['mock', adapter]]),
    leaseTtlMs: 3_000,
    leaseHeartbeatMs: 1_000,
  });
  const second = new Orchestrator({
    config,
    store: secondStore,
    adapters: new Map([['mock', adapter]]),
    leaseTtlMs: 3_000,
    leaseHeartbeatMs: 1_000,
  });

  try {
    const started = await first.start({ prompt: 'settle during cancellation', workspace });
    await startedWorker;
    assert.equal(await second.cancel(started.job.id, 'racing-controller'), true);
    settleWorker();
    const terminal = await started.completion;

    assert.equal(terminal.status, 'cancelled');
    assert.equal(terminal.result, undefined);
    assert.equal(terminal.error?.name, 'CancellationRequestedError');
    assert.equal(terminal.events.at(-1)?.type, 'job.cancelled');
    assert.equal((await secondStore.get(terminal.id))?.status, 'cancelled');
  } finally {
    settleWorker();
    await Promise.all([firstStore.close(), secondStore.close()]);
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(directory, { recursive: true, force: true }),
    ]);
  }
});

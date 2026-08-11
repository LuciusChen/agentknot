import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdapters } from '../src/adapters/index.js';
import type { AgentKnotConfig } from '../src/config.js';
import { JobPersistenceError, Orchestrator } from '../src/orchestrator.js';
import { MemoryJobStore, SqliteJobStore } from '../src/store.js';
import type {
  JobRecord,
  ResolvedRoute,
  WorkerAdapter,
  WorkerHealth,
  WorkerRunInput,
  WorkerRunResult,
} from '../src/types.js';

function poolConfig(delayMs = 40): AgentKnotConfig {
  return {
    version: 1,
    defaultRoute: 'route-a',
    storage: { directory: '.agentknot/jobs' },
    workers: {
      workerA: { adapter: 'mock', responsePrefix: 'A', delayMs },
      workerB: { adapter: 'mock', responsePrefix: 'B', delayMs },
    },
    routes: {
      'route-a': { worker: 'workerA', provider: 'provider-a', model: 'model-a' },
      'route-b': { worker: 'workerB', provider: 'provider-b', model: 'model-b' },
    },
    routePools: {
      balanced: { strategy: 'least-active', routes: ['route-a', 'route-b'] },
    },
  };
}

test('route pools include explicit member jobs in least-active admission', async () => {
  const config = poolConfig();
  const jobs = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: createAdapters(config),
  });

  const explicit = await jobs.start({ prompt: 'explicit A', workspace: process.cwd(), route: 'route-a' });
  const pooled1 = await jobs.start({ prompt: 'pooled 1', workspace: process.cwd(), route: 'balanced' });
  const pooled2 = await jobs.start({ prompt: 'pooled 2', workspace: process.cwd(), route: 'balanced' });
  const pooled3 = await jobs.start({ prompt: 'pooled 3', workspace: process.cwd(), route: 'balanced' });

  assert.equal(pooled1.job.route.name, 'route-b');
  assert.equal(pooled2.job.route.name, 'route-a');
  assert.equal(pooled3.job.route.name, 'route-b');
  assert.deepEqual(pooled1.job.routePoolSelection, {
    pool: 'balanced',
    strategy: 'least-active',
    candidates: ['route-a', 'route-b'],
    selectedRoute: 'route-b',
    activeBefore: { 'route-a': 1, 'route-b': 0 },
    cursorBefore: 0,
    selectedMemberIndex: 1,
    tieBreak: 'rotating-order',
  });
  assert.equal(explicit.job.routePoolSelection, undefined);
  await Promise.all([
    explicit.completion,
    pooled1.completion,
    pooled2.completion,
    pooled3.completion,
  ]);
});

test('route pools rotate equal-load ties and release failed admission reservations', async () => {
  class FailOnceStore extends MemoryJobStore {
    failed = false;

    override async create(job: JobRecord): Promise<void> {
      if (!this.failed) {
        this.failed = true;
        throw new Error('seeded admission failure');
      }
      await super.create(job);
    }
  }

  const config = poolConfig(0);
  const store = new FailOnceStore();
  const jobs = new Orchestrator({ config, store, adapters: createAdapters(config) });
  await assert.rejects(
    jobs.start({ prompt: 'fails admission', workspace: process.cwd(), route: 'balanced' }),
    (error: unknown) => error instanceof JobPersistenceError
  );

  const first = await jobs.start({ prompt: 'first', workspace: process.cwd(), route: 'balanced' });
  assert.equal(first.job.route.name, 'route-b');
  assert.deepEqual(first.job.routePoolSelection?.activeBefore, { 'route-a': 0, 'route-b': 0 });
  await first.completion;

  const second = await jobs.start({ prompt: 'second', workspace: process.cwd(), route: 'balanced' });
  assert.equal(second.job.route.name, 'route-a');
  assert.deepEqual(second.job.routePoolSelection?.activeBefore, { 'route-a': 0, 'route-b': 0 });
  await second.completion;
});

class CountingAdapter implements WorkerAdapter {
  calls = 0;

  constructor(
    readonly name: string,
    readonly failure?: Error
  ) {}

  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'ready' };
  }

  async run(input: WorkerRunInput): Promise<WorkerRunResult> {
    this.calls += 1;
    if (this.failure) throw this.failure;
    return { output: `${this.name}:${input.prompt}` };
  }
}

test('a pool snapshots one exact route and retries never fail over to another member', async () => {
  const config = poolConfig(0);
  config.routes['route-a']!.maxAttempts = 2;
  const failing = new CountingAdapter('workerA', new Error('selected route failed'));
  const other = new CountingAdapter('workerB');
  const jobs = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: new Map([
      ['workerA', failing],
      ['workerB', other],
    ]),
  });

  const terminal = await (await jobs.start({ prompt: 'no fallback', workspace: process.cwd(), route: 'balanced' })).completion;
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.route.name, 'route-a');
  assert.equal(terminal.routePoolSelection?.selectedRoute, 'route-a');
  assert.equal(terminal.attempt, 2);
  assert.equal(failing.calls, 2);
  assert.equal(other.calls, 0);
});

test('adapter lookup and terminal persistence failures release their exact reservations', async () => {
  class FailOnceTerminalStore extends MemoryJobStore {
    failed = false;

    override async save(job: JobRecord): Promise<void> {
      if (!this.failed && job.status === 'succeeded') {
        this.failed = true;
        throw new Error('seeded terminal save failure');
      }
      await super.save(job);
    }
  }

  const config = poolConfig(0);
  const adapterA = new CountingAdapter('workerA');
  const adapterB = new CountingAdapter('workerB');
  const adapters = new Map<string, WorkerAdapter>([['workerB', adapterB]]);
  const jobs = new Orchestrator({ config, store: new FailOnceTerminalStore(), adapters });

  await assert.rejects(
    jobs.start({ prompt: 'missing adapter', workspace: process.cwd(), route: 'balanced' }),
    /No adapter registered for worker "workerA"/
  );
  adapters.set('workerA', adapterA);

  const terminalFailure = await jobs.start({
    prompt: 'terminal persistence failure',
    workspace: process.cwd(),
    route: 'balanced',
  });
  assert.equal(terminalFailure.job.route.name, 'route-b');
  assert.deepEqual(terminalFailure.job.routePoolSelection?.activeBefore, {
    'route-a': 0,
    'route-b': 0,
  });
  await assert.rejects(terminalFailure.completion, (error: unknown) => error instanceof JobPersistenceError);

  const recovered = await jobs.start({ prompt: 'after failures', workspace: process.cwd(), route: 'balanced' });
  assert.equal(recovered.job.route.name, 'route-a');
  assert.deepEqual(recovered.job.routePoolSelection?.activeBefore, { 'route-a': 0, 'route-b': 0 });
  assert.equal((await recovered.completion).status, 'succeeded');
});

test('durable route-pool admission serializes selection with the first Job lease', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-route-pool-'));
  const firstStore = await SqliteJobStore.open(directory);
  const secondStore = await SqliteJobStore.open(directory, { importLegacy: false });
  const config = poolConfig(80);
  const first = new Orchestrator({ config, store: firstStore, adapters: createAdapters(config) });
  const second = new Orchestrator({ config, store: secondStore, adapters: createAdapters(config) });

  try {
    const [left, right] = await Promise.all([
      first.start({ prompt: 'left', workspace: process.cwd(), route: 'balanced' }),
      second.start({ prompt: 'right', workspace: process.cwd(), route: 'balanced' }),
    ]);

    assert.deepEqual(new Set([left.job.route.name, right.job.route.name]), new Set(['route-a', 'route-b']));
    const selections = [left.job.routePoolSelection!, right.job.routePoolSelection!];
    assert.equal(
      selections.filter((selection) => Object.values(selection.activeBefore).every((value) => value === 0)).length,
      1
    );
    assert.equal(
      selections.filter((selection) => Object.values(selection.activeBefore).some((value) => value === 1)).length,
      1
    );
    await Promise.all([left.completion, right.completion]);
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable route-pool activity includes an exact member admitted by another store', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-exact-route-'));
  const firstStore = await SqliteJobStore.open(directory);
  const secondStore = await SqliteJobStore.open(directory, { importLegacy: false });
  const config = poolConfig(80);
  const first = new Orchestrator({ config, store: firstStore, adapters: createAdapters(config) });
  const second = new Orchestrator({ config, store: secondStore, adapters: createAdapters(config) });

  try {
    const exact = await first.start({ prompt: 'exact', workspace: process.cwd(), route: 'route-a' });
    const pooled = await second.start({ prompt: 'pooled', workspace: process.cwd(), route: 'balanced' });
    assert.equal(pooled.job.route.name, 'route-b');
    assert.deepEqual(pooled.job.routePoolSelection?.activeBefore, { 'route-a': 1, 'route-b': 0 });
    await Promise.all([exact.completion, pooled.completion]);
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable route-pool cursor survives execution-owner replacement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-route-cursor-'));
  const config = poolConfig(0);
  let firstStore: SqliteJobStore | undefined = await SqliteJobStore.open(directory);
  try {
    const first = new Orchestrator({ config, store: firstStore, adapters: createAdapters(config) });
    const initial = await first.start({ prompt: 'initial', workspace: process.cwd(), route: 'balanced' });
    assert.equal(initial.job.route.name, 'route-a');
    await initial.completion;
    await firstStore.close();
    firstStore = undefined;

    const secondStore = await SqliteJobStore.open(directory, { importLegacy: false });
    try {
      const second = new Orchestrator({ config, store: secondStore, adapters: createAdapters(config) });
      const resumed = await second.start({ prompt: 'resumed', workspace: process.cwd(), route: 'balanced' });
      assert.equal(resumed.job.route.name, 'route-b');
      assert.deepEqual(resumed.job.routePoolSelection?.activeBefore, { 'route-a': 0, 'route-b': 0 });
      await resumed.completion;
    } finally {
      await secondStore.close();
    }
  } finally {
    await firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable idempotent pool admission reuses its exact route without advancing rotation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-route-idempotency-'));
  const firstStore = await SqliteJobStore.open(directory);
  const secondStore = await SqliteJobStore.open(directory, { importLegacy: false });
  const config = poolConfig(0);
  const first = new Orchestrator({ config, store: firstStore, adapters: createAdapters(config) });
  const second = new Orchestrator({ config, store: secondStore, adapters: createAdapters(config) });

  try {
    const request = {
      prompt: 'idempotent pool request',
      workspace: process.cwd(),
      route: 'balanced',
      idempotencyKey: 'route-pool-idempotency',
    };
    const initial = await first.start(request);
    const duplicate = await second.start(request);
    assert.equal(duplicate.job.id, initial.job.id);
    assert.equal(duplicate.job.route.name, 'route-a');
    await Promise.all([initial.completion, duplicate.completion]);

    const next = await second.start({ prompt: 'next', workspace: process.cwd(), route: 'balanced' });
    assert.equal(next.job.route.name, 'route-b');
    assert.equal(next.job.routePoolSelection?.cursorBefore, 1);
    await next.completion;
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable route selection and cursor roll back when Job admission fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-route-rollback-'));
  const store = await SqliteJobStore.open(directory);
  const config = poolConfig(0);
  const adapters = new Map<string, WorkerAdapter>([
    ['workerB', new CountingAdapter('workerB')],
  ]);
  const jobs = new Orchestrator({ config, store, adapters });

  try {
    await assert.rejects(
      jobs.start({ prompt: 'missing selected adapter', workspace: process.cwd(), route: 'balanced' }),
      (error: unknown) => error instanceof JobPersistenceError
    );
    adapters.set('workerA', new CountingAdapter('workerA'));

    const admitted = await jobs.start({ prompt: 'after rollback', workspace: process.cwd(), route: 'balanced' });
    assert.equal(admitted.job.route.name, 'route-a');
    assert.equal(admitted.job.routePoolSelection?.cursorBefore, 0);
    assert.deepEqual(admitted.job.routePoolSelection?.activeBefore, { 'route-a': 0, 'route-b': 0 });
    await admitted.completion;
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

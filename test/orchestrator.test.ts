import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createAdapters } from '../src/adapters/index.js';
import type { AgentKnotConfig } from '../src/config.js';
import { JobControlPersistenceError, JobPersistenceError, Orchestrator } from '../src/orchestrator.js';
import { FileJobStore, MemoryJobStore, SqliteJobStore } from '../src/store.js';
import { WorkspaceIsolationManager } from '../src/workspace-isolation.js';
import type { JobStore, WorkerAdapter, WorkerEventSink } from '../src/types.js';

const execFileAsync = promisify(execFile);

async function git(directory: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: directory });
}

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

function failEventSaves(delegate: MemoryJobStore, failures: Record<string, number>): JobStore {
  const remaining = new Map(Object.entries(failures));
  return {
    create: (job) => delegate.create(job),
    save: async (job) => {
      const type = job.events.at(-1)?.type;
      const count = type === undefined ? 0 : remaining.get(type) ?? 0;
      if (type !== undefined && count > 0) {
        remaining.set(type, count - 1);
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

test('Orchestrator fences route-neutral live control to one active attempt with durable receipts', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-worker-control-'));
  let finishWorker!: () => void;
  let workerReady!: () => void;
  const finish = new Promise<void>((resolve) => { finishWorker = resolve; });
  const ready = new Promise<void>((resolve) => { workerReady = resolve; });
  const deliveries: string[] = [];
  const adapter: WorkerAdapter = {
    name: 'controlled',
    async doctor() { return { ok: true, message: 'ready' }; },
    controlCapabilities() { return ['steer']; },
    async run(input) {
      const unbind = input.control?.bind(async (request) => {
        deliveries.push(`${request.kind}:${request.message}`);
        return { accepted: true };
      });
      workerReady();
      await finish;
      unbind?.();
      return { output: 'controlled result' };
    },
  };
  const controlledConfig: AgentKnotConfig = {
    ...config,
    defaultRoute: 'controlled',
    workers: { controlled: { adapter: 'mock' } },
    routes: {
      controlled: {
        worker: 'controlled',
        provider: 'provider',
        model: 'model',
        maxAttempts: 1,
      },
    },
  };
  const store = new MemoryJobStore();
  const orchestrator = new Orchestrator({
    config: controlledConfig,
    store,
    adapters: new Map([['controlled', adapter]]),
  });

  try {
    const started = await orchestrator.start({ prompt: 'controlled task', workspace });
    await ready;
    assert.deepEqual(await orchestrator.controlCapabilities(started.job.id), {
      schemaVersion: 1,
      jobId: started.job.id,
      attempt: 1,
      state: 'active',
      ready: true,
      kinds: ['steer'],
    });

    const request = {
      schemaVersion: 1 as const,
      controlId: 'control-1',
      attempt: 1,
      kind: 'steer' as const,
      message: 'Stay within src/types.ts.',
    };
    const accepted = await orchestrator.control(started.job.id, request);
    assert.equal(accepted?.status, 'accepted');
    assert.equal(accepted?.durable, true);
    assert.deepEqual(await orchestrator.control(started.job.id, request), accepted);
    assert.deepEqual(deliveries, ['steer:Stay within src/types.ts.']);

    await Promise.all([
      orchestrator.control(started.job.id, {
        schemaVersion: 1,
        controlId: 'control-order-a',
        attempt: 1,
        kind: 'steer',
        message: 'First ordered control.',
      }),
      orchestrator.control(started.job.id, {
        schemaVersion: 1,
        controlId: 'control-order-b',
        attempt: 1,
        kind: 'steer',
        message: 'Second ordered control.',
      }),
    ]);

    const unsupported = await orchestrator.control(started.job.id, {
      schemaVersion: 1,
      controlId: 'control-2',
      attempt: 1,
      kind: 'follow-up',
      message: 'Report after the current turn.',
    });
    assert.equal(unsupported?.status, 'unsupported');
    assert.equal(unsupported?.durable, true);

    const stale = await orchestrator.control(started.job.id, {
      schemaVersion: 1,
      controlId: 'control-3',
      attempt: 2,
      kind: 'steer',
      message: 'Do not reach a different attempt.',
    });
    assert.equal(stale?.status, 'stale-attempt');
    assert.equal(stale?.durable, true);

    finishWorker();
    const terminal = await started.completion;
    assert.deepEqual(
      terminal.events.filter((event) => event.type.startsWith('job.control.')).map((event) => event.type),
      [
        'job.control.requested',
        'job.control.accepted',
        'job.control.requested',
        'job.control.accepted',
        'job.control.requested',
        'job.control.accepted',
        'job.control.requested',
        'job.control.rejected',
        'job.control.requested',
        'job.control.rejected',
      ]
    );
    const afterTerminal = await orchestrator.control(terminal.id, {
      schemaVersion: 1,
      controlId: 'control-4',
      attempt: 1,
      kind: 'steer',
      message: 'Too late.',
    });
    assert.equal(afterTerminal?.status, 'stale-attempt');
    assert.equal(afterTerminal?.durable, false);
    assert.equal((await store.get(terminal.id))?.events.at(-1)?.type, 'job.succeeded');
  } finally {
    finishWorker();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Orchestrator never delivers control when request persistence fails', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-worker-control-persistence-'));
  const delegate = new MemoryJobStore();
  let finishWorker!: () => void;
  let workerReady!: () => void;
  const finish = new Promise<void>((resolve) => { finishWorker = resolve; });
  const ready = new Promise<void>((resolve) => { workerReady = resolve; });
  let deliveries = 0;
  const adapter: WorkerAdapter = {
    name: 'controlled',
    async doctor() { return { ok: true, message: 'ready' }; },
    controlCapabilities() { return ['steer']; },
    async run(input) {
      const unbind = input.control?.bind(async () => {
        deliveries += 1;
        return { accepted: true };
      });
      workerReady();
      await finish;
      unbind?.();
      return { output: 'done' };
    },
  };
  const controlledConfig: AgentKnotConfig = {
    ...config,
    defaultRoute: 'controlled',
    workers: { controlled: { adapter: 'mock' } },
    routes: {
      controlled: {
        worker: 'controlled', provider: 'provider', model: 'model', maxAttempts: 1,
      },
    },
  };
  const orchestrator = new Orchestrator({
    config: controlledConfig,
    store: failEventSave(delegate, 'job.control.requested'),
    adapters: new Map([['controlled', adapter]]),
  });
  try {
    const started = await orchestrator.start({ prompt: 'persist before control', workspace });
    await ready;
    await assert.rejects(
      orchestrator.control(started.job.id, {
        schemaVersion: 1,
        controlId: 'control-persistence',
        attempt: 1,
        kind: 'steer',
        message: 'Must not be delivered.',
      }),
      (error: unknown) => {
        assert.ok(error instanceof JobControlPersistenceError);
        assert.equal(error.delivery, 'not-started');
        return true;
      }
    );
    assert.equal(deliveries, 0);
    finishWorker();
    assert.equal((await started.completion).status, 'succeeded');
  } finally {
    finishWorker();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Orchestrator cannot persist success while delivered control lacks settlement evidence', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-control-terminal-fence-'));
  const delegate = new MemoryJobStore();
  let finishWorker!: () => void;
  let workerReady!: () => void;
  const finish = new Promise<void>((resolve) => { finishWorker = resolve; });
  const ready = new Promise<void>((resolve) => { workerReady = resolve; });
  const adapter: WorkerAdapter = {
    name: 'controlled',
    async doctor() { return { ok: true, message: 'ready' }; },
    controlCapabilities() { return ['steer']; },
    async run(input) {
      input.control?.bind(async () => ({ accepted: true }));
      workerReady();
      await finish;
      return { output: 'must not become durable success' };
    },
  };
  const controlledConfig: AgentKnotConfig = {
    ...config,
    defaultRoute: 'controlled',
    workers: { controlled: { adapter: 'mock' } },
    routes: {
      controlled: { worker: 'controlled', provider: 'provider', model: 'model', maxAttempts: 1 },
    },
  };
  const orchestrator = new Orchestrator({
    config: controlledConfig,
    store: failEventSaves(delegate, { 'job.control.accepted': 1, 'job.control.lost': 2 }),
    adapters: new Map([['controlled', adapter]]),
  });
  try {
    const started = await orchestrator.start({ prompt: 'fence terminal state', workspace });
    await ready;
    await assert.rejects(
      orchestrator.control(started.job.id, {
        schemaVersion: 1,
        controlId: 'control-terminal-fence',
        attempt: 1,
        kind: 'steer',
        message: 'Delivery occurs before settlement persistence fails.',
      }),
      JobControlPersistenceError
    );
    finishWorker();
    await assert.rejects(started.completion, (error: unknown) =>
      assertPersistenceError(error, 'event', 'job.control.lost'));
    const persisted = await delegate.get(started.job.id);
    assert.equal(persisted?.status, 'running');
    assert.equal(persisted?.events.some((event) => event.type === 'job.succeeded'), false);
  } finally {
    finishWorker();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Orchestrator stops one attempt at its configured normalized tool-call limit', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-tool-budget-'));
  let runs = 0;
  let attemptAborted = false;
  const adapter: WorkerAdapter = {
    name: 'budgeted',
    async doctor() {
      return { ok: true, message: 'ready' };
    },
    async run(input, emit) {
      runs += 1;
      try {
        for (let index = 1; index <= 3; index += 1) {
          await emit('worker.tool.started', { toolCallId: `tool-${index}` });
        }
      } catch (error) {
        attemptAborted = input.signal.aborted;
        throw error;
      }
      return { output: 'must not pass the budget' };
    },
  };
  const budgetedConfig: AgentKnotConfig = {
    ...config,
    workers: { budgeted: { adapter: 'mock' } },
    routes: {
      budgeted: {
        worker: 'budgeted',
        provider: 'mock-provider',
        model: 'mock-model',
        maxAttempts: 2,
        maxToolCalls: 5,
      },
    },
    defaultRoute: 'budgeted',
  };
  const job = await new Orchestrator({
    config: budgetedConfig,
    store: new MemoryJobStore(),
    adapters: new Map([['budgeted', adapter]]),
  }).run({ prompt: 'respect the tool budget', workspace, maxToolCalls: 2 });

  assert.equal(job.status, 'failed');
  assert.equal(job.attempt, 1);
  assert.equal(job.error?.name, 'WorkerToolCallLimitError');
  assert.match(job.error?.message ?? '', /effective Job tool-call limit of 2/);
  assert.equal(job.error?.retryable, false);
  assert.equal(runs, 1);
  assert.equal(attemptAborted, true);
  assert.equal(job.route.maxToolCalls, 2);
  assert.equal(
    job.events.filter((event) => event.type === 'worker.tool.started').length,
    2
  );
});

test('Job admission persists the minimum of task and route tool-call budgets', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-effective-tool-budget-'));
  const cases = [
    { route: 5, task: 2, expected: 2 },
    { route: 2, task: 5, expected: 2 },
    { task: 3, expected: 3 },
    { route: 4, expected: 4 },
    {},
  ];
  try {
    const invalidStore = new MemoryJobStore();
    const invalidOrchestrator = new Orchestrator({
      config,
      store: invalidStore,
      adapters: createAdapters(config),
    });
    for (const maxToolCalls of [0, 1.5, 1_001]) {
      await assert.rejects(
        invalidOrchestrator.start({ prompt: 'invalid budget', workspace, maxToolCalls }),
        /Job maxToolCalls must be an integer between 1 and 1000/
      );
    }
    assert.deepEqual(await invalidStore.list(), []);

    for (const candidate of cases) {
      const budgetedConfig: AgentKnotConfig = {
        ...config,
        routes: {
          mock: {
            ...config.routes.mock!,
            ...(candidate.route === undefined ? {} : { maxToolCalls: candidate.route }),
          },
        },
      };
      const job = await new Orchestrator({
        config: budgetedConfig,
        store: new MemoryJobStore(),
        adapters: createAdapters(budgetedConfig),
      }).run({
        prompt: 'effective budget',
        workspace,
        ...(candidate.task === undefined ? {} : { maxToolCalls: candidate.task }),
      });
      assert.equal(job.route.maxToolCalls, candidate.expected);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Orchestrator treats a valid blocked worker result as route-neutral and non-retryable', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-worker-blocked-'));
  let runs = 0;
  const completionReport = {
    schemaVersion: 1 as const,
    taskOutcome: 'blocked' as const,
    changedFiles: [],
    checksRun: [],
    remainingRisks: ['Required context is unavailable.'],
    notes: ['Cannot verify the requested behavior from the admitted working set.'],
  };
  const adapter: WorkerAdapter = {
    name: 'mock',
    async doctor() {
      return { ok: true, message: 'ready' };
    },
    async run() {
      runs += 1;
      return { output: 'available evidence', completionReport };
    },
  };
  const retryConfig = structuredClone(config);
  retryConfig.routes.mock!.maxAttempts = 3;

  try {
    const job = await new Orchestrator({
      config: retryConfig,
      store: new MemoryJobStore(),
      adapters: new Map([['mock', adapter]]),
    }).run({ prompt: 'analyze bounded evidence', workspace });

    assert.equal(job.status, 'failed');
    assert.equal(job.attempt, 1);
    assert.equal(job.error?.name, 'WorkerTaskBlockedError');
    assert.equal(job.error?.retryable, false);
    assert.equal(runs, 1);
    assert.equal(job.events.some((event) => event.type === 'job.retrying'), false);
    assert.deepEqual(job.completionSummary?.workerReported, {
      status: 'reported',
      report: completionReport,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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
  assert.equal(persisted?.attempt, 1, 'attempt is durably reserved before the adapter event');
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

test('independent durable runtimes share one FIFO execution-capacity boundary', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-capacity-workspace-'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-capacity-store-'));
  const firstStore = await SqliteJobStore.open(directory);
  const secondStore = await SqliteJobStore.open(directory, { importLegacy: false });
  const boundedConfig = structuredClone(config);
  boundedConfig.delegation = {
    mode: 'off',
    dispatch: { defaultRoute: 'mock', maxChildren: 1, maxDepth: 1, maxConcurrency: 1 },
    policy: { delegate: [], keepUpstream: [] },
  };
  const startedJobIds: string[] = [];
  const adapter: WorkerAdapter = {
    name: 'mock',
    async doctor() {
      return { ok: true, message: 'blocking capacity adapter ready' };
    },
    async run(input) {
      startedJobIds.push(input.jobId);
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () =>
          reject(input.signal.reason instanceof Error ? input.signal.reason : new Error('aborted'));
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener('abort', onAbort, { once: true });
      });
      return { output: 'unreachable' };
    },
  };
  const firstRuntime = new Orchestrator({
    config: boundedConfig,
    store: firstStore,
    adapters: new Map([['mock', adapter]]),
    leaseTtlMs: 500,
    leaseHeartbeatMs: 100,
  });
  const secondRuntime = new Orchestrator({
    config: boundedConfig,
    store: secondStore,
    adapters: new Map([['mock', adapter]]),
    leaseTtlMs: 500,
    leaseHeartbeatMs: 100,
  });

  let first: Awaited<ReturnType<Orchestrator['start']>> | undefined;
  let second: Awaited<ReturnType<Orchestrator['start']>> | undefined;
  try {
    first = await firstRuntime.start({ prompt: 'hold the global slot', workspace });
    while (startedJobIds.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    second = await secondRuntime.start({ prompt: 'wait across another runtime', workspace });
    const deadline = Date.now() + 2_000;
    let waiting = false;
    while (Date.now() < deadline) {
      const record = await secondStore.get(second.job.id);
      waiting = record?.events.some((event) => event.type === 'job.capacity.waiting') ?? false;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(waiting, true, 'the second runtime must persist capacity waiting evidence');
    assert.deepEqual(startedJobIds, [first.job.id]);

    await first.cancel();
    assert.equal((await first.completion).status, 'cancelled');
    while (startedJobIds.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(startedJobIds, [first.job.id, second.job.id]);
    await second.cancel();
    assert.equal((await second.completion).status, 'cancelled');
  } finally {
    await Promise.allSettled([first?.cancel(), second?.cancel()]);
    await Promise.allSettled([first?.completion, second?.completion]);
    await Promise.all([firstStore.close(), secondStore.close()]);
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(directory, { recursive: true, force: true }),
    ]);
  }
});

test('durable recovery waits for lease expiry, retries only the next attempt, and honors cancellation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-recovery-store-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  await git(workspace, 'init', '-q');
  await git(workspace, 'config', 'user.email', 'agentknot-test@example.invalid');
  await git(workspace, 'config', 'user.name', 'AgentKnot test');
  await writeFile(path.join(workspace, 'README.md'), 'base\n');
  await git(workspace, 'add', '--', 'README.md');
  await git(workspace, 'commit', '-qm', 'base');
  await writeFile(path.join(workspace, 'README.md'), 'admitted dirty input\n');
  const firstStore = await SqliteJobStore.open(directory);
  const secondStore = await SqliteJobStore.open(directory, { importLegacy: false });
  const retryConfig = structuredClone(config);
  retryConfig.storage.directory = 'managed';
  retryConfig.workspaceIsolation = { mode: 'git-worktree', directory: 'worktrees' };
  retryConfig.routes.mock!.maxAttempts = 2;
  const start = new Date('2026-08-11T00:00:00.000Z');
  let clock = new Date(start);
  const attempts: string[] = [];
  const adapter: WorkerAdapter = {
    name: 'mock',
    async doctor() {
      return { ok: true, message: 'recovery adapter ready' };
    },
    async run(input) {
      assert.equal((await secondStore.get(input.jobId))?.attempt, input.attempt);
      attempts.push(`${input.jobId}:${input.attempt}`);
      return { output: `recovered attempt ${input.attempt}` };
    },
  };
  const recovery = new Orchestrator({
    config: retryConfig,
    store: secondStore,
    adapters: new Map([['mock', adapter]]),
    baseDirectory: directory,
    now: () => new Date(clock),
    leaseTtlMs: 300,
    leaseHeartbeatMs: 100,
  });

  const running: Parameters<SqliteJobStore['admit']>[0] = {
    id: 'job_recover_running',
    schemaVersion: 1,
    status: 'running',
    request: { prompt: 'recover the second attempt', workspace },
    route: {
      name: 'mock',
      worker: 'mock',
      provider: 'mock-provider',
      model: 'mock-model',
      requiredEnv: [],
      maxAttempts: 2,
      timeoutMs: 30_000,
    },
    createdAt: start.toISOString(),
    updatedAt: start.toISOString(),
    startedAt: start.toISOString(),
    attempt: 1,
    execution: { runtimeId: 'runtime-old', pid: 1, startedAt: start.toISOString() },
    events: [
      { sequence: 1, jobId: 'job_recover_running', at: start.toISOString(), type: 'job.queued' },
      { sequence: 2, jobId: 'job_recover_running', at: start.toISOString(), type: 'job.started' },
    ],
  };
  const manager = new WorkspaceIsolationManager(retryConfig, directory);
  const inspection = await manager.inspect(workspace);
  running.workspaceSnapshot = await manager.persistAdmissionSnapshot(inspection, running.id);
  const cancelledRunning: Parameters<SqliteJobStore['admit']>[0] = {
    ...structuredClone(running),
    id: 'job_recover_cancelled',
    events: [
      { sequence: 1, jobId: 'job_recover_cancelled', at: start.toISOString(), type: 'job.queued' },
      { sequence: 2, jobId: 'job_recover_cancelled', at: start.toISOString(), type: 'job.started' },
      {
        sequence: 3,
        jobId: 'job_recover_cancelled',
        at: start.toISOString(),
        type: 'job.control.requested',
        data: { controlId: 'control-before-outage', attempt: 1, kind: 'steer', message: 'pending' },
      },
    ],
  };
  cancelledRunning.workspaceSnapshot = await manager.persistAdmissionSnapshot(
    inspection,
    cancelledRunning.id
  );
  const recoverableQueued: Parameters<SqliteJobStore['admit']>[0] = {
    ...structuredClone(running),
    id: 'job_recover_queued',
    status: 'queued',
    attempt: 0,
    events: [
      { sequence: 1, jobId: 'job_recover_queued', at: start.toISOString(), type: 'job.queued' },
    ],
  };
  delete recoverableQueued.startedAt;
  recoverableQueued.workspaceSnapshot = await manager.persistAdmissionSnapshot(
    inspection,
    recoverableQueued.id
  );

  try {
    await firstStore.admit(running, { ownerId: 'runtime-old', ttlMs: 100, now: start });
    await firstStore.admit(cancelledRunning, { ownerId: 'runtime-old', ttlMs: 100, now: start });
    await firstStore.admit(recoverableQueued, {
      ownerId: 'runtime-old',
      ttlMs: 100,
      now: start,
    });
    await firstStore.requestCancellation(
      cancelledRunning.id,
      'controller-during-outage',
      new Date(start.getTime() + 50)
    );

    assert.deepEqual(
      await recovery.recoverInterruptedJobs(),
      [],
      'a live prior fence is never stolen'
    );
    clock = new Date(start.getTime() + 100);
    const admitted = await recovery.recoverInterruptedJobs();
    assert.deepEqual(
      admitted.map((job) => job.id).sort(),
      ['job_recover_cancelled', 'job_recover_queued', 'job_recover_running']
    );

    const terminal = await recovery.wait(running.id, 500);
    const cancelled = await recovery.wait(cancelledRunning.id, 500);
    const queuedTerminal = await recovery.wait(recoverableQueued.id, 500);
    assert.equal(terminal?.status, 'succeeded');
    assert.equal(terminal?.attempt, 2);
    assert.deepEqual(attempts.sort(), ['job_recover_queued:1', 'job_recover_running:2']);
    assert.deepEqual(
      terminal?.events.map((event) => event.type),
      [
        'job.queued',
        'job.started',
        'job.attempt.lost',
        'job.recovery.started',
        'job.artifact',
        'job.succeeded',
      ]
    );
    assert.equal(terminal?.events[2]?.data?.recoveryFence, 2);
    assert.equal(queuedTerminal?.status, 'succeeded');
    assert.deepEqual(
      queuedTerminal?.events.map((event) => event.type),
      ['job.queued', 'job.recovery.started', 'job.started', 'job.artifact', 'job.succeeded']
    );
    assert.equal(cancelled?.status, 'cancelled');
    assert.deepEqual(
      cancelled?.events.slice(-2).map((event) => event.type),
      ['job.control.lost', 'job.cancelled']
    );
    assert.equal(cancelled?.events.at(-1)?.data?.source, 'controller-during-outage');
  } finally {
    await recovery.shutdown();
    await Promise.all([firstStore.close(), secondStore.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

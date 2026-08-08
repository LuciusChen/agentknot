import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AgentKnotConfig } from '../src/config.js';
import {
  Orchestrator,
  ROUTE_DIAGNOSTIC_TIMEOUT_MS,
  type RouteDiagnosticOptions,
} from '../src/orchestrator.js';
import { MemoryJobStore } from '../src/store.js';
import type {
  ResolvedRoute,
  WorkerAdapter,
  WorkerProbeInput,
  WorkerProbeResult,
  WorkerRunInput,
  WorkerRunResult,
} from '../src/types.js';

const config: AgentKnotConfig = {
  version: 1,
  defaultRoute: 'secondary',
  storage: { directory: '.agentknot/jobs' },
  workers: {
    probe: { adapter: 'mock' },
  },
  routes: {
    luna: {
      worker: 'probe',
      provider: 'opencode-go',
      model: 'gpt-5.6-luna',
      thinkingLevel: 'max',
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 3_600_000,
    },
    secondary: {
      worker: 'probe',
      provider: 'secondary-provider',
      model: 'secondary-model',
      thinkingLevel: 'medium',
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 3_600_000,
    },
  },
};

function createAdapter(
  probe: ((input: WorkerProbeInput) => Promise<WorkerProbeResult>) | undefined,
  calls: { probe: number }
): WorkerAdapter {
  return {
    name: 'probe',
    async doctor(route: ResolvedRoute) {
      return { ok: true, message: `Configuration is ready for ${route.provider}/${route.model}` };
    },
    ...(probe === undefined
      ? {}
      : {
          async probe(input: WorkerProbeInput): Promise<WorkerProbeResult> {
            calls.probe += 1;
            return probe(input);
          },
        }),
    async run(_input: WorkerRunInput): Promise<WorkerRunResult> {
      return { output: 'normal job result' };
    },
  };
}

function createOrchestrator(
  adapter: WorkerAdapter,
  options: { diagnosticTimeoutMs?: number } = {}
): { orchestrator: Orchestrator; store: MemoryJobStore } {
  const store = new MemoryJobStore();
  const orchestrator = new Orchestrator({
    config,
    store,
    adapters: new Map([['probe', adapter]]),
    ...options,
  });
  return { orchestrator, store };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('configuration-only doctor says live inference was not checked and does not probe', async () => {
  const calls = { probe: 0 };
  const { orchestrator } = createOrchestrator(
    createAdapter(async () => ({ output: 'unexpected probe' }), calls)
  );

  const result = await orchestrator.doctor('luna');

  assert.equal(result.ok, true);
  assert.equal(result.route, 'luna');
  assert.match(result.message, /live inference was not checked/i);
  assert.deepEqual(result.liveInference, { checked: false, status: 'not-checked' });
  assert.equal(calls.probe, 0);
});

test('live doctor probes the exact resolved Luna route and leaves stores untouched', async () => {
  const calls = { probe: 0 };
  let received: WorkerProbeInput | undefined;
  const { orchestrator, store } = createOrchestrator(
    createAdapter(async (input) => {
      received = input;
      return { output: 'probe succeeded' };
    }, calls)
  );

  const result = await orchestrator.doctor('luna', { live: true });

  assert.equal(result.ok, true);
  assert.match(result.message, /live inference succeeded/i);
  assert.deepEqual(result.liveInference, { checked: true, status: 'succeeded' });
  assert.equal(calls.probe, 1);
  assert.deepEqual(
    {
      name: received?.route.name,
      worker: received?.route.worker,
      provider: received?.route.provider,
      model: received?.route.model,
      thinkingLevel: received?.route.thinkingLevel,
    },
    {
      name: 'luna',
      worker: 'probe',
      provider: 'opencode-go',
      model: 'gpt-5.6-luna',
      thinkingLevel: 'max',
    }
  );
  assert.equal(received?.signal.aborted, false);
  assert.deepEqual(await store.list(), []);
});

test('live doctor preserves provider errors and does not fall back to another route', async () => {
  const calls = { probe: 0 };
  const { orchestrator } = createOrchestrator(
    createAdapter(async () => {
      throw new Error('Luna provider returned HTTP 403: egress denied');
    }, calls)
  );

  const result = await orchestrator.doctor('luna', { live: true });

  assert.equal(result.ok, false);
  assert.match(result.message, /Luna provider returned HTTP 403: egress denied/);
  assert.deepEqual(result.liveInference, { checked: true, status: 'failed' });
  assert.equal(calls.probe, 1);
});

test('live doctor remains route-neutral and probes the selected resolved route', async () => {
  const calls = { probe: 0 };
  let received: WorkerProbeInput | undefined;
  const { orchestrator } = createOrchestrator(
    createAdapter(async (input) => {
      received = input;
      return { output: 'secondary route probe succeeded' };
    }, calls)
  );

  const result = await orchestrator.doctor('secondary', { live: true });

  assert.equal(result.ok, true);
  assert.equal(result.route, 'secondary');
  assert.equal(received?.route.provider, 'secondary-provider');
  assert.equal(received?.route.model, 'secondary-model');
  assert.equal(received?.route.thinkingLevel, 'medium');
  assert.equal(calls.probe, 1);
});

test('live doctor reports unsupported adapters explicitly', async () => {
  const calls = { probe: 0 };
  const { orchestrator } = createOrchestrator(createAdapter(undefined, calls));

  const result = await orchestrator.doctor('luna', { live: true });

  assert.equal(result.ok, false);
  assert.match(result.message, /live inference probe is unsupported/i);
  assert.deepEqual(result.liveInference, { checked: false, status: 'unsupported' });
  assert.equal(calls.probe, 0);
});

test('live doctor aborts a timed-out probe and clears its control-plane timer', async () => {
  const calls = { probe: 0 };
  let probeSignal: AbortSignal | undefined;
  let cleanedUp = false;
  const { orchestrator } = createOrchestrator(
    createAdapter(async ({ signal }) => {
      probeSignal = signal;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            },
            { once: true }
          );
        });
      } finally {
        cleanedUp = true;
      }
      return { output: 'late result' };
    }, calls),
    { diagnosticTimeoutMs: 10 }
  );

  const result = await orchestrator.doctor('luna', { live: true });

  assert.equal(result.ok, false);
  assert.deepEqual(result.liveInference, { checked: true, status: 'timeout' });
  assert.match(result.message, /timed out after 10ms/);
  assert.equal(calls.probe, 1);
  assert.equal(probeSignal?.aborted, true);
  assert.equal(cleanedUp, true);
});

test('live doctor propagates caller abort and cleans up the probe listener', async () => {
  const calls = { probe: 0 };
  let cleanedUp = false;
  const controller = new AbortController();
  const { orchestrator } = createOrchestrator(
    createAdapter(async ({ signal }) => {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            },
            { once: true }
          );
        });
      } finally {
        cleanedUp = true;
      }
      return { output: 'late result' };
    }, calls),
    { diagnosticTimeoutMs: 50 }
  );

  const pending = orchestrator.doctor('luna', {
    live: true,
    signal: controller.signal,
  } satisfies RouteDiagnosticOptions);
  await delay(1);
  controller.abort(new Error('controller stopped'));
  const result = await pending;

  assert.equal(result.ok, false);
  assert.deepEqual(result.liveInference, { checked: true, status: 'aborted' });
  assert.match(result.message, /controller stopped/);
  assert.equal(calls.probe, 1);
  assert.equal(cleanedUp, true);
  await delay(75);
  assert.equal(result.liveInference.status, 'aborted');
});

test('normal jobs never invoke the diagnostic probe or create diagnostic records', async () => {
  const calls = { probe: 0 };
  const { orchestrator, store } = createOrchestrator(
    createAdapter(async () => ({ output: 'unexpected probe' }), calls)
  );
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-diagnostics-job-'));

  const job = await orchestrator.run({ prompt: 'normal execution', workspace, route: 'luna' });

  assert.equal(job.status, 'succeeded');
  assert.equal(calls.probe, 0);
  assert.equal((await store.list()).length, 1);
  assert.deepEqual((await store.get(job.id))?.artifacts, undefined);
});

test('route diagnostics keep the fixed production timeout', () => {
  assert.equal(ROUTE_DIAGNOSTIC_TIMEOUT_MS, 30_000);
});

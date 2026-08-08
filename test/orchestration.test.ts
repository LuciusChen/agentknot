import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AgentKnotConfig } from '../src/config.js';
import { OrchestrationService } from '../src/orchestration.js';
import { MemoryOrchestrationStore } from '../src/orchestration-store.js';
import type { TaskAssessment } from '../src/orchestration-types.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryJobStore } from '../src/store.js';
import type {
  ResolvedRoute,
  WorkerAdapter,
  WorkerEventSink,
  WorkerHealth,
  WorkerRunInput,
  WorkerRunResult,
} from '../src/types.js';

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      },
      { once: true }
    );
  });
}

class PlannerAndWorkerAdapter implements WorkerAdapter {
  readonly name = 'test';
  activeWorkers = 0;
  peakWorkers = 0;
  workerRuns = 0;

  constructor(
    readonly assessment: TaskAssessment,
    readonly workerDelayMs = 5,
    readonly plannerOutput?: string
  ) {}

  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'test adapter ready' };
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    await emit('worker.started', { route: input.route.name });
    if (input.route.name === 'planner') {
      return { output: this.plannerOutput ?? JSON.stringify(this.assessment) };
    }
    this.workerRuns += 1;
    this.activeWorkers += 1;
    this.peakWorkers = Math.max(this.peakWorkers, this.activeWorkers);
    try {
      await abortableDelay(this.workerDelayMs, input.signal);
      return { output: `completed ${input.route.name}: ${input.prompt}` };
    } finally {
      this.activeWorkers -= 1;
    }
  }
}

const assessment: TaskAssessment = {
  schemaVersion: 1,
  recommendation: 'delegate',
  complexity: 'medium',
  parallelizable: true,
  taskKinds: ['test-gap-analysis', 'documentation'],
  reasoning: 'The work has two independent verification tracks.',
  subtasks: [
    {
      title: 'Review tests',
      kind: 'test-gap-analysis',
      prompt: 'Review the tests for missing failure cases.',
      acceptanceCriteria: ['Report concrete missing cases'],
    },
    {
      title: 'Update docs',
      kind: 'documentation',
      prompt: 'Update documentation for the new behavior.',
      acceptanceCriteria: ['Document current behavior and limits'],
    },
  ],
};

function testConfig(maxConcurrency = 1): AgentKnotConfig {
  return {
    version: 1,
    defaultRoute: 'worker',
    storage: { directory: '.agentknot/jobs' },
    workers: { test: { adapter: 'mock' } },
    routes: {
      planner: { worker: 'test', provider: 'test', model: 'planner', maxAttempts: 1, timeoutMs: 30_000 },
      worker: { worker: 'test', provider: 'test', model: 'worker', maxAttempts: 1, timeoutMs: 30_000 },
    },
    delegation: {
      mode: 'auto',
      planner: { strategy: 'hybrid', route: 'planner' },
      dispatch: { defaultRoute: 'worker', maxChildren: 2, maxDepth: 1, maxConcurrency },
      policy: {
        delegate: ['test-gap-analysis', 'documentation'],
        keepUpstream: ['product-decision', 'artifact-integration', 'commit', 'push'],
      },
      fallback: 'upstream',
    },
  };
}

function createServices(adapter: PlannerAndWorkerAdapter, maxConcurrency = 1): {
  jobs: Orchestrator;
  jobStore: MemoryJobStore;
  orchestrations: OrchestrationService;
  orchestrationStore: MemoryOrchestrationStore;
} {
  const config = testConfig(maxConcurrency);
  const jobStore = new MemoryJobStore();
  const jobs = new Orchestrator({
    config,
    store: jobStore,
    adapters: new Map([[adapter.name, adapter]]),
  });
  const orchestrationStore = new MemoryOrchestrationStore();
  const orchestrations = new OrchestrationService({
    config: config.delegation!,
    jobs,
    store: orchestrationStore,
  });
  return { jobs, jobStore, orchestrations, orchestrationStore };
}

test('OrchestrationService persists a plan before dispatching bounded child jobs', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-orchestration-'));
  const adapter = new PlannerAndWorkerAdapter(assessment);
  const { jobStore, orchestrations, orchestrationStore } = createServices(adapter);

  const record = await orchestrations.run({
    prompt: 'Review the tests and update the documentation.',
    workspace,
    source: 'claude',
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.plan?.decision, 'split');
  assert.equal(record.plan?.willDispatch, true);
  assert.equal(record.plannerJobId?.startsWith('job_'), true);
  assert.equal(record.children.length, 2);
  assert.equal(record.children.every((child) => child.status === 'succeeded'), true);
  assert.equal(record.result?.action, 'delegated');
  assert.equal(record.result?.children.length, 2);
  assert.equal(adapter.workerRuns, 2);
  assert.equal(adapter.peakWorkers, 1);
  assert.ok(
    record.events.findIndex((event) => event.type === 'orchestration.planned') <
      record.events.findIndex((event) => event.type === 'orchestration.child.started')
  );
  assert.deepEqual(
    record.events.map((event) => event.sequence),
    Array.from({ length: record.events.length }, (_, index) => index + 1)
  );
  assert.deepEqual(await orchestrationStore.get(record.id), record);
  assert.equal((await jobStore.list()).length, 3);
});

test('OrchestrationService suggest mode persists a plan without dispatching worker jobs', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-suggest-'));
  const adapter = new PlannerAndWorkerAdapter(assessment);
  const { jobStore, orchestrations } = createServices(adapter);

  const record = await orchestrations.run({
    prompt: 'Suggest a delegation plan.',
    workspace,
    delegation: 'suggest',
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.plan?.mode, 'suggest');
  assert.equal(record.plan?.willDispatch, false);
  assert.equal(record.result?.action, 'suggested');
  assert.deepEqual(record.children, []);
  assert.equal(adapter.workerRuns, 0);
  assert.equal((await jobStore.list()).length, 1);
});

test('OrchestrationService uses explicit upstream fallback for malformed planner output', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-fallback-'));
  const adapter = new PlannerAndWorkerAdapter(assessment, 5, 'not json');
  const { orchestrations } = createServices(adapter);

  const record = await orchestrations.run({ prompt: 'Ambiguous task.', workspace });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.plan?.decision, 'upstream');
  assert.equal(record.plan?.willDispatch, false);
  assert.match(record.plan?.plannerError?.message ?? '', /valid JSON object/);
  const { planHash, ...unhashedPlan } = record.plan!;
  assert.equal(planHash, createHash('sha256').update(JSON.stringify(unhashedPlan)).digest('hex'));
  assert.equal(record.result?.action, 'upstream');
  assert.deepEqual(record.children, []);
});

test('OrchestrationService cancellation stops active child jobs and does not launch more work', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-orchestration-cancel-'));
  const adapter = new PlannerAndWorkerAdapter(assessment, 1_000);
  const { orchestrations } = createServices(adapter);

  const started = await orchestrations.start({ prompt: 'Run delegated work.', workspace });
  while (adapter.workerRuns === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await started.cancel();
  const record = await started.completion;

  assert.equal(record.status, 'cancelled');
  assert.equal(adapter.workerRuns, 1);
  assert.equal(record.children.length, 1);
  assert.equal(record.children[0]?.status, 'cancelled');
  assert.equal(record.events.some((event) => event.type === 'orchestration.cancel.requested'), true);
  assert.equal(record.events.at(-1)?.type, 'orchestration.cancelled');
});

test('OrchestrationService enforces its concurrency cap across parent orchestrations', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-orchestration-global-cap-'));
  const oneChildAssessment: TaskAssessment = {
    ...assessment,
    parallelizable: false,
    taskKinds: ['test-gap-analysis'],
    subtasks: [assessment.subtasks[0]!],
  };
  const adapter = new PlannerAndWorkerAdapter(oneChildAssessment, 25);
  const { orchestrations } = createServices(adapter);

  const [first, second] = await Promise.all([
    orchestrations.run({ prompt: 'Review tests for request one.', workspace }),
    orchestrations.run({ prompt: 'Review tests for request two.', workspace }),
  ]);

  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'succeeded');
  assert.equal(adapter.workerRuns, 2);
  assert.equal(adapter.peakWorkers, 1);
});

test('OrchestrationService runs independent child jobs concurrently when the cap allows it', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-orchestration-parallel-'));
  const adapter = new PlannerAndWorkerAdapter(assessment, 25);
  const { orchestrations } = createServices(adapter, 2);

  const record = await orchestrations.run({
    prompt: 'Review test gaps and documentation in parallel.',
    workspace,
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.children.length, 2);
  assert.equal(adapter.workerRuns, 2);
  assert.equal(adapter.peakWorkers, 2);
});

test('OrchestrationService serializes children when the assessment marks them non-parallel', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-orchestration-nonparallel-'));
  const adapter = new PlannerAndWorkerAdapter({ ...assessment, parallelizable: false }, 25);
  const { orchestrations } = createServices(adapter, 2);

  const record = await orchestrations.run({
    prompt: 'Perform two ordered review tasks.',
    workspace,
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(adapter.workerRuns, 2);
  assert.equal(adapter.peakWorkers, 1);
  assert.deepEqual(
    record.events.find((event) => event.type === 'orchestration.dispatching')?.data,
    { subtaskCount: 2, configuredConcurrency: 2, effectiveConcurrency: 1 }
  );
});

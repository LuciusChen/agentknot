import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { AgentKnotConfig } from '../src/config.js';
import { OrchestrationService } from '../src/orchestration.js';
import { MemoryOrchestrationStore } from '../src/orchestration-store.js';
import type {
  OrchestrationRecord,
  OrchestrationStore,
  TaskAssessment,
} from '../src/orchestration-types.js';
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

const execFileAsync = promisify(execFile);

async function createGitWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync('git', ['init', '-q'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'agentknot-tests@example.invalid'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['config', 'user.name', 'AgentKnot Tests'], { cwd: workspace });
  await writeFile(path.join(workspace, 'README.md'), '# fixture\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-q', '-m', 'fixture'], { cwd: workspace });
  return workspace;
}

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

async function waitFor(condition: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

class PlannerAndWorkerAdapter implements WorkerAdapter {
  readonly name = 'test';
  activeWorkers = 0;
  peakWorkers = 0;
  workerRuns = 0;
  activeRuns = 0;
  peakRuns = 0;

  constructor(
    readonly assessment: TaskAssessment,
    readonly workerDelayMs = 5,
    readonly plannerOutput?: string,
    readonly plannerDelayMs = 0
  ) {}

  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'test adapter ready' };
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    await emit('worker.started', { route: input.route.name });
    this.activeRuns += 1;
    this.peakRuns = Math.max(this.peakRuns, this.activeRuns);
    try {
      if (input.route.name === 'planner') {
        await abortableDelay(this.plannerDelayMs, input.signal);
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
    } finally {
      this.activeRuns -= 1;
    }
  }
}

class BlockingPlannerAdapter implements WorkerAdapter {
  readonly name = 'test';
  activeRuns = 0;
  workerRuns = 0;
  #plannerStartedResolve: (() => void) | undefined;
  readonly plannerStarted = new Promise<void>((resolve) => {
    this.#plannerStartedResolve = resolve;
  });

  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'blocking test adapter ready' };
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    this.activeRuns += 1;
    try {
      await emit('worker.started', { route: input.route.name });
      if (input.route.name === 'planner') {
        this.#plannerStartedResolve?.();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            cleanup();
            reject(input.signal.reason instanceof Error ? input.signal.reason : new Error('Aborted'));
          };
          const cleanup = () => {
            input.signal.removeEventListener('abort', onAbort);
          };
          if (input.signal.aborted) onAbort();
          else input.signal.addEventListener('abort', onAbort, { once: true });
        });
        return { output: JSON.stringify(assessment) };
      }
      this.workerRuns += 1;
      return { output: `completed ${input.route.name}: ${input.prompt}` };
    } finally {
      this.activeRuns -= 1;
    }
  }
}

class RetryingChildAdapter implements WorkerAdapter {
  readonly name = 'test';
  readonly attempts: Array<{ prompt: string; attempt: number }> = [];

  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'retry test adapter ready' };
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    await emit('worker.started', { route: input.route.name });
    if (input.route.name === 'planner') return { output: JSON.stringify(assessment) };

    this.attempts.push({ prompt: input.prompt, attempt: input.attempt });
    if (input.prompt.includes('Review the tests') && input.attempt === 1) {
      throw new Error('transient child failure');
    }
    if (input.prompt.includes('Update documentation')) {
      throw new Error('permanent child failure');
    }
    return { output: `completed on attempt ${input.attempt}` };
  }
}

class FailingOrchestrationStore implements OrchestrationStore {
  readonly delegate = new MemoryOrchestrationStore();
  saveCalls = 0;

  constructor(readonly failAtSave: number) {}

  create(record: OrchestrationRecord): Promise<void> {
    return this.delegate.create(record);
  }

  async save(record: OrchestrationRecord): Promise<void> {
    this.saveCalls += 1;
    if (this.saveCalls === this.failAtSave) throw new Error('injected orchestration save failure');
    await this.delegate.save(record);
  }

  get(id: string): Promise<OrchestrationRecord | undefined> {
    return this.delegate.get(id);
  }

  list(): Promise<OrchestrationRecord[]> {
    return this.delegate.list();
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

function testConfig(maxConcurrency = 1, workerMaxAttempts = 1, maxChildren = 2): AgentKnotConfig {
  return {
    version: 1,
    defaultRoute: 'worker',
    storage: { directory: '.agentknot/jobs' },
    workspaceIsolation: {
      mode: 'git-worktree',
      directory: path.join(os.tmpdir(), 'agentknot-orchestration-test-worktrees'),
    },
    workers: { test: { adapter: 'mock' } },
    routes: {
      planner: { worker: 'test', provider: 'test', model: 'planner', maxAttempts: 1, timeoutMs: 30_000 },
      worker: {
        worker: 'test',
        provider: 'test',
        model: 'worker',
        maxAttempts: workerMaxAttempts,
        timeoutMs: 30_000,
      },
    },
    delegation: {
      mode: 'auto',
      planner: { strategy: 'hybrid', route: 'planner' },
      dispatch: { defaultRoute: 'worker', maxChildren, maxDepth: 1, maxConcurrency },
      policy: {
        delegate: ['test-gap-analysis', 'documentation'],
        keepUpstream: ['product-decision', 'artifact-integration', 'commit', 'push'],
      },
      fallback: 'upstream',
    },
  };
}

function createServices(
  adapter: WorkerAdapter,
  maxConcurrency = 1,
  workerMaxAttempts = 1,
  maxChildren = 2
): {
  jobs: Orchestrator;
  jobStore: MemoryJobStore;
  orchestrations: OrchestrationService;
  orchestrationStore: MemoryOrchestrationStore;
} {
  const config = testConfig(maxConcurrency, workerMaxAttempts, maxChildren);
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
  const workspace = await createGitWorkspace('agentknot-orchestration-');
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
  assert.equal(record.children.every((child) => child.planHash === record.plan?.planHash), true);
  assert.equal(record.children.every((child) => child.policyVersion === 1), true);
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
  const jobs = await jobStore.list();
  assert.equal(jobs.length, 3);
  for (const child of jobs.filter(
    (job) => job.request.metadata?.agentknotDelegation && job.id !== record.plannerJobId
  )) {
    const provenance = child.request.metadata?.agentknotDelegation as Record<string, unknown>;
    assert.equal(provenance.planHash, record.plan?.planHash);
    assert.equal(provenance.policyVersion, 1);
  }
});

test('OrchestrationService suggest mode persists a plan without dispatching worker jobs', async () => {
  const workspace = await createGitWorkspace('agentknot-suggest-');
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
  const workspace = await createGitWorkspace('agentknot-fallback-');
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

test('OrchestrationService rejects a nested missing acceptanceCriteria without dispatching children', async () => {
  const workspace = await createGitWorkspace('agentknot-fallback-missing-criteria-');
  const malformedAssessment = {
    ...assessment,
    subtasks: assessment.subtasks.map((subtask, index) => {
      if (index !== 1) return subtask;
      const { acceptanceCriteria: _acceptanceCriteria, ...rest } = subtask;
      return rest;
    }),
  };
  const adapter = new PlannerAndWorkerAdapter(assessment, 5, JSON.stringify(malformedAssessment));
  const { jobStore, orchestrations } = createServices(adapter);

  const record = await orchestrations.run({ prompt: 'Reject incomplete structured planner output.', workspace });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.plan?.decision, 'upstream');
  assert.equal(record.plan?.willDispatch, false);
  assert.match(record.plan?.plannerError?.message ?? '', /subtasks\[1\]/);
  assert.match(record.plan?.plannerError?.message ?? '', /missing: acceptanceCriteria/);
  assert.equal(record.result?.action, 'upstream');
  assert.deepEqual(record.children, []);
  assert.equal(adapter.workerRuns, 0);
  assert.equal((await jobStore.list()).length, 1);
});

test('OrchestrationService cancellation stops active child jobs and does not launch more work', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-cancel-');
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

test('OrchestrationService cancellation removes a planner blocked on the shared dispatch semaphore', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-blocked-cancel-');
  const adapter = new BlockingPlannerAdapter();
  const { jobStore, orchestrations, orchestrationStore } = createServices(adapter, 1);

  const first = await orchestrations.start({ prompt: 'Hold the planner slot.', workspace });
  await adapter.plannerStarted;

  const second = await orchestrations.start({ prompt: 'Wait for the planner slot.', workspace });
  await waitFor(
    async () => {
      const record = await orchestrationStore.get(second.orchestration.id);
      return record?.events.some((event) => event.type === 'orchestration.planning') === true;
    },
    'the second orchestration to reach planning'
  );
  assert.equal((await jobStore.list()).length, 1, 'the blocked planner must not be admitted');

  await second.cancel();
  const cancelled = await second.completion;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.children.length, 0);
  assert.equal(cancelled.events.at(-1)?.type, 'orchestration.cancelled');
  assert.equal((await jobStore.list()).length, 1, 'cancelling a semaphore waiter must not start a job');
  assert.equal(adapter.activeRuns, 1, 'the first planner remains the only active execution');

  await first.cancel();
  const firstCancelled = await first.completion;
  assert.equal(firstCancelled.status, 'cancelled');
  assert.equal(adapter.activeRuns, 0, 'all admitted work must settle after cancellation');
});

test('OrchestrationService aggregates failed children while preserving child retries', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-child-retry-');
  const adapter = new RetryingChildAdapter();
  const { jobStore, orchestrations } = createServices(adapter, 2, 2);

  const record = await orchestrations.run({
    prompt: 'Retry delegated work and report failures.',
    workspace,
  });

  assert.equal(record.status, 'failed');
  assert.equal(record.children.length, 2);
  assert.match(record.error?.message ?? '', /1 of 2 delegated child jobs did not succeed/);
  assert.equal(record.events.at(-1)?.type, 'orchestration.failed');

  const jobs = await jobStore.list();
  const retriedJob = jobs.find((job) => job.request.prompt.includes('Review the tests'));
  const failedJob = jobs.find((job) => job.request.prompt.includes('Update documentation'));
  assert.ok(retriedJob);
  assert.ok(failedJob);
  assert.equal(retriedJob.attempt, 2);
  assert.equal(retriedJob.status, 'succeeded');
  assert.equal(retriedJob.result?.attempt, 2);
  assert.equal(retriedJob.events.filter((event) => event.type === 'job.retrying').length, 1);
  assert.equal(failedJob.attempt, 2);
  assert.equal(failedJob.status, 'failed');
  assert.equal(failedJob.error?.attempt, 2);
  assert.equal(failedJob.error?.retryable, false);
  assert.equal(failedJob.events.filter((event) => event.type === 'job.retrying').length, 1);

  const retriedChild = record.children.find((child) => child.jobId === retriedJob.id);
  const failedChild = record.children.find((child) => child.jobId === failedJob.id);
  const retriedResultChild = record.result?.children.find((child) => child.jobId === retriedJob.id);
  const failedResultChild = record.result?.children.find((child) => child.jobId === failedJob.id);
  assert.equal(retriedChild?.status, 'succeeded');
  assert.equal(failedChild?.status, 'failed');
  assert.equal(failedChild?.error?.attempt, 2);
  assert.equal(retriedResultChild?.status, 'succeeded');
  assert.equal(failedResultChild?.status, 'failed');
  assert.deepEqual(
    adapter.attempts
      .filter(({ prompt }) => prompt === retriedJob.request.prompt)
      .map(({ attempt }) => attempt),
    [1, 2]
  );
  assert.deepEqual(
    adapter.attempts
      .filter(({ prompt }) => prompt === failedJob.request.prompt)
      .map(({ attempt }) => attempt),
    [1, 2]
  );
});

test('OrchestrationService enforces its concurrency cap across parent orchestrations', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-global-cap-');
  const oneChildAssessment: TaskAssessment = {
    ...assessment,
    parallelizable: false,
    taskKinds: ['test-gap-analysis'],
    subtasks: [assessment.subtasks[0]!],
  };
  const adapter = new PlannerAndWorkerAdapter(oneChildAssessment, 25, undefined, 25);
  const { orchestrations } = createServices(adapter);

  const [first, second] = await Promise.all([
    orchestrations.run({ prompt: 'Review tests for request one.', workspace }),
    orchestrations.run({ prompt: 'Review tests for request two.', workspace }),
  ]);

  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'succeeded');
  assert.equal(adapter.workerRuns, 2);
  assert.equal(adapter.peakWorkers, 1);
  assert.equal(adapter.peakRuns, 1);
});

test('OrchestrationService runs independent child jobs concurrently when the cap allows it', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-parallel-');
  const adapter = new PlannerAndWorkerAdapter(assessment, 250);
  const { orchestrations } = createServices(adapter, 4, 1, 6);

  const record = await orchestrations.run({
    prompt: 'Review test gaps and documentation in parallel.',
    workspace,
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.children.length, 2);
  assert.equal(adapter.workerRuns, 2);
  assert.equal(adapter.peakWorkers, 2);
  assert.equal(adapter.peakRuns, 2);
});

test('OrchestrationService refills bounded worker slots from a larger task pool', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-task-pool-');
  const pooledAssessment: TaskAssessment = {
    ...assessment,
    taskKinds: ['test-gap-analysis'],
    subtasks: Array.from({ length: 6 }, (_, index) => ({
      title: `Independent part ${index + 1}`,
      kind: 'test-gap-analysis',
      prompt: `Implement independent part ${index + 1} within its exclusive file scope.`,
      acceptanceCriteria: [`Part ${index + 1} is independently verified`],
    })),
  };
  const adapter = new PlannerAndWorkerAdapter(pooledAssessment, 500);
  const { orchestrations } = createServices(adapter, 4, 1, 6);

  const record = await orchestrations.run({
    prompt: 'Run six independent scoped tasks through four worker slots.',
    workspace,
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.children.length, 6);
  assert.equal(adapter.workerRuns, 6);
  assert.equal(adapter.peakWorkers, 4);
  const firstCompletion = record.events.findIndex(
    (event) => event.type === 'orchestration.child.completed'
  );
  assert.notEqual(firstCompletion, -1);
  assert.equal(
    record.events
      .slice(0, firstCompletion)
      .filter((event) => event.type === 'orchestration.child.started').length,
    4
  );
  assert.equal(
    record.events
      .slice(firstCompletion + 1)
      .filter((event) => event.type === 'orchestration.child.started').length,
    2
  );
});

test('OrchestrationService serializes children when the assessment marks them non-parallel', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-nonparallel-');
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

test('OrchestrationService requires isolated jobs for automatic modes', () => {
  const config = testConfig();
  delete config.workspaceIsolation;
  const adapter = new PlannerAndWorkerAdapter(assessment);
  const jobs = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: new Map([[adapter.name, adapter]]),
  });

  assert.throws(
    () =>
      new OrchestrationService({
        config: config.delegation!,
        jobs,
        store: new MemoryOrchestrationStore(),
      }),
    /requires a job orchestrator with git-worktree isolation/
  );
});

test('OrchestrationService cancels an admitted planner when parent persistence fails', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-planner-save-failure-');
  const adapter = new PlannerAndWorkerAdapter(assessment, 5, undefined, 1_000);
  const config = testConfig(1);
  const jobs = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: new Map([[adapter.name, adapter]]),
  });
  const store = new FailingOrchestrationStore(3);
  const orchestrations = new OrchestrationService({ config: config.delegation!, jobs, store });

  const record = await orchestrations.run({ prompt: 'Review persistence.', workspace });
  const planner = (await jobs.list())[0];

  assert.equal(record.status, 'failed');
  assert.match(record.error?.message ?? '', /injected orchestration save failure/);
  assert.equal(planner?.status, 'cancelled');
  assert.equal(adapter.activeRuns, 0);
});

test('OrchestrationService cancels an admitted child when parent persistence fails', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-child-save-failure-');
  const adapter = new PlannerAndWorkerAdapter(assessment, 1_000);
  const config = testConfig(1);
  const jobs = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: new Map([[adapter.name, adapter]]),
  });
  const store = new FailingOrchestrationStore(7);
  const orchestrations = new OrchestrationService({ config: config.delegation!, jobs, store });

  const record = await orchestrations.run({ prompt: 'Review persistence.', workspace });
  const childJob = (await jobs.list()).find(
    (job) => (job.request.metadata?.agentknotDelegation as Record<string, unknown>)?.role === 'worker'
  );

  assert.equal(record.status, 'failed');
  assert.match(record.error?.message ?? '', /injected orchestration save failure/);
  assert.equal(record.children.length, 1);
  assert.equal(record.children[0]?.status, 'cancelled');
  assert.equal(childJob?.status, 'cancelled');
  assert.equal(adapter.activeRuns, 0);
});

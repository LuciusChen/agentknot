import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type {
  AgentKnotConfig,
  ArtifactValidationConfig,
  RouteSelectionConfig,
} from '../src/config.js';
import { OrchestrationService } from '../src/orchestration.js';
import { MemoryOrchestrationStore } from '../src/orchestration-store.js';
import type {
  DelegationPlan,
  OrchestrationRecord,
  OrchestrationRequest,
  OrchestrationStore,
  PlannedSubtask,
  TaskAssessment,
} from '../src/orchestration-types.js';
import { JobPersistenceError, Orchestrator } from '../src/orchestrator.js';
import { MemoryJobStore } from '../src/store.js';
import type {
  JobRecord,
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

async function gitStatus(workspace: string): Promise<string> {
  return String((await execFileAsync('git', ['status', '--short'], { cwd: workspace })).stdout);
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
  reviewerRuns = 0;

  constructor(
    readonly assessment: TaskAssessment,
    readonly workerDelayMs = 5,
    ..._unused: unknown[]
  ) {}

  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'test adapter ready' };
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    await emit('worker.started', { route: input.route.name });
    this.activeRuns += 1;
    this.peakRuns = Math.max(this.peakRuns, this.activeRuns);
    try {
      if (input.route.name.startsWith('reviewer')) {
        this.reviewerRuns += 1;
        return {
          output: JSON.stringify({
            schemaVersion: 1,
            verdict: 'accept',
            summary: 'The bounded patch satisfies the stated criteria.',
            findings: [],
          }),
        };
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

class ArtifactWritingAdapter implements WorkerAdapter {
  readonly name = 'test';
  reviewerRuns = 0;

  constructor(
    readonly assessment: TaskAssessment,
    readonly pathsByPrompt: Map<string, string[]>,
    readonly reviewerOutput = JSON.stringify({
      schemaVersion: 1,
      verdict: 'accept',
      summary: 'The patch is correct for the bounded task.',
      findings: [],
    })
  ) {}

  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'artifact-writing adapter ready' };
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    await emit('worker.started', { route: input.route.name });
    if (input.route.name.startsWith('reviewer')) {
      this.reviewerRuns += 1;
      return { output: this.reviewerOutput };
    }
    for (const [prompt, changedPaths] of this.pathsByPrompt) {
      if (!input.prompt.includes(prompt)) continue;
      for (const changedPath of changedPaths) {
        await writeFile(path.join(input.workspace, changedPath), `${prompt}\n`);
      }
    }
    return { output: `completed ${input.route.name}` };
  }
}

class BlockingReviewerAdapter implements WorkerAdapter {
  readonly name = 'test';
  reviewerJobId: string | undefined;
  #reviewerStartedResolve: (() => void) | undefined;
  readonly reviewerStarted = new Promise<void>((resolve) => {
    this.#reviewerStartedResolve = resolve;
  });

  constructor(readonly assessment: TaskAssessment) {}

  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'blocking reviewer ready' };
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    await emit('worker.started', { route: input.route.name });
    if (input.route.name === 'worker') {
      await writeFile(path.join(input.workspace, 'reviewed.ts'), 'export const reviewed = true;\n');
      return { output: 'implemented reviewed.ts' };
    }
    this.reviewerJobId = input.jobId;
    this.#reviewerStartedResolve?.();
    await new Promise<void>((_resolve, reject) => {
      const onAbort = () => {
        input.signal.removeEventListener('abort', onAbort);
        reject(input.signal.reason instanceof Error ? input.signal.reason : new Error('Aborted'));
      };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    });
    return { output: 'unreachable' };
  }
}

class CoordinatedReviewerAdapter implements WorkerAdapter {
  readonly name = 'test';

  constructor(
    readonly assessment: TaskAssessment,
    readonly validationMarker: string,
    readonly reviewerMarker: string
  ) {}

  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'coordinated reviewer ready' };
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    await emit('worker.started', { route: input.route.name });
    if (input.route.name === 'worker') {
      await writeFile(path.join(input.workspace, 'reviewed.ts'), 'export const reviewed = true;\n');
      return { output: 'implemented reviewed.ts' };
    }
    await writeFile(this.reviewerMarker, 'started\n');
    let validationStarted = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      validationStarted = await stat(this.validationMarker).then(
        () => true,
        () => false
      );
      if (validationStarted) break;
      await abortableDelay(5, input.signal);
    }
    if (!validationStarted) throw new Error('Timed out waiting for concurrent artifact validation');
    return {
      output: JSON.stringify({
        schemaVersion: 1,
        verdict: 'accept',
        summary: 'The patch and concurrent validation evidence are bounded.',
        findings: [],
      }),
    };
  }
}

class BlockingWorkerAdapter implements WorkerAdapter {
  readonly name = 'test';
  activeRuns = 0;
  workerRuns = 0;
  #workerStartedResolve: (() => void) | undefined;
  readonly workerStarted = new Promise<void>((resolve) => {
    this.#workerStartedResolve = resolve;
  });

  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'blocking test adapter ready' };
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    this.activeRuns += 1;
    try {
      await emit('worker.started', { route: input.route.name });
      this.workerRuns += 1;
      this.#workerStartedResolve?.();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          input.signal.removeEventListener('abort', onAbort);
          reject(input.signal.reason instanceof Error ? input.signal.reason : new Error('Aborted'));
        };
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener('abort', onAbort, { once: true });
      });
      return { output: `unreachable ${input.route.name}: ${input.prompt}` };
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
  created: OrchestrationRecord | undefined;

  constructor(readonly failAtSave: number) {}

  create(record: OrchestrationRecord): Promise<void> {
    this.created = structuredClone(record);
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

class SwitchableOrchestrationStore implements OrchestrationStore {
  readonly delegate = new MemoryOrchestrationStore();
  failNextSave = false;

  create(record: OrchestrationRecord): Promise<void> {
    return this.delegate.create(record);
  }

  async save(record: OrchestrationRecord): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('injected cancellation save failure');
    }
    await this.delegate.save(record);
  }

  get(id: string): Promise<OrchestrationRecord | undefined> {
    return this.delegate.get(id);
  }

  list(): Promise<OrchestrationRecord[]> {
    return this.delegate.list();
  }
}

class ParentAwareJobStore extends MemoryJobStore {
  constructor(readonly parentStore: OrchestrationStore) {
    super();
  }

  override async create(record: JobRecord): Promise<void> {
    const metadata = record.request.metadata?.agentknotDelegation as Record<string, unknown> | undefined;
    if (metadata?.role === 'worker') {
      const parent = await this.parentStore.get(String(metadata.orchestrationId));
      assert.ok(parent?.plan, 'the deterministic handoff plan must be persisted before child admission');
      assert.equal(
        parent.events.some((event) => event.type === 'orchestration.handoff.accepted'),
        true,
        'the handoff event must be persisted before child admission'
      );
    }
    await super.create(record);
  }
}

class ChildPersistenceFailureAdapter implements WorkerAdapter {
  readonly name = 'test';

  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'persistence failure adapter ready' };
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    await emit('worker.started', { route: input.route.name });
    throw new JobPersistenceError('terminal', 'job.succeeded', new Error('child snapshot full'));
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

function singleQualityReviewAssessment(prompt: string): TaskAssessment {
  return {
    schemaVersion: 1,
    recommendation: 'delegate',
    complexity: 'low',
    parallelizable: false,
    taskKinds: ['documentation'],
    reasoning: 'One small repository deliverable needs independent review.',
    subtasks: [
      {
        title: 'Produce one reviewed file',
        kind: 'documentation',
        prompt,
        acceptanceCriteria: ['The bounded reviewed file is added with the expected value'],
      },
    ],
  };
}

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
      worker: {
        worker: 'test',
        provider: 'test',
        model: 'worker',
        maxAttempts: workerMaxAttempts,
        timeoutMs: 30_000,
      },
      alternate: {
        worker: 'test',
        provider: 'test',
        model: 'alternate',
        maxAttempts: workerMaxAttempts,
        timeoutMs: 30_000,
      },
      reviewer: {
        worker: 'test',
        provider: 'test',
        model: 'reviewer',
        maxAttempts: 1,
        timeoutMs: 30_000,
      },
      'reviewer-alternate': {
        worker: 'test',
        provider: 'test',
        model: 'reviewer-alternate',
        maxAttempts: 1,
        timeoutMs: 30_000,
      },
    },
    delegation: {
      mode: 'auto',
      dispatch: { defaultRoute: 'worker', maxChildren, maxDepth: 1, maxConcurrency },
      policy: {
        delegate: ['test-gap-analysis', 'documentation'],
        keepUpstream: ['product-decision', 'artifact-integration', 'commit', 'push'],
      },
    },
  };
}

function createServices(
  adapter: WorkerAdapter,
  maxConcurrency = 1,
  workerMaxAttempts = 1,
  maxChildren = 2,
  routeSelection?: RouteSelectionConfig,
  qualityReview = false,
  artifactValidation?: ArtifactValidationConfig
): {
  jobs: Orchestrator;
  jobStore: MemoryJobStore;
  orchestrations: OrchestrationService;
  orchestrationStore: MemoryOrchestrationStore;
} {
  const config = testConfig(maxConcurrency, workerMaxAttempts, maxChildren);
  if (routeSelection !== undefined) config.delegation!.dispatch.routeSelection = routeSelection;
  if (qualityReview) {
    config.delegation!.qualityReview = { route: 'reviewer', complexities: ['low'] };
  }
  if (artifactValidation !== undefined) {
    config.delegation!.artifactValidation = artifactValidation;
  }
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
    assessment,
    source: 'claude',
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.plan?.decision, 'split');
  assert.equal(record.plan?.willDispatch, true);
  assert.deepEqual(record.request.assessment, assessment);
  assert.notEqual(record.request.assessment, assessment);
  assert.equal(record.children.length, 2);
  assert.equal(record.children.every((child) => child.status === 'succeeded'), true);
  assert.equal(record.children.every((child) => child.planHash === record.plan?.planHash), true);
  assert.equal(record.children.every((child) => child.policyVersion === 1), true);
  assert.equal(record.result?.action, 'delegated');
  assert.equal(record.result?.children.length, 2);
  assert.deepEqual(record.result?.artifactReview, {
    status: 'checked',
    conflicts: [],
    unavailable: [],
  });
  assert.equal(adapter.workerRuns, 2);
  assert.equal(adapter.peakWorkers, 1);
  assert.ok(
    record.events.findIndex((event) => event.type === 'orchestration.handoff.accepted') <
      record.events.findIndex((event) => event.type === 'orchestration.child.started')
  );
  assert.deepEqual(
    record.events.map((event) => event.sequence),
    Array.from({ length: record.events.length }, (_, index) => index + 1)
  );
  assert.deepEqual(await orchestrationStore.get(record.id), record);
  assert.equal(
    record.events.some(
      (event) => String(event.type).includes('orchestration.planner') || String(event.type) === 'orchestration.planning'
    ),
    false
  );
  const jobs = await jobStore.list();
  assert.equal(jobs.length, 2);
  assert.equal(
    jobs.every(
      (job) => (job.request.metadata?.agentknotDelegation as Record<string, unknown> | undefined)?.role === 'worker'
    ),
    true
  );
  for (const child of jobs) {
    const provenance = child.request.metadata?.agentknotDelegation as Record<string, unknown>;
    assert.equal(provenance.planHash, record.plan?.planHash);
    assert.equal(provenance.policyVersion, 1);
  }
});

test('OrchestrationService dispatches parallel children through a complete-route pool', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-route-pool-');
  const adapter = new PlannerAndWorkerAdapter(assessment, 20);
  const config = testConfig(2);
  config.routePools = {
    balanced: { strategy: 'least-active', routes: ['worker', 'alternate'] },
  };
  config.delegation!.dispatch.defaultRoute = 'balanced';
  const jobStore = new MemoryJobStore();
  const jobs = new Orchestrator({
    config,
    store: jobStore,
    adapters: new Map([[adapter.name, adapter]]),
  });
  const orchestrations = new OrchestrationService({
    config: config.delegation!,
    jobs,
    store: new MemoryOrchestrationStore(),
  });

  const record = await orchestrations.run({
    prompt: 'Review tests and update docs through the configured pool.',
    workspace,
    assessment,
    source: 'codex',
  });
  assert.equal(record.status, 'succeeded');
  const children = await Promise.all(record.children.map((child) => jobs.get(child.jobId)));
  assert.deepEqual(
    children.map((child) => child?.route.name).sort(),
    ['alternate', 'worker']
  );
  assert.equal(children.every((child) => child?.request.route === 'balanced'), true);
  assert.equal(children.every((child) => child?.routePoolSelection?.pool === 'balanced'), true);
  assert.equal(children.every((child) => child?.routePoolSelection?.selectedRoute === child?.route.name), true);
  assert.equal(record.children.every((child) => child.routePoolSelection?.pool === 'balanced'), true);
  assert.equal(
    record.children.every((child) => child.routePoolSelection?.selectedRoute === child.route?.name),
    true
  );
});

test('OrchestrationService resolves reviewer pools to replaceable exact routes', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-role-pools-');
  const adapter = new ArtifactWritingAdapter(
    singleQualityReviewAssessment('Produce reviewed file.'),
    new Map([['Produce reviewed file.', ['reviewed.ts']]])
  );
  const config = testConfig(2, 1, 1);
  config.routePools = {
    reviewers: { strategy: 'least-active', routes: ['reviewer', 'reviewer-alternate'] },
  };
  config.delegation!.qualityReview = { route: 'reviewers', complexities: ['low'] };
  const jobStore = new MemoryJobStore();
  const jobs = new Orchestrator({
    config,
    store: jobStore,
    adapters: new Map([[adapter.name, adapter]]),
  });
  const orchestrations = new OrchestrationService({
    config: config.delegation!,
    jobs,
    store: new MemoryOrchestrationStore(),
  });

  const record = await orchestrations.run({
    prompt: 'Produce and review one bounded file through replaceable role pools.',
    workspace,
    assessment: adapter.assessment,
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.children.length, 1);
  if (record.qualityReview?.status !== 'completed') assert.fail('quality review should complete');
  assert.equal(record.qualityReview.route, 'reviewers');
  const reviewer = await jobs.get(record.qualityReview.reviewerJobId);
  assert.equal(reviewer?.request.route, 'reviewers');
  assert.equal(reviewer?.routePoolSelection?.pool, 'reviewers');
  assert.equal(reviewer?.routePoolSelection?.selectedRoute, reviewer?.route.name);
});

test('OrchestrationService runs one advisory reviewer after one valid low-complexity patch', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-quality-review-');
  const lowAssessment = singleQualityReviewAssessment('Produce reviewed file.');
  const adapter = new ArtifactWritingAdapter(
    lowAssessment,
    new Map([['Produce reviewed file.', ['reviewed.ts']]])
  );
  const { jobStore, orchestrations, orchestrationStore } = createServices(
    adapter,
    2,
    1,
    1,
    undefined,
    true
  );

  const record = await orchestrations.run({
    prompt: 'Add the bounded reviewed file and verify it.',
    workspace,
    assessment: lowAssessment,
    source: 'controller-test',
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.children.length, 1);
  assert.equal(adapter.reviewerRuns, 1);
  assert.equal(record.qualityReview?.status, 'completed');
  if (record.qualityReview?.status !== 'completed') assert.fail('quality review should complete');
  assert.equal(record.qualityReview.route, 'reviewer');
  assert.equal(record.qualityReview.childJobId, record.children[0]?.jobId);
  assert.equal(record.qualityReview.verdict, 'accept');
  assert.deepEqual(record.qualityReview.findings, []);
  const reviewerJobId = record.qualityReview.reviewerJobId;
  assert.equal(record.result?.children.length, 1);
  assert.equal(
    record.events.findIndex((event) => event.type === 'orchestration.child.completed') <
      record.events.findIndex((event) => event.type === 'orchestration.review.started'),
    true
  );
  assert.equal(
    record.events.findIndex((event) => event.type === 'orchestration.review.completed') <
      record.events.findIndex((event) => event.type === 'orchestration.succeeded'),
    true
  );
  const jobs = await jobStore.list();
  assert.equal(jobs.length, 2);
  const reviewer = jobs.find((job) => job.id === reviewerJobId);
  assert.ok(reviewer);
  assert.equal(reviewer.request.route, 'reviewer');
  assert.equal(reviewer.request.source, 'controller-test');
  assert.match(reviewer.request.prompt, /Worker completion\/test claims \(unverified\)/);
  assert.match(reviewer.request.prompt, /diff --git a\/reviewed\.ts b\/reviewed\.ts/);
  const provenance = reviewer.request.metadata?.agentknotDelegation as Record<string, unknown>;
  assert.equal(provenance.role, 'reviewer');
  assert.equal(provenance.depth, 1);
  assert.equal(provenance.childJobId, record.children[0]?.jobId);
  assert.deepEqual(await orchestrationStore.get(record.id), record);
  assert.equal(await gitStatus(workspace), '');
});

test('OrchestrationService runs controller-owned artifact validation concurrently with review', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-artifact-validation-');
  const coordination = await mkdtemp(path.join(os.tmpdir(), 'agentknot-validation-coordination-'));
  const validationMarker = path.join(coordination, 'validation-started');
  const reviewerMarker = path.join(coordination, 'reviewer-started');
  const adapter = new CoordinatedReviewerAdapter(
    singleQualityReviewAssessment('Write reviewed.ts.'),
    validationMarker,
    reviewerMarker
  );
  const script = [
    "const fs=require('node:fs')",
    `fs.writeFileSync(${JSON.stringify(validationMarker)},'started\\n')`,
    'const deadline=Date.now()+1000',
    `;(function check(){if(fs.existsSync(${JSON.stringify(reviewerMarker)}))process.exit(0);if(Date.now()>deadline)process.exit(8);setTimeout(check,5)})()`,
  ].join(';');
  const { orchestrations, orchestrationStore } = createServices(
    adapter,
    2,
    1,
    1,
    undefined,
    true,
    {
      argv: [process.execPath, '-e', script],
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    }
  );

  const record = await orchestrations.run({
    prompt: 'Write, validate, and independently review the target.',
    workspace,
    assessment: adapter.assessment,
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.qualityReview?.status, 'completed');
  assert.equal(record.artifactValidation?.status, 'completed');
  if (record.artifactValidation?.status !== 'completed') {
    assert.fail('artifact validation should complete');
  }
  assert.equal(record.artifactValidation.outcome, 'passed');
  assert.equal(record.artifactValidation.command.outcome, 'passed');
  assert.equal(record.artifactValidation.command.argv[0], process.execPath);
  assert.equal(record.artifactValidation.cleanup, 'cleaned');
  assert.equal(
    record.events.findIndex(
      (event) => event.type === 'orchestration.artifact-validation.started'
    ) <
      record.events.findIndex(
        (event) => event.type === 'orchestration.artifact-validation.completed'
      ),
    true
  );
  assert.equal(
    record.events.findIndex(
      (event) => event.type === 'orchestration.artifact-validation.completed'
    ) < record.events.findIndex((event) => event.type === 'orchestration.succeeded'),
    true
  );
  assert.deepEqual(await orchestrationStore.get(record.id), record);
  assert.equal(await gitStatus(workspace), '');
});

test('OrchestrationService keeps a failed validation command as advisory evidence', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-artifact-validation-failed-');
  const adapter = new ArtifactWritingAdapter(
    singleQualityReviewAssessment('Write failed-validation.ts.'),
    new Map([['Write failed-validation.ts.', ['failed-validation.ts']]])
  );
  const { orchestrations } = createServices(adapter, 1, 1, 1, undefined, false, {
    argv: [process.execPath, '-e', "process.stderr.write('validation failed'); process.exit(6)"],
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  });

  const record = await orchestrations.run({ prompt: 'Produce a failing validation target.', workspace, assessment: adapter.assessment });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.artifactValidation?.status, 'completed');
  if (record.artifactValidation?.status !== 'completed') {
    assert.fail('artifact validation should complete with a failed outcome');
  }
  assert.equal(record.artifactValidation.outcome, 'failed');
  assert.equal(record.artifactValidation.command.outcome, 'failed');
  assert.equal(record.artifactValidation.command.exitCode, 6);
  assert.equal(record.artifactValidation.command.stderr, 'validation failed');
  assert.equal(record.children[0]?.status, 'succeeded');
  assert.equal(await gitStatus(workspace), '');
});

test('OrchestrationService cancellation awaits artifact validation cleanup', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-artifact-validation-cancel-');
  const markerDirectory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-validation-cancel-'));
  const marker = path.join(markerDirectory, 'started');
  const adapter = new ArtifactWritingAdapter(
    singleQualityReviewAssessment('Write cancellable-validation.ts.'),
    new Map([['Write cancellable-validation.ts.', ['cancellable-validation.ts']]])
  );
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started\\n');setInterval(()=>{},1000)`;
  const { orchestrations } = createServices(adapter, 1, 1, 1, undefined, false, {
    argv: [process.execPath, '-e', script],
    timeoutMs: 2_000,
    maxOutputBytes: 1_024,
  });
  const started = await orchestrations.start({
    prompt: 'Produce and validate a cancellable target.',
    workspace,
    assessment: adapter.assessment,
  });
  let commandStarted = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    commandStarted = await stat(marker).then(
      () => true,
      () => false
    );
    if (commandStarted) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(commandStarted, true);

  await started.cancel();
  const record = await started.completion;

  assert.equal(record.status, 'cancelled');
  assert.equal(record.artifactValidation?.status, 'unavailable');
  if (record.artifactValidation?.status !== 'unavailable') {
    assert.fail('artifact validation should be unavailable after cancellation');
  }
  assert.equal(record.artifactValidation.reason, 'parent-cancelled');
  assert.equal(record.artifactValidation.cleanup, 'cleaned');
  assert.equal(record.artifactValidation.command?.outcome, 'cancelled');
  assert.equal(
    record.events.findIndex(
      (event) => event.type === 'orchestration.artifact-validation.unavailable'
    ) < record.events.findIndex((event) => event.type === 'orchestration.cancelled'),
    true
  );
  assert.equal(await gitStatus(workspace), '');
});

test('OrchestrationService keeps malformed reviewer output advisory and does not fall back', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-quality-review-invalid-');
  const lowAssessment = singleQualityReviewAssessment('Produce invalid review target.');
  const adapter = new ArtifactWritingAdapter(
    lowAssessment,
    new Map([['Produce invalid review target.', ['target.ts']]]),
    'not reviewer JSON'
  );
  const { jobStore, orchestrations } = createServices(adapter, 2, 1, 1, undefined, true);

  const record = await orchestrations.run({ prompt: 'Produce one reviewed target.', workspace, assessment: lowAssessment });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.result?.action, 'delegated');
  assert.equal(record.qualityReview?.status, 'unavailable');
  if (record.qualityReview?.status !== 'unavailable') assert.fail('review should be unavailable');
  assert.equal(record.qualityReview.reason, 'reviewer-output-invalid');
  assert.equal(adapter.reviewerRuns, 1);
  assert.equal(
    (await jobStore.list()).filter(
      (job) =>
        (job.request.metadata?.agentknotDelegation as Record<string, unknown> | undefined)?.role ===
        'reviewer'
    ).length,
    1
  );
  assert.equal(await gitStatus(workspace), '');
});

test('OrchestrationService preserves success when the advisory reviewer requests changes', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-quality-review-changes-');
  const lowAssessment = singleQualityReviewAssessment('Produce change-request target.');
  const adapter = new ArtifactWritingAdapter(
    lowAssessment,
    new Map([['Produce change-request target.', ['target.ts']]]),
    JSON.stringify({
      schemaVersion: 1,
      verdict: 'changes-requested',
      summary: 'The patch misses one stated behavior.',
      findings: [
        { severity: 'high', message: 'Required behavior is absent.', evidence: 'The patch adds only a placeholder.' },
      ],
    })
  );
  const { orchestrations } = createServices(adapter, 2, 1, 1, undefined, true);

  const record = await orchestrations.run({ prompt: 'Produce a target for advisory review.', workspace, assessment: lowAssessment });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.result?.action, 'delegated');
  assert.equal(record.qualityReview?.status, 'completed');
  if (record.qualityReview?.status !== 'completed') assert.fail('review should complete');
  assert.equal(record.qualityReview.verdict, 'changes-requested');
  assert.equal(record.qualityReview.findings.length, 1);
  assert.equal(await gitStatus(workspace), '');
});

test('OrchestrationService explicitly skips configured review for an empty patch', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-quality-review-empty-');
  const adapter = new PlannerAndWorkerAdapter(singleQualityReviewAssessment('Inspect without editing.'));
  const { orchestrations } = createServices(adapter, 2, 1, 1, undefined, true);

  const record = await orchestrations.run({ prompt: 'Produce an empty artifact.', workspace, assessment: adapter.assessment });

  assert.deepEqual(record.qualityReview, {
    status: 'skipped',
    route: 'reviewer',
    reason: 'artifact-empty',
  });
  assert.equal(adapter.reviewerRuns, 0);
  assert.equal(await gitStatus(workspace), '');
});

test('OrchestrationService explicitly skips configured review for multiple children', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-quality-review-multiple-');
  const lowMultiple: TaskAssessment = {
    ...assessment,
    complexity: 'low',
  };
  const adapter = new ArtifactWritingAdapter(
    lowMultiple,
    new Map([
      ['Review the tests', ['review.ts']],
      ['Update documentation', ['documentation.ts']],
    ])
  );
  const { orchestrations } = createServices(adapter, 2, 1, 2, undefined, true);

  const record = await orchestrations.run({ prompt: 'Produce two independent artifacts.', workspace, assessment: lowMultiple });

  assert.equal(record.status, 'succeeded');
  assert.deepEqual(record.qualityReview, {
    status: 'skipped',
    route: 'reviewer',
    reason: 'child-count-not-one',
  });
  assert.equal(adapter.reviewerRuns, 0);
  assert.equal(await gitStatus(workspace), '');
});

test('OrchestrationService cancels and awaits a running advisory reviewer', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-quality-review-cancel-');
  const lowAssessment = singleQualityReviewAssessment('Write reviewed.ts.');
  const adapter = new BlockingReviewerAdapter(lowAssessment);
  const { jobStore, orchestrations } = createServices(adapter, 2, 1, 1, undefined, true);
  const started = await orchestrations.start({ prompt: 'Write and review the target.', workspace, assessment: lowAssessment });
  await adapter.reviewerStarted;

  await started.cancel();
  const record = await started.completion;

  assert.equal(record.status, 'cancelled');
  assert.equal(record.qualityReview?.status, 'unavailable');
  if (record.qualityReview?.status !== 'unavailable') assert.fail('review should be unavailable');
  assert.equal(record.qualityReview.reason, 'parent-cancelled');
  const reviewer = await jobStore.get(adapter.reviewerJobId!);
  assert.equal(reviewer?.status, 'cancelled');
  assert.equal(
    record.events.findIndex((event) => event.type === 'orchestration.review.unavailable') <
      record.events.findIndex((event) => event.type === 'orchestration.cancelled'),
    true
  );
  assert.equal(await gitStatus(workspace), '');
});

test('OrchestrationService flags deterministic child artifact path overlaps', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-artifact-overlap-');
  const overlapAssessment: TaskAssessment = {
    ...assessment,
    taskKinds: ['test-gap-analysis'],
    subtasks: [
      {
        title: 'First artifact',
        kind: 'test-gap-analysis',
        prompt: 'Produce first artifact.',
        acceptanceCriteria: ['First artifact is captured'],
      },
      {
        title: 'Second artifact',
        kind: 'test-gap-analysis',
        prompt: 'Produce second artifact.',
        acceptanceCriteria: ['Second artifact is captured'],
      },
      {
        title: 'Third artifact',
        kind: 'test-gap-analysis',
        prompt: 'Produce third artifact.',
        acceptanceCriteria: ['Third artifact is captured'],
      },
    ],
  };
  const adapter = new ArtifactWritingAdapter(
    overlapAssessment,
    new Map([
      ['Produce first artifact.', ['first.ts', 'shared-a.ts', 'shared-b.ts']],
      ['Produce second artifact.', ['second.ts', 'shared-a.ts', 'shared-b.ts']],
      ['Produce third artifact.', ['third.ts', 'shared-b.ts']],
    ])
  );
  const { orchestrations, orchestrationStore } = createServices(adapter, 3, 1, 3);

  const record = await orchestrations.run({ prompt: 'Produce three isolated artifacts.', workspace, assessment: overlapAssessment });
  const subtaskIds = record.plan?.subtasks.map((subtask) => subtask.id);
  assert.ok(subtaskIds);
  assert.deepEqual(record.result?.artifactReview, {
    status: 'checked',
    conflicts: [
      { path: 'shared-a.ts', subtaskIds: subtaskIds.slice(0, 2) },
      { path: 'shared-b.ts', subtaskIds },
    ],
    unavailable: [],
  });
  assert.deepEqual((await orchestrationStore.get(record.id))?.result?.artifactReview, record.result?.artifactReview);
  assert.equal((await execFileAsync('git', ['status', '--short'], { cwd: workspace })).stdout, '');
});

test('OrchestrationService marks missing terminal child evidence as incomplete', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-artifact-incomplete-');
  const adapter = new PlannerAndWorkerAdapter(assessment);
  const { jobs, orchestrations } = createServices(adapter, 2);
  const getJob = jobs.get.bind(jobs);
  jobs.get = async (id) => {
    const job = await getJob(id);
    if (
      job?.status === 'succeeded' &&
      (job.request.metadata?.agentknotDelegation as Record<string, unknown> | undefined)?.role ===
        'worker' &&
      job.request.prompt.includes('Update documentation')
    ) {
      const legacy = structuredClone(job);
      delete legacy.completionSummary;
      return legacy;
    }
    return job;
  };

  const record = await orchestrations.run({ prompt: 'Review incomplete evidence.', workspace, assessment });
  const unavailableChild = record.children.find((child) => {
    const subtask = record.plan?.subtasks.find((candidate) => candidate.id === child.subtaskId);
    return subtask?.prompt.includes('Update documentation');
  });
  assert.ok(unavailableChild);
  assert.deepEqual(record.result?.artifactReview, {
    status: 'incomplete',
    conflicts: [],
    unavailable: [
      {
        subtaskId: unavailableChild.subtaskId,
        jobId: unavailableChild.jobId,
        reason: 'completion-summary-unavailable',
      },
    ],
  });
});

test('OrchestrationService keeps shadow suggestions out of child route authority and preserves metadata', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-shadow-route-');
  const adapter = new PlannerAndWorkerAdapter(assessment);
  const routeSelection: RouteSelectionConfig = {
    mode: 'shadow',
    rules: [
      { route: 'alternate', taskKinds: ['test-gap-analysis'] },
      { route: 'alternate', complexities: ['medium'] },
      { route: 'worker' },
    ],
  };
  const { jobStore, orchestrations } = createServices(adapter, 2, 1, 2, routeSelection);

  const record = await orchestrations.run({
    prompt: 'Review the tests and update the documentation.',
    workspace,
    assessment,
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.plan?.willDispatch, true);
  assert.equal(record.plan?.subtasks.every((subtask) => subtask.route === 'worker'), true);
  assert.deepEqual(
    record.plan?.subtasks.map((subtask) => subtask.routeSelection),
    [
      { mode: 'shadow', suggestedRoute: 'alternate', basis: 'rule', ruleIndex: 0 },
      { mode: 'shadow', suggestedRoute: 'alternate', basis: 'rule', ruleIndex: 1 },
    ]
  );
  assert.deepEqual(
    record.events
      .filter((event) => event.type === 'orchestration.child.started')
      .map((event) => event.data?.route),
    ['worker', 'worker']
  );

  const childJobs = (await jobStore.list()).filter(
    (job) => (job.request.metadata?.agentknotDelegation as Record<string, unknown> | undefined)?.role === 'worker'
  );
  assert.equal(childJobs.length, 2);
  for (const childJob of childJobs) {
    const reloadedChildJob = await jobStore.get(childJob.id);
    assert.ok(reloadedChildJob);
    assert.equal(reloadedChildJob.request.route, 'worker');
    assert.equal(reloadedChildJob.route.name, 'worker');
    assert.equal(reloadedChildJob.route.model, 'worker');
    const metadata = reloadedChildJob.request.metadata?.agentknotDelegation as Record<string, unknown>;
    const subtaskId = metadata.subtaskId;
    const plan: DelegationPlan | undefined = record.plan;
    assert.ok(plan);
    const matchedSubtask: PlannedSubtask | undefined = plan.subtasks.find(
      (candidate: PlannedSubtask) => candidate.id === subtaskId
    );
    assert.ok(matchedSubtask);
    assert.equal(metadata.taskKind, matchedSubtask.kind);
    assert.equal(metadata.parentComplexity, 'medium');
    assert.deepEqual(metadata.routeSelection, matchedSubtask.routeSelection);
  }
});

test('OrchestrationService dispatches the exact human-configured active route', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-active-route-');
  const adapter = new PlannerAndWorkerAdapter(assessment);
  const routeSelection: RouteSelectionConfig = {
    mode: 'active',
    rules: [{ route: 'alternate', complexities: ['medium'] }],
  };
  const { jobStore, orchestrations } = createServices(adapter, 2, 1, 2, routeSelection);

  const record = await orchestrations.run({
    prompt: 'Run the configured medium-complexity route.',
    workspace,
    assessment,
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.plan?.subtasks.every((subtask) => subtask.route === 'alternate'), true);
  assert.deepEqual(
    record.plan?.subtasks.map((subtask) => subtask.routeSelection),
    [
      { mode: 'active', selectedRoute: 'alternate', basis: 'rule', ruleIndex: 0 },
      { mode: 'active', selectedRoute: 'alternate', basis: 'rule', ruleIndex: 0 },
    ]
  );
  assert.deepEqual(
    record.events
      .filter((event) => event.type === 'orchestration.child.started')
      .map((event) => event.data?.route),
    ['alternate', 'alternate']
  );

  const childJobs = (await jobStore.list()).filter(
    (job) => (job.request.metadata?.agentknotDelegation as Record<string, unknown> | undefined)?.role === 'worker'
  );
  assert.equal(childJobs.length, 2);
  for (const child of childJobs) {
    assert.equal(child.request.route, 'alternate');
    assert.equal(child.route.name, 'alternate');
    assert.equal(child.route.model, 'alternate');
    const metadata = child.request.metadata?.agentknotDelegation as Record<string, unknown>;
    assert.deepEqual(metadata.routeSelection, {
      mode: 'active',
      selectedRoute: 'alternate',
      basis: 'rule',
      ruleIndex: 0,
    });
  }
});

test('OrchestrationService suggest mode persists a plan without dispatching worker jobs', async () => {
  const workspace = await createGitWorkspace('agentknot-suggest-');
  const adapter = new PlannerAndWorkerAdapter(assessment);
  const routeSelection: RouteSelectionConfig = {
    mode: 'shadow',
    rules: [
      { route: 'alternate', taskKinds: ['test-gap-analysis'] },
      { route: 'alternate', complexities: ['medium'] },
      { route: 'worker' },
    ],
  };
  const { jobStore, orchestrations } = createServices(adapter, 2, 1, 2, routeSelection);

  const record = await orchestrations.run({
    prompt: 'Suggest a delegation plan.',
    workspace,
    assessment,
    delegation: 'suggest',
  });

  assert.equal(record.status, 'succeeded');
  assert.equal(record.plan?.mode, 'suggest');
  assert.equal(record.plan?.willDispatch, false);
  assert.deepEqual(
    record.plan?.subtasks.map((subtask) => subtask.routeSelection),
    [
      { mode: 'shadow', suggestedRoute: 'alternate', basis: 'rule', ruleIndex: 0 },
      { mode: 'shadow', suggestedRoute: 'alternate', basis: 'rule', ruleIndex: 1 },
    ]
  );
  assert.equal(record.result?.action, 'suggested');
  assert.deepEqual(record.children, []);
  assert.equal(adapter.workerRuns, 0);
  assert.equal((await jobStore.list()).length, 0);
});

test('OrchestrationService rejects a missing controller assessment before record admission', async () => {
  const workspace = await createGitWorkspace('agentknot-missing-assessment-');
  const adapter = new PlannerAndWorkerAdapter(assessment);
  const { jobStore, orchestrations, orchestrationStore } = createServices(adapter);

  await assert.rejects(
    orchestrations.start({ prompt: 'Assessment is required.', workspace } as OrchestrationRequest),
    /Orchestration controller assessment is required/
  );
  assert.equal((await jobStore.list()).length, 0);
  assert.equal((await orchestrationStore.list()).length, 0);
});

test('OrchestrationService rejects a malformed controller assessment before record admission', async () => {
  const workspace = await createGitWorkspace('agentknot-malformed-assessment-');
  const adapter = new PlannerAndWorkerAdapter(assessment);
  const { jobStore, orchestrations, orchestrationStore } = createServices(adapter);
  const malformedAssessment = {
    ...assessment,
    subtasks: assessment.subtasks.map((subtask, index) => {
      if (index !== 1) return subtask;
      const { acceptanceCriteria: _acceptanceCriteria, ...rest } = subtask;
      return rest;
    }),
  };

  await assert.rejects(
    orchestrations.start({
      prompt: 'Reject incomplete controller handoff.',
      workspace,
      assessment: malformedAssessment as unknown as TaskAssessment,
    }),
    /Controller assessment subtasks\[1\].*missing: acceptanceCriteria/
  );
  assert.equal((await jobStore.list()).length, 0);
  assert.equal((await orchestrationStore.list()).length, 0);
});

test('OrchestrationService cancellation stops active child jobs and does not launch more work', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-cancel-');
  const adapter = new PlannerAndWorkerAdapter(assessment, 1_000);
  const { orchestrations } = createServices(adapter);

  const started = await orchestrations.start({ prompt: 'Run delegated work.', workspace, assessment });
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

test('OrchestrationService cancellation removes a child blocked on the shared dispatch semaphore', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-blocked-cancel-');
  const adapter = new BlockingWorkerAdapter();
  const { jobStore, orchestrations, orchestrationStore } = createServices(adapter, 1);

  const first = await orchestrations.start({ prompt: 'Hold the worker slot.', workspace, assessment });
  await adapter.workerStarted;

  const second = await orchestrations.start({ prompt: 'Wait for the worker slot.', workspace, assessment });
  await waitFor(
    async () => {
      const record = await orchestrationStore.get(second.orchestration.id);
      return record?.events.some((event) => event.type === 'orchestration.handoff.accepted') === true;
    },
    'the second orchestration to accept the handoff'
  );
  assert.equal((await jobStore.list()).length, 1, 'the blocked child must not be admitted');

  await second.cancel();
  const cancelled = await second.completion;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.children.length, 0);
  assert.equal(cancelled.events.at(-1)?.type, 'orchestration.cancelled');
  assert.equal((await jobStore.list()).length, 1, 'cancelling a semaphore waiter must not start a job');
  assert.equal(adapter.activeRuns, 1, 'the first child remains the only active execution');

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
    assessment,
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
    orchestrations.run({ prompt: 'Review tests for request one.', workspace, assessment: oneChildAssessment }),
    orchestrations.run({ prompt: 'Review tests for request two.', workspace, assessment: oneChildAssessment }),
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
    assessment,
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
    assessment: pooledAssessment,
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
    assessment: { ...assessment, parallelizable: false },
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

test('OrchestrationService admits no child when handoff persistence fails', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-handoff-save-failure-');
  const adapter = new PlannerAndWorkerAdapter(assessment);
  const config = testConfig(1);
  const jobs = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: new Map([[adapter.name, adapter]]),
  });
  const store = new FailingOrchestrationStore(2);
  const orchestrations = new OrchestrationService({ config: config.delegation!, jobs, store });

  const record = await orchestrations.run({ prompt: 'Review persistence.', workspace, assessment });
  const jobsAfterFailure = await jobs.list();

  assert.equal(record.status, 'failed');
  assert.match(record.error?.message ?? '', /injected orchestration save failure/);
  assert.equal(jobsAfterFailure.length, 0);
  assert.equal(adapter.activeRuns, 0);
  assert.equal(store.created?.events[0]?.type, 'orchestration.queued');
  assert.equal(store.created?.events[0]?.sequence, 1);
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
  const store = new FailingOrchestrationStore(3);
  const orchestrations = new OrchestrationService({ config: config.delegation!, jobs, store });

  const record = await orchestrations.run({ prompt: 'Review persistence.', workspace, assessment });
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

test('OrchestrationService aborts active work even when cancellation evidence cannot be saved', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-cancel-save-failure-');
  const adapter = new BlockingWorkerAdapter();
  const config = testConfig(1);
  const jobs = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: new Map([[adapter.name, adapter]]),
  });
  const store = new SwitchableOrchestrationStore();
  const orchestrations = new OrchestrationService({ config: config.delegation!, jobs, store });
  const started = await orchestrations.start({ prompt: 'Cancel despite persistence failure.', workspace, assessment });
  await adapter.workerStarted;

  store.failNextSave = true;
  await assert.rejects(started.cancel(), /injected cancellation save failure/);
  const record = await started.completion;

  assert.equal(record.status, 'cancelled');
  assert.equal(record.cancelRequestedAt, undefined);
  assert.equal(record.events.some((event) => event.type === 'orchestration.cancel.requested'), false);
  assert.equal(adapter.activeRuns, 0);
  assert.deepEqual(
    record.events.map((event) => event.sequence),
    Array.from({ length: record.events.length }, (_, index) => index + 1)
  );
});

test('OrchestrationService propagates child control-plane persistence failure without fabricating worker failure', async () => {
  const workspace = await createGitWorkspace('agentknot-orchestration-child-persistence-');
  const adapter = new ChildPersistenceFailureAdapter();
  const config = testConfig(1);
  const jobStore = new MemoryJobStore();
  const jobs = new Orchestrator({
    config,
    store: jobStore,
    adapters: new Map([[adapter.name, adapter]]),
  });
  const store = new MemoryOrchestrationStore();
  const orchestrations = new OrchestrationService({ config: config.delegation!, jobs, store });

  await assert.rejects(
    orchestrations.run({ prompt: 'Propagate child persistence.', workspace, assessment }),
    JobPersistenceError
  );
  const parent = (await store.list())[0]!;
  const child = (await jobStore.list()).find(
    (job) => (job.request.metadata?.agentknotDelegation as Record<string, unknown>)?.role === 'worker'
  );

  assert.equal(parent.status, 'dispatching');
  assert.equal(parent.children[0]?.status, 'running');
  assert.equal(parent.events.some((event) => event.type === 'orchestration.child.completed'), false);
  assert.equal(child?.status, 'running');
  assert.equal(child?.error, undefined);
});

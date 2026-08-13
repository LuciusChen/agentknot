import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import type { OrchestrationService } from '../src/orchestration.js';
import type { Orchestrator } from '../src/orchestrator.js';
import { AgentKnotRuntime, createRuntime } from '../src/runtime.js';
import type { RuntimeOwnership } from '../src/runtime-ownership.js';
import { FileOrchestrationStore } from '../src/orchestration-store.js';
import type { OrchestrationRecord, OrchestrationStatus } from '../src/orchestration-types.js';
import type { TaskAssessment } from '../src/orchestration-types.js';
import { FileJobStore } from '../src/store.js';
import type { JobRecord, JobStatus } from '../src/types.js';

function staleJob(id: string, status: Extract<JobStatus, 'queued' | 'running'>, workspace: string): JobRecord {
  const createdAt = '2026-08-08T01:00:00.000Z';
  const events = [
    {
      sequence: 1,
      jobId: id,
      at: createdAt,
      type: 'job.queued' as const,
      data: { source: 'test' },
    },
    ...(status === 'running'
      ? [
          {
            sequence: 2,
            jobId: id,
            at: '2026-08-08T01:00:01.000Z',
            type: 'job.started' as const,
            data: { route: 'mock', worker: 'mock', provider: 'mock', model: 'mock' },
          },
        ]
      : []),
  ];
  return {
    id,
    schemaVersion: 1,
    status,
    request: { prompt: 'stale task', workspace, source: 'test' },
    route: {
      name: 'mock',
      worker: 'mock',
      provider: 'mock',
      model: 'mock',
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 30_000,
    },
    createdAt,
    updatedAt: events.at(-1)?.at ?? createdAt,
    ...(status === 'running' ? { startedAt: '2026-08-08T01:00:01.000Z' } : {}),
    attempt: status === 'running' ? 1 : 0,
    events,
  };
}

function staleOrchestration(
  id: string,
  status: Extract<OrchestrationStatus, 'queued' | 'planning' | 'dispatching'>,
  workspace: string,
  pid: number
): OrchestrationRecord {
  const createdAt = '2026-08-08T01:00:00.000Z';
  const assessment: TaskAssessment = {
    schemaVersion: 1,
    recommendation: 'do-not-delegate',
    complexity: 'low',
    parallelizable: false,
    taskKinds: ['documentation'],
    reasoning: 'Controller-authored stale-orchestration fixture assessment.',
    subtasks: [],
  };
  return {
    id,
    schemaVersion: 1,
    status,
    request: { prompt: 'stale orchestration', workspace, assessment, source: 'test' },
    policy: {
      mode: 'off',
      dispatch: { defaultRoute: 'mock', maxChildren: 2, maxDepth: 1, maxConcurrency: 1 },
      policy: {
        delegate: ['documentation'],
        keepUpstream: ['product-decision', 'artifact-integration', 'commit', 'push'],
      },
    },
    createdAt,
    updatedAt: createdAt,
    execution: { runtimeId: 'runtime_stale', pid, startedAt: createdAt },
    events: [
      {
        sequence: 1,
        orchestrationId: id,
        at: createdAt,
        type: 'orchestration.queued',
        data: { source: 'test', mode: 'off' },
      },
    ],
    children: [],
  };
}

test('runtime close and shutdown track recovery before active Job registration', async () => {
  let recoverySignal: AbortSignal | undefined;
  let entered!: () => void;
  const recoveryEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const jobs = {
    async recoverInterruptedJobs(options: { signal?: AbortSignal }) {
      recoverySignal = options.signal;
      entered();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(options.signal?.reason ?? new Error('aborted'));
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
      return [];
    },
    hasActiveJobs: () => false,
    shutdown: async () => undefined,
  } as unknown as Orchestrator;
  const orchestrations = { shutdown: async () => undefined } as unknown as OrchestrationService;
  let ownershipClosed = false;
  const ownership = {
    assertHeld: () => undefined,
    close: async () => {
      ownershipClosed = true;
    },
  } as unknown as RuntimeOwnership;
  const runtime = new AgentKnotRuntime(jobs, orchestrations, { ownership });

  const recovery = runtime.recoverInterruptedJobs();
  await recoveryEntered;
  await assert.rejects(runtime.close(), /Cannot release runtime storage ownership while work is active/);
  await runtime.shutdown();
  await assert.rejects(recovery, /Runtime shutdown interrupted Job recovery/);
  assert.equal(recoverySignal?.aborted, true);
  await runtime.close();
  assert.equal(ownershipClosed, true);
});

test('runtime close cannot race an in-flight worker control operation', async () => {
  let controlEntered!: () => void;
  let finishControl!: () => void;
  const entered = new Promise<void>((resolve) => { controlEntered = resolve; });
  const pending = new Promise<void>((resolve) => { finishControl = resolve; });
  const jobs = {
    async control() {
      controlEntered();
      await pending;
      return undefined;
    },
    hasActiveJobs: () => false,
  } as unknown as Orchestrator;
  const orchestrations = {} as unknown as OrchestrationService;
  let ownershipClosed = false;
  const ownership = {
    assertHeld: () => undefined,
    close: async () => { ownershipClosed = true; },
  } as unknown as RuntimeOwnership;
  const runtime = new AgentKnotRuntime(jobs, orchestrations, { ownership });

  const control = runtime.controlJob('job_control', {
    schemaVersion: 1,
    controlId: 'control-close-race',
    attempt: 1,
    kind: 'steer',
    message: 'Keep the runtime ownership fence held.',
  });
  await entered;
  await assert.rejects(runtime.close(), /Cannot release runtime storage ownership while work is active/);
  finishControl();
  await control;
  await runtime.close();
  assert.equal(ownershipClosed, true);
});

test('exclusive createRuntime imports legacy state and fails unrecoverable historical parents explicitly', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-runtime-'));
  const storageDirectory = path.join(directory, 'jobs');
  const orchestrationStorageDirectory = path.join(directory, 'orchestrations');
  const configPath = path.join(directory, 'agentknot.config.json');
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        defaultRoute: 'mock',
        storage: { directory: 'jobs' },
        workers: { mock: { adapter: 'mock' } },
        routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
      },
      null,
      2
    )}\n`
  );
  const store = new FileJobStore(storageDirectory);
  const exitedProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(exitedProcess, 'spawn');
  const exitedPid = exitedProcess.pid;
  assert.ok(exitedPid);
  exitedProcess.kill();
  await once(exitedProcess, 'exit');
  await store.create(staleJob('job_stale_queued', 'queued', workspace));
  const staleRunning = staleJob('job_stale_running', 'running', workspace);
  staleRunning.execution = {
    runtimeId: 'runtime_exited',
    pid: exitedPid,
    startedAt: staleRunning.createdAt,
  };
  await store.create(staleRunning);
  const activeRunning = staleJob('job_active_running', 'running', workspace);
  activeRunning.execution = {
    runtimeId: 'runtime_active',
    pid: process.pid,
    startedAt: activeRunning.createdAt,
  };
  await store.create(activeRunning);
  const orchestrationStore = new FileOrchestrationStore(orchestrationStorageDirectory);
  const staleChild = staleJob('job_stale_child', 'running', workspace);
  staleChild.execution = {
    runtimeId: 'runtime_exited',
    pid: exitedPid,
    startedAt: staleChild.createdAt,
  };
  await store.create(staleChild);
  const staleParentRecord = staleOrchestration(
    'orchestration_stale',
    'dispatching',
    workspace,
    exitedPid
  );
  staleParentRecord.children = [
    {
      subtaskId: 'subtask_1',
      jobId: staleChild.id,
      planHash: 'a'.repeat(64),
      policyVersion: 1,
      status: 'running',
    },
  ];
  staleParentRecord.policy.qualityReview = { route: 'mock', complexities: ['low'] };
  staleParentRecord.qualityReview = {
    status: 'pending',
    route: 'mock',
    childJobId: staleChild.id,
    reviewerJobId: 'job_stale_reviewer',
  };
  staleParentRecord.policy.artifactValidation = {
    argv: [process.execPath, '-e', 'process.exit(0)'],
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  };
  staleParentRecord.artifactValidation = {
    status: 'pending',
    childJobId: staleChild.id,
    artifact: {
      attempt: 1,
      size: 1,
      sha256: 'b'.repeat(64),
      baseCommit: 'c'.repeat(40),
    },
  };
  await orchestrationStore.create(staleParentRecord);
  const staleQueuedParent = staleOrchestration(
    'orchestration_stale_queued',
    'queued',
    workspace,
    exitedPid
  );
  const stalePlanningParent = staleOrchestration(
    'orchestration_stale_planning',
    'planning',
    workspace,
    exitedPid
  );
  stalePlanningParent.cancelRequestedAt = '2026-08-08T01:00:02.000Z';
  await orchestrationStore.create(staleQueuedParent);
  await orchestrationStore.create(stalePlanningParent);
  const unchangedJobSnapshots = new Map(
    await Promise.all(
      ['job_stale_queued', 'job_stale_running', 'job_active_running', 'job_stale_child'].map(
        async (id) => [id, await readFile(path.join(storageDirectory, `${id}.json`))] as const
      )
    )
  );
  const unchangedOrchestrationSnapshots = new Map(
    await Promise.all(
      [staleParentRecord, staleQueuedParent, stalePlanningParent].map(
        async (record) => [
          record.id,
          await readFile(path.join(orchestrationStorageDirectory, `${record.id}.json`)),
        ] as const
      )
    )
  );
  const readOnlyRuntime = await createRuntime({ configPath, reconcileOnStartup: false });
  for (const [id, snapshot] of unchangedJobSnapshots) {
    assert.deepEqual(await readFile(path.join(storageDirectory, `${id}.json`)), snapshot);
  }
  for (const [id, snapshot] of unchangedOrchestrationSnapshots) {
    assert.deepEqual(
      await readFile(path.join(orchestrationStorageDirectory, `${id}.json`)),
      snapshot
    );
  }
  assert.equal((await readOnlyRuntime.get('job_stale_queued'))?.status, 'queued');
  assert.equal((await readOnlyRuntime.getOrchestration(staleParentRecord.id))?.status, 'dispatching');
  assert.equal((await readOnlyRuntime.getOrchestration(staleQueuedParent.id))?.status, 'queued');
  assert.equal((await readOnlyRuntime.getOrchestration(stalePlanningParent.id))?.status, 'planning');
  await assert.rejects(
    async () => readOnlyRuntime.run({ prompt: 'must remain read only', workspace }),
    /created for read-only access/
  );

  const observed: string[] = [];

  const runtime = await createRuntime({
    configPath,
    onEvent: (event) => {
      observed.push(event.type);
    },
  });

  const recoveredQueued = await runtime.waitForJob('job_stale_queued', 500);
  assert.equal(recoveredQueued?.status, 'failed');
  assert.equal(recoveredQueued?.attempt, 0);
  assert.equal(recoveredQueued?.error?.name, 'RecoverySnapshotUnavailableError');
  assert.equal(recoveredQueued?.events.at(-1)?.data?.reason, 'workspace-snapshot-unavailable');

  for (const id of [
    'job_stale_running',
    'job_active_running',
    'job_stale_child',
  ] as const) {
    const job = await runtime.get(id);
    assert.equal(job?.status, 'failed');
    assert.equal(job?.error?.name, 'ExecutionLeaseLostError');
    assert.equal(job?.error?.retryable, false);
    assert.equal(job?.completedAt, job?.updatedAt);
    assert.equal(job?.completionSummary?.outcome, 'failed');
    assert.deepEqual(job?.completionSummary?.workerReported, {
      status: 'unavailable',
      reason: 'not-retained',
    });
    assert.deepEqual(job?.attemptUsage, [
      { attempt: 1, usage: { unavailableReason: 'worker-failure' } },
    ]);
    assert.equal(job?.events.at(-2)?.type, 'job.attempt.lost');
    assert.equal(job?.events.at(-2)?.data?.reason, 'lease-expired');
    assert.equal(job?.events.at(-2)?.data?.retryable, false);
    assert.equal(job?.events.at(-1)?.sequence, 4);
    assert.equal(job?.events.at(-1)?.type, 'job.failed');
    assert.equal(job?.events.at(-1)?.data?.reason, 'recovery-attempts-exhausted');
    assert.equal(job?.events.at(-1)?.data?.attempt, 1);
  }
  assert.equal(observed.includes('job.recovery.started'), false);
  assert.ok(observed.includes('job.attempt.lost'));
  const staleParent = await runtime.getOrchestration('orchestration_stale');
  assert.equal(staleParent?.status, 'failed');
  assert.equal(staleParent?.error?.name, 'RecoveryStateError');
  assert.equal(staleParent?.events.at(-1)?.type, 'orchestration.failed');
  assert.equal(staleParent?.events.at(-1)?.data?.reason, 'recovery-state-unavailable');
  assert.equal(staleParent?.children[0]?.status, 'failed');
  assert.equal(staleParent?.children[0]?.error?.name, 'ExecutionLeaseLostError');
  assert.deepEqual(staleParent?.qualityReview, {
    status: 'unavailable',
    route: 'mock',
    childJobId: staleChild.id,
    reviewerJobId: 'job_stale_reviewer',
    reason: 'runtime-restart',
  });
  assert.deepEqual(staleParent?.artifactValidation, {
    status: 'unavailable',
    childJobId: staleChild.id,
    artifact: {
      attempt: 1,
      size: 1,
      sha256: 'b'.repeat(64),
      baseCommit: 'c'.repeat(40),
    },
    reason: 'runtime-restart',
    cleanup: 'not-confirmed',
  });
  assert.equal(staleParent?.events.at(-3)?.type, 'orchestration.review.unavailable');
  assert.equal(
    staleParent?.events.at(-2)?.type,
    'orchestration.artifact-validation.unavailable'
  );
  for (const [id, previousStatus] of [
    [staleQueuedParent.id, 'queued'],
    [stalePlanningParent.id, 'planning'],
  ] as const) {
    const parent = await runtime.getOrchestration(id);
    assert.equal(parent?.status, 'failed');
    assert.equal(parent?.error?.name, 'RecoveryStateError');
    assert.equal(parent?.events.at(-1)?.type, 'orchestration.failed');
    assert.equal(parent?.events.at(-1)?.data?.previousStatus, previousStatus);
    assert.equal(parent?.events.at(-1)?.data?.reason, 'recovery-state-unavailable');
  }
  assert.equal(
    (await runtime.getOrchestration(stalePlanningParent.id))?.cancelRequestedAt,
    stalePlanningParent.cancelRequestedAt,
    'runtime interruption remains the terminal outcome while preserving prior cancellation intent'
  );

  const admission = runtime.start({ prompt: 'owner remains held during work', workspace });
  await assert.rejects(runtime.close(), /Cannot release runtime storage ownership while work is active/);
  const ownedJob = await admission;
  const terminalJob = await ownedJob.completion;
  assert.equal(terminalJob.status, 'succeeded');
  assert.equal(terminalJob.route.name, 'mock');
  assert.equal(terminalJob.route.worker, 'mock');
  const startedEvent = terminalJob.events.find((event) => event.type === 'job.started');
  assert.ok(startedEvent);
  assert.deepEqual(startedEvent.data, {
    route: 'mock',
    worker: 'mock',
    provider: 'mock',
    model: 'mock',
  });

  const queuedAfterFirstRecovery = await runtime.get('job_stale_queued');
  const parentAfterFirstRecovery = new Map(
    await Promise.all(
      [staleParentRecord.id, staleQueuedParent.id, stalePlanningParent.id].map(
        async (id) => [id, await runtime.getOrchestration(id)] as const
      )
    )
  );
  await assert.rejects(
    createRuntime({ configPath }),
    /Another execution-owning AgentKnot runtime already owns storage directory/
  );
  await runtime.close();
  const secondRuntime = await createRuntime({ configPath });
  try {
    const queuedAfterSecondRecovery = await secondRuntime.get('job_stale_queued');
    assert.deepEqual(queuedAfterSecondRecovery, queuedAfterFirstRecovery);
    assert.equal((await secondRuntime.get('job_active_running'))?.status, 'failed');
    assert.deepEqual(
      await secondRuntime.getOrchestration('orchestration_stale'),
      staleParent
    );
    for (const id of [staleQueuedParent.id, stalePlanningParent.id]) {
      assert.deepEqual(
        await secondRuntime.getOrchestration(id),
        parentAfterFirstRecovery.get(id)
      );
    }
  } finally {
    await secondRuntime.close();
  }
});

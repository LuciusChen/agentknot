import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { createRuntime } from '../src/runtime.js';
import { FileOrchestrationStore } from '../src/orchestration-store.js';
import type { OrchestrationRecord, OrchestrationStatus } from '../src/orchestration-types.js';
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
  return {
    id,
    schemaVersion: 1,
    status,
    request: { prompt: 'stale orchestration', workspace, source: 'test' },
    policy: {
      mode: 'off',
      planner: { strategy: 'hybrid', route: 'mock' },
      dispatch: { defaultRoute: 'mock', maxChildren: 2, maxDepth: 1, maxConcurrency: 1 },
      policy: {
        delegate: ['documentation'],
        keepUpstream: ['product-decision', 'artifact-integration', 'commit', 'push'],
      },
      fallback: 'upstream',
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

test('exclusive createRuntime fails every prior nonterminal record once without replay', async () => {
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

  for (const [id, previousStatus, expectedSequence] of [
    ['job_stale_queued', 'queued', 2],
    ['job_stale_running', 'running', 3],
    ['job_active_running', 'running', 3],
    ['job_stale_child', 'running', 3],
  ] as const) {
    const job = await runtime.get(id);
    assert.equal(job?.status, 'failed');
    assert.equal(job?.error?.name, 'ExecutionInterruptedError');
    assert.equal(job?.error?.retryable, false);
    assert.equal(job?.completedAt, job?.updatedAt);
    assert.equal(job?.completionSummary?.outcome, 'failed');
    assert.deepEqual(job?.completionSummary?.workerReported, {
      status: 'unavailable',
      reason: 'not-retained',
    });
    assert.equal(job?.events.at(-1)?.sequence, expectedSequence);
    assert.equal(job?.events.at(-1)?.type, 'job.failed');
    assert.deepEqual(job?.events.at(-1)?.data, {
      name: 'ExecutionInterruptedError',
      message: 'A new AgentKnot runtime found this job without a terminal state; the previous execution cannot be resumed',
      attempt: previousStatus === 'running' ? 1 : 0,
      reason: 'runtime_restart',
      previousStatus,
    });
  }
  assert.deepEqual(observed, []);
  const staleParent = await runtime.getOrchestration('orchestration_stale');
  assert.equal(staleParent?.status, 'failed');
  assert.equal(staleParent?.error?.name, 'ExecutionInterruptedError');
  assert.equal(staleParent?.events.at(-1)?.type, 'orchestration.failed');
  assert.equal(staleParent?.events.at(-1)?.data?.reason, 'runtime_restart');
  assert.equal(staleParent?.children[0]?.status, 'failed');
  assert.equal(staleParent?.children[0]?.error?.name, 'ExecutionInterruptedError');
  for (const [id, previousStatus] of [
    [staleQueuedParent.id, 'queued'],
    [stalePlanningParent.id, 'planning'],
  ] as const) {
    const parent = await runtime.getOrchestration(id);
    assert.equal(parent?.status, 'failed');
    assert.equal(parent?.error?.name, 'ExecutionInterruptedError');
    assert.equal(parent?.events.at(-1)?.type, 'orchestration.failed');
    assert.equal(parent?.events.at(-1)?.data?.previousStatus, previousStatus);
    assert.equal(parent?.events.at(-1)?.data?.reason, 'runtime_restart');
  }
  assert.equal(
    (await runtime.getOrchestration(stalePlanningParent.id))?.cancelRequestedAt,
    stalePlanningParent.cancelRequestedAt,
    'runtime interruption remains the terminal outcome while preserving prior cancellation intent'
  );

  const admission = runtime.start({ prompt: 'owner remains held during work', workspace });
  await assert.rejects(runtime.close(), /Cannot release runtime storage ownership while work is active/);
  const ownedJob = await admission;
  assert.equal((await ownedJob.completion).status, 'succeeded');

  const queuedAfterFirstRecovery = await runtime.get('job_stale_queued');
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
        await runtime.getOrchestration(id)
      );
    }
  } finally {
    await secondRuntime.close();
  }
});

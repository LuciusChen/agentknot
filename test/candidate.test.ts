import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CandidateService,
  SqliteCandidateStore,
  SqliteDurableRecordStore,
  SqliteJobStore,
  SqliteWorkOrderStore,
  WorkOrderService,
  type CandidateRecord,
  type JobRecord,
  type WorkOrderCommand,
} from '../src/index.js';

const CREATED_AT = new Date('2026-08-14T01:02:03.000Z');
const ARTIFACT = {
  path: '/tmp/agentknot-artifacts/job_executor/attempt-1.patch',
  sha256: 'a'.repeat(64),
  baseCommit: 'b'.repeat(40),
};

function command(workspace: string): WorkOrderCommand {
  return {
    objective: 'Create one candidate record',
    workspace,
    acceptanceCriteria: ['The candidate retains artifact identity.'],
    constraints: ['Do not apply the artifact.'],
  };
}

function job(id: string): JobRecord {
  const at = CREATED_AT.toISOString();
  return {
    id,
    schemaVersion: 1,
    status: 'succeeded',
    request: { prompt: 'produce a patch', workspace: '/tmp/candidate-workspace' },
    route: {
      name: 'mock',
      worker: 'mock',
      provider: 'fixture',
      model: 'fixture',
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 1_000,
    },
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    attempt: 1,
    events: [
      { sequence: 1, jobId: id, at, type: 'job.queued' },
      { sequence: 2, jobId: id, at, type: 'job.succeeded' },
    ],
    artifacts: [
      {
        kind: 'git-patch',
        attempt: 1,
        path: ARTIFACT.path,
        size: 42,
        sha256: ARTIFACT.sha256,
        baseCommit: ARTIFACT.baseCommit,
      },
    ],
  };
}

async function withFixture(
  run: (fixture: {
    workOrders: SqliteWorkOrderStore;
    jobs: SqliteJobStore;
    candidates: SqliteCandidateStore;
    workOrder: Awaited<ReturnType<WorkOrderService['issue']>>;
    job: JobRecord;
  }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-candidate-'));
  const workOrders = await SqliteWorkOrderStore.open(path.join(directory, 'work-orders'));
  const jobs = await SqliteJobStore.open(path.join(directory, 'jobs'), { importLegacy: false });
  const candidates = await SqliteCandidateStore.open(path.join(directory, 'candidates'));
  try {
    const sourceJob = job('job_executor');
    await jobs.create(sourceJob);
    const workOrder = await new WorkOrderService({
      store: workOrders,
      now: () => CREATED_AT,
    }).issue(command(directory));
    await new WorkOrderService({ store: workOrders, now: () => CREATED_AT }).bindExecutorJob(
      workOrder.id,
      workOrder.events.at(-1)!.sequence,
      sourceJob.id
    );
    await run({ workOrders, jobs, candidates, workOrder, job: sourceJob });
  } finally {
    await Promise.all([candidates.close(), jobs.close(), workOrders.close()]);
    await rm(directory, { recursive: true, force: true });
  }
}

function service(
  fixture: {
    workOrders: SqliteWorkOrderStore;
    jobs: SqliteJobStore;
    candidates: SqliteCandidateStore;
  }
): CandidateService {
  return new CandidateService({
    store: fixture.candidates,
    workOrders: fixture.workOrders,
    jobs: fixture.jobs,
    now: () => CREATED_AT,
  });
}

test('creates and reads one immutable CandidateRecord with its exact creation event', async () => {
  await withFixture(async (fixture) => {
    const created = await service(fixture).create({
      workOrderId: fixture.workOrder.id,
      executorJobId: fixture.job.id,
      artifact: ARTIFACT,
    });

    assert.match(created.id, /^candidate_[0-9a-f-]{36}$/);
    assert.equal(created.schemaVersion, 1);
    assert.equal('status' in created, false);
    assert.deepEqual(created.artifact, ARTIFACT);
    assert.equal(created.createdAt, CREATED_AT.toISOString());
    assert.deepEqual(created.events, [
      {
        sequence: 1,
        candidateId: created.id,
        at: CREATED_AT.toISOString(),
        type: 'candidate.created',
      },
    ]);
    assert.deepEqual(await service(fixture).get(created.id), created);
    assert.deepEqual(await service(fixture).list(), [created]);
    assert.deepEqual(await service(fixture).eventsAfter(created.id, 0), created.events);
  });
});

test('CandidateRecord and its event survive a SQLite restart', async () => {
  await withFixture(async (fixture) => {
    const created = await service(fixture).create({
      workOrderId: fixture.workOrder.id,
      executorJobId: fixture.job.id,
      artifact: ARTIFACT,
    });
    const directory = fixture.candidates.directory;
    await fixture.candidates.close();

    const reopened = await SqliteCandidateStore.open(directory);
    try {
      assert.deepEqual(await reopened.get(created.id), created);
      assert.deepEqual(await reopened.list(), [created]);
      assert.deepEqual(await reopened.eventsAfter(created.id, 0), created.events);
    } finally {
      await reopened.close();
    }
  });
});

test('Candidate creation defensively copies references and read results', async () => {
  await withFixture(async (fixture) => {
    const input = { ...ARTIFACT };
    const created = await service(fixture).create({
      workOrderId: fixture.workOrder.id,
      executorJobId: fixture.job.id,
      artifact: input,
    });
    input.path = '/tmp/mutated.patch';
    created.artifact.sha256 = 'c'.repeat(64);
    created.events[0]!.candidateId = 'candidate_mutated';

    const persisted = await service(fixture).get(created.id);
    assert.ok(persisted);
    assert.deepEqual(persisted.artifact, ARTIFACT);
    assert.equal(persisted.events[0]?.type, 'candidate.created');
  });
});

test('Candidate creation rejects invalid WorkOrder, Job, and artifact references', async () => {
  await withFixture(async (fixture) => {
    const candidateService = service(fixture);
    const request = {
      workOrderId: fixture.workOrder.id,
      executorJobId: fixture.job.id,
      artifact: ARTIFACT,
    };

    await assert.rejects(
      candidateService.create({ ...request, workOrderId: 'work_order_missing' }),
      /WorkOrder work_order_missing does not exist/
    );

    const unbound = await new WorkOrderService({
      store: fixture.workOrders,
      now: () => CREATED_AT,
    }).issue(command('/tmp/unbound'));
    await assert.rejects(
      candidateService.create({ ...request, workOrderId: unbound.id }),
      /is not bound to an executor Job/
    );

    await assert.rejects(
      candidateService.create({ ...request, executorJobId: 'job_other' }),
      /is bound to executor Job job_executor, not job_other/
    );

    const missingJobWorkOrder = await new WorkOrderService({
      store: fixture.workOrders,
      now: () => CREATED_AT,
    }).issue(command('/tmp/missing-job'));
    await new WorkOrderService({ store: fixture.workOrders, now: () => CREATED_AT }).bindExecutorJob(
      missingJobWorkOrder.id,
      missingJobWorkOrder.events.at(-1)!.sequence,
      'job_missing'
    );
    await assert.rejects(
      candidateService.create({
        ...request,
        workOrderId: missingJobWorkOrder.id,
        executorJobId: 'job_missing',
      }),
      /Executor Job job_missing does not exist/
    );

    await assert.rejects(
      candidateService.create({
        ...request,
        artifact: { ...ARTIFACT, sha256: 'd'.repeat(64) },
      }),
      /is not recorded by executor Job job_executor/
    );
  });
});

test('Candidate creation does not mutate the WorkOrder or Job source records', async () => {
  await withFixture(async (fixture) => {
    const beforeWorkOrder = await fixture.workOrders.get(fixture.workOrder.id);
    const beforeJob = await fixture.jobs.get(fixture.job.id);
    assert.ok(beforeWorkOrder && beforeJob);

    await service(fixture).create({
      workOrderId: fixture.workOrder.id,
      executorJobId: fixture.job.id,
      artifact: ARTIFACT,
    });

    assert.deepEqual(await fixture.workOrders.get(fixture.workOrder.id), beforeWorkOrder);
    assert.deepEqual(await fixture.jobs.get(fixture.job.id), beforeJob);
    assert.deepEqual(
      await fixture.workOrders.eventsAfter(fixture.workOrder.id, 0),
      beforeWorkOrder.events
    );
    assert.deepEqual(await fixture.jobs.eventsAfter(fixture.job.id, 0), beforeJob.events);
  });
});

test('Candidate persistence keeps immutable records out of generic updates', async () => {
  await withFixture(async (fixture) => {
    const created = await service(fixture).create({
      workOrderId: fixture.workOrder.id,
      executorJobId: fixture.job.id,
      artifact: ARTIFACT,
    });
    const raw = await SqliteDurableRecordStore.open<CandidateRecord>(
      'Candidate',
      fixture.candidates.directory
    );
    try {
      const loaded = await raw.get(created.id);
      assert.ok(loaded);
      await assert.rejects(raw.save(loaded), /Candidate records do not support general save/);
      assert.deepEqual(await raw.get(created.id), created);
    } finally {
      await raw.close();
    }
  });
});

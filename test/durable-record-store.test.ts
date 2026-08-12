import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CancellationRequestedError,
  ExecutionLeaseLostError,
  IdempotencyConflictError,
  SqliteDurableRecordStore,
  StaleRecordRevisionError,
} from '../src/durable-record-store.js';
import type { JobRecord } from '../src/types.js';
import { SqliteJobStore } from '../src/store.js';

function fixture(id = 'job_fixture'): JobRecord {
  const at = '2026-08-11T00:00:00.000Z';
  return {
    id,
    schemaVersion: 1,
    status: 'queued',
    request: { prompt: 'bounded task', workspace: '/workspace', source: 'test' },
    route: {
      name: 'mock',
      worker: 'mock',
      provider: 'deterministic',
      model: 'fixture',
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 1_000,
    },
    createdAt: at,
    updatedAt: at,
    attempt: 0,
    events: [
      {
        sequence: 1,
        jobId: id,
        at,
        type: 'job.queued',
        data: { source: 'test' },
      },
    ],
  };
}

async function withStores(
  run: (
    first: SqliteDurableRecordStore<JobRecord>,
    second: SqliteDurableRecordStore<JobRecord>
  ) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-store-'));
  const first = await SqliteDurableRecordStore.open<JobRecord>('Job', directory);
  const second = await SqliteDurableRecordStore.open<JobRecord>('Job', directory);
  try {
    await run(first, second);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(directory, { recursive: true, force: true });
  }
}

test('durable store commits a bounded snapshot and append-only event suffix atomically', async () => {
  await withStores(async (store) => {
    const record = fixture();
    await store.create(record);
    record.status = 'running';
    record.startedAt = '2026-08-11T00:00:01.000Z';
    record.updatedAt = record.startedAt;
    record.events.push({
      sequence: 2,
      jobId: record.id,
      at: record.startedAt,
      type: 'job.started',
    });
    await store.save(record);

    const loaded = await store.get(record.id);
    assert.equal(loaded?.status, 'running');
    assert.deepEqual(await store.eventsAfter(record.id, 1), [record.events[1]]);

    loaded!.events[0]!.data = { source: 'rewritten' };
    await assert.rejects(store.save(loaded!), /cannot rewrite persisted event 1/);
    assert.deepEqual((await store.get(record.id))?.events, record.events);
  });
});

test('durable store rejects a stale snapshot across independent store instances', async () => {
  await withStores(async (first, second) => {
    await first.create(fixture());
    const left = await first.get('job_fixture');
    const right = await second.get('job_fixture');
    assert.ok(left && right);

    left.updatedAt = '2026-08-11T00:00:01.000Z';
    await first.save(left);
    right.updatedAt = '2026-08-11T00:00:02.000Z';
    await assert.rejects(second.save(right), StaleRecordRevisionError);
    assert.equal((await second.get(right.id))?.updatedAt, left.updatedAt);
  });
});

test('durable admission commits the record, idempotency identity, and first lease atomically', async () => {
  await withStores(async (first, second) => {
    const digest = createHash('sha256').update('admitted request').digest('hex');
    await assert.rejects(
      first.admit(fixture('job_invalid'), {
        ownerId: '',
        ttlMs: 1_000,
        idempotency: { scope: 'controller-session', key: 'invalid', requestHash: digest },
      }),
      /Lease ownerId/
    );
    assert.equal(await first.get('job_invalid'), undefined);

    const admitted = await first.admit(fixture('job_admitted'), {
      ownerId: 'runtime-a',
      ttlMs: 1_000,
      idempotency: { scope: 'controller-session', key: 'turn-2', requestHash: digest },
    });
    assert.equal(admitted.created, true);
    if (!admitted.created) assert.fail('expected a newly admitted record');
    assert.equal(admitted.lease.fence, 1);

    const duplicate = await second.admit(fixture('job_duplicate'), {
      ownerId: 'runtime-b',
      ttlMs: 1_000,
      idempotency: { scope: 'controller-session', key: 'turn-2', requestHash: digest },
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.record.id, 'job_admitted');
    assert.equal((await second.getLease('job_admitted'))?.ownerId, 'runtime-a');

    const different = createHash('sha256').update('different request').digest('hex');
    await assert.rejects(
      second.admit(fixture('job_conflict'), {
        ownerId: 'runtime-b',
        ttlMs: 1_000,
        idempotency: {
          scope: 'controller-session',
          key: 'turn-2',
          requestHash: different,
        },
      }),
      IdempotencyConflictError
    );
    assert.equal(await second.get('job_conflict'), undefined);
  });
});

test('durable capacity admission is FIFO across independent store instances', async () => {
  await withStores(async (first, second) => {
    const start = new Date('2026-08-11T00:00:00.000Z');
    const admittedA = await first.admit(fixture('job_capacity_a'), {
      ownerId: 'runtime-a',
      ttlMs: 1_000,
      capacityLimit: 1,
      now: start,
    });
    const admittedB = await second.admit(fixture('job_capacity_b'), {
      ownerId: 'runtime-b',
      ttlMs: 1_000,
      capacityLimit: 1,
      now: new Date(start.getTime() + 1),
    });
    const admittedC = await first.admit(fixture('job_capacity_c'), {
      ownerId: 'runtime-c',
      ttlMs: 1_000,
      capacityLimit: 1,
      now: new Date(start.getTime() + 2),
    });
    assert.equal(admittedA.created, true);
    assert.equal(admittedB.created, true);
    assert.equal(admittedC.created, true);
    if (!admittedA.created || !admittedB.created || !admittedC.created) {
      assert.fail('expected three newly admitted records');
    }

    assert.equal(
      await first.tryAcquireCapacity(admittedA.lease, 1, new Date(start.getTime() + 3)),
      'acquired'
    );
    assert.equal(
      await second.tryAcquireCapacity(admittedB.lease, 1, new Date(start.getTime() + 3)),
      'waiting'
    );
    assert.equal(
      await first.tryAcquireCapacity(admittedC.lease, 1, new Date(start.getTime() + 3)),
      'waiting'
    );

    assert.equal(await first.releaseCapacity(admittedA.lease), true);
    assert.equal(
      await first.tryAcquireCapacity(admittedC.lease, 1, new Date(start.getTime() + 4)),
      'waiting'
    );
    assert.equal(
      await second.tryAcquireCapacity(admittedB.lease, 1, new Date(start.getTime() + 4)),
      'acquired'
    );
    assert.equal(await second.releaseCapacity(admittedB.lease), true);
    assert.equal(
      await first.tryAcquireCapacity(admittedC.lease, 1, new Date(start.getTime() + 5)),
      'acquired'
    );
  });
});

test('durable capacity reclaims a crashed holder after its execution lease expires', async () => {
  await withStores(async (first, second) => {
    const start = new Date('2026-08-11T00:00:00.000Z');
    const holder = await first.admit(fixture('job_capacity_holder'), {
      ownerId: 'runtime-holder',
      ttlMs: 100,
      capacityLimit: 1,
      now: start,
    });
    const waiter = await second.admit(fixture('job_capacity_waiter'), {
      ownerId: 'runtime-waiter',
      ttlMs: 1_000,
      capacityLimit: 1,
      now: start,
    });
    assert.equal(holder.created, true);
    assert.equal(waiter.created, true);
    if (!holder.created || !waiter.created) assert.fail('expected newly admitted records');
    assert.equal(await first.tryAcquireCapacity(holder.lease, 1, start), 'acquired');
    assert.equal(await second.tryAcquireCapacity(waiter.lease, 1, start), 'waiting');

    assert.equal(
      await second.tryAcquireCapacity(waiter.lease, 1, new Date(start.getTime() + 100)),
      'acquired'
    );
    assert.equal(await first.releaseCapacity(holder.lease), false);
  });
});

test('durable capacity keeps the reclaimed successor row fenced against the stale lease', async () => {
  await withStores(async (first, second) => {
    const start = new Date('2026-08-11T00:00:00.000Z');
    const holder = await first.admit(fixture('job_capacity_fenced_holder'), {
      ownerId: 'runtime-holder',
      ttlMs: 100,
      capacityLimit: 1,
      now: start,
    });
    const waiter = await second.admit(fixture('job_capacity_fenced_waiter'), {
      ownerId: 'runtime-waiter',
      ttlMs: 1_000,
      capacityLimit: 1,
      now: start,
    });
    assert.equal(holder.created, true);
    assert.equal(waiter.created, true);
    if (!holder.created || !waiter.created) assert.fail('expected newly admitted records');
    assert.equal(holder.lease.fence, 1);
    assert.equal(await first.tryAcquireCapacity(holder.lease, 1, start), 'acquired');
    assert.equal(await second.tryAcquireCapacity(waiter.lease, 1, start), 'waiting');

    const reclaimed = await second.claimLease(holder.record.id, {
      ownerId: 'runtime-holder-2',
      ttlMs: 1_000,
      now: new Date(start.getTime() + 100),
    });
    assert.ok(reclaimed);
    assert.equal(reclaimed.fence, 2);

    assert.equal(
      await second.tryAcquireCapacity(waiter.lease, 1, new Date(start.getTime() + 100)),
      'waiting',
      'lease reclaim must atomically preserve the reclaimed holder capacity row'
    );
    assert.equal(
      await first.tryAcquireCapacity(reclaimed, 1, new Date(start.getTime() + 100)),
      'acquired'
    );
    assert.equal(
      await second.tryAcquireCapacity(waiter.lease, 1, new Date(start.getTime() + 100)),
      'waiting'
    );

    assert.equal(await first.releaseCapacity(holder.lease), false);
    assert.equal(
      await second.tryAcquireCapacity(waiter.lease, 1, new Date(start.getTime() + 101)),
      'waiting'
    );

    assert.equal(await second.releaseCapacity(reclaimed), true);
    assert.equal(
      await first.tryAcquireCapacity(waiter.lease, 1, new Date(start.getTime() + 102)),
      'acquired'
    );
  });
});

test('durable leases fence stale owners and can be reclaimed only after expiry', async () => {
  await withStores(async (first, second) => {
    await first.create(fixture());
    const start = new Date('2026-08-11T00:00:00.000Z');
    const leaseA = await first.claimLease('job_fixture', {
      ownerId: 'runtime-a',
      ttlMs: 1_000,
      now: start,
    });
    assert.equal(leaseA?.fence, 1);
    const liveRecord = await first.get('job_fixture');
    assert.ok(liveRecord);
    liveRecord.updatedAt = '2026-08-11T00:00:00.100Z';
    await first.save(liveRecord, leaseA!, new Date(start.getTime() + 100));
    assert.equal(
      await second.claimLease('job_fixture', {
        ownerId: 'runtime-b',
        ttlMs: 1_000,
        now: new Date(start.getTime() + 999),
      }),
      undefined
    );
    assert.equal(await first.renewLease(leaseA!, 1_000, new Date(start.getTime() + 500)), true);
    assert.equal(
      await second.claimLease('job_fixture', {
        ownerId: 'runtime-b',
        ttlMs: 1_000,
        now: new Date(start.getTime() + 1_499),
      }),
      undefined
    );

    const leaseB = await second.claimLease('job_fixture', {
      ownerId: 'runtime-b',
      ttlMs: 1_000,
      now: new Date(start.getTime() + 1_500),
    });
    assert.equal(leaseB?.fence, 2);
    const staleRecord = await first.get('job_fixture');
    assert.ok(staleRecord);
    staleRecord.updatedAt = '2026-08-11T00:00:02.000Z';
    await assert.rejects(first.save(staleRecord, leaseA!), ExecutionLeaseLostError);
    assert.equal(await first.renewLease(leaseA!, 1_000, new Date(start.getTime() + 1_501)), false);
    assert.equal(await first.releaseLease(leaseA!), false);
    assert.equal(await second.releaseLease(leaseB!), true);
    assert.equal(await second.releaseLease(leaseB!), false);
    assert.equal(await first.getLease('job_fixture'), undefined);

    const leaseC = await first.claimLease('job_fixture', {
      ownerId: 'runtime-b',
      ttlMs: 1_000,
      now: new Date(start.getTime() + 1_501),
    });
    assert.equal(leaseC?.fence, 3);
    const staleAfterRelease = await second.get('job_fixture');
    assert.ok(staleAfterRelease);
    staleAfterRelease.updatedAt = '2026-08-11T00:00:03.000Z';
    await assert.rejects(second.save(staleAfterRelease, leaseB!), ExecutionLeaseLostError);
  });
});

test('durable cancellation intent is idempotent and visible to another store instance', async () => {
  await withStores(async (first, second) => {
    await first.create(fixture());
    const firstRequest = await first.requestCancellation(
      'job_fixture',
      'controller-a',
      new Date('2026-08-11T00:00:01.000Z')
    );
    const duplicate = await second.requestCancellation(
      'job_fixture',
      'controller-b',
      new Date('2026-08-11T00:00:02.000Z')
    );
    assert.deepEqual(duplicate, firstRequest);
    assert.deepEqual(await second.getCancellation('job_fixture'), {
      recordId: 'job_fixture',
      requestedAt: '2026-08-11T00:00:01.000Z',
      source: 'controller-a',
    });
  });
});

test('accepted durable cancellation prevents a later success transition', async () => {
  await withStores(async (first, second) => {
    await first.create(fixture());
    const running = await first.get('job_fixture');
    assert.ok(running);
    running.status = 'running';
    running.updatedAt = '2026-08-11T00:00:01.000Z';
    running.events.push({
      sequence: 2,
      jobId: running.id,
      at: running.updatedAt,
      type: 'job.started',
    });
    await first.save(running);
    await second.requestCancellation(
      running.id,
      'controller-b',
      new Date('2026-08-11T00:00:02.000Z')
    );

    running.status = 'succeeded';
    running.updatedAt = '2026-08-11T00:00:03.000Z';
    running.completedAt = running.updatedAt;
    running.events.push({
      sequence: 3,
      jobId: running.id,
      at: running.updatedAt,
      type: 'job.succeeded',
    });
    await assert.rejects(first.save(running), CancellationRequestedError);
    assert.equal((await first.get(running.id))?.status, 'running');
  });
});

test('SqliteJobStore imports legacy JSON once without rewriting its evidence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-migration-'));
  const legacyPath = path.join(directory, 'job_legacy.json');
  const legacy = fixture('job_legacy');
  const serialized = `${JSON.stringify(legacy, null, 2)}\n`;
  await writeFile(legacyPath, serialized, { mode: 0o600 });

  const store = await SqliteJobStore.open(directory);
  try {
    assert.equal((await store.get(legacy.id))?.id, legacy.id);
    assert.equal(await readFile(legacyPath, 'utf8'), serialized);
    assert.equal((await stat(path.join(directory, 'agentknot.sqlite'))).mode & 0o777, 0o600);
    assert.deepEqual(await store.eventsAfter(legacy.id, 0), legacy.events);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy import rejects a filename that does not match the record identity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-durable-migration-id-'));
  await writeFile(
    path.join(directory, 'job_filename.json'),
    `${JSON.stringify(fixture('job_payload'), null, 2)}\n`,
    { mode: 0o600 }
  );

  await assert.rejects(
    SqliteJobStore.open(directory),
    /filename identity job_filename does not match record id job_payload/
  );
  const store = await SqliteJobStore.open(directory, { importLegacy: false });
  try {
    assert.equal(await store.get('job_filename'), undefined);
    assert.equal(await store.get('job_payload'), undefined);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

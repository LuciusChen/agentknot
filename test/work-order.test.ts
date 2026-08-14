import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SqliteDurableRecordStore,
  SqliteWorkOrderStore,
  StaleRecordRevisionError,
  WorkOrderBindingConflictError,
  WorkOrderService,
  type WorkOrderCommand,
  type WorkOrderRecord,
} from '../src/index.js';

const ISSUED_AT = new Date('2026-08-13T01:02:03.000Z');
const BOUND_AT = new Date('2026-08-13T01:03:04.000Z');
const REPLAYED_AT = new Date('2026-08-13T01:04:05.000Z');

function command(workspace: string): WorkOrderCommand {
  return {
    objective: 'Add a durable command root',
    workspace,
    acceptanceCriteria: [
      'The command survives a restart.',
      '执行成功与用户接受保持分离。',
    ],
    constraints: ['Do not launch a Job.', 'Do not modify the canonical workspace.'],
    baseRevision: 'refs/heads/main@abc123',
  };
}

function revisionOf(record: WorkOrderRecord): number {
  return record.events.at(-1)!.sequence;
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-work-order-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('issues and transactionally persists one immutable WorkOrder command and event', async () => {
  await withDirectory(async (directory) => {
    const store = await SqliteWorkOrderStore.open(directory);
    try {
      const input = command('./relative-workspace');
      const service = new WorkOrderService({ store, now: () => ISSUED_AT });
      const issued = await service.issue(input);

      assert.match(issued.id, /^work_order_[0-9a-f-]{36}$/);
      assert.equal(issued.schemaVersion, 1);
      assert.equal(issued.status, 'issued');
      assert.equal(issued.createdAt, ISSUED_AT.toISOString());
      assert.equal(issued.updatedAt, ISSUED_AT.toISOString());
      assert.deepEqual(issued.command, {
        ...command(path.resolve('./relative-workspace')),
        workspace: path.resolve('./relative-workspace'),
      });
      assert.deepEqual(issued.events, [
        {
          sequence: 1,
          workOrderId: issued.id,
          at: ISSUED_AT.toISOString(),
          type: 'work-order.issued',
        },
      ]);

      const loaded = await service.get(issued.id);
      assert.deepEqual(loaded, issued);
      assert.deepEqual(await service.eventsAfter(issued.id, 0), issued.events);
      assert.deepEqual(await service.list(), [issued]);

      const conflicting: WorkOrderRecord = {
        ...structuredClone(issued),
        command: { ...structuredClone(issued.command), objective: 'Silently replace the command' },
      };
      await assert.rejects(store.create(conflicting), /UNIQUE constraint failed: records\.id/);
      assert.deepEqual(await service.get(issued.id), issued);
      assert.deepEqual(await service.eventsAfter(issued.id, 0), issued.events);
    } finally {
      await store.close();
    }
  });
});

test('round-trips WorkOrder command fields after closing and reopening SQLite', async () => {
  await withDirectory(async (directory) => {
    const first = await SqliteWorkOrderStore.open(directory);
    const issued = await new WorkOrderService({ store: first, now: () => ISSUED_AT }).issue(
      command(directory)
    );
    await first.close();

    const second = await SqliteWorkOrderStore.open(directory);
    try {
      assert.deepEqual(await second.get(issued.id), issued);
      assert.deepEqual(await second.list(), [issued]);
      assert.deepEqual(await second.eventsAfter(issued.id, 0), issued.events);
    } finally {
      await second.close();
    }
  });
});

test('binds one admitted Job identity to an issued WorkOrder', async () => {
  await withDirectory(async (directory) => {
    const store = await SqliteWorkOrderStore.open(directory);
    let now = ISSUED_AT;
    const service = new WorkOrderService({ store, now: () => now });
    try {
      const issued = await service.issue(command(directory));
      now = BOUND_AT;
      const bound = await service.bindExecutorJob(
        issued.id,
        revisionOf(issued),
        'job_executor'
      );

      assert.equal(bound.executorJobId, 'job_executor');
      assert.equal(bound.status, 'issued');
      assert.deepEqual(bound.command, issued.command);
      assert.equal(bound.updatedAt, BOUND_AT.toISOString());
      assert.deepEqual(bound.events[1], {
        sequence: 2,
        workOrderId: issued.id,
        at: BOUND_AT.toISOString(),
        type: 'work-order.executor-job.bound',
        data: { executorJobId: 'job_executor' },
      });
      assert.deepEqual(await service.get(issued.id), bound);
    } finally {
      await store.close();
    }
  });
});

test('replaying the same Job binding is idempotent even with the original revision', async () => {
  await withDirectory(async (directory) => {
    const store = await SqliteWorkOrderStore.open(directory);
    let now = ISSUED_AT;
    const service = new WorkOrderService({ store, now: () => now });
    try {
      const issued = await service.issue(command(directory));
      now = BOUND_AT;
      const first = await service.bindExecutorJob(
        issued.id,
        revisionOf(issued),
        'job_executor'
      );
      now = REPLAYED_AT;
      const replayed = await service.bindExecutorJob(
        issued.id,
        revisionOf(issued),
        'job_executor'
      );

      assert.deepEqual(replayed, first);
      assert.equal(replayed.events.length, 2);
      assert.equal(replayed.updatedAt, BOUND_AT.toISOString());
      assert.deepEqual(await service.eventsAfter(issued.id, 0), first.events);
    } finally {
      await store.close();
    }
  });
});

test('rejects rebinding an issued WorkOrder to a different Job', async () => {
  await withDirectory(async (directory) => {
    const store = await SqliteWorkOrderStore.open(directory);
    const service = new WorkOrderService({ store, now: () => ISSUED_AT });
    try {
      const issued = await service.issue(command(directory));
      const first = await service.bindExecutorJob(issued.id, revisionOf(issued), 'job_first');

      await assert.rejects(
        service.bindExecutorJob(issued.id, revisionOf(first), 'job_second'),
        WorkOrderBindingConflictError
      );
      assert.deepEqual(await service.get(issued.id), first);
    } finally {
      await store.close();
    }
  });
});

test('concurrent callers binding different Jobs produce one success and one conflict', async () => {
  await withDirectory(async (directory) => {
    const firstStore = await SqliteWorkOrderStore.open(directory);
    const secondStore = await SqliteWorkOrderStore.open(directory);
    const first = new WorkOrderService({ store: firstStore, now: () => ISSUED_AT });
    const second = new WorkOrderService({ store: secondStore, now: () => BOUND_AT });
    try {
      const issued = await first.issue(command(directory));
      const results = await Promise.allSettled([
        first.bindExecutorJob(issued.id, revisionOf(issued), 'job_first'),
        second.bindExecutorJob(issued.id, revisionOf(issued), 'job_second'),
      ]);

      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const rejected = results.find((result) => result.status === 'rejected');
      assert.ok(rejected && rejected.status === 'rejected');
      assert.ok(rejected.reason instanceof WorkOrderBindingConflictError);

      const bound = await first.get(issued.id);
      assert.ok(bound);
      assert.ok(bound.executorJobId === 'job_first' || bound.executorJobId === 'job_second');
      assert.equal(bound.events.length, 2);
    } finally {
      await Promise.all([firstStore.close(), secondStore.close()]);
    }
  });
});

test('rejects a stale WorkOrder revision before the first binding', async () => {
  await withDirectory(async (directory) => {
    const store = await SqliteWorkOrderStore.open(directory);
    const service = new WorkOrderService({ store, now: () => ISSUED_AT });
    try {
      const issued = await service.issue(command(directory));

      await assert.rejects(
        service.bindExecutorJob(issued.id, revisionOf(issued) + 1, 'job_executor'),
        StaleRecordRevisionError
      );
      assert.deepEqual(await service.get(issued.id), issued);
    } finally {
      await store.close();
    }
  });
});

test('rejects binding when the WorkOrder does not exist', async () => {
  await withDirectory(async (directory) => {
    const store = await SqliteWorkOrderStore.open(directory);
    try {
      const service = new WorkOrderService({ store, now: () => BOUND_AT });
      await assert.rejects(
        service.bindExecutorJob('work_order_missing', 1, 'job_executor'),
        /WorkOrder work_order_missing does not exist/
      );
    } finally {
      await store.close();
    }
  });
});

test('retains the executor Job binding after closing and reopening SQLite', async () => {
  await withDirectory(async (directory) => {
    const first = await SqliteWorkOrderStore.open(directory);
    const service = new WorkOrderService({ store: first, now: () => ISSUED_AT });
    const issued = await service.issue(command(directory));
    const bound = await service.bindExecutorJob(
      issued.id,
      revisionOf(issued),
      'job_executor'
    );
    await first.close();

    const second = await SqliteWorkOrderStore.open(directory);
    try {
      assert.deepEqual(await second.get(issued.id), bound);
      assert.deepEqual(await second.eventsAfter(issued.id, 1), [bound.events[1]]);
    } finally {
      await second.close();
    }
  });
});

test('caller mutation cannot silently change an issued WorkOrder command', async () => {
  await withDirectory(async (directory) => {
    const store = await SqliteWorkOrderStore.open(directory);
    try {
      const input = command(directory);
      const service = new WorkOrderService({ store, now: () => ISSUED_AT });
      const issued = await service.issue(input);

      input.objective = 'Mutated input';
      input.acceptanceCriteria.push('Mutated input criterion');
      issued.command.objective = 'Mutated returned record';
      issued.command.constraints.push('Mutated returned constraint');

      const loaded = await service.get(issued.id);
      assert.equal(loaded?.command.objective, 'Add a durable command root');
      assert.deepEqual(loaded?.command.acceptanceCriteria, command(directory).acceptanceCriteria);
      assert.deepEqual(loaded?.command.constraints, command(directory).constraints);
      assert.equal('save' in store, false);

      const raw = await SqliteDurableRecordStore.open<WorkOrderRecord>('WorkOrder', directory);
      try {
        const rawRecord = await raw.get(issued.id);
        assert.ok(rawRecord);
        rawRecord.command.objective = 'Attempted generic-store rewrite';
        await assert.rejects(
          raw.save(rawRecord),
          /WorkOrder records do not support general save after issue/
        );
        assert.equal((await raw.get(issued.id))?.command.objective, 'Add a durable command root');
      } finally {
        await raw.close();
      }
    } finally {
      await store.close();
    }
  });
});

test('WorkOrder persistence follows the exact schema-version convention', async () => {
  await withDirectory(async (directory) => {
    const store = await SqliteWorkOrderStore.open(directory);
    try {
      const invalid = {
        id: 'work_order_future',
        schemaVersion: 2,
        status: 'issued',
        command: command(directory),
        createdAt: ISSUED_AT.toISOString(),
        updatedAt: ISSUED_AT.toISOString(),
        events: [
          {
            sequence: 1,
            workOrderId: 'work_order_future',
            at: ISSUED_AT.toISOString(),
            type: 'work-order.issued',
          },
        ],
      } as unknown as WorkOrderRecord;

      await assert.rejects(store.create(invalid), /Unsupported WorkOrder schemaVersion 2/);
      assert.equal(await store.get(invalid.id), undefined);
    } finally {
      await store.close();
    }
  });
});

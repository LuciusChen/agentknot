import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SqliteDurableRecordStore,
  SqliteWorkOrderStore,
  WorkOrderService,
  type WorkOrderCommand,
  type WorkOrderRecord,
} from '../src/index.js';

const ISSUED_AT = new Date('2026-08-13T01:02:03.000Z');

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

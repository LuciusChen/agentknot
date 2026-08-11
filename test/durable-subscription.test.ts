import assert from 'node:assert/strict';
import test from 'node:test';

import { DurableEventSubscription } from '../src/durable-subscription.js';

interface TestEvent {
  sequence: number;
  type: string;
}

interface TestRecord {
  id: string;
  status: 'running' | 'succeeded';
  events: TestEvent[];
}

function source(record: TestRecord) {
  return {
    async get(id: string) {
      return id === record.id ? structuredClone(record) : undefined;
    },
    async eventsAfter(id: string, sequence: number) {
      return id === record.id
        ? record.events.filter((event) => event.sequence > sequence).map((event) => ({ ...event }))
        : [];
    },
  };
}

test('durable subscription replays a cursor then ends after the terminal event', async () => {
  const record: TestRecord = {
    id: 'record_replay',
    status: 'succeeded',
    events: [
      { sequence: 1, type: 'queued' },
      { sequence: 2, type: 'started' },
      { sequence: 3, type: 'succeeded' },
    ],
  };
  const subscription = new DurableEventSubscription(source(record), (current) =>
    current.status === 'succeeded'
  );

  const events: TestEvent[] = [];
  for await (const event of subscription.subscribe(record.id, 1)) events.push(event);

  assert.deepEqual(events, record.events.slice(1));
});

test('durable subscription closes the read/register missed-wakeup race', async () => {
  const record: TestRecord = { id: 'record_race', status: 'running', events: [] };
  let reads = 0;
  let subscription: DurableEventSubscription<TestEvent, TestRecord>;
  const raceSource = {
    async get() {
      return structuredClone(record);
    },
    async eventsAfter(_id: string, sequence: number) {
      reads += 1;
      if (reads === 1) {
        // The commit notification lands after the subscriber captured its version
        // but before it registered a waiter.
        record.events.push({ sequence: 1, type: 'started' });
        subscription.notifyPersisted(record.id);
        return [];
      }
      return record.events.filter((event) => event.sequence > sequence).map((event) => ({ ...event }));
    },
  };
  subscription = new DurableEventSubscription(raceSource, (current) =>
    current.status === 'succeeded'
  );
  const iterator = subscription.subscribe(record.id, 0, { refreshIntervalMs: 60_000 })[
    Symbol.asyncIterator
  ]();
  const next = iterator.next();

  assert.deepEqual(await next, { done: false, value: { sequence: 1, type: 'started' } });
  await iterator.return?.();
});

test('independent subscribers observe external commits through durable refresh fallback', async () => {
  const record: TestRecord = { id: 'record_external', status: 'running', events: [] };
  const reader = new DurableEventSubscription(source(record), (current) =>
    current.status === 'succeeded'
  );
  const iterator = reader.subscribe(record.id, 0, { refreshIntervalMs: 10 })[Symbol.asyncIterator]();
  const next = iterator.next();

  await new Promise((resolve) => setImmediate(resolve));
  record.events.push({ sequence: 1, type: 'started' });
  assert.deepEqual(await next, { done: false, value: { sequence: 1, type: 'started' } });
  await iterator.return?.();
});

test('aborting a durable subscription rejects its pending wait and permits clean return', async () => {
  const record: TestRecord = { id: 'record_abort', status: 'running', events: [] };
  const subscription = new DurableEventSubscription(source(record), (current) =>
    current.status === 'succeeded'
  );
  const controller = new AbortController();
  const iterator = subscription.subscribe(record.id, 0, {
    signal: controller.signal,
    refreshIntervalMs: 60_000,
  })[Symbol.asyncIterator]();
  const next = iterator.next();
  controller.abort(new Error('reader disconnected'));

  await assert.rejects(next, /reader disconnected/);
});

test('bounded wait returns the latest snapshot at timeout and wakes immediately after commit', async () => {
  const record: TestRecord = { id: 'record_wait', status: 'running', events: [] };
  const subscription = new DurableEventSubscription(source(record), (current) =>
    current.status === 'succeeded'
  );
  assert.equal((await subscription.wait(record.id, 0))?.status, 'running');

  const waited = subscription.wait(record.id, 5_000);
  record.status = 'succeeded';
  record.events.push({ sequence: 1, type: 'succeeded' });
  subscription.notifyPersisted(record.id);
  assert.equal((await waited)?.status, 'succeeded');
});

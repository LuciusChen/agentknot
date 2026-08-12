import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AttemptWorkerControlChannel,
  normalizeWorkerControlKinds,
  validateWorkerControlRequest,
} from '../src/worker-control.js';

test('attempt worker control binds delivery and rejects work after close', async () => {
  const channel = new AttemptWorkerControlChannel();
  const order: string[] = [];
  channel.bind(async (request) => {
    order.push(request.controlId);
    return { accepted: true };
  });
  const first = channel.deliver({ controlId: 'first', kind: 'steer', message: 'one' });
  const second = channel.deliver({ controlId: 'second', kind: 'follow-up', message: 'two' });
  assert.deepEqual(await Promise.all([first, second]), [
    { delivered: true, uncertain: false, result: { accepted: true } },
    { delivered: true, uncertain: false, result: { accepted: true } },
  ]);
  assert.deepEqual(order, ['first', 'second']);

  channel.close();
  assert.deepEqual(await channel.deliver({ controlId: 'late', kind: 'steer', message: 'late' }), {
    delivered: false,
    uncertain: false,
    result: { accepted: false, reason: 'worker-control-not-ready' },
  });
});

test('attempt worker control bounds handler failure and timeout as uncertain delivery', async () => {
  const failed = new AttemptWorkerControlChannel(20);
  failed.bind(async () => { throw new Error('private adapter failure'); });
  assert.deepEqual(await failed.deliver({ controlId: 'failed', kind: 'steer', message: 'one' }), {
    delivered: true,
    uncertain: true,
    result: { accepted: false, reason: 'worker-control-handler-failed' },
  });

  const timedOut = new AttemptWorkerControlChannel(20);
  timedOut.bind(() => new Promise(() => undefined));
  assert.deepEqual(await timedOut.deliver({ controlId: 'timeout', kind: 'steer', message: 'two' }), {
    delivered: true,
    uncertain: true,
    result: { accepted: false, reason: 'worker-control-handler-timeout' },
  });
});

test('worker control validates bounded strict requests and adapter capabilities', () => {
  assert.deepEqual(validateWorkerControlRequest({
    schemaVersion: 1,
    controlId: 'control_1',
    attempt: 2,
    kind: 'follow-up',
    message: 'Run the bounded check next.',
  }), {
    schemaVersion: 1,
    controlId: 'control_1',
    attempt: 2,
    kind: 'follow-up',
    message: 'Run the bounded check next.',
  });
  assert.throws(
    () => validateWorkerControlRequest({
      schemaVersion: 1,
      controlId: 'bad id',
      attempt: 1,
      kind: 'steer',
      message: 'message',
    }),
    /invalid/
  );
  assert.throws(
    () => validateWorkerControlRequest({
      schemaVersion: 1,
      controlId: 'too-large',
      attempt: 1,
      kind: 'steer',
      message: 'x'.repeat(8 * 1024 + 1),
    }),
    /maximum is 8192 bytes/
  );
  assert.deepEqual(normalizeWorkerControlKinds(['steer', 'follow-up']), ['steer', 'follow-up']);
  assert.throws(() => normalizeWorkerControlKinds(['steer', 'steer']), /invalid/);
});

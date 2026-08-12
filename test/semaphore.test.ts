import assert from 'node:assert/strict';
import test from 'node:test';

import { Semaphore } from '../src/semaphore.js';

test('Semaphore preserves FIFO while an earlier waiting callback is asynchronous', async () => {
  const semaphore = new Semaphore(1);
  const signal = new AbortController().signal;
  const releaseInitial = await semaphore.acquire(signal);
  let finishFirstCallback!: () => void;
  const first = semaphore.acquire(signal, () => new Promise<void>((resolve) => {
    finishFirstCallback = resolve;
  }));
  let secondAcquired = false;
  const second = semaphore.acquire(signal, async () => undefined).then((release) => {
    secondAcquired = true;
    return release;
  });

  await new Promise((resolve) => setImmediate(resolve));
  releaseInitial();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondAcquired, false);

  finishFirstCallback();
  const releaseFirst = await first;
  assert.equal(secondAcquired, false);
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondAcquired, true);
  releaseSecond();
});

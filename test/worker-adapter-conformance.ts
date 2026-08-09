import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  JobEventType,
  ResolvedRoute,
  WorkerAdapter,
  WorkerHealth,
} from '../src/types.js';

type WorkerEvent = {
  type: Exclude<JobEventType, `job.${string}`>;
  data?: Record<string, unknown>;
};

export interface WorkerAdapterConformanceOptions {
  name: string;
  createAdapter: () => WorkerAdapter;
  route: ResolvedRoute;
  expectedOutput: string;
  assertHealth?: (health: WorkerHealth) => void;
}

export function registerWorkerAdapterConformanceTests(
  options: WorkerAdapterConformanceOptions
): void {
  const input = (signal: AbortSignal) => ({
    jobId: `job_${options.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_')}_conformance`,
    prompt: `Conformance prompt for ${options.name}`,
    workspace: process.cwd(),
    route: options.route,
    attempt: 7,
    signal,
  });

  test(`${options.name} conforms to the healthy doctor contract`, async () => {
    const health = await options.createAdapter().doctor(options.route);

    assert.equal(health.ok, true);
    assert.equal(typeof health.message, 'string');
    assert.notEqual(health.message, '');
    options.assertHealth?.(health);
  });

  test(`${options.name} conforms to normalized run events and output`, async () => {
    const events: WorkerEvent[] = [];
    const result = await options.createAdapter().run(
      input(new AbortController().signal),
      (type, data) => {
        events.push(data === undefined ? { type } : { type, data });
      }
    );

    assert.equal(result.output, options.expectedOutput);
    const started = events.filter((event) => event.type === 'worker.started');
    assert.equal(started.length, 1);
    assert.equal(started[0]?.data?.attempt, 7);
    const text = events
      .filter((event) => event.type === 'worker.text.delta')
      .map((event) => event.data?.delta);
    assert.ok(text.length > 0);
    assert.equal(text.every((delta) => typeof delta === 'string'), true);
    assert.equal(text.join(''), options.expectedOutput);
  });

  test(`${options.name} propagates worker event sink failures`, async () => {
    const expected = new Error(`${options.name} event sink failed`);

    await assert.rejects(
      options.createAdapter().run(input(new AbortController().signal), (type) => {
        if (type === 'worker.text.delta') throw expected;
      }),
      (error: unknown) => error === expected
    );
  });

  test(`${options.name} rejects a run whose signal is already aborted`, async () => {
    const controller = new AbortController();
    const reason = new Error(`${options.name} conformance abort`);
    const events: WorkerEvent[] = [];
    controller.abort(reason);

    await assert.rejects(
      options.createAdapter().run(input(controller.signal), (type, data) => {
        events.push(data === undefined ? { type } : { type, data });
      }),
      (error: unknown) => error === reason
    );
    assert.deepEqual(events, []);
  });
}

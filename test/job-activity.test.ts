import assert from 'node:assert/strict';
import test from 'node:test';

import { isJobActivityProjection, projectJobActivity } from '../src/job-activity.js';
import type { JobEvent, JobEventType, JobRecord, JobStatus } from '../src/types.js';

function events(
  ...entries: Array<{ type: JobEventType; data?: Record<string, unknown> }>
): JobEvent[] {
  return entries.map((entry, index) => ({
    sequence: index + 1,
    jobId: 'job_activity',
    at: `2026-08-12T00:00:${String(index).padStart(2, '0')}.000Z`,
    type: entry.type,
    ...(entry.data === undefined ? {} : { data: entry.data }),
  }));
}

function job(status: JobStatus, jobEvents: JobEvent[]): JobRecord {
  return {
    schemaVersion: 1,
    id: 'job_activity',
    status,
    request: { prompt: 'private prompt', workspace: '/private/workspace' },
    route: {
      name: 'route',
      worker: 'worker',
      provider: 'provider',
      model: 'model',
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 30_000,
    },
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    attempt: status === 'queued' ? 0 : 1,
    events: jobEvents,
  };
}

test('job activity distinguishes capacity waiting, startup, and terminal state', () => {
  assert.equal(
    projectJobActivity(job('queued', events(
      { type: 'job.queued' },
      { type: 'job.capacity.waiting' },
      { type: 'job.observer.failed' }
    ))).state,
    'capacity-waiting'
  );
  assert.equal(
    projectJobActivity(job('running', events(
      { type: 'job.started' },
      { type: 'worker.started' },
      { type: 'job.attempt.lost' },
      { type: 'job.recovery.started' },
      { type: 'job.capacity.waiting' }
    ))).state,
    'capacity-waiting'
  );
  assert.equal(
    projectJobActivity(job('running', events(
      { type: 'job.queued' },
      { type: 'job.started' }
    ))).state,
    'starting'
  );
  assert.equal(
    projectJobActivity(job('failed', events(
      { type: 'job.queued' },
      { type: 'job.failed' }
    ))).state,
    'terminal'
  );
});

test('job activity tracks concurrent tools without copying private event payloads', () => {
  const projection = projectJobActivity(job('running', events(
    { type: 'job.started' },
    { type: 'worker.started' },
    {
      type: 'worker.tool.started',
      data: {
        toolCallId: 'call-1',
        toolName: 'read\nprivate',
        arguments: { path: '/private/secret' },
      },
    },
    {
      type: 'worker.tool.started',
      data: { toolCallId: 'call-2', toolName: 'bash', arguments: { command: 'secret' } },
    },
    {
      type: 'worker.tool.updated',
      data: { toolCallId: 'call-2', toolName: 'bash', update: 'private output' },
    }
  )));

  assert.equal(projection.state, 'tools-running');
  assert.equal(projection.coverage, 'complete');
  assert.deepEqual(projection.activeTools, {
    count: 2,
    names: ['read private', 'bash'],
    namesTruncated: false,
  });
  assert.equal(projection.lastObserved?.toolName, 'bash');
  assert.equal(JSON.stringify(projection).includes('secret'), false);
  assert.equal(JSON.stringify(projection).includes('private output'), false);
  assert.equal(isJobActivityProjection(projection), true);
});

test('job activity bounds visible tool names and reports omitted active tools', () => {
  const longName = `read-${'x'.repeat(100)}`;
  const projection = projectJobActivity(job('running', events(
    { type: 'job.started' },
    { type: 'worker.started' },
    ...[longName, 'bash', 'write', 'edit', 'test'].map((name, index) => ({
      type: 'worker.tool.started' as const,
      data: { toolCallId: `call-${index}`, toolName: name },
    }))
  )));

  assert.equal(projection.state, 'tools-running');
  assert.equal(projection.activeTools?.count, 5);
  assert.equal(projection.activeTools?.names.length, 4);
  assert.equal(projection.activeTools?.names[0]?.length, 80);
  assert.equal(projection.activeTools?.namesTruncated, true);
});

test('job activity clears completed tools and preserves oversized-event lifecycle identity', () => {
  const projection = projectJobActivity(job('running', events(
    { type: 'job.started' },
    { type: 'worker.started' },
    { type: 'worker.tool.started', data: { toolCallId: 'call-1', toolName: 'read' } },
    {
      type: 'worker.tool.completed',
      data: {
        toolCallId: 'call-1',
        toolName: 'read',
        isError: false,
        agentknotRecordLimit: {
          field: 'event.data',
          action: 'replaced',
          originalBytes: 20_000,
          maxBytes: 16_384,
        },
      },
    }
  )));

  assert.equal(projection.state, 'running');
  assert.equal(projection.coverage, 'complete');
  assert.equal(projection.activeTools, undefined);
  assert.equal(projection.lastObserved?.toolName, 'read');
});

test('job activity reports partial and truncated coverage without false active tools', () => {
  const partial = projectJobActivity(job('running', events(
    { type: 'job.started' },
    { type: 'worker.started' },
    { type: 'worker.tool.started', data: { agentknotRecordLimit: { action: 'replaced' } } }
  )));
  assert.equal(partial.state, 'running');
  assert.equal(partial.coverage, 'partial');
  assert.equal(partial.activeTools, undefined);

  const truncated = projectJobActivity(job('running', events(
    { type: 'job.started' },
    { type: 'worker.started' },
    { type: 'worker.tool.started', data: { toolCallId: 'call-1', toolName: 'read' } },
    {
      type: 'job.worker.events.truncated',
      data: { maxEvents: 512, firstDroppedEventType: 'worker.text.delta' },
    }
  )));
  assert.equal(truncated.state, 'running');
  assert.equal(truncated.coverage, 'truncated');
  assert.equal(truncated.activeTools, undefined);
  assert.equal(truncated.lastObserved?.type, 'job.worker.events.truncated');
});

test('job activity distinguishes worker retry from broker-client connectivity', () => {
  const projection = projectJobActivity(job('running', events(
    { type: 'job.started' },
    { type: 'worker.started' },
    { type: 'worker.retry.started', data: { attempt: 2, delayMs: 1_000 } }
  )));
  assert.equal(projection.state, 'retrying');
  assert.equal(projection.lastObserved?.retryAttempt, 2);
  assert.equal('connectivity' in projection, false);

  const control = projectJobActivity(job('running', events(
    { type: 'job.started' },
    { type: 'worker.started' },
    { type: 'job.control.accepted', data: { attempt: 1, controlId: 'control-1' } }
  )));
  assert.equal(control.lastObserved?.retryAttempt, undefined);
});

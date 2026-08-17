import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AgentKnotConfig } from '../src/config.js';
import { AgentKnotHttpClient } from '../src/http-client.js';
import { createAgentKnotHttpServer } from '../src/http-server.js';
import { readJobOutputRecord } from '../src/job-output.js';
import { Orchestrator } from '../src/orchestrator.js';
import {
  DEFAULT_OUTPUT_CHUNK_BYTES,
  MAX_OUTPUT_CHUNK_BYTES,
} from '../src/record-limits.js';
import { MemoryJobStore, SqliteJobStore } from '../src/store.js';
import type { JobOutputReadResult, JobRecord } from '../src/types.js';

const route = {
  name: 'mock',
  worker: 'mock',
  provider: 'test',
  model: 'fixture',
  requiredEnv: [],
  maxAttempts: 1,
  timeoutMs: 1_000,
};

const config: AgentKnotConfig = {
  version: 1,
  defaultRoute: route.name,
  storage: { directory: '.agentknot/jobs' },
  workers: { mock: { adapter: 'mock' } },
  routes: {
    mock: {
      worker: route.worker,
      provider: route.provider,
      model: route.model,
      maxAttempts: route.maxAttempts,
      timeoutMs: route.timeoutMs,
    },
  },
};

function record(
  id: string,
  output: string | undefined,
  subtaskId = 'subtask-output'
): JobRecord {
  return {
    id,
    schemaVersion: 1,
    status: output === undefined ? 'failed' : 'succeeded',
    request: {
      prompt: 'Produce durable output.',
      workspace: '/tmp/workspace',
      metadata: {
        agentknotDelegation: {
          orchestrationId: 'orchestration-output',
          role: 'worker',
          subtaskId,
          depth: 1,
          planHash: 'plan-hash',
          policyVersion: 1,
          taskKind: 'implementation',
          parentComplexity: 'low',
        },
      },
    },
    route,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:01.000Z',
    completedAt: '2026-08-17T00:00:01.000Z',
    attempt: 1,
    events: [
      {
        sequence: 1,
        jobId: id,
        at: '2026-08-17T00:00:00.000Z',
        type: 'job.queued',
      },
    ],
    ...(output === undefined
      ? {
          error: {
            name: 'WorkerFailure',
            message: 'No output was retained.',
            attempt: 1,
            retryable: false,
          },
        }
      : {
          result: {
            output,
            attempt: 1,
            worker: route.worker,
            provider: route.provider,
            model: route.model,
          },
        }),
  };
}

function available(result: JobOutputReadResult): Extract<JobOutputReadResult, { status: 'available' }> {
  assert.equal(result.status, 'available');
  return result as Extract<JobOutputReadResult, { status: 'available' }>;
}

test('Job output reader applies default and custom byte limits with continuous cursors', () => {
  const output = 'a'.repeat(DEFAULT_OUTPUT_CHUNK_BYTES + 23);
  const job = record('job_output_ascii', output);
  const first = available(readJobOutputRecord(job.id, job));
  assert.equal(Buffer.byteLength(first.chunk, 'utf8'), DEFAULT_OUTPUT_CHUNK_BYTES);
  assert.equal(first.cursor, 0);
  assert.equal(first.nextCursor, DEFAULT_OUTPUT_CHUNK_BYTES);
  assert.equal(first.hasMore, true);
  assert.equal(first.totalBytes, Buffer.byteLength(output, 'utf8'));

  const second = available(
    readJobOutputRecord(job.id, job, { cursor: first.nextCursor, maxBytes: 7 })
  );
  assert.equal(second.cursor, first.nextCursor);
  assert.equal(Buffer.byteLength(second.chunk, 'utf8'), 7);
  assert.equal(second.nextCursor, first.nextCursor! + 7);

  let cursor = 0;
  let reconstructed = '';
  do {
    const page = available(readJobOutputRecord(job.id, job, { cursor, maxBytes: 7 }));
    assert.ok(Buffer.byteLength(page.chunk, 'utf8') <= 7);
    reconstructed += page.chunk;
    if (!page.hasMore) {
      assert.equal(page.nextCursor, undefined);
      break;
    }
    assert.ok(page.nextCursor! > cursor);
    cursor = page.nextCursor!;
  } while (true);
  assert.equal(reconstructed, output);
});

test('Job output reader preserves Chinese and emoji across UTF-8 byte pages', () => {
  const output = 'A中文🙂B'.repeat(100);
  const job = record('job_output_unicode', output);
  let cursor = 0;
  let reconstructed = '';
  do {
    const page = available(readJobOutputRecord(job.id, job, { cursor, maxBytes: 7 }));
    assert.ok(Buffer.byteLength(page.chunk, 'utf8') <= 7);
    assert.equal(page.chunk.includes('\uFFFD'), false);
    reconstructed += page.chunk;
    if (!page.hasMore) break;
    cursor = page.nextCursor!;
  } while (true);
  assert.equal(reconstructed, output);
  assert.throws(
    () => readJobOutputRecord(job.id, job, { cursor: 2 }),
    /UTF-8 code point boundary/
  );
});

test('Job output reader rejects invalid bounds and distinguishes unavailable results', () => {
  const succeeded = record('job_output_available', 'retained');
  const failed = record('job_output_unavailable', undefined);
  assert.deepEqual(readJobOutputRecord('job_missing', undefined), {
    schemaVersion: 1,
    status: 'unavailable',
    jobId: 'job_missing',
    reason: 'job-not-found',
  });
  assert.deepEqual(readJobOutputRecord(failed.id, failed), {
    schemaVersion: 1,
    status: 'unavailable',
    jobId: failed.id,
    reason: 'output-unavailable',
  });
  assert.deepEqual(
    readJobOutputRecord(succeeded.id, succeeded, { subtaskId: 'different-subtask' }),
    {
      schemaVersion: 1,
      status: 'unavailable',
      jobId: succeeded.id,
      subtaskId: 'different-subtask',
      reason: 'subtask-not-found',
    }
  );
  assert.throws(() => readJobOutputRecord(succeeded.id, succeeded, { cursor: -1 }), /cursor/);
  assert.throws(() => readJobOutputRecord(succeeded.id, succeeded, { cursor: 100 }), /exceeds/);
  assert.throws(() => readJobOutputRecord(succeeded.id, succeeded, { maxBytes: 3 }), /maxBytes/);
  assert.throws(
    () => readJobOutputRecord(succeeded.id, succeeded, { maxBytes: MAX_OUTPUT_CHUNK_BYTES + 1 }),
    /maxBytes/
  );
});

test('Job output remains readable through the bounded HTTP projection', async () => {
  const output = 'HTTP 中文🙂 output '.repeat(500);
  const store = new MemoryJobStore();
  const job = record('job_output_http', output);
  await store.create(job);
  const orchestrator = new Orchestrator({ config, store, adapters: new Map() });
  const server = createAgentKnotHttpServer(orchestrator);
  const address = await server.listen(0);
  try {
    const client = new AgentKnotHttpClient(`http://${address.host}:${address.port}`);
    const first = available(
      await client.readJobOutput(job.id, { subtaskId: 'subtask-output', maxBytes: 64 })
    );
    assert.ok(Buffer.byteLength(first.chunk, 'utf8') <= 64);
    const second = available(
      await client.readJobOutput(job.id, {
        subtaskId: 'subtask-output',
        cursor: first.nextCursor!,
        maxBytes: 64,
      })
    );
    assert.equal(second.cursor, first.nextCursor);
    assert.equal(first.chunk + second.chunk, output.slice(0, first.chunk.length + second.chunk.length));
  } finally {
    await server.close();
  }
});

test('Job output is restart-safe in the durable SQLite store', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-job-output-'));
  const output = 'durable 中文🙂 output '.repeat(1_000);
  const job = record('job_output_restart', output);
  let store = await SqliteJobStore.open(directory, { importLegacy: false });
  try {
    await store.create(job);
  } finally {
    await store.close();
  }

  store = await SqliteJobStore.open(directory, { importLegacy: false });
  try {
    const orchestrator = new Orchestrator({ config, store, adapters: new Map() });
    let cursor = 0;
    let reconstructed = '';
    do {
      const page = available(
        await orchestrator.readJobOutput(job.id, {
          subtaskId: 'subtask-output',
          cursor,
          maxBytes: 127,
        })
      );
      assert.ok(Buffer.byteLength(page.chunk, 'utf8') <= 127);
      reconstructed += page.chunk;
      if (!page.hasMore) break;
      cursor = page.nextCursor!;
    } while (true);
    assert.equal(reconstructed, output);
    assert.equal((await store.get(job.id))?.result?.output, output);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

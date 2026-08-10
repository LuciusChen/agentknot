import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AgentKnotConfig } from '../src/config.js';
import { OrchestrationService } from '../src/orchestration.js';
import { FileOrchestrationStore, MemoryOrchestrationStore } from '../src/orchestration-store.js';
import type { OrchestrationRecord } from '../src/orchestration-types.js';
import type { TaskAssessment } from '../src/orchestration-types.js';
import { Orchestrator } from '../src/orchestrator.js';
import {
  MAX_EVENT_DATA_BYTES,
  MAX_ERROR_MESSAGE_BYTES,
  MAX_JOB_RECORD_BYTES,
  MAX_METADATA_BYTES,
  MAX_METADATA_DEPTH,
  MAX_PROMPT_BYTES,
  MAX_RESULT_OUTPUT_BYTES,
  MAX_WORKER_COMPLETION_REPORT_BYTES,
  MAX_WORKER_EVENTS,
  limitText,
  limitTextSuffix,
  utf8Bytes,
} from '../src/record-limits.js';
import { FileJobStore, MemoryJobStore } from '../src/store.js';
import type {
  JobRecord,
  WorkerAdapter,
  WorkerEventSink,
  WorkerRunInput,
  WorkerRunResult,
} from '../src/types.js';

const config: AgentKnotConfig = {
  version: 1,
  defaultRoute: 'test',
  storage: { directory: '.agentknot/jobs' },
  workers: { test: { adapter: 'mock' } },
  routes: { test: { worker: 'test', provider: 'test', model: 'test' } },
  delegation: {
    mode: 'off',
    dispatch: { defaultRoute: 'test', maxChildren: 2, maxDepth: 1, maxConcurrency: 1 },
    policy: { delegate: [], keepUpstream: [] },
  },
};

const assessment: TaskAssessment = {
  schemaVersion: 1,
  recommendation: 'do-not-delegate',
  complexity: 'low',
  parallelizable: false,
  taskKinds: ['documentation'],
  reasoning: 'Controller-authored record-limit boundary fixture.',
  subtasks: [],
};

class ScriptedAdapter implements WorkerAdapter {
  readonly name = 'test';

  constructor(readonly script: (input: WorkerRunInput, emit: WorkerEventSink) => Promise<WorkerRunResult>) {}

  async doctor(): Promise<{ ok: true; message: string }> {
    return { ok: true, message: 'ready' };
  }

  run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    return this.script(input, emit);
  }
}

async function workspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'agentknot-record-limits-'));
}

function orchestrator(
  script: ScriptedAdapter['script'],
  options: { fetch?: typeof globalThis.fetch; store?: MemoryJobStore } = {}
): Orchestrator {
  return new Orchestrator({
    config,
    store: options.store ?? new MemoryJobStore(),
    adapters: new Map([['test', new ScriptedAdapter(script)]]),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

test('text limit helpers preserve exact and partial ASCII, 2-byte, 3-byte, and 4-byte UTF-8 boundaries', () => {
  for (const character of ['a', 'é', '€', '🙂']) {
    const value = `prefix-${character}`;
    const exactBytes = utf8Bytes(value);
    assert.deepEqual(limitText(value, exactBytes), { value });

    const bounded = limitText(value, exactBytes - 1);
    assert.ok(utf8Bytes(bounded.value) <= exactBytes - 1);
    assert.equal(bounded.value.includes('�'), false);
    assert.deepEqual(bounded.truncation, { originalBytes: exactBytes, maxBytes: exactBytes - 1 });

    const suffixBytes = utf8Bytes('suffix');
    const suffix = limitTextSuffix(`${character}suffix`, suffixBytes);
    assert.equal(suffix, 'suffix');
    assert.ok(utf8Bytes(suffix) <= suffixBytes);
    assert.equal(suffix.includes('�'), false);
  }
  assert.throws(() => limitText('x', 0.5), /non-negative safe integer/);
  assert.throws(() => limitTextSuffix('x', -1), /non-negative safe integer/);
});

test('Job and Orchestration admission enforce shared prompt, metadata size, and metadata depth limits', async () => {
  const directory = await workspace();
  const jobs = orchestrator(async () => ({ output: 'ok' }));
  const orchestrations = new OrchestrationService({
    config: config.delegation!,
    jobs,
    store: new MemoryOrchestrationStore(),
  });
  const tooLargePrompt = 'x'.repeat(MAX_PROMPT_BYTES + 1);
  const tooLargeMetadata = { value: 'x'.repeat(MAX_METADATA_BYTES) };
  let tooDeepMetadata: Record<string, unknown> = {};
  for (let depth = 0; depth < MAX_METADATA_DEPTH; depth += 1) {
    tooDeepMetadata = { child: tooDeepMetadata };
  }

  await assert.rejects(
    jobs.start({ prompt: tooLargePrompt, workspace: directory }),
    /Job prompt is 65537 bytes; maximum is 65536 bytes/
  );
  await assert.rejects(
    orchestrations.start({ prompt: tooLargePrompt, workspace: directory, assessment }),
    /Orchestration prompt is 65537 bytes; maximum is 65536 bytes/
  );
  for (const metadata of [tooLargeMetadata, tooDeepMetadata]) {
    await assert.rejects(jobs.start({ prompt: 'bounded', workspace: directory, metadata }));
    await assert.rejects(
      orchestrations.start({ prompt: 'bounded', workspace: directory, assessment, metadata })
    );
  }
  assert.deepEqual(await jobs.list(), []);
  assert.deepEqual(await orchestrations.list(), []);
});

test('worker output is truncated on a UTF-8 boundary with explicit terminal evidence', async () => {
  const directory = await workspace();
  const original = `${'x'.repeat(MAX_RESULT_OUTPUT_BYTES - 1)}€`;
  const job = await orchestrator(async () => ({
    output: original,
    metadata: { payload: 'x'.repeat(MAX_METADATA_BYTES) },
  })).run({
    prompt: 'bound output',
    workspace: directory,
  });

  assert.equal(job.status, 'succeeded');
  assert.equal(utf8Bytes(job.result!.output), MAX_RESULT_OUTPUT_BYTES - 1);
  assert.equal(job.result!.output.endsWith('�'), false);
  assert.deepEqual(job.result!.outputTruncation, {
    originalBytes: MAX_RESULT_OUTPUT_BYTES + 2,
    maxBytes: MAX_RESULT_OUTPUT_BYTES,
  });
  assert.deepEqual(job.result!.metadata, {
    agentknotRecordLimit: {
      field: 'result.metadata',
      action: 'replaced',
      originalBytes: MAX_METADATA_BYTES + 19,
      maxBytes: MAX_METADATA_BYTES,
    },
  });
});

test('adapter error messages are bounded while retaining visible truncation evidence', async () => {
  const directory = await workspace();
  const job = await orchestrator(async () => {
    throw new Error('€'.repeat(MAX_ERROR_MESSAGE_BYTES));
  }).run({ prompt: 'bound error', workspace: directory });

  assert.equal(job.status, 'failed');
  assert.ok(utf8Bytes(job.error!.message) <= MAX_ERROR_MESSAGE_BYTES);
  assert.match(job.error!.message, /\[AgentKnot truncated error message from 49152 bytes\]$/);
});

test('worker event payloads and event count are bounded with one durable truncation event', async () => {
  const directory = await workspace();
  const job = await orchestrator(async (_input, emit) => {
    await emit('worker.raw', { payload: 'x'.repeat(MAX_EVENT_DATA_BYTES) });
    for (let index = 1; index < MAX_WORKER_EVENTS + 2; index += 1) {
      await emit('worker.raw', { index });
    }
    return { output: 'ok' };
  }).run({ prompt: 'bound events', workspace: directory });

  const workerEvents = job.events.filter((event) => event.type.startsWith('worker.'));
  const truncationEvents = job.events.filter(
    (event) => event.type === 'job.worker.events.truncated'
  );
  assert.equal(workerEvents.length, MAX_WORKER_EVENTS);
  assert.equal(truncationEvents.length, 1);
  assert.deepEqual(truncationEvents[0]!.data, {
    maxEvents: MAX_WORKER_EVENTS,
    firstDroppedEventType: 'worker.raw',
  });
  assert.deepEqual(workerEvents[0]!.data, {
    agentknotRecordLimit: {
      field: 'event.data',
      action: 'replaced',
      originalBytes: MAX_EVENT_DATA_BYTES + 19,
      maxBytes: MAX_EVENT_DATA_BYTES,
    },
  });
});

test('non-serializable adapter event and result objects are replaced with bounded evidence', async () => {
  const directory = await workspace();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const job = await orchestrator(async (_input, emit) => {
    await emit('worker.raw', circular);
    return { output: 'ok', metadata: circular };
  }).run({ prompt: 'normalize objects', workspace: directory });
  const evidence = {
    agentknotRecordLimit: {
      action: 'replaced',
      reason: 'not-json-serializable',
    },
  };
  const eventLimit = job.events.find((event) => event.type === 'worker.raw')?.data
    ?.agentknotRecordLimit as Record<string, unknown>;
  const metadataLimit = job.result?.metadata?.agentknotRecordLimit as Record<string, unknown>;

  assert.deepEqual(
    { agentknotRecordLimit: { action: eventLimit.action, reason: eventLimit.reason } },
    evidence
  );
  assert.deepEqual(
    { agentknotRecordLimit: { action: metadataLimit.action, reason: metadataLimit.reason } },
    evidence
  );
});

test('oversized structured worker reports are rejected without retaining them in terminal records', async () => {
  const directory = await workspace();
  const job = await orchestrator(async () => ({
    output: 'ok',
    completionReport: {
      schemaVersion: 1,
      taskOutcome: 'completed',
      changedFiles: [],
      checksRun: [],
      remainingRisks: [],
      notes: ['x'.repeat(MAX_WORKER_COMPLETION_REPORT_BYTES)],
    },
  })).run({ prompt: 'bound report', workspace: directory });

  assert.deepEqual(job.completionSummary!.workerReported, {
    status: 'unavailable',
    reason: 'malformed',
  });
});

test('memory and file stores reject oversized Job and Orchestration snapshots before mutation', async () => {
  const directory = await workspace();
  const now = new Date(0).toISOString();
  const oversized = 'x'.repeat(MAX_JOB_RECORD_BYTES);
  const job: JobRecord = {
    id: 'job_oversized',
    schemaVersion: 1,
    status: 'queued',
    request: { prompt: 'test', workspace: directory, metadata: { oversized } },
    route: {
      name: 'test',
      worker: 'test',
      provider: 'test',
      model: 'test',
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 1,
    },
    createdAt: now,
    updatedAt: now,
    attempt: 0,
    events: [],
  };
  const orchestration: OrchestrationRecord = {
    id: 'orchestration_oversized',
    schemaVersion: 1,
    status: 'queued',
    request: { prompt: 'test', workspace: directory, assessment, metadata: { oversized } },
    policy: config.delegation!,
    createdAt: now,
    updatedAt: now,
    execution: { runtimeId: 'test', pid: process.pid, startedAt: now },
    events: [],
    children: [],
  };

  const memoryJobs = new MemoryJobStore();
  const fileJobs = new FileJobStore(path.join(directory, 'jobs'));
  const memoryOrchestrations = new MemoryOrchestrationStore();
  const fileOrchestrations = new FileOrchestrationStore(path.join(directory, 'orchestrations'));
  await assert.rejects(memoryJobs.create(job), /Job record is .* maximum is 16777216 bytes/);
  await assert.rejects(fileJobs.create(job), /Job record is .* maximum is 16777216 bytes/);
  await assert.rejects(
    memoryOrchestrations.create(orchestration),
    /Orchestration record is .* maximum is 16777216 bytes/
  );
  await assert.rejects(
    fileOrchestrations.create(orchestration),
    /Orchestration record is .* maximum is 16777216 bytes/
  );
  assert.deepEqual(await memoryJobs.list(), []);
  assert.deepEqual(await memoryOrchestrations.list(), []);

  const admittedJob: JobRecord = {
    ...job,
    id: 'job_save_boundary',
    request: { prompt: 'last good Job', workspace: directory },
  };
  const rejectedJob: JobRecord = {
    ...admittedJob,
    request: { ...admittedJob.request, metadata: { oversized } },
  };
  await memoryJobs.create(admittedJob);
  await fileJobs.create(admittedJob);
  const jobBytes = await readFile(path.join(directory, 'jobs', `${admittedJob.id}.json`));
  await assert.rejects(memoryJobs.save(rejectedJob), /Job record is .* maximum is 16777216 bytes/);
  await assert.rejects(fileJobs.save(rejectedJob), /Job record is .* maximum is 16777216 bytes/);
  assert.deepEqual(await memoryJobs.get(admittedJob.id), admittedJob);
  assert.deepEqual(await fileJobs.get(admittedJob.id), admittedJob);
  assert.deepEqual(await readFile(path.join(directory, 'jobs', `${admittedJob.id}.json`)), jobBytes);
  assert.deepEqual(await readdir(path.join(directory, 'jobs')), [`${admittedJob.id}.json`]);

  const admittedOrchestration: OrchestrationRecord = {
    ...orchestration,
    id: 'orchestration_save_boundary',
    request: { prompt: 'last good Orchestration', workspace: directory, assessment },
  };
  const rejectedOrchestration: OrchestrationRecord = {
    ...admittedOrchestration,
    request: { ...admittedOrchestration.request, metadata: { oversized } },
  };
  await memoryOrchestrations.create(admittedOrchestration);
  await fileOrchestrations.create(admittedOrchestration);
  const orchestrationBytes = await readFile(
    path.join(directory, 'orchestrations', `${admittedOrchestration.id}.json`)
  );
  await assert.rejects(
    memoryOrchestrations.save(rejectedOrchestration),
    /Orchestration record is .* maximum is 16777216 bytes/
  );
  await assert.rejects(
    fileOrchestrations.save(rejectedOrchestration),
    /Orchestration record is .* maximum is 16777216 bytes/
  );
  assert.deepEqual(await memoryOrchestrations.get(admittedOrchestration.id), admittedOrchestration);
  assert.deepEqual(await fileOrchestrations.get(admittedOrchestration.id), admittedOrchestration);
  assert.deepEqual(
    await readFile(path.join(directory, 'orchestrations', `${admittedOrchestration.id}.json`)),
    orchestrationBytes
  );
  assert.deepEqual(await readdir(path.join(directory, 'orchestrations')), [
    `${admittedOrchestration.id}.json`,
  ]);
});

test('callback delivery is skipped when the independently serialized body exceeds its budget', async () => {
  const directory = await workspace();
  let fetchCalls = 0;
  const fakeFetch: typeof globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 204 });
  };
  const callbackUrl = `https://example.test/${'x'.repeat(9 * 1024 * 1024)}`;
  const store = new MemoryJobStore();
  const job = await orchestrator(async () => ({ output: 'ok' }), {
    fetch: fakeFetch,
    store,
  }).run({
    prompt: 'bound callback',
    workspace: directory,
    callbackUrl,
  });

  assert.equal(fetchCalls, 0);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.callback?.delivered, false);
  assert.match(job.callback?.error ?? '', /Callback payload is .* maximum is 8388608 bytes/);
  assert.deepEqual(await store.get(job.id), job);
});

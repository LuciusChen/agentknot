import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createAdapters } from '../src/adapters/index.js';
import { resolveDelegationConfig, type AgentKnotConfig } from '../src/config.js';
import { OrchestrationService } from '../src/orchestration.js';
import { FileOrchestrationStore } from '../src/orchestration-store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { FileJobStore } from '../src/store.js';

const config: AgentKnotConfig = {
  version: 1,
  defaultRoute: 'mock',
  storage: { directory: '.agentknot/jobs' },
  workers: { mock: { adapter: 'mock', responsePrefix: 'done' } },
  routes: {
    mock: { worker: 'mock', provider: 'mock-provider', model: 'mock-model' },
  },
};

const timestamp = '2026-08-10T00:00:00.000Z';
const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })));
});

function legacyJob(id: string): Record<string, unknown> {
  return {
    id,
    status: 'succeeded',
    request: { prompt: 'legacy job', workspace: '/tmp/legacy-workspace', source: 'test' },
    route: {
      name: 'mock',
      worker: 'mock',
      provider: 'mock-provider',
      model: 'mock-model',
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 30_000,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    attempt: 1,
    events: [],
    result: {
      output: 'legacy output',
      attempt: 1,
      worker: 'mock',
      provider: 'mock-provider',
      model: 'mock-model',
    },
  };
}

function legacyOrchestration(id: string): Record<string, unknown> {
  return {
    id,
    status: 'succeeded',
    request: { prompt: 'legacy orchestration', workspace: '/tmp/legacy-workspace', source: 'test' },
    policy: {
      mode: 'off',
      planner: { strategy: 'hybrid', route: 'mock' },
      dispatch: { defaultRoute: 'mock', maxChildren: 2, maxDepth: 1, maxConcurrency: 2 },
      policy: { delegate: ['documentation'], keepUpstream: ['product-decision'] },
      fallback: 'upstream',
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    execution: { runtimeId: 'runtime_legacy', pid: 1, startedAt: timestamp },
    events: [],
    children: [],
    result: { action: 'upstream', children: [] },
  };
}

async function writeSnapshot(directory: string, id: string, record: unknown): Promise<Buffer> {
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  await writeFile(path.join(directory, `${id}.json`), bytes);
  return bytes;
}

async function assertFailedReadsPreserveSnapshot(
  store: FileJobStore | FileOrchestrationStore,
  directory: string,
  id: string,
  before: Buffer,
  expectedMessage: string
): Promise<void> {
  const snapshotPath = path.join(directory, `${id}.json`);
  for (const read of [() => store.get(id), () => store.list()]) {
    await assert.rejects(read(), (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message, expectedMessage);
      return true;
    });
    assert.deepEqual(await readFile(snapshotPath), before);
  }
}

test('new Job and Orchestration records persist schemaVersion 1', async () => {
  const directory = await createTemporaryDirectory('agentknot-record-versioning-new-');
  const workspace = await mkdtemp(path.join(directory, 'workspace-'));
  const jobsDirectory = path.join(directory, 'jobs');
  const jobStore = new FileJobStore(jobsDirectory);
  const jobs = new Orchestrator({ config, store: jobStore, adapters: createAdapters(config) });

  const job = await jobs.run({ prompt: 'create a versioned job', workspace, source: 'test' });
  assert.equal(job.schemaVersion, 1);
  assert.equal((await jobStore.get(job.id))?.schemaVersion, 1);
  assert.equal(
    (JSON.parse(await readFile(path.join(jobsDirectory, `${job.id}.json`), 'utf8')) as { schemaVersion?: unknown })
      .schemaVersion,
    1
  );

  const orchestrationsDirectory = path.join(directory, 'orchestrations');
  const orchestrationStore = new FileOrchestrationStore(orchestrationsDirectory);
  const orchestrations = new OrchestrationService({
    config: resolveDelegationConfig(config),
    jobs,
    store: orchestrationStore,
  });

  const orchestration = await orchestrations.run({
    prompt: 'create a versioned orchestration',
    workspace,
    source: 'test',
  });
  assert.equal(orchestration.schemaVersion, 1);
  assert.equal((await orchestrationStore.get(orchestration.id))?.schemaVersion, 1);
  assert.equal(
    (
      JSON.parse(
        await readFile(path.join(orchestrationsDirectory, `${orchestration.id}.json`), 'utf8')
      ) as { schemaVersion?: unknown }
    ).schemaVersion,
    1
  );
});

test('FileJobStore materializes a legacy v1 record without rewriting read-only access', async () => {
  const directory = await createTemporaryDirectory('agentknot-record-versioning-legacy-job-');
  const id = 'job_legacy_v1';
  const before = await writeSnapshot(directory, id, legacyJob(id));
  const store = new FileJobStore(directory);

  assert.equal((await store.get(id))?.schemaVersion, 1);
  assert.deepEqual(await readFile(path.join(directory, `${id}.json`)), before);
  assert.equal((await store.list())[0]?.schemaVersion, 1);
  assert.deepEqual(await readFile(path.join(directory, `${id}.json`)), before);
});

test('FileOrchestrationStore materializes a legacy v1 record without rewriting read-only access', async () => {
  const directory = await createTemporaryDirectory('agentknot-record-versioning-legacy-orchestration-');
  const id = 'orchestration_legacy_v1';
  const before = await writeSnapshot(directory, id, legacyOrchestration(id));
  const store = new FileOrchestrationStore(directory);

  assert.equal((await store.get(id))?.schemaVersion, 1);
  assert.deepEqual(await readFile(path.join(directory, `${id}.json`)), before);
  assert.equal((await store.list())[0]?.schemaVersion, 1);
  assert.deepEqual(await readFile(path.join(directory, `${id}.json`)), before);
});

test('FileJobStore rejects a non-object snapshot without rewriting it', async () => {
  const directory = await createTemporaryDirectory('agentknot-record-versioning-invalid-job-');
  const id = 'job_invalid_snapshot';
  const before = await writeSnapshot(directory, id, null);
  const store = new FileJobStore(directory);

  await assertFailedReadsPreserveSnapshot(
    store,
    directory,
    id,
    before,
    'Invalid persisted Job record: expected an object'
  );
});

test('FileOrchestrationStore rejects a non-object snapshot without rewriting it', async () => {
  const directory = await createTemporaryDirectory('agentknot-record-versioning-invalid-orchestration-');
  const id = 'orchestration_invalid_snapshot';
  const before = await writeSnapshot(directory, id, null);
  const store = new FileOrchestrationStore(directory);

  await assertFailedReadsPreserveSnapshot(
    store,
    directory,
    id,
    before,
    'Invalid persisted Orchestration record: expected an object'
  );
});

test('FileJobStore rejects a structured schemaVersion without exposing nested content', async () => {
  const directory = await createTemporaryDirectory('agentknot-record-versioning-structured-job-');
  const id = 'job_structured_schema_version';
  const before = await writeSnapshot(directory, id, {
    ...legacyJob(id),
    schemaVersion: { version: 2, details: { secret: 'job-secret-must-not-leak' } },
  });
  const store = new FileJobStore(directory);

  await assertFailedReadsPreserveSnapshot(
    store,
    directory,
    id,
    before,
    'Unsupported Job schemaVersion <object>; supported schemaVersion is 1'
  );
});

test('FileOrchestrationStore rejects a structured schemaVersion without exposing nested content', async () => {
  const directory = await createTemporaryDirectory('agentknot-record-versioning-structured-orchestration-');
  const id = 'orchestration_structured_schema_version';
  const before = await writeSnapshot(directory, id, {
    ...legacyOrchestration(id),
    schemaVersion: { version: 2, details: { secret: 'orchestration-secret-must-not-leak' } },
  });
  const store = new FileOrchestrationStore(directory);

  await assertFailedReadsPreserveSnapshot(
    store,
    directory,
    id,
    before,
    'Unsupported Orchestration schemaVersion <object>; supported schemaVersion is 1'
  );
});

test('FileJobStore rejects an unsupported explicit schemaVersion', async () => {
  const directory = await createTemporaryDirectory('agentknot-record-versioning-unsupported-job-');
  const id = 'job_unsupported_v2';
  const before = await writeSnapshot(directory, id, { ...legacyJob(id), schemaVersion: 2 });
  const store = new FileJobStore(directory);

  await assertFailedReadsPreserveSnapshot(
    store,
    directory,
    id,
    before,
    'Unsupported Job schemaVersion 2; supported schemaVersion is 1'
  );
});

test('FileOrchestrationStore rejects an unsupported explicit schemaVersion', async () => {
  const directory = await createTemporaryDirectory('agentknot-record-versioning-unsupported-orchestration-');
  const id = 'orchestration_unsupported_v2';
  const before = await writeSnapshot(directory, id, { ...legacyOrchestration(id), schemaVersion: 2 });
  const store = new FileOrchestrationStore(directory);

  await assertFailedReadsPreserveSnapshot(
    store,
    directory,
    id,
    before,
    'Unsupported Orchestration schemaVersion 2; supported schemaVersion is 1'
  );
});

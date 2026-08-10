import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdapters } from '../src/adapters/index.js';
import { parseConfig, resolveDelegationConfig, type AgentKnotConfig } from '../src/config.js';
import type { TaskAssessment } from '../src/orchestration-types.js';
import { OrchestrationService } from '../src/orchestration.js';
import { MemoryOrchestrationStore } from '../src/orchestration-store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { AgentKnotRuntime, createRuntime } from '../src/runtime.js';
import { MemoryJobStore } from '../src/store.js';

function modeOffConfig(): AgentKnotConfig {
  return parseConfig({
    version: 1,
    defaultRoute: 'mock',
    storage: { directory: 'jobs', orchestrationDirectory: 'orchestrations' },
    workers: { mock: { adapter: 'mock' } },
    routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
    delegation: { mode: 'off' },
  });
}

const assessment: TaskAssessment = {
  schemaVersion: 1,
  recommendation: 'do-not-delegate',
  complexity: 'low',
  parallelizable: false,
  taskKinds: [],
  reasoning: 'Keep this bounded controller task upstream.',
  subtasks: [],
};

function directRuntime(config: AgentKnotConfig): AgentKnotRuntime {
  const jobs = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: createAdapters(config),
  });
  const orchestrations = new OrchestrationService({
    config: resolveDelegationConfig(config),
    jobs,
    store: new MemoryOrchestrationStore(),
  });
  return new AgentKnotRuntime(jobs, orchestrations);
}

test('AgentKnotRuntime and createRuntime expose compatible mode-off public behavior', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-public-runtime-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  const configPath = path.join(directory, 'agentknot.config.json');
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        defaultRoute: 'mock',
        storage: { directory: 'jobs', orchestrationDirectory: 'orchestrations' },
        workers: { mock: { adapter: 'mock' } },
        routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
        delegation: { mode: 'off' },
      },
      null,
      2
    )}\n`
  );

  const constructed = directRuntime(modeOffConfig());
  const created = await createRuntime({ configPath });
  try {
    assert.ok(created instanceof AgentKnotRuntime);
    assert.deepEqual(created.routes(), constructed.routes());
    assert.deepEqual(created.delegationPolicy(), constructed.delegationPolicy());
    assert.deepEqual(await created.doctor(), await constructed.doctor());
    assert.deepEqual(await created.list(), await constructed.list());
    assert.deepEqual(await created.listOrchestrations(), await constructed.listOrchestrations());

    const request = {
      prompt: 'Use the upstream path.',
      workspace,
      source: 'test',
      assessment,
    };
    const constructedRecord = await constructed.orchestrate(request);
    const createdRecord = await created.orchestrate(request);

    for (const record of [constructedRecord, createdRecord]) {
      assert.equal(record.status, 'succeeded');
      assert.equal(record.request.workspace, workspace);
      assert.equal(record.request.source, 'test');
      assert.deepEqual(record.request.assessment, assessment);
      assert.equal(record.plan?.mode, 'off');
      assert.equal(record.plan?.willDispatch, false);
      assert.equal(record.result?.action, 'upstream');
      assert.deepEqual(record.children, []);
    }
    assert.deepEqual(
      createdRecord.events.map((event) => event.type),
      constructedRecord.events.map((event) => event.type)
    );
  } finally {
    await created.close();
  }
});

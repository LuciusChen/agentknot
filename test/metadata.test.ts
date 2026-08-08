import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdapters } from '../src/adapters/index.js';
import type { AgentKnotConfig } from '../src/config.js';
import { createAgentKnotHttpServer } from '../src/http-server.js';
import { OrchestrationService } from '../src/orchestration.js';
import { MemoryOrchestrationStore } from '../src/orchestration-store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { AgentKnotRuntime } from '../src/runtime.js';
import { MemoryJobStore } from '../src/store.js';

const config: AgentKnotConfig = {
  version: 1,
  defaultRoute: 'mock',
  storage: { directory: '.agentknot/jobs' },
  workers: { mock: { adapter: 'mock' } },
  routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
  delegation: {
    mode: 'off',
    planner: { strategy: 'hybrid', route: 'mock' },
    dispatch: { defaultRoute: 'mock', maxChildren: 2, maxDepth: 1, maxConcurrency: 1 },
    policy: { delegate: ['documentation'], keepUpstream: ['commit', 'push'] },
    fallback: 'upstream',
  },
};

const invalidMetadataValues: unknown[] = [
  [],
  null,
  'metadata',
  42,
  { undefinedValue: undefined },
  { nonFinite: Number.NaN },
  { date: new Date(0) },
  { bigint: 1n },
  { symbol: Symbol('metadata') },
];

function asMetadata(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'agentknot-metadata-'));
}

function createOrchestrator(): Orchestrator {
  return new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: createAdapters(config),
  });
}

test('leaf Job TypeScript boundary rejects non-JSON-compatible metadata before admission', async () => {
  const workspace = await createWorkspace();
  const orchestrator = createOrchestrator();

  for (const metadata of invalidMetadataValues) {
    await assert.rejects(
      orchestrator.start({ prompt: 'validate metadata', workspace, metadata: asMetadata(metadata) }),
      /metadata must be a JSON-compatible object/
    );
  }
  assert.deepEqual(await orchestrator.list(), []);
});

test('Orchestration TypeScript boundary rejects the same non-JSON-compatible metadata values', async () => {
  const workspace = await createWorkspace();
  const orchestrations = new OrchestrationService({
    config: config.delegation!,
    jobs: createOrchestrator(),
    store: new MemoryOrchestrationStore(),
  });

  for (const metadata of invalidMetadataValues) {
    await assert.rejects(
      orchestrations.start({ prompt: 'validate metadata', workspace, metadata: asMetadata(metadata) }),
      /metadata must be a JSON-compatible object/
    );
  }
  assert.deepEqual(await orchestrations.list(), []);
});

test('HTTP Job and Orchestration boundaries reject non-object metadata consistently', async () => {
  const workspace = await createWorkspace();
  const jobs = createOrchestrator();
  const orchestrations = new OrchestrationService({
    config: config.delegation!,
    jobs,
    store: new MemoryOrchestrationStore(),
  });
  const http = createAgentKnotHttpServer(new AgentKnotRuntime(jobs, orchestrations));
  const address = await http.listen(0);
  const baseUrl = `http://${address.host}:${address.port}`;
  const invalidHttpMetadata = [[], null, 'metadata', 42];

  try {
    for (const metadata of invalidHttpMetadata) {
      for (const endpoint of ['/v1/jobs', '/v1/orchestrations']) {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'validate metadata', workspace, metadata }),
        });
        assert.equal(response.status, 400, endpoint);
        const body = (await response.json()) as { error: string };
        assert.equal(body.error, 'metadata must be a JSON-compatible object');
      }
    }
  } finally {
    await http.close();
  }
});

test('JSON-compatible metadata remains available through the leaf TypeScript boundary', async () => {
  const workspace = await createWorkspace();
  const metadata = {
    owner: 'controller',
    values: [null, true, 3.5, { nested: 'value' }],
  };
  const job = await createOrchestrator().run({ prompt: 'preserve metadata', workspace, metadata });

  assert.equal(job.status, 'succeeded');
  assert.deepEqual(job.request.metadata, metadata);
});

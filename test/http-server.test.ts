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

test('HTTP API accepts work from a vendor-neutral controller and exposes the result', async () => {
  const config: AgentKnotConfig = {
    version: 1,
    defaultRoute: 'mock',
    storage: { directory: '.agentknot/jobs' },
    workers: { mock: { adapter: 'mock', delayMs: 5 } },
    routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
  };
  const orchestrator = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: createAdapters(config),
  });
  const http = createAgentKnotHttpServer(orchestrator);
  const address = await http.listen(0);
  const baseUrl = `http://${address.host}:${address.port}`;
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-http-'));

  try {
    const createdResponse = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'http task', workspace, source: 'codex' }),
    });
    assert.equal(createdResponse.status, 202);
    const created = (await createdResponse.json()) as { job: { id: string } };

    let status = 'queued';
    for (let attempt = 0; attempt < 20 && status !== 'succeeded'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const response = await fetch(`${baseUrl}/v1/jobs/${created.job.id}`);
      const body = (await response.json()) as { job: { status: string } };
      status = body.job.status;
    }
    assert.equal(status, 'succeeded');
  } finally {
    await http.close();
  }
});

test('HTTP API exposes controller-neutral orchestration policy and durable orchestration state', async () => {
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
  const jobs = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: createAdapters(config),
  });
  const orchestrations = new OrchestrationService({
    config: config.delegation!,
    jobs,
    store: new MemoryOrchestrationStore(),
  });
  const http = createAgentKnotHttpServer(new AgentKnotRuntime(jobs, orchestrations));
  const address = await http.listen(0);
  const baseUrl = `http://${address.host}:${address.port}`;
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-http-orchestration-'));

  try {
    const policyResponse = await fetch(`${baseUrl}/v1/delegation`);
    assert.equal(policyResponse.status, 200);
    const policy = (await policyResponse.json()) as { delegation: { mode: string } };
    assert.equal(policy.delegation.mode, 'off');

    const createdResponse = await fetch(`${baseUrl}/v1/orchestrations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Coordinate this task.', workspace, source: 'claude' }),
    });
    assert.equal(createdResponse.status, 202);
    const created = (await createdResponse.json()) as { orchestration: { id: string } };

    let terminal: { status: string; result?: { action: string } } | undefined;
    for (let attempt = 0; attempt < 20 && terminal?.status !== 'succeeded'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const response = await fetch(`${baseUrl}/v1/orchestrations/${created.orchestration.id}`);
      terminal = ((await response.json()) as { orchestration: typeof terminal }).orchestration;
    }
    assert.equal(terminal?.status, 'succeeded');
    assert.equal(terminal?.result?.action, 'upstream');

    const eventsResponse = await fetch(
      `${baseUrl}/v1/orchestrations/${created.orchestration.id}/events`
    );
    const events = (await eventsResponse.json()) as { events: Array<{ type: string }> };
    assert.equal(events.events.at(-1)?.type, 'orchestration.succeeded');
  } finally {
    await http.close();
  }
});

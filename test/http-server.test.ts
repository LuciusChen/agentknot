import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdapters } from '../src/adapters/index.js';
import type { AgentKnotConfig } from '../src/config.js';
import { createAgentKnotHttpServer } from '../src/http-server.js';
import { Orchestrator } from '../src/orchestrator.js';
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

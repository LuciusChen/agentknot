import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createAdapters } from '../src/adapters/index.js';
import type { AgentKnotConfig } from '../src/config.js';
import { createAgentKnotHttpServer } from '../src/http-server.js';
import type { AgentKnotHttpRuntime } from '../src/http-server.js';
import { OrchestrationService } from '../src/orchestration.js';
import { MemoryOrchestrationStore } from '../src/orchestration-store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { AgentKnotRuntime } from '../src/runtime.js';
import { MemoryJobStore } from '../src/store.js';

const execFileAsync = promisify(execFile);

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: directory, encoding: 'utf8' });
  return String(result.stdout);
}

test('HTTP liveness endpoints are identical, leave readiness absent, and do not access the runtime', async () => {
  const runtimeAccesses: string[] = [];
  const runtime: AgentKnotHttpRuntime = {
    routes() {
      runtimeAccesses.push('routes');
      return [];
    },
    async get() {
      runtimeAccesses.push('get');
      return undefined;
    },
    async list() {
      runtimeAccesses.push('list');
      return [];
    },
    async listArtifacts() {
      runtimeAccesses.push('listArtifacts');
      return undefined;
    },
    async verifyArtifacts() {
      runtimeAccesses.push('verifyArtifacts');
      return undefined;
    },
    async previewArtifact() {
      runtimeAccesses.push('previewArtifact');
      return undefined;
    },
    async start() {
      runtimeAccesses.push('start');
      throw new Error('runtime start must not be called by health handling');
    },
    delegationPolicy() {
      runtimeAccesses.push('delegationPolicy');
      throw new Error('runtime delegation policy must not be called by health handling');
    },
    async getOrchestration() {
      runtimeAccesses.push('getOrchestration');
      return undefined;
    },
    async listOrchestrations() {
      runtimeAccesses.push('listOrchestrations');
      return [];
    },
    async startOrchestration() {
      runtimeAccesses.push('startOrchestration');
      throw new Error('runtime orchestration start must not be called by health handling');
    },
  };
  const guardedRuntime = new Proxy(runtime, {
    get(_target, property) {
      runtimeAccesses.push(String(property));
      throw new Error(`runtime property ${String(property)} must not be accessed by health handling`);
    },
  });
  const http = createAgentKnotHttpServer(guardedRuntime);
  const address = await http.listen(0);
  const baseUrl = `http://${address.host}:${address.port}`;

  try {
    const [liveResponse, aliasResponse, readyResponse] = await Promise.all([
      fetch(`${baseUrl}/health/live`),
      fetch(`${baseUrl}/health`),
      fetch(`${baseUrl}/health/ready`),
    ]);
    assert.equal(liveResponse.status, 200);
    assert.equal(aliasResponse.status, 200);
    assert.equal(readyResponse.status, 404);

    const liveBody = await liveResponse.text();
    const aliasBody = await aliasResponse.text();
    assert.equal(liveBody, aliasBody);
    assert.deepEqual(JSON.parse(liveBody) as unknown, {
      ok: true,
      service: 'agentknot',
      status: 'live',
      checks: {
        storage: 'not-checked',
        routes: 'not-checked',
        inference: 'not-checked',
      },
    });
    assert.deepEqual(JSON.parse(await readyResponse.text()) as unknown, { error: 'Not found' });
    assert.deepEqual(runtimeAccesses, []);
  } finally {
    await http.close();
  }
});

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

test('HTTP API lists, verifies, and previews artifacts without applying them', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'agentknot-http-artifact-source-'));
  const storage = await mkdtemp(path.join(os.tmpdir(), 'agentknot-http-artifact-storage-'));
  const worktrees = await mkdtemp(path.join(os.tmpdir(), 'agentknot-http-artifact-worktrees-'));
  await git(source, 'init', '-q');
  await git(source, 'config', 'user.email', 'agentknot-test@example.invalid');
  await git(source, 'config', 'user.name', 'AgentKnot test');
  await writeFile(path.join(source, 'README.md'), 'base\n');
  await git(source, 'add', '--', '.');
  await git(source, 'commit', '-qm', 'base');
  const sourceHead = (await git(source, 'rev-parse', 'HEAD')).trim();
  const config: AgentKnotConfig = {
    version: 1,
    defaultRoute: 'mock',
    storage: { directory: storage },
    workspaceIsolation: { mode: 'git-worktree', directory: worktrees },
    workers: { mock: { adapter: 'mock' } },
    routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
  };
  const jobs = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: createAdapters(config),
  });
  const http = createAgentKnotHttpServer(jobs);
  const address = await http.listen(0);
  const baseUrl = `http://${address.host}:${address.port}`;

  try {
    const createdResponse = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'http artifact task', workspace: source }),
    });
    assert.equal(createdResponse.status, 202);
    const created = (await createdResponse.json()) as { job: { id: string } };

    let terminal: { status: string } | undefined;
    for (let attempt = 0; attempt < 40 && terminal?.status !== 'succeeded'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const response = await fetch(`${baseUrl}/v1/jobs/${created.job.id}`);
      terminal = ((await response.json()) as { job: typeof terminal }).job;
    }
    assert.equal(terminal?.status, 'succeeded');

    const listedResponse = await fetch(`${baseUrl}/v1/jobs/${created.job.id}/artifacts`);
    assert.equal(listedResponse.status, 200);
    const listed = (await listedResponse.json()) as { jobId: string; artifacts: unknown[] };
    assert.equal(listed.jobId, created.job.id);
    assert.equal(listed.artifacts.length, 1);

    const verifiedResponse = await fetch(`${baseUrl}/v1/jobs/${created.job.id}/artifacts/verify`);
    assert.equal(verifiedResponse.status, 200);
    const verified = (await verifiedResponse.json()) as {
      valid: boolean;
      artifacts: Array<{ valid: boolean; issues: string[] }>;
    };
    assert.equal(verified.valid, true);
    assert.equal(verified.artifacts[0]?.valid, true);
    assert.deepEqual(verified.artifacts[0]?.issues, []);

    const previewResponse = await fetch(`${baseUrl}/v1/jobs/${created.job.id}/artifacts/1/preview`);
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as {
      content: string | null;
      truncated: boolean;
      verification: { valid: boolean };
    };
    assert.equal(preview.content, '');
    assert.equal(preview.truncated, false);
    assert.equal(preview.verification.valid, true);
    assert.equal((await git(source, 'rev-parse', 'HEAD')).trim(), sourceHead);
    assert.equal(await git(source, 'status', '--porcelain=v1', '--untracked-files=all'), '');

    const missing = await fetch(`${baseUrl}/v1/jobs/${created.job.id}/artifacts/2/preview`);
    assert.equal(missing.status, 404);
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

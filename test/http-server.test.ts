import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { createAdapters } from '../src/adapters/index.js';
import type { AgentKnotConfig } from '../src/config.js';
import { AgentKnotHttpClient, type AgentKnotWaitUpdate } from '../src/http-client.js';
import { createAgentKnotHttpServer } from '../src/http-server.js';
import type { AgentKnotHttpRuntime } from '../src/http-server.js';
import { buildJobList, MAX_JOB_LIST_RESPONSE_BYTES } from '../src/job-list.js';
import { OrchestrationService } from '../src/orchestration.js';
import { MemoryOrchestrationStore } from '../src/orchestration-store.js';
import type {
  OrchestrationRecord,
  OrchestrationRequest,
  TaskAssessment,
} from '../src/orchestration-types.js';
import { Orchestrator } from '../src/orchestrator.js';
import { AgentKnotRuntime } from '../src/runtime.js';
import { MemoryJobStore } from '../src/store.js';
import type { JobRecord, WorkerAdapter } from '../src/types.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const upstreamAssessment: TaskAssessment = {
  schemaVersion: 1,
  recommendation: 'do-not-delegate',
  complexity: 'low',
  parallelizable: false,
  taskKinds: [],
  reasoning: 'Keep this bounded controller task upstream.',
  subtasks: [],
};

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

test('HTTP client distinguishes disconnects and reconnects only to the same admitted job', async () => {
  const now = new Date().toISOString();
  const admitted: JobRecord = {
    schemaVersion: 1,
    id: 'job_disconnect_test',
    status: 'running',
    request: { prompt: 'bounded test', workspace: '/tmp/test' },
    route: {
      name: 'mock',
      worker: 'mock',
      provider: 'mock',
      model: 'mock',
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 30_000,
    },
    createdAt: now,
    updatedAt: now,
    attempt: 1,
    events: [],
  };
  let admissions = 0;
  const waitPaths: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    if (request.method === 'POST' && request.url === '/v1/jobs') {
      admissions += 1;
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ job: admitted }));
      return;
    }
    if (request.url === `/v1/jobs/${admitted.id}/events?after=0`) {
      waitPaths.push(request.url);
      request.socket.destroy();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const client = new AgentKnotHttpClient(`http://127.0.0.1:${address.port}`);
  const updates: AgentKnotWaitUpdate[] = [];
  try {
    const initial = await client.startJob(admitted.request);
    await assert.rejects(client.waitForJob(initial, (update) => updates.push(update)), /fetch failed/);
    assert.equal(admissions, 1);
    assert.deepEqual(
      waitPaths,
      Array.from({ length: 3 }, () => `/v1/jobs/${admitted.id}/events?after=0`)
    );
    assert.deepEqual(
      updates.map((update) =>
        update.connectivity === 'disconnected' ? [update.connectivity, update.attempt] : [update.connectivity]
      ),
      [
        ['disconnected', 1],
        ['disconnected', 2],
        ['disconnected', 3],
      ]
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('HTTP client aborts one cursor follow without reconnecting or cancelling work', async () => {
  const now = new Date().toISOString();
  const admitted: JobRecord = {
    schemaVersion: 1,
    id: 'job_observer_abort',
    status: 'running',
    request: { prompt: 'bounded test', workspace: '/tmp/test' },
    route: {
      name: 'mock',
      worker: 'mock',
      provider: 'mock',
      model: 'mock',
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 30_000,
    },
    createdAt: now,
    updatedAt: now,
    attempt: 1,
    events: [],
  };
  let follows = 0;
  let markFollowStarted!: () => void;
  const followStarted = new Promise<void>((resolve) => {
    markFollowStarted = resolve;
  });
  const server = createServer((request, response) => {
    request.resume();
    if (request.method === 'POST') {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ job: admitted }));
      return;
    }
    if (request.url === `/v1/jobs/${admitted.id}/events?after=0`) {
      follows += 1;
      markFollowStarted();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const client = new AgentKnotHttpClient(`http://127.0.0.1:${address.port}`);
  const controller = new AbortController();
  try {
    const initial = await client.startJob(admitted.request);
    const observation = client.waitForJob(initial, undefined, controller.signal);
    await followStarted;
    controller.abort(new Error('stop observing'));
    await assert.rejects(observation, /stop observing/);
    assert.equal(follows, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test('HTTP client forwards the typed orchestration request unchanged', async () => {
  let received: unknown;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(`${JSON.stringify({ orchestration: { id: 'orchestration_client_test', status: 'succeeded' } })}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const request: OrchestrationRequest = {
    prompt: 'Typed client request.',
    workspace: '/tmp/controller-workspace',
    source: 'codex',
    assessment: upstreamAssessment,
    metadata: { boundary: 'controller' },
    delegation: 'suggest',
  };

  try {
    const admitted = await new AgentKnotHttpClient(
      `http://127.0.0.1:${address.port}`
    ).startOrchestration(request);
    assert.equal(admitted.id, 'orchestration_client_test');
    assert.deepEqual(received, request);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
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
  const requestedPaths: string[] = [];
  http.server.on('request', (request) => requestedPaths.push(request.url ?? ''));
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
    const created = (await createdResponse.json()) as { job: JobRecord };
    const terminal = await new AgentKnotHttpClient(baseUrl).waitForJob(created.job);
    assert.equal(terminal.status, 'succeeded');
    assert.equal((await fetch(`${baseUrl}/v1/jobs/${created.job.id}/wait`)).status, 404);
    const eventPaths = requestedPaths.filter((requestedPath) =>
      requestedPath.startsWith(`/v1/jobs/${created.job.id}/events?after=`)
    );
    assert.equal(eventPaths[0], `/v1/jobs/${created.job.id}/events?after=1`);
    assert.ok(eventPaths.length >= 1);
    assert.deepEqual(
      eventPaths.map((requestedPath) => Number(new URL(requestedPath, baseUrl).searchParams.get('after'))),
      [...eventPaths]
        .map((requestedPath) => Number(new URL(requestedPath, baseUrl).searchParams.get('after')))
        .sort((left, right) => left - right)
    );
    assert.equal(
      requestedPaths.filter((requestedPath) => requestedPath === `/v1/jobs/${created.job.id}`).length,
      0
    );
  } finally {
    await http.close();
  }
});

test('disconnecting an HTTP cursor observer does not cancel its durable Job', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-http-observer-'));
  const config: AgentKnotConfig = {
    version: 1,
    defaultRoute: 'mock',
    storage: { directory: '.agentknot/jobs' },
    workers: { mock: { adapter: 'mock', delayMs: 5_000 } },
    routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
  };
  const orchestrator = new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: createAdapters(config),
  });
  const http = createAgentKnotHttpServer(orchestrator);
  const address = await http.listen(0);
  const client = new AgentKnotHttpClient(`http://${address.host}:${address.port}`);
  const controller = new AbortController();
  try {
    const initial = await client.startJob({ prompt: 'keep running', workspace });
    const observation = client.waitForJob(initial, undefined, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('observer left'));
    await assert.rejects(observation, /observer left/);
    assert.equal((await client.getJob(initial.id))?.status, 'running');
  } finally {
    await http.close();
  }
});

test('HTTP close cancels and awaits active jobs before returning', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-http-close-'));
  const store = new MemoryJobStore();
  let runStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    runStarted = resolve;
  });
  let abortObserved!: () => void;
  const aborted = new Promise<void>((resolve) => {
    abortObserved = resolve;
  });
  let releaseRun!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const adapter: WorkerAdapter = {
    name: 'mock',
    async doctor() {
      return { ok: true, message: 'blocking adapter ready' };
    },
    async run(input) {
      runStarted();
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) resolve();
        else input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      abortObserved();
      await released;
      return { output: 'must not succeed after server close' };
    },
  };
  const closeConfig: AgentKnotConfig = {
    version: 1,
    defaultRoute: 'mock',
    storage: { directory: '.agentknot/jobs' },
    workers: { mock: { adapter: 'mock' } },
    routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock', timeoutMs: 30_000 } },
  };
  const orchestrator = new Orchestrator({
    config: closeConfig,
    store,
    adapters: new Map([['mock', adapter]]),
  });
  const http = createAgentKnotHttpServer(orchestrator);
  const address = await http.listen(0);
  const baseUrl = `http://${address.host}:${address.port}`;
  let closing: Promise<void> | undefined;
  try {
    const response = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'block until close', workspace }),
    });
    assert.equal(response.status, 202);
    const body = (await response.json()) as { job: { id: string } };
    await started;

    closing = http.close();
    await aborted;
    assert.equal(http.server.listening, true);
    assert.equal((await fetch(`${baseUrl}/health/live`)).status, 200);
    const refused = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'must not be admitted during shutdown', workspace }),
    });
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), { error: 'AgentKnot server is shutting down' });

    releaseRun();
    await closing;

    const job = await store.get(body.job.id);
    assert.equal(job?.status, 'cancelled');
    assert.equal(job?.events.at(-1)?.type, 'job.cancelled');
  } finally {
    releaseRun();
    await closing?.catch(() => undefined);
    if (http.server.listening) await http.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('HTTP job listing returns bounded summaries instead of cumulative full records', async () => {
  const largeOutput = 'x'.repeat(6 * 1024 * 1024);
  const jobs: JobRecord[] = Array.from({ length: 3 }, (_, index) => ({
    schemaVersion: 1,
    id: `job_large_${index}`,
    status: 'succeeded',
    request: { prompt: `private prompt ${index}`, workspace: '/private/workspace' },
    route: {
      name: 'mock',
      worker: 'mock',
      provider: 'mock',
      model: 'deterministic',
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 30_000,
    },
    createdAt: `2026-08-10T00:00:0${index}.000Z`,
    updatedAt: `2026-08-10T00:00:0${index}.000Z`,
    completedAt: `2026-08-10T00:00:0${index}.000Z`,
    attempt: 1,
    events: [],
    result: {
      output: largeOutput,
      attempt: 1,
      worker: 'mock',
      provider: 'mock',
      model: 'deterministic',
    },
  }));
  const runtime: AgentKnotHttpRuntime = {
    routes: () => [],
    get: async () => undefined,
    list: async () => jobs,
    listArtifacts: async () => undefined,
    verifyArtifacts: async () => undefined,
    previewArtifact: async () => undefined,
    start: async () => {
      throw new Error('listing must not start work');
    },
  };
  const http = createAgentKnotHttpServer(runtime);
  const address = await http.listen(0);
  const baseUrl = `http://${address.host}:${address.port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/jobs`);
    assert.equal(response.status, 200);
    assert.ok(Number(response.headers.get('content-length')) <= MAX_JOB_LIST_RESPONSE_BYTES);
    const page = await new AgentKnotHttpClient(baseUrl).listJobs();
    assert.equal(page.schemaVersion, 1);
    assert.equal(page.total, 3);
    assert.equal(page.truncated, false);
    assert.equal(page.jobs.length, 3);
    assert.deepEqual(page.jobs[0], {
      schemaVersion: 1,
      id: 'job_large_0',
      status: 'succeeded',
      route: 'mock',
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
      completedAt: '2026-08-10T00:00:00.000Z',
      attempt: 1,
    });
    assert.doesNotMatch(JSON.stringify(page), /private prompt|private\/workspace/);
    assert.doesNotMatch(JSON.stringify(page), /xxxx/);

    const oversizedSummaryJobs = jobs.slice(0, 2).map((job, index) => ({
      ...job,
      route: { ...job.route, name: String(index).repeat(600 * 1024) },
    }));
    const capped = buildJobList(oversizedSummaryJobs);
    assert.equal(capped.jobs.length, 1);
    assert.equal(capped.total, 2);
    assert.equal(capped.truncated, true);
    assert.ok(Buffer.byteLength(`${JSON.stringify(capped)}\n`) <= MAX_JOB_LIST_RESPONSE_BYTES);
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
      dispatch: {
        defaultRoute: 'mock',
        maxChildren: 2,
        maxDepth: 1,
        maxConcurrency: 1,
        routeSelection: {
          mode: 'active',
          rules: [{ route: 'mock', complexities: ['low'] }],
        },
      },
      policy: { delegate: ['documentation'], keepUpstream: ['commit', 'push'] },
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
  const requestedPaths: string[] = [];
  http.server.on('request', (request) => requestedPaths.push(request.url ?? ''));
  const address = await http.listen(0);
  const baseUrl = `http://${address.host}:${address.port}`;
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-http-orchestration-'));

  try {
    const policyResponse = await fetch(`${baseUrl}/v1/delegation`);
    assert.equal(policyResponse.status, 200);
    const policy = (await policyResponse.json()) as { delegation: typeof config.delegation };
    assert.deepEqual(policy.delegation, config.delegation);

    const createdResponse = await fetch(`${baseUrl}/v1/orchestrations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Coordinate this task.',
        workspace,
        source: 'claude',
        assessment: upstreamAssessment,
      }),
    });
    assert.equal(createdResponse.status, 202);
    const created = (await createdResponse.json()) as { orchestration: OrchestrationRecord };
    const terminal = await new AgentKnotHttpClient(baseUrl).waitForOrchestration(created.orchestration);
    assert.equal(terminal.status, 'succeeded');
    assert.deepEqual(terminal.request.assessment, upstreamAssessment);
    assert.equal(terminal.result?.action, 'upstream');
    assert.equal(
      (await fetch(`${baseUrl}/v1/orchestrations/${created.orchestration.id}/wait`)).status,
      404
    );
    assert.deepEqual(
      requestedPaths.filter(
        (requestedPath) =>
          requestedPath.startsWith(`/v1/orchestrations/${created.orchestration.id}/events?after=`)
      ),
      [`/v1/orchestrations/${created.orchestration.id}/events?after=1`]
    );
    assert.equal(
      requestedPaths.filter(
        (requestedPath) => requestedPath === `/v1/orchestrations/${created.orchestration.id}`
      ).length,
      0
    );

    const eventsResponse = await fetch(
      `${baseUrl}/v1/orchestrations/${created.orchestration.id}/events`
    );
    const events = (await eventsResponse.json()) as { events: Array<{ type: string }> };
    assert.equal(events.events.at(-1)?.type, 'orchestration.succeeded');
  } finally {
    await http.close();
  }
});

test('HTTP orchestration admission rejects missing or route-bearing assessments before runtime admission', async () => {
  let startCalls = 0;
  const runtime: AgentKnotHttpRuntime = {
    routes: () => [],
    get: async () => undefined,
    list: async () => [],
    listArtifacts: async () => undefined,
    verifyArtifacts: async () => undefined,
    previewArtifact: async () => undefined,
    start: async () => {
      throw new Error('job admission must not be reached');
    },
    startOrchestration: async () => {
      startCalls += 1;
      throw new Error('orchestration admission must not be reached');
    },
  };
  const http = createAgentKnotHttpServer(runtime);
  const address = await http.listen(0);
  const baseUrl = `http://${address.host}:${address.port}`;
  const post = (body: unknown): Promise<Response> =>
    fetch(`${baseUrl}/v1/orchestrations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    const missing = await post({ prompt: 'Missing assessment.', workspace: '/tmp/workspace' });
    assert.equal(missing.status, 400);
    assert.match(String((await missing.json() as { error: string }).error), /assessment is required/);

    const routeBearing = await post({
      prompt: 'Route-bearing assessment.',
      workspace: '/tmp/workspace',
      assessment: { ...upstreamAssessment, route: 'mock' },
    });
    assert.equal(routeBearing.status, 400);
    assert.match(
      String((await routeBearing.json() as { error: string }).error),
      /Controller assessment must contain exactly/
    );
    assert.equal(startCalls, 0);
  } finally {
    await http.close();
  }
});

test('two independent CLI processes share one orchestration runtime without local config access', async () => {
  const config: AgentKnotConfig = {
    version: 1,
    defaultRoute: 'mock',
    storage: { directory: '.agentknot/jobs' },
    workers: { mock: { adapter: 'mock' } },
    routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
    delegation: {
      mode: 'off',
      dispatch: { defaultRoute: 'mock', maxChildren: 2, maxDepth: 1, maxConcurrency: 1 },
      policy: { delegate: ['documentation'], keepUpstream: ['commit', 'push'] },
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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-shared-cli-'));

  try {
    const runClient = (source: 'codex' | 'claude', prompt: string) =>
      execFileAsync(
        process.execPath,
        [
          cliPath,
          'orchestrate',
          ...(source === 'codex' ? ['--server', baseUrl] : []),
          '--source',
          source,
          '--workspace',
          workspace,
          '--assessment-json',
          JSON.stringify(upstreamAssessment),
          '--handoff-json',
          '--prompt',
          prompt,
        ],
        {
          cwd: workspace,
          encoding: 'utf8',
          env: {
            ...process.env,
            AGENTKNOT_CONFIG: undefined,
            AGENTKNOT_SERVER_URL: source === 'claude' ? baseUrl : undefined,
          },
        }
      );
    const [codexResult, claudeResult] = await Promise.all([
      runClient('codex', 'Codex shared-runtime request.'),
      runClient('claude', 'Claude shared-runtime request.'),
    ]);
    const codexHandoff = JSON.parse(String(codexResult.stdout)) as {
      id: string;
      status: string;
      result?: { action: string };
    };
    const claudeHandoff = JSON.parse(String(claudeResult.stdout)) as typeof codexHandoff;
    assert.notEqual(codexHandoff.id, claudeHandoff.id);
    assert.deepEqual(
      [codexHandoff, claudeHandoff].map((handoff) => [handoff.status, handoff.result?.action]),
      [
        ['succeeded', 'upstream'],
        ['succeeded', 'upstream'],
      ]
    );

    const persisted = await orchestrations.list();
    assert.equal(persisted.length, 2);
    assert.deepEqual(new Set(persisted.map((record) => record.request.source)), new Set(['codex', 'claude']));

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cliPath, 'delegation', '--server', 'http://127.0.0.1:1', '--json'],
        { cwd: workspace, encoding: 'utf8', env: { ...process.env, AGENTKNOT_CONFIG: undefined } }
      ),
      (error: unknown) => {
        const stderr = String((error as { stderr?: unknown }).stderr ?? '');
        assert.match(stderr, /AgentKnot server request failed/);
        assert.doesNotMatch(stderr, /agentknot\.config\.json/);
        return true;
      }
    );
  } finally {
    await http.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

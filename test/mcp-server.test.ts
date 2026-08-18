import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { stopBroker } from '../src/broker-lifecycle.js';
import { writeBrokerLaunchProfile } from '../src/broker-profile.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

interface RpcResponse {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
}

class StdioMcpClient {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, { resolve(value: RpcResponse): void; reject(error: Error): void }>();
  #buffer = '';
  #nextId = 1;
  readonly notifications: Array<{ method?: string; params?: Record<string, unknown> }> = [];

  constructor(environment: NodeJS.ProcessEnv) {
    this.#child = spawn(process.execPath, [cliPath, 'mcp'], {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdout?.setEncoding('utf8');
    this.#child.stdout?.on('data', (chunk: string) => this.#accept(chunk));
    this.#child.once('exit', (code, signal) => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error(`MCP process exited (${String(code ?? signal)})`));
      }
      this.#pending.clear();
    });
  }

  #accept(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line === '') continue;
      const response = JSON.parse(line) as RpcResponse & { id?: number };
      if (typeof response.id !== 'number') {
        this.notifications.push(response as { method?: string; params?: Record<string, unknown> });
        continue;
      }
      const pending = this.#pending.get(response.id);
      if (pending === undefined) continue;
      this.#pending.delete(response.id);
      pending.resolve(response);
    }
  }

  beginRequest(method: string, params: object): {
    id: number;
    result: Promise<Record<string, unknown>>;
  } {
    const id = this.#nextId++;
    const response = new Promise<RpcResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return {
      id,
      result: response.then((settled) => {
        if (settled.error !== undefined) throw new Error(settled.error.message ?? 'MCP request failed');
        assert.ok(settled.result);
        return settled.result;
      }),
    };
  }

  async request(method: string, params: object): Promise<Record<string, unknown>> {
    return this.beginRequest(method, params).result;
  }

  notify(method: string, params?: object): void {
    this.#child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  abandonRequest(id: number, reason: string): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    pending.reject(new Error(reason));
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agentknot-test', version: '1' },
    });
    this.notify('notifications/initialized');
  }

  async callTool(
    name: string,
    args: object,
    meta?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request('tools/call', {
      name,
      arguments: args,
      ...(meta === undefined ? {} : { _meta: meta }),
    });
  }

  async close(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    const exited = once(this.#child, 'exit');
    this.#child.stdin?.end();
    await exited;
  }
}

function toolJson(result: Record<string, unknown>): Record<string, unknown> {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const content = result.content as Array<{ type: string; text: string }>;
  assert.equal(content[0]?.type, 'text');
  return JSON.parse(content[0]?.text ?? '') as Record<string, unknown>;
}

async function startForegroundBroker(
  root: string,
  environment: NodeJS.ProcessEnv,
  configPath: string
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [cliPath, 'broker', 'run', '--port', '0', '--config', configPath],
    { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`broker startup timed out: ${stderr}`)), 5_000);
    const onData = (): void => {
      if (!stdout.includes('AgentKnot listening on http://')) return;
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      resolve();
    };
    const onExit = (): void => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      reject(new Error(`broker exited during startup: ${stderr}`));
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
  return child;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

test('MCP explicitly starts and follows a broker without owning its runtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentknot-mcp-'));
  const runtime = path.join(root, 'runtime');
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await Promise.all([mkdir(runtime, { mode: 0o700 }), mkdir(home), mkdir(workspace)]);
  await chmod(runtime, 0o700);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_RUNTIME_DIR: runtime,
    HOME: home,
    USERPROFILE: home,
    AGENTKNOT_CONFIG: undefined,
    AGENTKNOT_SERVER_URL: undefined,
  };
  const writeConfig = async (name: string): Promise<string> => {
    const configPath = path.join(root, `${name}.json`);
    await writeFile(
      configPath,
      `${JSON.stringify({
        version: 1,
        defaultRoute: name,
        storage: {
          directory: path.join(root, `${name}-jobs`),
          orchestrationDirectory: path.join(root, `${name}-orchestrations`),
        },
        workers: { mock: { adapter: 'mock' } },
        routes: { [name]: { worker: 'mock', provider: 'test', model: name } },
        delegation: { mode: 'off' },
      })}\n`
    );
    return configPath;
  };

  let broker: ChildProcess | undefined;
  let mcp: StdioMcpClient | undefined;
  let detachedBrokerRunning = false;
  try {
    const firstConfig = await writeConfig('first');
    await writeBrokerLaunchProfile(
      { configPath: firstConfig, port: 0 },
      { environment }
    );
    mcp = new StdioMcpClient(environment);
    await mcp.initialize();

    const listed = await mcp.request('tools/list', {});
    const names = (listed.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.deepEqual(names, [
      'agentknot_broker_status',
      'agentknot_broker_start',
      'agentknot_delegation_policy',
      'agentknot_routes',
      'agentknot_orchestration_start',
      'agentknot_orchestration_status',
      'agentknot_orchestration_wait',
      'agentknot_orchestration_follow',
      'agentknot_orchestration_cancel',
      'agentknot_job_output',
      'agentknot_job_control_capabilities',
      'agentknot_job_control',
      'agentknot_artifact_preview',
    ]);
    assert.deepEqual(toolJson(await mcp.callTool('agentknot_broker_status', {})), {
      state: 'stopped',
      launchConfigured: true,
    });
    const started = toolJson(await mcp.callTool('agentknot_broker_start', {}));
    assert.equal(started.action, 'started');
    detachedBrokerRunning = true;
    assert.equal(toolJson(await mcp.callTool('agentknot_broker_status', {})).state, 'running');
    assert.equal(
      ((toolJson(await mcp.callTool('agentknot_routes', {})).routes as Array<{ name: string }>)[0]?.name),
      'first'
    );

    const firstBroker = started.broker as { pid: number };
    process.kill(firstBroker.pid, 'SIGKILL');
    detachedBrokerRunning = false;
    let unavailable!: Record<string, unknown>;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      unavailable = toolJson(await mcp.callTool('agentknot_broker_status', {}));
      if (unavailable.state === 'unavailable') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(unavailable.state, 'unavailable');
    assert.equal(unavailable.launchConfigured, true);
    const restarted = toolJson(await mcp.callTool('agentknot_broker_start', {}));
    assert.equal(restarted.action, 'started');
    detachedBrokerRunning = true;

    const admitted = toolJson(
      await mcp.callTool('agentknot_orchestration_start', {
        prompt: 'Keep this controller-owned test upstream.',
        workspace,
        source: 'independent-controller',
        delegation: 'never',
        assessment: {
          schemaVersion: 1,
          recommendation: 'delegate',
          complexity: 'low',
          parallelizable: false,
          taskKinds: ['documentation'],
          reasoning: 'Transport acceptance fixture.',
          context: {
            schemaVersion: 1,
            summary: 'The transport fixture requires no repository discovery.',
            relevantPaths: ['package.json'],
            constraints: ['Do not inspect unrelated files.'],
            references: [
              {
                id: 'transport-fixture',
                kind: 'artifact',
                locator: 'artifact:transport-fixture',
                source: 'controller',
                trust: 'unverified',
                revision: 'v1',
              },
            ],
          },
          subtasks: [
            {
              title: 'Transport budget fixture',
              kind: 'documentation',
              prompt: 'Describe the transport budget fixture.',
              acceptanceCriteria: ['The transport budget fixture is described'],
            },
          ],
        },
      })
    );
    assert.ok(['queued', 'dispatching', 'succeeded'].includes(String(admitted.status)));
    const waited = toolJson(
      await mcp.callTool('agentknot_orchestration_wait', {
        id: admitted.id,
      })
    );
    assert.equal(waited.state, 'terminal');
    assert.equal((waited.terminal as { status: string }).status, 'succeeded');
    const followed = toolJson(
      await mcp.callTool('agentknot_orchestration_follow', {
        id: admitted.id,
        afterSequence: 0,
      })
    );
    assert.ok(Number(followed.nextSequence) >= 2);
    assert.equal((followed.terminal as { status: string }).status, 'succeeded');

    await stopBroker({ environment });
    detachedBrokerRunning = false;
    broker = await startForegroundBroker(root, environment, await writeConfig('second'));
    assert.equal(
      ((toolJson(await mcp.callTool('agentknot_routes', {})).routes as Array<{ name: string }>)[0]?.name),
      'second'
    );
  } finally {
    await mcp?.close();
    await stopChild(broker);
    if (detachedBrokerRunning) await stopBroker({ environment });
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP job output returns one bounded page in matching text and structured forms', async () => {
  const calls: string[] = [];
  const http: Server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    const url = new URL(request.url ?? '/', 'http://agentknot.test');
    const match = /^\/v1\/jobs\/([a-zA-Z0-9_-]+)\/output$/u.exec(url.pathname);
    if (request.method !== 'GET' || match === null) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not found"}');
      return;
    }
    const jobId = match[1]!;
    const subtaskId = url.searchParams.get('subtaskId') ?? undefined;
    response.writeHead(200, { 'content-type': 'application/json' });
    if (jobId === 'job_missing') {
      response.end(JSON.stringify({
        schemaVersion: 1,
        status: 'unavailable',
        jobId,
        reason: 'job-not-found',
      }));
      return;
    }
    response.end(JSON.stringify({
      schemaVersion: 1,
      status: 'available',
      jobId,
      ...(subtaskId === undefined ? {} : { subtaskId }),
      chunk: '中文',
      cursor: 0,
      nextCursor: 6,
      hasMore: true,
      totalBytes: 10,
    }));
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address() as AddressInfo;
  const mcp = new StdioMcpClient({
    ...process.env,
    AGENTKNOT_SERVER_URL: `http://127.0.0.1:${address.port}`,
  });
  try {
    await mcp.initialize();
    const response = await mcp.callTool('agentknot_job_output', {
      jobId: 'job_output_fixture',
      subtaskId: 'subtask-output',
      cursor: 0,
      maxBytes: 8,
    });
    const page = toolJson(response);
    assert.deepEqual(response.structuredContent, page);
    assert.equal(page.chunk, '中文');
    assert.equal(page.nextCursor, 6);
    assert.equal(page.hasMore, true);
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') < 16 * 1024);
    assert.ok(
      calls.some((call) =>
        call.includes(
          '/v1/jobs/job_output_fixture/output?subtaskId=subtask-output&cursor=0&maxBytes=8'
        )
      )
    );

    const missingResponse = await mcp.callTool('agentknot_job_output', {
      jobId: 'job_missing',
    });
    const missing = toolJson(missingResponse);
    assert.deepEqual(missingResponse.structuredContent, missing);
    assert.equal(missing.status, 'unavailable');
    assert.equal(missing.reason, 'job-not-found');
  } finally {
    await mcp.close();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error === undefined ? resolve() : reject(error)))
    );
  }
});

test('MCP wait resumes the same durable cursor and cancels its in-flight follow', async () => {
  const timerRoot = await mkdtemp(path.join(os.tmpdir(), 'agentknot-mcp-wait-timer-'));
  const timerHook = path.join(timerRoot, 'timer-hook.mjs');
  const timerLog = path.join(timerRoot, 'timer.log');
  await writeFile(
    timerHook,
    `import { appendFileSync } from 'node:fs';
const log = process.env.AGENTKNOT_TEST_TIMER_LOG;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const tracked = new Map();
let nextId = 1;
globalThis.setTimeout = function (callback, delay, ...args) {
  const handle = Reflect.apply(originalSetTimeout, globalThis, [callback, delay, ...args]);
  if (log && [100, 40000, 40001, 179999, 180000].includes(delay)) {
    const id = nextId++;
    tracked.set(handle, id);
    appendFileSync(log, 'set ' + id + ' ' + delay + '\\n');
  }
  return handle;
};
globalThis.clearTimeout = function (handle) {
  const id = tracked.get(handle);
  if (log && id !== undefined) {
    tracked.delete(handle);
    appendFileSync(log, 'clear ' + id + '\\n');
  }
  return Reflect.apply(originalClearTimeout, globalThis, [handle]);
};
`
  );
  const calls: string[] = [];
  let mode:
    | 'active'
    | 'deadline-hanging'
    | 'terminal'
    | 'progress-terminal'
    | 'progress-hanging'
    | 'durable-cancellation'
    | 'broker-error'
    | 'follow-hanging'
    | 'record-hanging' = 'active';
  let hangingRequestArrived: (() => void) | undefined;
  let hangingRequestClosed: (() => void) | undefined;
  let durableCancellationResponse: ServerResponse | undefined;
  const armHangingRequest = (): { arrived: Promise<void>; closed: Promise<void> } => ({
    arrived: new Promise<void>((resolve) => {
      hangingRequestArrived = resolve;
    }),
    closed: new Promise<void>((resolve) => {
      hangingRequestClosed = resolve;
    }),
  });
  const observeHangingRequest = (
    request: IncomingMessage,
    response: ServerResponse
  ): void => {
    hangingRequestArrived?.();
    let closed = false;
    const observeClose = (): void => {
      if (closed) return;
      closed = true;
      hangingRequestClosed?.();
    };
    request.once('aborted', observeClose);
    response.once('close', observeClose);
  };
  const terminal = {
    schemaVersion: 1,
    id: 'orchestration_wait_fixture',
    status: 'succeeded',
    request: { source: 'test-controller', delegation: 'inherit' },
    children: [],
    events: [
      { sequence: 1, type: 'orchestration.queued' },
      { sequence: 2, type: 'orchestration.succeeded' },
    ],
    result: { action: 'delegated', artifactReview: { status: 'checked', conflicts: [], unavailable: [] } },
  };
  const cancelledTerminal = {
    ...terminal,
    status: 'cancelled',
    events: [
      terminal.events[0],
      { sequence: 2, type: 'orchestration.cancelled' },
    ],
  };
  const http: Server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    if (
      request.method === 'POST' &&
      request.url === '/v1/orchestrations/orchestration_wait_fixture/cancel'
    ) {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end('{"accepted":true}');
      const waiting = durableCancellationResponse;
      durableCancellationResponse = undefined;
      setImmediate(() => {
        if (waiting === undefined || waiting.destroyed) return;
        waiting.writeHead(200, { 'content-type': 'application/json' });
        waiting.end(JSON.stringify({ nextSequence: 2, orchestration: cancelledTerminal }));
      });
      return;
    }
    if (request.url === '/v1/orchestrations/orchestration_wait_fixture') {
      if (mode === 'record-hanging') {
        observeHangingRequest(request, response);
        return;
      }
      if (mode === 'broker-error') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{"error":"injected broker error"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ orchestration: mode === 'terminal' ? terminal : {
        ...terminal,
        status: 'running',
        events: mode === 'deadline-hanging'
          ? [
              terminal.events[0],
              { sequence: 2, type: 'orchestration.child.started' },
            ]
          : [terminal.events[0]],
        result: undefined,
      } }));
      return;
    }
    if (!request.url?.startsWith('/v1/orchestrations/orchestration_wait_fixture/events?after=')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not found"}');
      return;
    }
    if (mode === 'durable-cancellation') {
      durableCancellationResponse = response;
      observeHangingRequest(request, response);
      return;
    }
    const after = Number(new URL(request.url, 'http://agentknot.test').searchParams.get('after'));
    if (mode === 'progress-hanging' && after >= 1) {
      observeHangingRequest(request, response);
      return;
    }
    if (mode === 'follow-hanging' || mode === 'deadline-hanging') {
      observeHangingRequest(request, response);
      return;
    }
    if (mode === 'terminal') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ nextSequence: 2, orchestration: terminal }));
      return;
    }
    if (mode === 'progress-terminal' && after >= 1) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ nextSequence: 2, orchestration: terminal }));
      return;
    }
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        events: after === 0 ? [{ sequence: 1, type: 'orchestration.queued' }] : [],
        nextSequence: 1,
        wait: {
          schemaVersion: 1,
          kind: 'orchestration',
          id: terminal.id,
          status: 'running',
          phase: 'dispatching',
          updatedAt: new Date().toISOString(),
          children: [],
        },
      }));
    }, 30);
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address() as AddressInfo;
  const mcp = new StdioMcpClient({
    ...process.env,
    AGENTKNOT_SERVER_URL: `http://127.0.0.1:${address.port}`,
    AGENTKNOT_TEST_TIMER_LOG: timerLog,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(timerHook).href}`,
    ].filter((value) => value !== undefined && value !== '').join(' '),
  });
  try {
    await mcp.initialize();
    const listed = await mcp.request('tools/list', {});
    const waitTool = (listed.tools as Array<{
      name: string;
      inputSchema: { properties?: Record<string, Record<string, unknown>> };
    }>).find((tool) => tool.name === 'agentknot_orchestration_wait');
    assert.ok(waitTool);
    assert.deepEqual(waitTool.inputSchema.properties?.waitMs, {
      type: 'integer',
      minimum: 100,
      maximum: 180_000,
      default: 40_000,
    });

    mode = 'terminal';
    const terminalShapes: string[] = [];
    for (const waitMs of [undefined, 100, 40_000, 40_001, 179_999, 180_000] as const) {
      const result = toolJson(
        await mcp.callTool('agentknot_orchestration_wait', {
          id: terminal.id,
          afterSequence: 0,
          ...(waitMs === undefined ? {} : { waitMs }),
        })
      );
      assert.equal(result.state, 'terminal');
      terminalShapes.push(JSON.stringify(Object.keys(result).sort()));
    }
    assert.equal(new Set(terminalShapes).size, 1, 'waitMs must not change the response shape');

    for (const waitMs of [99, 180_001, 0, -1, 1.5, '180000', null]) {
      const callsBeforeValidation = calls.length;
      const timerLogBeforeValidation = await readFile(timerLog, 'utf8');
      const rejected = await mcp.callTool('agentknot_orchestration_wait', {
        id: terminal.id,
        afterSequence: 0,
        waitMs,
      });
      assert.equal(rejected.isError, true, `waitMs=${String(waitMs)} should be rejected`);
      assert.equal(calls.length, callsBeforeValidation, 'invalid waitMs must not reach the broker');
      assert.equal(
        await readFile(timerLog, 'utf8'),
        timerLogBeforeValidation,
        'invalid waitMs must not create a deadline timer'
      );
    }
    // Raw JSON cannot represent NaN or Infinity. They arrive as null if a JavaScript caller
    // serializes them, so the public transport test above intentionally covers null instead.

    mode = 'progress-terminal';
    const notificationsBeforeLongWait = mcp.notifications.length;
    const longWait = toolJson(
      await mcp.callTool(
        'agentknot_orchestration_wait',
        { id: terminal.id, afterSequence: 0, waitMs: 180_000 },
        { progressToken: 'long-wait-progress' }
      )
    );
    assert.equal(longWait.state, 'terminal');
    assert.ok(mcp.notifications.slice(notificationsBeforeLongWait).some((notification) =>
      notification.method === 'notifications/progress' &&
      notification.params?.progressToken === 'long-wait-progress'));
    const notificationsAfterLongWait = mcp.notifications.length;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mcp.notifications.length, notificationsAfterLongWait);

    mode = 'active';
    const activeCallStart = calls.length;
    const active = toolJson(
      await mcp.callTool(
        'agentknot_orchestration_wait',
        { id: terminal.id, afterSequence: 0, waitMs: 100 },
        { progressToken: 'wait-progress' }
      )
    );
    assert.equal(active.state, 'active');
    assert.equal(active.id, terminal.id);
    assert.equal(active.nextSequence, 1);
    const activeCalls = calls.slice(activeCallStart);
    const eventCalls = activeCalls.filter((call) => call.includes('/events?after='));
    assert.ok(eventCalls.length >= 2);
    assert.ok(eventCalls[0]?.endsWith('events?after=0'));
    assert.ok(eventCalls.slice(1).every((call) => call.endsWith('events?after=1')));
    assert.equal(
      activeCalls.filter((call) => call === `GET /v1/orchestrations/${terminal.id}`).length,
      1,
      'the bounded wait must not add a deadline fallback snapshot'
    );
    assert.ok(mcp.notifications.some((notification) =>
      notification.method === 'notifications/progress' &&
      notification.params?.progressToken === 'wait-progress'));

    mode = 'deadline-hanging';
    const deadlineBounded = toolJson(
      await mcp.callTool('agentknot_orchestration_wait', {
        id: terminal.id,
        afterSequence: 0,
        waitMs: 100,
      })
    );
    assert.equal(deadlineBounded.state, 'active');
    assert.equal(deadlineBounded.nextSequence, 0);

    mode = 'terminal';
    const resumed = toolJson(
      await mcp.callTool('agentknot_orchestration_wait', {
        id: terminal.id,
        afterSequence: active.nextSequence,
        waitMs: 100,
      })
    );
    assert.equal(resumed.state, 'terminal');
    assert.equal((resumed.terminal as { id: string }).id, terminal.id);
    assert.equal(calls.some((call) => call.startsWith('POST ')), false);

    mode = 'progress-hanging';
    let hanging = armHangingRequest();
    const pending = mcp.beginRequest('tools/call', {
      name: 'agentknot_orchestration_wait',
      arguments: { id: terminal.id, afterSequence: 0, waitMs: 180_000 },
      _meta: { progressToken: 'abort-progress' },
    });
    const pendingSettlement = pending.result.then(
      (result) => ({ result }),
      (error: Error) => ({ error })
    );
    await hanging.arrived;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(mcp.notifications.some((notification) =>
      notification.method === 'notifications/progress' &&
      notification.params?.progressToken === 'abort-progress'));
    mcp.notify('notifications/cancelled', { requestId: pending.id, reason: 'test cancellation' });
    await Promise.race([
      hanging.closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('cancelled MCP wait did not abort its HTTP follow')), 1_000)),
    ]);
    mcp.abandonRequest(pending.id, 'test client stopped awaiting cancelled request');
    const abortedWait = await pendingSettlement;
    if ('result' in abortedWait) assert.equal(abortedWait.result.isError, true);
    else assert.match(abortedWait.error.message, /stopped awaiting cancelled request/);
    const notificationsAfterAbort = mcp.notifications.length;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mcp.notifications.length, notificationsAfterAbort);

    mode = 'terminal';
    const reattachedAfterAbort = toolJson(
      await mcp.callTool('agentknot_orchestration_wait', {
        id: terminal.id,
        afterSequence: 1,
        waitMs: 100,
      })
    );
    assert.equal(reattachedAfterAbort.state, 'terminal');
    assert.equal((reattachedAfterAbort.terminal as { id: string }).id, terminal.id);

    mode = 'durable-cancellation';
    hanging = armHangingRequest();
    const longWaitCancelled = mcp.callTool('agentknot_orchestration_wait', {
      id: terminal.id,
      afterSequence: 1,
      waitMs: 180_000,
    });
    await hanging.arrived;
    assert.deepEqual(
      toolJson(await mcp.callTool('agentknot_orchestration_cancel', { id: terminal.id })),
      { accepted: true, orchestrationId: terminal.id }
    );
    const cancelledWaitResult = toolJson(await longWaitCancelled);
    assert.equal(cancelledWaitResult.state, 'terminal');
    assert.equal(
      (cancelledWaitResult.terminal as { status: string }).status,
      'cancelled'
    );
    assert.equal(
      calls.filter((call) =>
        call === `POST /v1/orchestrations/${terminal.id}/cancel`).length,
      1
    );
    assert.equal(calls.some((call) => call === 'POST /v1/orchestrations'), false);

    mode = 'broker-error';
    const brokerError = await mcp.callTool('agentknot_orchestration_wait', {
      id: terminal.id,
      afterSequence: 1,
      waitMs: 180_000,
    });
    assert.equal(brokerError.isError, true);

    mode = 'record-hanging';
    hanging = armHangingRequest();
    const preflight = mcp.beginRequest('tools/call', {
      name: 'agentknot_orchestration_wait',
      arguments: { id: terminal.id, afterSequence: 1 },
    });
    const preflightSettlement = preflight.result.then(
      (result) => ({ result }),
      (error: Error) => ({ error })
    );
    await hanging.arrived;
    mcp.notify('notifications/cancelled', { requestId: preflight.id, reason: 'test cancellation' });
    await Promise.race([
      hanging.closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('cancelled MCP wait did not abort its record read')), 1_000)),
    ]);
    mcp.abandonRequest(preflight.id, 'test client stopped awaiting cancelled preflight');
    const abortedPreflight = await preflightSettlement;
    if ('result' in abortedPreflight) assert.equal(abortedPreflight.result.isError, true);
    else assert.match(abortedPreflight.error.message, /stopped awaiting cancelled preflight/);

    const timerEvents = (await readFile(timerLog, 'utf8')).trim().split('\n');
    const timers = new Map<string, { delay: number; cleared: boolean }>();
    for (const event of timerEvents) {
      const [kind, id, delay] = event.split(' ');
      if (kind === 'set' && id !== undefined && delay !== undefined) {
        timers.set(id, { delay: Number(delay), cleared: false });
      } else if (kind === 'clear' && id !== undefined) {
        const timer = timers.get(id);
        assert.ok(timer, `clear must refer to a tracked timer: ${event}`);
        timer.cleared = true;
      }
    }
    assert.deepEqual(
      new Set([...timers.values()].map((timer) => timer.delay)),
      new Set([100, 40_000, 40_001, 179_999, 180_000]),
      'the handler must pass each explicit duration to setTimeout without clamping'
    );
    assert.ok([...timers.values()].every((timer) => timer.cleared));
  } finally {
    await mcp.close();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => error === undefined ? resolve() : reject(error)));
    await rm(timerRoot, { recursive: true, force: true });
  }
});

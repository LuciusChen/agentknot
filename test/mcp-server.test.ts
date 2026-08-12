import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
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
          },
          subtasks: [
            {
              title: 'Transport budget fixture',
              kind: 'documentation',
              prompt: 'Describe the transport budget fixture.',
              acceptanceCriteria: ['The transport budget fixture is described'],
              maxToolCalls: 7,
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

test('MCP wait resumes the same durable cursor and cancels its in-flight follow', async () => {
  const calls: string[] = [];
  let mode: 'active' | 'deadline-hanging' | 'terminal' | 'follow-hanging' | 'record-hanging' = 'active';
  let hangingRequestArrived: (() => void) | undefined;
  let hangingRequestClosed: (() => void) | undefined;
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
  const http: Server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.url === '/v1/orchestrations/orchestration_wait_fixture') {
      if (mode === 'record-hanging') {
        observeHangingRequest(request, response);
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
    if (mode === 'follow-hanging' || mode === 'deadline-hanging') {
      observeHangingRequest(request, response);
      return;
    }
    if (mode === 'terminal') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ nextSequence: 2, orchestration: terminal }));
      return;
    }
    const after = Number(new URL(request.url, 'http://agentknot.test').searchParams.get('after'));
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
  });
  try {
    await mcp.initialize();
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
    const eventCalls = calls.filter((call) => call.includes('/events?after='));
    assert.ok(eventCalls.length >= 2);
    assert.ok(eventCalls[0]?.endsWith('events?after=0'));
    assert.ok(eventCalls.slice(1).every((call) => call.endsWith('events?after=1')));
    assert.equal(
      calls.filter((call) => call === `GET /v1/orchestrations/${terminal.id}`).length,
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

    mode = 'follow-hanging';
    let hanging = armHangingRequest();
    const pending = mcp.beginRequest('tools/call', {
      name: 'agentknot_orchestration_wait',
      arguments: { id: terminal.id, afterSequence: 1, waitMs: 40_000 },
    });
    void pending.result.catch(() => undefined);
    await hanging.arrived;
    mcp.notify('notifications/cancelled', { requestId: pending.id, reason: 'test cancellation' });
    await Promise.race([
      hanging.closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('cancelled MCP wait did not abort its HTTP follow')), 1_000)),
    ]);

    mode = 'record-hanging';
    hanging = armHangingRequest();
    const preflight = mcp.beginRequest('tools/call', {
      name: 'agentknot_orchestration_wait',
      arguments: { id: terminal.id, afterSequence: 1 },
    });
    void preflight.result.catch(() => undefined);
    await hanging.arrived;
    mcp.notify('notifications/cancelled', { requestId: preflight.id, reason: 'test cancellation' });
    await Promise.race([
      hanging.closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('cancelled MCP wait did not abort its record read')), 1_000)),
    ]);
  } finally {
    await mcp.close();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

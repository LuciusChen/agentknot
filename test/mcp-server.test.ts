import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
      if (typeof response.id !== 'number') continue;
      const pending = this.#pending.get(response.id);
      if (pending === undefined) continue;
      this.#pending.delete(response.id);
      pending.resolve(response);
    }
  }

  async request(method: string, params: object): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    const response = new Promise<RpcResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const settled = await response;
    if (settled.error !== undefined) throw new Error(settled.error.message ?? 'MCP request failed');
    assert.ok(settled.result);
    return settled.result;
  }

  notify(method: string): void {
    this.#child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agentknot-test', version: '1' },
    });
    this.notify('notifications/initialized');
  }

  async callTool(name: string, args: object): Promise<Record<string, unknown>> {
    return this.request('tools/call', { name, arguments: args });
  }

  async close(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    const exited = once(this.#child, 'exit');
    this.#child.stdin?.end();
    await exited;
  }
}

function toolJson(result: Record<string, unknown>): Record<string, unknown> {
  assert.equal(result.isError, undefined);
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
      'agentknot_orchestration_follow',
      'agentknot_orchestration_cancel',
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
          recommendation: 'do-not-delegate',
          complexity: 'low',
          parallelizable: false,
          taskKinds: [],
          reasoning: 'Transport acceptance fixture.',
          subtasks: [],
        },
      })
    );
    assert.ok(['queued', 'dispatching', 'succeeded'].includes(String(admitted.status)));
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

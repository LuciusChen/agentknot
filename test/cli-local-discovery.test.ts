import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { readLocalDiscovery, type LocalDiscoveryEnvironment } from '../src/local-discovery.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const upstreamAssessmentJson = JSON.stringify({
  schemaVersion: 1,
  recommendation: 'do-not-delegate',
  complexity: 'low',
  parallelizable: false,
  taskKinds: [],
  reasoning: 'Controller keeps this transport fixture upstream.',
  subtasks: [],
});

interface Fixture {
  root: string;
  runtime: string;
  home: string;
  workspace: string;
  environment: LocalDiscoveryEnvironment;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunningServer {
  child: ChildProcess;
  url: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentknot-cli-discovery-'));
  const runtime = path.join(root, 'runtime');
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  await chmod(runtime, 0o700);
  await chmod(home, 0o700);
  return {
    root,
    runtime,
    home,
    workspace,
    environment: { XDG_RUNTIME_DIR: runtime, HOME: home, USERPROFILE: home },
  };
}

async function removeFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

function childEnvironment(
  fixture: Fixture,
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...fixture.environment,
    AGENTKNOT_CONFIG: undefined,
    AGENTKNOT_SERVER_URL: undefined,
    ...overrides,
  };
}

async function writeConfig(
  fixture: Fixture,
  name: string,
  route: string,
  options: { defaultRoute?: string } = {}
): Promise<string> {
  const configPath = path.join(fixture.root, `${name}.json`);
  const jobs = path.join(fixture.root, `${name}-jobs`);
  const orchestrations = path.join(fixture.root, `${name}-orchestrations`);
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        defaultRoute: options.defaultRoute ?? route,
        storage: { directory: jobs, orchestrationDirectory: orchestrations },
        workers: { mock: { adapter: 'mock' } },
        routes: { [route]: { worker: 'mock', provider: 'test', model: route } },
        delegation: { mode: 'off' },
      },
      null,
      2
    )}\n`
  );
  return configPath;
}

function listeningUrl(output: string): string | undefined {
  const match = /AgentKnot listening on (http:\/\/[^\s]+)/.exec(output);
  return match?.[1];
}

async function startServer(
  fixture: Fixture,
  configPath: string,
  host = '127.0.0.1',
  port = '0'
): Promise<RunningServer> {
  const child = spawn(
    process.execPath,
    [cliPath, 'serve', '--host', host, '--port', port, '--config', configPath],
    { cwd: fixture.root, env: childEnvironment(fixture), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let output = '';
  let errorOutput = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    errorOutput += chunk.toString();
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`server did not start: ${errorOutput}`));
    }, 5_000);
    const onData = (): void => {
      const address = listeningUrl(output);
      if (address === undefined) return;
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      resolve(address);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      reject(new Error(`server exited before listening (${code ?? signal}): ${errorOutput}`));
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
  return { child, url };
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = once(server.child, 'exit');
  server.child.kill('SIGTERM');
  await exited;
}

async function runCli(
  fixture: Fixture,
  args: string[],
  overrides: Record<string, string | undefined> = {}
): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: fixture.root,
      env: childEnvironment(fixture, overrides),
      encoding: 'utf8',
    });
    return { code: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error: unknown) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
    };
  }
}

test('loopback serve publishes the actual port, status probes health, and graceful stop unregisters', async () => {
  const fixture = await createFixture();
  let server: RunningServer | undefined;
  try {
    const configPath = await writeConfig(fixture, 'server', 'server');
    server = await startServer(fixture, configPath);
    const record = await readLocalDiscovery({ environment: fixture.environment });
    assert.ok(record);
    assert.equal(record.url, server.url);
    assert.match(record.url, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);

    const available = await runCli(fixture, ['client', '--json']);
    assert.equal(available.code, 0, available.stderr);
    assert.deepEqual(JSON.parse(available.stdout), { status: 'available', url: server.url });

    await stopServer(server);
    server = undefined;
    assert.equal(await readLocalDiscovery({ environment: fixture.environment }), undefined);

    const unconfigured = await runCli(fixture, ['client', '--json']);
    assert.equal(unconfigured.code, 0, unconfigured.stderr);
    assert.deepEqual(JSON.parse(unconfigured.stdout), { status: 'unconfigured' });
  } finally {
    if (server !== undefined) await stopServer(server);
    await removeFixture(fixture);
  }
});

test('two selector-free CLI processes discover and share one registered server', async () => {
  const fixture = await createFixture();
  let server: RunningServer | undefined;
  try {
    const configPath = await writeConfig(fixture, 'server', 'server');
    server = await startServer(fixture, configPath);
    const runClient = (source: string, prompt: string) =>
      runCli(fixture, [
        'orchestrate',
        '--source',
        source,
        '--workspace',
        fixture.workspace,
        '--delegation',
        'never',
        '--assessment-json',
        upstreamAssessmentJson,
        '--handoff-json',
        '--prompt',
        prompt,
      ]);
    const [first, second] = await Promise.all([
      runClient('codex', 'first discovered request'),
      runClient('claude', 'second discovered request'),
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    const firstRecord = JSON.parse(first.stdout) as { id: string; status: string };
    const secondRecord = JSON.parse(second.stdout) as { id: string; status: string };
    assert.equal(firstRecord.status, 'succeeded');
    assert.equal(secondRecord.status, 'succeeded');
    assert.notEqual(firstRecord.id, secondRecord.id);
  } finally {
    if (server !== undefined) await stopServer(server);
    await removeFixture(fixture);
  }
});

test('transport precedence keeps explicit and configured local paths deliberate', async () => {
  const fixture = await createFixture();
  let server: RunningServer | undefined;
  try {
    const serverConfig = await writeConfig(fixture, 'server', 'server');
    const localConfig = await writeConfig(fixture, 'local', 'local');
    server = await startServer(fixture, serverConfig);

    const explicitConfig = await runCli(fixture, ['routes', '--json', '--config', localConfig]);
    assert.equal(explicitConfig.code, 0, explicitConfig.stderr);
    assert.deepEqual(JSON.parse(explicitConfig.stdout).map((route: { name: string }) => route.name), ['local']);

    const configuredLocal = await runCli(
      fixture,
      ['routes', '--json'],
      { AGENTKNOT_CONFIG: localConfig }
    );
    assert.equal(configuredLocal.code, 0, configuredLocal.stderr);
    assert.deepEqual(JSON.parse(configuredLocal.stdout).map((route: { name: string }) => route.name), ['local']);

    const explicitConfigWithEnvironmentServer = await runCli(
      fixture,
      ['routes', '--json', '--config', localConfig],
      { AGENTKNOT_SERVER_URL: server.url }
    );
    assert.equal(explicitConfigWithEnvironmentServer.code, 0, explicitConfigWithEnvironmentServer.stderr);
    assert.deepEqual(
      JSON.parse(explicitConfigWithEnvironmentServer.stdout).map((route: { name: string }) => route.name),
      ['local']
    );

    const discovered = await runCli(fixture, ['routes', '--json']);
    assert.equal(discovered.code, 0, discovered.stderr);
    assert.deepEqual(JSON.parse(discovered.stdout).map((route: { name: string }) => route.name), ['server']);

    const explicitServer = await runCli(
      fixture,
      ['routes', '--json', '--server', server.url],
      { AGENTKNOT_CONFIG: localConfig }
    );
    assert.equal(explicitServer.code, 0, explicitServer.stderr);
    assert.deepEqual(JSON.parse(explicitServer.stdout).map((route: { name: string }) => route.name), ['server']);

    const environmentServer = await runCli(
      fixture,
      ['routes', '--json'],
      { AGENTKNOT_CONFIG: localConfig, AGENTKNOT_SERVER_URL: server.url }
    );
    assert.equal(environmentServer.code, 0, environmentServer.stderr);
    assert.deepEqual(JSON.parse(environmentServer.stdout).map((route: { name: string }) => route.name), ['server']);

    const incompatible = await runCli(
      fixture,
      ['routes', '--json', '--config', localConfig, '--server', server.url]
    );
    assert.equal(incompatible.code, 1);
    assert.match(incompatible.stderr, /cannot be used together/);
  } finally {
    if (server !== undefined) await stopServer(server);
    await removeFixture(fixture);
  }
});

test('a stale discovered endpoint is terminal and never falls back to local config', async () => {
  const fixture = await createFixture();
  let server: RunningServer | undefined;
  try {
    const serverConfig = await writeConfig(fixture, 'server', 'server');
    await writeConfig(fixture, 'agentknot.config', 'local');
    server = await startServer(fixture, serverConfig);
    const staleUrl = server.url;
    server.child.kill('SIGKILL');
    await once(server.child, 'exit');
    server = undefined;

    const result = await runCli(fixture, ['routes', '--json']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /AgentKnot server request failed/);
    assert.equal(result.stdout, '');
    assert.equal((await readLocalDiscovery({ environment: fixture.environment }))?.url, staleUrl);

    const unavailable = await runCli(fixture, ['client', '--json']);
    assert.equal(unavailable.code, 1);
    const status = JSON.parse(unavailable.stdout) as { status: string; url: string };
    assert.equal(status.status, 'unavailable');
    assert.equal(status.url, staleUrl);
  } finally {
    if (server !== undefined) await stopServer(server);
    await removeFixture(fixture);
  }
});

test('discovery ownership is contended before a different-config server can start', async () => {
  const fixture = await createFixture();
  let first: RunningServer | undefined;
  try {
    const firstConfig = await writeConfig(fixture, 'first', 'first');
    const secondConfig = await writeConfig(fixture, 'second', 'second');
    first = await startServer(fixture, firstConfig);
    const before = await readLocalDiscovery({ environment: fixture.environment });
    assert.ok(before);

    const refused = await runCli(fixture, [
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--config',
      secondConfig,
    ]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Another execution-owning AgentKnot runtime already owns storage directory/);
    assert.deepEqual(await readLocalDiscovery({ environment: fixture.environment }), before);
  } finally {
    if (first !== undefined) await stopServer(first);
    await removeFixture(fixture);
  }
});

test('failed loopback runtime and listen startup leave no new registration', async () => {
  const fixture = await createFixture();
  let occupied: ReturnType<typeof createServer> | undefined;
  try {
    const invalidConfig = path.join(fixture.root, 'invalid.json');
    await writeFile(invalidConfig, '{"version":1}\n');
    const runtimeFailure = await runCli(fixture, [
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--config',
      invalidConfig,
    ]);
    assert.equal(runtimeFailure.code, 1);
    assert.equal(await readLocalDiscovery({ environment: fixture.environment }), undefined);

    occupied = createServer((_request, response) => response.end('occupied'));
    await new Promise<void>((resolve) => occupied?.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    assert.ok(address && typeof address !== 'string');
    const configPath = await writeConfig(fixture, 'listen', 'listen');
    const listenFailure = await runCli(fixture, [
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      String(address.port),
      '--config',
      configPath,
    ]);
    assert.equal(listenFailure.code, 1);
    assert.equal(await readLocalDiscovery({ environment: fixture.environment }), undefined);
  } finally {
    if (occupied !== undefined) {
      await new Promise<void>((resolve) => occupied?.close(() => resolve()));
    }
    await removeFixture(fixture);
  }
});

test('non-127 loopback-adjacent serve hosts do not auto-register', async () => {
  const fixture = await createFixture();
  let server: RunningServer | undefined;
  try {
    const configPath = await writeConfig(fixture, 'remote-bind', 'remote-bind');
    server = await startServer(fixture, configPath, '0.0.0.0');
    assert.equal(await readLocalDiscovery({ environment: fixture.environment }), undefined);
  } finally {
    if (server !== undefined) await stopServer(server);
    await removeFixture(fixture);
  }
});

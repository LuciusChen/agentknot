import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  STARTUP_REPORT_PATH_ENV,
  startBroker,
  stopBroker,
} from '../src/broker-lifecycle.js';
import { readBrokerLaunchProfile } from '../src/broker-profile.js';
import {
  readLocalDiscovery,
  resolveLocalDiscoveryPaths,
  type LocalDiscoveryEnvironment,
} from '../src/local-discovery.js';

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

    const noProfile = await runCli(fixture, ['broker', 'start', '--json']);
    assert.equal(noProfile.code, 1);
    assert.match(noProfile.stderr, /launch is not configured.*broker up --config/);
  } finally {
    if (server !== undefined) await stopServer(server);
    await removeFixture(fixture);
  }
});

test('two selector-free CLI sessions with different transient environments share one broker', async () => {
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
      runCli(fixture, [
        'orchestrate',
        '--source',
        'claude',
        '--workspace',
        fixture.workspace,
        '--delegation',
        'never',
        '--assessment-json',
        upstreamAssessmentJson,
        '--handoff-json',
        '--prompt',
        'second discovered request',
      ], { XDG_RUNTIME_DIR: undefined }),
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

test('explicit broker lifecycle starts one detached cross-controller broker and stops it cleanly', async () => {
  const fixture = await createFixture();
  let brokerPid: number | undefined;
  try {
    const configPath = await writeConfig(fixture, 'broker', 'broker');
    const started = await runCli(fixture, [
      'broker',
      'up',
      '--port',
      '0',
      '--config',
      configPath,
      '--json',
    ]);
    assert.equal(started.code, 0, started.stderr);
    const startResult = JSON.parse(started.stdout) as {
      action: string;
      broker: { state: string; url: string; pid: number; instanceId: string };
    };
    assert.equal(startResult.action, 'started');
    assert.equal(startResult.broker.state, 'running');
    brokerPid = startResult.broker.pid;
    assert.deepEqual(await readBrokerLaunchProfile({ environment: fixture.environment }), {
      schemaVersion: 1,
      configPath,
      port: 0,
    });

    const status = await runCli(fixture, ['broker', 'status', '--json']);
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), {
      ...startResult.broker,
      launchConfigured: true,
    });

    const secondUp = await runCli(fixture, [
      'broker',
      'up',
      '--port',
      '0',
      '--config',
      configPath,
      '--json',
    ]);
    assert.equal(secondUp.code, 0, secondUp.stderr);
    const secondResult = JSON.parse(secondUp.stdout) as typeof startResult;
    assert.equal(secondResult.action, 'already-running');
    assert.equal(secondResult.broker.instanceId, startResult.broker.instanceId);
    assert.equal(secondResult.broker.pid, brokerPid);

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
    const [codex, claude] = await Promise.all([
      runClient('codex', 'detached broker request'),
      runClient('claude', 'independent controller request'),
    ]);
    assert.equal(codex.code, 0, codex.stderr);
    assert.equal(claude.code, 0, claude.stderr);

    const stopped = await runCli(fixture, ['broker', 'down', '--json']);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(stopped.stdout), { action: 'stopped' });
    brokerPid = undefined;
    assert.equal(await readLocalDiscovery({ environment: fixture.environment }), undefined);
    const after = await runCli(fixture, ['broker', 'status', '--json']);
    assert.equal(after.code, 0, after.stderr);
    assert.deepEqual(JSON.parse(after.stdout), { state: 'stopped', launchConfigured: true });

    const restarted = await runCli(fixture, ['broker', 'start', '--json']);
    assert.equal(restarted.code, 0, restarted.stderr);
    const restartResult = JSON.parse(restarted.stdout) as typeof startResult;
    assert.equal(restartResult.action, 'started');
    assert.notEqual(restartResult.broker.instanceId, startResult.broker.instanceId);
    brokerPid = restartResult.broker.pid;

    const finalStop = await runCli(fixture, ['broker', 'down', '--json']);
    assert.equal(finalStop.code, 0, finalStop.stderr);
    assert.deepEqual(JSON.parse(finalStop.stdout), { action: 'stopped' });
    brokerPid = undefined;
  } finally {
    if (brokerPid !== undefined) {
      try {
        process.kill(brokerPid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await removeFixture(fixture);
  }
});

test('broker startup reaps the exact child that misses readiness despite SIGTERM', async () => {
  const fixture = await createFixture();
  let child: ChildProcess | undefined;
  try {
    const configPath = await writeConfig(fixture, 'startup-cleanup', 'startup-cleanup');
    const stubbornChild = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const spawnProcess = ((
      _command: string,
      _args: readonly string[] | undefined,
      spawnOptions: SpawnOptions = {}
    ): ChildProcess => {
      const spawned = spawn(process.execPath, ['-e', stubbornChild], spawnOptions);
      child = spawned;
      return spawned;
    }) as unknown as typeof spawn;
    const startedAt = Date.now();
    await assert.rejects(
      startBroker({
        cliEntryPath: cliPath,
        configPath,
        port: 0,
        environment: fixture.environment,
        startTimeoutMs: 120,
        spawnProcess,
      }),
      /did not become ready within 120ms/
    );
    assert.ok(Date.now() - startedAt < 2_000, 'startup cleanup must remain bounded');
    assert.ok(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'exact child must be reaped');
    assert.equal(await readLocalDiscovery({ environment: fixture.environment }), undefined);
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    await removeFixture(fixture);
  }
});

test('broker startup failure includes a bounded one-shot report and removes its private state', async () => {
  const fixture = await createFixture();
  let child: ChildProcess | undefined;
  let reportPath: string | undefined;
  try {
    const configPath = await writeConfig(fixture, 'startup-diagnostics', 'startup-diagnostics');
    const childConfigPath = await writeConfig(fixture, 'startup-child', 'other', {
      defaultRoute: `${'startup-noise-'.repeat(400)}broker-startup-diagnostic-marker`,
    });
    const spawnProcess = ((
      command: string,
      args: readonly string[] | undefined,
      spawnOptions: SpawnOptions = {}
    ): ChildProcess => {
      reportPath = (spawnOptions.env as NodeJS.ProcessEnv)[STARTUP_REPORT_PATH_ENV];
      const childArgs = [...(args ?? [])];
      const configIndex = childArgs.indexOf('--config');
      assert.ok(configIndex >= 0);
      childArgs[configIndex + 1] = childConfigPath;
      const spawned = spawn(command, childArgs, {
        ...spawnOptions,
        env: { ...spawnOptions.env, ...fixture.environment },
      });
      child = spawned;
      return spawned;
    }) as unknown as typeof spawn;

    await assert.rejects(
      startBroker({
        cliEntryPath: cliPath,
        configPath,
        port: 0,
        environment: fixture.environment,
        spawnProcess,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /broker-startup-diagnostic-marker/);
        assert.ok(Buffer.byteLength(error.message, 'utf8') < 5 * 1024);
        return true;
      }
    );
    assert.ok(child);
    assert.equal(child.stderr, null);
    assert.ok(reportPath);
    await assert.rejects(readFile(reportPath));
    await assert.rejects(stat(path.dirname(reportPath)));
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    await removeFixture(fixture);
  }
});

test('successful broker startup owns no diagnostic pipe or retained report state', async () => {
  const fixture = await createFixture();
  let child: ChildProcess | undefined;
  let reportPath: string | undefined;
  let childEnv: NodeJS.ProcessEnv | undefined;
  try {
    const configPath = await writeConfig(fixture, 'startup-pipe', 'startup-pipe');
    const spawnProcess = ((
      command: string,
      args: readonly string[] | undefined,
      spawnOptions: SpawnOptions = {}
    ): ChildProcess => {
      childEnv = spawnOptions.env as NodeJS.ProcessEnv;
      reportPath = childEnv[STARTUP_REPORT_PATH_ENV];
      const spawned = spawn(command, args ?? [], spawnOptions);
      child = spawned;
      return spawned;
    }) as unknown as typeof spawn;

    const started = await startBroker({
      cliEntryPath: cliPath,
      configPath,
      port: 0,
      environment: fixture.environment,
      spawnProcess,
    });
    assert.equal(started.action, 'started');
    assert.ok(child);
    assert.equal(child.stderr, null);
    assert.equal(childEnv?.HOME, fixture.home);
    assert.equal(childEnv?.USERPROFILE, fixture.home);
    assert.equal(childEnv?.XDG_RUNTIME_DIR, fixture.runtime);
    assert.ok(reportPath);
    await assert.rejects(readFile(reportPath));
    await assert.rejects(stat(path.dirname(reportPath)));
    await stopBroker({ environment: fixture.environment });
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await removeFixture(fixture);
  }
});

test('startup failure report creation is exclusive, bounded, and mode 0600', async () => {
  const fixture = await createFixture();
  try {
    const reportPath = path.join(fixture.root, 'startup-report');
    const invalidConfig = await writeConfig(fixture, 'startup-report-invalid', 'other', {
      defaultRoute: `${'startup-noise-'.repeat(400)}startup-report-marker`,
    });
    const first = await runCli(fixture, ['broker', 'run', '--config', invalidConfig], {
      [STARTUP_REPORT_PATH_ENV]: reportPath,
    });
    assert.equal(first.code, 1);
    const report = await readFile(reportPath, 'utf8');
    assert.match(report, /startup-report-marker/);
    assert.ok(Buffer.byteLength(report, 'utf8') <= 4 * 1024);
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);

    await writeFile(reportPath, 'sentinel');
    await runCli(fixture, ['broker', 'run', '--config', invalidConfig], {
      [STARTUP_REPORT_PATH_ENV]: reportPath,
    });
    assert.equal(await readFile(reportPath, 'utf8'), 'sentinel');
  } finally {
    await removeFixture(fixture);
  }
});

test('broker down removes a stale crash record without touching an unidentified process', async () => {
  const fixture = await createFixture();
  let brokerPid: number | undefined;
  try {
    const configPath = await writeConfig(fixture, 'crash', 'crash');
    const started = await runCli(fixture, [
      'broker',
      'up',
      '--port',
      '0',
      '--config',
      configPath,
      '--json',
    ]);
    assert.equal(started.code, 0, started.stderr);
    brokerPid = (JSON.parse(started.stdout) as { broker: { pid: number } }).broker.pid;
    process.kill(brokerPid, 'SIGKILL');
    brokerPid = undefined;

    let unavailable!: CliResult;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      unavailable = await runCli(fixture, ['broker', 'status', '--json']);
      if ((JSON.parse(unavailable.stdout) as { state: string }).state === 'unavailable') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(unavailable.code, 1);
    const unavailableReport = JSON.parse(unavailable.stdout) as {
      state: string;
      launchConfigured: boolean;
    };
    assert.equal(unavailableReport.state, 'unavailable');
    assert.equal(unavailableReport.launchConfigured, true);

    const stopped = await runCli(fixture, ['broker', 'down', '--json']);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(stopped.stdout), { action: 'stale-record-removed' });
    assert.equal(await readLocalDiscovery({ environment: fixture.environment }), undefined);
  } finally {
    if (brokerPid !== undefined) {
      try {
        process.kill(brokerPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await removeFixture(fixture);
  }
});

test('broker up refuses malformed discovery ownership instead of replacing or timing out', async () => {
  const fixture = await createFixture();
  try {
    const configPath = await writeConfig(fixture, 'malformed', 'malformed');
    const paths = await resolveLocalDiscoveryPaths({ environment: fixture.environment });
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    await chmod(paths.directory, 0o700);
    await writeFile(paths.recordPath, '{"not":"an identity"}\n', { mode: 0o600 });

    const startedAt = Date.now();
    const refused = await runCli(fixture, [
      'broker',
      'up',
      '--port',
      '0',
      '--config',
      configPath,
      '--json',
    ]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /cannot be identified safely/);
    assert.ok(Date.now() - startedAt < 2_000, 'malformed ownership should fail before spawning');
    assert.equal(await readFile(paths.recordPath, 'utf8'), '{"not":"an identity"}\n');
  } finally {
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

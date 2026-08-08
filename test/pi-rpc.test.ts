import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { createAdapters } from '../src/adapters/index.js';
import type { AgentKnotConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';
import { PiRpcWorkerAdapter } from '../src/adapters/pi-rpc.js';
import { MemoryJobStore } from '../src/store.js';
import type { JobEventType, ResolvedRoute } from '../src/types.js';

const route: ResolvedRoute = {
  name: 'fake-pi',
  worker: 'pi',
  provider: 'opencode-go',
  model: 'gpt-5.6-luna',
  thinkingLevel: 'high',
  requiredEnv: [],
  maxAttempts: 1,
  timeoutMs: 10_000,
};

const conformanceFixture = path.resolve('test/fixtures/fake-pi-conformance.mjs');

function createConformanceAdapter(
  mode: string,
  environment: Record<string, string> = {}
): PiRpcWorkerAdapter {
  return new PiRpcWorkerAdapter('pi', {
    adapter: 'pi-rpc',
    command: process.execPath,
    commandArgs: [conformanceFixture],
    noSession: true,
    environment: { FAKE_PI_MODE: mode, ...environment },
  });
}

function conformanceInput(signal: AbortSignal, jobId = 'job_pi_conformance') {
  return {
    jobId,
    prompt: 'exercise the Pi RPC fixture',
    workspace: process.cwd(),
    route,
    attempt: 1,
    signal,
  };
}

async function waitForPid(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The child has not written its startup marker yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for fake Pi PID file ${pidFile}`);
}

function assertProcessGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  });
}

function createConformanceOrchestrator(
  environment: Record<string, string>,
  timeoutMs: number
): Orchestrator {
  const config: AgentKnotConfig = {
    version: 1,
    defaultRoute: 'fake-pi',
    storage: { directory: '.agentknot/jobs' },
    workers: {
      pi: {
        adapter: 'pi-rpc',
        command: process.execPath,
        commandArgs: [conformanceFixture],
        noSession: true,
        environment,
      },
    },
    routes: {
      'fake-pi': {
        worker: 'pi',
        provider: 'test-provider',
        model: 'test-model',
        requiredEnv: [],
        maxAttempts: 1,
        timeoutMs,
      },
    },
  };
  return new Orchestrator({
    config,
    store: new MemoryJobStore(),
    adapters: createAdapters(config),
  });
}

test('PiRpcWorkerAdapter doctor uses worker environment for required variables without mutating process.env', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-pi-doctor-env-'));
  const requiredEnv = `AGENTKNOT_REQUIRED_${randomUUID().replaceAll('-', '')}`;
  const provider = `provider-${randomUUID()}`;
  const before = process.env[requiredEnv];
  try {
    const adapter = new PiRpcWorkerAdapter('pi', {
      adapter: 'pi-rpc',
      command: process.execPath,
      environment: {
        [requiredEnv]: 'present',
        PI_CODING_AGENT_DIR: directory,
      },
    });

    const health = await adapter.doctor({ ...route, provider, requiredEnv: [requiredEnv] });

    assert.equal(health.ok, true);
    assert.equal(health.details?.credentialSource, 'environment');
    assert.deepEqual(process.env[requiredEnv], before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PiRpcWorkerAdapter doctor uses worker PI_CODING_AGENT_DIR without exposing auth values', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-pi-doctor-auth-'));
  const provider = `provider-${randomUUID()}`;
  const credential = `opaque-${randomUUID()}`;
  const requiredEnv = `AGENTKNOT_REQUIRED_${randomUUID().replaceAll('-', '')}`;
  const authDirectoryBefore = process.env.PI_CODING_AGENT_DIR;
  try {
    await writeFile(
      path.join(directory, 'auth.json'),
      JSON.stringify({ [provider]: { type: 'api_key', key: credential } })
    );
    const adapter = new PiRpcWorkerAdapter('pi', {
      adapter: 'pi-rpc',
      command: process.execPath,
      environment: { PI_CODING_AGENT_DIR: directory },
    });

    const health = await adapter.doctor({ ...route, provider, requiredEnv: [requiredEnv] });

    assert.equal(health.ok, true);
    assert.equal(health.details?.credentialSource, 'pi-auth-file');
    assert.equal(JSON.stringify(health).includes(credential), false);
    assert.equal(process.env.PI_CODING_AGENT_DIR, authDirectoryBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PiRpcWorkerAdapter doctor resolves Pi auth from the worker HOME default', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-pi-doctor-home-'));
  const agentDirectory = path.join(directory, '.pi', 'agent');
  const provider = `provider-${randomUUID()}`;
  const credential = `opaque-${randomUUID()}`;
  const requiredEnv = `AGENTKNOT_REQUIRED_${randomUUID().replaceAll('-', '')}`;
  const homeBefore = process.env.HOME;
  try {
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      path.join(agentDirectory, 'auth.json'),
      JSON.stringify({ [provider]: { type: 'api_key', key: credential } })
    );
    const adapter = new PiRpcWorkerAdapter('pi', {
      adapter: 'pi-rpc',
      command: process.execPath,
      environment: { HOME: directory, PI_CODING_AGENT_DIR: '' },
    });

    const health = await adapter.doctor({ ...route, provider, requiredEnv: [requiredEnv] });

    assert.equal(health.ok, true);
    assert.equal(health.details?.credentialSource, 'pi-auth-file');
    assert.equal(JSON.stringify(health).includes(credential), false);
    assert.equal(process.env.HOME, homeBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PiRpcWorkerAdapter expands worker PI_CODING_AGENT_DIR against worker HOME', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-pi-doctor-tilde-'));
  const agentDirectory = path.join(directory, 'custom-agent');
  const provider = `provider-${randomUUID()}`;
  const credential = `opaque-${randomUUID()}`;
  const requiredEnv = `AGENTKNOT_REQUIRED_${randomUUID().replaceAll('-', '')}`;
  try {
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      path.join(agentDirectory, 'auth.json'),
      JSON.stringify({ [provider]: { type: 'api_key', key: credential } })
    );
    const adapter = new PiRpcWorkerAdapter('pi', {
      adapter: 'pi-rpc',
      command: process.execPath,
      environment: {
        HOME: directory,
        PI_CODING_AGENT_DIR: '~/custom-agent',
      },
    });

    const health = await adapter.doctor({ ...route, provider, requiredEnv: [requiredEnv] });

    assert.equal(health.ok, true);
    assert.equal(health.details?.credentialSource, 'pi-auth-file');
    assert.equal(JSON.stringify(health).includes(credential), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PiRpcWorkerAdapter treats empty worker credentials as absent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-pi-doctor-empty-'));
  const provider = `provider-${randomUUID()}`;
  const requiredEnv = `AGENTKNOT_REQUIRED_${randomUUID().replaceAll('-', '')}`;
  try {
    await writeFile(
      path.join(directory, 'auth.json'),
      JSON.stringify({ [provider]: { type: 'api_key', key: '' } })
    );
    const adapter = new PiRpcWorkerAdapter('pi', {
      adapter: 'pi-rpc',
      command: process.execPath,
      environment: {
        [requiredEnv]: '',
        PI_CODING_AGENT_DIR: directory,
      },
    });

    const health = await adapter.doctor({ ...route, provider, requiredEnv: [requiredEnv] });

    assert.equal(health.ok, false);
    assert.deepEqual(health.details?.missingEnvironment, [requiredEnv]);
    assert.equal(health.details?.authFileCredential, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PiRpcWorkerAdapter discovers and runs a bare command from worker PATH', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-pi-doctor-path-'));
  const commandDirectory = await mkdtemp(path.join(directory, 'bin-'));
  const authDirectory = await mkdtemp(path.join(directory, 'auth-'));
  const command = path.join(commandDirectory, 'fake-pi');
  const pathFile = path.join(directory, 'child-path.txt');
  const fixtureUrl = pathToFileURL(path.resolve('test/fixtures/fake-pi.mjs')).href;
  const parentPath = process.env.PATH;
  try {
    await writeFile(command, `#!${process.execPath}\nimport ${JSON.stringify(fixtureUrl)};\n`);
    await chmod(command, 0o755);
    const adapter = new PiRpcWorkerAdapter('pi', {
      adapter: 'pi-rpc',
      command: 'fake-pi',
      noSession: true,
      environment: {
        PATH: commandDirectory,
        PI_CODING_AGENT_DIR: authDirectory,
        FAKE_PI_PATH_FILE: pathFile,
      },
    });
    const testRoute = { ...route, provider: `provider-${randomUUID()}`, requiredEnv: [] };

    const health = await adapter.doctor(testRoute);
    assert.equal(health.ok, true);
    assert.equal(health.details?.command, command);

    const result = await adapter.run(
      {
        jobId: 'job_pi_worker_path',
        prompt: 'do work',
        workspace: directory,
        route: testRoute,
        attempt: 1,
        signal: new AbortController().signal,
      },
      () => undefined
    );

    assert.equal(result.output, 'fake result');
    assert.equal(await readFile(pathFile, 'utf8'), commandDirectory);
    assert.equal(process.env.PATH, parentPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PiRpcWorkerAdapter speaks JSONL RPC and normalizes Pi events', async () => {
  const fixture = path.resolve('test/fixtures/fake-pi.mjs');
  const adapter = new PiRpcWorkerAdapter('pi', {
    adapter: 'pi-rpc',
    command: process.execPath,
    commandArgs: [fixture],
    noSession: true,
  });
  const controller = new AbortController();
  const events: JobEventType[] = [];

  const result = await adapter.run(
    {
      jobId: 'job_test',
      prompt: 'do work',
      workspace: process.cwd(),
      route,
      attempt: 1,
      signal: controller.signal,
    },
    (type) => {
      events.push(type);
    }
  );

  assert.equal(result.output, 'fake result');
  assert.ok(events.includes('worker.started'));
  assert.ok(events.includes('worker.tool.started'));
  assert.ok(events.includes('worker.tool.completed'));
  assert.equal(events.filter((event) => event === 'worker.text.delta').length, 2);
});

test('PiRpcWorkerAdapter decodes split JSONL frames and split UTF-8 exactly', async () => {
  const adapter = createConformanceAdapter('split');
  const result = await adapter.run(conformanceInput(new AbortController().signal), () => undefined);

  assert.equal(result.output, 'before🙂after');
});

test('PiRpcWorkerAdapter reports malformed JSONL before settlement with line context', async () => {
  const adapter = createConformanceAdapter('malformed');

  await assert.rejects(
    adapter.run(conformanceInput(new AbortController().signal), () => undefined),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /malformed JSONL/);
      assert.match(error instanceof Error ? error.message : String(error), /line 2/);
      return true;
    }
  );
});

test('PiRpcWorkerAdapter reports process exit before agent_settled', async () => {
  const adapter = createConformanceAdapter('exit-before-settled');

  await assert.rejects(
    adapter.run(conformanceInput(new AbortController().signal), () => undefined),
    /exited before agent_settled.*code=17.*premature fixture exit/
  );
});

test('PiRpcWorkerAdapter distinguishes agent_end without agent_settled', async () => {
  const adapter = createConformanceAdapter('agent-end-without-settled');

  await assert.rejects(
    adapter.run(conformanceInput(new AbortController().signal), () => undefined),
    /agent_end without agent_settled.*code=23.*missing settlement fixture/
  );
});

test('Orchestrator bounds timeout cleanup when the owned Pi child ignores SIGTERM', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-pi-timeout-'));
  const pidFile = path.join(directory, 'child.pid');
  const sigtermFile = path.join(directory, 'sigterm');
  const orchestrator = createConformanceOrchestrator(
    {
      FAKE_PI_MODE: 'ignore-sigterm',
      FAKE_PI_PID_FILE: pidFile,
      FAKE_PI_SIGTERM_FILE: sigtermFile,
    },
    500
  );
  const started = await orchestrator.start({ prompt: 'timeout', workspace: directory });
  let pid: number | undefined;
  try {
    pid = await waitForPid(pidFile);
    const startedAt = Date.now();
    const job = await started.completion;

    assert.equal(job.status, 'failed');
    assert.match(job.error?.message ?? '', /Worker timed out after 500ms/);
    assert.match(await readFile(sigtermFile, 'utf8'), /ignored/);
    assert.ok(Date.now() - startedAt < 5_000);
    assertProcessGone(pid);
  } finally {
    started.cancel();
    await started.completion.catch(() => undefined);
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The adapter or the test assertion already reaped the exact child.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('Orchestrator bounds cancellation cleanup when the owned Pi child ignores SIGTERM', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-pi-cancel-'));
  const pidFile = path.join(directory, 'child.pid');
  const sigtermFile = path.join(directory, 'sigterm');
  const orchestrator = createConformanceOrchestrator(
    {
      FAKE_PI_MODE: 'ignore-sigterm',
      FAKE_PI_PID_FILE: pidFile,
      FAKE_PI_SIGTERM_FILE: sigtermFile,
    },
    10_000
  );
  const started = await orchestrator.start({ prompt: 'cancel', workspace: directory });
  let pid: number | undefined;
  try {
    pid = await waitForPid(pidFile);
    started.cancel();
    const job = await started.completion;

    assert.equal(job.status, 'cancelled');
    assert.match(job.error?.message ?? '', /Job cancelled by controller/);
    assert.match(await readFile(sigtermFile, 'utf8'), /ignored/);
    assertProcessGone(pid);
  } finally {
    started.cancel();
    await started.completion.catch(() => undefined);
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The adapter or the test assertion already reaped the exact child.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('PiRpcWorkerAdapter propagates the resolved thinking level to a live probe', async () => {
  const fixture = path.resolve('test/fixtures/fake-pi-diagnostics.mjs');
  const adapter = new PiRpcWorkerAdapter('pi', {
    adapter: 'pi-rpc',
    command: process.execPath,
    commandArgs: [fixture],
    noSession: true,
  });

  const result = await adapter.probe({
    route: { ...route, name: 'luna', thinkingLevel: 'max' },
    signal: new AbortController().signal,
  });

  assert.match(result.output, /thinking=max/);
  assert.match(result.output, /retry=false/);
});

test('PiRpcWorkerAdapter preserves provider errors from a live probe', async () => {
  const fixture = path.resolve('test/fixtures/fake-pi-diagnostics.mjs');
  const adapter = new PiRpcWorkerAdapter('pi', {
    adapter: 'pi-rpc',
    command: process.execPath,
    commandArgs: [fixture],
    noSession: true,
    environment: { FAKE_PI_ERROR: 'provider returned 403' },
  });

  await assert.rejects(
    adapter.probe({ route, signal: new AbortController().signal }),
    /provider returned 403/
  );
});

test('PiRpcWorkerAdapter isolates a live probe in a temporary workspace and removes it', async () => {
  const fixture = path.resolve('test/fixtures/fake-pi-diagnostics.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-pi-probe-cwd-'));
  const cwdFile = path.join(directory, 'child.cwd');
  try {
    const adapter = new PiRpcWorkerAdapter('pi', {
      adapter: 'pi-rpc',
      command: process.execPath,
      commandArgs: [fixture],
      noSession: true,
      environment: { FAKE_PI_CWD_FILE: cwdFile },
    });

    await adapter.probe({ route, signal: new AbortController().signal });
    const probeWorkspace = await readFile(cwdFile, 'utf8');
    assert.notEqual(probeWorkspace, process.cwd());
    await assert.rejects(stat(probeWorkspace), (error: unknown) => {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PiRpcWorkerAdapter terminates a live probe child on abort', async () => {
  const fixture = path.resolve('test/fixtures/fake-pi-diagnostics.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-pi-probe-'));
  const pidFile = path.join(directory, 'child.pid');
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    const adapter = new PiRpcWorkerAdapter('pi', {
      adapter: 'pi-rpc',
      command: process.execPath,
      commandArgs: [fixture],
      noSession: true,
      environment: { FAKE_PI_HANG: '1', FAKE_PI_PID_FILE: pidFile },
    });
    pending = adapter.probe({ route, signal: controller.signal });

    let pid: number | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        pid = Number(await readFile(pidFile, 'utf8'));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    assert.ok(pid && Number.isInteger(pid));
    controller.abort(new Error('diagnostic cancelled'));
    await assert.rejects(pending, /diagnostic cancelled/);
    assert.throws(() => process.kill(pid as number, 0), (error: unknown) => {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    });
  } finally {
    controller.abort(new Error('test cleanup'));
    await pending?.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

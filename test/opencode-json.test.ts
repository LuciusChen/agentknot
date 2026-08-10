import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createAdapters } from '../src/adapters/index.js';
import { OpenCodeJsonWorkerAdapter } from '../src/adapters/opencode-json.js';
import type { AgentKnotConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryJobStore } from '../src/store.js';
import type { ResolvedRoute } from '../src/types.js';
import { registerWorkerAdapterConformanceTests } from './worker-adapter-conformance.js';

const execFileAsync = promisify(execFile);
const fixture = path.resolve('test/fixtures/fake-opencode-json.mjs');
const route: ResolvedRoute = {
  name: 'fake-opencode',
  worker: 'opencode',
  provider: 'opencode-go',
  model: 'gpt-5.6-luna',
  thinkingLevel: 'max',
  requiredEnv: ['FAKE_OPENCODE_KEY'],
  maxAttempts: 1,
  timeoutMs: 10_000,
};

function createAdapter(
  mode = 'success',
  environment: Record<string, string> = {}
): OpenCodeJsonWorkerAdapter {
  return new OpenCodeJsonWorkerAdapter('opencode', {
    adapter: 'opencode-json',
    command: process.execPath,
    commandArgs: [fixture],
    environment: {
      FAKE_OPENCODE_KEY: 'configured',
      FAKE_OPENCODE_MODE: mode,
      FAKE_OPENCODE_COMPLETION: 'valid',
      ...environment,
    },
  });
}

function input(signal: AbortSignal, workspace = process.cwd()) {
  return {
    jobId: 'job_opencode_json',
    prompt: 'exercise OpenCode JSON',
    workspace,
    route,
    attempt: 1,
    signal,
  };
}

async function waitForPid(file: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const pid = Number((await readFile(file, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The fixture has not written its PID yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function assertProcessGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  });
}

registerWorkerAdapterConformanceTests({
  name: 'OpenCode JSON',
  createAdapter: () => createAdapter('chunked'),
  route,
  expectedOutput: 'OpenCode conformance output',
  assertHealth: (health) => assert.match(health.message, /OpenCode JSON is ready/),
});

test('OpenCode JSON argv fixes pure JSON mode and preserves exact route data', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-opencode-argv-'));
  const argvFile = path.join(directory, 'argv.json');
  try {
    await createAdapter('success', { FAKE_OPENCODE_ARGV_FILE: argvFile }).run(
      input(new AbortController().signal, directory),
      () => undefined
    );
    const value: unknown = JSON.parse(await readFile(argvFile, 'utf8'));
    assert.ok(Array.isArray(value));
    assert.deepEqual(value.slice(0, -1), [
      'run',
      '--pure',
      '--format',
      'json',
      '--model',
      'opencode-go/gpt-5.6-luna',
      '--variant',
      'max',
      '--dir',
      directory,
    ]);
    assert.equal(typeof value.at(-1), 'string');
    assert.equal(value.at(-1)?.includes('AGENTKNOT_WORKER_COMPLETION_REPORT_V1'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OpenCode JSON doctor uses its own private auth store without Pi credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-opencode-auth-'));
  const authDirectory = path.join(directory, 'opencode');
  const authFile = path.join(authDirectory, 'auth.json');
  try {
    await mkdir(authDirectory, { recursive: true });
    await writeFile(authFile, JSON.stringify({ 'opencode-go': { type: 'api', key: 'fixture-secret' } }));
    await chmod(authFile, 0o600);
    const adapter = createAdapter('success', {
      FAKE_OPENCODE_KEY: '',
      XDG_DATA_HOME: directory,
      PI_CODING_AGENT_DIR: path.join(directory, 'missing-pi-store'),
    });
    adapter.config.unsetEnvironment = ['OPENCODE_API_KEY'];
    const health = await adapter.doctor({ ...route, requiredEnv: [] });
    assert.equal(health.ok, true);
    assert.equal(health.details?.credentialSource, 'opencode-auth-file');
    assert.equal(JSON.stringify(health).includes('fixture-secret'), false);

    await chmod(authFile, 0o644);
    const insecure = await adapter.doctor({ ...route, requiredEnv: [] });
    assert.equal(insecure.ok, false);
    assert.match(insecure.message, /not private/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OpenCode JSON preserves exact session statistics and requires a valid completion report', async () => {
  const result = await createAdapter('success', { FAKE_OPENCODE_COMPLETION: 'valid' }).run(
    input(new AbortController().signal),
    () => undefined
  );
  assert.equal(result.output, 'OpenCode conformance output');
  assert.deepEqual(result.completionReport, {
    schemaVersion: 1,
    changedFiles: ['result.txt'],
    checksRun: [{ command: 'npm test', outcome: 'passed' }],
    remainingRisks: [],
    notes: ['fixture'],
  });
  assert.deepEqual((result.metadata as Record<string, unknown>).sessionStats, {
    toolCalls: 0,
    tokens: { input: 3, output: 5, cacheRead: 2, cacheWrite: 9, total: 19 },
    cost: 0.125,
  });

  await assert.rejects(
    createAdapter('success', { FAKE_OPENCODE_COMPLETION: 'malformed' }).run(
      input(new AbortController().signal),
      () => undefined
    ),
    /malformed required completion report/
  );
});

test('OpenCode JSON rejects missing report, malformed JSONL, error, incomplete, and nonzero settlements', async () => {
  await assert.rejects(
    createAdapter('success', { FAKE_OPENCODE_COMPLETION: 'missing' }).run(
      input(new AbortController().signal),
      () => undefined
    ),
    /missing required completion report/
  );
  await assert.rejects(createAdapter('malformed').run(input(new AbortController().signal), () => undefined), /malformed JSONL/);
  await assert.rejects(createAdapter('error-event').run(input(new AbortController().signal), () => undefined), /fake OpenCode provider error/);
  await assert.rejects(createAdapter('no-finish').run(input(new AbortController().signal), () => undefined), /without a step_finish/);
  await assert.rejects(createAdapter('exit-nonzero').run(input(new AbortController().signal), () => undefined), /code=17.*fake opencode failed/);
});

test('OpenCode JSON abort terminates the exact owned child within a bound', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-opencode-abort-'));
  const pidFile = path.join(directory, 'pid');
  const controller = new AbortController();
  const reason = new Error('cancel OpenCode fixture');
  try {
    const run = createAdapter('block', { FAKE_OPENCODE_PID_FILE: pidFile }).run(
      input(controller.signal, directory),
      () => undefined
    );
    const pid = await waitForPid(pidFile);
    controller.abort(reason);
    await assert.rejects(run, (error: unknown) => error === reason);
    assertProcessGone(pid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OpenCode JSON live probe uses the exact route without a completion report', async () => {
  const result = await createAdapter().probe?.({
    route,
    signal: new AbortController().signal,
  });
  assert.equal(result?.output, 'AgentKnot live inference probe succeeded.');
  assert.equal(result?.output.includes('AGENTKNOT_WORKER_COMPLETION_REPORT_V1'), false);
});

test('OpenCode JSON construction stays behind the built-in adapter registry', () => {
  const config: AgentKnotConfig = {
    version: 1,
    defaultRoute: 'native',
    storage: { directory: '.agentknot/jobs' },
    workers: {
      native: {
        adapter: 'opencode-json',
        command: process.execPath,
        commandArgs: [fixture],
        environment: { FAKE_OPENCODE_KEY: 'configured' },
      },
    },
    routes: {
      native: {
        worker: 'native',
        provider: route.provider,
        model: route.model,
        thinkingLevel: 'max',
        requiredEnv: route.requiredEnv,
      },
    },
  };
  assert.ok(createAdapters(config).get('native') instanceof OpenCodeJsonWorkerAdapter);
});

test('OpenCode JSON timeout uses core semantics and removes the exact child', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-opencode-timeout-'));
  const pidFile = path.join(directory, 'pid');
  const config: AgentKnotConfig = {
    version: 1,
    defaultRoute: 'native',
    storage: { directory: path.join(directory, 'jobs') },
    workers: {
      native: {
        adapter: 'opencode-json',
        command: process.execPath,
        commandArgs: [fixture],
        environment: {
          FAKE_OPENCODE_KEY: 'configured',
          FAKE_OPENCODE_MODE: 'block',
          FAKE_OPENCODE_PID_FILE: pidFile,
        },
      },
    },
    routes: {
      native: {
        worker: 'native',
        provider: route.provider,
        model: route.model,
        thinkingLevel: 'max',
        requiredEnv: ['FAKE_OPENCODE_KEY'],
        maxAttempts: 1,
        timeoutMs: 500,
      },
    },
  };
  try {
    const jobs = new Orchestrator({
      config,
      store: new MemoryJobStore(),
      adapters: createAdapters(config),
    });
    const started = await jobs.start({ prompt: 'timeout', workspace: directory });
    const pid = await waitForPid(pidFile);
    const terminal = await started.completion;
    assert.equal(terminal.status, 'failed');
    assert.match(terminal.error?.message ?? '', /timed out after 500ms/);
    assertProcessGone(pid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OpenCode JSON changes remain controller-captured worktree artifacts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-opencode-artifact-'));
  const repository = path.join(directory, 'repository');
  const worktrees = path.join(directory, 'worktrees');
  const config: AgentKnotConfig = {
    version: 1,
    defaultRoute: 'native',
    storage: { directory: path.join(directory, 'jobs') },
    workspaceIsolation: { mode: 'git-worktree', directory: worktrees },
    workers: {
      native: {
        adapter: 'opencode-json',
        command: process.execPath,
        commandArgs: [fixture],
        environment: {
          FAKE_OPENCODE_KEY: 'configured',
          FAKE_OPENCODE_COMPLETION: 'valid',
          FAKE_OPENCODE_WRITE_FILE: 'created.txt',
        },
      },
    },
    routes: {
      native: {
        worker: 'native',
        provider: route.provider,
        model: route.model,
        thinkingLevel: 'max',
        requiredEnv: ['FAKE_OPENCODE_KEY'],
        maxAttempts: 1,
      },
    },
  };
  try {
    await mkdir(repository);
    await execFileAsync('git', ['init', '-q'], { cwd: repository });
    await execFileAsync('git', ['config', 'user.name', 'AgentKnot Test'], { cwd: repository });
    await execFileAsync('git', ['config', 'user.email', 'agentknot@example.invalid'], {
      cwd: repository,
    });
    await writeFile(path.join(repository, 'README.md'), 'base\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repository });
    await execFileAsync('git', ['commit', '-qm', 'base'], { cwd: repository });

    const jobs = new Orchestrator({
      config,
      store: new MemoryJobStore(),
      adapters: createAdapters(config),
      baseDirectory: directory,
    });
    const terminal = await (await jobs.start({ prompt: 'create a file', workspace: repository })).completion;
    assert.equal(terminal.status, 'succeeded');
    assert.deepEqual(terminal.artifacts?.[0]?.changedFiles, ['created.txt']);
    await assert.rejects(readFile(path.join(repository, 'created.txt')), /ENOENT/);
    const status = await execFileAsync('git', ['status', '--short'], { cwd: repository });
    assert.equal(status.stdout, '');

    const incompleteJobs = new Orchestrator({
      config,
      store: new MemoryJobStore(),
      adapters: new Map([
        ['native', createAdapter('success', { FAKE_OPENCODE_COMPLETION: 'missing' })],
      ]),
      baseDirectory: directory,
    });
    const incomplete = await (
      await incompleteJobs.start({ prompt: 'return only intermediate progress', workspace: repository })
    ).completion;
    assert.equal(incomplete.status, 'failed');
    assert.match(incomplete.error?.message ?? '', /missing required completion report/);
    assert.equal(incomplete.result, undefined);
    assert.deepEqual(incomplete.artifacts?.[0]?.changedFiles, []);
    assert.equal((await incompleteJobs.verifyArtifacts(incomplete.id))?.valid, true);
    assert.deepEqual(await readdir(worktrees), []);
    assert.equal((await execFileAsync('git', ['status', '--short'], { cwd: repository })).stdout, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

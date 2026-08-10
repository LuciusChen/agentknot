import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { FileOrchestrationStore } from '../src/orchestration-store.js';
import type { OrchestrationRecord, OrchestrationStatus } from '../src/orchestration-types.js';
import type { TaskAssessment } from '../src/orchestration-types.js';
import { FileJobStore } from '../src/store.js';
import type { JobRecord, ThinkingLevel } from '../src/types.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const probeFixture = path.resolve('test/fixtures/fake-pi-diagnostics.mjs');
const upstreamAssessmentJson = JSON.stringify({
  schemaVersion: 1,
  recommendation: 'do-not-delegate',
  complexity: 'low',
  parallelizable: false,
  taskKinds: [],
  reasoning: 'Controller keeps this transport fixture upstream.',
  subtasks: [],
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Fixture {
  directory: string;
  configPath: string;
  jobsDirectory: string;
  orchestrationDirectory: string;
  workspace: string;
}

interface RouteFixture {
  name: string;
  worker: string;
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}

async function runCli(configPath: string, ...args: string[]): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args, '--config', configPath], {
      env: { ...process.env, AGENTKNOT_CONFIG: undefined },
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

async function createFixture(kind: 'mock' | 'pi'): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-cli-runtime-'));
  const workspace = path.join(directory, 'workspace');
  const jobsDirectory = path.join(directory, 'jobs');
  const orchestrationDirectory = path.join(directory, 'orchestrations');
  await mkdir(workspace);
  const configPath = path.join(directory, 'agentknot.config.json');
  const route =
    kind === 'mock'
      ? { mock: { worker: 'mock', provider: 'mock', model: 'mock' } }
      : {
          luna: {
            worker: 'pi',
            provider: 'opencode-go',
            model: 'gpt-5.6-luna',
            thinkingLevel: 'max',
          },
        };
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        defaultRoute: kind === 'mock' ? 'mock' : 'luna',
        storage: { directory: 'jobs', orchestrationDirectory: 'orchestrations' },
        workers:
          kind === 'mock'
            ? { mock: { adapter: 'mock' } }
            : {
                pi: {
                  adapter: 'pi-rpc',
                  command: process.execPath,
                  commandArgs: [probeFixture],
                  noSession: true,
                },
              },
        routes: route,
        delegation: { mode: 'off' },
      },
      null,
      2
    )}\n`
  );
  return { directory, configPath, jobsDirectory, orchestrationDirectory, workspace };
}

function staleJob(id: string, route: RouteFixture, workspace: string, pid: number): JobRecord {
  const createdAt = '2026-08-08T01:00:00.000Z';
  const startedAt = '2026-08-08T01:00:01.000Z';
  return {
    id,
    schemaVersion: 1,
    status: 'running',
    request: { prompt: 'stale task', workspace, source: 'test' },
    route: {
      ...route,
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 30_000,
    },
    createdAt,
    updatedAt: startedAt,
    startedAt,
    attempt: 1,
    execution: { runtimeId: 'runtime_exited', pid, startedAt },
    events: [
      {
        sequence: 1,
        jobId: id,
        at: createdAt,
        type: 'job.queued',
        data: { source: 'test' },
      },
      {
        sequence: 2,
        jobId: id,
        at: startedAt,
        type: 'job.started',
        data: {
          route: route.name,
          worker: route.worker,
          provider: route.provider,
          model: route.model,
        },
      },
    ],
  };
}

function staleOrchestration(
  id: string,
  route: RouteFixture,
  workspace: string,
  pid: number
): OrchestrationRecord {
  const createdAt = '2026-08-08T01:00:00.000Z';
  const assessment: TaskAssessment = {
    schemaVersion: 1,
    recommendation: 'do-not-delegate',
    complexity: 'low',
    parallelizable: false,
    taskKinds: ['documentation'],
    reasoning: 'Controller-authored stale-orchestration fixture assessment.',
    subtasks: [],
  };
  return {
    id,
    schemaVersion: 1,
    status: 'dispatching' as Extract<OrchestrationStatus, 'dispatching'>,
    request: { prompt: 'stale orchestration', workspace, assessment, source: 'test' },
    policy: {
      mode: 'off',
      dispatch: { defaultRoute: route.name, maxChildren: 2, maxDepth: 1, maxConcurrency: 1 },
      policy: {
        delegate: ['documentation'],
        keepUpstream: ['product-decision', 'artifact-integration', 'commit', 'push'],
      },
    },
    createdAt,
    updatedAt: createdAt,
    execution: { runtimeId: 'runtime_exited', pid, startedAt: createdAt },
    events: [
      {
        sequence: 1,
        orchestrationId: id,
        at: createdAt,
        type: 'orchestration.queued',
        data: { source: 'test', mode: 'off' },
      },
    ],
    children: [],
  };
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  assert.ok(pid);
  await once(child, 'exit');
  return pid;
}

async function seedStaleRecords(fixture: Fixture, route: RouteFixture): Promise<{
  jobId: string;
  orchestrationId: string;
}> {
  const pid = await exitedPid();
  const jobId = 'job_stale_read';
  const orchestrationId = 'orchestration_stale_read';
  const jobs = new FileJobStore(fixture.jobsDirectory);
  const orchestrations = new FileOrchestrationStore(fixture.orchestrationDirectory);
  await jobs.create(staleJob(jobId, route, fixture.workspace, pid));
  await orchestrations.create(staleOrchestration(orchestrationId, route, fixture.workspace, pid));
  return { jobId, orchestrationId };
}

async function readSnapshot(directory: string, id: string): Promise<Buffer> {
  return readFile(path.join(directory, `${id}.json`));
}

async function startServer(configPath: string): Promise<ReturnType<typeof spawn>> {
  const child = spawn(
    process.execPath,
    [cliPath, 'serve', '--host', '127.0.0.1', '--port', '0', '--config', configPath],
    {
      env: { ...process.env, AGENTKNOT_CONFIG: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };
    const onData = (chunk: Buffer): void => {
      if (!chunk.toString().includes('AgentKnot listening on http://')) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`serve exited before listening (${code ?? signal}): ${stderr}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      child.kill('SIGTERM');
      reject(new Error(`serve did not start within 5 seconds: ${stderr}`));
    }, 5_000);
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
  return child;
}

async function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  await exit;
}

test('read-oriented and invalid CLI commands do not reconcile persisted records', async () => {
  const fixture = await createFixture('pi');
  try {
    const route = {
      name: 'luna',
      worker: 'pi',
      provider: 'opencode-go',
      model: 'gpt-5.6-luna',
      thinkingLevel: 'max',
    } satisfies RouteFixture;
    const ids = await seedStaleRecords(fixture, route);
    const jobSnapshot = await readSnapshot(fixture.jobsDirectory, ids.jobId);
    const orchestrationSnapshot = await readSnapshot(
      fixture.orchestrationDirectory,
      ids.orchestrationId
    );
    const jobsBefore = await readdir(fixture.jobsDirectory);
    const orchestrationsBefore = await readdir(fixture.orchestrationDirectory);

    const commands: Array<{ args: string[]; expectedCode: number }> = [
      { args: ['doctor'], expectedCode: 0 },
      { args: ['doctor', '--live'], expectedCode: 0 },
      { args: ['routes', '--json'], expectedCode: 0 },
      { args: ['jobs', '--json'], expectedCode: 0 },
      { args: ['usage', '--json'], expectedCode: 0 },
      { args: ['show', ids.jobId], expectedCode: 0 },
      { args: ['artifacts', ids.jobId, '--json'], expectedCode: 0 },
      { args: ['artifact-verify', ids.jobId, '--json'], expectedCode: 0 },
      { args: ['artifact-preview', ids.jobId, '1', '--json'], expectedCode: 1 },
      { args: ['delegation', '--json'], expectedCode: 0 },
      { args: ['orchestrations', '--json'], expectedCode: 0 },
      { args: ['orchestration-show', ids.orchestrationId], expectedCode: 0 },
      { args: ['show'], expectedCode: 1 },
      { args: ['serve', '--port', '65536'], expectedCode: 1 },
      { args: ['unknown-command'], expectedCode: 1 },
    ];
    let jobListOutput: string | undefined;
    let liveDiagnosticOutput: string | undefined;

    for (const command of commands) {
      const result = await runCli(fixture.configPath, ...command.args);
      assert.equal(result.code, command.expectedCode, `${command.args.join(' ')}: ${result.stderr}`);
      if (command.args.join(' ') === 'jobs --json') jobListOutput = result.stdout;
      if (command.args.join(' ') === 'doctor --live') liveDiagnosticOutput = result.stdout;
      assert.deepEqual(
        await readSnapshot(fixture.jobsDirectory, ids.jobId),
        jobSnapshot,
        `job changed after ${command.args.join(' ')}`
      );
      assert.deepEqual(
        await readSnapshot(fixture.orchestrationDirectory, ids.orchestrationId),
        orchestrationSnapshot,
        `orchestration changed after ${command.args.join(' ')}`
      );
      assert.deepEqual(await readdir(fixture.jobsDirectory), jobsBefore);
      assert.deepEqual(await readdir(fixture.orchestrationDirectory), orchestrationsBefore);
    }

    assert.notEqual(jobListOutput, undefined);
    assert.equal(jobListOutput, `${JSON.stringify(JSON.parse(jobListOutput!))}\n`);

    const usage = await runCli(fixture.configPath, 'usage');
    assert.equal(usage.code, 0, usage.stderr);
    assert.match(usage.stdout, /^AgentKnot usage report/);
    assert.match(usage.stdout, /Downstream tokens\n  Status +unavailable \(no-successful-jobs\)/);
    assert.match(usage.stdout, /Upstream tokens +unavailable \(not persisted\)/);
    assert.match(usage.stdout, /Upstream \/ downstream +unavailable \(not persisted\)/);
    assert.deepEqual(await readSnapshot(fixture.jobsDirectory, ids.jobId), jobSnapshot);
    assert.deepEqual(
      await readSnapshot(fixture.orchestrationDirectory, ids.orchestrationId),
      orchestrationSnapshot
    );

    assert.notEqual(liveDiagnosticOutput, undefined);
    const diagnostic = JSON.parse(liveDiagnosticOutput!) as {
      route: string;
      liveInference: { checked: boolean; status: string };
    };
    assert.equal(diagnostic.route, 'luna');
    assert.deepEqual(diagnostic.liveInference, { checked: true, status: 'succeeded' });
    assert.deepEqual(await readdir(fixture.jobsDirectory), jobsBefore);
    assert.deepEqual(await readdir(fixture.orchestrationDirectory), orchestrationsBefore);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('execution-owning CLI commands keep startup reconciliation enabled', async () => {
  const executionCommands: Array<{ name: 'run' | 'orchestrate'; args: string[] }> = [
    {
      name: 'run',
      args: ['run', '--prompt', 'execute through the mock worker', '--workspace'],
    },
    {
      name: 'orchestrate',
      args: [
        'orchestrate',
        '--prompt',
        'keep this goal upstream',
        '--assessment-json',
        upstreamAssessmentJson,
        '--workspace',
      ],
    },
  ];

  for (const command of executionCommands) {
    const fixture = await createFixture('mock');
    try {
      const route = { name: 'mock', worker: 'mock', provider: 'mock', model: 'mock' } satisfies RouteFixture;
      const ids = await seedStaleRecords(fixture, route);
      const result = await runCli(
        fixture.configPath,
        ...command.args,
        fixture.workspace,
        '--json'
      );
      assert.equal(result.code, 0, `${command.name}: ${result.stderr}`);

      const jobs = new FileJobStore(fixture.jobsDirectory);
      const orchestrations = new FileOrchestrationStore(fixture.orchestrationDirectory);
      assert.equal((await jobs.get(ids.jobId))?.status, 'failed');
      assert.equal((await orchestrations.get(ids.orchestrationId))?.status, 'failed');
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }

  const fixture = await createFixture('mock');
  let server: ReturnType<typeof spawn> | undefined;
  try {
    const route = { name: 'mock', worker: 'mock', provider: 'mock', model: 'mock' } satisfies RouteFixture;
    const ids = await seedStaleRecords(fixture, route);
    server = await startServer(fixture.configPath);
    const jobs = new FileJobStore(fixture.jobsDirectory);
    const orchestrations = new FileOrchestrationStore(fixture.orchestrationDirectory);
    assert.equal((await jobs.get(ids.jobId))?.status, 'failed');
    assert.equal((await orchestrations.get(ids.orchestrationId))?.status, 'failed');
  } finally {
    if (server !== undefined) await stopServer(server);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('CLI serve refuses a second storage owner and permits restart after owner crash', async () => {
  const fixture = await createFixture('mock');
  let first: ReturnType<typeof spawn> | undefined;
  let restarted: ReturnType<typeof spawn> | undefined;
  try {
    first = await startServer(fixture.configPath);
    const refused = await runCli(fixture.configPath, 'serve', '--host', '127.0.0.1', '--port', '0');
    assert.equal(refused.code, 1);
    assert.match(
      refused.stderr,
      /Another execution-owning AgentKnot runtime already owns storage directory/
    );
    assert.equal(first.exitCode, null);

    const crashed = once(first, 'exit');
    first.kill('SIGKILL');
    await crashed;
    first = undefined;
    restarted = await startServer(fixture.configPath);
  } finally {
    if (first !== undefined) await stopServer(first);
    if (restarted !== undefined) await stopServer(restarted);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

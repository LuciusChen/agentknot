import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { promisify } from 'node:util';

import type { AgentKnotConfig } from '../src/config.js';
import { createAgentKnotHttpServer } from '../src/http-server.js';
import { Orchestrator } from '../src/orchestrator.js';
import { FileJobStore, MemoryJobStore } from '../src/store.js';
import type {
  ResolvedRoute,
  WorkerAdapter,
  WorkerCompletionReport,
  WorkerEventSink,
  WorkerHealth,
  WorkerRunInput,
  WorkerRunResult,
} from '../src/types.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })));
});

const validReport: WorkerCompletionReport = {
  schemaVersion: 1,
  taskOutcome: 'completed',
  changedFiles: ['worker-claimed.ts'],
  checksRun: [
    { command: 'npm test', outcome: 'passed' },
    { command: 'npm run build', outcome: 'failed', notes: 'Worker claim only.' },
    { command: 'npm run lint', outcome: 'unknown', notes: 'No lint script is configured.' },
  ],
  remainingRisks: ['The worker claim is not semantic verification.'],
  notes: ['Worker supplied structured completion evidence.'],
};

function config(
  storageDirectory: string,
  workspaceIsolation?: AgentKnotConfig['workspaceIsolation'],
  maxAttempts = 1
): AgentKnotConfig {
  return {
    version: 1,
    defaultRoute: 'test',
    storage: { directory: storageDirectory },
    ...(workspaceIsolation === undefined ? {} : { workspaceIsolation }),
    workers: { test: { adapter: 'mock' } },
    routes: {
      test: {
        worker: 'test',
        provider: 'provider',
        model: 'model',
        maxAttempts,
        timeoutMs: 2_000,
      },
    },
  };
}

function adapter(
  run: (input: WorkerRunInput, emit: WorkerEventSink) => Promise<WorkerRunResult>
): WorkerAdapter {
  return {
    name: 'test',
    async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
      return { ok: true, message: 'test worker is ready' };
    },
    run,
  };
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: directory, encoding: 'utf8' });
  return String(result.stdout);
}

async function repository(): Promise<{ root: string; worktrees: string; artifacts: string }> {
  const root = await temporaryDirectory('agentknot-completion-source-');
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'agentknot-test@example.invalid');
  await git(root, 'config', 'user.name', 'AgentKnot test');
  await writeFile(path.join(root, 'README.md'), 'base\n');
  await git(root, 'add', '--', '.');
  await git(root, 'commit', '-qm', 'base');
  return {
    root,
    worktrees: await temporaryDirectory('agentknot-completion-worktrees-'),
    artifacts: await temporaryDirectory('agentknot-completion-artifacts-'),
  };
}

test('successful direct jobs expose a structured worker report without claiming captured paths', async () => {
  const workspace = await temporaryDirectory('agentknot-completion-direct-');
  const orchestrator = new Orchestrator({
    config: config(await temporaryDirectory('agentknot-completion-store-')),
    store: new MemoryJobStore(),
    adapters: new Map([
      [
        'test',
        adapter(async (_input, emit) => {
          await emit('worker.raw', { output: 'changed-files.ts' });
          return {
            output: 'changed-files.ts was updated',
            metadata: { proseClaim: 'changed-files.ts' },
            completionReport: validReport,
          };
        }),
      ],
    ]),
  });

  const job = await orchestrator.run({ prompt: 'complete the task', workspace });

  assert.equal(job.status, 'succeeded');
  assert.deepEqual(job.completionSummary, {
    schemaVersion: 1,
    outcome: 'succeeded',
    attempt: 1,
    changedFiles: { status: 'unavailable', reason: 'workspace-isolation-disabled' },
    workerReported: { status: 'reported', report: validReport },
  });
  assert.equal(JSON.stringify(job.completionSummary).includes('proseClaim'), false);
});

test('absent and malformed reports remain unavailable and do not infer from other worker data', async () => {
  const cases: Array<{ name: string; report?: unknown; reason: 'absent' | 'malformed' }> = [
    { name: 'absent', reason: 'absent' },
    {
      name: 'malformed',
      report: {
        schemaVersion: 1,
        changedFiles: ['claimed.ts'],
        checksRun: [{ command: 'npm test', outcome: 'passed', unexpected: true }],
        remainingRisks: [],
        notes: [],
      },
      reason: 'malformed',
    },
  ];

  for (const item of cases) {
    const workspace = await temporaryDirectory(`agentknot-completion-${item.name}-`);
    const orchestrator = new Orchestrator({
      config: config(await temporaryDirectory(`agentknot-completion-store-${item.name}-`)),
      store: new MemoryJobStore(),
      adapters: new Map([
        [
          'test',
          adapter(async (_input, emit) => {
            await emit('worker.stderr', { text: 'changed-files-from-stderr.ts' });
            return {
              output: 'I changed prose-only.ts',
              metadata: {
                sessionStats: {
                  workerCompletionReport: {
                    schemaVersion: 1,
                    changedFiles: ['session-stats.ts'],
                  },
                },
              },
              ...(item.report === undefined ? {} : { completionReport: item.report as WorkerCompletionReport }),
            };
          }),
        ],
      ]),
    });

    const job = await orchestrator.run({ prompt: item.name, workspace });
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(job.completionSummary?.workerReported, {
      status: 'unavailable',
      reason: item.reason,
    });
  }
});

test('worktree summaries capture empty and nonempty terminal-attempt paths with artifact identity', async () => {
  for (const [name, changedFile] of [
    ['empty', undefined],
    ['nonempty', 'captured.ts'],
  ] as const) {
    const paths = await repository();
    const orchestrator = new Orchestrator({
      config: config(paths.artifacts, { mode: 'git-worktree', directory: paths.worktrees }),
      store: new MemoryJobStore(),
      adapters: new Map([
        [
          'test',
          adapter(async (input) => {
            if (changedFile !== undefined) await writeFile(path.join(input.workspace, changedFile), 'captured\n');
            return { output: name };
          }),
        ],
      ]),
    });

    const job = await orchestrator.run({ prompt: name, workspace: paths.root });
    const artifact = job.artifacts?.[0];
    assert.ok(artifact);
    assert.deepEqual(job.completionSummary?.changedFiles, {
      status: 'captured',
      paths: changedFile === undefined ? [] : [changedFile],
      artifact: {
        attempt: artifact.attempt,
        sha256: artifact.sha256,
        baseCommit: artifact.baseCommit,
        baseTree: artifact.baseTree,
      },
    });
  }
});

test('failed and cancelled jobs summarize the terminal attempt and do not retain worker reports', async () => {
  const paths = await repository();
  const failing = new Orchestrator({
    config: config(paths.artifacts, { mode: 'git-worktree', directory: paths.worktrees }),
    store: new MemoryJobStore(),
    adapters: new Map([
      [
        'test',
        adapter(async (input) => {
          await writeFile(path.join(input.workspace, 'failed.ts'), 'failed\n');
          throw new Error('worker failed');
        }),
      ],
    ]),
  });
  const failed = await failing.run({ prompt: 'fail', workspace: paths.root });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.completionSummary?.outcome, 'failed');
  assert.equal(failed.completionSummary?.workerReported.status, 'unavailable');
  assert.equal(
    failed.completionSummary?.workerReported.status === 'unavailable'
      ? failed.completionSummary.workerReported.reason
      : undefined,
    'not-retained'
  );
  assert.deepEqual(
    failed.completionSummary?.changedFiles,
    {
      status: 'captured',
      paths: ['failed.ts'],
      artifact: {
        attempt: failed.artifacts?.[0]?.attempt,
        sha256: failed.artifacts?.[0]?.sha256,
        baseCommit: failed.artifacts?.[0]?.baseCommit,
        baseTree: failed.artifacts?.[0]?.baseTree,
      },
    }
  );

  let started!: () => void;
  const runStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cancellation = new Orchestrator({
    config: config(await temporaryDirectory('agentknot-cancel-store-')),
    store: new MemoryJobStore(),
    adapters: new Map([
      [
        'test',
        adapter(async (input) => {
          started();
          await new Promise<void>((resolve) => {
            if (input.signal.aborted) resolve();
            else input.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { output: 'late normal result', completionReport: validReport };
        }),
      ],
    ]),
  });
  const running = await cancellation.start({ prompt: 'cancel', workspace: paths.root });
  await runStarted;
  await running.cancel();
  const cancelled = await running.completion;
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.completionSummary, {
    schemaVersion: 1,
    outcome: 'cancelled',
    attempt: 1,
    changedFiles: { status: 'unavailable', reason: 'workspace-isolation-disabled' },
    workerReported: { status: 'unavailable', reason: 'not-retained' },
  });
});

test('retries summarize only the terminal attempt while retaining earlier artifacts separately', async () => {
  const paths = await repository();
  const orchestrator = new Orchestrator({
    config: config(paths.artifacts, { mode: 'git-worktree', directory: paths.worktrees }, 2),
    store: new MemoryJobStore(),
    adapters: new Map([
      [
        'test',
        adapter(async (input) => {
          const file = `attempt-${input.attempt}.ts`;
          await writeFile(path.join(input.workspace, file), `${input.attempt}\n`);
          if (input.attempt === 1) throw new Error('retry');
          return {
            output: 'terminal attempt',
            completionReport: { ...validReport, changedFiles: [file], notes: ['terminal attempt only'] },
          };
        }),
      ],
    ]),
  });

  const job = await orchestrator.run({ prompt: 'retry', workspace: paths.root });
  assert.equal(job.status, 'succeeded');
  assert.equal(job.completionSummary?.attempt, 2);
  assert.deepEqual(job.completionSummary?.changedFiles, {
    status: 'captured',
    paths: ['attempt-2.ts'],
    artifact: {
      attempt: 2,
      sha256: job.artifacts?.[1]?.sha256,
      baseCommit: job.artifacts?.[1]?.baseCommit,
      baseTree: job.artifacts?.[1]?.baseTree,
    },
  });
  assert.deepEqual(job.completionSummary?.workerReported, {
    status: 'reported',
    report: { ...validReport, changedFiles: ['attempt-2.ts'], notes: ['terminal attempt only'] },
  });
  assert.deepEqual(job.artifacts?.map((artifact) => artifact.attempt), [1, 2]);
  assert.deepEqual(job.artifacts?.[0]?.changedFiles, ['attempt-1.ts']);
});

test('completion summary is persisted before terminal event observers and callback delivery', async () => {
  const directory = await temporaryDirectory('agentknot-completion-order-');
  const store = new FileJobStore(directory);
  const observed: Array<{ event: string; summary: unknown; persisted: unknown }> = [];
  const callbackBodies: string[] = [];
  const orchestrator = new Orchestrator({
    config: config(directory),
    store,
    adapters: new Map([
      ['test', adapter(async () => ({ output: 'done', completionReport: validReport }))],
    ]),
    fetch: async (_input, init) => {
      callbackBodies.push(String(init?.body));
      return new Response(null, { status: 204 });
    },
    onEvent: async (event, job) => {
      if (!event.type.startsWith('job.') || !event.type.endsWith('succeeded')) return;
      observed.push({
        event: event.type,
        summary: job.completionSummary,
        persisted: (await store.get(job.id))?.completionSummary,
      });
    },
  });

  const job = await orchestrator.run({
    prompt: 'ordering',
    workspace: await temporaryDirectory('agentknot-completion-order-workspace-'),
    callbackUrl: 'https://controller.invalid/job',
  });

  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.event, 'job.succeeded');
  assert.deepEqual(observed[0]?.summary, job.completionSummary);
  assert.deepEqual(observed[0]?.persisted, job.completionSummary);
  assert.deepEqual(JSON.parse(callbackBodies[0] ?? '{}').completionSummary, job.completionSummary);
});

test('HTTP and CLI JSON full JobRecord surfaces include the additive summary', async () => {
  const workspace = await temporaryDirectory('agentknot-completion-http-workspace-');
  const httpConfig = config(await temporaryDirectory('agentknot-completion-http-store-'));
  const orchestrator = new Orchestrator({
    config: httpConfig,
    store: new MemoryJobStore(),
    adapters: new Map([
      ['test', adapter(async () => ({ output: 'http', completionReport: validReport }))],
    ]),
  });
  const http = createAgentKnotHttpServer(orchestrator);
  const address = await http.listen(0);
  const baseUrl = `http://${address.host}:${address.port}`;
  try {
    const created = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'http', workspace }),
    });
    assert.equal(created.status, 202);
    const admitted = (await created.json()) as { job: { id: string; completionSummary?: unknown } };
    assert.equal(admitted.job.completionSummary, undefined);
    let terminal: { status: string; completionSummary?: unknown } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const response = await fetch(`${baseUrl}/v1/jobs/${admitted.job.id}`);
      terminal = ((await response.json()) as { job: typeof terminal }).job;
      if (terminal?.status === 'succeeded') break;
    }
    assert.equal(terminal?.status, 'succeeded');
    assert.deepEqual(terminal?.completionSummary, {
      schemaVersion: 1,
      outcome: 'succeeded',
      attempt: 1,
      changedFiles: { status: 'unavailable', reason: 'workspace-isolation-disabled' },
      workerReported: { status: 'reported', report: validReport },
    });
  } finally {
    await http.close();
  }

  const cliDirectory = await temporaryDirectory('agentknot-completion-cli-');
  const cliWorkspace = path.join(cliDirectory, 'workspace');
  const cliJobs = path.join(cliDirectory, 'jobs');
  const cliConfig = path.join(cliDirectory, 'config.json');
  await mkdir(cliWorkspace);
  await writeFile(
    cliConfig,
    `${JSON.stringify(
      {
        version: 1,
        defaultRoute: 'test',
        storage: { directory: cliJobs },
        workers: { test: { adapter: 'mock' } },
        routes: { test: { worker: 'test', provider: 'provider', model: 'model' } },
      },
      null,
      2
    )}\n`
  );
  const result = await execFileAsync(process.execPath, [
    cliPath,
    'run',
    '--route',
    'test',
    '--workspace',
    cliWorkspace,
    '--json',
    '--config',
    cliConfig,
    'cli',
  ]);
  const cliJob = JSON.parse(String(result.stdout)) as {
    status: string;
    completionSummary?: { outcome: string; changedFiles: { reason?: string } };
  };
  assert.equal(cliJob.status, 'succeeded');
  assert.equal(cliJob.completionSummary?.outcome, 'succeeded');
  assert.equal(cliJob.completionSummary?.changedFiles.reason, 'workspace-isolation-disabled');
});

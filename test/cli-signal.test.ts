import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { SqliteJobStore } from '../src/store.js';

const execFileAsync = promisify(execFile);
const cli = path.resolve('dist/src/cli.js');
const fakePi = path.resolve('test/fixtures/fake-pi-conformance.mjs');

async function waitForPid(file: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const pid = Number((await readFile(file, 'utf8')).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // The exact fake worker has not written its marker yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for exact fake Pi PID: ${file}`);
}

function assertProcessGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  });
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
}

test('CLI SIGTERM cancels and awaits its exact Pi child before releasing storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentknot-cli-signal-'));
  const workspace = path.join(root, 'workspace');
  const storage = path.join(root, 'jobs');
  const orchestrations = path.join(root, 'orchestrations');
  const worktrees = path.join(root, 'worktrees');
  const pidFile = path.join(root, 'fake-pi.pid');
  const sigtermFile = path.join(root, 'fake-pi.sigterm');
  const configPath = path.join(root, 'agentknot.config.json');
  await mkdir(workspace);
  await execFileAsync('git', ['init', '-q'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'agentknot-test@example.invalid'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['config', 'user.name', 'AgentKnot test'], { cwd: workspace });
  await writeFile(path.join(workspace, 'README.md'), 'base\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-qm', 'base'], { cwd: workspace });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        defaultRoute: 'fake-pi',
        storage: { directory: storage, orchestrationDirectory: orchestrations },
        workspaceIsolation: { mode: 'git-worktree', directory: worktrees },
        workers: {
          pi: {
            adapter: 'pi-rpc',
            command: process.execPath,
            commandArgs: [fakePi],
            noSession: true,
            environment: {
              FAKE_PI_MODE: 'ignore-sigterm',
              FAKE_PI_PID_FILE: pidFile,
              FAKE_PI_SIGTERM_FILE: sigtermFile,
            },
          },
        },
        routes: {
          'fake-pi': {
            worker: 'pi',
            provider: 'test-provider',
            model: 'test-model',
            maxAttempts: 1,
            timeoutMs: 30_000,
          },
        },
      },
      null,
      2
    )}\n`
  );

  const child = spawn(
    process.execPath,
    [cli, 'run', '--config', configPath, '--workspace', workspace, '--prompt', 'wait'],
    { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout.resume();
  child.stderr.resume();
  const childExit = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  let workerPid: number | undefined;
  try {
    workerPid = await waitForPid(pidFile);
    child.kill('SIGTERM');
    const [code, signal] = await childExit;

    assert.equal(signal, null);
    assert.equal(code, 1);
    assertProcessGone(workerPid);
    assert.equal((await readFile(sigtermFile, 'utf8')).trim(), 'ignored');
    assert.deepEqual(await readdir(worktrees), []);
    assert.equal(
      (await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: workspace })).stdout,
      ''
    );
    const jobs = await SqliteJobStore.open(storage, { readOnly: true, importLegacy: false });
    try {
      const records = await jobs.list();
      assert.equal(records.length, 1);
      const job = records[0]!;
      assert.equal(job.status, 'cancelled');
      assert.equal(job.events.at(-1)?.type, 'job.cancelled');
      assert.equal(job.artifacts?.length, 1);
    } finally {
      await jobs.close();
    }
    assert.equal((await readdir(storage)).some((name) => name.endsWith('.tmp')), false);
    assert.equal((await readdir(orchestrations)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      if (!(await settlesWithin(childExit, 1_000))) child.kill('SIGKILL');
      await settlesWithin(childExit, 1_000);
    }
    if (workerPid !== undefined) {
      try {
        process.kill(workerPid, 'SIGKILL');
      } catch {
        // The CLI already reaped the exact child.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

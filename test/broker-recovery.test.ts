import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function startBroker(
  root: string,
  environment: NodeJS.ProcessEnv,
  configPath: string,
  timeoutMs: number
): Promise<{ child: ChildProcess; url: string }> {
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
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`broker startup timed out: ${stderr}`));
    }, timeoutMs);
    const onData = (): void => {
      const match = /AgentKnot listening on (http:\/\/[^\s]+)/.exec(stdout);
      if (match?.[1] === undefined) return;
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      resolve(match[1]);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      reject(new Error(`broker exited during startup (${String(code ?? signal)}): ${stderr}`));
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
  return { child, url };
}

async function stopChild(child: ChildProcess | undefined, signal: NodeJS.Signals): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}

async function json(url: string, pathname: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(pathname, url));
  if (!response.ok) assert.fail(`${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

test('broker restart reclaims one parent and child without duplicate admission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentknot-broker-recovery-'));
  const runtimeDirectory = path.join(root, 'runtime');
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const configPath = path.join(root, 'agentknot.config.json');
  await Promise.all([mkdir(runtimeDirectory, { mode: 0o700 }), mkdir(home), mkdir(workspace)]);
  await writeFile(path.join(workspace, 'README.md'), '# recovery fixture\n');
  await execFileAsync('git', ['init', '-q'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.name', 'AgentKnot Test'], { cwd: workspace });
  await execFileAsync('git', ['add', 'README.md'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: workspace });
  await writeFile(
    configPath,
    `${JSON.stringify({
      version: 1,
      defaultRoute: 'mock',
      storage: {
        directory: path.join(root, 'jobs'),
        orchestrationDirectory: path.join(root, 'orchestrations'),
      },
      workspaceIsolation: { mode: 'git-worktree', directory: path.join(root, 'worktrees') },
      workers: { mock: { adapter: 'mock', delayMs: 2_000 } },
      routes: {
        mock: {
          worker: 'mock',
          provider: 'test',
          model: 'mock',
          maxAttempts: 2,
          timeoutMs: 30_000,
        },
      },
      delegation: {
        mode: 'auto',
        dispatch: { defaultRoute: 'mock', maxChildren: 1, maxDepth: 1, maxConcurrency: 1 },
        policy: { delegate: ['implementation'], keepUpstream: ['product-decision'] },
      },
    })}\n`
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDirectory,
    HOME: home,
    USERPROFILE: home,
    AGENTKNOT_CONFIG: undefined,
    AGENTKNOT_SERVER_URL: undefined,
  };

  let broker: ChildProcess | undefined;
  try {
    let running = await startBroker(root, environment, configPath, 5_000);
    broker = running.child;
    const admitted = await fetch(new URL('/v1/orchestrations', running.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Run one recoverable child.',
        workspace,
        source: 'restart-test-controller',
        delegation: 'force',
        idempotencyKey: 'restart-parent',
        assessment: {
          schemaVersion: 1,
          recommendation: 'delegate',
          complexity: 'medium',
          parallelizable: false,
          taskKinds: ['implementation'],
          reasoning: 'One bounded child proves parent recovery.',
          subtasks: [
            {
              title: 'Recoverable child',
              kind: 'implementation',
              prompt: 'Complete without modifying the fixture.',
              acceptanceCriteria: ['the exact child reaches terminal success after restart'],
            },
          ],
        },
      }),
    });
    if (admitted.status !== 202) {
      assert.fail(`orchestration admission returned ${admitted.status}: ${await admitted.text()}`);
    }
    const admittedBody = (await admitted.json()) as {
      orchestration: { id: string };
    };
    const orchestrationId = admittedBody.orchestration.id;

    let childId: string | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const parent = (await json(running.url, `/v1/orchestrations/${orchestrationId}`))
        .orchestration as { children: Array<{ jobId: string }> };
      childId = parent.children[0]?.jobId;
      if (childId !== undefined) {
        const job = (await json(running.url, `/v1/jobs/${childId}`)).job as { status: string };
        if (job.status === 'running') break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(childId);

    await stopChild(broker, 'SIGKILL');
    broker = undefined;
    running = await startBroker(root, environment, configPath, 25_000);
    broker = running.child;

    let terminalParent!: {
      status: string;
      children: Array<{ jobId: string; status: string }>;
      events: Array<{ type: string }>;
    };
    for (let attempt = 0; attempt < 150; attempt += 1) {
      terminalParent = (await json(running.url, `/v1/orchestrations/${orchestrationId}`))
        .orchestration as typeof terminalParent;
      if (terminalParent.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(terminalParent.status, 'succeeded');
    assert.equal(terminalParent.children.length, 1);
    assert.equal(terminalParent.children[0]?.jobId, childId);
    assert.equal(terminalParent.children[0]?.status, 'succeeded');
    assert.equal(
      terminalParent.events.filter((event) => event.type === 'orchestration.recovery.started').length,
      1
    );

    const recoveredJob = (await json(running.url, `/v1/jobs/${childId}`)).job as {
      status: string;
      attempt: number;
      events: Array<{ type: string }>;
    };
    assert.equal(recoveredJob.status, 'succeeded');
    assert.equal(recoveredJob.attempt, 2);
    assert.equal(
      recoveredJob.events.filter((event) => event.type === 'job.attempt.lost').length,
      1
    );
    const jobs = await json(running.url, '/v1/jobs');
    assert.equal(jobs.total, 1);
  } finally {
    await stopChild(broker, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

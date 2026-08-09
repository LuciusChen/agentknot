import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import type { DelegationConfig } from '../src/config.js';
import type { OrchestrationRecord } from '../src/orchestration-types.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

interface CliFixture {
  configPath: string;
  workspace: string;
}

async function createModeOffFixture(): Promise<CliFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-cli-orchestration-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  const configPath = path.join(directory, 'agentknot.config.json');
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        defaultRoute: 'mock',
        storage: { directory: 'jobs', orchestrationDirectory: 'orchestrations' },
        workers: { mock: { adapter: 'mock' } },
        routes: {
          mock: { worker: 'mock', provider: 'mock', model: 'mock' },
          alternate: { worker: 'mock', provider: 'mock', model: 'alternate' },
        },
        delegation: {
          mode: 'off',
          dispatch: {
            defaultRoute: 'alternate',
            routeSelection: { mode: 'active', rules: [{ route: 'mock' }] },
          },
        },
      },
      null,
      2
    )}\n`
  );
  return { configPath, workspace };
}

async function runCli(configPath: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [cliPath, ...args, '--config', configPath], {
    env: { ...process.env, AGENTKNOT_CONFIG: undefined },
  });
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: directory, encoding: 'utf8' });
  return String(result.stdout);
}

async function createArtifactFixture(): Promise<CliFixture> {
  const fixture = await createModeOffFixture();
  await git(fixture.workspace, 'init', '-q');
  await git(fixture.workspace, 'config', 'user.email', 'agentknot-test@example.invalid');
  await git(fixture.workspace, 'config', 'user.name', 'AgentKnot test');
  await writeFile(path.join(fixture.workspace, 'README.md'), 'base\n');
  await git(fixture.workspace, 'add', '--', '.');
  await git(fixture.workspace, 'commit', '-qm', 'base');
  await writeFile(
    fixture.configPath,
    `${JSON.stringify(
      {
        version: 1,
        defaultRoute: 'mock',
        storage: { directory: 'jobs', orchestrationDirectory: 'orchestrations' },
        workspaceIsolation: { mode: 'git-worktree', directory: 'worktrees' },
        workers: { mock: { adapter: 'mock' } },
        routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
        delegation: { mode: 'off' },
      },
      null,
      2
    )}\n`
  );
  return fixture;
}

test('CLI exposes one read-only artifact list, verification, and preview contract', async () => {
  const fixture = await createArtifactFixture();
  const beforeHead = (await git(fixture.workspace, 'rev-parse', 'HEAD')).trim();
  const run = await runCli(
    fixture.configPath,
    'run',
    '--prompt',
    'Create an empty inspection artifact.',
    '--workspace',
    fixture.workspace,
    '--json'
  );
  const job = JSON.parse(run.stdout) as { id: string; artifacts: Array<{ attempt: number }> };
  assert.equal(job.artifacts.length, 1);

  const listed = JSON.parse((await runCli(fixture.configPath, 'artifacts', job.id, '--json')).stdout) as {
    jobId: string;
    artifacts: unknown[];
  };
  assert.equal(listed.jobId, job.id);
  assert.equal(listed.artifacts.length, 1);

  const verified = JSON.parse(
    (await runCli(fixture.configPath, 'artifact-verify', job.id, '--json')).stdout
  ) as { valid: boolean; artifacts: Array<{ valid: boolean; issues: string[] }> };
  assert.equal(verified.valid, true);
  assert.equal(verified.artifacts[0]?.valid, true);
  assert.deepEqual(verified.artifacts[0]?.issues, []);

  const preview = JSON.parse(
    (await runCli(fixture.configPath, 'artifact-preview', job.id, '1', '--json')).stdout
  ) as { jobId: string; content: string | null; truncated: boolean; verification: { valid: boolean } };
  assert.equal(preview.jobId, job.id);
  assert.equal(preview.content, '');
  assert.equal(preview.truncated, false);
  assert.equal(preview.verification.valid, true);
  assert.equal((await git(fixture.workspace, 'rev-parse', 'HEAD')).trim(), beforeHead);
  assert.equal(await git(fixture.workspace, 'status', '--porcelain=v1', '--untracked-files=all'), '');
});

test('CLI orchestration commands use deterministic mode-off configuration', async () => {
  const fixture = await createModeOffFixture();
  const orchestrate = await runCli(
    fixture.configPath,
    'orchestrate',
    '--prompt',
    'Keep this task upstream.',
    '--workspace',
    fixture.workspace,
    '--source',
    'test',
    '--delegation',
    'force',
    '--json'
  );
  const record = JSON.parse(orchestrate.stdout) as OrchestrationRecord;

  assert.equal(record.status, 'succeeded');
  assert.equal(record.request.prompt, 'Keep this task upstream.');
  assert.equal(record.request.workspace, fixture.workspace);
  assert.equal(record.request.source, 'test');
  assert.equal(record.request.delegation, 'force');
  assert.equal(record.policy.mode, 'off');
  assert.equal(record.plan?.mode, 'off');
  assert.equal(record.plan?.willDispatch, false);
  assert.equal(record.result?.action, 'upstream');
  assert.deepEqual(record.children, []);

  const humanDelegation = await runCli(fixture.configPath, 'delegation');
  assert.match(humanDelegation.stdout, /\tworker-default=alternate\t/);
  assert.match(humanDelegation.stdout, /\troute-selection=active\t/);

  const delegation = await runCli(fixture.configPath, 'delegation', '--json');
  const policy = JSON.parse(delegation.stdout) as DelegationConfig;
  assert.equal(policy.mode, 'off');
  assert.equal(policy.planner.route, 'mock');
  assert.equal(policy.dispatch.defaultRoute, 'alternate');
  assert.equal(policy.dispatch.routeSelection?.mode, 'active');

  const list = await runCli(fixture.configPath, 'orchestrations', '--json');
  const records = JSON.parse(list.stdout) as OrchestrationRecord[];
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, record.id);
  assert.equal(records[0]?.result?.action, 'upstream');

  const shown = await runCli(fixture.configPath, 'orchestration-show', record.id);
  const shownRecord = JSON.parse(shown.stdout) as OrchestrationRecord;
  assert.deepEqual(shownRecord, record);
});

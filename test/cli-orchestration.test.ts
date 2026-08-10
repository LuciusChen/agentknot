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

async function createDelegatedFixture(): Promise<CliFixture> {
  const fixture = await createArtifactFixture();
  const plannerOutput = JSON.stringify({
    schemaVersion: 1,
    recommendation: 'delegate',
    complexity: 'low',
    parallelizable: false,
    taskKinds: ['documentation'],
    reasoning: 'One bounded repository deliverable is useful downstream.',
    subtasks: [
      {
        title: 'Write reviewed fixture',
        kind: 'documentation',
        prompt: 'Create reviewed.txt with the reviewed fixture text.',
        acceptanceCriteria: ['reviewed.txt contains the reviewed fixture text'],
      },
    ],
  });
  await writeFile(
    fixture.configPath,
    `${JSON.stringify(
      {
        version: 1,
        defaultRoute: 'worker',
        storage: { directory: 'jobs', orchestrationDirectory: 'orchestrations' },
        workspaceIsolation: { mode: 'git-worktree', directory: 'worktrees' },
        workers: {
          pi: {
            adapter: 'pi-rpc',
            command: process.execPath,
            commandArgs: [path.resolve('test/fixtures/fake-pi.mjs')],
            noSession: true,
            environment: {
              FAKE_PI_PLANNER_OUTPUT: plannerOutput,
              FAKE_PI_COMPLETION_OUTPUT: 'Delegated worker created reviewed.txt.',
              FAKE_PI_REVIEW_OUTPUT: JSON.stringify({
                schemaVersion: 1,
                verdict: 'accept',
                summary: 'The patch matches the bounded acceptance criterion.',
                findings: [],
              }),
              FAKE_PI_WRITE_REVIEWED_FILE: 'true',
            },
          },
        },
        routes: {
          planner: { worker: 'pi', provider: 'test', model: 'planner' },
          worker: { worker: 'pi', provider: 'test', model: 'worker' },
          reviewer: { worker: 'pi', provider: 'test', model: 'reviewer', maxAttempts: 1 },
        },
        delegation: {
          mode: 'auto',
          planner: { route: 'planner' },
          dispatch: { defaultRoute: 'worker', maxChildren: 1, maxConcurrency: 1, maxDepth: 1 },
          policy: {
            delegate: ['documentation'],
            keepUpstream: ['product-decision', 'artifact-integration', 'commit', 'push'],
          },
          qualityReview: { route: 'reviewer', complexities: ['low'] },
          artifactValidation: {
            argv: [
              process.execPath,
              '-e',
              "const fs=require('node:fs');if(fs.readFileSync('reviewed.txt','utf8').trim()==='')process.exit(4);console.log('verified fixture')",
            ],
            timeoutMs: 2_000,
            maxOutputBytes: 1_024,
          },
        },
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

  const handoffRun = await runCli(
    fixture.configPath,
    'orchestrate',
    '--prompt',
    'Keep this second task upstream.',
    '--workspace',
    fixture.workspace,
    '--source',
    'test',
    '--handoff-json'
  );
  const handoff = JSON.parse(handoffRun.stdout) as Record<string, unknown> & {
    request: Record<string, unknown>;
    plan: Record<string, unknown>;
    children: unknown[];
    artifacts: unknown[];
    result: { action: string };
  };
  assert.equal(handoff.status, 'succeeded');
  assert.deepEqual(handoff.request, { source: 'test' });
  assert.equal(handoff.plan.decision, 'upstream');
  assert.deepEqual(handoff.children, []);
  assert.deepEqual(handoff.artifacts, []);
  assert.equal(handoff.result.action, 'upstream');
  for (const omitted of ['policy', 'events', 'execution', 'createdAt', 'updatedAt']) {
    assert.equal(omitted in handoff, false);
  }
  assert.equal('prompt' in handoff.request, false);
  assert.equal('workspace' in handoff.request, false);
  assert.ok(handoffRun.stdout.length < orchestrate.stdout.length);

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
  assert.equal(records.length, 2);
  const listedRecord = records.find((candidate) => candidate.id === record.id);
  assert.equal(listedRecord?.result?.action, 'upstream');

  const shown = await runCli(fixture.configPath, 'orchestration-show', record.id);
  const shownRecord = JSON.parse(shown.stdout) as OrchestrationRecord;
  assert.deepEqual(shownRecord, record);
});

test('CLI compact handoff projects delegated child and verified artifact evidence', async () => {
  const fixture = await createDelegatedFixture();
  const run = await runCli(
    fixture.configPath,
    'orchestrate',
    '--prompt',
    'Create one bounded reviewed fixture.',
    '--workspace',
    fixture.workspace,
    '--source',
    'test',
    '--handoff-json'
  );
  const handoff = JSON.parse(run.stdout) as {
    plan: { decision: string; willDispatch: boolean; assessment: { complexity: string } };
    children: Array<{ status: string; output?: string; jobId: string }>;
    artifacts: Array<{
      jobId: string;
      status: string;
      valid: boolean;
      attempts: Array<{ attempt: number; size: number; valid: boolean; issues: string[] }>;
    }>;
    result: { action: string; artifactReview: { status: string } };
    qualityReview: { status: string; route: string; verdict?: string; reviewerJobId?: string };
    artifactValidation: {
      status: string;
      outcome: string;
      cleanup: string;
      command: { outcome: string; stdoutTail: string; stderrTail: string };
    };
  };

  assert.equal(handoff.plan.decision, 'delegate');
  assert.equal(handoff.plan.willDispatch, true);
  assert.equal(handoff.plan.assessment.complexity, 'low');
  assert.equal(handoff.children.length, 1);
  assert.equal(handoff.children[0]?.status, 'succeeded');
  assert.equal(handoff.children[0]?.output, 'Delegated worker created reviewed.txt.');
  assert.equal(handoff.artifacts.length, 1);
  assert.equal(handoff.artifacts[0]?.jobId, handoff.children[0]?.jobId);
  assert.equal(handoff.artifacts[0]?.status, 'verified');
  assert.equal(handoff.artifacts[0]?.valid, true);
  assert.equal(handoff.artifacts[0]?.attempts.length, 1);
  assert.equal(handoff.artifacts[0]?.attempts[0]?.attempt, 1);
  assert.equal(Number(handoff.artifacts[0]?.attempts[0]?.size) > 0, true);
  assert.equal(handoff.artifacts[0]?.attempts[0]?.valid, true);
  assert.deepEqual(handoff.artifacts[0]?.attempts[0]?.issues, []);
  assert.equal(handoff.qualityReview.status, 'completed');
  assert.equal(handoff.qualityReview.route, 'reviewer');
  assert.equal(handoff.qualityReview.verdict, 'accept');
  assert.equal(handoff.qualityReview.reviewerJobId?.startsWith('job_'), true);
  assert.equal(handoff.artifactValidation.status, 'completed');
  assert.equal(handoff.artifactValidation.outcome, 'passed');
  assert.equal(handoff.artifactValidation.cleanup, 'cleaned');
  assert.equal(handoff.artifactValidation.command.outcome, 'passed');
  assert.equal(handoff.artifactValidation.command.stdoutTail, 'verified fixture\n');
  assert.equal(handoff.artifactValidation.command.stderrTail, '');
  assert.equal(handoff.result.action, 'delegated');
  assert.equal(handoff.result.artifactReview.status, 'checked');
});

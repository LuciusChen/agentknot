import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { SqliteCandidateStore } from '../src/candidate-store.js';
import type { CandidateRecord } from '../src/candidate.js';
import { SqliteReviewStore } from '../src/review-store.js';
import type { ReviewRecord } from '../src/review.js';
import type { WorkOrderRecord } from '../src/work-order.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

interface TaskCandidateJson {
  schemaVersion: 1;
  workOrder: WorkOrderRecord;
  candidate: CandidateRecord;
}

interface TaskReviewJson {
  schemaVersion: 1;
  workOrder: WorkOrderRecord;
  candidate: CandidateRecord;
  review: ReviewRecord;
}

interface TaskReviewsJson {
  schemaVersion: 1;
  workOrder: WorkOrderRecord;
  candidates: CandidateRecord[];
  reviews: ReviewRecord[];
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: directory, encoding: 'utf8' });
  return String(result.stdout);
}

async function runCli(configPath: string, ...args: string[]): Promise<{
  stdout: string;
  stderr: string;
}> {
  const result = await execFileAsync(
    process.execPath,
    [cliPath, ...args, '--config', configPath],
    {
      env: { ...process.env, AGENTKNOT_CONFIG: undefined },
      encoding: 'utf8',
    }
  );
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function runCliFailure(configPath: string, ...args: string[]): Promise<{
  stdout: string;
  stderr: string;
}> {
  try {
    await runCli(configPath, ...args);
  } catch (error: unknown) {
    assert.ok(typeof error === 'object' && error !== null);
    const result = error as { stdout?: unknown; stderr?: unknown };
    return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  }
  throw new Error('Expected AgentKnot CLI command to fail');
}

test('task-review records explicit Review evidence and task-reviews reloads it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-cli-task-review-'));
  const workspace = path.join(directory, 'workspace');
  const configPath = path.join(directory, 'agentknot.config.json');
  await mkdir(workspace);
  try {
    await git(workspace, 'init', '-q');
    await git(workspace, 'config', 'user.email', 'agentknot-test@example.invalid');
    await git(workspace, 'config', 'user.name', 'AgentKnot test');
    await writeFile(path.join(workspace, 'README.md'), 'base\n');
    await git(workspace, 'add', '--', '.');
    await git(workspace, 'commit', '-qm', 'base');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          defaultRoute: 'executor',
          storage: { directory: 'jobs', orchestrationDirectory: 'orchestrations' },
          workspaceIsolation: { mode: 'git-worktree', directory: 'worktrees' },
          workers: { mock: { adapter: 'mock', responsePrefix: 'Review fixture completed' } },
          routes: {
            executor: { worker: 'mock', provider: 'test', model: 'review-fixture' },
          },
          delegation: { mode: 'off' },
        },
        null,
        2
      )}\n`
    );

    const task = JSON.parse(
      (
        await runCli(
          configPath,
          'task',
          'Prepare one reviewable result.',
          '--workspace',
          workspace,
          '--acceptance',
          'The result can be reviewed independently.',
          '--constraint',
          'Do not apply the result.',
          '--json'
        )
      ).stdout
    ) as { workOrder: WorkOrderRecord };
    const workOrderId = task.workOrder.id;
    const candidateEnvelope = JSON.parse(
      (await runCli(configPath, 'task-candidate', workOrderId, '--json')).stdout
    ) as TaskCandidateJson;
    const candidate = candidateEnvelope.candidate;
    const candidateBefore = structuredClone(candidate);

    await assert.rejects(stat(path.join(directory, 'reviews')), { code: 'ENOENT' });
    const human = await runCli(
      configPath,
      'task-review',
      workOrderId,
      '--reviewer',
      'independent-reviewer',
      '--summary',
      'The Candidate stays within the requested boundary.',
      '--finding-json',
      JSON.stringify({
        severity: 'low',
        message: 'One name could be clearer.',
        evidence: 'The public label is broader than the retained record.',
      })
    );
    assert.match(human.stdout, /Task\n  Objective: Prepare one reviewable result\./u);
    assert.match(human.stdout, /Review\n  Reviewer: independent-reviewer/u);
    assert.match(human.stdout, /Summary: The Candidate stays within the requested boundary\./u);
    assert.match(human.stdout, /- low: One name could be clearer\./u);
    assert.match(human.stdout, /Review evidence is recorded\. It is not a verdict/u);
    assert.match(human.stdout, /Next action\n  Consider all relevant Reviews/u);
    assert.doesNotMatch(
      human.stdout,
      new RegExp(`${workOrderId}|${candidate.id}|review_[0-9a-f-]+`, 'u')
    );
    assert.doesNotMatch(human.stdout, /sha256|baseCommit|\/artifacts\//u);

    let firstReview: ReviewRecord;
    const reviews = await SqliteReviewStore.open(path.join(directory, 'reviews'), {
      readOnly: true,
    });
    try {
      const persisted = await reviews.list();
      assert.equal(persisted.length, 1);
      firstReview = persisted[0]!;
      assert.equal(firstReview.candidateId, candidate.id);
      assert.equal(firstReview.reviewer, 'independent-reviewer');
      assert.equal(firstReview.events[0]?.type, 'review.created');
      assert.equal('verdict' in firstReview, false);
      assert.equal('decision' in firstReview, false);
    } finally {
      await reviews.close();
    }

    const candidates = await SqliteCandidateStore.open(path.join(directory, 'candidates'), {
      readOnly: true,
    });
    try {
      assert.deepEqual(await candidates.get(candidate.id), candidateBefore);
    } finally {
      await candidates.close();
    }

    const restartedHuman = await runCli(configPath, 'task-reviews', workOrderId);
    assert.match(restartedHuman.stdout, /1 Candidate and 1 Review are recorded\./u);
    assert.match(restartedHuman.stdout, /Review 1\n    Reviewer: independent-reviewer/u);
    assert.match(restartedHuman.stdout, /Summary: The Candidate stays within/u);
    assert.doesNotMatch(
      restartedHuman.stdout,
      new RegExp(`${workOrderId}|${candidate.id}|${firstReview.id}`, 'u')
    );

    const restartedJson = JSON.parse(
      (await runCli(configPath, 'task-reviews', workOrderId, '--json')).stdout
    ) as TaskReviewsJson;
    assert.equal(restartedJson.workOrder.id, workOrderId);
    assert.deepEqual(restartedJson.candidates, [candidateBefore]);
    assert.deepEqual(restartedJson.reviews, [firstReview]);

    const second = JSON.parse(
      (
        await runCli(
          configPath,
          'task-review',
          workOrderId,
          '--reviewer',
          'second-reviewer',
          '--summary',
          'A second independent review found no additional issues.',
          '--json'
        )
      ).stdout
    ) as TaskReviewJson;
    assert.equal(second.workOrder.id, workOrderId);
    assert.equal(second.candidate.id, candidate.id);
    assert.notEqual(second.review.id, firstReview.id);
    assert.deepEqual(second.review.findings, []);

    const invalid = await runCliFailure(
      configPath,
      'task-review',
      workOrderId,
      '--reviewer',
      'invalid-reviewer',
      '--summary',
      'This input must be rejected.',
      '--finding-json',
      JSON.stringify({ severity: 'critical', message: 'bad', evidence: 'bad' })
    );
    assert.match(invalid.stderr, /severity must be low, medium, or high/u);
    const afterInvalid = await SqliteReviewStore.open(path.join(directory, 'reviews'), {
      readOnly: true,
    });
    try {
      assert.equal((await afterInvalid.list()).length, 2);
    } finally {
      await afterInvalid.close();
    }

    const duplicateCandidates = await SqliteCandidateStore.open(path.join(directory, 'candidates'));
    try {
      const duplicate = structuredClone(candidateBefore);
      duplicate.id = 'candidate_duplicate';
      duplicate.events[0] = {
        ...duplicate.events[0]!,
        candidateId: duplicate.id,
      };
      await duplicateCandidates.create(duplicate);
    } finally {
      await duplicateCandidates.close();
    }
    const ambiguous = await runCliFailure(
      configPath,
      'task-review',
      workOrderId,
      '--reviewer',
      'ambiguous-reviewer',
      '--summary',
      'The command must not guess a Candidate.'
    );
    assert.match(ambiguous.stderr, /multiple Candidates; select one explicitly/u);

    const selected = await runCli(
      configPath,
      'task-review',
      workOrderId,
      '--candidate',
      candidate.id,
      '--reviewer',
      'selected-reviewer',
      '--summary',
      'The original Candidate was selected explicitly.'
    );
    assert.match(selected.stdout, /Reviewer: selected-reviewer/u);
    assert.doesNotMatch(selected.stdout, new RegExp(candidate.id, 'u'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

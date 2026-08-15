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
import { SqliteDispositionStore } from '../src/disposition-store.js';
import type { DispositionRecord } from '../src/disposition.js';
import { SqliteReviewStore } from '../src/review-store.js';
import type { ReviewRecord } from '../src/review.js';
import { SqliteJobStore } from '../src/store.js';
import type { JobRecord } from '../src/types.js';
import { SqliteWorkOrderStore } from '../src/work-order-store.js';
import type { WorkOrderRecord } from '../src/work-order.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

interface TaskJson {
  schemaVersion: 1;
  workOrder: WorkOrderRecord;
  job: JobRecord;
}

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

interface TaskDispositionJson {
  schemaVersion: 1;
  workOrder: WorkOrderRecord;
  candidate: CandidateRecord;
  review: ReviewRecord;
  disposition: DispositionRecord;
}

interface TaskDispositionsJson {
  schemaVersion: 1;
  workOrder: WorkOrderRecord;
  candidates: CandidateRecord[];
  reviews: ReviewRecord[];
  dispositions: DispositionRecord[];
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

test('task-disposition records an explicit final decision and reloads it after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-cli-task-disposition-'));
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
          workers: {
            mock: { adapter: 'mock', responsePrefix: 'Disposition fixture completed' },
          },
          routes: {
            executor: { worker: 'mock', provider: 'test', model: 'disposition-fixture' },
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
          'Prepare one candidate for a final decision.',
          '--workspace',
          workspace,
          '--acceptance',
          'Independent review evidence supports a final decision.',
          '--constraint',
          'Do not apply or promote the artifact.',
          '--json'
        )
      ).stdout
    ) as TaskJson;
    const workOrderBefore = structuredClone(task.workOrder);
    const jobBefore = structuredClone(task.job);
    const candidateEnvelope = JSON.parse(
      (await runCli(configPath, 'task-candidate', task.workOrder.id, '--json')).stdout
    ) as TaskCandidateJson;
    const candidateBefore = structuredClone(candidateEnvelope.candidate);
    const reviewEnvelope = JSON.parse(
      (
        await runCli(
          configPath,
          'task-review',
          task.workOrder.id,
          '--reviewer',
          'independent-reviewer',
          '--summary',
          'The Candidate satisfies the recorded criteria.',
          '--json'
        )
      ).stdout
    ) as TaskReviewJson;
    const reviewBefore = structuredClone(reviewEnvelope.review);

    await assert.rejects(stat(path.join(directory, 'dispositions')), { code: 'ENOENT' });
    const human = await runCli(
      configPath,
      'task-disposition',
      task.workOrder.id,
      '--decision',
      'accept',
      '--decided-by',
      'maintainer',
      '--rationale',
      'The reviewed evidence satisfies the WorkOrder acceptance criteria.'
    );
    assert.match(
      human.stdout,
      /Task\n  Objective: Prepare one candidate for a final decision\./u
    );
    assert.match(human.stdout, /Disposition\n  Decision: accept/u);
    assert.match(human.stdout, /Decided by: maintainer/u);
    assert.match(human.stdout, /Rationale: The reviewed evidence satisfies/u);
    assert.match(
      human.stdout,
      /Review considered: independent-reviewer — The Candidate satisfies/u
    );
    assert.match(human.stdout, /No artifact or canonical workspace was changed/u);
    assert.match(human.stdout, /Next action\n  Inspect and promote the artifact separately/u);

    let firstDisposition: DispositionRecord;
    const dispositions = await SqliteDispositionStore.open(
      path.join(directory, 'dispositions'),
      { readOnly: true }
    );
    try {
      const persisted = await dispositions.list();
      assert.equal(persisted.length, 1);
      firstDisposition = persisted[0]!;
      assert.equal(firstDisposition.candidateId, candidateBefore.id);
      assert.equal(firstDisposition.reviewId, reviewBefore.id);
      assert.equal(firstDisposition.decision, 'accept');
      assert.equal(firstDisposition.events[0]?.type, 'disposition.recorded');
      assert.equal('status' in firstDisposition, false);
      assert.equal('updatedAt' in firstDisposition, false);
    } finally {
      await dispositions.close();
    }
    assert.doesNotMatch(
      human.stdout,
      new RegExp(
        `${task.workOrder.id}|${task.job.id}|${candidateBefore.id}|${reviewBefore.id}|${firstDisposition.id}`,
        'u'
      )
    );
    assert.doesNotMatch(human.stdout, /sha256|baseCommit|\/artifacts\//u);

    const workOrders = await SqliteWorkOrderStore.open(path.join(directory, 'work-orders'), {
      readOnly: true,
    });
    const jobs = await SqliteJobStore.open(path.join(directory, 'jobs'), { readOnly: true });
    const candidates = await SqliteCandidateStore.open(path.join(directory, 'candidates'), {
      readOnly: true,
    });
    const reviews = await SqliteReviewStore.open(path.join(directory, 'reviews'), {
      readOnly: true,
    });
    try {
      assert.deepEqual(await workOrders.get(workOrderBefore.id), workOrderBefore);
      assert.deepEqual(await jobs.get(jobBefore.id), jobBefore);
      assert.deepEqual(await candidates.get(candidateBefore.id), candidateBefore);
      assert.deepEqual(await reviews.get(reviewBefore.id), reviewBefore);
    } finally {
      await Promise.all([
        reviews.close(),
        candidates.close(),
        jobs.close(),
        workOrders.close(),
      ]);
    }

    const restartedHuman = await runCli(
      configPath,
      'task-dispositions',
      task.workOrder.id
    );
    assert.match(restartedHuman.stdout, /1 final disposition is recorded/u);
    assert.match(restartedHuman.stdout, /Disposition 1\n    Decision: accept/u);
    assert.match(restartedHuman.stdout, /No artifact was applied or promoted/u);
    assert.doesNotMatch(
      restartedHuman.stdout,
      new RegExp(
        `${task.workOrder.id}|${candidateBefore.id}|${reviewBefore.id}|${firstDisposition.id}`,
        'u'
      )
    );

    const restartedJson = JSON.parse(
      (await runCli(configPath, 'task-dispositions', task.workOrder.id, '--json')).stdout
    ) as TaskDispositionsJson;
    assert.deepEqual(restartedJson.workOrder, workOrderBefore);
    assert.deepEqual(restartedJson.candidates, [candidateBefore]);
    assert.deepEqual(restartedJson.reviews, [reviewBefore]);
    assert.deepEqual(restartedJson.dispositions, [firstDisposition]);

    const replay = JSON.parse(
      (
        await runCli(
          configPath,
          'task-disposition',
          task.workOrder.id,
          '--decision',
          'accept',
          '--decided-by',
          'maintainer',
          '--rationale',
          'The reviewed evidence satisfies the WorkOrder acceptance criteria.',
          '--json'
        )
      ).stdout
    ) as TaskDispositionJson;
    assert.deepEqual(replay.disposition, firstDisposition);
    assert.deepEqual(replay.candidate, candidateBefore);
    assert.deepEqual(replay.review, reviewBefore);

    const conflict = await runCliFailure(
      configPath,
      'task-disposition',
      task.workOrder.id,
      '--decision',
      'discard',
      '--decided-by',
      'maintainer',
      '--rationale',
      'A different final decision must conflict.'
    );
    assert.match(conflict.stderr, /different final disposition is already recorded/u);
    assert.doesNotMatch(conflict.stderr, new RegExp(candidateBefore.id, 'u'));

    const secondReview = JSON.parse(
      (
        await runCli(
          configPath,
          'task-review',
          task.workOrder.id,
          '--reviewer',
          'second-reviewer',
          '--summary',
          'A second independent review is also available.',
          '--json'
        )
      ).stdout
    ) as TaskReviewJson;
    const ambiguous = await runCliFailure(
      configPath,
      'task-disposition',
      task.workOrder.id,
      '--decision',
      'accept',
      '--decided-by',
      'maintainer',
      '--rationale',
      'The reviewed evidence satisfies the WorkOrder acceptance criteria.'
    );
    assert.match(ambiguous.stderr, /multiple Reviews; select one explicitly/u);

    const selectedReplay = JSON.parse(
      (
        await runCli(
          configPath,
          'task-disposition',
          task.workOrder.id,
          '--review',
          reviewBefore.id,
          '--decision',
          'accept',
          '--decided-by',
          'maintainer',
          '--rationale',
          'The reviewed evidence satisfies the WorkOrder acceptance criteria.',
          '--json'
        )
      ).stdout
    ) as TaskDispositionJson;
    assert.deepEqual(selectedReplay.disposition, firstDisposition);
    assert.notEqual(secondReview.review.id, reviewBefore.id);

    const invalid = await runCliFailure(
      configPath,
      'task-disposition',
      task.workOrder.id,
      '--decision',
      'approve',
      '--decided-by',
      'maintainer',
      '--rationale',
      'This value must be rejected.'
    );
    assert.match(invalid.stderr, /decision must be accept or discard/u);
    const finalDispositions = await SqliteDispositionStore.open(
      path.join(directory, 'dispositions'),
      { readOnly: true }
    );
    try {
      assert.deepEqual(await finalDispositions.list(), [firstDisposition]);
      assert.deepEqual(
        await finalDispositions.eventsAfter(firstDisposition.id, 0),
        firstDisposition.events
      );
    } finally {
      await finalDispositions.close();
    }
    assert.equal((await git(workspace, 'status', '--short')).trim(), '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

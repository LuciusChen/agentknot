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

test('task-show and task-candidate compose per-Candidate evidence after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-cli-task-presentation-'));
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
            mock: { adapter: 'mock', responsePrefix: 'Presentation fixture completed' },
          },
          routes: {
            executor: { worker: 'mock', provider: 'test', model: 'presentation-fixture' },
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
          'Prepare candidates for presentation.',
          '--workspace',
          workspace,
          '--acceptance',
          'The candidate evidence can be reviewed independently.',
          '--constraint',
          'Do not apply or promote the artifact.',
          '--json'
        )
      ).stdout
    ) as TaskJson;
    const workOrderId = task.workOrder.id;
    const candidatesDirectory = path.join(directory, 'candidates');
    const reviewsDirectory = path.join(directory, 'reviews');
    const dispositionsDirectory = path.join(directory, 'dispositions');

    const beforeCandidate = await runCli(configPath, 'task-show', workOrderId);
    assert.match(beforeCandidate.stdout, /Next action\n  Review the result/u);
    await assert.rejects(stat(candidatesDirectory), { code: 'ENOENT' });
    await assert.rejects(stat(reviewsDirectory), { code: 'ENOENT' });
    await assert.rejects(stat(dispositionsDirectory), { code: 'ENOENT' });

    const firstCandidateJson = JSON.parse(
      (await runCli(configPath, 'task-candidate', workOrderId, '--json')).stdout
    ) as TaskCandidateJson;
    const firstCandidate = structuredClone(firstCandidateJson.candidate);
    const candidateJsonEnvelope = Object.keys(firstCandidateJson).sort();
    assert.deepEqual(candidateJsonEnvelope, [
      'artifactVerification',
      'candidate',
      'job',
      'schemaVersion',
      'workOrder',
    ]);
    await assert.rejects(stat(reviewsDirectory), { code: 'ENOENT' });
    await assert.rejects(stat(dispositionsDirectory), { code: 'ENOENT' });

    const firstReviewJson = JSON.parse(
      (
        await runCli(
          configPath,
          'task-review',
          workOrderId,
          '--reviewer',
          'first-reviewer',
          '--summary',
          'The first Candidate is ready for a final decision.',
          '--json'
        )
      ).stdout
    ) as TaskReviewJson;
    const firstReview = firstReviewJson.review;
    const taskShowJsonBeforeDecision = JSON.parse(
      (await runCli(configPath, 'task-show', workOrderId, '--json')).stdout
    ) as { schemaVersion: 1; workOrder: WorkOrderRecord; job: JobRecord; artifactVerification: object };
    assert.deepEqual(Object.keys(taskShowJsonBeforeDecision).sort(), [
      'artifactVerification',
      'job',
      'schemaVersion',
      'workOrder',
    ]);

    const reviewOnly = await runCli(configPath, 'task-show', workOrderId);
    assert.match(reviewOnly.stdout, /Reviewer: first-reviewer/u);
    assert.match(
      reviewOnly.stdout,
      /Next action\n  Record an explicit accept or discard disposition for the reviewed Candidate/u
    );
    assert.doesNotMatch(reviewOnly.stdout, /Next action[\s\S]*promot/iu);
    const candidateReviewOnly = await runCli(configPath, 'task-candidate', workOrderId);
    assert.match(candidateReviewOnly.stdout, /Reviewer: first-reviewer/u);
    assert.match(
      candidateReviewOnly.stdout,
      /Next action\n  Record an explicit accept or discard disposition for the reviewed Candidate/u
    );
    assert.doesNotMatch(candidateReviewOnly.stdout, /Next action[\s\S]*promot/iu);

    await runCli(
      configPath,
      'task-disposition',
      workOrderId,
      '--decision',
      'accept',
      '--decided-by',
      'maintainer',
      '--rationale',
      'The first Candidate satisfies the recorded criteria.'
    );
    const accepted = await runCli(configPath, 'task-show', workOrderId);
    assert.match(accepted.stdout, /Decision: accept/u);
    assert.match(
      accepted.stdout,
      /Next action\n  Inspect and promote the artifact separately if that action is intended\./u
    );
    const acceptedCandidate = await runCli(configPath, 'task-candidate', workOrderId);
    assert.match(acceptedCandidate.stdout, /Decision: accept/u);
    assert.match(
      acceptedCandidate.stdout,
      /Next action\n  Inspect and promote the artifact separately if that action is intended\./u
    );
    const taskShowJsonAfterDecision = JSON.parse(
      (await runCli(configPath, 'task-show', workOrderId, '--json')).stdout
    ) as typeof taskShowJsonBeforeDecision;
    assert.deepEqual(taskShowJsonAfterDecision, taskShowJsonBeforeDecision);
    const candidateJsonAfterDecision = JSON.parse(
      (await runCli(configPath, 'task-candidate', workOrderId, '--json')).stdout
    ) as TaskCandidateJson;
    assert.deepEqual(Object.keys(candidateJsonAfterDecision).sort(), candidateJsonEnvelope);
    assert.deepEqual(candidateJsonAfterDecision.candidate, firstCandidate);

    const secondCandidate = structuredClone(firstCandidate);
    secondCandidate.id = 'candidate_presentation_second';
    secondCandidate.createdAt = new Date(Date.parse(firstCandidate.createdAt) + 1_000).toISOString();
    secondCandidate.events = [
      {
        ...secondCandidate.events[0]!,
        candidateId: secondCandidate.id,
        at: secondCandidate.createdAt,
      },
    ];
    const candidateStore = await SqliteCandidateStore.open(candidatesDirectory);
    try {
      await candidateStore.create(secondCandidate);
    } finally {
      await candidateStore.close();
    }

    const secondReviewJson = JSON.parse(
      (
        await runCli(
          configPath,
          'task-review',
          workOrderId,
          '--candidate',
          secondCandidate.id,
          '--reviewer',
          'second-reviewer',
          '--summary',
          'The second Candidate is also ready for a final decision.',
          '--json'
        )
      ).stdout
    ) as TaskReviewJson;
    const secondReview = secondReviewJson.review;

    const partial = await runCli(configPath, 'task-show', workOrderId);
    assert.match(partial.stdout, /Candidate 1/u);
    assert.match(partial.stdout, /Candidate 2/u);
    assert.match(partial.stdout, /Disposition: not recorded/u);
    assert.match(
      partial.stdout,
      /Resolve each Candidate individually.*explicit disposition for every Candidate/u
    );
    assert.doesNotMatch(partial.stdout, /Next action[\s\S]*promot/iu);
    const selectedPartial = await runCli(configPath, 'task-candidate', workOrderId);
    assert.match(selectedPartial.stdout, /Reviewer: second-reviewer/u);
    assert.doesNotMatch(selectedPartial.stdout, /Reviewer: first-reviewer/u);
    assert.match(
      selectedPartial.stdout,
      /Next action\n  Record an explicit accept or discard disposition for the reviewed Candidate/u
    );

    await runCli(
      configPath,
      'task-disposition',
      workOrderId,
      '--review',
      secondReview.id,
      '--decision',
      'discard',
      '--decided-by',
      'maintainer',
      '--rationale',
      'The second Candidate is not needed.'
    );
    const mixed = await runCli(configPath, 'task-show', workOrderId);
    assert.match(mixed.stdout, /Decision: accept/u);
    assert.match(mixed.stdout, /Decision: discard/u);
    assert.match(
      mixed.stdout,
      /Decisions are mixed; inspect each Candidate individually before taking any artifact action\./u
    );
    assert.doesNotMatch(mixed.stdout, /Next action[\s\S]*promot/iu);
    const selectedMixed = await runCli(configPath, 'task-candidate', workOrderId);
    assert.match(selectedMixed.stdout, /Decision: discard/u);
    assert.doesNotMatch(selectedMixed.stdout, /Decision: accept/u);
    assert.match(
      selectedMixed.stdout,
      /The artifact was not applied or deleted; any cleanup remains a separate action\./u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

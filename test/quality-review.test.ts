import assert from 'node:assert/strict';
import test from 'node:test';

import type { PlannedSubtask } from '../src/orchestration-types.js';
import {
  MAX_QUALITY_REVIEW_OUTPUT_BYTES,
  buildQualityReviewPrompt,
  parseQualityReview,
} from '../src/quality-review.js';
import type { JobArtifactPreview, JobRecord } from '../src/types.js';

const timestamp = '2026-08-10T00:00:00.000Z';
const artifact = {
  kind: 'git-patch' as const,
  attempt: 1,
  path: '/tmp/artifact.patch',
  size: 42,
  sha256: 'a'.repeat(64),
  baseCommit: 'b'.repeat(40),
  changedFiles: ['src/example.ts'],
};
const childJob: JobRecord = {
  id: 'job_child',
  schemaVersion: 1,
  status: 'succeeded',
  request: { prompt: 'implement', workspace: '/tmp/review-fixture' },
  route: {
    name: 'worker',
    worker: 'test',
    provider: 'test',
    model: 'worker',
    requiredEnv: [],
    maxAttempts: 1,
    timeoutMs: 30_000,
  },
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: timestamp,
  attempt: 1,
  events: [],
  artifacts: [artifact],
  result: { output: 'untrusted prose', attempt: 1, worker: 'test', provider: 'test', model: 'worker' },
  completionSummary: {
    schemaVersion: 1,
    outcome: 'succeeded',
    attempt: 1,
    changedFiles: {
      status: 'captured',
      paths: ['src/example.ts'],
      artifact: { attempt: 1, sha256: artifact.sha256, baseCommit: artifact.baseCommit },
    },
    workerReported: {
      status: 'reported',
      report: {
        schemaVersion: 1,
        taskOutcome: 'completed',
        changedFiles: ['src/example.ts'],
        checksRun: [{ command: 'npm test', outcome: 'passed' }],
        remainingRisks: [],
        notes: [],
      },
    },
  },
};
const preview: JobArtifactPreview = {
  jobId: childJob.id,
  artifact,
  format: 'git-patch',
  encoding: 'utf-8',
  content: 'diff --git a/src/example.ts b/src/example.ts\n+export const value = 1;\n',
  truncated: false,
  maxBytes: 1024,
  verification: {
    artifact,
    file: {
      exists: true,
      expectedSize: 42,
      actualSize: 42,
      sizeMatches: true,
      expectedSha256: artifact.sha256,
      actualSha256: artifact.sha256,
      sha256Matches: true,
    },
    source: {
      repositoryAvailable: true,
      expectedBaseCommit: artifact.baseCommit,
      actualHead: artifact.baseCommit,
      headMatchesBase: true,
    },
    issues: [],
    valid: true,
  },
};
const subtask: PlannedSubtask = {
  id: 'subtask_1',
  title: 'Implement example',
  kind: 'independent-implementation',
  prompt: 'Change src/example.ts only.',
  acceptanceCriteria: ['The exported value is one'],
  route: 'worker',
  executionPrompt: 'implement',
};

test('quality review prompt separates verified patch evidence from worker test claims', () => {
  const prompt = buildQualityReviewPrompt({ parentGoal: 'Implement the example.', subtask, childJob, preview });
  assert.match(prompt, /independent advisory quality reviewer/);
  assert.match(prompt, /only permitted text outside the review object/);
  assert.match(prompt, /Use repository inspection tools when available/);
  assert.match(prompt, /Do not edit files, apply the patch, execute repository commands/);
  assert.match(prompt, /Worker completion\/test claims \(unverified\)/);
  assert.match(prompt, /"command":"npm test","outcome":"passed"/);
  assert.match(prompt, /Verified patch preview:/);
  assert.match(prompt, /export const value = 1/);
  assert.doesNotMatch(prompt, /untrusted prose/);
  assert.match(prompt, /upstream controller remains the final authority/);
});

test('parseQualityReview accepts one strict bounded advisory verdict', () => {
  assert.deepEqual(
    parseQualityReview(
      JSON.stringify({
        schemaVersion: 1,
        verdict: 'changes-requested',
        summary: 'One acceptance criterion is not proven.',
        findings: [
          { severity: 'high', message: 'Value is wrong.', evidence: 'The patch exports value = 2.' },
        ],
      })
    ),
    {
      schemaVersion: 1,
      verdict: 'changes-requested',
      summary: 'One acceptance criterion is not proven.',
      findings: [
        { severity: 'high', message: 'Value is wrong.', evidence: 'The patch exports value = 2.' },
      ],
    }
  );
});

test('parseQualityReview rejects malformed, inconsistent, extra, and oversized output', () => {
  const accepted = { schemaVersion: 1, verdict: 'accept', summary: 'Looks correct.', findings: [] };
  assert.throws(() => parseQualityReview(`\`\`\`json\n${JSON.stringify(accepted)}\n\`\`\``), /valid JSON/);
  assert.throws(() => parseQualityReview(JSON.stringify({ ...accepted, extra: true })), /contain only/);
  assert.throws(
    () => parseQualityReview(JSON.stringify({ ...accepted, verdict: 'changes-requested' })),
    /requires at least one finding/
  );
  assert.throws(
    () => parseQualityReview(JSON.stringify({ ...accepted, verdict: 'approved' })),
    /verdict must be/
  );
  assert.throws(() => parseQualityReview('x'.repeat(MAX_QUALITY_REVIEW_OUTPUT_BYTES + 1)), /exceeds/);
});

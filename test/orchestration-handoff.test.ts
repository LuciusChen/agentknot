import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOrchestrationHandoff } from '../src/orchestration-handoff.js';
import {
  MAX_HANDOFF_COMPLETION_TEXT_BYTES,
  MAX_HANDOFF_COMPLETION_ITEMS,
  MAX_HANDOFF_ERROR_BYTES,
  MAX_ORCHESTRATION_HANDOFF_BYTES,
  limitText,
} from '../src/record-limits.js';
import type { OrchestrationRecord } from '../src/orchestration-types.js';
import type {
  JobArtifactVerificationReport,
  JobRecord,
  WorkerCompletionReport,
} from '../src/types.js';

const route = {
  name: 'worker',
  worker: 'mock',
  provider: 'test',
  model: 'fixture',
  requiredEnv: [],
  maxAttempts: 1,
  timeoutMs: 1_000,
};

function completionReport(overrides: Partial<WorkerCompletionReport> = {}): WorkerCompletionReport {
  return {
    schemaVersion: 1,
    taskOutcome: 'completed',
    changedFiles: ['src/summary.ts'],
    checksRun: [{ command: 'npm test', outcome: 'passed' }],
    remainingRisks: ['Manual acceptance remains upstream.'],
    notes: ['Summary-first fixture completed.'],
    ...overrides,
  };
}

function job(id: string, output: string | undefined, report = completionReport()): JobRecord {
  return {
    id,
    schemaVersion: 1,
    status: output === undefined ? 'failed' : 'succeeded',
    request: {
      prompt: 'raw prompt must not enter handoff',
      workspace: '/tmp/workspace',
    },
    route,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:01.000Z',
    completedAt: '2026-08-17T00:00:01.000Z',
    attempt: 1,
    events: [
      {
        sequence: 1,
        jobId: id,
        at: '2026-08-17T00:00:00.000Z',
        type: 'job.queued',
        data: { secretEventHistory: 'must not enter handoff' },
      },
    ],
    ...(output === undefined
      ? {
          error: {
            name: 'WorkerFailure',
            message: 'failure '.repeat(2_000),
            attempt: 1,
            retryable: false,
          },
        }
      : {
          result: {
            output,
            attempt: 1,
            worker: route.worker,
            provider: route.provider,
            model: route.model,
          },
        }),
    completionSummary: {
      schemaVersion: 1,
      outcome: output === undefined ? 'failed' : 'succeeded',
      attempt: 1,
      changedFiles: { status: 'unavailable', reason: 'workspace-isolation-disabled' },
      workerReported: { status: 'reported', report },
    },
  };
}

function orchestration(children: JobRecord[]): OrchestrationRecord {
  return {
    id: 'orchestration_summary_first',
    schemaVersion: 1,
    status: 'succeeded',
    request: {
      prompt: 'parent raw prompt must not enter handoff',
      workspace: '/tmp/workspace',
      source: 'test-controller',
      assessment: {
        schemaVersion: 1,
        recommendation: 'delegate',
        complexity: 'low',
        parallelizable: children.length > 1,
        taskKinds: ['implementation'],
        reasoning: 'Use bounded children.',
        subtasks: children.map((child, index) => ({
          title: `Child ${index + 1}`,
          kind: 'implementation',
          prompt: child.request.prompt,
          acceptanceCriteria: ['Return bounded evidence.'],
        })),
      },
    },
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:01.000Z',
    completedAt: '2026-08-17T00:00:01.000Z',
    policy: {
      mode: 'auto',
      dispatch: {
        defaultRoute: route.name,
        maxChildren: Math.max(2, children.length),
        maxDepth: 1,
        maxConcurrency: Math.max(2, children.length),
      },
      policy: { delegate: ['implementation'], keepUpstream: [] },
    },
    execution: {
      runtimeId: 'runtime-fixture',
      pid: 1,
      startedAt: '2026-08-17T00:00:00.000Z',
    },
    children: children.map((child, index) => ({
      subtaskId: `subtask-${index + 1}`,
      jobId: child.id,
      planHash: 'plan-hash',
      policyVersion: 1,
      status: child.status,
      route,
      ...(child.result === undefined ? {} : { output: child.result.output }),
      ...(child.error === undefined ? {} : { error: child.error }),
    })),
    events: [
      {
        sequence: 1,
        orchestrationId: 'orchestration_summary_first',
        at: '2026-08-17T00:00:00.000Z',
        type: 'orchestration.queued',
        data: { secretEventHistory: 'must not enter handoff' },
      },
    ],
    result: {
      action: 'delegated',
      children: [],
      artifactReview: { status: 'checked', conflicts: [], unavailable: [] },
    },
  };
}

function verification(jobId: string, changedFiles?: string[]): JobArtifactVerificationReport {
  if (changedFiles === undefined) return { jobId, artifacts: [], valid: true };
  const sha256 = 'a'.repeat(64);
  const baseCommit = 'b'.repeat(40);
  const baseTree = 'c'.repeat(40);
  return {
    jobId,
    valid: true,
    artifacts: [
      {
        artifact: {
          kind: 'git-patch',
          attempt: 1,
          path: `/private/${jobId}.patch`,
          size: 512,
          sha256,
          baseCommit,
          baseTree,
          changedFiles: [...changedFiles],
        },
        file: {
          exists: true,
          expectedSize: 512,
          actualSize: 512,
          sizeMatches: true,
          expectedSha256: sha256,
          actualSha256: sha256,
          sha256Matches: true,
        },
        source: {
          repositoryAvailable: true,
          expectedBaseCommit: baseCommit,
          actualHead: baseCommit,
          headMatchesBase: true,
          expectedBaseTree: baseTree,
          actualTree: baseTree,
          treeMatchesBase: true,
        },
        issues: [],
        valid: true,
      },
    ],
  };
}

async function handoffFor(
  jobs: JobRecord[],
  record: OrchestrationRecord,
  changedFiles = new Map<string, string[]>()
): Promise<any> {
  return buildOrchestrationHandoff(
    {
      async getJob(id) {
        return jobs.find((candidate) => candidate.id === id);
      },
      async verifyArtifacts(id) {
        return verification(id, changedFiles.get(id));
      },
    },
    record
  );
}

function nearLimitText(label: string, index: number): string {
  return limitText(
    `${label}-${index}-中文-English-🙂-${'边界-boundary-🚀'.repeat(40)}`,
    MAX_HANDOFF_COMPLETION_TEXT_BYTES
  ).value;
}

function nearLimitCompletionReport(childIndex: number): WorkerCompletionReport {
  return completionReport({
    taskOutcome: childIndex % 2 === 0 ? 'completed' : 'blocked',
    changedFiles: Array.from({ length: MAX_HANDOFF_COMPLETION_ITEMS }, (_, index) =>
      nearLimitText(`src/child-${childIndex}/file`, index)
    ),
    checksRun: Array.from({ length: MAX_HANDOFF_COMPLETION_ITEMS }, (_, index) => ({
      command: nearLimitText(`check-child-${childIndex}`, index),
      outcome: index % 3 === 0 ? 'failed' : 'passed',
      notes: nearLimitText(`check-note-child-${childIndex}`, index),
    })),
    remainingRisks: Array.from({ length: MAX_HANDOFF_COMPLETION_ITEMS }, (_, index) =>
      nearLimitText(`risk-child-${childIndex}`, index)
    ),
    notes: Array.from({ length: MAX_HANDOFF_COMPLETION_ITEMS }, (_, index) =>
      nearLimitText(`note-child-${childIndex}`, index)
    ),
  });
}

function completionItemCount(handoff: any, field: keyof WorkerCompletionReport): number {
  return handoff.children.reduce((total: number, child: any) => {
    const report = child.completion?.workerReported?.report;
    const value = report?.[field];
    return total + (Array.isArray(value) ? value.length : 0);
  }, 0);
}

test('terminal handoff is summary-first for successful, failed, and multiple children', async () => {
  const largeOutput = 'worker output '.repeat(40_000);
  const longReport = completionReport({
    notes: Array.from({ length: MAX_HANDOFF_COMPLETION_ITEMS + 5 }, (_, index) =>
      `note-${index}-${'x'.repeat(500)}`
    ),
  });
  const jobs = [job('job_success', largeOutput, longReport), job('job_failure', undefined)];
  const record = orchestration(jobs);
  const handoff = (await buildOrchestrationHandoff(
    {
      async getJob(id) {
        return jobs.find((candidate) => candidate.id === id);
      },
      async verifyArtifacts(id) {
        return verification(id);
      },
    },
    record
  )) as {
    children: Array<Record<string, unknown>>;
    artifacts: Array<Record<string, unknown>>;
  };

  assert.equal(handoff.children.length, 2);
  for (const child of handoff.children) assert.equal('output' in child, false);
  assert.equal(handoff.children[0]?.outputAvailable, true);
  assert.equal(handoff.children[0]?.outputBytes, Buffer.byteLength(largeOutput, 'utf8'));
  assert.equal(handoff.children[1]?.outputAvailable, false);
  assert.equal((handoff.children[0]?.completion as any).workerReported.status, 'reported');
  assert.equal((handoff.children[0]?.completion as any).workerReported.truncated, true);
  assert.equal(
    (handoff.children[0]?.completion as any).workerReported.report.notes.length,
    MAX_HANDOFF_COMPLETION_ITEMS
  );
  assert.ok(
    Buffer.byteLength(((handoff.children[1]?.error as any).message as string), 'utf8') <=
      MAX_HANDOFF_ERROR_BYTES
  );
  assert.equal(handoff.artifacts.every((artifact) => artifact.status === 'verified'), true);

  const serialized = JSON.stringify(handoff);
  assert.equal(serialized.includes('raw prompt must not enter handoff'), false);
  assert.equal(serialized.includes('secretEventHistory'), false);
  assert.equal(serialized.includes(largeOutput), false);
  const summaryFirstBytes = Buffer.byteLength(serialized, 'utf8');
  assert.ok(summaryFirstBytes <= MAX_ORCHESTRATION_HANDOFF_BYTES);
  assert.equal('handoffTruncation' in handoff, false);

  const legacy = structuredClone(handoff);
  legacy.children = record.children.map((child) => ({
    subtaskId: child.subtaskId,
    jobId: child.jobId,
    status: child.status,
    route: child.route,
    routePoolSelection: child.routePoolSelection,
    output: child.output,
    error: child.error,
  }));
  const legacyBytes = Buffer.byteLength(JSON.stringify(legacy), 'utf8');
  assert.ok(summaryFirstBytes < legacyBytes / 8);

  assert.equal(record.children[0]?.output, largeOutput);
  assert.equal(jobs[0]?.result?.output, largeOutput);
});

test('six-child handoff remains unchanged when its bounded summaries fit the global budget', async () => {
  const jobs = Array.from({ length: 6 }, (_, index) =>
    job(
      `job_moderate_${index + 1}`,
      index % 2 === 0 ? `retained output ${index + 1}` : undefined,
      completionReport({
        taskOutcome: index % 2 === 0 ? 'completed' : 'blocked',
        changedFiles: [`src/child-${index + 1}.ts`],
        checksRun: [{ command: `npm test -- child-${index + 1}`, outcome: 'passed' }],
        remainingRisks: [`risk-${index + 1}`],
        notes: [`note-${index + 1}`],
      })
    )
  );
  const record = orchestration(jobs);
  record.artifactValidation = { status: 'skipped', reason: 'child-count-not-one' };
  const changedFiles = new Map(
    jobs.map((candidate, index) => [candidate.id, [`src/child-${index + 1}.ts`]])
  );

  const handoff = await handoffFor(jobs, record, changedFiles);
  const bytes = Buffer.byteLength(JSON.stringify(handoff), 'utf8');

  assert.ok(bytes <= MAX_ORCHESTRATION_HANDOFF_BYTES);
  assert.equal(handoff.children.length, 6);
  assert.equal('handoffTruncation' in handoff, false);
  assert.equal(handoff.children.every((child: any) => !('output' in child)), true);
  assert.equal(handoff.artifacts.every((artifact: any) => artifact.status === 'verified'), true);
});

test('global handoff budget degrades worst-case summaries deterministically without losing a child', async () => {
  const jobs = Array.from({ length: 6 }, (_, index) =>
    job(
      `job_worst_${index + 1}`,
      index % 2 === 0 ? `durable output ${index + 1} 中文 🙂` : undefined,
      nearLimitCompletionReport(index + 1)
    )
  );
  jobs[0]!.result!.outputTruncation = {
    originalBytes: Buffer.byteLength(jobs[0]!.result!.output, 'utf8') + 1_024,
    maxBytes: Buffer.byteLength(jobs[0]!.result!.output, 'utf8'),
  };
  const record = orchestration(jobs);
  record.artifactValidation = { status: 'skipped', reason: 'child-count-not-one' };
  const changedFiles = new Map(
    jobs.map((candidate, childIndex) => [
      candidate.id,
      Array.from({ length: MAX_HANDOFF_COMPLETION_ITEMS }, (_, index) =>
        nearLimitText(`artifact-child-${childIndex + 1}`, index)
      ),
    ])
  );

  const first = await handoffFor(jobs, record, changedFiles);
  const second = await handoffFor(jobs, record, changedFiles);
  const firstJson = JSON.stringify(first);
  const secondJson = JSON.stringify(second);
  const afterBytes = Buffer.byteLength(firstJson, 'utf8');

  assert.equal(firstJson, secondJson);
  assert.deepEqual(first, second);
  assert.equal(first.children.length, 6);
  assert.ok(afterBytes <= MAX_ORCHESTRATION_HANDOFF_BYTES);
  assert.equal(first.handoffTruncation?.applied, true);
  assert.equal(first.handoffTruncation?.maxBytes, MAX_ORCHESTRATION_HANDOFF_BYTES);
  assert.ok(first.handoffTruncation.originalBytes > MAX_ORCHESTRATION_HANDOFF_BYTES);
  assert.ok(first.handoffTruncation.omittedItems > 0);
  assert.deepEqual(first.handoffTruncation.affectedChildren, [
    'subtask-1',
    'subtask-2',
    'subtask-3',
    'subtask-4',
    'subtask-5',
    'subtask-6',
  ]);

  for (const [index, child] of first.children.entries()) {
    assert.equal(child.subtaskId, `subtask-${index + 1}`);
    assert.equal(child.jobId, `job_worst_${index + 1}`);
    assert.equal(child.status, index % 2 === 0 ? 'succeeded' : 'failed');
    assert.equal(child.outputAvailable, index % 2 === 0);
    assert.equal(typeof child.outputBytes, 'number');
    assert.equal(child.outputTruncated, index === 0);
    assert.equal('output' in child, false);
    assert.equal(typeof child.route?.name, 'string');
    assert.equal(typeof child.completion?.outcome, 'string');
    if (child.status === 'failed') {
      assert.equal(child.error?.code, 'WorkerFailure');
      assert.ok(typeof child.error?.message === 'string' && child.error.message.length > 0);
    }
  }
  assert.equal(first.artifactValidation.status, 'skipped');
  assert.equal(first.artifacts.length, 6);
  assert.equal(
    first.artifacts.every(
      (artifact: any) => artifact.status === 'verified' && artifact.valid === true
    ),
    true
  );

  const totalCompletionItems = 6 * MAX_HANDOFF_COMPLETION_ITEMS;
  const retainedNotes = completionItemCount(first, 'notes');
  const retainedChecks = completionItemCount(first, 'checksRun');
  const retainedChangedFiles = completionItemCount(first, 'changedFiles');
  const retainedRisks = completionItemCount(first, 'remainingRisks');
  const removedCompletionItems =
    totalCompletionItems * 4 -
    retainedNotes -
    retainedChecks -
    retainedChangedFiles -
    retainedRisks;
  assert.ok(first.handoffTruncation.omittedItems >= removedCompletionItems);
  assert.equal(retainedNotes, 0);
  assert.equal(retainedChecks, 0);
  assert.equal(retainedChangedFiles, 0);
  assert.ok(retainedRisks > 0 && retainedRisks < totalCompletionItems);
  assert.equal(firstJson.includes('\ufffd'), false);
  assert.equal(firstJson.includes('中文'), true);
  assert.equal(firstJson.includes('🙂'), true);
  assert.equal(record.children.length, 6);
  assert.equal(jobs[0]!.result!.output, 'durable output 1 中文 🙂');
  assert.equal(changedFiles.get('job_worst_1')?.length, MAX_HANDOFF_COMPLETION_ITEMS);
});

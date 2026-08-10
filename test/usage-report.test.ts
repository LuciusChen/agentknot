import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  OrchestrationRecord,
  PlannedSubtask,
  RouteSelectionEvidence,
  TaskAssessment,
} from '../src/orchestration-types.js';
import type { JobRecord } from '../src/types.js';
import { buildUsageReport } from '../src/usage-report.js';

const timestamp = '2026-08-09T00:00:00.000Z';

function job(id: string, sessionStats: unknown, status: 'succeeded' | 'failed' = 'succeeded'): JobRecord {
  return {
    id,
    schemaVersion: 1,
    status,
    request: { prompt: 'usage fixture', workspace: '/tmp/usage-fixture', source: 'test' },
    route: {
      name: 'luna',
      worker: 'pi',
      provider: 'opencode-go',
      model: 'gpt-5.6-luna',
      thinkingLevel: 'max',
      requiredEnv: [],
      maxAttempts: 1,
      timeoutMs: 30_000,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    attempt: 1,
    events: [],
    ...(status === 'succeeded'
      ? {
          result: {
            output: 'done',
            attempt: 1,
            worker: 'pi',
            provider: 'opencode-go',
            model: 'gpt-5.6-luna',
            metadata: sessionStats === undefined ? {} : { sessionStats },
          },
        }
      : {
          error: {
            name: 'Error',
            message: 'failed',
            attempt: 1,
            retryable: false,
          },
        }),
  };
}

function stats(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  total: number,
  cost: number
): Record<string, unknown> {
  return {
    tokens: { input, output, cacheRead, cacheWrite, total },
    cost,
  };
}

function subtask(
  id: string,
  route: string,
  routeSelection?: RouteSelectionEvidence
): PlannedSubtask {
  return {
    id,
    title: id,
    kind: 'test-gap-analysis',
    prompt: id,
    acceptanceCriteria: ['report evidence'],
    route,
    executionPrompt: id,
    ...(routeSelection === undefined ? {} : { routeSelection }),
  };
}

function orchestration(
  id: string,
  mode: 'active' | 'shadow',
  subtasks: PlannedSubtask[]
): OrchestrationRecord {
  const assessment: TaskAssessment = {
    schemaVersion: 1,
    recommendation: 'delegate',
    complexity: 'low',
    parallelizable: true,
    taskKinds: ['test-gap-analysis'],
    reasoning: 'fixture',
    subtasks: subtasks.map(({ title, kind, prompt, acceptanceCriteria }) => ({
      title,
      kind,
      prompt,
      acceptanceCriteria,
    })),
  };
  return {
    id,
    schemaVersion: 1,
    status: 'succeeded',
    request: { prompt: 'route fixture', workspace: '/tmp/usage-fixture', source: 'test', assessment },
    policy: {
      mode: 'auto',
      dispatch: {
        defaultRoute: 'luna',
        maxChildren: 6,
        maxDepth: 1,
        maxConcurrency: 6,
        routeSelection: {
          mode,
          rules: [{ route: 'deepseek-flash', complexities: ['low'] }],
        },
      },
      policy: {
        delegate: ['test-gap-analysis'],
        keepUpstream: ['product-decision'],
      },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    execution: { runtimeId: 'runtime_usage', pid: 1, startedAt: timestamp },
    events: [],
    plan: {
      policyVersion: 1,
      planHash: 'a'.repeat(64),
      mode: 'auto',
      decision: 'split',
      willDispatch: true,
      reasoning: 'fixture',
      assessment,
      subtasks,
    },
    children: [],
    result: { action: 'delegated', children: [] },
  };
}

test('usage report aggregates exact persisted stats and separates active and shadow route hits', () => {
  const jobs = [
    job('job_valid_1', stats(10, 5, 30, 2, 47, 0.2)),
    job('job_valid_2', stats(20, 7, 10, 3, 40, 0.3)),
    job('job_missing', undefined),
    job('job_timeout', { unavailableReason: 'timeout' }),
    job('job_failed', undefined, 'failed'),
  ];
  const active = orchestration('orchestration_active', 'active', [
    subtask('rule', 'deepseek-flash', {
      mode: 'active',
      selectedRoute: 'deepseek-flash',
      basis: 'rule',
      ruleIndex: 0,
    }),
    subtask('default', 'luna', {
      mode: 'active',
      selectedRoute: 'luna',
      basis: 'default',
    }),
    subtask('missing', 'luna'),
    subtask('policy-mismatch', 'luna', {
      mode: 'active',
      selectedRoute: 'deepseek-flash',
      basis: 'rule',
      ruleIndex: 0,
    }),
  ]);
  const shadow = orchestration('orchestration_shadow', 'shadow', [
    subtask('shadow-rule', 'luna', {
      mode: 'shadow',
      suggestedRoute: 'deepseek-flash',
      basis: 'rule',
      ruleIndex: 0,
    }),
  ]);

  const report = buildUsageReport(jobs, [active, shadow]);

  assert.deepEqual(report.scope, {
    totalJobs: 5,
    successfulJobs: 4,
    statsAvailableJobs: 2,
    statsUnavailableJobs: 2,
    terminalOrchestrations: 2,
    plannedSubtasks: 5,
  });
  assert.equal(report.downstream.status, 'available');
  if (report.downstream.status !== 'available') assert.fail('downstream usage should be available');
  assert.equal(report.downstream.coverage, 'partial');
  assert.deepEqual(report.downstream.tokens, {
    input: 30,
    output: 12,
    cacheRead: 40,
    cacheWrite: 5,
    total: 87,
  });
  assert.equal(report.downstream.providerReportedCost, 0.5);
  assert.deepEqual(report.downstream.unavailable, [
    { reason: 'missing', count: 1 },
    { reason: 'timeout', count: 1 },
  ]);
  assert.deepEqual(report.downstream.cacheReadHitRate, {
    status: 'available',
    formula: 'cacheRead / (input + cacheRead)',
    numerator: 40,
    denominator: 70,
    value: 40 / 70,
  });
  assert.equal(report.routeSelection.status, 'available');
  assert.equal(report.routeSelection.coverage, 'partial');
  assert.equal(report.routeSelection.classifiedSelections, 3);
  assert.equal(report.routeSelection.unavailableSelections, 2);
  assert.deepEqual(report.routeSelection.active.selections, [
    { basis: 'rule', route: 'deepseek-flash', ruleIndex: 0, count: 1 },
    { basis: 'default', route: 'luna', count: 1 },
  ]);
  assert.equal(report.routeSelection.active.ruleHitRate.status, 'available');
  if (report.routeSelection.active.ruleHitRate.status === 'available') {
    assert.equal(report.routeSelection.active.ruleHitRate.value, 0.5);
  }
  assert.equal(report.routeSelection.shadow.ruleHitRate.status, 'available');
  if (report.routeSelection.shadow.ruleHitRate.status === 'available') {
    assert.equal(report.routeSelection.shadow.ruleHitRate.value, 1);
  }
  assert.deepEqual(report.upstream, {
    status: 'unavailable',
    reason: 'controller-usage-not-persisted',
  });
  assert.deepEqual(report.proportions, report.upstream);
  assert.equal(report.qualityReview.status, 'unavailable');
  if (report.qualityReview.status !== 'unavailable') assert.fail('review usage should be unavailable');
  assert.equal(report.qualityReview.reason, 'no-configured-quality-reviews');
});

test('usage report keeps valid zero stats distinct from missing evidence', () => {
  const report = buildUsageReport([job('job_zero', stats(0, 0, 0, 0, 0, 0))], []);

  assert.equal(report.downstream.status, 'available');
  if (report.downstream.status !== 'available') assert.fail('zero stats should be available');
  assert.equal(report.downstream.coverage, 'complete');
  assert.deepEqual(report.downstream.tokens, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
  assert.deepEqual(report.downstream.cacheReadHitRate, {
    status: 'unavailable',
    formula: 'cacheRead / (input + cacheRead)',
    reason: 'zero-denominator',
  });
  assert.equal(report.routeSelection.status, 'unavailable');
});

test('usage report exposes exact persisted route-pool distribution', () => {
  const first = job('job_pool_a', stats(1, 1, 0, 0, 2, 0));
  const second = job('job_pool_b', stats(1, 1, 0, 0, 2, 0));
  first.request.route = 'luna-workers';
  first.routePoolSelection = {
    pool: 'luna-workers',
    strategy: 'least-active',
    candidates: ['luna', 'opencode-luna'],
    selectedRoute: 'luna',
    activeBefore: { luna: 0, 'opencode-luna': 0 },
    cursorBefore: 0,
    selectedMemberIndex: 0,
    tieBreak: 'rotating-order',
  };
  second.request.route = 'luna-workers';
  second.route = { ...second.route, name: 'opencode-luna', worker: 'opencode' };
  second.routePoolSelection = {
    pool: 'luna-workers',
    strategy: 'least-active',
    candidates: ['luna', 'opencode-luna'],
    selectedRoute: 'opencode-luna',
    activeBefore: { luna: 1, 'opencode-luna': 0 },
    cursorBefore: 1,
    selectedMemberIndex: 1,
    tieBreak: 'rotating-order',
  };

  const report = buildUsageReport([first, second], []);
  assert.deepEqual(report.routePools, {
    status: 'available',
    coverage: 'complete',
    observedJobs: 2,
    classifiedJobs: 2,
    unavailableJobs: 0,
    selections: [
      { pool: 'luna-workers', route: 'luna', count: 1 },
      { pool: 'luna-workers', route: 'opencode-luna', count: 1 },
    ],
  });
});

test('usage report aggregates route-neutral advisory review evidence without inferring controller acceptance', () => {
  const completedAccept = orchestration('orchestration_review_accept', 'active', []);
  completedAccept.policy.qualityReview = { route: 'reviewer-a', complexities: ['low'] };
  completedAccept.qualityReview = {
    status: 'completed',
    route: 'reviewer-a',
    childJobId: 'job_worker_a',
    reviewerJobId: 'job_reviewer_a',
    verdict: 'accept',
    summary: 'The patch satisfies the stated acceptance criteria.',
    findings: [
      { severity: 'low', message: 'Minor naming issue.', evidence: 'src/example.ts:10' },
      { severity: 'high', message: 'High-risk edge case checked.', evidence: 'test/example.test.ts:20' },
    ],
  };

  const completedChanges = orchestration('orchestration_review_changes', 'active', []);
  completedChanges.policy.qualityReview = { route: 'reviewer-b', complexities: ['low'] };
  completedChanges.qualityReview = {
    status: 'completed',
    route: 'reviewer-b',
    childJobId: 'job_worker_b',
    reviewerJobId: 'job_reviewer_b',
    verdict: 'changes-requested',
    summary: 'One bounded correction is required.',
    findings: [
      { severity: 'medium', message: 'Missing boundary handling.', evidence: 'src/example.ts:25' },
    ],
  };

  const skipped = orchestration('orchestration_review_skipped', 'active', []);
  skipped.policy.qualityReview = { route: 'reviewer-a', complexities: ['low'] };
  skipped.qualityReview = { status: 'skipped', route: 'reviewer-a', reason: 'artifact-empty' };

  const unavailable = orchestration('orchestration_review_unavailable', 'active', []);
  unavailable.policy.qualityReview = { route: 'reviewer-a', complexities: ['low'] };
  unavailable.qualityReview = {
    status: 'unavailable',
    route: 'reviewer-a',
    reason: 'reviewer-failed',
  };

  const unclassified = orchestration('orchestration_review_missing', 'active', []);
  unclassified.policy.qualityReview = { route: 'reviewer-a', complexities: ['low'] };

  const report = buildUsageReport([], [
    completedAccept,
    completedChanges,
    skipped,
    unavailable,
    unclassified,
  ]);

  assert.equal(report.qualityReview.status, 'available');
  if (report.qualityReview.status !== 'available') assert.fail('review usage should be available');
  assert.equal(report.qualityReview.coverage, 'partial');
  assert.equal(report.qualityReview.configuredOrchestrations, 5);
  assert.equal(report.qualityReview.classifiedReviews, 4);
  assert.equal(report.qualityReview.unclassifiedReviews, 1);
  assert.deepEqual(report.qualityReview.outcomes, { completed: 2, skipped: 1, unavailable: 1 });
  assert.deepEqual(report.qualityReview.verdicts, {
    accept: 1,
    changesRequested: 1,
    uncertain: 0,
  });
  assert.deepEqual(report.qualityReview.findingSeverities, { low: 1, medium: 1, high: 1 });
  assert.deepEqual(report.qualityReview.reviewerRoutes, [
    { route: 'reviewer-a', count: 3 },
    { route: 'reviewer-b', count: 1 },
  ]);
  assert.deepEqual(report.qualityReview.reasons, [
    { status: 'skipped', reason: 'artifact-empty', count: 1 },
    { status: 'unavailable', reason: 'reviewer-failed', count: 1 },
  ]);
  assert.deepEqual(report.qualityReview.controllerDisposition, {
    status: 'unavailable',
    reason: 'controller-review-disposition-not-persisted',
  });
});

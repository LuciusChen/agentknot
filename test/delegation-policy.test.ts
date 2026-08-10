import assert from 'node:assert/strict';
import test from 'node:test';

import type { DelegationConfig } from '../src/config.js';
import { composeDelegationPlan, validateTaskAssessment } from '../src/delegation-policy.js';
import type { OrchestrationRequest, TaskAssessment } from '../src/orchestration-types.js';

const config: DelegationConfig = {
  mode: 'auto',
  dispatch: { defaultRoute: 'worker', maxChildren: 2, maxDepth: 1, maxConcurrency: 1 },
  policy: {
    delegate: ['documentation', 'repository-analysis', 'test-gap-analysis', 'independent-implementation'],
    keepUpstream: ['product-decision', 'artifact-integration', 'commit', 'push'],
  },
};

const assessment: TaskAssessment = {
  schemaVersion: 1,
  recommendation: 'delegate',
  complexity: 'medium',
  parallelizable: true,
  taskKinds: ['independent-implementation', 'test-gap-analysis', 'documentation'],
  reasoning: 'The review and documentation tracks are independent.',
  subtasks: [
    {
      title: 'Review test gaps',
      kind: 'test-gap-analysis',
      prompt: 'Review the implementation tests and identify missing cases.',
      acceptanceCriteria: ['List concrete missing cases'],
    },
    {
      title: 'Update documentation',
      kind: 'documentation',
      prompt: 'Update the documentation for the implemented behavior.',
      acceptanceCriteria: ['Current and proposed behavior are distinguished'],
    },
  ],
};

const request: OrchestrationRequest = {
  prompt: 'Implement the feature, review the tests, and update the documentation',
  workspace: '/tmp/project',
  assessment,
  source: 'claude',
};

test('validateTaskAssessment accepts a strict controller handoff and returns a defensive copy', () => {
  const validated = validateTaskAssessment(assessment);
  assert.deepEqual(validated, assessment);
  assert.notEqual(validated, assessment);
  assert.notEqual(validated.subtasks, assessment.subtasks);
  assert.notEqual(validated.subtasks[0], assessment.subtasks[0]);
  assert.throws(() => validateTaskAssessment(JSON.stringify(assessment)), /Controller assessment must be an object/);
  assert.throws(() => validateTaskAssessment(null), /Controller assessment must be an object/);
  assert.throws(
    () => validateTaskAssessment({ ...assessment, parallelizable: 'yes' }),
    /Controller assessment parallelizable must be a boolean/
  );
  assert.throws(
    () => validateTaskAssessment({ ...assessment, unexpected: true }),
    /unknown: unexpected/
  );
});

test('validateTaskAssessment strictly rejects a subtask that omits acceptanceCriteria', () => {
  const withoutAcceptanceCriteria = {
    ...assessment,
    subtasks: assessment.subtasks.map((subtask) => {
      const { acceptanceCriteria: _acceptanceCriteria, ...rest } = subtask;
      return rest;
    }),
  };
  assert.throws(
    () => validateTaskAssessment(withoutAcceptanceCriteria),
    /Controller assessment subtasks\[0\] must contain exactly \[title, kind, prompt, acceptanceCriteria\].*missing: acceptanceCriteria/
  );
});

test('composeDelegationPlan uses ordered shadow rules with AND predicates and keeps default execution routes', () => {
  const shadowConfig: DelegationConfig = {
    ...config,
    dispatch: {
      ...config.dispatch,
      routeSelection: {
        mode: 'shadow',
        rules: [
          { route: 'combined', taskKinds: ['test-gap-analysis'], complexities: ['high'] },
          { route: 'first-kind', taskKinds: ['test-gap-analysis'] },
          { route: 'second-kind', taskKinds: ['test-gap-analysis'] },
          { route: 'complexity', complexities: ['medium'] },
          { route: 'catch-all' },
        ],
      },
    },
  };

  const plan = composeDelegationPlan(request, assessment, shadowConfig);
  assert.equal(plan.willDispatch, true);
  assert.deepEqual(
    plan.subtasks.map((subtask) => ({
      kind: subtask.kind,
      route: subtask.route,
      routeSelection: subtask.routeSelection,
    })),
    [
      {
        kind: 'test-gap-analysis',
        route: 'worker',
        routeSelection: {
          mode: 'shadow',
          suggestedRoute: 'first-kind',
          basis: 'rule',
          ruleIndex: 1,
        },
      },
      {
        kind: 'documentation',
        route: 'worker',
        routeSelection: {
          mode: 'shadow',
          suggestedRoute: 'complexity',
          basis: 'rule',
          ruleIndex: 3,
        },
      },
    ]
  );

  const catchAll = composeDelegationPlan(request, assessment, {
    ...shadowConfig,
    dispatch: {
      ...shadowConfig.dispatch,
      routeSelection: { mode: 'shadow', rules: [{ route: 'catch-all' }] },
    },
  });
  assert.equal(catchAll.subtasks.every((subtask) => subtask.route === 'worker'), true);
  assert.equal(
    catchAll.subtasks.every(
      (subtask) =>
        subtask.routeSelection?.mode === 'shadow' &&
        subtask.routeSelection?.basis === 'rule' &&
        subtask.routeSelection.suggestedRoute === 'catch-all' &&
        subtask.routeSelection.ruleIndex === 0
    ),
    true
  );

  const noMatch = composeDelegationPlan(request, assessment, {
    ...shadowConfig,
    dispatch: {
      ...shadowConfig.dispatch,
      routeSelection: {
        mode: 'shadow',
        rules: [{ route: 'candidate', taskKinds: ['architecture-review'] }],
      },
    },
  });
  assert.deepEqual(
    noMatch.subtasks.map((subtask) => subtask.routeSelection),
    [
      { mode: 'shadow', suggestedRoute: 'worker', basis: 'default' },
      { mode: 'shadow', suggestedRoute: 'worker', basis: 'default' },
    ]
  );
  assert.equal(noMatch.subtasks.every((subtask) => subtask.route === 'worker'), true);

  const withoutSelection = composeDelegationPlan(request, assessment, config);
  assert.notEqual(plan.planHash, withoutSelection.planHash);
  const changedSuggestion = composeDelegationPlan(request, assessment, {
    ...shadowConfig,
    dispatch: {
      ...shadowConfig.dispatch,
      routeSelection: {
        mode: 'shadow',
        rules: [
          { route: 'combined', taskKinds: ['test-gap-analysis'], complexities: ['high'] },
          { route: 'changed-kind', taskKinds: ['test-gap-analysis'] },
          { route: 'second-kind', taskKinds: ['test-gap-analysis'] },
          { route: 'complexity', complexities: ['medium'] },
          { route: 'catch-all' },
        ],
      },
    },
  });
  assert.notEqual(plan.planHash, changedSuggestion.planHash);
});

test('composeDelegationPlan applies only human-configured active routes with a conservative default', () => {
  const activeConfig: DelegationConfig = {
    ...config,
    dispatch: {
      ...config.dispatch,
      routeSelection: {
        mode: 'active',
        rules: [{ route: 'deepseek-flash', complexities: ['low'] }],
      },
    },
  };

  const low = composeDelegationPlan(request, { ...assessment, complexity: 'low' }, activeConfig);
  assert.deepEqual(
    low.subtasks.map((subtask) => ({ route: subtask.route, evidence: subtask.routeSelection })),
    [
      {
        route: 'deepseek-flash',
        evidence: {
          mode: 'active',
          selectedRoute: 'deepseek-flash',
          basis: 'rule',
          ruleIndex: 0,
        },
      },
      {
        route: 'deepseek-flash',
        evidence: {
          mode: 'active',
          selectedRoute: 'deepseek-flash',
          basis: 'rule',
          ruleIndex: 0,
        },
      },
    ]
  );

  const medium = composeDelegationPlan(request, assessment, activeConfig);
  assert.deepEqual(
    medium.subtasks.map((subtask) => ({ route: subtask.route, evidence: subtask.routeSelection })),
    [
      {
        route: 'worker',
        evidence: { mode: 'active', selectedRoute: 'worker', basis: 'default' },
      },
      {
        route: 'worker',
        evidence: { mode: 'active', selectedRoute: 'worker', basis: 'default' },
      },
    ]
  );
  assert.notEqual(low.planHash, medium.planHash);
});

test('small low-complexity repository work is delegated once and selected by the active rule', () => {
  const activeConfig: DelegationConfig = {
    ...config,
    dispatch: {
      ...config.dispatch,
      routeSelection: {
        mode: 'active',
        rules: [{ route: 'deepseek-flash', complexities: ['low'] }],
      },
    },
  };
  const single: TaskAssessment = {
    ...assessment,
    complexity: 'low',
    parallelizable: false,
    taskKinds: ['independent-implementation'],
    reasoning: 'One small bounded repository edit with no useful split.',
    subtasks: [
      {
        title: 'Fix the range helper',
        kind: 'independent-implementation',
        prompt: 'Modify src/ranges.js to fix the bounded range helper behavior.',
        acceptanceCriteria: ['src/ranges.js implements the specified behavior'],
      },
    ],
  };

  const plan = composeDelegationPlan(request, validateTaskAssessment(single), activeConfig);
  assert.equal(plan.decision, 'delegate');
  assert.equal(plan.willDispatch, true);
  assert.equal(plan.subtasks.length, 1);
  assert.deepEqual(
    plan.subtasks.map((subtask) => ({ route: subtask.route, evidence: subtask.routeSelection })),
    [
      {
        route: 'deepseek-flash',
        evidence: {
          mode: 'active',
          selectedRoute: 'deepseek-flash',
          basis: 'rule',
          ruleIndex: 0,
        },
      },
    ]
  );

  const analysisPlan = composeDelegationPlan(request, {
    ...single,
    taskKinds: ['repository-analysis'],
    subtasks: [{
      title: 'Search spam keywords',
      kind: 'repository-analysis',
      prompt: 'Search the repository for spam-keyword evidence and report exact matches.',
      acceptanceCriteria: ['Findings cite exact repository paths and matched evidence'],
    }],
  }, activeConfig);
  assert.deepEqual(
    analysisPlan.subtasks.map((subtask) => [subtask.kind, subtask.route, subtask.routeSelection?.basis]),
    [['repository-analysis', 'deepseek-flash', 'rule']]
  );
  assert.match(analysisPlan.subtasks[0]?.executionPrompt ?? '', /Repository-analysis boundary:/);
  assert.match(
    analysisPlan.subtasks[0]?.executionPrompt ?? '',
    /Authoritative source repository and logical target: \/tmp\/project/
  );
  assert.match(analysisPlan.subtasks[0]?.executionPrompt ?? '', /isolated execution worktree/);
  assert.match(analysisPlan.subtasks[0]?.executionPrompt ?? '', /active worktree\/current working directory is the only writable repository/);
  assert.match(analysisPlan.subtasks[0]?.executionPrompt ?? '', /do not access or modify the source checkout path directly/);
  assert.match(analysisPlan.subtasks[0]?.executionPrompt ?? '', /Every other repository is a read-only reference/);
  assert.match(analysisPlan.subtasks[0]?.executionPrompt ?? '', /report the workspace mismatch/);
  assert.match(analysisPlan.subtasks[0]?.executionPrompt ?? '', /at most five findings and 4000 characters/);
  assert.match(analysisPlan.subtasks[0]?.executionPrompt ?? '', /Do not inventory the repository/);
});

test('composeDelegationPlan deterministically applies allowlists, keep-upstream rules, caps, and suggest mode', () => {
  const plan = composeDelegationPlan(request, assessment, config);
  assert.equal(plan.policyVersion, 1);
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
  assert.equal(plan.mode, 'auto');
  assert.equal(plan.decision, 'split');
  assert.equal(plan.willDispatch, true);
  assert.deepEqual(
    plan.subtasks.map((subtask) => [subtask.id, subtask.kind, subtask.route]),
    [
      ['subtask_1', 'test-gap-analysis', 'worker'],
      ['subtask_2', 'documentation', 'worker'],
    ]
  );
  assert.equal(
    plan.subtasks.every((subtask) => subtask.executionPrompt.includes('out-of-scope or overlapping change')),
    true
  );

  const suggested = composeDelegationPlan({ ...request, delegation: 'suggest' }, assessment, config);
  assert.equal(suggested.mode, 'suggest');
  assert.equal(suggested.decision, 'split');
  assert.equal(suggested.willDispatch, false);

  const disabled = composeDelegationPlan({ ...request, delegation: 'never' }, assessment, config);
  assert.equal(disabled.decision, 'upstream');
  assert.equal(disabled.willDispatch, false);
  assert.deepEqual(disabled.subtasks, []);

  const overLimit = composeDelegationPlan(
    request,
    {
      ...assessment,
      subtasks: [
        ...assessment.subtasks,
        {
          title: 'Third task',
          kind: 'documentation',
          prompt: 'Write another document.',
          acceptanceCriteria: ['Document exists'],
        },
      ],
    },
    config
  );
  assert.equal(overLimit.decision, 'upstream');
  assert.equal(overLimit.willDispatch, false);
  assert.match(overLimit.reasoning, /exceeded the configured child limit/);
});

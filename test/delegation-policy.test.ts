import assert from 'node:assert/strict';
import test from 'node:test';

import type { DelegationConfig } from '../src/config.js';
import { buildPlannerPrompt, composeDelegationPlan, parseTaskAssessment } from '../src/delegation-policy.js';
import type { OrchestrationRequest, TaskAssessment } from '../src/orchestration-types.js';

const config: DelegationConfig = {
  mode: 'auto',
  planner: { strategy: 'hybrid', route: 'planner' },
  dispatch: { defaultRoute: 'worker', maxChildren: 2, maxDepth: 1, maxConcurrency: 1 },
  policy: {
    delegate: ['documentation', 'test-gap-analysis', 'independent-implementation'],
    keepUpstream: ['product-decision', 'artifact-integration', 'commit', 'push'],
  },
  fallback: 'upstream',
};

const request: OrchestrationRequest = {
  prompt: 'Implement the feature, review the tests, and update the documentation',
  workspace: '/tmp/project',
  source: 'claude',
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

test('parseTaskAssessment accepts strict JSON and rejects fences or malformed planner output', () => {
  const json = JSON.stringify(assessment);
  assert.deepEqual(parseTaskAssessment(json), assessment);
  assert.throws(() => parseTaskAssessment('```json\n' + json + '\n```'), /valid JSON object/);
  assert.throws(() => parseTaskAssessment(`result: ${json}`), /valid JSON object/);
  assert.throws(
    () => parseTaskAssessment(JSON.stringify({ ...assessment, parallelizable: 'yes' })),
    /parallelizable must be a boolean/
  );
});

test('planner instructions reserve parallelism for independent non-overlapping write scopes and structured criteria', () => {
  const prompt = buildPlannerPrompt(request, config);
  assert.match(prompt, /expected write scopes do not overlap/);
  assert.match(prompt, /no execution-order dependency/);
  assert.match(prompt, /bounded file or component scope/);
  assert.match(
    prompt,
    /Every delegated subtask object must contain the four separate keys "title", "kind", "prompt", and "acceptanceCriteria"\./
  );
  assert.match(prompt, /The "acceptanceCriteria" key must be a separate non-empty JSON string array/);
  assert.match(prompt, /do not put acceptance criteria only in the "prompt" text/);
});

test('parseTaskAssessment strictly rejects a subtask that omits acceptanceCriteria', () => {
  const withoutAcceptanceCriteria = {
    ...assessment,
    subtasks: assessment.subtasks.map((subtask) => {
      const { acceptanceCriteria: _acceptanceCriteria, ...rest } = subtask;
      return rest;
    }),
  };
  assert.throws(
    () => parseTaskAssessment(JSON.stringify(withoutAcceptanceCriteria)),
    /missing: acceptanceCriteria/
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

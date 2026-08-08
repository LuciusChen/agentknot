import assert from 'node:assert/strict';
import test from 'node:test';

import type { DelegationConfig } from '../src/config.js';
import { composeDelegationPlan, parseTaskAssessment } from '../src/delegation-policy.js';
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

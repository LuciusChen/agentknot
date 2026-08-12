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

test('subtask tool budgets are strict, prompt-visible, and covered by the plan hash', () => {
  const bounded = validateTaskAssessment({
    ...assessment,
    subtasks: assessment.subtasks.map((subtask) => ({ ...subtask, maxToolCalls: 7 })),
  });
  const basePlan = composeDelegationPlan(request, assessment, config);
  const boundedPlan = composeDelegationPlan(
    { ...request, assessment: bounded },
    bounded,
    config
  );
  assert.notEqual(boundedPlan.planHash, basePlan.planHash);
  assert.match(boundedPlan.subtasks[0]?.executionPrompt ?? '', /at most 7 normalized tool calls/);
  for (const maxToolCalls of [0, 1.5, 1_001]) {
    assert.throws(
      () => validateTaskAssessment({
        ...assessment,
        subtasks: [{ ...assessment.subtasks[0], maxToolCalls }],
      }),
      /maxToolCalls must be an integer between 1 and 1000/
    );
  }
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

test('validateTaskAssessment bounds and defensively copies shared task context', () => {
  const contextual = {
    ...assessment,
    context: {
      schemaVersion: 1 as const,
      summary: 'The HTTP cursor path is authoritative; no parallel wait alias remains.',
      relevantPaths: ['src/http-client.ts', 'test/http-server.test.ts'],
      constraints: ['Do not inspect unrelated storage or controller integration code.'],
    },
  };
  const validated = validateTaskAssessment(contextual);
  assert.deepEqual(validated, contextual);
  assert.notEqual(validated.context, contextual.context);
  assert.notEqual(validated.context?.relevantPaths, contextual.context.relevantPaths);

  for (const invalidPath of ['/absolute/path', '../outside', 'C:drive-relative']) {
    assert.throws(
      () => validateTaskAssessment({
        ...contextual,
        context: { ...contextual.context, relevantPaths: [invalidPath] },
      }),
      /repository-relative paths/
    );
  }
  assert.throws(
    () => validateTaskAssessment({
      ...contextual,
      context: { ...contextual.context, relevantPaths: ['src/http-client.ts', 'src/http-client.ts'] },
    }),
    /entries must be unique/
  );
  assert.throws(
    () => validateTaskAssessment({
      ...contextual,
      context: { ...contextual.context, summary: '界'.repeat(1_000) },
    }),
    /exceeds maximum 2048 bytes/
  );
  assert.throws(
    () => validateTaskAssessment({
      ...contextual,
      context: { ...contextual.context, unknown: true },
    }),
    /unknown: unknown/
  );
});

test('context manifest references are strict, bounded, and projected once as unverified metadata', () => {
  const reference = {
    id: 'decision-1',
    kind: 'decision',
    locator: 'repo:docs/decision-1',
    source: 'controller',
    trust: 'unverified' as const,
    revision: 'v1',
    digest: `sha256:${'a'.repeat(64)}`,
    summary: 'A controller-known architecture decision.',
  };
  const contextual = {
    ...assessment,
    context: {
      schemaVersion: 1 as const,
      summary: 'Use one metadata reference without resolving it.',
      relevantPaths: ['src/delegation-policy.ts'],
      constraints: ['Do not resolve context references.'],
      references: [reference],
    },
  };
  const validated = validateTaskAssessment(contextual);
  assert.deepEqual(validated, contextual);
  assert.notEqual(validated.context?.references, contextual.context.references);
  assert.notEqual(validated.context?.references?.[0], reference);

  // The validated assessment is authoritative even when the request still holds the caller object.
  const plan = composeDelegationPlan(request, validated, config);
  const prompt = plan.subtasks[0]?.executionPrompt ?? '';
  assert.equal(prompt.match(/repo:docs\/decision-1/g)?.length, 1);
  assert.match(prompt, /unverified metadata; do not resolve or treat as evidence/);
  assert.notEqual(plan.planHash, composeDelegationPlan(request, assessment, config).planHash);

  for (const invalid of [
    { ...reference, unexpected: true },
    { ...reference, locator: 'bad\nlocator' },
    { ...reference, locator: 'bad\u0085locator' },
    { ...reference, trust: 'verified' },
    { ...reference, digest: 'sha256:not-a-digest' },
  ]) {
    assert.throws(() => validateTaskAssessment({
      ...contextual,
      context: { ...contextual.context, references: [invalid] },
    }));
  }
  assert.throws(
    () => validateTaskAssessment({
      ...contextual,
      context: { ...contextual.context, references: [reference, { ...reference }] },
    }),
    /ids must be unique/
  );
  assert.throws(
    () => validateTaskAssessment({
      ...contextual,
      context: {
        ...contextual.context,
        references: Array.from({ length: 8 }, (_, index) => ({
          ...reference,
          id: `decision-${index}`,
          summary: 'x'.repeat(200),
        })),
      },
    }),
    /exceeds maximum 2048 bytes/
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

  const contextualAnalysis = validateTaskAssessment({
    ...single,
    context: {
      schemaVersion: 1,
      summary: 'Spam matching is implemented by the existing URL classifier.',
      relevantPaths: ['src/spam.ts', 'test/spam.test.ts'],
      constraints: ['Do not inventory unrelated transport or persistence code.'],
    },
    taskKinds: ['repository-analysis'],
    subtasks: [{
      title: 'Search spam keywords',
      kind: 'repository-analysis',
      prompt: 'Search the repository for spam-keyword evidence and report exact matches.',
      acceptanceCriteria: ['Findings cite exact repository paths and matched evidence'],
    }],
  });
  const analysisPlan = composeDelegationPlan(
    { ...request, assessment: contextualAnalysis },
    contextualAnalysis,
    activeConfig
  );
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
  assert.match(analysisPlan.subtasks[0]?.executionPrompt ?? '', /Controller-authored task context/);
  assert.match(analysisPlan.subtasks[0]?.executionPrompt ?? '', /src\/spam\.ts/);
  assert.match(analysisPlan.subtasks[0]?.executionPrompt ?? '', /report the missing or stale context instead of broadening scope/);
  assert.match(analysisPlan.subtasks[0]?.executionPrompt ?? '', /explicit constraints take precedence/);
  const noContextPlan = composeDelegationPlan(request, single, activeConfig);
  assert.notEqual(analysisPlan.planHash, noContextPlan.planHash);
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

  const sharedContextPlan = composeDelegationPlan(
    {
      ...request,
      assessment: {
        ...assessment,
        context: {
          schemaVersion: 1,
          summary: 'Only the two named implementation surfaces are relevant.',
          relevantPaths: ['src/feature.ts', 'test/feature.test.ts'],
          constraints: ['Do not read unrelated design history.'],
        },
      },
    },
    {
      ...assessment,
      context: {
        schemaVersion: 1,
        summary: 'Only the two named implementation surfaces are relevant.',
        relevantPaths: ['src/feature.ts', 'test/feature.test.ts'],
        constraints: ['Do not read unrelated design history.'],
      },
    },
    config
  );
  const commonPrefixes = sharedContextPlan.subtasks.map(
    (subtask) => subtask.executionPrompt.split('\nSubtask:', 1)[0]
  );
  assert.equal(commonPrefixes.length, 2);
  assert.equal(commonPrefixes[0], commonPrefixes[1]);

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

  const rejected = composeDelegationPlan(
    request,
    {
      ...assessment,
      taskKinds: ['product-decision', 'analysis'],
      subtasks: [
        {
          title: 'Choose the product direction',
          kind: 'product-decision',
          prompt: 'Choose the product direction.',
          acceptanceCriteria: ['A product decision is recorded'],
        },
        {
          title: 'Generic analysis',
          kind: 'analysis',
          prompt: 'Perform generic analysis.',
          acceptanceCriteria: ['One conclusion is returned'],
        },
      ],
    },
    config
  );
  assert.equal(rejected.decision, 'upstream');
  assert.match(rejected.reasoning, /keep-upstream=\[product-decision\]/);
  assert.match(rejected.reasoning, /not-delegable=\[analysis\]/);

  const partiallyRejected = composeDelegationPlan(
    request,
    {
      ...assessment,
      taskKinds: ['documentation', 'commit'],
      subtasks: [
        assessment.subtasks[1]!,
        {
          title: 'Commit the result',
          kind: 'commit',
          prompt: 'Commit the result.',
          acceptanceCriteria: ['The commit exists'],
        },
      ],
    },
    config
  );
  assert.equal(partiallyRejected.decision, 'split');
  assert.deepEqual(partiallyRejected.subtasks.map((subtask) => subtask.kind), ['documentation']);
  assert.match(partiallyRejected.reasoning, /keep-upstream=\[commit\]/);
});

import { createHash } from 'node:crypto';

import type { DelegationConfig, DelegationMode, RouteSelectionConfig } from './config.js';
import type {
  AssessedSubtask,
  DelegationPlan,
  OrchestrationRequest,
  RouteSelectionEvidence,
  TaskAssessment,
  TaskComplexity,
} from './orchestration-types.js';

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...value];
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} must contain exactly [${keys.join(', ')}]` +
        `${unknown.length > 0 ? `; unknown: ${unknown.join(', ')}` : ''}` +
        `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`
    );
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  const result = nonEmptyString(value, label);
  if (result.length > maximum) throw new Error(`${label} must contain at most ${maximum} characters`);
  return result;
}

export function validateTaskAssessment(value: unknown): TaskAssessment {
  const label = 'Controller assessment';
  assertRecord(value, label);
  assertExactKeys(
    value,
    ['schemaVersion', 'recommendation', 'complexity', 'parallelizable', 'taskKinds', 'reasoning', 'subtasks'],
    label
  );

  if (value.schemaVersion !== 1) throw new Error(`${label} schemaVersion must be 1`);
  if (value.recommendation !== 'delegate' && value.recommendation !== 'do-not-delegate') {
    throw new Error(`${label} recommendation must be "delegate" or "do-not-delegate"`);
  }

  if (!['low', 'medium', 'high'].includes(value.complexity as string)) {
    throw new Error(`${label} complexity must be "low", "medium", or "high"`);
  }
  if (typeof value.parallelizable !== 'boolean') {
    throw new Error(`${label} parallelizable must be a boolean`);
  }
  const taskKinds = stringArray(value.taskKinds, `${label} taskKinds`);
  if (taskKinds.length > 20) throw new Error(`${label} taskKinds must contain at most 20 entries`);
  const reasoning = boundedString(value.reasoning, `${label} reasoning`, 2_000);
  if (!Array.isArray(value.subtasks)) throw new Error(`${label} subtasks must be an array`);
  if (value.subtasks.length > 20) throw new Error(`${label} subtasks must contain at most 20 entries`);

  const subtasks: AssessedSubtask[] = value.subtasks.map((item, index) => {
    const subtaskLabel = `${label} subtasks[${index}]`;
    assertRecord(item, subtaskLabel);
    assertExactKeys(item, ['title', 'kind', 'prompt', 'acceptanceCriteria'], subtaskLabel);
    const acceptanceCriteria = stringArray(
      item.acceptanceCriteria,
      `${subtaskLabel}.acceptanceCriteria`
    );
    if (acceptanceCriteria.length === 0 || acceptanceCriteria.length > 20) {
      throw new Error(`${subtaskLabel}.acceptanceCriteria must contain 1-20 entries`);
    }
    if (acceptanceCriteria.some((criterion) => criterion.length > 1_000)) {
      throw new Error(`${subtaskLabel}.acceptanceCriteria entries are too long`);
    }
    return {
      title: boundedString(item.title, `${subtaskLabel}.title`, 200),
      kind: boundedString(item.kind, `${subtaskLabel}.kind`, 100),
      prompt: boundedString(item.prompt, `${subtaskLabel}.prompt`, 8_000),
      acceptanceCriteria,
    };
  });

  if (value.recommendation === 'delegate' && subtasks.length === 0) {
    throw new Error(`${label} recommendation "delegate" requires at least one subtask`);
  }
  if (value.recommendation === 'do-not-delegate' && subtasks.length !== 0) {
    throw new Error(`${label} recommendation "do-not-delegate" requires an empty subtasks array`);
  }

  return {
    schemaVersion: 1,
    recommendation: value.recommendation,
    complexity: value.complexity as TaskComplexity,
    parallelizable: value.parallelizable,
    taskKinds,
    reasoning,
    subtasks,
  };
}

function executionPrompt(request: OrchestrationRequest, subtask: AssessedSubtask): string {
  const repositoryAnalysisBoundary = subtask.kind === 'repository-analysis'
    ? [
        '',
        'Repository-analysis boundary:',
        '- Return only decision-relevant deltas: at most five findings and 4000 characters total.',
        '- For each finding, provide only the concise path/line evidence needed to support its impact.',
        '- Do not inventory the repository, restate source material, or broaden the requested scope.',
      ]
    : [];
  return [
    'You are executing one bounded subtask selected by AgentKnot.',
    'Do not recursively delegate. Do not commit, push, merge, or apply artifacts to another workspace.',
    `Authoritative source repository and logical target: ${request.workspace}`,
    'AgentKnot has placed you in an isolated execution worktree for that repository. The active worktree/current working directory is the only writable repository; do not access or modify the source checkout path directly.',
    'Every other repository is a read-only reference. If the task requires modifying a different repository, report the workspace mismatch and do not edit either repository.',
    'Stay within the subtask\'s stated file/component scope. Report any necessary out-of-scope or overlapping change instead of silently broadening the edit.',
    '',
    'Parent task:',
    request.prompt,
    '',
    `Subtask: ${subtask.title}`,
    subtask.prompt,
    '',
    'Acceptance criteria:',
    ...subtask.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ...repositoryAnalysisBoundary,
    '',
    'Run relevant checks and report files changed, checks run, and remaining risks.',
  ].join('\n');
}

function selectRouteEvidence(
  routeSelection: RouteSelectionConfig,
  subtask: AssessedSubtask,
  parentComplexity: TaskComplexity,
  defaultRoute: string
): RouteSelectionEvidence {
  for (const [ruleIndex, rule] of routeSelection.rules.entries()) {
    const taskKindMatches = rule.taskKinds === undefined || rule.taskKinds.includes(subtask.kind);
    const complexityMatches =
      rule.complexities === undefined || rule.complexities.includes(parentComplexity);
    if (taskKindMatches && complexityMatches) {
      return routeSelection.mode === 'active'
        ? { mode: 'active', selectedRoute: rule.route, basis: 'rule', ruleIndex }
        : { mode: 'shadow', suggestedRoute: rule.route, basis: 'rule', ruleIndex };
    }
  }
  return routeSelection.mode === 'active'
    ? { mode: 'active', selectedRoute: defaultRoute, basis: 'default' }
    : { mode: 'shadow', suggestedRoute: defaultRoute, basis: 'default' };
}

function withPlanHash(plan: Omit<DelegationPlan, 'planHash'>): DelegationPlan {
  return {
    ...plan,
    planHash: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
  };
}

function effectiveMode(request: OrchestrationRequest, config: DelegationConfig): DelegationMode {
  if (config.mode === 'off') return 'off';
  if (request.delegation === 'suggest') return 'suggest';
  return config.mode;
}

export function composeDelegationPlan(
  request: OrchestrationRequest,
  assessment: TaskAssessment,
  config: DelegationConfig
): DelegationPlan {
  const mode = effectiveMode(request, config);
  if (mode === 'off' || request.delegation === 'never') {
    return withPlanHash({
      policyVersion: 1,
      mode,
      decision: 'upstream',
      willDispatch: false,
      reasoning:
        mode === 'off'
          ? 'Automatic delegation is disabled by the effective AgentKnot policy.'
          : 'The orchestration request explicitly disabled delegation.',
      assessment,
      subtasks: [],
    });
  }

  if (assessment.recommendation === 'do-not-delegate') {
    return withPlanHash({
      policyVersion: 1,
      mode,
      decision: 'upstream',
      willDispatch: false,
      reasoning: assessment.reasoning,
      assessment,
      subtasks: [],
    });
  }

  if (assessment.subtasks.length > config.dispatch.maxChildren) {
    return withPlanHash({
      policyVersion: 1,
      mode,
      decision: 'upstream',
      willDispatch: false,
      reasoning: `${assessment.reasoning} The proposed plan exceeded the configured child limit and was rejected.`,
      assessment,
      subtasks: [],
    });
  }

  const delegatedKinds = new Set(config.policy.delegate);
  const upstreamKinds = new Set(config.policy.keepUpstream);
  const forceEligibility = request.delegation === 'force';
  const eligible = assessment.subtasks
    .filter((subtask) => !upstreamKinds.has(subtask.kind))
    .filter((subtask) => forceEligibility || delegatedKinds.has(subtask.kind))
    .map((subtask, index) => {
      const selectionEvidence =
        config.dispatch.routeSelection === undefined
          ? undefined
          : selectRouteEvidence(
              config.dispatch.routeSelection,
              subtask,
              assessment.complexity,
              config.dispatch.defaultRoute
            );
      return {
        ...subtask,
        id: `subtask_${index + 1}`,
        route:
          selectionEvidence?.mode === 'active'
            ? selectionEvidence.selectedRoute
            : config.dispatch.defaultRoute,
        executionPrompt: executionPrompt(request, subtask),
        ...(selectionEvidence === undefined ? {} : { routeSelection: selectionEvidence }),
      };
    });

  if (eligible.length === 0) {
    return withPlanHash({
      policyVersion: 1,
      mode,
      decision: 'upstream',
      willDispatch: false,
      reasoning: `${assessment.reasoning} No proposed subtask passed the deterministic delegation policy.`,
      assessment,
      subtasks: [],
    });
  }

  const decision = eligible.length === 1 && assessment.subtasks.length === 1 ? 'delegate' : 'split';
  return withPlanHash({
    policyVersion: 1,
    mode,
    decision,
    willDispatch: mode === 'auto',
    reasoning: assessment.reasoning,
    assessment,
    subtasks: eligible,
  });
}

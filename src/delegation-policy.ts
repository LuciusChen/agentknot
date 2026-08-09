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

export function parseTaskAssessment(output: string): TaskAssessment {
  if (output.length > 64 * 1024) throw new Error('Planner output must contain at most 65536 characters');
  let value: unknown;
  try {
    value = JSON.parse(output.trim()) as unknown;
  } catch (error) {
    throw new Error('Planner output must be a valid JSON object', { cause: error });
  }
  assertRecord(value, 'Planner output');
  assertExactKeys(
    value,
    ['schemaVersion', 'recommendation', 'complexity', 'parallelizable', 'taskKinds', 'reasoning', 'subtasks'],
    'Planner output'
  );

  if (value.schemaVersion !== 1) throw new Error('Planner output schemaVersion must be 1');
  if (value.recommendation !== 'delegate' && value.recommendation !== 'do-not-delegate') {
    throw new Error('Planner output recommendation must be "delegate" or "do-not-delegate"');
  }

  if (!['low', 'medium', 'high'].includes(value.complexity as string)) {
    throw new Error('Planner output complexity must be "low", "medium", or "high"');
  }
  if (typeof value.parallelizable !== 'boolean') {
    throw new Error('Planner output parallelizable must be a boolean');
  }
  const taskKinds = stringArray(value.taskKinds, 'Planner output taskKinds');
  if (taskKinds.length > 20) throw new Error('Planner output taskKinds must contain at most 20 entries');
  const reasoning = boundedString(value.reasoning, 'Planner output reasoning', 2_000);
  if (!Array.isArray(value.subtasks)) throw new Error('Planner output subtasks must be an array');
  if (value.subtasks.length > 20) throw new Error('Planner output subtasks must contain at most 20 entries');

  const subtasks: AssessedSubtask[] = value.subtasks.map((item, index) => {
    assertRecord(item, `Planner output subtasks[${index}]`);
    assertExactKeys(item, ['title', 'kind', 'prompt', 'acceptanceCriteria'], `Planner output subtasks[${index}]`);
    const acceptanceCriteria = stringArray(
      item.acceptanceCriteria,
      `Planner output subtasks[${index}].acceptanceCriteria`
    );
    if (acceptanceCriteria.length === 0 || acceptanceCriteria.length > 20) {
      throw new Error(`Planner output subtasks[${index}].acceptanceCriteria must contain 1-20 entries`);
    }
    if (acceptanceCriteria.some((criterion) => criterion.length > 1_000)) {
      throw new Error(`Planner output subtasks[${index}].acceptanceCriteria entries are too long`);
    }
    return {
      title: boundedString(item.title, `Planner output subtasks[${index}].title`, 200),
      kind: boundedString(item.kind, `Planner output subtasks[${index}].kind`, 100),
      prompt: boundedString(item.prompt, `Planner output subtasks[${index}].prompt`, 8_000),
      acceptanceCriteria,
    };
  });

  if (value.recommendation === 'delegate' && subtasks.length === 0) {
    throw new Error('Planner output recommendation "delegate" requires at least one subtask');
  }
  if (value.recommendation === 'do-not-delegate' && subtasks.length !== 0) {
    throw new Error('Planner output recommendation "do-not-delegate" requires an empty subtasks array');
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

export function buildPlannerPrompt(request: OrchestrationRequest, config: DelegationConfig): string {
  return [
    'You are AgentKnot\'s read-only task classifier. Do not edit files, execute the requested work, or delegate.',
    'Assess whether bounded independent subtasks can be sent to background coding workers.',
    'Optimize for useful parallelism, not the largest task count. Mark parallelizable true only when subtasks have no execution-order dependency and their expected write scopes do not overlap.',
    'Each parallel subtask prompt must name its bounded file or component scope, explicit non-goals, and acceptance criteria. If work must share a contract or edit the same files, keep it in one subtask or mark the plan non-parallel.',
    'Every delegated subtask object must contain the four separate keys "title", "kind", "prompt", and "acceptanceCriteria".',
    'The "acceptanceCriteria" key must be a separate non-empty JSON string array; do not put acceptance criteria only in the "prompt" text.',
    `Return at most ${config.dispatch.maxChildren} useful subtasks. Final product decisions, artifact integration, commits, and pushes must remain upstream.`,
    `Preferred delegatable kinds: ${config.policy.delegate.join(', ')}.`,
    `Kinds that must remain upstream: ${config.policy.keepUpstream.join(', ')}.`,
    'Return JSON only with exactly this shape and no markdown fence:',
    '{"schemaVersion":1,"recommendation":"delegate|do-not-delegate","complexity":"low|medium|high","parallelizable":true,"taskKinds":["kind"],"reasoning":"short explanation","subtasks":[{"title":"short title","kind":"kind","prompt":"self-contained bounded instruction","acceptanceCriteria":["objective check"]}]}',
    'Use an empty subtasks array when delegation would add no value. Do not wrap the JSON in commentary.',
    '',
    'Task:',
    request.prompt,
  ].join('\n');
}

export function skippedTaskAssessment(reasoning: string): TaskAssessment {
  return {
    schemaVersion: 1,
    recommendation: 'do-not-delegate',
    complexity: 'low',
    parallelizable: false,
    taskKinds: [],
    reasoning,
    subtasks: [],
  };
}

function executionPrompt(parentPrompt: string, subtask: AssessedSubtask): string {
  return [
    'You are executing one bounded subtask selected by AgentKnot.',
    'Do not recursively delegate. Do not commit, push, merge, or apply artifacts to another workspace.',
    'Stay within the subtask\'s stated file/component scope. Report any necessary out-of-scope or overlapping change instead of silently broadening the edit.',
    '',
    'Parent task:',
    parentPrompt,
    '',
    `Subtask: ${subtask.title}`,
    subtask.prompt,
    '',
    'Acceptance criteria:',
    ...subtask.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    'Run relevant checks and report files changed, checks run, and remaining risks.',
  ].join('\n');
}

function selectShadowRouteEvidence(
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
      return {
        mode: 'shadow',
        suggestedRoute: rule.route,
        basis: 'rule',
        ruleIndex,
      };
    }
  }
  return { mode: 'shadow', suggestedRoute: defaultRoute, basis: 'default' };
}

function withPlanHash(plan: Omit<DelegationPlan, 'planHash'>): DelegationPlan {
  return {
    ...plan,
    planHash: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
  };
}

export function rehashDelegationPlan(plan: DelegationPlan): DelegationPlan {
  const { planHash: _previousHash, ...unhashed } = plan;
  return withPlanHash(unhashed);
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
          : selectShadowRouteEvidence(
              config.dispatch.routeSelection,
              subtask,
              assessment.complexity,
              config.dispatch.defaultRoute
            );
      return {
        ...subtask,
        id: `subtask_${index + 1}`,
        route: config.dispatch.defaultRoute,
        executionPrompt: executionPrompt(request.prompt, subtask),
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

import type { OrchestrationRecord, RouteSelectionEvidence } from './orchestration-types.js';
import type { JobRecord } from './types.js';

export interface UsageTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type UsageRate =
  | {
      status: 'available';
      formula: string;
      numerator: number;
      denominator: number;
      value: number;
    }
  | {
      status: 'unavailable';
      formula: string;
      reason: 'zero-denominator' | 'aggregate-overflow';
    };

export interface UsageUnavailableCount {
  reason: 'missing' | 'timeout' | 'unsupported' | 'invalid';
  count: number;
}

export type DownstreamUsage =
  | {
      status: 'available';
      coverage: 'complete' | 'partial';
      tokens: UsageTokenTotals;
      providerReportedCost: number;
      cacheReadHitRate: UsageRate;
      unavailable: UsageUnavailableCount[];
    }
  | {
      status: 'unavailable';
      reason: 'no-successful-jobs' | 'no-valid-session-stats' | 'aggregate-overflow';
      unavailable: UsageUnavailableCount[];
    };

export interface RouteSelectionCount {
  basis: 'rule' | 'default';
  route: string;
  ruleIndex?: number;
  count: number;
}

export interface RouteSelectionModeUsage {
  classifiedSelections: number;
  ruleHits: number;
  defaultSelections: number;
  ruleHitRate: UsageRate;
  selections: RouteSelectionCount[];
}

interface RouteSelectionUsageBase {
  classifiedSelections: number;
  unavailableSelections: number;
  active: RouteSelectionModeUsage;
  shadow: RouteSelectionModeUsage;
}

export type RouteSelectionUsage =
  | (RouteSelectionUsageBase & {
      status: 'available';
      coverage: 'complete' | 'partial';
    })
  | (RouteSelectionUsageBase & {
      status: 'unavailable';
      reason: 'no-classified-route-selections';
    });

export interface UsageReport {
  schemaVersion: 1;
  scope: {
    totalJobs: number;
    successfulJobs: number;
    statsAvailableJobs: number;
    statsUnavailableJobs: number;
    terminalOrchestrations: number;
    plannedSubtasks: number;
  };
  downstream: DownstreamUsage;
  routeSelection: RouteSelectionUsage;
  upstream: {
    status: 'unavailable';
    reason: 'controller-usage-not-persisted';
  };
  proportions: {
    status: 'unavailable';
    reason: 'controller-usage-not-persisted';
  };
}

type ParsedSessionStats =
  | { status: 'available'; tokens: UsageTokenTotals; cost: number }
  | { status: 'unavailable'; reason: UsageUnavailableCount['reason'] };

const CACHE_HIT_FORMULA = 'cacheRead / (input + cacheRead)';
const ROUTE_HIT_FORMULA = 'rule / (rule + default)';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseSessionStats(job: JobRecord): ParsedSessionStats {
  const metadata = job.result?.metadata;
  if (!isRecord(metadata) || metadata.sessionStats === undefined) {
    return { status: 'unavailable', reason: 'missing' };
  }
  const stats = metadata.sessionStats;
  if (!isRecord(stats)) return { status: 'unavailable', reason: 'invalid' };
  if (stats.unavailableReason !== undefined) {
    return stats.unavailableReason === 'timeout' || stats.unavailableReason === 'unsupported'
      ? { status: 'unavailable', reason: stats.unavailableReason }
      : { status: 'unavailable', reason: 'invalid' };
  }
  if (!isRecord(stats.tokens)) return { status: 'unavailable', reason: 'invalid' };
  const tokens = stats.tokens;
  if (
    !isNonNegativeSafeInteger(tokens.input) ||
    !isNonNegativeSafeInteger(tokens.output) ||
    !isNonNegativeSafeInteger(tokens.cacheRead) ||
    !isNonNegativeSafeInteger(tokens.cacheWrite) ||
    !isNonNegativeSafeInteger(tokens.total) ||
    typeof stats.cost !== 'number' ||
    !Number.isFinite(stats.cost) ||
    stats.cost < 0
  ) {
    return { status: 'unavailable', reason: 'invalid' };
  }
  return {
    status: 'available',
    tokens: {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      total: tokens.total,
    },
    cost: stats.cost,
  };
}

function addSafe(left: number, right: number): number | undefined {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : undefined;
}

function rate(formula: string, numerator: number, denominator: number | undefined): UsageRate {
  if (denominator === undefined) return { status: 'unavailable', formula, reason: 'aggregate-overflow' };
  if (denominator === 0) return { status: 'unavailable', formula, reason: 'zero-denominator' };
  return { status: 'available', formula, numerator, denominator, value: numerator / denominator };
}

function downstreamUsage(jobs: readonly JobRecord[]): {
  downstream: DownstreamUsage;
  availableJobs: number;
  unavailableJobs: number;
} {
  const successful = jobs.filter((job) => job.status === 'succeeded');
  const unavailable = new Map<UsageUnavailableCount['reason'], number>();
  const totals: UsageTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let providerReportedCost = 0;
  let availableJobs = 0;
  let aggregateOverflow = false;

  for (const job of successful) {
    const stats = parseSessionStats(job);
    if (stats.status === 'unavailable') {
      unavailable.set(stats.reason, (unavailable.get(stats.reason) ?? 0) + 1);
      continue;
    }
    availableJobs += 1;
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
      const sum = addSafe(totals[field], stats.tokens[field]);
      if (sum === undefined) aggregateOverflow = true;
      else totals[field] = sum;
    }
    const cost = providerReportedCost + stats.cost;
    if (!Number.isFinite(cost)) aggregateOverflow = true;
    else providerReportedCost = cost;
  }

  const unavailableCounts = [...unavailable.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => left.reason.localeCompare(right.reason));
  const unavailableJobs = successful.length - availableJobs;
  if (successful.length === 0) {
    return {
      downstream: { status: 'unavailable', reason: 'no-successful-jobs', unavailable: [] },
      availableJobs,
      unavailableJobs,
    };
  }
  if (availableJobs === 0) {
    return {
      downstream: {
        status: 'unavailable',
        reason: 'no-valid-session-stats',
        unavailable: unavailableCounts,
      },
      availableJobs,
      unavailableJobs,
    };
  }
  if (aggregateOverflow) {
    return {
      downstream: {
        status: 'unavailable',
        reason: 'aggregate-overflow',
        unavailable: unavailableCounts,
      },
      availableJobs,
      unavailableJobs,
    };
  }
  return {
    downstream: {
      status: 'available',
      coverage: unavailableJobs === 0 ? 'complete' : 'partial',
      tokens: totals,
      providerReportedCost,
      cacheReadHitRate: rate(
        CACHE_HIT_FORMULA,
        totals.cacheRead,
        addSafe(totals.input, totals.cacheRead)
      ),
      unavailable: unavailableCounts,
    },
    availableJobs,
    unavailableJobs,
  };
}

function parseRouteSelection(value: unknown): RouteSelectionEvidence | undefined {
  if (!isRecord(value) || (value.mode !== 'active' && value.mode !== 'shadow')) return undefined;
  if (value.basis !== 'rule' && value.basis !== 'default') return undefined;
  const route = value.mode === 'active' ? value.selectedRoute : value.suggestedRoute;
  if (typeof route !== 'string' || route.length === 0) return undefined;
  if (value.basis === 'rule') {
    const ruleIndex = value.ruleIndex;
    if (!isNonNegativeSafeInteger(ruleIndex)) return undefined;
    return value.mode === 'active'
      ? { mode: 'active', selectedRoute: route, basis: 'rule', ruleIndex }
      : { mode: 'shadow', suggestedRoute: route, basis: 'rule', ruleIndex };
  }
  if (value.ruleIndex !== undefined) return undefined;
  return value.mode === 'active'
    ? { mode: 'active', selectedRoute: route, basis: 'default' }
    : { mode: 'shadow', suggestedRoute: route, basis: 'default' };
}

function selectionKey(evidence: RouteSelectionEvidence): string {
  const route = evidence.mode === 'active' ? evidence.selectedRoute : evidence.suggestedRoute;
  return `${evidence.basis}\u0000${evidence.basis === 'rule' ? evidence.ruleIndex : ''}\u0000${route}`;
}

function selectionMatchesPolicy(
  record: OrchestrationRecord,
  subtaskRoute: string,
  evidence: RouteSelectionEvidence
): boolean {
  const policy = record.policy.dispatch.routeSelection;
  if (policy === undefined || policy.mode !== evidence.mode) return false;
  const route = evidence.mode === 'active' ? evidence.selectedRoute : evidence.suggestedRoute;
  if (evidence.basis === 'rule' && policy.rules[evidence.ruleIndex]?.route !== route) return false;
  if (evidence.basis === 'default' && record.policy.dispatch.defaultRoute !== route) return false;
  return evidence.mode === 'active'
    ? subtaskRoute === route
    : subtaskRoute === record.policy.dispatch.defaultRoute;
}

function modeUsage(
  evidence: readonly RouteSelectionEvidence[],
  mode: RouteSelectionEvidence['mode']
): RouteSelectionModeUsage {
  const selected = evidence.filter((item) => item.mode === mode);
  const counts = new Map<string, { evidence: RouteSelectionEvidence; count: number }>();
  for (const item of selected) {
    const key = selectionKey(item);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { evidence: item, count: 1 });
  }
  const ruleHits = selected.filter((item) => item.basis === 'rule').length;
  const defaultSelections = selected.length - ruleHits;
  const selections = [...counts.values()]
    .map(({ evidence: item, count }): RouteSelectionCount => ({
      basis: item.basis,
      route: item.mode === 'active' ? item.selectedRoute : item.suggestedRoute,
      ...(item.basis === 'rule' ? { ruleIndex: item.ruleIndex } : {}),
      count,
    }))
    .sort((left, right) => {
      if (left.basis !== right.basis) return left.basis === 'rule' ? -1 : 1;
      if ((left.ruleIndex ?? -1) !== (right.ruleIndex ?? -1)) {
        return (left.ruleIndex ?? -1) - (right.ruleIndex ?? -1);
      }
      return left.route.localeCompare(right.route);
    });
  return {
    classifiedSelections: selected.length,
    ruleHits,
    defaultSelections,
    ruleHitRate: rate(ROUTE_HIT_FORMULA, ruleHits, selected.length),
    selections,
  };
}

function routeSelectionUsage(orchestrations: readonly OrchestrationRecord[]): {
  routeSelection: RouteSelectionUsage;
  terminalOrchestrations: number;
  plannedSubtasks: number;
} {
  const terminal = orchestrations.filter((record) =>
    ['succeeded', 'failed', 'cancelled'].includes(record.status)
  );
  const evidence: RouteSelectionEvidence[] = [];
  let plannedSubtasks = 0;
  let unavailableSelections = 0;
  for (const record of terminal) {
    for (const subtask of record.plan?.subtasks ?? []) {
      plannedSubtasks += 1;
      const parsed = parseRouteSelection(subtask.routeSelection);
      if (parsed === undefined || !selectionMatchesPolicy(record, subtask.route, parsed)) {
        unavailableSelections += 1;
      }
      else evidence.push(parsed);
    }
  }
  const base: RouteSelectionUsageBase = {
    classifiedSelections: evidence.length,
    unavailableSelections,
    active: modeUsage(evidence, 'active'),
    shadow: modeUsage(evidence, 'shadow'),
  };
  return {
    routeSelection:
      evidence.length === 0
        ? { ...base, status: 'unavailable', reason: 'no-classified-route-selections' }
        : {
            ...base,
            status: 'available',
            coverage: unavailableSelections === 0 ? 'complete' : 'partial',
          },
    terminalOrchestrations: terminal.length,
    plannedSubtasks,
  };
}

export function buildUsageReport(
  jobs: readonly JobRecord[],
  orchestrations: readonly OrchestrationRecord[]
): UsageReport {
  const downstream = downstreamUsage(jobs);
  const routeSelection = routeSelectionUsage(orchestrations);
  return {
    schemaVersion: 1,
    scope: {
      totalJobs: jobs.length,
      successfulJobs: jobs.filter((job) => job.status === 'succeeded').length,
      statsAvailableJobs: downstream.availableJobs,
      statsUnavailableJobs: downstream.unavailableJobs,
      terminalOrchestrations: routeSelection.terminalOrchestrations,
      plannedSubtasks: routeSelection.plannedSubtasks,
    },
    downstream: downstream.downstream,
    routeSelection: routeSelection.routeSelection,
    upstream: { status: 'unavailable', reason: 'controller-usage-not-persisted' },
    proportions: { status: 'unavailable', reason: 'controller-usage-not-persisted' },
  };
}

import {
  QUALITY_REVIEW_FINDING_SEVERITIES,
  QUALITY_REVIEW_SKIPPED_REASONS,
  QUALITY_REVIEW_UNAVAILABLE_REASONS,
  QUALITY_REVIEW_VERDICTS,
  type OrchestrationQualityReview,
  type OrchestrationRecord,
  type RouteSelectionEvidence,
} from './orchestration-types.js';
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

export interface RoutePoolSelectionCount {
  pool: string;
  route: string;
  count: number;
}

export type RoutePoolUsage =
  | {
      status: 'available';
      coverage: 'complete' | 'partial';
      observedJobs: number;
      classifiedJobs: number;
      unavailableJobs: number;
      selections: RoutePoolSelectionCount[];
    }
  | {
      status: 'unavailable';
      reason: 'no-route-pool-selections';
      observedJobs: 0;
      classifiedJobs: 0;
      unavailableJobs: 0;
      selections: [];
    };

export interface QualityReviewReasonCount {
  status: 'skipped' | 'unavailable';
  reason: string;
  count: number;
}

export interface QualityReviewRouteCount {
  route: string;
  count: number;
}

interface QualityReviewUsageBase {
  configuredOrchestrations: number;
  classifiedReviews: number;
  unclassifiedReviews: number;
  outcomes: {
    completed: number;
    skipped: number;
    unavailable: number;
  };
  verdicts: {
    accept: number;
    changesRequested: number;
    uncertain: number;
  };
  findingSeverities: {
    low: number;
    medium: number;
    high: number;
  };
  reviewerRoutes: QualityReviewRouteCount[];
  reasons: QualityReviewReasonCount[];
  controllerDisposition: {
    status: 'unavailable';
    reason: 'controller-review-disposition-not-persisted';
  };
}

export type QualityReviewUsage =
  | (QualityReviewUsageBase & {
      status: 'available';
      coverage: 'complete' | 'partial';
    })
  | (QualityReviewUsageBase & {
      status: 'unavailable';
      reason: 'no-configured-quality-reviews' | 'no-classified-quality-reviews';
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
  routePools: RoutePoolUsage;
  qualityReview: QualityReviewUsage;
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

function routePoolUsage(jobs: readonly JobRecord[]): RoutePoolUsage {
  const observed = jobs.filter((job) => job.routePoolSelection !== undefined);
  if (observed.length === 0) {
    return {
      status: 'unavailable',
      reason: 'no-route-pool-selections',
      observedJobs: 0,
      classifiedJobs: 0,
      unavailableJobs: 0,
      selections: [],
    };
  }
  const counts = new Map<string, RoutePoolSelectionCount>();
  let classifiedJobs = 0;
  for (const job of observed) {
    const selection = job.routePoolSelection;
    if (
      !selection ||
      typeof selection.pool !== 'string' ||
      selection.pool.trim() === '' ||
      selection.strategy !== 'least-active' ||
      !Array.isArray(selection.candidates) ||
      !selection.candidates.includes(selection.selectedRoute) ||
      !isNonNegativeSafeInteger(selection.cursorBefore) ||
      !isNonNegativeSafeInteger(selection.selectedMemberIndex) ||
      selection.candidates[selection.selectedMemberIndex] !== selection.selectedRoute ||
      selection.selectedRoute !== job.route.name ||
      selection.tieBreak !== 'rotating-order'
    ) {
      continue;
    }
    classifiedJobs += 1;
    const key = `${selection.pool}\u0000${selection.selectedRoute}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else {
      counts.set(key, {
        pool: selection.pool,
        route: selection.selectedRoute,
        count: 1,
      });
    }
  }
  const unavailableJobs = observed.length - classifiedJobs;
  return {
    status: 'available',
    coverage: unavailableJobs === 0 ? 'complete' : 'partial',
    observedJobs: observed.length,
    classifiedJobs,
    unavailableJobs,
    selections: [...counts.values()].sort((left, right) => {
      if (left.pool !== right.pool) return left.pool.localeCompare(right.pool);
      return left.route.localeCompare(right.route);
    }),
  };
}

type ClassifiedQualityReview = Exclude<OrchestrationQualityReview, { status: 'pending' }>;

function includesString(values: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && values.includes(value);
}

function parseQualityReview(record: OrchestrationRecord): ClassifiedQualityReview | undefined {
  const route = record.policy.qualityReview?.route;
  const value = record.qualityReview;
  if (route === undefined || !isRecord(value) || value.route !== route) return undefined;
  if (
    value.status === 'skipped' &&
    includesString(QUALITY_REVIEW_SKIPPED_REASONS, value.reason)
  ) {
    return { status: 'skipped', route, reason: value.reason } as ClassifiedQualityReview;
  }
  if (
    value.status === 'unavailable' &&
    includesString(QUALITY_REVIEW_UNAVAILABLE_REASONS, value.reason)
  ) {
    return { status: 'unavailable', route, reason: value.reason } as ClassifiedQualityReview;
  }
  if (
    value.status !== 'completed' ||
    !includesString(QUALITY_REVIEW_VERDICTS, value.verdict) ||
    typeof value.childJobId !== 'string' ||
    value.childJobId.length === 0 ||
    typeof value.reviewerJobId !== 'string' ||
    value.reviewerJobId.length === 0 ||
    typeof value.summary !== 'string' ||
    value.summary.length === 0 ||
    !Array.isArray(value.findings) ||
    value.findings.length > 10
  ) {
    return undefined;
  }
  const findings = value.findings.flatMap((finding) => {
    if (
      !isRecord(finding) ||
      !includesString(QUALITY_REVIEW_FINDING_SEVERITIES, finding.severity) ||
      typeof finding.message !== 'string' ||
      finding.message.length === 0 ||
      typeof finding.evidence !== 'string' ||
      finding.evidence.length === 0
    ) {
      return [];
    }
    return [{ severity: finding.severity, message: finding.message, evidence: finding.evidence }];
  });
  if (findings.length !== value.findings.length) return undefined;
  if (value.verdict === 'changes-requested' && findings.length === 0) return undefined;
  return {
    status: 'completed',
    route,
    childJobId: value.childJobId,
    reviewerJobId: value.reviewerJobId,
    verdict: value.verdict,
    summary: value.summary,
    findings,
  } as ClassifiedQualityReview;
}

function qualityReviewUsage(orchestrations: readonly OrchestrationRecord[]): QualityReviewUsage {
  const configured = orchestrations.filter(
    (record) =>
      ['succeeded', 'failed', 'cancelled'].includes(record.status) &&
      record.policy.qualityReview !== undefined
  );
  const reviews = configured.flatMap((record) => {
    const review = parseQualityReview(record);
    return review === undefined ? [] : [review];
  });
  const completed = reviews.filter(
    (review): review is Extract<ClassifiedQualityReview, { status: 'completed' }> =>
      review.status === 'completed'
  );
  const routeCounts = new Map<string, number>();
  const reasonCounts = new Map<string, QualityReviewReasonCount>();
  for (const review of reviews) {
    routeCounts.set(review.route, (routeCounts.get(review.route) ?? 0) + 1);
    if (review.status === 'skipped' || review.status === 'unavailable') {
      const key = `${review.status}\u0000${review.reason}`;
      const existing = reasonCounts.get(key);
      if (existing) existing.count += 1;
      else reasonCounts.set(key, { status: review.status, reason: review.reason, count: 1 });
    }
  }
  const unclassifiedReviews = configured.length - reviews.length;
  const base: QualityReviewUsageBase = {
    configuredOrchestrations: configured.length,
    classifiedReviews: reviews.length,
    unclassifiedReviews,
    outcomes: {
      completed: completed.length,
      skipped: reviews.filter((review) => review.status === 'skipped').length,
      unavailable: reviews.filter((review) => review.status === 'unavailable').length,
    },
    verdicts: {
      accept: completed.filter((review) => review.verdict === 'accept').length,
      changesRequested: completed.filter((review) => review.verdict === 'changes-requested').length,
      uncertain: completed.filter((review) => review.verdict === 'uncertain').length,
    },
    findingSeverities: {
      low: completed.flatMap((review) => review.findings).filter((finding) => finding.severity === 'low')
        .length,
      medium: completed
        .flatMap((review) => review.findings)
        .filter((finding) => finding.severity === 'medium').length,
      high: completed
        .flatMap((review) => review.findings)
        .filter((finding) => finding.severity === 'high').length,
    },
    reviewerRoutes: [...routeCounts]
      .map(([route, count]) => ({ route, count }))
      .sort((left, right) => left.route.localeCompare(right.route)),
    reasons: [...reasonCounts.values()].sort((left, right) => {
      if (left.status !== right.status) return left.status.localeCompare(right.status);
      return left.reason.localeCompare(right.reason);
    }),
    controllerDisposition: {
      status: 'unavailable',
      reason: 'controller-review-disposition-not-persisted',
    },
  };
  if (configured.length === 0) {
    return { ...base, status: 'unavailable', reason: 'no-configured-quality-reviews' };
  }
  if (reviews.length === 0) {
    return { ...base, status: 'unavailable', reason: 'no-classified-quality-reviews' };
  }
  return {
    ...base,
    status: 'available',
    coverage: unclassifiedReviews === 0 ? 'complete' : 'partial',
  };
}

export function buildUsageReport(
  jobs: readonly JobRecord[],
  orchestrations: readonly OrchestrationRecord[]
): UsageReport {
  const downstream = downstreamUsage(jobs);
  const routeSelection = routeSelectionUsage(orchestrations);
  const routePools = routePoolUsage(jobs);
  const qualityReview = qualityReviewUsage(orchestrations);
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
    routePools,
    qualityReview,
    upstream: { status: 'unavailable', reason: 'controller-usage-not-persisted' },
    proportions: { status: 'unavailable', reason: 'controller-usage-not-persisted' },
  };
}

import type { OrchestrationRecord } from './orchestration-types.js';
import {
  MAX_HANDOFF_COMPLETION_ITEMS,
  MAX_HANDOFF_COMPLETION_TEXT_BYTES,
  MAX_HANDOFF_ERROR_BYTES,
  MAX_HANDOFF_ROUTE_IDENTITY_BYTES,
  MAX_ORCHESTRATION_HANDOFF_BYTES,
  MIN_HANDOFF_ERROR_MESSAGE_BYTES,
  limitText,
  limitTextSuffix,
  utf8Bytes,
} from './record-limits.js';
import type {
  JobArtifactVerificationReport,
  JobCompletionSummary,
  JobError,
  JobRecord,
  WorkerCompletionCheck,
} from './types.js';

const MAX_HANDOFF_VALIDATION_STREAM_BYTES = 2 * 1024;

export interface OrchestrationHandoffReader {
  /** Optional for compatibility with existing artifact-only projection readers. */
  getJob?(id: string): Promise<JobRecord | undefined>;
  verifyArtifacts(id: string): Promise<JobArtifactVerificationReport | undefined>;
}

/** @deprecated Use OrchestrationHandoffReader. */
export type ArtifactVerificationReader = OrchestrationHandoffReader;

interface HandoffError {
  code: string;
  message: string;
}

interface HandoffCompletion {
  outcome: JobCompletionSummary['outcome'];
  workerReported?:
    | {
        status: 'unavailable';
        reason: Extract<
          JobCompletionSummary['workerReported'],
          { status: 'unavailable' }
        >['reason'];
      }
    | {
        status: 'reported';
        report: {
          schemaVersion: 1;
          taskOutcome: 'completed' | 'blocked';
          changedFiles: string[];
          checksRun: WorkerCompletionCheck[];
          remainingRisks: string[];
          notes: string[];
        };
        truncated: boolean;
      };
}

interface HandoffChild {
  subtaskId: string;
  jobId: string;
  status: JobRecord['status'];
  route?:
    | NonNullable<OrchestrationRecord['children'][number]['route']>
    | { name: string }
    | undefined;
  routePoolSelection?: OrchestrationRecord['children'][number]['routePoolSelection'] | undefined;
  completion?: HandoffCompletion | undefined;
  outputAvailable: boolean;
  /** UTF-8 bytes actually retained in JobRecord.result.output, not original Worker bytes. */
  outputBytes: number;
  /** True only when the existing durable-result boundary truncated the original Worker output. */
  outputTruncated: boolean;
  error?: HandoffError | undefined;
}

interface HandoffArtifactAttempt {
  attempt: number;
  size?: number | undefined;
  sha256?: string | undefined;
  baseCommit?: string | undefined;
  baseTree?: string | undefined;
  changedFiles?: string[] | undefined;
  valid: boolean;
  issues: string[];
  file?: object | undefined;
  source?: object | undefined;
}

type HandoffArtifact =
  | { jobId: string; status: 'unavailable' }
  | {
      jobId: string;
      status: 'verified';
      valid: boolean;
      attempts: HandoffArtifactAttempt[];
    };

export interface OrchestrationHandoffTruncation {
  applied: true;
  maxBytes: number;
  originalBytes: number;
  /** Removed array entries or optional structured fields; shortened text counts once per field. */
  omittedItems: number;
  affectedChildren: string[];
}

interface OrchestrationHandoffProjection {
  schemaVersion: 1;
  id: string;
  status: OrchestrationRecord['status'];
  request?: object | undefined;
  plan?: object | undefined;
  children: HandoffChild[];
  qualityReview?: unknown;
  artifactValidation?: unknown;
  artifacts: HandoffArtifact[];
  result?: object | undefined;
  error?: HandoffError | undefined;
  handoffTruncation?: OrchestrationHandoffTruncation;
}

function compactStrings(values: string[]): { values: string[]; truncated: boolean } {
  const selected = values.slice(0, MAX_HANDOFF_COMPLETION_ITEMS);
  let truncated = selected.length !== values.length;
  const compact = selected.map((value) => {
    const bounded = limitText(value, MAX_HANDOFF_COMPLETION_TEXT_BYTES);
    if (bounded.truncation !== undefined) truncated = true;
    return bounded.value;
  });
  return { values: compact, truncated };
}

function compactChecks(values: WorkerCompletionCheck[]): {
  values: WorkerCompletionCheck[];
  truncated: boolean;
} {
  const selected = values.slice(0, MAX_HANDOFF_COMPLETION_ITEMS);
  let truncated = selected.length !== values.length;
  const compact = selected.map((value) => {
    const command = limitText(value.command, MAX_HANDOFF_COMPLETION_TEXT_BYTES);
    const notes =
      value.notes === undefined
        ? undefined
        : limitText(value.notes, MAX_HANDOFF_COMPLETION_TEXT_BYTES);
    if (command.truncation !== undefined || notes?.truncation !== undefined) truncated = true;
    return {
      command: command.value,
      outcome: value.outcome,
      ...(notes === undefined ? {} : { notes: notes.value }),
    };
  });
  return { values: compact, truncated };
}

function compactCompletion(summary: JobCompletionSummary | undefined): HandoffCompletion | undefined {
  if (summary === undefined) return undefined;
  if (summary.workerReported.status === 'unavailable') {
    return {
      outcome: summary.outcome,
      workerReported: summary.workerReported,
    };
  }
  const report = summary.workerReported.report;
  const changedFiles = compactStrings(report.changedFiles);
  const checksRun = compactChecks(report.checksRun);
  const remainingRisks = compactStrings(report.remainingRisks);
  const notes = compactStrings(report.notes);
  return {
    outcome: summary.outcome,
    workerReported: {
      status: 'reported',
      report: {
        schemaVersion: report.schemaVersion,
        taskOutcome: report.taskOutcome,
        changedFiles: changedFiles.values,
        checksRun: checksRun.values,
        remainingRisks: remainingRisks.values,
        notes: notes.values,
      },
      truncated:
        changedFiles.truncated ||
        checksRun.truncated ||
        remainingRisks.truncated ||
        notes.truncated,
    },
  };
}

function compactError(
  error: Pick<JobError, 'name' | 'message'> | undefined
): HandoffError | undefined {
  if (error === undefined) return undefined;
  return {
    code: error.name,
    message: limitText(error.message, MAX_HANDOFF_ERROR_BYTES).value,
  };
}

interface HandoffBudgetState {
  evidence: OrchestrationHandoffTruncation;
  affectedChildren: Set<string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializedHandoffBytes(value: object): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function recordOmission(
  state: HandoffBudgetState,
  count: number,
  childId?: string
): void {
  if (count < 1) return;
  state.evidence.omittedItems += count;
  if (childId !== undefined) state.affectedChildren.add(childId);
  state.evidence.affectedChildren = [...state.affectedChildren].sort();
}

function removedFieldCount(value: unknown, retained: readonly string[]): number {
  if (!isObject(value)) return 1;
  const retainedKeys = new Set(retained);
  return Object.keys(value).filter((key) => !retainedKeys.has(key)).length;
}

function reportedCompletion(child: HandoffChild): Extract<
  NonNullable<HandoffCompletion['workerReported']>,
  { status: 'reported' }
> | undefined {
  const workerReported = child.completion?.workerReported;
  return workerReported?.status === 'reported' ? workerReported : undefined;
}

function removeCompletionItems(
  handoff: OrchestrationHandoffProjection,
  state: HandoffBudgetState,
  field: 'notes' | 'checksRun' | 'changedFiles' | 'remainingRisks'
): boolean {
  while (true) {
    let removed = false;
    for (const child of handoff.children) {
      const workerReported = reportedCompletion(child);
      if (workerReported === undefined) continue;
      const values = workerReported.report[field];
      if (values.length === 0) continue;
      values.pop();
      workerReported.truncated = true;
      recordOmission(state, 1, child.subtaskId);
      removed = true;
      if (serializedHandoffBytes(handoff) <= MAX_ORCHESTRATION_HANDOFF_BYTES) return true;
    }
    if (!removed) return false;
  }
}

function removeArtifactChangedFiles(
  handoff: OrchestrationHandoffProjection,
  state: HandoffBudgetState
): boolean {
  while (true) {
    let removed = false;
    for (const artifact of handoff.artifacts) {
      if (artifact.status !== 'verified') continue;
      for (const attempt of artifact.attempts) {
        if (attempt.changedFiles === undefined || attempt.changedFiles.length === 0) continue;
        attempt.changedFiles.pop();
        const child = handoff.children.find((candidate) => candidate.jobId === artifact.jobId);
        recordOmission(state, 1, child?.subtaskId);
        removed = true;
        if (serializedHandoffBytes(handoff) <= MAX_ORCHESTRATION_HANDOFF_BYTES) return true;
      }
    }
    if (!removed) return false;
  }
}

function finalStatusProjection(value: unknown): object | undefined {
  if (!isObject(value) || typeof value.status !== 'string') return undefined;
  return {
    status: value.status,
    ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
    ...(typeof value.verdict === 'string' ? { verdict: value.verdict } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
}

function minimumRouteIdentity(route: HandoffChild['route']): { name: string } | undefined {
  if (route === undefined) return undefined;
  return {
    name: limitText(route.name, MAX_HANDOFF_ROUTE_IDENTITY_BYTES).value,
  };
}

function minimumError(error: HandoffError | undefined): HandoffError | undefined {
  if (error === undefined) return undefined;
  return {
    code: limitText(error.code, MAX_HANDOFF_ROUTE_IDENTITY_BYTES).value,
    message: limitText(error.message, MIN_HANDOFF_ERROR_MESSAGE_BYTES).value,
  };
}

function minimumHandoff(
  handoff: OrchestrationHandoffProjection,
  state: HandoffBudgetState
): OrchestrationHandoffProjection {
  for (const key of ['request', 'plan', 'qualityReview', 'result', 'error'] as const) {
    if (handoff[key] !== undefined) recordOmission(state, 1);
  }
  const children = handoff.children.map((child) => {
    recordOmission(state, 1, child.subtaskId);
    return {
      subtaskId: child.subtaskId,
      jobId: child.jobId,
      status: child.status,
      route: minimumRouteIdentity(child.route),
      ...(child.completion === undefined
        ? {}
        : { completion: { outcome: child.completion.outcome } }),
      outputAvailable: child.outputAvailable,
      outputBytes: child.outputBytes,
      outputTruncated: child.outputTruncated,
      ...(child.error === undefined ? {} : { error: minimumError(child.error) }),
    };
  });
  const artifacts = handoff.artifacts.map((artifact) => {
    if (artifact.status === 'unavailable') return artifact;
    const child = children.find((candidate) => candidate.jobId === artifact.jobId);
    recordOmission(state, 1, child?.subtaskId);
    return {
      jobId: artifact.jobId,
      status: artifact.status,
      valid: artifact.valid,
      attempts: [],
    };
  });
  const minimal: OrchestrationHandoffProjection = {
    schemaVersion: handoff.schemaVersion,
    id: handoff.id,
    status: handoff.status,
    children,
    ...(handoff.artifactValidation === undefined
      ? {}
      : { artifactValidation: finalStatusProjection(handoff.artifactValidation) }),
    artifacts,
    handoffTruncation: state.evidence,
  };

  while (serializedHandoffBytes(minimal) > MAX_ORCHESTRATION_HANDOFF_BYTES) {
    let shortened = false;
    for (const child of minimal.children) {
      for (const target of [child.error, child.route] as Array<
        { message?: string; name?: string } | undefined
      >) {
        const key = target?.message === undefined ? 'name' : 'message';
        const value = target?.[key];
        if (value === undefined || utf8Bytes(value) <= 1) continue;
        target![key] = limitText(value, Math.max(1, Math.floor(utf8Bytes(value) / 2))).value;
        recordOmission(state, 1, child.subtaskId);
        shortened = true;
        if (serializedHandoffBytes(minimal) <= MAX_ORCHESTRATION_HANDOFF_BYTES) return minimal;
      }
    }
    if (!shortened) break;
  }
  return minimal;
}

function enforceHandoffBudget(
  handoff: OrchestrationHandoffProjection
): OrchestrationHandoffProjection {
  const originalBytes = serializedHandoffBytes(handoff);
  if (originalBytes <= MAX_ORCHESTRATION_HANDOFF_BYTES) return handoff;

  const state: HandoffBudgetState = {
    evidence: {
      applied: true,
      maxBytes: MAX_ORCHESTRATION_HANDOFF_BYTES,
      originalBytes,
      omittedItems: 0,
      affectedChildren: [],
    },
    affectedChildren: new Set(),
  };
  handoff.handoffTruncation = state.evidence;
  const fits = (): boolean =>
    serializedHandoffBytes(handoff) <= MAX_ORCHESTRATION_HANDOFF_BYTES;

  if (handoff.request !== undefined) {
    delete handoff.request;
    recordOmission(state, 1);
    if (fits()) return handoff;
  }
  if (handoff.plan !== undefined && isObject(handoff.plan)) {
    const plan = handoff.plan;
    handoff.plan = {
      ...(typeof plan.decision === 'string' ? { decision: plan.decision } : {}),
      ...(typeof plan.willDispatch === 'boolean' ? { willDispatch: plan.willDispatch } : {}),
    };
    recordOmission(state, Math.max(1, removedFieldCount(plan, ['decision', 'willDispatch'])));
    if (fits()) return handoff;
  }
  for (const child of handoff.children) {
    if (child.routePoolSelection !== undefined) {
      delete child.routePoolSelection;
      recordOmission(state, 1, child.subtaskId);
      if (fits()) return handoff;
    }
    if (child.route !== undefined && 'worker' in child.route) {
      const route = child.route;
      child.route = {
        name: route.name,
        worker: route.worker,
        provider: route.provider,
        model: route.model,
      };
      recordOmission(
        state,
        Math.max(1, removedFieldCount(route, ['name', 'worker', 'provider', 'model'])),
        child.subtaskId
      );
      if (fits()) return handoff;
    }
  }
  for (const field of ['qualityReview', 'artifactValidation'] as const) {
    const value = handoff[field];
    const projected = finalStatusProjection(value);
    if (value === undefined || projected === undefined) continue;
    handoff[field] = projected;
    recordOmission(state, Math.max(1, removedFieldCount(value, Object.keys(projected))));
    if (fits()) return handoff;
  }
  if (handoff.result !== undefined && isObject(handoff.result)) {
    const result = handoff.result;
    const artifactReview = isObject(result.artifactReview)
      ? { status: result.artifactReview.status }
      : undefined;
    handoff.result = {
      ...(typeof result.action === 'string' ? { action: result.action } : {}),
      ...(artifactReview === undefined ? {} : { artifactReview }),
    };
    recordOmission(state, Math.max(1, removedFieldCount(result, ['action', 'artifactReview'])));
    if (fits()) return handoff;
  }
  for (const artifact of handoff.artifacts) {
    if (artifact.status !== 'verified') continue;
    for (const attempt of artifact.attempts) {
      for (const field of ['file', 'source'] as const) {
        if (attempt[field] === undefined) continue;
        delete attempt[field];
        const child = handoff.children.find((candidate) => candidate.jobId === artifact.jobId);
        recordOmission(state, 1, child?.subtaskId);
        if (fits()) return handoff;
      }
    }
  }

  if (removeCompletionItems(handoff, state, 'notes')) return handoff;
  if (removeCompletionItems(handoff, state, 'checksRun')) return handoff;
  if (removeCompletionItems(handoff, state, 'changedFiles')) return handoff;
  if (removeArtifactChangedFiles(handoff, state)) return handoff;
  if (removeCompletionItems(handoff, state, 'remainingRisks')) return handoff;

  for (const child of handoff.children) {
    if (child.completion?.workerReported === undefined) continue;
    delete child.completion.workerReported;
    recordOmission(state, 1, child.subtaskId);
    if (fits()) return handoff;
  }
  for (const artifact of handoff.artifacts) {
    if (artifact.status !== 'verified') continue;
    for (const attempt of artifact.attempts) {
      const retained = ['attempt', 'valid', 'issues'] as const;
      const omitted = removedFieldCount(attempt, retained);
      const compact = {
        attempt: attempt.attempt,
        valid: attempt.valid,
        issues: attempt.issues,
      };
      Object.assign(attempt, compact);
      for (const key of Object.keys(attempt)) {
        if (!retained.includes(key as (typeof retained)[number])) {
          delete (attempt as unknown as Record<string, unknown>)[key];
        }
      }
      const child = handoff.children.find((candidate) => candidate.jobId === artifact.jobId);
      recordOmission(state, omitted, child?.subtaskId);
      if (fits()) return handoff;
    }
    while (artifact.attempts.length > 0) {
      artifact.attempts.pop();
      const child = handoff.children.find((candidate) => candidate.jobId === artifact.jobId);
      recordOmission(state, 1, child?.subtaskId);
      if (fits()) return handoff;
    }
  }
  for (const child of handoff.children) {
    if (child.error === undefined) continue;
    const compact = minimumError(child.error);
    if (compact === undefined) continue;
    if (compact?.message === child.error.message && compact.code === child.error.code) continue;
    child.error = compact;
    recordOmission(state, 1, child.subtaskId);
    if (fits()) return handoff;
  }
  for (const child of handoff.children) {
    if (child.route === undefined) continue;
    const compact = minimumRouteIdentity(child.route);
    if (compact === undefined) continue;
    child.route = compact;
    recordOmission(state, 1, child.subtaskId);
    if (fits()) return handoff;
  }
  return minimumHandoff(handoff, state);
}

function compactArtifactValidation(
  value: OrchestrationRecord['artifactValidation']
): OrchestrationRecord['artifactValidation'] | object {
  if (value === undefined || !('command' in value) || value.command === undefined) return value;
  const command = value.command;
  return {
    ...value,
    command: {
      argv: command.argv,
      outcome: command.outcome,
      exitCode: command.exitCode,
      signal: command.signal,
      durationMs: command.durationMs,
      stdoutTail: limitTextSuffix(command.stdout, MAX_HANDOFF_VALIDATION_STREAM_BYTES),
      stderrTail: limitTextSuffix(command.stderr, MAX_HANDOFF_VALIDATION_STREAM_BYTES),
      outputTruncated: command.outputTruncated,
      maxOutputBytes: command.maxOutputBytes,
    },
  };
}

export async function buildOrchestrationHandoff(
  reader: OrchestrationHandoffReader,
  record: OrchestrationRecord
): Promise<object> {
  const childEvidence = await Promise.all(
    record.children.map(async (child) => {
      const [job, verification] = await Promise.all([
        reader.getJob?.(child.jobId),
        reader.verifyArtifacts(child.jobId),
      ]);
      const output = reader.getJob === undefined ? child.output : job?.result?.output;
      const handoffChild: HandoffChild = {
        subtaskId: child.subtaskId,
        jobId: child.jobId,
        status: child.status,
        route: child.route,
        routePoolSelection: child.routePoolSelection,
        completion: compactCompletion(job?.completionSummary),
        outputAvailable: output !== undefined,
        outputBytes: output === undefined ? 0 : Buffer.byteLength(output, 'utf8'),
        outputTruncated:
          output === undefined ? false : job?.result?.outputTruncation !== undefined,
        error: compactError(child.error ?? job?.error),
      };
      const artifact: HandoffArtifact =
        verification === undefined
          ? { jobId: child.jobId, status: 'unavailable' }
          : {
              jobId: child.jobId,
              status: 'verified',
              valid: verification.valid,
              attempts: verification.artifacts.map((attempt) => ({
                attempt: attempt.artifact.attempt,
                size: attempt.artifact.size,
                sha256: attempt.artifact.sha256,
                baseCommit: attempt.artifact.baseCommit,
                baseTree: attempt.artifact.baseTree,
                changedFiles:
                  attempt.artifact.changedFiles === undefined
                    ? undefined
                    : [...attempt.artifact.changedFiles],
                valid: attempt.valid,
                issues: [...attempt.issues],
                file: {
                  exists: attempt.file.exists,
                  actualSize: attempt.file.actualSize,
                  sizeMatches: attempt.file.sizeMatches,
                  actualSha256: attempt.file.actualSha256,
                  sha256Matches: attempt.file.sha256Matches,
                },
                source: {
                  repositoryAvailable: attempt.source.repositoryAvailable,
                  actualHead: attempt.source.actualHead,
                  headMatchesBase: attempt.source.headMatchesBase,
                  actualTree: attempt.source.actualTree,
                  treeMatchesBase: attempt.source.treeMatchesBase,
                },
              })),
            };
      return {
        child: handoffChild,
        artifact,
      };
    })
  );
  const handoff: OrchestrationHandoffProjection = {
    schemaVersion: record.schemaVersion,
    id: record.id,
    status: record.status,
    request: {
      source: record.request.source,
      delegation: record.request.delegation,
    },
    plan:
      record.plan === undefined
        ? undefined
        : {
            policyVersion: record.plan.policyVersion,
            planHash: record.plan.planHash,
            mode: record.plan.mode,
            decision: record.plan.decision,
            willDispatch: record.plan.willDispatch,
            reasoning: record.plan.reasoning,
            assessment: {
              recommendation: record.plan.assessment.recommendation,
              complexity: record.plan.assessment.complexity,
              parallelizable: record.plan.assessment.parallelizable,
              taskKinds: record.plan.assessment.taskKinds,
            },
            subtasks: record.plan.subtasks.map((subtask) => ({
              id: subtask.id,
              title: subtask.title,
              kind: subtask.kind,
              route: subtask.route,
              routeSelection: subtask.routeSelection,
            })),
          },
    children: childEvidence.map((evidence) => evidence.child),
    qualityReview: record.qualityReview,
    artifactValidation: compactArtifactValidation(record.artifactValidation),
    artifacts: childEvidence.map((evidence) => evidence.artifact),
    result:
      record.result === undefined
        ? undefined
        : {
            action: record.result.action,
            artifactReview: record.result.artifactReview,
          },
    error: compactError(record.error),
  };
  return enforceHandoffBudget(handoff);
}

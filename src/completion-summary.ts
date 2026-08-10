import type {
  JobCompletionSummaryChangedFiles,
  JobCompletionSummaryWorkerReported,
  JobArtifact,
  WorkerCompletionCheck,
  WorkerCompletionReport,
} from './types.js';
import { MAX_WORKER_COMPLETION_REPORT_BYTES, utf8Bytes } from './record-limits.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || typeof value[index] !== 'string') return false;
  }
  return true;
}

function isWorkerCompletionCheck(value: unknown): value is WorkerCompletionCheck {
  if (!isRecord(value) || !hasOnlyKeys(value, ['command', 'outcome'], ['notes'])) return false;
  if (typeof value.command !== 'string' || value.command.trim() === '') return false;
  if (
    value.outcome !== 'passed' &&
    value.outcome !== 'failed' &&
    value.outcome !== 'unknown'
  ) {
    return false;
  }
  return !hasOwn(value, 'notes') || typeof value.notes === 'string';
}

/**
 * Validate and copy the optional adapter-owned report without interpreting any other worker data.
 * `undefined` is intentionally distinct from a malformed value so callers can preserve a stable
 * unavailable reason in the terminal summary.
 */
export function validateWorkerCompletionReport(
  value: unknown
): WorkerCompletionReport | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !hasOnlyKeys(value, ['schemaVersion', 'changedFiles', 'checksRun', 'remainingRisks', 'notes']) ||
    value.schemaVersion !== 1 ||
    !isStringArray(value.changedFiles) ||
    !Array.isArray(value.checksRun) ||
    !isStringArray(value.remainingRisks) ||
    !isStringArray(value.notes)
  ) {
    return undefined;
  }

  const checksRun: WorkerCompletionCheck[] = [];
  for (let index = 0; index < value.checksRun.length; index += 1) {
    const check = value.checksRun[index];
    if (
      !Object.prototype.hasOwnProperty.call(value.checksRun, index) ||
      !isWorkerCompletionCheck(check)
    ) {
      return undefined;
    }
    checksRun.push({
      command: check.command,
      outcome: check.outcome,
      ...(check.notes === undefined ? {} : { notes: check.notes }),
    });
  }

  const report: WorkerCompletionReport = {
    schemaVersion: 1,
    changedFiles: [...value.changedFiles],
    checksRun,
    remainingRisks: [...value.remainingRisks],
    notes: [...value.notes],
  };
  if (utf8Bytes(JSON.stringify(report)) > MAX_WORKER_COMPLETION_REPORT_BYTES) return undefined;
  return report;
}

export function workerReportedSummary(
  value: unknown,
  retainedNormalResult: boolean
): JobCompletionSummaryWorkerReported {
  if (!retainedNormalResult) return { status: 'unavailable', reason: 'not-retained' };
  if (value === undefined) return { status: 'unavailable', reason: 'absent' };
  // The Pi adapter uses null to mark a detected malformed/unsupported envelope. Keep that
  // distinction at the adapter boundary while mapping it to the stable summary reason.
  const report = validateWorkerCompletionReport(value);
  if (!report) return { status: 'unavailable', reason: 'malformed' };
  return { status: 'reported', report };
}

export function capturedChangedFilesSummary(
  isolationEnabled: boolean,
  artifacts: JobArtifact[] | undefined,
  attempt: number
): JobCompletionSummaryChangedFiles {
  if (!isolationEnabled) return { status: 'unavailable', reason: 'workspace-isolation-disabled' };
  const artifact = artifacts?.find((candidate) => candidate.attempt === attempt);
  if (!artifact || artifact.kind !== 'git-patch') {
    return { status: 'unavailable', reason: 'artifact-unavailable' };
  }
  if (!isStringArray(artifact.changedFiles)) {
    return { status: 'unavailable', reason: 'artifact-paths-unavailable' };
  }
  return {
    status: 'captured',
    paths: [...artifact.changedFiles],
    artifact: {
      attempt: artifact.attempt,
      sha256: artifact.sha256,
      baseCommit: artifact.baseCommit,
      ...(artifact.baseTree === undefined ? {} : { baseTree: artifact.baseTree }),
    },
  };
}

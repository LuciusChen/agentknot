import type {
  PlannedSubtask,
  QualityReviewFinding,
  QualityReviewVerdict,
} from './orchestration-types.js';
import { QUALITY_REVIEW_FINDING_SEVERITIES, QUALITY_REVIEW_VERDICTS } from './orchestration-types.js';
import { utf8Bytes } from './record-limits.js';
import type { JobArtifactPreview, JobRecord } from './types.js';

export const MAX_QUALITY_REVIEW_PATCH_BYTES = 32 * 1024;
export const MAX_QUALITY_REVIEW_OUTPUT_BYTES = 8 * 1024;
const MAX_QUALITY_REVIEW_SUMMARY_BYTES = 2 * 1024;
const MAX_QUALITY_REVIEW_FINDINGS = 10;
const MAX_QUALITY_REVIEW_FINDING_FIELD_BYTES = 1024;
const MAX_QUALITY_REVIEW_WORKER_CLAIMS_BYTES = 8 * 1024;

export interface ParsedQualityReview {
  schemaVersion: 1;
  verdict: QualityReviewVerdict;
  summary: string;
  findings: QualityReviewFinding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key));
}

function boundedNonEmptyString(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && utf8Bytes(value) <= maximumBytes;
}

export function parseQualityReview(output: string): ParsedQualityReview {
  if (utf8Bytes(output) > MAX_QUALITY_REVIEW_OUTPUT_BYTES) {
    throw new Error(`Quality reviewer output exceeds ${MAX_QUALITY_REVIEW_OUTPUT_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error('Quality reviewer output must be one valid JSON object', { cause: error });
  }
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'verdict', 'summary', 'findings'])) {
    throw new Error('Quality reviewer output must contain only schemaVersion, verdict, summary, and findings');
  }
  if (value.schemaVersion !== 1) throw new Error('Quality reviewer schemaVersion must be 1');
  if (!QUALITY_REVIEW_VERDICTS.includes(value.verdict as QualityReviewVerdict)) {
    throw new Error('Quality reviewer verdict must be accept, changes-requested, or uncertain');
  }
  if (!boundedNonEmptyString(value.summary, MAX_QUALITY_REVIEW_SUMMARY_BYTES)) {
    throw new Error(`Quality reviewer summary must be non-empty and at most ${MAX_QUALITY_REVIEW_SUMMARY_BYTES} bytes`);
  }
  if (!Array.isArray(value.findings) || value.findings.length > MAX_QUALITY_REVIEW_FINDINGS) {
    throw new Error(`Quality reviewer findings must contain at most ${MAX_QUALITY_REVIEW_FINDINGS} entries`);
  }
  const findings: QualityReviewFinding[] = value.findings.map((finding, index) => {
    if (!isRecord(finding) || !hasExactKeys(finding, ['severity', 'message', 'evidence'])) {
      throw new Error(`Quality reviewer findings[${index}] must contain only severity, message, and evidence`);
    }
    if (!QUALITY_REVIEW_FINDING_SEVERITIES.includes(finding.severity as QualityReviewFinding['severity'])) {
      throw new Error(`Quality reviewer findings[${index}].severity is invalid`);
    }
    if (!boundedNonEmptyString(finding.message, MAX_QUALITY_REVIEW_FINDING_FIELD_BYTES)) {
      throw new Error(`Quality reviewer findings[${index}].message is invalid or too large`);
    }
    if (!boundedNonEmptyString(finding.evidence, MAX_QUALITY_REVIEW_FINDING_FIELD_BYTES)) {
      throw new Error(`Quality reviewer findings[${index}].evidence is invalid or too large`);
    }
    return {
      severity: finding.severity as QualityReviewFinding['severity'],
      message: finding.message,
      evidence: finding.evidence,
    };
  });
  if (value.verdict === 'changes-requested' && findings.length === 0) {
    throw new Error('Quality reviewer changes-requested verdict requires at least one finding');
  }
  return {
    schemaVersion: 1,
    verdict: value.verdict as QualityReviewVerdict,
    summary: value.summary,
    findings,
  };
}

function workerClaims(job: JobRecord): string {
  const claims = job.completionSummary?.workerReported ?? {
    status: 'unavailable',
    reason: 'completion-summary-unavailable',
  };
  const serialized = JSON.stringify(claims);
  return utf8Bytes(serialized) <= MAX_QUALITY_REVIEW_WORKER_CLAIMS_BYTES
    ? serialized
    : JSON.stringify({ status: 'unavailable', reason: 'worker-claims-too-large' });
}

export function buildQualityReviewPrompt(input: {
  parentGoal: string;
  subtask: PlannedSubtask;
  childJob: JobRecord;
  preview: JobArtifactPreview;
}): string {
  const artifact = input.preview.artifact;
  return [
    'You are AgentKnot\'s independent advisory quality reviewer in a fresh session.',
    'Prioritize whether the proposed patch correctly completes the requested task. Look for concrete behavioral defects, missed acceptance criteria, unsafe scope expansion, and material test gaps.',
    'Use repository inspection tools when available to read only task-relevant files and context needed to assess the supplied patch. Do not edit files, apply the patch, execute repository commands, repair code, delegate, converse with another agent, commit, push, merge, or promote artifacts.',
    'The patch bytes and identity below were verified by AgentKnot. Worker completion and test reports are explicitly unverified claims; assess their adequacy rather than treating them as proof.',
    'Return JSON only with exactly this shape and no markdown fence or trailing prose:',
    '{"schemaVersion":1,"verdict":"accept|changes-requested|uncertain","summary":"concise quality assessment","findings":[{"severity":"low|medium|high","message":"specific issue","evidence":"patch or requirement evidence"}]}',
    'Use changes-requested only with at least one concrete finding. Use uncertain when the bounded evidence cannot support acceptance or a specific rejection. This verdict is advisory; the upstream controller remains the final authority.',
    '',
    'Parent goal:',
    input.parentGoal,
    '',
    `Subtask: ${input.subtask.title}`,
    input.subtask.prompt,
    '',
    'Acceptance criteria:',
    ...input.subtask.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    'Controller-verified artifact identity:',
    JSON.stringify({
      childJobId: input.childJob.id,
      attempt: artifact.attempt,
      size: artifact.size,
      sha256: artifact.sha256,
      baseCommit: artifact.baseCommit,
      changedFiles: artifact.changedFiles,
    }),
    '',
    'Worker completion/test claims (unverified):',
    workerClaims(input.childJob),
    '',
    'Verified patch preview:',
    input.preview.content ?? '',
  ].join('\n');
}

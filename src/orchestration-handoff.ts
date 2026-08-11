import type { OrchestrationRecord } from './orchestration-types.js';
import { limitTextSuffix } from './record-limits.js';
import type { JobArtifactVerificationReport } from './types.js';

const MAX_HANDOFF_VALIDATION_STREAM_BYTES = 2 * 1024;

export interface ArtifactVerificationReader {
  verifyArtifacts(id: string): Promise<JobArtifactVerificationReport | undefined>;
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
  reader: ArtifactVerificationReader,
  record: OrchestrationRecord
): Promise<object> {
  const artifacts = await Promise.all(
    record.children.map(async (child) => {
      const verification = await reader.verifyArtifacts(child.jobId);
      if (verification === undefined) return { jobId: child.jobId, status: 'unavailable' };
      return {
        jobId: child.jobId,
        status: 'verified',
        valid: verification.valid,
        attempts: verification.artifacts.map((attempt) => ({
          attempt: attempt.artifact.attempt,
          size: attempt.artifact.size,
          sha256: attempt.artifact.sha256,
          baseCommit: attempt.artifact.baseCommit,
          baseTree: attempt.artifact.baseTree,
          changedFiles: attempt.artifact.changedFiles,
          valid: attempt.valid,
          issues: attempt.issues,
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
    })
  );
  return {
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
    children: record.children.map((child) => ({
      subtaskId: child.subtaskId,
      jobId: child.jobId,
      status: child.status,
      route: child.route,
      routePoolSelection: child.routePoolSelection,
      output: child.output,
      error: child.error,
    })),
    qualityReview: record.qualityReview,
    artifactValidation: compactArtifactValidation(record.artifactValidation),
    artifacts,
    result:
      record.result === undefined
        ? undefined
        : {
            action: record.result.action,
            artifactReview: record.result.artifactReview,
          },
    error: record.error,
  };
}

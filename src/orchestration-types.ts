import type { DelegationConfig, DelegationMode } from './config.js';
import type {
  JobCompletionSummaryChangedFilesUnavailableReason,
  JobError,
  JobExecution,
  JobRoutePoolSelection,
  JobStatus,
  JobWorkspaceSnapshot,
  ResolvedRoute,
} from './types.js';

export const ORCHESTRATION_STATUSES = [
  'queued',
  'dispatching',
  'succeeded',
  'failed',
  'cancelled',
] as const;

/** Historical snapshots may still contain the pre-handoff planning status. */
export type OrchestrationStatus = (typeof ORCHESTRATION_STATUSES)[number] | 'planning';

export const ORCHESTRATION_DELEGATION_OVERRIDES = ['inherit', 'never', 'suggest', 'force'] as const;

export type OrchestrationDelegationOverride = (typeof ORCHESTRATION_DELEGATION_OVERRIDES)[number];

export interface OrchestrationRequest {
  prompt: string;
  workspace: string;
  /** Authored by the upstream controller and strictly validated before admission. */
  assessment: TaskAssessment;
  source?: string;
  metadata?: Record<string, unknown>;
  /** May narrow automatic behavior. `force` never bypasses global off mode or keep-upstream policy. */
  delegation?: OrchestrationDelegationOverride;
  /** Opaque caller key for exactly-once admission of one canonical handoff. */
  idempotencyKey?: string;
}

export type TaskComplexity = 'low' | 'medium' | 'high';

export type RouteSelectionEvidence =
  | {
      mode: 'shadow';
      suggestedRoute: string;
      basis: 'rule';
      ruleIndex: number;
    }
  | {
      mode: 'shadow';
      suggestedRoute: string;
      basis: 'default';
    }
  | {
      mode: 'active';
      selectedRoute: string;
      basis: 'rule';
      ruleIndex: number;
    }
  | {
      mode: 'active';
      selectedRoute: string;
      basis: 'default';
    };

export interface AssessedSubtask {
  title: string;
  kind: string;
  prompt: string;
  acceptanceCriteria: string[];
}

export interface TaskAssessment {
  schemaVersion: 1;
  recommendation: 'delegate' | 'do-not-delegate';
  complexity: TaskComplexity;
  parallelizable: boolean;
  taskKinds: string[];
  reasoning: string;
  subtasks: AssessedSubtask[];
}

export type DelegationDecision = 'upstream' | 'delegate' | 'split';

export interface PlannedSubtask extends AssessedSubtask {
  id: string;
  /** The actual execution route; only active configured selection can replace the default. */
  route: string;
  executionPrompt: string;
  routeSelection?: RouteSelectionEvidence;
}

export type AgentKnotDelegationMetadata =
  | {
      orchestrationId: string;
      role: 'worker';
      subtaskId: string;
      depth: 1;
      planHash: string;
      policyVersion: 1;
      taskKind: string;
      /** Complexity assessed for the parent orchestration goal. */
      parentComplexity: TaskComplexity;
      routeSelection?: RouteSelectionEvidence;
    }
  | {
      orchestrationId: string;
      role: 'reviewer';
      depth: 1;
      childJobId: string;
      planHash: string;
      policyVersion: 1;
    };

export interface DelegationPlan {
  policyVersion: 1;
  planHash: string;
  mode: DelegationMode;
  decision: DelegationDecision;
  willDispatch: boolean;
  reasoning: string;
  assessment: TaskAssessment;
  subtasks: PlannedSubtask[];
}

export const ORCHESTRATION_EVENT_TYPES = [
  'orchestration.queued',
  'orchestration.recovery.started',
  'orchestration.handoff.accepted',
  'orchestration.dispatching',
  'orchestration.child.started',
  'orchestration.child.completed',
  'orchestration.review.skipped',
  'orchestration.review.started',
  'orchestration.review.completed',
  'orchestration.review.unavailable',
  'orchestration.artifact-validation.skipped',
  'orchestration.artifact-validation.started',
  'orchestration.artifact-validation.completed',
  'orchestration.artifact-validation.unavailable',
  'orchestration.cancel.requested',
  'orchestration.succeeded',
  'orchestration.failed',
  'orchestration.cancelled',
] as const;

export type OrchestrationEventType = (typeof ORCHESTRATION_EVENT_TYPES)[number];

export interface OrchestrationEvent {
  sequence: number;
  orchestrationId: string;
  at: string;
  type: OrchestrationEventType;
  data?: Record<string, unknown>;
}

export interface OrchestrationChild {
  subtaskId: string;
  jobId: string;
  planHash: string;
  policyVersion: 1;
  status: JobStatus;
  /** Exact admitted route snapshot; absent only on legacy records. */
  route?: ResolvedRoute;
  /** Pool admission evidence copied from the authoritative child Job when present. */
  routePoolSelection?: JobRoutePoolSelection;
  output?: string;
  error?: JobError;
}

export type OrchestrationArtifactReviewUnavailableReason =
  | 'job-not-found'
  | 'completion-summary-unavailable'
  | JobCompletionSummaryChangedFilesUnavailableReason;

export interface OrchestrationArtifactReview {
  /** `checked` means path evidence was available for every child, not that patches are compatible. */
  status: 'checked' | 'incomplete';
  /** Exact path overlap is conservative review evidence, not semantic conflict verification. */
  conflicts: Array<{ path: string; subtaskIds: string[] }>;
  unavailable: Array<{
    subtaskId: string;
    jobId: string;
    reason: OrchestrationArtifactReviewUnavailableReason;
  }>;
}

export const QUALITY_REVIEW_VERDICTS = ['accept', 'changes-requested', 'uncertain'] as const;
export type QualityReviewVerdict = (typeof QUALITY_REVIEW_VERDICTS)[number];

export const QUALITY_REVIEW_FINDING_SEVERITIES = ['low', 'medium', 'high'] as const;
export type QualityReviewFindingSeverity = (typeof QUALITY_REVIEW_FINDING_SEVERITIES)[number];

export interface QualityReviewFinding {
  severity: QualityReviewFindingSeverity;
  message: string;
  evidence: string;
}

export const QUALITY_REVIEW_SKIPPED_REASONS = [
  'not-delegated',
  'complexity-not-selected',
  'child-count-not-one',
  'child-not-succeeded',
  'child-job-unavailable',
  'artifact-count-not-one',
  'artifact-invalid',
  'artifact-empty',
  'artifact-too-large',
  'artifact-truncated',
  'handoff-too-large',
] as const;
export type QualityReviewSkippedReason = (typeof QUALITY_REVIEW_SKIPPED_REASONS)[number];

export const QUALITY_REVIEW_UNAVAILABLE_REASONS = [
  'reviewer-start-failed',
  'reviewer-failed',
  'reviewer-output-truncated',
  'reviewer-output-invalid',
  'parent-cancelled',
  'runtime-restart',
] as const;
export type QualityReviewUnavailableReason =
  (typeof QUALITY_REVIEW_UNAVAILABLE_REASONS)[number];

export type OrchestrationQualityReview =
  | {
      status: 'skipped';
      route: string;
      reason: QualityReviewSkippedReason;
    }
  | {
      status: 'pending';
      route: string;
      childJobId: string;
      reviewerJobId: string;
    }
  | {
      status: 'unavailable';
      route: string;
      childJobId?: string;
      reviewerJobId?: string;
      reason: QualityReviewUnavailableReason;
      error?: { name: string; message: string };
    }
  | {
      status: 'completed';
      route: string;
      childJobId: string;
      reviewerJobId: string;
      verdict: QualityReviewVerdict;
      summary: string;
      findings: QualityReviewFinding[];
    };

export interface ArtifactValidationIdentity {
  attempt: number;
  size: number;
  sha256: string;
  baseCommit: string;
  baseTree?: string;
}

export const ARTIFACT_VALIDATION_COMMAND_OUTCOMES = [
  'passed',
  'failed',
  'timed-out',
  'output-limit',
  'cancelled',
] as const;
export type ArtifactValidationCommandOutcome =
  (typeof ARTIFACT_VALIDATION_COMMAND_OUTCOMES)[number];

export interface ArtifactValidationCommandEvidence {
  argv: string[];
  outcome: ArtifactValidationCommandOutcome;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  maxOutputBytes: number;
}

export const ARTIFACT_VALIDATION_SKIPPED_REASONS = [
  'not-delegated',
  'child-count-not-one',
  'child-not-succeeded',
  'child-job-unavailable',
  'artifact-count-not-one',
  'artifact-invalid',
  'artifact-empty',
  'artifact-too-large',
] as const;
export type ArtifactValidationSkippedReason =
  (typeof ARTIFACT_VALIDATION_SKIPPED_REASONS)[number];

export const ARTIFACT_VALIDATION_UNAVAILABLE_REASONS = [
  'artifact-invalid',
  'source-drift',
  'patch-apply-failed',
  'validation-start-failed',
  'cleanup-failed',
  'parent-cancelled',
  'runtime-restart',
] as const;
export type ArtifactValidationUnavailableReason =
  (typeof ARTIFACT_VALIDATION_UNAVAILABLE_REASONS)[number];

export type OrchestrationArtifactValidation =
  | {
      status: 'skipped';
      reason: ArtifactValidationSkippedReason;
    }
  | {
      status: 'pending';
      childJobId: string;
      artifact: ArtifactValidationIdentity;
    }
  | {
      status: 'unavailable';
      childJobId?: string;
      artifact?: ArtifactValidationIdentity;
      reason: ArtifactValidationUnavailableReason;
      cleanup: 'not-started' | 'cleaned' | 'failed' | 'not-confirmed';
      command?: ArtifactValidationCommandEvidence;
      error?: { name: string; message: string };
    }
  | {
      status: 'completed';
      childJobId: string;
      artifact: ArtifactValidationIdentity;
      outcome: 'passed' | 'failed';
      command: ArtifactValidationCommandEvidence;
      cleanup: 'cleaned';
    };

export interface OrchestrationResult {
  action: 'upstream' | 'suggested' | 'delegated';
  children: OrchestrationChild[];
  /** Present only for newly completed delegated results. */
  artifactReview?: OrchestrationArtifactReview;
}

export interface OrchestrationError {
  name: string;
  message: string;
}

export interface OrchestrationRecord {
  id: string;
  schemaVersion: 1;
  status: OrchestrationStatus;
  request: OrchestrationRequest;
  /** Immutable effective policy captured before handoff composition and child dispatch. */
  policy: DelegationConfig;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelRequestedAt?: string;
  execution: JobExecution;
  events: OrchestrationEvent[];
  /** Immutable parent input used for every child and reviewer admission. */
  workspaceSnapshot?: JobWorkspaceSnapshot;
  plan?: DelegationPlan;
  children: OrchestrationChild[];
  /** Optional advisory evidence from one separately configured depth-one reviewer Job. */
  qualityReview?: OrchestrationQualityReview;
  /** Optional controller-owned command evidence from one applied patch in a disposable worktree. */
  artifactValidation?: OrchestrationArtifactValidation;
  result?: OrchestrationResult;
  error?: OrchestrationError;
}

export interface OrchestrationStore {
  create(record: OrchestrationRecord): Promise<void>;
  save(record: OrchestrationRecord): Promise<void>;
  get(id: string): Promise<OrchestrationRecord | undefined>;
  list(): Promise<OrchestrationRecord[]>;
  eventsAfter?(id: string, sequence: number): Promise<OrchestrationEvent[]>;
  createIdempotent?(
    scope: string,
    key: string,
    requestHash: string,
    record: OrchestrationRecord
  ): Promise<{ created: boolean; record: OrchestrationRecord }>;
}

export interface StartOrchestrationResult {
  orchestration: OrchestrationRecord;
  completion: Promise<OrchestrationRecord>;
  cancel: () => Promise<void>;
}

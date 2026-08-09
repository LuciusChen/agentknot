export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TERMINAL_OUTCOMES = ['succeeded', 'failed', 'cancelled'] as const;

export type JobTerminalOutcome = (typeof JOB_TERMINAL_OUTCOMES)[number];

export const JOB_COMPLETION_SUMMARY_CHANGED_FILES_UNAVAILABLE_REASONS = [
  'workspace-isolation-disabled',
  'artifact-unavailable',
  'artifact-paths-unavailable',
] as const;

export type JobCompletionSummaryChangedFilesUnavailableReason =
  (typeof JOB_COMPLETION_SUMMARY_CHANGED_FILES_UNAVAILABLE_REASONS)[number];

export const WORKER_COMPLETION_REPORT_UNAVAILABLE_REASONS = [
  'absent',
  'malformed',
  'not-retained',
] as const;

export type WorkerCompletionReportUnavailableReason =
  (typeof WORKER_COMPLETION_REPORT_UNAVAILABLE_REASONS)[number];

export const WORKER_COMPLETION_CHECK_OUTCOMES = ['passed', 'failed', 'unknown'] as const;

export type WorkerCompletionCheckOutcome = (typeof WORKER_COMPLETION_CHECK_OUTCOMES)[number];

export interface WorkerCompletionCheck {
  command: string;
  outcome: WorkerCompletionCheckOutcome;
  notes?: string;
}

/** Worker claims are kept distinct from controller-captured artifact evidence. */
export interface WorkerCompletionReport {
  schemaVersion: 1;
  changedFiles: string[];
  checksRun: WorkerCompletionCheck[];
  remainingRisks: string[];
  notes: string[];
}

export interface JobCompletionSummaryArtifactEvidence {
  attempt: number;
  sha256: string;
  baseCommit: string;
}

/** Controller-captured Git evidence; captured paths are not semantic verification. */
export type JobCompletionSummaryChangedFiles =
  | {
      status: 'captured';
      paths: string[];
      artifact: JobCompletionSummaryArtifactEvidence;
    }
  | {
      status: 'unavailable';
      reason: JobCompletionSummaryChangedFilesUnavailableReason;
    };

export type JobCompletionSummaryWorkerReported =
  | {
      status: 'reported';
      report: WorkerCompletionReport;
    }
  | {
      status: 'unavailable';
      reason: WorkerCompletionReportUnavailableReason;
    };

export interface JobCompletionSummary {
  schemaVersion: 1;
  outcome: JobTerminalOutcome;
  attempt: number;
  changedFiles: JobCompletionSummaryChangedFiles;
  workerReported: JobCompletionSummaryWorkerReported;
}

export const WORKSPACE_ISOLATION_MODES = ['none', 'git-worktree'] as const;

export type WorkspaceIsolationMode = (typeof WORKSPACE_ISOLATION_MODES)[number];

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface JobRequest {
  prompt: string;
  workspace: string;
  route?: string;
  /** Free-form caller identity. No controller vendor is privileged by the protocol. */
  source?: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolvedRoute {
  name: string;
  worker: string;
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  requiredEnv: string[];
  maxAttempts: number;
  timeoutMs: number;
}

export interface JobResult {
  output: string;
  attempt: number;
  worker: string;
  provider: string;
  model: string;
  metadata?: Record<string, unknown>;
}

export interface JobError {
  name: string;
  message: string;
  attempt: number;
  retryable: boolean;
}

export type JobEventType =
  | 'job.queued'
  | 'job.started'
  | 'job.retrying'
  | 'job.succeeded'
  | 'job.failed'
  | 'job.cancelled'
  | 'job.artifact'
  | 'job.observer.failed'
  | 'worker.started'
  | 'worker.text.delta'
  | 'worker.tool.started'
  | 'worker.tool.updated'
  | 'worker.tool.completed'
  | 'worker.retry.started'
  | 'worker.retry.completed'
  | 'worker.raw'
  | 'worker.stderr';

export interface JobEvent {
  sequence: number;
  jobId: string;
  at: string;
  type: JobEventType;
  data?: Record<string, unknown>;
}

export interface JobArtifact {
  kind: 'git-patch';
  attempt: number;
  path: string;
  size: number;
  sha256: string;
  baseCommit: string;
  /** Git-derived repository-relative paths; absent only on legacy persisted artifacts. */
  changedFiles?: string[];
}

export const JOB_ARTIFACT_VERIFICATION_ISSUES = [
  'artifact-path-mismatch',
  'artifact-kind-unsupported',
  'artifact-file-missing',
  'artifact-file-unreadable',
  'artifact-size-mismatch',
  'artifact-sha256-mismatch',
  'source-repository-unavailable',
  'base-commit-mismatch',
] as const;

export type JobArtifactVerificationIssue = (typeof JOB_ARTIFACT_VERIFICATION_ISSUES)[number];

export interface JobArtifactVerification {
  artifact: JobArtifact;
  file: {
    exists: boolean;
    expectedSize: number;
    actualSize: number | null;
    sizeMatches: boolean;
    expectedSha256: string;
    actualSha256: string | null;
    sha256Matches: boolean;
  };
  source: {
    repositoryAvailable: boolean;
    expectedBaseCommit: string;
    actualHead: string | null;
    headMatchesBase: boolean;
  };
  issues: JobArtifactVerificationIssue[];
  valid: boolean;
}

export interface JobArtifactList {
  jobId: string;
  artifacts: JobArtifact[];
}

export interface JobArtifactVerificationReport {
  jobId: string;
  artifacts: JobArtifactVerification[];
  valid: boolean;
}

export interface JobArtifactPreview {
  jobId: string;
  artifact: JobArtifact;
  format: 'git-patch';
  encoding: 'utf-8';
  content: string | null;
  truncated: boolean;
  maxBytes: number;
  verification: JobArtifactVerification;
}

export interface JobExecution {
  runtimeId: string;
  pid: number;
  startedAt: string;
}

export interface JobRecord {
  id: string;
  schemaVersion: 1;
  status: JobStatus;
  request: JobRequest;
  route: ResolvedRoute;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  attempt: number;
  events: JobEvent[];
  execution?: JobExecution;
  artifacts?: JobArtifact[];
  result?: JobResult;
  error?: JobError;
  /** Additive terminal evidence; absent on legacy records. */
  completionSummary?: JobCompletionSummary;
  callback?: {
    delivered: boolean;
    status?: number;
    error?: string;
  };
}

export interface WorkerRunInput {
  jobId: string;
  prompt: string;
  workspace: string;
  route: ResolvedRoute;
  attempt: number;
  signal: AbortSignal;
}

export interface WorkerRunResult {
  output: string;
  metadata?: Record<string, unknown>;
  /**
   * Optional structured worker claim; the orchestrator validates it before summarizing.
   * `null` means the worker detected its completion-report envelope but it was malformed or
   * unsupported. Missing (`undefined`) means no envelope was detected.
   */
  completionReport?: WorkerCompletionReport | null;
}

export interface WorkerProbeInput {
  route: ResolvedRoute;
  signal: AbortSignal;
}

export interface WorkerProbeResult {
  output: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerHealth {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export const ROUTE_DIAGNOSTIC_LIVE_STATUSES = [
  'not-checked',
  'succeeded',
  'failed',
  'unsupported',
  'timeout',
  'aborted',
] as const;

export type RouteDiagnosticLiveStatus = (typeof ROUTE_DIAGNOSTIC_LIVE_STATUSES)[number];

export interface RouteDiagnostic extends WorkerHealth {
  route: string;
  liveInference: {
    checked: boolean;
    status: RouteDiagnosticLiveStatus;
  };
}

export type WorkerEventSink = (
  type: Exclude<JobEventType, `job.${string}`>,
  data?: Record<string, unknown>
) => Promise<void> | void;

export interface WorkerAdapter {
  readonly name: string;
  doctor(route: ResolvedRoute): Promise<WorkerHealth>;
  /**
   * Optional one-shot live inference capability used by route diagnostics only.
   * Implementations must honor signal and settle after abort.
   */
  probe?(input: WorkerProbeInput): Promise<WorkerProbeResult>;
  run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult>;
}

export interface JobStore {
  create(job: JobRecord): Promise<void>;
  save(job: JobRecord): Promise<void>;
  get(id: string): Promise<JobRecord | undefined>;
  list(): Promise<JobRecord[]>;
}

export interface StartJobResult {
  job: JobRecord;
  completion: Promise<JobRecord>;
  cancel: () => void;
}

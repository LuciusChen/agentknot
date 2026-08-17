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
  taskOutcome: 'completed' | 'blocked';
  changedFiles: string[];
  checksRun: WorkerCompletionCheck[];
  remainingRisks: string[];
  notes: string[];
}

export interface JobCompletionSummaryArtifactEvidence {
  attempt: number;
  sha256: string;
  baseCommit: string;
  baseTree?: string;
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

export const ROUTE_POOL_STRATEGIES = ['least-active'] as const;

export type RoutePoolStrategy = (typeof ROUTE_POOL_STRATEGIES)[number];

/** Immutable admission evidence for a logical pool target resolved to one concrete route. */
export interface JobRoutePoolSelection {
  pool: string;
  strategy: RoutePoolStrategy;
  candidates: string[];
  selectedRoute: string;
  activeBefore: Record<string, number>;
  cursorBefore: number;
  selectedMemberIndex: number;
  tieBreak: 'rotating-order';
}

export interface JobRequest {
  prompt: string;
  workspace: string;
  route?: string;
  /** Free-form caller identity. No controller vendor is privileged by the protocol. */
  source?: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  /** Exact durable authority for one attempt-scoped read of a recorded AgentKnot artifact. */
  artifactReadGrant?: JobArtifactReadGrant;
  /** Opaque caller key for exactly-once admission of one canonical request. */
  idempotencyKey?: string;
}

export interface JobArtifactReadIdentity {
  kind: 'git-patch';
  attempt: number;
  size: number;
  sha256: string;
  baseCommit: string;
  baseTree?: string;
}

/** Contains logical evidence only; filesystem paths and artifact bytes are never authority. */
export interface JobArtifactReadGrant {
  schemaVersion: 1;
  sourceJobId: string;
  artifact: JobArtifactReadIdentity;
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

export const WORKER_RETRY_SCOPES = ['downstream', 'completion-envelope'] as const;

export type WorkerRetryScope = (typeof WORKER_RETRY_SCOPES)[number];

export interface JobResult {
  output: string;
  /** Present when AgentKnot retained only the bounded UTF-8 prefix of worker output. */
  outputTruncation?: {
    originalBytes: number;
    maxBytes: number;
  };
  attempt: number;
  worker: string;
  provider: string;
  model: string;
  metadata?: Record<string, unknown>;
}

export const JOB_OUTPUT_UNAVAILABLE_REASONS = [
  'job-not-found',
  'subtask-not-found',
  'output-unavailable',
] as const;

export type JobOutputUnavailableReason = (typeof JOB_OUTPUT_UNAVAILABLE_REASONS)[number];

export interface JobOutputReadOptions {
  subtaskId?: string;
  cursor?: number;
  maxBytes?: number;
}

export type JobOutputReadResult =
  | {
      schemaVersion: 1;
      status: 'available';
      jobId: string;
      subtaskId?: string;
      chunk: string;
      cursor: number;
      nextCursor?: number;
      hasMore: boolean;
      totalBytes: number;
      /** Existing persistence-boundary evidence; the reader never truncates durable output. */
      outputTruncation?: JobResult['outputTruncation'];
    }
  | {
      schemaVersion: 1;
      status: 'unavailable';
      jobId: string;
      subtaskId?: string;
      reason: JobOutputUnavailableReason;
    };

export interface WorkerUsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type WorkerUsageUnavailableReason =
  | 'missing'
  | 'timeout'
  | 'unsupported'
  | 'invalid'
  | 'worker-failure';

/** Fixed-shape usage evidence shared by Worker adapters and durable Job attempts. */
export type WorkerUsageEvidence =
  | { tokens: WorkerUsageTokens; cost: number }
  | { unavailableReason: WorkerUsageUnavailableReason };

export interface JobAttemptUsage {
  attempt: number;
  usage: WorkerUsageEvidence;
}

export interface JobError {
  name: string;
  message: string;
  attempt: number;
  retryable: boolean;
}

export type JobEventType =
  | 'job.queued'
  | 'job.capacity.waiting'
  | 'job.started'
  | 'job.attempt.lost'
  | 'job.recovery.started'
  | 'job.retrying'
  | 'job.succeeded'
  | 'job.failed'
  | 'job.cancelled'
  | 'job.artifact'
  | 'job.observer.failed'
  | 'job.worker.events.truncated'
  | 'job.control.requested'
  | 'job.control.accepted'
  | 'job.control.rejected'
  | 'job.control.lost'
  | 'worker.started'
  | 'worker.text.delta'
  | 'worker.tool.started'
  | 'worker.tool.updated'
  | 'worker.tool.completed'
  | 'worker.retry.started'
  | 'worker.retry.completed'
  | 'worker.artifact.read'
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
  /** Exact source tree seen by the worker; absent only on legacy persisted artifacts. */
  baseTree?: string;
  /** Git-derived repository-relative paths; absent only on legacy persisted artifacts. */
  changedFiles?: string[];
}

export const JOB_ARTIFACT_VERIFICATION_ISSUES = [
  'artifact-path-mismatch',
  'artifact-kind-unsupported',
  'artifact-file-missing',
  'artifact-file-unreadable',
  'artifact-size-limit-exceeded',
  'artifact-size-mismatch',
  'artifact-sha256-mismatch',
  'source-repository-unavailable',
  'base-commit-mismatch',
  'base-tree-mismatch',
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
    expectedBaseTree?: string;
    actualTree?: string | null;
    treeMatchesBase?: boolean;
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

/** Immutable admitted source state used to reconstruct an isolated attempt after restart. */
export interface JobWorkspaceSnapshot {
  format: 'git-binary-patch';
  sourceWorkspace: string;
  repository: string;
  relativeSubdirectory: string;
  baseCommit: string;
  baseTree: string;
  size: number;
  sha256: string;
}

export interface JobRecord {
  id: string;
  schemaVersion: 1;
  status: JobStatus;
  request: JobRequest;
  route: ResolvedRoute;
  /** Present only when request.route named a configured route pool. */
  routePoolSelection?: JobRoutePoolSelection;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  attempt: number;
  events: JobEvent[];
  execution?: JobExecution;
  /** Present for git-worktree Jobs admitted after durable restart recovery was introduced. */
  workspaceSnapshot?: JobWorkspaceSnapshot;
  artifacts?: JobArtifact[];
  result?: JobResult;
  /** One fixed-shape downstream-usage observation per completed worker attempt. */
  attemptUsage?: JobAttemptUsage[];
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
  /** Attempt-scoped live control. Omitted when the caller does not provide a control channel. */
  control?: WorkerControlPort;
  /** Attempt-scoped exact artifact reader. Adapters must not expose paths or broader storage. */
  artifactReader?: WorkerArtifactReader;
}

export interface WorkerArtifactReadResult {
  sourceJobId: string;
  artifact: JobArtifactReadIdentity;
  content: string;
}

export interface WorkerArtifactReader {
  read(): Promise<WorkerArtifactReadResult>;
}

export const WORKER_CONTROL_KINDS = ['steer', 'follow-up'] as const;

export type WorkerControlKind = (typeof WORKER_CONTROL_KINDS)[number];

export interface WorkerControlRequest {
  schemaVersion: 1;
  controlId: string;
  attempt: number;
  kind: WorkerControlKind;
  message: string;
}

export const WORKER_CONTROL_RECEIPT_STATUSES = [
  'accepted',
  'unsupported',
  'stale-attempt',
  'adapter-rejected',
  'lost',
] as const;

export type WorkerControlReceiptStatus = (typeof WORKER_CONTROL_RECEIPT_STATUSES)[number];

export interface WorkerControlReceipt {
  schemaVersion: 1;
  jobId: string;
  controlId: string;
  attempt: number;
  kind: WorkerControlKind;
  status: WorkerControlReceiptStatus;
  durable: boolean;
  requestedAt: string;
  settledAt: string;
  reason?: string;
}

export interface WorkerControlCapabilities {
  schemaVersion: 1;
  jobId: string;
  attempt: number;
  state: 'active' | 'inactive';
  ready: boolean;
  kinds: WorkerControlKind[];
}

export interface WorkerControlAdapterRequest {
  controlId: string;
  kind: WorkerControlKind;
  message: string;
}

export type WorkerControlAdapterResult =
  | { accepted: true }
  | { accepted: false; reason: string };

export type WorkerControlHandler = (
  request: WorkerControlAdapterRequest
) => Promise<WorkerControlAdapterResult>;

/** Input-scoped binding; implementations must not keep a global Job-to-process registry. */
export interface WorkerControlPort {
  bind(handler: WorkerControlHandler): () => void;
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

/**
 * The worker session reached a terminal error after its adapter exhausted any in-session recovery it owns.
 * Replaying a fresh worker session inside the same Job would duplicate completed work.
 */
export class WorkerSettledError extends Error {
  readonly name = 'WorkerSettledError';

  constructor(message: string, readonly usage?: WorkerUsageEvidence) {
    super(message);
  }
}

/**
 * The worker transport failed before the adapter observed its first settled session boundary.
 * A later whole-Job attempt may therefore retry the exact admitted route without replaying a
 * session that the worker already settled. An adapter may supply a structured retry delay hint;
 * core bounds that hint before waiting and never derives it from provider error text.
 */
export class WorkerTransientError extends Error {
  readonly name = 'WorkerTransientError';

  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    if (
      retryAfterMs !== undefined &&
      (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)
    ) {
      throw new Error('WorkerTransientError retryAfterMs must be a non-negative safe integer');
    }
  }
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
  /** Optional route-dependent live-control capabilities. Omission means unsupported. */
  controlCapabilities?(route: ResolvedRoute): readonly WorkerControlKind[];
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
  eventsAfter?(id: string, sequence: number): Promise<JobEvent[]>;
  createIdempotent?(
    scope: string,
    key: string,
    requestHash: string,
    job: JobRecord
  ): Promise<{ created: boolean; record: JobRecord }>;
  findIdempotent?(scope: string, key: string): Promise<JobRecord | undefined>;
}

export interface StartJobResult {
  job: JobRecord;
  completion: Promise<JobRecord>;
  cancel: () => Promise<void>;
}

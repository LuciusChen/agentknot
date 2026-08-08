export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

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
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  request: JobRequest;
  route: ResolvedRoute;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  attempt: number;
  events: JobEvent[];
  artifacts?: JobArtifact[];
  result?: JobResult;
  error?: JobError;
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
}

export interface WorkerHealth {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export type WorkerEventSink = (
  type: Exclude<JobEventType, `job.${string}`>,
  data?: Record<string, unknown>
) => Promise<void> | void;

export interface WorkerAdapter {
  readonly name: string;
  doctor(route: ResolvedRoute): Promise<WorkerHealth>;
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

import type { DelegationConfig, DelegationMode } from './config.js';
import type { JobError, JobExecution, JobStatus } from './types.js';

export const ORCHESTRATION_STATUSES = [
  'queued',
  'planning',
  'dispatching',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type OrchestrationStatus = (typeof ORCHESTRATION_STATUSES)[number];

export const ORCHESTRATION_DELEGATION_OVERRIDES = ['inherit', 'never', 'suggest', 'force'] as const;

export type OrchestrationDelegationOverride = (typeof ORCHESTRATION_DELEGATION_OVERRIDES)[number];

export interface OrchestrationRequest {
  prompt: string;
  workspace: string;
  source?: string;
  metadata?: Record<string, unknown>;
  /** May narrow automatic behavior. `force` never bypasses global off mode or keep-upstream policy. */
  delegation?: OrchestrationDelegationOverride;
}

export type TaskComplexity = 'low' | 'medium' | 'high';

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
  route: string;
  executionPrompt: string;
}

export interface DelegationPlan {
  policyVersion: 1;
  planHash: string;
  mode: DelegationMode;
  decision: DelegationDecision;
  willDispatch: boolean;
  reasoning: string;
  assessment: TaskAssessment;
  subtasks: PlannedSubtask[];
  plannerError?: {
    name: string;
    message: string;
    jobId?: string;
  };
}

export const ORCHESTRATION_EVENT_TYPES = [
  'orchestration.queued',
  'orchestration.planning',
  'orchestration.planner.started',
  'orchestration.planner.completed',
  'orchestration.planned',
  'orchestration.dispatching',
  'orchestration.child.started',
  'orchestration.child.completed',
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
  output?: string;
  error?: JobError;
}

export interface OrchestrationResult {
  action: 'upstream' | 'suggested' | 'delegated';
  children: OrchestrationChild[];
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
  /** Immutable effective policy captured before planning begins. */
  policy: DelegationConfig;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelRequestedAt?: string;
  execution: JobExecution;
  events: OrchestrationEvent[];
  plannerJobId?: string;
  plan?: DelegationPlan;
  children: OrchestrationChild[];
  result?: OrchestrationResult;
  error?: OrchestrationError;
}

export interface OrchestrationStore {
  create(record: OrchestrationRecord): Promise<void>;
  save(record: OrchestrationRecord): Promise<void>;
  get(id: string): Promise<OrchestrationRecord | undefined>;
  list(): Promise<OrchestrationRecord[]>;
}

export interface StartOrchestrationResult {
  orchestration: OrchestrationRecord;
  completion: Promise<OrchestrationRecord>;
  cancel: () => Promise<void>;
}

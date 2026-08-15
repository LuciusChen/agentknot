import { randomUUID } from 'node:crypto';

import { assertTextLimit, MAX_PROMPT_BYTES } from './record-limits.js';
import type { JobRecord, JobStore } from './types.js';
import type { WorkOrderStore } from './work-order.js';

/** The artifact identity retained by a Candidate; patch bytes remain owned by the Job artifact. */
export interface CandidateArtifact {
  path: string;
  sha256: string;
  baseCommit: string;
}

/** Compatibility name for callers that treat the retained artifact as a reference. */
export type CandidateArtifactReference = CandidateArtifact;

interface CandidateEventBase {
  sequence: number;
  candidateId: string;
  at: string;
}

export interface CandidateCreatedEvent extends CandidateEventBase {
  type: 'candidate.created';
}

export type CandidateEvent = CandidateCreatedEvent;
export type CandidateEventType = CandidateEvent['type'];

/** Immutable, status-free evidence that one recorded Job artifact is a WorkOrder candidate. */
export interface CandidateRecord {
  id: string;
  schemaVersion: 1;
  workOrderId: string;
  executorJobId: string;
  artifact: CandidateArtifact;
  createdAt: string;
  events: CandidateEvent[];
}

export interface CandidateStore {
  create(record: CandidateRecord): Promise<void>;
  get(id: string): Promise<CandidateRecord | undefined>;
  list(): Promise<CandidateRecord[]>;
  eventsAfter(id: string, sequence: number): Promise<CandidateEvent[]>;
}

export interface CandidateCreateRequest {
  workOrderId: string;
  executorJobId: string;
  artifact: CandidateArtifact;
}

export interface CandidateServiceOptions {
  store: CandidateStore;
  workOrders: Pick<WorkOrderStore, 'get'>;
  jobs: Pick<JobStore, 'get'>;
  now?: () => Date;
}

function assertNonEmptyText(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  assertTextLimit(label, value, MAX_PROMPT_BYTES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeArtifact(value: unknown): CandidateArtifact {
  if (!isRecord(value)) throw new Error('Candidate artifact must be an object');
  assertNonEmptyText('Candidate artifact path', value.path);
  assertNonEmptyText('Candidate artifact sha256', value.sha256);
  assertNonEmptyText('Candidate artifact baseCommit', value.baseCommit);
  return {
    // The managed artifact path is an exact durable reference, not a path to normalize or copy.
    path: value.path,
    sha256: value.sha256,
    baseCommit: value.baseCommit,
  };
}

function normalizeCreateRequest(value: unknown): CandidateCreateRequest {
  if (!isRecord(value)) throw new Error('Candidate creation request must be an object');
  assertNonEmptyText('Candidate workOrderId', value.workOrderId);
  assertNonEmptyText('Candidate executorJobId', value.executorJobId);
  return {
    workOrderId: value.workOrderId,
    executorJobId: value.executorJobId,
    artifact: normalizeArtifact(value.artifact),
  };
}

function hasRecordedArtifact(job: JobRecord, artifact: CandidateArtifact): boolean {
  return (
    job.artifacts?.some(
      (recorded) =>
        recorded.kind === 'git-patch' &&
        recorded.path === artifact.path &&
        recorded.sha256 === artifact.sha256 &&
        recorded.baseCommit === artifact.baseCommit
    ) ?? false
  );
}

/** Domain service for creating immutable candidate evidence without changing source records. */
export class CandidateService {
  readonly #store: CandidateStore;
  readonly #workOrders: Pick<WorkOrderStore, 'get'>;
  readonly #jobs: Pick<JobStore, 'get'>;
  readonly #now: () => Date;

  constructor(options: CandidateServiceOptions) {
    this.#store = options.store;
    this.#workOrders = options.workOrders;
    this.#jobs = options.jobs;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Validates only persisted WorkOrder/Job projections before writing the Candidate projection.
   * Those reads and Candidate persistence are separate stores and are not one cross-store
   * transaction; the method never reads, hashes, copies, or applies artifact bytes.
   */
  async create(request: CandidateCreateRequest): Promise<CandidateRecord> {
    const normalized = normalizeCreateRequest(request);
    const workOrder = await this.#workOrders.get(normalized.workOrderId);
    if (workOrder === undefined) {
      throw new Error(`WorkOrder ${normalized.workOrderId} does not exist`);
    }
    if (workOrder.executorJobId === undefined) {
      throw new Error(`WorkOrder ${normalized.workOrderId} is not bound to an executor Job`);
    }
    if (workOrder.executorJobId !== normalized.executorJobId) {
      throw new Error(
        `WorkOrder ${normalized.workOrderId} is bound to executor Job ${workOrder.executorJobId}, not ${normalized.executorJobId}`
      );
    }

    const job = await this.#jobs.get(normalized.executorJobId);
    if (job === undefined) {
      throw new Error(`Executor Job ${normalized.executorJobId} does not exist`);
    }
    if (!hasRecordedArtifact(job, normalized.artifact)) {
      throw new Error(
        `Candidate artifact ${normalized.artifact.path} is not recorded by executor Job ${normalized.executorJobId}`
      );
    }

    const id = `candidate_${randomUUID()}`;
    const createdAt = this.#now().toISOString();
    const record: CandidateRecord = {
      id,
      schemaVersion: 1,
      workOrderId: normalized.workOrderId,
      executorJobId: normalized.executorJobId,
      artifact: normalized.artifact,
      createdAt,
      events: [
        {
          sequence: 1,
          candidateId: id,
          at: createdAt,
          type: 'candidate.created',
        },
      ],
    };
    await this.#store.create(record);
    return structuredClone(record);
  }

  get(id: string): Promise<CandidateRecord | undefined> {
    return this.#store.get(id);
  }

  list(): Promise<CandidateRecord[]> {
    return this.#store.list();
  }

  eventsAfter(id: string, sequence: number): Promise<CandidateEvent[]> {
    return this.#store.eventsAfter(id, sequence);
  }
}

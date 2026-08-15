import { createHash } from 'node:crypto';

import { assertTextLimit, MAX_PROMPT_BYTES } from './record-limits.js';
import type { CandidateRecord, CandidateStore } from './candidate.js';
import type { ReviewRecord, ReviewStore } from './review.js';

/** Disposition-domain bounds are independent from orchestration review transport limits. */
export const MAX_DISPOSITION_DECIDED_BY_BYTES = 256;
export const MAX_DISPOSITION_RATIONALE_BYTES = 2 * 1024;

export const DISPOSITION_DECISIONS = ['accept', 'discard'] as const;
export type DispositionDecision = (typeof DISPOSITION_DECISIONS)[number];

const DISPOSITION_ID_PREFIX = 'disposition_';

interface DispositionEventBase {
  sequence: number;
  dispositionId: string;
  at: string;
}

export interface DispositionRecordedEvent extends DispositionEventBase {
  type: 'disposition.recorded';
}

export type DispositionEvent = DispositionRecordedEvent;
export type DispositionEventType = DispositionEvent['type'];

/** The controller's immutable final decision over one Candidate, without artifact mutation. */
export interface DispositionRecord {
  id: string;
  schemaVersion: 1;
  candidateId: string;
  reviewId: string;
  decision: DispositionDecision;
  decidedBy: string;
  rationale: string;
  createdAt: string;
  events: DispositionEvent[];
}

export interface DispositionStore {
  create(record: DispositionRecord): Promise<void>;
  get(id: string): Promise<DispositionRecord | undefined>;
  getForCandidate(candidateId: string): Promise<DispositionRecord | undefined>;
  list(): Promise<DispositionRecord[]>;
  eventsAfter(id: string, sequence: number): Promise<DispositionEvent[]>;
}

export interface DispositionCreateRequest {
  candidateId: string;
  reviewId: string;
  decision: DispositionDecision;
  decidedBy: string;
  rationale: string;
}

/** Compatibility name for callers that describe recording as a request rather than creation. */
export type DispositionRequest = DispositionCreateRequest;

export interface DispositionServiceOptions {
  store: DispositionStore;
  candidates: Pick<CandidateStore, 'get'>;
  reviews: Pick<ReviewStore, 'get'>;
  now?: () => Date;
}

/** A conflicting final decision cannot replace the first immutable disposition. */
export class DispositionConflictError extends Error {
  readonly name = 'DispositionConflictError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function assertBoundedNonEmptyText(
  label: string,
  value: unknown,
  maxBytes: number
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  assertTextLimit(label, value, maxBytes);
}

function normalizeCreateRequest(value: unknown): DispositionCreateRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['candidateId', 'reviewId', 'decision', 'decidedBy', 'rationale'])
  ) {
    throw new Error(
      'Disposition creation request must contain only candidateId, reviewId, decision, decidedBy, and rationale'
    );
  }
  assertBoundedNonEmptyText('Disposition candidateId', value.candidateId, MAX_PROMPT_BYTES);
  assertBoundedNonEmptyText('Disposition reviewId', value.reviewId, MAX_PROMPT_BYTES);
  if (!DISPOSITION_DECISIONS.includes(value.decision as DispositionDecision)) {
    throw new Error('Disposition decision must be accept or discard');
  }
  assertBoundedNonEmptyText(
    'Disposition decidedBy',
    value.decidedBy,
    MAX_DISPOSITION_DECIDED_BY_BYTES
  );
  assertBoundedNonEmptyText(
    'Disposition rationale',
    value.rationale,
    MAX_DISPOSITION_RATIONALE_BYTES
  );
  return {
    candidateId: value.candidateId,
    reviewId: value.reviewId,
    decision: value.decision as DispositionDecision,
    decidedBy: value.decidedBy,
    rationale: value.rationale,
  };
}

/** Returns the one fixed-length durable identity reserved for a Candidate's disposition. */
export function dispositionIdForCandidate(candidateId: string): string {
  return `${DISPOSITION_ID_PREFIX}${createHash('sha256').update(candidateId, 'utf8').digest('hex')}`;
}

function hasSameSemanticInput(
  record: DispositionRecord,
  request: DispositionCreateRequest
): boolean {
  return (
    record.candidateId === request.candidateId &&
    record.reviewId === request.reviewId &&
    record.decision === request.decision &&
    record.decidedBy === request.decidedBy &&
    record.rationale === request.rationale
  );
}

/** Domain service for recording one immutable controller disposition without changing its sources. */
export class DispositionService {
  readonly #store: DispositionStore;
  readonly #candidates: Pick<CandidateStore, 'get'>;
  readonly #reviews: Pick<ReviewStore, 'get'>;
  readonly #now: () => Date;

  constructor(options: DispositionServiceOptions) {
    this.#store = options.store;
    this.#candidates = options.candidates;
    this.#reviews = options.reviews;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Validates only the existing Candidate and its named Review before writing the Disposition
   * projection. Those reads and Disposition persistence are separate stores and are not one
   * cross-store transaction; this method never changes either source record or any artifact.
   */
  async record(request: DispositionCreateRequest): Promise<DispositionRecord> {
    const normalized = normalizeCreateRequest(request);
    const candidate: CandidateRecord | undefined = await this.#candidates.get(
      normalized.candidateId
    );
    if (candidate === undefined) {
      throw new Error(`Candidate ${normalized.candidateId} does not exist`);
    }

    const review: ReviewRecord | undefined = await this.#reviews.get(normalized.reviewId);
    if (review === undefined) {
      throw new Error(`Review ${normalized.reviewId} does not exist`);
    }
    if (review.candidateId !== normalized.candidateId) {
      throw new Error(
        `Review ${normalized.reviewId} belongs to Candidate ${review.candidateId}, not ${normalized.candidateId}`
      );
    }

    const id = dispositionIdForCandidate(normalized.candidateId);
    const createdAt = this.#now().toISOString();
    const record: DispositionRecord = {
      id,
      schemaVersion: 1,
      candidateId: normalized.candidateId,
      reviewId: normalized.reviewId,
      decision: normalized.decision,
      decidedBy: normalized.decidedBy,
      rationale: normalized.rationale,
      createdAt,
      events: [
        {
          sequence: 1,
          dispositionId: id,
          at: createdAt,
          type: 'disposition.recorded',
        },
      ],
    };

    try {
      await this.#store.create(record);
      return structuredClone(record);
    } catch (error) {
      // The durable store owns atomic identity/event creation but not domain conflict errors.
      // Re-read the deterministic identity after a create race and classify the committed record
      // here, without making the generic persistence layer depend on this domain.
      let existing: DispositionRecord | undefined;
      try {
        existing = await this.#store.get(id);
      } catch {
        throw error;
      }
      if (existing === undefined) throw error;
      if (hasSameSemanticInput(existing, normalized)) return structuredClone(existing);
      throw new DispositionConflictError(
        `Disposition conflict for Candidate ${normalized.candidateId}: an existing record has different decision inputs`,
        { cause: error }
      );
    }
  }

  /** Compatibility alias for callers using the other immutable-domain creation APIs. */
  create(request: DispositionCreateRequest): Promise<DispositionRecord> {
    return this.record(request);
  }

  async get(id: string): Promise<DispositionRecord | undefined> {
    const record = await this.#store.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  async getForCandidate(candidateId: string): Promise<DispositionRecord | undefined> {
    const record = await this.#store.getForCandidate(candidateId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async list(): Promise<DispositionRecord[]> {
    return structuredClone(await this.#store.list());
  }

  async eventsAfter(id: string, sequence: number): Promise<DispositionEvent[]> {
    return structuredClone(await this.#store.eventsAfter(id, sequence));
  }
}

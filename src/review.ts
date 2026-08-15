import { randomUUID } from 'node:crypto';

import { assertTextLimit, MAX_PROMPT_BYTES } from './record-limits.js';
import type { CandidateRecord, CandidateStore } from './candidate.js';

/** Review-domain bounds are independent from orchestration quality-review transport limits. */
export const MAX_REVIEWER_IDENTITY_BYTES = 256;
export const MAX_REVIEW_SUMMARY_BYTES = 2 * 1024;
export const MAX_REVIEW_FINDINGS = 10;
export const MAX_REVIEW_FINDING_MESSAGE_BYTES = 1024;
export const MAX_REVIEW_FINDING_EVIDENCE_BYTES = 1024;

export const REVIEW_FINDING_SEVERITIES = ['low', 'medium', 'high'] as const;
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

export interface ReviewFinding {
  severity: ReviewFindingSeverity;
  message: string;
  evidence: string;
}

interface ReviewEventBase {
  sequence: number;
  reviewId: string;
  at: string;
}

export interface ReviewCreatedEvent extends ReviewEventBase {
  type: 'review.created';
}

export type ReviewEvent = ReviewCreatedEvent;
export type ReviewEventType = ReviewEvent['type'];

/** Immutable, status-free domain evidence about one Candidate. */
export interface ReviewRecord {
  id: string;
  schemaVersion: 1;
  candidateId: string;
  reviewer: string;
  summary: string;
  findings: ReviewFinding[];
  createdAt: string;
  events: ReviewEvent[];
}

export interface ReviewStore {
  create(record: ReviewRecord): Promise<void>;
  get(id: string): Promise<ReviewRecord | undefined>;
  list(): Promise<ReviewRecord[]>;
  eventsAfter(id: string, sequence: number): Promise<ReviewEvent[]>;
}

export interface ReviewCreateRequest {
  candidateId: string;
  reviewer: string;
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewServiceOptions {
  store: ReviewStore;
  candidates: Pick<CandidateStore, 'get'>;
  now?: () => Date;
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

function normalizeFinding(value: unknown, index: number): ReviewFinding {
  if (!isRecord(value) || !hasExactKeys(value, ['severity', 'message', 'evidence'])) {
    throw new Error(
      `Review findings[${index}] must contain only severity, message, and evidence`
    );
  }
  if (!REVIEW_FINDING_SEVERITIES.includes(value.severity as ReviewFindingSeverity)) {
    throw new Error(`Review findings[${index}].severity must be low, medium, or high`);
  }
  assertBoundedNonEmptyText(
    `Review findings[${index}].message`,
    value.message,
    MAX_REVIEW_FINDING_MESSAGE_BYTES
  );
  assertBoundedNonEmptyText(
    `Review findings[${index}].evidence`,
    value.evidence,
    MAX_REVIEW_FINDING_EVIDENCE_BYTES
  );
  return {
    severity: value.severity as ReviewFindingSeverity,
    message: value.message,
    evidence: value.evidence,
  };
}

function normalizeCreateRequest(value: unknown): ReviewCreateRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['candidateId', 'reviewer', 'summary', 'findings'])) {
    throw new Error(
      'Review creation request must contain only candidateId, reviewer, summary, and findings'
    );
  }
  assertBoundedNonEmptyText('Review candidateId', value.candidateId, MAX_PROMPT_BYTES);
  assertBoundedNonEmptyText('Review reviewer', value.reviewer, MAX_REVIEWER_IDENTITY_BYTES);
  assertBoundedNonEmptyText('Review summary', value.summary, MAX_REVIEW_SUMMARY_BYTES);
  if (!Array.isArray(value.findings)) {
    throw new Error('Review findings must be an array');
  }
  if (value.findings.length > MAX_REVIEW_FINDINGS) {
    throw new Error(`Review findings must contain at most ${MAX_REVIEW_FINDINGS} entries`);
  }
  return {
    candidateId: value.candidateId,
    reviewer: value.reviewer,
    summary: value.summary,
    findings: Array.from(value.findings, (finding, index) => normalizeFinding(finding, index)),
  };
}

/** Domain service for creating immutable Review evidence without changing its Candidate source. */
export class ReviewService {
  readonly #store: ReviewStore;
  readonly #candidates: Pick<CandidateStore, 'get'>;
  readonly #now: () => Date;

  constructor(options: ReviewServiceOptions) {
    this.#store = options.store;
    this.#candidates = options.candidates;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Validates only that the linked Candidate projection exists before writing the Review
   * projection. Candidate validation and Review persistence are separate stores and are not one
   * cross-store transaction; this method never changes the Candidate or any execution record.
   */
  async create(request: ReviewCreateRequest): Promise<ReviewRecord> {
    const normalized = normalizeCreateRequest(request);
    const candidate: CandidateRecord | undefined = await this.#candidates.get(
      normalized.candidateId
    );
    if (candidate === undefined) {
      throw new Error(`Candidate ${normalized.candidateId} does not exist`);
    }

    const id = `review_${randomUUID()}`;
    const createdAt = this.#now().toISOString();
    const record: ReviewRecord = {
      id,
      schemaVersion: 1,
      candidateId: normalized.candidateId,
      reviewer: normalized.reviewer,
      summary: normalized.summary,
      findings: normalized.findings,
      createdAt,
      events: [
        {
          sequence: 1,
          reviewId: id,
          at: createdAt,
          type: 'review.created',
        },
      ],
    };
    await this.#store.create(record);
    return structuredClone(record);
  }

  async get(id: string): Promise<ReviewRecord | undefined> {
    const record = await this.#store.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  async list(): Promise<ReviewRecord[]> {
    return structuredClone(await this.#store.list());
  }

  async eventsAfter(id: string, sequence: number): Promise<ReviewEvent[]> {
    return structuredClone(await this.#store.eventsAfter(id, sequence));
  }
}

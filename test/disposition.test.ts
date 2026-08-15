import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DISPOSITION_DECISIONS,
  DispositionConflictError,
  DispositionService,
  MAX_DISPOSITION_DECIDED_BY_BYTES,
  MAX_DISPOSITION_RATIONALE_BYTES,
  SqliteCandidateStore,
  SqliteDispositionStore,
  SqliteDurableRecordStore,
  SqliteReviewStore,
  dispositionIdForCandidate,
  type CandidateRecord,
  type DispositionCreateRequest,
  type DispositionRecord,
  type ReviewRecord,
} from '../src/index.js';

const CREATED_AT = new Date('2026-08-15T01:02:03.000Z');

function candidate(id: string): CandidateRecord {
  const at = CREATED_AT.toISOString();
  return {
    id,
    schemaVersion: 1,
    workOrderId: `work_order_${id}`,
    executorJobId: `job_${id}`,
    artifact: {
      path: `/tmp/agentknot-artifacts/${id}/attempt-1.patch`,
      sha256: 'a'.repeat(64),
      baseCommit: 'b'.repeat(40),
    },
    createdAt: at,
    events: [
      {
        sequence: 1,
        candidateId: id,
        at,
        type: 'candidate.created',
      },
    ],
  };
}

function review(id: string, candidateId: string): ReviewRecord {
  const at = CREATED_AT.toISOString();
  return {
    id,
    schemaVersion: 1,
    candidateId,
    reviewer: 'controller:reviewer-1',
    summary: 'The review evidence is bounded.',
    findings: [],
    createdAt: at,
    events: [
      {
        sequence: 1,
        reviewId: id,
        at,
        type: 'review.created',
      },
    ],
  };
}

async function withFixture(
  run: (fixture: {
    candidates: SqliteCandidateStore;
    reviews: SqliteReviewStore;
    dispositions: SqliteDispositionStore;
    candidate: CandidateRecord;
    otherCandidate: CandidateRecord;
    review: ReviewRecord;
    alternateReview: ReviewRecord;
    otherReview: ReviewRecord;
  }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-disposition-'));
  const candidates = await SqliteCandidateStore.open(path.join(directory, 'candidates'));
  const reviews = await SqliteReviewStore.open(path.join(directory, 'reviews'));
  const dispositions = await SqliteDispositionStore.open(path.join(directory, 'dispositions'));
  const existingCandidate = candidate('candidate_existing');
  const existingOtherCandidate = candidate('candidate_other');
  const existingReview = review('review_existing', existingCandidate.id);
  const existingAlternateReview = review('review_alternate', existingCandidate.id);
  const existingOtherReview = review('review_other', existingOtherCandidate.id);
  try {
    await candidates.create(structuredClone(existingCandidate));
    await candidates.create(structuredClone(existingOtherCandidate));
    await reviews.create(structuredClone(existingReview));
    await reviews.create(structuredClone(existingAlternateReview));
    await reviews.create(structuredClone(existingOtherReview));
    await run({
      candidates,
      reviews,
      dispositions,
      candidate: structuredClone(existingCandidate),
      otherCandidate: structuredClone(existingOtherCandidate),
      review: structuredClone(existingReview),
      alternateReview: structuredClone(existingAlternateReview),
      otherReview: structuredClone(existingOtherReview),
    });
  } finally {
    await Promise.all([dispositions.close(), reviews.close(), candidates.close()]);
    await rm(directory, { recursive: true, force: true });
  }
}

function service(fixture: {
  candidates: SqliteCandidateStore;
  reviews: SqliteReviewStore;
  dispositions: SqliteDispositionStore;
}): DispositionService {
  return new DispositionService({
    store: fixture.dispositions,
    candidates: fixture.candidates,
    reviews: fixture.reviews,
    now: () => CREATED_AT,
  });
}

function request(
  candidateId: string,
  reviewId: string,
  overrides: Partial<DispositionCreateRequest> = {}
): DispositionCreateRequest {
  return {
    candidateId,
    reviewId,
    decision: 'accept',
    decidedBy: 'controller:owner-1',
    rationale: 'The reviewed candidate satisfies the recorded acceptance criteria.',
    ...overrides,
  };
}

test('records accept and discard as immutable status-free dispositions with one event', async () => {
  await withFixture(async (fixture) => {
    const accepted = await service(fixture).record(
      request(fixture.candidate.id, fixture.review.id)
    );
    const discarded = await service(fixture).create(
      request(fixture.otherCandidate.id, fixture.otherReview.id, {
        decision: 'discard',
        rationale: 'The reviewed candidate does not satisfy the recorded criteria.',
      })
    );

    assert.equal(accepted.id, dispositionIdForCandidate(fixture.candidate.id));
    assert.equal(dispositionIdForCandidate(fixture.candidate.id).length, 76);
    assert.equal(dispositionIdForCandidate('x').length, accepted.id.length);
    assert.notEqual(dispositionIdForCandidate(fixture.candidate.id), dispositionIdForCandidate('x'));
    assert.notEqual(accepted.id, discarded.id);
    assert.equal(accepted.schemaVersion, 1);
    assert.equal(accepted.candidateId, fixture.candidate.id);
    assert.equal(accepted.reviewId, fixture.review.id);
    assert.equal(accepted.decision, 'accept');
    assert.equal(accepted.decidedBy, 'controller:owner-1');
    assert.equal('status' in accepted, false);
    assert.equal('updatedAt' in accepted, false);
    assert.deepEqual(accepted.events, [
      {
        sequence: 1,
        dispositionId: accepted.id,
        at: CREATED_AT.toISOString(),
        type: 'disposition.recorded',
      },
    ]);
    assert.equal(discarded.decision, 'discard');
    assert.equal(discarded.events.length, 1);
    assert.deepEqual(await service(fixture).getForCandidate(fixture.candidate.id), accepted);
    const listed = await service(fixture).list();
    assert.equal(listed.length, 2);
    assert.deepEqual(new Set(listed.map((record) => record.id)), new Set([accepted.id, discarded.id]));
    assert.deepEqual(await service(fixture).eventsAfter(accepted.id, 0), accepted.events);
    assert.deepEqual(await service(fixture).eventsAfter(accepted.id, 1), []);
    assert.deepEqual(DISPOSITION_DECISIONS, ['accept', 'discard']);
  });
});

test('exact semantic replay is idempotent and appends no second event', async () => {
  await withFixture(async (fixture) => {
    const first = await service(fixture).record(request(fixture.candidate.id, fixture.review.id));
    const replayed = await service(fixture).record(request(fixture.candidate.id, fixture.review.id));

    assert.deepEqual(replayed, first);
    assert.equal((await fixture.dispositions.list()).length, 1);
    assert.deepEqual(await fixture.dispositions.eventsAfter(first.id, 0), first.events);
    assert.deepEqual(await fixture.dispositions.getForCandidate(fixture.candidate.id), first);
  });
});

test('different review or decision inputs conflict without replacing the first disposition', async () => {
  await withFixture(async (fixture) => {
    const first = await service(fixture).record(request(fixture.candidate.id, fixture.review.id));
    const variants: Array<Partial<DispositionCreateRequest>> = [
      { reviewId: fixture.alternateReview.id },
      { decision: 'discard' },
      { decidedBy: 'controller:other-owner' },
      { rationale: 'A different final rationale.' },
    ];

    for (const variant of variants) {
      await assert.rejects(
        service(fixture).record(request(fixture.candidate.id, fixture.review.id, variant)),
        DispositionConflictError
      );
    }
    assert.deepEqual(await service(fixture).getForCandidate(fixture.candidate.id), first);
    assert.deepEqual(await service(fixture).eventsAfter(first.id, 0), first.events);
  });
});

test('concurrent different dispositions through independent stores yield one success and one conflict', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-disposition-concurrent-'));
  const candidates = await SqliteCandidateStore.open(path.join(directory, 'candidates'));
  const reviews = await SqliteReviewStore.open(path.join(directory, 'reviews'));
  const firstStore = await SqliteDispositionStore.open(path.join(directory, 'dispositions'));
  const secondStore = await SqliteDispositionStore.open(
    path.join(directory, 'dispositions'),
    { readOnly: false }
  );
  const existingCandidate = candidate('candidate_concurrent');
  const existingReview = review('review_concurrent', existingCandidate.id);
  try {
    await candidates.create(structuredClone(existingCandidate));
    await reviews.create(structuredClone(existingReview));
    const first = new DispositionService({
      store: firstStore,
      candidates,
      reviews,
      now: () => CREATED_AT,
    });
    const second = new DispositionService({
      store: secondStore,
      candidates,
      reviews,
      now: () => new Date(CREATED_AT.getTime() + 1),
    });

    const results = await Promise.allSettled([
      first.record(request(existingCandidate.id, existingReview.id)),
      second.record(
        request(existingCandidate.id, existingReview.id, {
          decision: 'discard',
          rationale: 'A concurrent controller recorded a different decision.',
        })
      ),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.ok(rejected.reason instanceof DispositionConflictError);

    const persisted = await first.getForCandidate(existingCandidate.id);
    assert.ok(persisted);
    assert.equal(persisted.events.length, 1);
    assert.ok(persisted.decision === 'accept' || persisted.decision === 'discard');
  } finally {
    await Promise.all([firstStore.close(), secondStore.close(), reviews.close(), candidates.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('creation rejects missing and mismatched references without writing a Disposition', async () => {
  await withFixture(async (fixture) => {
    const dispositionService = service(fixture);
    await assert.rejects(
      dispositionService.record(request('candidate_missing', fixture.review.id)),
      /Candidate candidate_missing does not exist/
    );
    await assert.rejects(
      dispositionService.record(request(fixture.candidate.id, 'review_missing')),
      /Review review_missing does not exist/
    );
    await assert.rejects(
      dispositionService.record(request(fixture.candidate.id, fixture.otherReview.id)),
      /Review review_other belongs to Candidate candidate_other, not candidate_existing/
    );
    assert.deepEqual(await fixture.dispositions.list(), []);
  });
});

test('Disposition records and source records survive restart without mutation', async () => {
  await withFixture(async (fixture) => {
    const beforeCandidate = await fixture.candidates.get(fixture.candidate.id);
    const beforeReview = await fixture.reviews.get(fixture.review.id);
    assert.ok(beforeCandidate && beforeReview);
    const created = await service(fixture).record(
      request(fixture.candidate.id, fixture.review.id)
    );
    const directory = fixture.dispositions.directory;
    await fixture.dispositions.close();

    assert.deepEqual(await fixture.candidates.get(fixture.candidate.id), beforeCandidate);
    assert.deepEqual(await fixture.reviews.get(fixture.review.id), beforeReview);
    assert.deepEqual(await fixture.candidates.eventsAfter(fixture.candidate.id, 0), beforeCandidate.events);
    assert.deepEqual(await fixture.reviews.eventsAfter(fixture.review.id, 0), beforeReview.events);

    const reopened = await SqliteDispositionStore.open(directory);
    try {
      assert.deepEqual(await reopened.get(created.id), created);
      assert.deepEqual(await reopened.getForCandidate(fixture.candidate.id), created);
      assert.deepEqual(await reopened.list(), [created]);
      assert.deepEqual(await reopened.eventsAfter(created.id, 0), created.events);
    } finally {
      await reopened.close();
    }
  });
});

test('service and store reads defensively copy input, records, and event results', async () => {
  await withFixture(async (fixture) => {
    const input = request(fixture.candidate.id, fixture.review.id);
    const created = await service(fixture).record(input);
    const original = structuredClone(created);

    input.decidedBy = 'mutated-input';
    input.rationale = 'mutated-input-rationale';
    created.rationale = 'mutated-returned-record';
    created.events[0]!.dispositionId = 'disposition_mutated';

    const loaded = await service(fixture).get(created.id);
    assert.ok(loaded);
    assert.deepEqual(loaded, original);

    const direct = await fixture.dispositions.get(created.id);
    assert.ok(direct);
    direct.rationale = 'mutated-direct-read';
    const listed = await service(fixture).list();
    listed[0]!.decidedBy = 'mutated-list-read';
    const events = await service(fixture).eventsAfter(created.id, 0);
    events[0]!.dispositionId = 'mutated-event-read';

    assert.deepEqual(await service(fixture).getForCandidate(fixture.candidate.id), original);
    assert.deepEqual(await service(fixture).get(created.id), original);
    assert.deepEqual(await service(fixture).eventsAfter(created.id, 0), original.events);
    assert.deepEqual(await fixture.candidates.get(fixture.candidate.id), fixture.candidate);
    assert.deepEqual(await fixture.reviews.get(fixture.review.id), fixture.review);
  });
});

test('strict bounded disposition input is rejected before persistence', async () => {
  await withFixture(async (fixture) => {
    const dispositionService = service(fixture);
    const valid = request(fixture.candidate.id, fixture.review.id);
    const invalid: Array<[DispositionCreateRequest, RegExp]> = [
      [{ ...valid, decidedBy: '' }, /Disposition decidedBy must be a non-empty string/],
      [{ ...valid, rationale: '   ' }, /Disposition rationale must be a non-empty string/],
      [
        { ...valid, decidedBy: 'x'.repeat(MAX_DISPOSITION_DECIDED_BY_BYTES + 1) },
        /Disposition decidedBy is .* bytes; maximum is/,
      ],
      [
        { ...valid, rationale: 'x'.repeat(MAX_DISPOSITION_RATIONALE_BYTES + 1) },
        /Disposition rationale is .* bytes; maximum is/,
      ],
      [{ ...valid, decision: 'unknown' as DispositionCreateRequest['decision'] }, /Disposition decision must be accept or discard/],
      [{ ...valid, disposition: 'unexpected' } as DispositionCreateRequest, /Disposition creation request must contain only/],
      [{ ...valid, candidateId: '' }, /Disposition candidateId must be a non-empty string/],
      [{ ...valid, reviewId: '' }, /Disposition reviewId must be a non-empty string/],
    ];

    for (const [invalidRequest, expected] of invalid) {
      await assert.rejects(dispositionService.record(invalidRequest), expected);
    }
    assert.deepEqual(await fixture.dispositions.list(), []);
    assert.deepEqual(await fixture.candidates.get(fixture.candidate.id), fixture.candidate);
    assert.deepEqual(await fixture.reviews.get(fixture.review.id), fixture.review);
  });
});

test('Disposition persistence rejects general save, unsupported versions, and duplicate create atomically', async () => {
  await withFixture(async (fixture) => {
    const created = await service(fixture).record(request(fixture.candidate.id, fixture.review.id));
    const raw = await SqliteDurableRecordStore.open<DispositionRecord>(
      'Disposition',
      fixture.dispositions.directory
    );
    try {
      const loaded = await raw.get(created.id);
      assert.ok(loaded);
      await assert.rejects(
        raw.save(loaded),
        /Disposition records do not support general save after creation/
      );
      await assert.rejects(raw.create(structuredClone(loaded)), /UNIQUE constraint failed: records\.id/);
      assert.deepEqual(await raw.get(created.id), created);
      assert.deepEqual(await raw.eventsAfter(created.id, 0), created.events);

      const invalid: DispositionRecord = {
        ...created,
        id: 'disposition_future',
        schemaVersion: 2 as 1,
      };
      await assert.rejects(raw.create(invalid), /Unsupported Disposition schemaVersion 2/);
      assert.equal(await raw.get(invalid.id), undefined);
      assert.deepEqual(await raw.get(created.id), created);
    } finally {
      await raw.close();
    }
  });
});

test('Disposition store rejects a non-Candidate-derived identity before persistence', async () => {
  await withFixture(async (fixture) => {
    const id = 'disposition_not-derived-from-candidate';
    const record: DispositionRecord = {
      id,
      schemaVersion: 1,
      candidateId: fixture.candidate.id,
      reviewId: fixture.review.id,
      decision: 'accept',
      decidedBy: 'controller:owner-1',
      rationale: 'This malformed persistence input must not bypass finality.',
      createdAt: CREATED_AT.toISOString(),
      events: [
        {
          sequence: 1,
          dispositionId: id,
          at: CREATED_AT.toISOString(),
          type: 'disposition.recorded',
        },
      ],
    };

    await assert.rejects(
      fixture.dispositions.create(record),
      /must equal the Candidate-derived identity/
    );
    assert.equal(await fixture.dispositions.get(id), undefined);
    assert.deepEqual(await fixture.dispositions.eventsAfter(id, 0), []);
    assert.deepEqual(await fixture.dispositions.list(), []);
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_REVIEW_FINDING_EVIDENCE_BYTES,
  MAX_REVIEW_FINDING_MESSAGE_BYTES,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_SUMMARY_BYTES,
  MAX_REVIEWER_IDENTITY_BYTES,
  REVIEW_FINDING_SEVERITIES,
  SqliteCandidateStore,
  SqliteDurableRecordStore,
  SqliteReviewStore,
  ReviewService,
  type CandidateRecord,
  type ReviewCreateRequest,
  type ReviewFinding,
  type ReviewRecord,
} from '../src/index.js';

const CREATED_AT = new Date('2026-08-14T02:03:04.000Z');
const CANDIDATE: CandidateRecord = {
  id: 'candidate_existing',
  schemaVersion: 1,
  workOrderId: 'work_order_existing',
  executorJobId: 'job_existing',
  artifact: {
    path: '/tmp/agentknot-artifacts/job_existing/attempt-1.patch',
    sha256: 'a'.repeat(64),
    baseCommit: 'b'.repeat(40),
  },
  createdAt: CREATED_AT.toISOString(),
  events: [
    {
      sequence: 1,
      candidateId: 'candidate_existing',
      at: CREATED_AT.toISOString(),
      type: 'candidate.created',
    },
  ],
};

const FINDINGS: ReviewFinding[] = [
  {
    severity: 'low',
    message: 'The naming could be clearer.',
    evidence: 'The exported identifier is abbreviated.',
  },
  {
    severity: 'medium',
    message: 'One boundary case is not covered.',
    evidence: 'The acceptance criteria do not mention an empty input.',
  },
  {
    severity: 'high',
    message: 'The patch changes an unrelated behavior.',
    evidence: 'The diff modifies a caller outside the requested scope.',
  },
];

async function withFixture(
  run: (fixture: {
    candidates: SqliteCandidateStore;
    reviews: SqliteReviewStore;
    candidate: CandidateRecord;
  }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-review-'));
  const candidates = await SqliteCandidateStore.open(path.join(directory, 'candidates'));
  const reviews = await SqliteReviewStore.open(path.join(directory, 'reviews'));
  try {
    await candidates.create(structuredClone(CANDIDATE));
    await run({ candidates, reviews, candidate: structuredClone(CANDIDATE) });
  } finally {
    await Promise.all([reviews.close(), candidates.close()]);
    await rm(directory, { recursive: true, force: true });
  }
}

function service(fixture: {
  candidates: SqliteCandidateStore;
  reviews: SqliteReviewStore;
}): ReviewService {
  return new ReviewService({
    store: fixture.reviews,
    candidates: fixture.candidates,
    now: () => CREATED_AT,
  });
}

function request(overrides: Partial<ReviewCreateRequest> = {}): ReviewCreateRequest {
  return {
    candidateId: CANDIDATE.id,
    reviewer: 'controller:reviewer-1',
    summary: 'The candidate is within the requested scope.',
    findings: structuredClone(FINDINGS),
    ...overrides,
  };
}

test('creates and reads one immutable status-free ReviewRecord with its creation event', async () => {
  await withFixture(async (fixture) => {
    const created = await service(fixture).create(request());

    assert.match(created.id, /^review_[0-9a-f-]{36}$/);
    assert.equal(created.schemaVersion, 1);
    assert.equal(created.candidateId, CANDIDATE.id);
    assert.equal(created.reviewer, 'controller:reviewer-1');
    assert.equal(created.summary, 'The candidate is within the requested scope.');
    assert.deepEqual(created.findings, FINDINGS);
    assert.equal(created.createdAt, CREATED_AT.toISOString());
    assert.equal('status' in created, false);
    assert.equal('updatedAt' in created, false);
    assert.equal('verdict' in created, false);
    assert.equal('recommendation' in created, false);
    assert.equal('accepted' in created, false);
    assert.equal('discarded' in created, false);
    assert.deepEqual(created.events, [
      {
        sequence: 1,
        reviewId: created.id,
        at: CREATED_AT.toISOString(),
        type: 'review.created',
      },
    ]);
    assert.deepEqual(await service(fixture).get(created.id), created);
    assert.deepEqual(await service(fixture).list(), [created]);
    assert.deepEqual(await service(fixture).eventsAfter(created.id, 0), created.events);
  });
});

test('ReviewRecord and its event survive a SQLite restart', async () => {
  await withFixture(async (fixture) => {
    const created = await service(fixture).create(request());
    const directory = fixture.reviews.directory;
    await fixture.reviews.close();

    const reopened = await SqliteReviewStore.open(directory);
    try {
      assert.deepEqual(await reopened.get(created.id), created);
      assert.deepEqual(await reopened.list(), [created]);
      assert.deepEqual(await reopened.eventsAfter(created.id, 0), created.events);
    } finally {
      await reopened.close();
    }
  });
});

test('ReviewService defensively copies findings and returned read values', async () => {
  await withFixture(async (fixture) => {
    const input = request();
    const created = await service(fixture).create(input);
    const originalEvents = structuredClone(created.events);

    input.reviewer = 'mutated-reviewer';
    input.findings[0]!.message = 'mutated input';
    created.findings[0]!.evidence = 'mutated returned record';
    created.events[0]!.reviewId = 'review_mutated';

    const loaded = await service(fixture).get(created.id);
    assert.ok(loaded);
    assert.equal(loaded.reviewer, 'controller:reviewer-1');
    assert.deepEqual(loaded.findings, FINDINGS);
    assert.equal(loaded.events[0]?.reviewId, created.id);

    const listed = await service(fixture).list();
    listed[0]!.findings[1]!.message = 'mutated list result';
    const afterListMutation = await service(fixture).get(created.id);
    assert.ok(afterListMutation);
    assert.equal(afterListMutation.findings[1]?.message, FINDINGS[1]?.message);

    const events = await service(fixture).eventsAfter(created.id, 0);
    events[0]!.reviewId = 'mutated event result';
    assert.deepEqual(await service(fixture).eventsAfter(created.id, 0), originalEvents);
  });
});

test('ReviewService rejects a missing Candidate without creating a Review', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-review-missing-'));
  const candidates = await SqliteCandidateStore.open(path.join(directory, 'candidates'));
  const reviews = await SqliteReviewStore.open(path.join(directory, 'reviews'));
  try {
    const reviewService = service({ candidates, reviews });
    await assert.rejects(
      reviewService.create(request({ candidateId: 'candidate_missing' })),
      /Candidate candidate_missing does not exist/
    );
    assert.deepEqual(await reviews.list(), []);
  } finally {
    await Promise.all([reviews.close(), candidates.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('ReviewService enforces bounded and invalid review input', async () => {
  await withFixture(async (fixture) => {
    const reviewService = service(fixture);
    const invalidRequests: Array<[ReviewCreateRequest, RegExp]> = [
      [request({ reviewer: '' }), /Review reviewer must be a non-empty string/],
      [request({ summary: '   ' }), /Review summary must be a non-empty string/],
      [
        request({ reviewer: 'x'.repeat(MAX_REVIEWER_IDENTITY_BYTES + 1) }),
        /Review reviewer is .* bytes; maximum is/,
      ],
      [
        request({ summary: 'x'.repeat(MAX_REVIEW_SUMMARY_BYTES + 1) }),
        /Review summary is .* bytes; maximum is/,
      ],
      [
        request({ findings: 'not-an-array' as unknown as ReviewFinding[] }),
        /Review findings must be an array/,
      ],
      [
        request({ findings: Array.from({ length: MAX_REVIEW_FINDINGS + 1 }, () => FINDINGS[0]!) }),
        /Review findings must contain at most/,
      ],
      [
        request({
          findings: [{ severity: 'critical', message: 'bad', evidence: 'bad' } as unknown as ReviewFinding],
        }),
        /severity must be low, medium, or high/,
      ],
      [
        request({ findings: [{ severity: 'low', message: '', evidence: 'evidence' }] }),
        /findings\[0\]\.message must be a non-empty string/,
      ],
      [
        request({
          findings: [
            {
              severity: 'low',
              message: 'x'.repeat(MAX_REVIEW_FINDING_MESSAGE_BYTES + 1),
              evidence: 'evidence',
            },
          ],
        }),
        /findings\[0\]\.message is .* bytes; maximum is/,
      ],
      [
        request({
          findings: [
            {
              severity: 'low',
              message: 'message',
              evidence: 'x'.repeat(MAX_REVIEW_FINDING_EVIDENCE_BYTES + 1),
            },
          ],
        }),
        /findings\[0\]\.evidence is .* bytes; maximum is/,
      ],
      [
        {
          ...request(),
          verdict: 'accept',
        } as ReviewCreateRequest,
        /Review creation request must contain only/,
      ],
    ];

    for (const [invalid, expected] of invalidRequests) {
      await assert.rejects(reviewService.create(invalid), expected);
    }
    assert.deepEqual(await fixture.reviews.list(), []);
    assert.deepEqual(await fixture.candidates.get(CANDIDATE.id), CANDIDATE);
    assert.deepEqual(REVIEW_FINDING_SEVERITIES, ['low', 'medium', 'high']);
  });
});

test('ReviewService rejects sparse findings before creating a Review or changing its Candidate', async () => {
  await withFixture(async (fixture) => {
    const reviewService = service(fixture);
    const before = await fixture.candidates.get(CANDIDATE.id);
    assert.ok(before);
    const sparseFindings = new Array<ReviewFinding>(2);
    sparseFindings[0] = FINDINGS[0]!;

    await assert.rejects(
      reviewService.create(request({ findings: sparseFindings })),
      /Review findings\[1\] must contain only severity, message, and evidence/
    );

    assert.deepEqual(await fixture.reviews.list(), []);
    assert.deepEqual(await fixture.candidates.get(CANDIDATE.id), before);
    assert.deepEqual(await fixture.candidates.eventsAfter(CANDIDATE.id, 0), before.events);
  });
});

test('multiple independent ReviewRecords may link to the same Candidate', async () => {
  await withFixture(async (fixture) => {
    const reviewService = service(fixture);
    const first = await reviewService.create(
      request({ reviewer: 'reviewer:first', summary: 'First independent review.' })
    );
    const second = await reviewService.create(
      request({ reviewer: 'reviewer:second', summary: 'Second independent review.' })
    );

    assert.notEqual(first.id, second.id);
    assert.equal(first.candidateId, CANDIDATE.id);
    assert.equal(second.candidateId, CANDIDATE.id);
    const listed = await reviewService.list();
    assert.equal(listed.length, 2);
    assert.deepEqual(new Set(listed.map((review) => review.id)), new Set([first.id, second.id]));
    assert.deepEqual(await reviewService.eventsAfter(first.id, 0), first.events);
    assert.deepEqual(await reviewService.eventsAfter(second.id, 0), second.events);
  });
});

test('Review creation does not mutate its Candidate source record or add source events/status', async () => {
  await withFixture(async (fixture) => {
    const before = await fixture.candidates.get(CANDIDATE.id);
    assert.ok(before);

    await service(fixture).create(request());

    assert.deepEqual(await fixture.candidates.get(CANDIDATE.id), before);
    assert.deepEqual(await fixture.candidates.eventsAfter(CANDIDATE.id, 0), before.events);
    assert.equal('status' in before, false);
    assert.equal('updatedAt' in before, false);
  });
});

test('Review persistence rejects general save and unsupported schema versions', async () => {
  await withFixture(async (fixture) => {
    const created = await service(fixture).create(request());
    const raw = await SqliteDurableRecordStore.open<ReviewRecord>('Review', fixture.reviews.directory);
    try {
      const loaded = await raw.get(created.id);
      assert.ok(loaded);
      await assert.rejects(raw.save(loaded), /Review records do not support general save/);

      const invalid: ReviewRecord = {
        ...created,
        id: 'review_future',
        schemaVersion: 2 as 1,
      };
      await assert.rejects(raw.create(invalid), /Unsupported Review schemaVersion 2/);
      assert.equal(await raw.get(invalid.id), undefined);
      assert.deepEqual(await raw.get(created.id), created);
    } finally {
      await raw.close();
    }
  });
});

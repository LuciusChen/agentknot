# 0021: Keep Job persistence failures out of worker retry

- Type: Incident
- Status: Resolved
- Date: 2026-08-09
- Severity: Local deterministic fault injection
- Owners: Upstream controller
- Affected versions/commits: through `76503a5`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [incident 0019](./0019-callback-bookkeeping-persistence-boundary.md)

## Summary

Leaf admission originally created an empty-event snapshot and then saved `job.queued` separately. Later `JobStore.save()` failures could enter the worker failure path, consume retries, or be rewritten as a terminal worker failure. Artifact metadata could also fail to persist after its patch file had been written.

No production failure was observed. Deterministic fault injection during the Stage 1 persistence audit reproduced each boundary.

## Expected invariant

The persisted Job and ordered events are authoritative. Store availability is a control-plane concern and must not be reported as worker behavior, consume a worker retry, fabricate a terminal result, or trigger a callback for a terminal snapshot that was not durably saved.

## Impact and exact state

Before the fix, admission failure between create and the first event could leave a queued record without `job.queued`. An event or artifact save failure during an attempt could be treated as retryable worker failure. A terminal save failure could enter generic error recovery and attempt a second terminal write. The exact durable state depended on which preceding whole-snapshot save succeeded; an unrecorded patch file could remain on disk.

The tests use memory-backed fault injection and temporary Git repositories. No user Job, provider request, source workspace, or production artifact was affected.

## Evidence and root cause

`Orchestrator.start()` performed admission as `store.create(job)` followed by `#emit(job, 'job.queued')`. `#appendEvent()` exposed raw store rejection inside the same `try`/`catch` path as `WorkerAdapter.run()`, so `#execute()` could not distinguish execution failure from persistence failure. Patch capture wrote the artifact before appending its record and had no rollback for a rejected save.

Regression coverage now injects failures at create, `worker.started`, `job.artifact`, and `job.succeeded`. It proves one atomic queued snapshot, zero worker starts on admission failure, one attempt despite a configured retry, no callback, preservation of the last good nonterminal snapshot, exact worktree cleanup, source immutability, and deletion of unrecorded patch evidence. The full suite passes 120 of 120 tests.

## Corrective actions and gates

- [x] Create the queued snapshot and sequence-one `job.queued` in one admission write.
- [x] Expose typed `JobPersistenceError` phase and event evidence.
- [x] Bypass worker retry and generic terminal recovery for persistence errors.
- [x] Roll back an unsaved in-memory event before exposing the error.
- [x] Remove only the exact unrecorded patch path and managed worktree after artifact-recording failure.
- [x] Cover admission, event, artifact, and terminal failure phases deterministically and update current product documents.

## Alternatives considered

Retrying store writes inside worker retry was rejected because it conflates two failure domains and can repeat external worker effects. Treating the failed write as a worker failure was rejected because it falsifies provenance. Adding a journal or cross-file transaction was deferred because Stage 1 uses whole snapshots and does not claim resumable or multi-process execution.

## Consequences and deferred work

Callers can distinguish the four persistence phases and must treat a rejected completion as control-plane failure. A last-good queued or running snapshot is intentionally left for fail-without-resume startup reconciliation; live in-process recovery is not claimed. Multi-process exclusion, PID namespace handling, record bounds, retention/redaction, and crash soak remain separate Stage 1 gates.

## Privacy and security review

The fixtures use synthetic prompts, invalid callback URLs, temporary repositories, and in-memory stores. Artifact rollback validates the generated Job ID and exact managed path before deletion. No credentials, provider output, or user repository content is included in this record.

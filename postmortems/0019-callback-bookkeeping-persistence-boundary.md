# 0019: Keep callback bookkeeping outside execution failure handling

- Type: Incident
- Status: Resolved
- Date: 2026-08-09
- Severity: Local deterministic fault injection
- Owners: Upstream controller
- Affected versions/commits: through `4a33e3d`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

The completion Promise handled execution, callback delivery, and callback-bookkeeping persistence in one shared rejection branch. A transient store failure after a successful callback could therefore be misclassified as worker failure: the already-persisted successful Job could be rewritten as failed and the callback attempted a second time.

No production callback incident was observed. A deterministic failing-store test exposed the behavior during the Stage 1 persistence audit.

## Expected invariant

Callback side effects and their bookkeeping happen after terminal execution. They must not change a correct terminal result, trigger a worker retry, or cause implicit callback redelivery.

## Evidence and root cause

`Orchestrator.start()` previously attached one `.catch()` after both `#execute()` and the `.then()` that called `#deliverCallback()`. A one-shot failure from `JobStore.save()` after the HTTP response therefore entered the same recovery branch used for execution errors. Because the next save could succeed, that branch could persist `job.failed` and invoke callback delivery again.

The regression test injects exactly one save failure when callback state first appears. It verifies one HTTP request, one worker execution, an authoritative persisted `succeeded` record without unpersisted callback claims, and rejection of the completion Promise with the store error.

## Corrective actions and gates

- [x] Terminate execution error handling before callback delivery begins.
- [x] Attempt callback delivery at most once and surface bookkeeping store failure to the completion caller.
- [x] Preserve the previously persisted terminal Job without claiming delivery state that was not saved.
- [x] Add deterministic fault-injection coverage and update PRD, SPEC, ROADMAP, README, and CHANGELOG.
- [ ] Complete the separate Stage 1 admission, event, terminal, and artifact persistence-failure contracts.

## Deferred work

Durable retry, callback idempotency keys, signing, authentication, and restart-aware delivery belong to Stage 3. This fix adds none of them.

## Privacy and security review

The reproduction uses an in-memory store and an invalid test URL handled by a fake fetch implementation. It records no credentials, external responses, prompts, patches, or user data.

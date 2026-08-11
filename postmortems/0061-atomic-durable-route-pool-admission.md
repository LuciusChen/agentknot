# 0061: Bind durable route-pool selection to Job admission

- Type: Architecture Decision
- Status: Accepted
- Implementation: Delivered in this slice
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Related: [decision 0042](./0042-complete-route-pool-balancing.md), [decision 0055](./0055-durable-middleware-kernel.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Context

Complete-route pools originally measured activity and rotated ties with maps owned by one `Orchestrator`. The supported lifetime lock kept that behavior coherent for one broker, but replacing the map with a database read alone would retain a select-then-admit race: two execution owners could observe the same counts and choose the same member before either Job became visible.

The existing fenced Job execution lease already describes an admitted execution that consumes a route. It is therefore the smallest durable activity fact that remains independent of controller, worker adapter, provider, model, and credential implementation.

## Decision

- For the production SQLite Job store, one immediate transaction now performs idempotency lookup, counts unexpired Job execution leases by exact candidate route, reads the rotating cursor, selects the least-active member, materializes the bounded Job with its selection evidence, inserts the record/events/idempotency identity, claims its first fenced execution lease, advances the cursor, and commits.
- The cursor key is a digest of the logical pool name, strategy, and ordered exact-route members. A changed pool definition begins a distinct rotation without adding a second routing abstraction.
- Explicit Jobs admitted to an exact member participate automatically because activity is derived from their persisted route and unexpired execution lease. Child and reviewer Jobs use the same ordinary Job admission boundary.
- A failed admission rolls back both the Job and cursor. An idempotent duplicate returns its original Job without selecting again or advancing rotation.
- The selected exact route remains immutable for every retry. This change adds no fallback, health score, quota estimate, credential router, provider special case, model ranking, or worker-specific branch.
- Memory and legacy file stores retain process-local selection as non-production test/migration behavior. The production path does not maintain a second authoritative activity counter.

## Consequences

Route-pool selection and the activity fact it consumes no longer have a cross-process race in the transactional Job store, and equal-load rotation survives broker replacement. Persisted `routePoolSelection.activeBefore` now reflects unexpired durable Job leases on that path rather than one process's map.

This is the first durable capacity-accounting slice, not a capacity scheduler. It adds no per-route limit, waiting queue, priority, backpressure, worker reattachment, or multi-host execution claim. The orchestration-wide child/reviewer semaphore is still process-local and direct leaf Jobs still begin immediately. The transitional lifetime scheduler lock therefore remains required until those admission and recovery gates are designed and verified.

## Verification

- Two independent SQLite Job-store instances concurrently admitting into one empty pool select different exact members; one transaction observes the other's first lease.
- A completed first admission advances a cursor that a replacement `Orchestrator` observes.
- A missing selected adapter aborts admission, and the next valid admission observes the original cursor and zero activity.
- An idempotent duplicate returns the original exact member, and the following new Job observes only one cursor advance.
- The complete deterministic suite passes 247 of 247.

## Alternatives rejected

- **Read durable counts and admit later:** rejected because it preserves the exact selection race this slice must remove.
- **Add a provider/API-key table:** rejected because credentials and in-request provider routing belong to replaceable downstream runtimes.
- **Use terminal Job status as activity:** rejected because the fenced execution lease is the existing ownership fact and already has expiry/recovery semantics.
- **Remove the scheduler lifetime lock now:** rejected because durable global admission limits, queued dispatch, and multi-executor recovery are not delivered by this slice.

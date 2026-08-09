# 0023: Use fixed budgets for durable records

- Type: Decision
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `7c8fbbf`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

Stage 1 bounds durable control-plane records with one fixed, exported set of UTF-8 budgets. Oversized requests fail before admission; bounded worker evidence is either replaced, omitted, or truncated with explicit evidence; stores enforce a final 16 MiB snapshot ceiling; and an over-budget callback is recorded as undelivered without making the network request. These budgets are intentionally not configurable in this stage.

## Context

Pi lifecycle-envelope filtering reduced known duplicate noise but did not bound custom-adapter events, stderr, output, completion reports, callbacks, or whole snapshots. One low-complexity dogfood inventory also produced roughly one million Pi tokens per child and visibly large persisted output, demonstrating that route classification alone is not a record-volume control.

The product needs deterministic stress behavior without adding a retention service, schema matrix, database, or per-route tuning surface. Artifact bytes and content retention/redaction remain separate lifecycle decisions.

## Expected invariant

The Stage 1 roadmap requires record and event sizes to remain within documented limits under stress fixtures. Limits must remain controller-, worker-, provider-, and model-neutral and must not silently switch a route or discard an entire terminal result without evidence.

## Decision rationale

The implemented budgets are measured in UTF-8 bytes:

| Boundary | Budget | Behavior at the boundary |
| --- | ---: | --- |
| Job or Orchestration prompt | 64 KiB | reject before admission |
| controller metadata | 64 KiB compact JSON, depth 20 | reject before admission |
| one event `data` value | 16 KiB stored JSON | replace with structured size evidence |
| worker events per Job | 512 | persist one `job.worker.events.truncated`, then drop further worker events |
| terminal result output | 1 MiB | retain a valid UTF-8 prefix and `outputTruncation` evidence |
| worker completion report | 256 KiB compact JSON | classify as malformed/unavailable |
| error name/message | 256 B / 16 KiB | truncate the message with an inline byte-count notice |
| Job or Orchestration snapshot | 16 MiB stored JSON | reject the store mutation |
| callback body | 8 MiB compact JSON | do not send; persist an undelivered size error |

Worker-result metadata uses the 64 KiB object budget and is replaced with structured evidence if it is oversized or not serializable. The supported Pi adapter retains only its last 4,096 stderr characters before normalized event limits are applied. Lifecycle events are not counted as worker events, so AgentKnot can still persist its terminal transition after a worker-event flood.

One small `record-limits` module owns constants, UTF-8 truncation, event-data replacement, bounded error text, and exact snapshot serialization. Memory and file stores enforce the same snapshot ceiling. Existing file snapshots remain readable even when larger than the new write ceiling; a later attempted write must satisfy the current ceiling.

## Alternatives considered

### Make every limit configurable

Rejected for Stage 1. Per-route and per-controller tuning would enlarge validation, documentation, compatibility, and operational state before there is evidence for more than one useful budget profile.

### Rely only on the 16 MiB snapshot ceiling

Rejected. A terminal save could then fail after successful worker execution, losing bounded diagnostic value and converting ordinary verbose output into a control-plane persistence failure.

### Silently truncate serialized snapshots

Rejected. Cutting arbitrary JSON can corrupt structure and silently remove lifecycle or provenance fields. Semantic boundaries are limited before serialization, and the final store cap rejects rather than guessing.

### Add compaction or retention in the same slice

Deferred. Deleting old records and redacting content have different user expectations, security consequences, and artifact interactions. Combining them would obscure both policies and inflate the implementation.

## Consequences

- The public `JobResult` may include additive `outputTruncation` evidence.
- Consumers can observe `job.worker.events.truncated`; sequence numbers remain gap-free for persisted events.
- Worker events beyond the cap are accepted by the sink but are no longer persisted or delivered to the live observer.
- Large terminal output is usable but incomplete; callers must check truncation evidence.
- Snapshot and callback limits prevent unbounded durable/network payload growth, not unbounded worker CPU time or event calls.
- Fixed budgets can be revisited only with measured workloads and a compatible contract decision.

## Corrective actions and gates

- [x] Centralize and export fixed budgets and UTF-8-safe helpers.
- [x] Enforce the same whole-record ceiling in memory and file stores.
- [x] Add stress fixtures for admission, multi-byte output, event floods, reports, snapshots, errors, and callbacks.
- [x] Define artifact-byte retention independently — fixed at 16 MiB in [decision 0025](./0025-local-retention-and-redaction-boundary.md).
- [x] Define content retention and honest redaction limitations independently — [decision 0025](./0025-local-retention-and-redaction-boundary.md).

## Deferred work

This decision does not cap patch artifact files, delete old snapshots/artifacts, redact prompts or model content, limit worker execution cost, authenticate callbacks, add queue backpressure, or make custom adapters honor cancellation. Those remain explicit roadmap work.

## Privacy and security review

The tests use generated repeated characters and synthetic paths only. No real prompt, model output, credentials, repository content, callback endpoint, or artifact bytes are retained in this record.

## Addenda

### 2026-08-09: Luna/max post-commit audit

Four read-only Luna/max jobs audited commit `658f9a6` through orchestration `orchestration_52171ea3-ae0e-485d-96f7-654019a6da36`; all artifacts were empty. The audit found that callback overflow can skip delivery yet still fail to save its bookkeeping under the independent 16 MiB snapshot ceiling, so current wording now says AgentKnot *attempts* that save. It also exposed parent-orchestration persistence gaps: queued admission is now atomic, failed event appends roll back, cancellation always propagates abort, and child Job persistence rejection is no longer synthesized as worker failure. Object evidence is JSON-normalized before its standalone budget is measured, and Pi stderr now uses streaming UTF-8 decoding with a 4 KiB byte suffix. Exact-boundary and rejected-save fixtures were expanded without making budgets configurable.

### 2026-08-09: Artifact and local-retention policy completed

[Decision 0025](./0025-local-retention-and-redaction-boundary.md) independently caps new patch artifacts at 16 MiB and defines indefinite local retention with exact manual deletion and no automatic content-redaction claim. The original deferred-work paragraph above records this decision's initial scope rather than current product status.

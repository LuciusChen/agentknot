# 0025: Keep local retention explicit and redaction claims narrow

- Type: Decision
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `e904b2f`
- Related: [decision 0023](./0023-fixed-durable-record-budgets.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

Stage 1 retains local Job and Orchestration snapshots and recorded patch artifacts indefinitely until an operator deliberately removes their exact files. It adds no expiry, garbage collector, cascade deletion, purge API, or content-redaction pipeline. Prompts, model output, normalized worker events, metadata, stderr evidence, callbacks, and Git patches can contain sensitive source or user data; byte limits are not redaction.

New Git patch artifacts have a fixed 16 MiB ceiling. An over-limit capture fails the Job once, is not retried, retains no patch file, and still cleans the managed worktree. Read-only inspection refuses to read a managed artifact above that ceiling and reports `artifact-size-limit-exceeded` with no checksum or preview content.

## Context

Decision 0023 bounded durable record growth but deliberately left deletion, redaction, and patch bytes separate. Automatic secret filtering would create a misleading safety claim: secrets have no reliable universal syntax, model text and tool events are arbitrary, and rewriting a patch would invalidate its checksum and applicability evidence. A retention service or configurable policy would also add lifecycle state and failure modes without a Stage 1 operator requirement.

## Decision rationale

The local policy is deliberately small and controller-, worker-, provider-, and model-neutral:

- newly written Job and Orchestration snapshots and captured patch artifacts remain until exact operator deletion;
- AgentKnot performs no automatic expiry, compaction, garbage collection, cascade delete, or storage-quota eviction;
- AgentKnot performs no content redaction of prompts, output, events, metadata, stderr, callbacks, or patches;
- credentials stay external to route records, Pi session statistics remain allowlisted, and bounded errors/data reduce exposure, but these are field minimization and size controls rather than proof of redaction;
- new patches larger than 16 MiB are rejected before artifact-directory creation or patch write and are not worker-retry eligible;
- verification uses file metadata before reading and withholds the hash and preview for managed files larger than 16 MiB;
- local operators must stop the execution owner and confirm no active work before deleting only the intended Job snapshot, Orchestration snapshot, or per-Job artifact directory. There is no automatic parent/child cascade, so related records must be resolved explicitly.

Snapshot and artifact files are created with mode `0600`. Directory protection continues to depend on the configured local filesystem, ownership, and process environment. Callback delivery can transmit a complete bounded Job record and therefore remains a separate trusted-controller boundary.

## Alternatives considered

### Best-effort secret pattern replacement

Rejected. It would miss arbitrary credentials and can corrupt model evidence or Git patches while giving operators false confidence.

### Automatic time-based deletion

Rejected for Stage 1. It needs durable policy, active-record coordination, parent/child semantics, failure recovery, and an auditable operator contract.

### Configurable patch limits

Rejected for Stage 1. One fixed ceiling is sufficient to bound retained local evidence without adding per-route policy and compatibility state.

### Truncate oversized patches

Rejected. A partial patch is not faithful artifact evidence and cannot retain the original checksum or application semantics.

## Consequences

- Local storage can grow over time and requires explicit operator monitoring and deletion.
- Sensitive content may remain in snapshots and artifacts until deletion and may also have been sent to a configured callback.
- Size replacement, omission, and truncation evidence must never be described as redaction.
- A Job whose worker completed but produced an oversized patch terminates failed with `ArtifactSizeLimitError`; changing the model or retrying cannot repair that artifact boundary.
- Legacy or externally modified oversized artifact files remain visible as invalid metadata but are not hashed or previewed.
- A future automated retention or redaction feature requires its own threat model, compatibility decision, and lifecycle tests.

## Corrective actions and gates

- [x] Bound new Git patch artifacts at 16 MiB without retry or retained partial bytes.
- [x] Refuse hash/preview reads of managed artifact files above the bound.
- [x] Document indefinite local retention, exact manual deletion, and the absence of automatic content redaction.
- [x] Keep the implementation fixed and local rather than adding a retention service or configuration matrix.

## Privacy and security review

Tests use generated repeated bytes and synthetic repositories. This record includes no real prompt, model output, credential, repository content, callback destination, or patch body.

# 0006: Keep artifact inspection read-only and identity-bound

- Type: Decision
- Status: Accepted
- Date: 2026-08-08
- Owners: AgentKnot maintainers
- Affected versions/commits: AgentKnot 0.0.1 development after `9fb29ad`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [worktree handoff decision](./0002-git-worktree-artifact-handoff.md)

## Summary

AgentKnot exposes one language-neutral, read-only artifact inspection contract through TypeScript, CLI, and HTTP. A controller selects a persisted job, lists its recorded artifacts, verifies managed path, size, SHA-256, and current-source base evidence, and requests a bounded preview by attempt. Inspection never accepts a caller-supplied artifact path and never applies, stages, commits, merges, or pushes a patch.

## Context

Worktree jobs already returned patch path, size, SHA-256, attempt, and base commit. Controllers still had to locate files manually and independently decide how to validate them. That prevented Stage 1 from offering an explicit inspect-and-accept-or-reject workflow and would force future TypeScript, Go, Python, or other clients to invent incompatible evidence semantics.

## Expected invariant

- One JSON-compatible payload shape serves every controller language and transport.
- Artifact identity comes from the persisted job and attempt, not an arbitrary path supplied by a caller.
- Verification distinguishes file integrity from current-source base compatibility with stable issue codes.
- Tampered or unreadable bytes are never returned as trusted preview content.
- A valid worker result does not imply artifact acceptance or promotion.

## Evidence chronology

1. Self-orchestration `orchestration_df855ce2-ec3f-4910-8186-838ea512cbbb` dispatched four Luna tasks for contract review, implementation, tests, and documentation from base `9fb29ad`.
2. Contract review identified job/attempt identity, negative verification results, preview bounds, and upstream-only promotion as the stable boundary.
3. The isolated implementation patch established the TypeScript, CLI, and HTTP surfaces but returned preview bytes without first enforcing their recorded integrity and exposed platform error text.
4. Upstream integration retained the public surface while adding managed-path checks, size evidence, stable issue codes, integrity-gated content, missing-file behavior, and source non-mutation tests.
5. The integrated CLI then inspected implementation job `job_75aa03ee-2ef2-4973-b87a-8d570ecae92b`: its 33,835-byte patch matched recorded SHA-256 `b2419c4840d0c5d42fde730e433d57dda5e9c9a873df21d064af0fdf32a3b56e`, its recorded base matched source `HEAD` `9fb29ad`, and bounded preview returned the complete Git patch without mutation.

## Decision rationale

A job-scoped aggregate verification report is useful for retries because one command checks every recorded attempt. Preview remains attempt-scoped because it returns one patch body. Negative integrity or base findings are inspection results rather than worker execution failures. An intact patch may still be previewed when the current source `HEAD` differs, but the report remains invalid; size or SHA-256 failure withholds content because those bytes are not the recorded artifact.

## Alternatives considered

### Accept a filesystem path in the API

Rejected. It would expand a read-only job operation into an arbitrary local-file reader and detach evidence from persisted provenance.

### Return preview content even after integrity failure

Rejected. Diagnostic access to arbitrary changed bytes is not required for the artifact contract and could be mistaken for trusted handoff data.

### Apply the patch after successful verification

Rejected. Integrity is not code review, semantic correctness, conflict resolution, or authorization. Promotion remains a separate upstream decision.

### Build a language-specific SDK first

Deferred. The JSON shapes and HTTP semantics must stabilize before wrappers in Go, Python, Rust, or another language add value.

## Consequences

- Controllers can inspect the same evidence from TypeScript, a shell, HTTP, or a future SDK.
- Preview is capped at 1 MiB and may be truncated.
- Absolute artifact paths remain local diagnostic data and are not portable across machines.
- Patch retention, redaction, signatures, repository identity, and clean-application verification remain separate Stage 1 work.
- The local HTTP API remains unauthenticated and trusted-input only.

## Corrective actions and gates

- [x] Add job-scoped artifact listing and verification.
- [x] Add attempt-scoped, bounded, integrity-gated preview.
- [x] Expose identical payloads through TypeScript, CLI, and HTTP.
- [x] Test valid, missing, tampered, and base-mismatched evidence without source mutation.
- [ ] Add supported-matrix patch application checks against the recorded base.
- [ ] Define retention, record-size, and sensitive-content policy.
- [ ] Consider explicit promotion only with controller intent and dirty/base/integrity refusal rules.

## Privacy and security review

Patch contents may contain sensitive source. Preview is bounded but not redacted. This record includes generated orchestration/job identifiers and hashes only; it contains no source patch, credential, or provider secret.

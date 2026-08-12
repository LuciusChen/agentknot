# 0077: Extend the bounded task context with metadata-only references

- Type: Architecture Decision
- Status: Accepted / Implemented
- Date: 2026-08-12
- Owners: AgentKnot maintainers
- Affected versions/commits: AgentKnot 0.0.x Stage 2 contract work
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decision 0068](./0068-bounded-shared-task-context.md), [experiment 0069](./0069-repeated-shared-context-scope-trials.md)

## Decision

The existing schemaVersion 1 `TaskAssessment.context` remains the single bounded task-context mechanism. `ContextManifest` names that structure and `TaskContext` remains its compatibility alias. This slice adds only an optional `references` array; it does not add a second payload, context service, memory store, or session owner.

Each `ContextReference` carries a unique identity, kind, opaque locator, actual source, and explicit `unverified` trust. Revision, lowercase SHA-256 digest, and summary are optional because not every source has a meaningful version or digest. The complete manifest, including references, remains capped at 2 KiB. Strict validation rejects unknown fields, controls, malformed digests, duplicate IDs, and aggregate oversize, and returns defensive copies.

Admission persists and plan-hashes the metadata through the existing assessment. Every child receives the same reference metadata once, clearly labeled as unverified navigation guidance. AgentKnot does not resolve, fetch, search, verify, or grant authority through a locator in this slice.

## Rationale

The first design proposal was informed by several context and memory systems, including Nowledge, but AgentKnot does not adopt or depend on any of them. Their useful lesson is provenance and trust separation, not their storage, retrieval, connector, or transcript-capture architecture. A fixed `provenance: "controller"`, required opaque revision, and URI/Git-specific parsing were rejected during upstream review because they add validation code without carrying reliable cross-provider information.

Keeping references inside the already admitted context reuses persistence, hashing, size limits, and prompt projection while preserving controller, worker, provider, model, and transport neutrality. Existing schemaVersion 1 requests without references remain valid.

## Deferred boundary

A later slice may define read and authorization semantics only after one concrete use case specifies supported locator schemes, workspace and snapshot isolation, byte/token budgets, durable audit events, stale or challenged references, and A/B quality evidence. Semantic retrieval, vector storage, transcript capture, fixed worker sessions, automatic trust promotion, and external memory providers remain out of scope.

## Verification

Focused runtime tests cover compatibility, strict validation, defensive copying, duplicate and aggregate limits, plan-hash coverage, and one-time unverified prompt projection. The public MCP admission test sends the same reference shape through the broker boundary. An independent dirty-snapshot review found and prompted fixes for C1 control-character admission and a validated-assessment/request prompt divergence; the final `npm test` run passed 300/300 and `git diff --check` passed.

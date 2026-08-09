# 0026: Persist child artifact path-overlap review evidence

- Type: Decision
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `bf12f90`
- Related: [decision 0007](./0007-non-overlapping-task-pools.md), [decision 0015](./0015-terminal-completion-provenance-boundary.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

Every newly produced `action: "delegated"` orchestration result persists an additive `artifactReview`. AgentKnot compares only controller-captured terminal `changedFiles` across its child Jobs. An exact repository-relative path owned by two or more children is reported once with the owning subtask IDs. Missing child evidence makes the review `incomplete`; an empty captured array is valid checked evidence.

This is conservative potential-conflict evidence, not semantic merge analysis. It does not accept, reject, apply, commit, merge, or push an artifact.

## Context and evidence

Planner-declared non-overlap is guidance and prior dogfood work produced overlapping patches. Before this change, each child Job had terminal artifact provenance but every controller had to reimplement cross-child comparison, and the parent retained no review result.

Two read-only Pi/OpenCode Go/Luna/max Jobs in orchestration `orchestration_5210c000-51fd-4c77-a105-31dd0eca5896` independently audited the source/test and documentation boundaries. Both recommended reusing the existing parent result rather than adding an endpoint, service, event stream, semantic diff parser, or promotion operation.

## Decision

- `OrchestrationResult.artifactReview` is optional for legacy, upstream, and suggested results and present on new delegated terminal results.
- `status: "checked"` means every child supplied usable controller-captured terminal path evidence, including `[]`; it says nothing about integrity, current base compatibility, semantic correctness, or acceptance.
- `status: "incomplete"` records each affected child/job and a stable unavailable reason. It must never be treated as a clean handoff.
- Paths are deduplicated within a child, grouped across distinct children, and conflicts are sorted by exact path. Owning subtask IDs retain parent child order.
- Only `JobCompletionSummary.changedFiles` captured evidence participates. Worker reports, prose, events, planner scopes, stderr, and earlier retry artifacts do not.
- Existing TypeScript, CLI full-record, and HTTP full-record surfaces carry the additive field; no endpoint or lifecycle event is added.
- Controllers still verify artifact bytes and recorded bases through the existing read-only APIs. They deliberately accept or reject upstream, and any later promotion is a separate explicit repository action outside AgentKnot.

## Alternatives considered

- **Let every controller compare paths:** rejected because it duplicates a stable control-plane rule and leaves no durable parent evidence.
- **Use worker-reported paths or planner scopes:** rejected because both are claims rather than controller-captured terminal evidence.
- **Run semantic diff or trial merges:** deferred; exact path overlap is bounded and deterministic, while semantic integration requires a larger repository/promotion contract.
- **Persist accepted/rejected/applied state:** rejected for Stage 1. A review decision is not a Job terminal state and AgentKnot owns no promotion operation.

## Consequences and limits

- Same-path edits may be compatible, and disjoint paths can still have semantic dependencies.
- Tampered bytes or a moved source base can coexist with checked path evidence, so per-artifact verification remains mandatory before acceptance.
- Legacy or malformed child evidence produces an incomplete review rather than a false clean result.
- Parent snapshots can grow only by conflicts and unavailable evidence, under the existing whole-record ceiling.

## Corrective actions and gates

- [x] Add the controller-neutral additive result and deterministic parent-level aggregation.
- [x] Cover empty, disjoint, overlapping, grouped multi-child, persistent, incomplete, and source-clean behavior through the public orchestration path.
- [x] Document inspection, path review, upstream accept/reject, and separate promotion as distinct steps.
- [ ] Keep any future AgentKnot promotion operation behind its independent dirty-target, integrity, base, and human-intent gate.

## Privacy and security review

The result retains repository-relative paths already present in child records. Those paths may be sensitive and follow the indefinite local retention/no-redaction policy in decision 0025. Tests use synthetic filenames only.

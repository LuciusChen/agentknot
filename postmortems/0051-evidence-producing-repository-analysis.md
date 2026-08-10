# 0051: Delegate bounded evidence-producing repository analysis

- Type: Incident / Decision
- Status: Resolved / Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected versions/commits: `06e9b59` and earlier planner contracts
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decision 0035](./0035-delegation-first-small-repository-deliverables.md), and [decision 0050](./0050-context-dependent-continuation-handoff.md)

## Summary

A resumed Chirp Codex session submitted `go on`. The context-recovery bridge correctly reconstructed the prior repository task as `再看看有无新的spam关键词呢` and submitted it through AgentKnot, but orchestration `orchestration_fa16bdf1-82c8-4b10-b359-9fba4ba1e837` admitted no child. Its Luna/max planner called the request a simple read-only inspection with no repository-file deliverable and retained it upstream.

That exposed a delegation-policy gap rather than another controller-hook failure. Searching, comparing, or interpreting repository content and reporting exact evidence is a bounded analysis deliverable even when it creates no patch. The planner contract and default/dogfood allowlist now name this free-form kind as `repository-analysis`. A direct lookup of one explicit fact from one already identified location may still remain upstream.

## Expected invariant

Patch production is not the only useful downstream deliverable. A concrete independently verifiable repository analysis should move repository reading and reasoning off the expensive controller path, then return bounded findings for upstream judgment. Informational conversation, requirements/product decisions, artifact integration, commit, push, merge, and deployment remain upstream.

## Root cause

Decision 0035 made small file-producing work delegation-first but retained broad language allowing read-only work upstream whenever handoff seemed cheaper. It noted that nontrivial read-only analysis could already be delegated, yet the default/dogfood allowlist had no general analysis kind beyond `architecture-review` and `test-gap-analysis`. The planner therefore treated an evidence-producing keyword investigation as a trivial no-patch lookup.

## Decision

1. Add `repository-analysis` to the default and repository dogfood delegation allowlists. Task kinds remain bounded free-form strings, so no protocol or parser field changes.
2. Instruct the existing planner to delegate a concrete repository investigation that searches, compares, or interprets project content and returns independently verifiable findings, including when read-only, low-complexity, or non-parallel.
3. Preserve the reverse boundary: retrieving one explicit fact from one already identified location may remain upstream.
4. Apply the existing human-authored route-selection rule after eligibility. In current dogfood configuration low complexity selects the replaceable `routine-workers` pool; no worker, provider, model, or runtime is encoded in the rule change.

## Rejected alternatives and implementation-bloat review

- A hook-side keyword or continuation classifier would duplicate semantic policy and couple controllers to task categories.
- A `producesRepositoryDeliverable` schema field is unnecessary because the planner already emits a free-form kind plus acceptance criteria.
- Reusing `architecture-review` for arbitrary keyword or content analysis would corrupt task-kind evidence.
- Delegating every read-only prompt would waste downstream work on direct factual lookups and conversation.
- Route fallback, learned ranking, quota inference, recursive review, repair, or automatic artifact integration are unrelated and remain excluded.

## Verification gates

- [x] Deterministic planner-prompt coverage distinguishes evidence-producing repository analysis from a direct single-fact lookup.
- [x] Deterministic composer coverage admits one low-complexity non-parallel `repository-analysis` subtask and applies the configured active rule.
- [x] Default and repository dogfood configuration coverage includes the new allowlist value.
- [x] After shared-service restart, orchestration `orchestration_85093459-f023-47cd-abae-8034bb41d72f` classified the exact Chirp task as low-complexity `repository-analysis` and started one `routine-workers` child, which then failed honestly for a missing completion report. A second independent same-task orchestration, `orchestration_2f8a8859-8f04-4217-aa22-44fc64113ba8`, rotated to native OpenCode/DeepSeek and returned a valid substantive report plus verified empty artifact on its first child attempt. Reverse probe `orchestration_2f761a58-ebe6-4aa0-899d-364229d2a607` retained an exact `package.json` single-field lookup upstream.
- [ ] The resumed Chirp controller consumes the child handoff before doing the repository analysis itself.

A separate delegated design review was not used as evidence: child `job_0a1795ac-26a6-4c2c-9490-add3e2219442` omitted the required completion report on its first attempt and returned a malformed report on its second. AgentKnot correctly failed both the Job and parent orchestration instead of treating intermediate text or empty artifacts as completion. This is consistent with the strict boundary in [incident/decision 0044](./0044-required-worker-completion-and-canonical-worktree-id.md); it does not justify weakening that boundary.

## Privacy and authority

The worker receives only the ordinary self-contained task and repository workspace. This change does not expose controller transcripts, apply artifacts, or grant commit/push/merge/deploy authority. Read-only analysis can still use a host-capable worker according to its configured profile; AgentKnot does not claim an OS sandbox.

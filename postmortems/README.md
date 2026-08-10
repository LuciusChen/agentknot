# AgentKnot postmortems and decision records

This directory preserves why the project chose a direction, what evidence changed it, what failed, and which limitations were deliberately deferred. Current truth belongs in README, PRD, SPEC, ROADMAP, code, and tests; these records preserve history so later work does not unknowingly repeat or reverse a decision.

"Postmortem" here covers three record types:

- **Incident**: an invariant was violated or users were affected.
- **Decision**: a non-obvious architectural or product tradeoff established a lasting boundary.
- **Experiment**: an approach was tried, abandoned, or kept behind a gate because evidence was insufficient.

## When a record is required

Write a postmortem when any of these occurs:

- source workspace mutation in `git-worktree` mode;
- missing, corrupt, wrongly based, wrongly hashed, or automatically applied artifacts;
- leaked managed worktrees, worker processes, child processes, timers, or credentials;
- impossible job state, stale active execution, event gaps/duplicates/reordering, or live delivery before persistence;
- retry contamination across attempts or execution from the wrong base commit;
- cancellation or timeout contradicting the documented terminal result;
- callback side effects or observer failures changing execution correctness;
- credentials entering records, events, logs, callbacks, or artifact metadata;
- controller identity changing routing or core behavior;
- an advertised capability that the implementation does not support;
- a significant architectural boundary, external integration, dependency, or default changes;
- an implementation is reverted, abandoned, or deferred after meaningful work;
- a proposal would broaden AgentKnot into collaboration, fleet, cloud, auto-merge, or another explicit non-goal.

Small local refactors and obvious bug fixes do not need a record unless they reveal a reusable failure mode.

## Record rules

- Use `NNNN-short-kebab-title.md`; numbers never change or get reused.
- Mark the type, status, date, affected versions/commits, and related documents near the top.
- Separate observed facts from interpretation and proposed follow-up.
- Include enough evidence or a minimal reproduction for another contributor to verify the conclusion.
- Name the violated or established PRD/SPEC invariant.
- Link the regression test or roadmap gate added because of the finding.
- Do not rewrite old records to match a later opinion. Add a clearly dated addendum or a new record that supersedes the old one.
- Remove secrets and unnecessarily sensitive prompt/repository content before committing a record.
- Update current docs separately; a postmortem is history, not the active specification.

## Template

```markdown
# NNNN: Short title

- Type: Incident | Decision | Experiment
- Status: Draft | Accepted | Resolved | Superseded
- Date: YYYY-MM-DD
- Owners: names or roles
- Affected versions/commits: identifiers
- Related: PRD/SPEC/ROADMAP/issues/records

## Summary

What happened or what was decided, in a few sentences.

## Context

What goal, system state, and constraints existed beforehand.

## Expected invariant

The PRD/SPEC rule or user expectation involved.

## Evidence and timeline

Observed facts, timestamps for incidents, job IDs/attempts/event sequences,
environment, isolation mode, routes, artifacts/hashes, and reproduction steps.

## Root cause or decision rationale

Why it happened or why this option best fits the constraints.

## Alternatives considered

Options considered, their advantages, and why they were rejected or deferred.

## Consequences

Positive outcomes, costs, new risks, and compatibility effects.

## What went well

Detection, containment, tests, or design properties that helped.

## What did not go well

Gaps, misleading assumptions, delayed detection, or unnecessary work.

## Corrective actions and gates

- [ ] Owner — concrete change — verification — roadmap gate

## Deferred work

Limitations intentionally left unresolved and the condition that should reopen them.

## Privacy and security review

What sensitive data was involved and how the record was redacted.

## Addenda

Dated updates without rewriting the original conclusion.
```

Incident records should also include severity, user/controller impact, immediate containment, and the exact terminal state. Decision records may replace the incident timeline with a compact evidence chronology, but must still include alternatives and consequences.

## Index

| ID | Type | Status | Title |
| --- | --- | --- | --- |
| [0001](./0001-vendor-neutral-control-plane.md) | Decision | Accepted | Separate controller, worker, and provider/model routing |
| [0002](./0002-git-worktree-artifact-handoff.md) | Decision | Accepted | Use Git worktrees and patch artifacts for handoff |
| [0003](./0003-skill-minimal-pi-workers.md) | Decision | Accepted | Keep background Pi workers skill-minimal by default |
| [0004](./0004-bounded-automatic-delegation.md) | Decision | Accepted | Put bounded automatic delegation in the control plane |
| [0005](./0005-concurrent-job-event-persistence.md) | Incident | Resolved | Serialize concurrent job event persistence |
| [0006](./0006-read-only-artifact-inspection.md) | Decision | Accepted | Keep artifact inspection read-only and identity-bound |
| [0007](./0007-non-overlapping-task-pools.md) | Decision | Accepted | Prefer non-overlapping task pools over fixed batches |
| [0008](./0008-route-diagnostics-false-ready.md) | Incident | Resolved | Separate configuration readiness from live Luna inference |
| [0009](./0009-pi-rpc-child-supervision.md) | Incident | Resolved | Bound Pi RPC child termination after timeout and cancellation |
| [0010](./0010-read-only-cli-runtime-reconciliation.md) | Incident | Resolved | Prevent read-only CLI runtime reconciliation from mutating active jobs |
| [0011](./0011-explicit-http-liveness-contract.md) | Decision | Accepted | Name HTTP process liveness without implying route readiness |
| [0012](./0012-evidence-gated-pi-profiles.md) | Decision | Accepted | Promote isolated Pi profiles only on measured dogfood benefit |
| [0013](./0013-pi-readseek-profile-ab.md) | Experiment | Rejected | Reject the first pi-readseek profile after measured regressions |
| [0014](./0014-pi-lean-ctx-profile-ab.md) | Experiment | Rejected | Keep pi-lean-ctx experimental after one beneficial A/B pair |
| [0015](./0015-terminal-completion-provenance-boundary.md) | Decision | Accepted | Keep terminal completion provenance explicit |
| [0016](./0016-shadow-route-selection.md) | Decision | Accepted | Keep route selection shadow-only until measured scorecards |
| [0017](./0017-deepseek-flash-route-ab.md) | Experiment | Inconclusive | Keep DeepSeek Flash as an explicit candidate after one mixed A/B |
| [0018](./0018-pi-concurrency-startup-ceiling.md) | Incident | Resolved | Do not treat direct Job bursts as orchestration capacity evidence |
| [0019](./0019-callback-bookkeeping-persistence-boundary.md) | Incident | Resolved | Keep callback bookkeeping outside execution failure handling |
| [0020](./0020-human-authored-active-route-selection.md) | Decision | Accepted | Apply only human-authored active route selection |
| [0021](./0021-job-persistence-failure-boundaries.md) | Incident | Resolved | Keep Job persistence failures out of worker retry |
| [0022](./0022-file-runtime-single-writer-ownership.md) | Decision | Accepted | Enforce one file-runtime writer before recovery |
| [0023](./0023-fixed-durable-record-budgets.md) | Decision | Accepted | Use fixed budgets for durable records |
| [0024](./0024-stale-dogfood-test-processes.md) | Incident | Resolved | Contain stale dogfood test processes |
| [0025](./0025-local-retention-and-redaction-boundary.md) | Decision | Accepted | Keep local retention explicit and redaction claims narrow |
| [0026](./0026-child-artifact-path-overlap-review.md) | Decision | Accepted | Persist child artifact path-overlap review evidence |
| [0027](./0027-controller-native-integration-boundary.md) | Decision | Accepted | Keep controller-native integrations thin and policy-neutral |
| [0028](./0028-native-opencode-adapter-evidence-gate.md) | Decision | Accepted | Defer a native OpenCode adapter until it proves value over Pi |
| [0029](./0029-controller-cli-and-single-child-delegation.md) | Incident / Decision | Accepted | Make the controller CLI prerequisite and single-child delegation explicit |
| [0030](./0030-pre-model-controller-dispatch.md) | Incident / Decision | Accepted | Dispatch configured automatic work before the controller model |
| [0031](./0031-bounded-pi-output-drain.md) | Incident / Experiment | Resolved | Bound Pi output draining when an event sink never settles |
| [0032](./0032-pre-model-multi-child-evidence.md) | Experiment | Accepted | Prove pre-model multi-child dispatch without a direct baseline |
| [0033](./0033-controller-timeout-phase-claim.md) | Incident / Experiment | Resolved | Remove the false pre-dispatch claim from hook failures |
| [0034](./0034-persisted-usage-observability-boundary.md) | Decision | Accepted | Report exact persisted usage without inventing controller telemetry |
| [0035](./0035-delegation-first-small-repository-deliverables.md) | Decision / Experiment | Accepted | Delegate small repository deliverables before the controller model |
| [0036](./0036-bounded-advisory-quality-review.md) | Decision / Experiment | Accepted | Bound advisory quality review to supplied evidence |
| [0037](./0037-controller-owned-artifact-validation.md) | Decision | Accepted | Validate one delegated patch in a disposable worktree |
| [0038](./0038-shared-local-controller-runtime.md) | Incident / Decision | Accepted | Route concurrent controllers through one local execution owner |
| [0039](./0039-live-plugin-cache-refresh.md) | Incident | Resolved | Do not invalidate hook paths used by active controller sessions |
| [0040](./0040-product-owned-local-service-discovery.md) | Decision | Accepted | Discover one running local service without shell-profile edits |
| [0041](./0041-native-opencode-worker-portability.md) | Decision / Experiment | Accepted | Add a native OpenCode worker to prove downstream portability |
| [0042](./0042-complete-route-pool-balancing.md) | Decision | Accepted | Balance heterogeneous downstreams above complete routes |

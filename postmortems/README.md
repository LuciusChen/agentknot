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
| [0043](./0043-native-opencode-lifecycle-soak.md) | Decision / Experiment | Accepted | Close native OpenCode lifecycle gate and document Git metadata boundary |
| [0044](./0044-required-worker-completion-and-canonical-worktree-id.md) | Incident / Decision | Resolved / Accepted | Require real-worker completion and canonicalize worktree identity |
| [0045](./0045-controller-session-workspace-binding.md) | Incident / Decision | Resolved / Accepted | Bind an explicit repository to the controller session |
| [0046](./0046-clutch-review-listing-and-shutdown-gaps.md) | Incident / Decision | Resolved / Accepted | Close Clutch review, listing, and shutdown gaps |
| [0047](./0047-resumable-controller-binding-and-replaceable-role-pools.md) | Incident / Decision | Resolved / Accepted | Resume controller bindings and make orchestration roles replaceable |
| [0048](./0048-controller-hook-failure-blocking.md) | Incident / Decision | Resolved / Accepted | Block controller fallback after automatic-entry failure |
| [0049](./0049-dirty-workspace-snapshot-isolation.md) | Decision | Accepted | Snapshot dirty workspaces without weakening artifact isolation |
| [0050](./0050-context-dependent-continuation-handoff.md) | Incident / Decision | Resolved / Accepted | Recover bounded continuation tasks without reading controller transcripts |
| [0051](./0051-evidence-producing-repository-analysis.md) | Incident / Decision | Resolved / Accepted | Delegate bounded evidence-producing repository analysis |
| [0052](./0052-bounded-analysis-and-observable-waiting.md) | Incident / Decision | Resolved / Accepted | Bound repository analysis and make waiting observable |
| [0053](./0053-controller-owned-planning-handoff.md) | Incident / Decision | Resolved / Accepted | Restore controller-owned planning and use a strict handoff |
| [0054](./0054-portable-service-lifecycle.md) | Incident / Decision | Resolved / Accepted | Make controller service lifecycle portable and explicit |
| [0055](./0055-durable-middleware-kernel.md) | Incident / Architecture Decision | Accepted / In progress | Replace process ownership with a durable middleware kernel |
| [0056](./0056-opencode-statistics-advisory-boundary.md) | Incident / Boundary correction | Accepted | Keep OpenCode accounting evidence advisory |
| [0057](./0057-independent-broker-and-thin-controller-clients.md) | Incident / Architecture Decision | Resolved / Accepted | Make the broker independent and controller clients thin |
| [0058](./0058-controller-neutral-broker-activation.md) | Incident / Architecture Decision | Resolved / Accepted | Let common clients explicitly activate a non-running broker |
| [0059](./0059-retire-native-opencode-worker.md) | Decision | Accepted | Retire the native secondary CLI worker and keep Pi as the sole built-in real worker |
| [0060](./0060-artifact-capture-omitted-deletions.md) | Incident | Resolved | Preserve tracked-file deletions in worker patch artifacts |
| [0061](./0061-atomic-durable-route-pool-admission.md) | Architecture Decision | Accepted | Bind least-active route selection to durable Job admission |
| [0062](./0062-durable-event-subscription.md) | Incident / Architecture Decision | Accepted | Make durable cursor subscription the wait authority |
| [0063](./0063-remove-per-prompt-controller-obligations.md) | Incident / Architecture Decision | Resolved / Accepted | Remove repeated controller prompt obligations |
| [0064](./0064-broker-startup-child-cleanup.md) | Incident / Architecture Decision | Resolved / Accepted | Bound broker startup child cleanup |
| [0065](./0065-retire-http-wait-aliases.md) | Incident / Architecture Decision | Resolved / Accepted | Retire pre-release HTTP wait aliases |
| [0066](./0066-pi-duplicate-tool-start-events.md) | Incident | Resolved | Remove duplicate Pi tool-start events |
| [0067](./0067-route-tool-execution-budget.md) | Incident / Architecture Decision | Superseded | Add an optional route tool-execution budget |
| [0068](./0068-bounded-shared-task-context.md) | Incident / Architecture Decision | Resolved / Accepted | Bound shared task context without worker-session coupling |
| [0069](./0069-repeated-shared-context-scope-trials.md) | Experiment / Incident | Accepted / Resolved | Repeat shared-context scope trials, remove contradictory check guidance, and settle blocked reports without retry |
| [0070](./0070-sparse-worktree-artifact-boundary.md) | Incident / Decision | Resolved / Accepted | Preserve sparse-checkout artifact semantics and enforce read-only analysis |
| [0071](./0071-defer-pi-durable-harness-migration.md) | Architecture Decision / Dependency Review | Accepted / Deferred | Defer Pi durable-harness migration until executable parity |
| [0072](./0072-compact-worker-activity-and-pi-frame-coalescing.md) | Incident / Architecture Decision | Resolved / Accepted | Preserve useful worker activity under Pi text-frame floods |
| [0073](./0073-stable-multi-session-broker-rendezvous.md) | Incident / Architecture Decision | Resolved / Accepted | Use one stable broker rendezvous across controller environments |
| [0074](./0074-session-start-controller-entry.md) | Incident / Architecture Decision | Resolved / Accepted | Restore controller entry at session boundaries after an implicit-selection miss |
| [0075](./0075-bounded-mcp-wait-and-resume-gate.md) | Incident / Architecture Decision | Resolved / Accepted | Bound MCP waiting without controller-session ownership |
| [0076](./0076-durable-capacity-and-live-control-fences.md) | Incident / Architecture Decision | Resolved / Accepted | Fence shared Job capacity and live-control settlement |
| [0077](./0077-task-context-reference-manifest.md) | Architecture Decision | Accepted / Implemented | Extend the bounded task context with metadata-only references |
| [0078](./0078-exact-artifact-read-grant.md) | Architecture Decision | Accepted / Implemented | Authorize one exact artifact read without turning references into capabilities |
| [0079](./0079-external-worktree-ancestor-isolation.md) | Incident / Architecture Decision | Resolved / Accepted | Keep external target worktrees outside the host project ancestry |
| [0080](./0080-artifact-read-review-ab.md) | Experiment / Incident | Accepted / Resolved | Keep exact artifact reads without claiming measured review efficiency |
| [0081](./0081-selective-workspace-context-ab.md) | Experiment / Architecture Decision | Accepted / Experimental | Select workspace-file context on demand after repeatable total-token wins but failed latency gates |
| [0082](./0082-real-repository-selective-context-gate.md) | Experiment / Architecture Decision | Accepted | Reject automatic context candidates and invalidate a confounded delegated A/B |
| [0083](./0083-remove-tool-count-task-boundaries.md) | Incident / Architecture Decision | Accepted / Implemented | Remove fixed tool-count task boundaries |
| [0084](./0084-worker-settled-retry-ownership.md) | Incident / Architecture Decision | Resolved / Accepted | Keep downstream retry inside the worker session and prevent full Job replay |
| [0085](./0085-in-session-completion-envelope-recovery.md) | Incident / Architecture Decision | Resolved / Accepted | Recover missing completion evidence in the live worker session |

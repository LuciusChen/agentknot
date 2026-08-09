# 0016: Keep route selection shadow-only until measured scorecards

- Type: Decision
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: AgentKnot 0.0.x Stage 1 bounded orchestration slice
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [bounded delegation decision](./0004-bounded-automatic-delegation.md), [task-pool decision](./0007-non-overlapping-task-pools.md)

## Summary

AgentKnot adds an optional vendor-neutral route-selection evidence slice under `delegation.dispatch.routeSelection`, but accepts only `mode: "shadow"` and disables it when omitted. Ordered 1–20 rules may suggest an existing route from an eligible subtask's kind and its parent assessment complexity, while the actual `PlannedSubtask.route` and child `Job.route` remain `dispatch.defaultRoute`.

The plan persists first-match/default evidence, and child `agentknotDelegation` metadata carries the task kind, parent assessment complexity, and evidence for later scorecards. This is measurement scaffolding rather than automatic routing; model rankings require separate measured scorecards before any automatic selection can drive execution.

## Context

AgentKnot already separates controller identity, deterministic orchestration policy, and route resolution, but future route comparisons need structured observations that do not depend on parsing planner or worker prompts. The bounded delegation slice provides a natural place to record a route suggestion beside the plan and the child provenance without giving a model discretion to change execution.

A shadow baseline is important because a suggestion that changes the worker route would confound the first measurement with the behavior being measured. Keeping `dispatch.defaultRoute` authoritative lets controllers compare evidence against the route that actually ran and preserves the existing provider/model/thinking, fallback, retry, artifact, and lifecycle contracts.

## Expected invariant

- Omitted `delegation.dispatch.routeSelection` disables route selection, and its only accepted mode is `shadow`; `mode: "auto"` is rejected for this field.
- The rule list contains 1–20 ordered rules, every rule references an existing route validated at config load, and present `taskKinds` or `complexities` arrays are non-empty and unique.
- Complexity predicates use only `low`, `medium`, and `high`; when both predicates exist they both must match, a rule with neither predicate is an explicit catch-all, and the first matching rule wins.
- A rule match records `mode: "shadow"`, the suggested route, `basis: "rule"`, and a zero-based `ruleIndex`; no match records the default route with `basis: "default"` and no rule index.
- For every eligible planned subtask, the evidence is persisted and covered by the plan hash, but `PlannedSubtask.route` remains `dispatch.defaultRoute` for actual execution.
- Child metadata exposes the task kind, parent assessment complexity, and shadow evidence so future scorecards do not parse prompts; the ordinary child `Job.route` remains actual authority.
- The planner cannot name routes, and this slice does not change actual dispatch, fallback, retry, provider/model/thinking resolution, persisted record `schemaVersion`, artifact handoff, or the formal repository Luna/max route.

## Evidence and timeline

1. The existing architecture assigns route resolution to configuration and the orchestrator, while planner assessment and deterministic plan composition belong to the orchestration service; this slice stays within those boundaries.
2. The existing plan hash and child metadata provide durable, controller-neutral evidence surfaces, so route suggestions can be added without a provider-specific branch or a new persisted-record schema.
3. The upstream contract fixes strict config validation, first-match/default semantics, plan-hash coverage, and public orchestration verification as the deterministic evidence required for this slice.
4. No measured scorecard currently establishes that a task kind or complexity should run on a different model or provider, so automatic selection is intentionally not admitted. No DeepSeek route or integration is configured by this decision.
5. Real shadow dogfood orchestration `orchestration_0ad86cfb-6e6a-4cb7-89a5-154edb768a11` used a temporary candidate set containing only `mock` and `luna`. Its low-complexity `test-gap-analysis` subtask persisted `suggestedRoute: "mock"`, `basis: "rule"`, and `ruleIndex: 0`, while the plan route, child request route, child-start event, and resolved Job route all remained `luna`. Child `job_18a11560-276c-4c45-b73b-9016566ed636` ran through Pi/OpenCode Go/`gpt-5.6-luna` with `thinkingLevel=max`, succeeded with an empty controller-captured patch, and copied the exact shadow evidence plus `taskKind` and `parentComplexity` into structured metadata.

## Decision rationale

Shadow mode preserves a controlled experiment: the system records what a deterministic rule would have suggested while the default route continues to execute. This makes the evidence useful for later comparison without silently changing worker behavior or weakening the route snapshot contract.

Configuration owns the rule language and candidate-route validation because route names and rule bounds are admission concerns, not planner intelligence or worker protocol behavior. Deterministic first-match evaluation makes overlapping rules reviewable and keeps the planner from supplying unvalidated route names.

Structured plan evidence and child metadata are preferable to prompt annotations because future scorecards need stable task-kind, parent-complexity, suggestion, and actual-route fields. The metadata is evidence, not semantic verification or a security boundary.

Separate measured scorecards are required before automatic model rankings can become policy. They must compare comparable workloads and record outcomes such as completion, artifact validity, checks, intervention, latency, and relevant cost or usage; a rule match by itself is not performance evidence.

## Alternatives considered

### Let the planner choose the child route

Rejected. Planner output is model-controlled and would bypass candidate validation, deterministic policy, and the ordinary route authority. It would also move provider/model policy into the planner contract.

### Use the suggested route for `PlannedSubtask.route`

Rejected. The existing planned route is the actual child execution input. Overloading it with a suggestion would silently change dispatch and make the first scorecard comparison impossible to interpret.

### Add an automatic route-selection mode now

Rejected. No measured scorecards establish model or provider rankings, and automatic switching would broaden the current routing contract. A future automatic mode requires a separate decision, explicit policy, and an evidence-gated roadmap change.

### Encode the suggestion only in prompts or parse it later

Rejected. Prompt text is not a stable evidence schema and would require scorecards to infer task kind, parent complexity, or route suggestions from model-controlled content. Structured plan and child metadata keep those fields observable.

### Add a provider-specific route or DeepSeek integration

Rejected for this slice. The control plane remains vendor-neutral, candidate routes remain ordinary configured routes, and the formal repository Luna/max route is unchanged. A provider addition belongs to route configuration and its own evidence gate rather than shadow-selection policy.

## Consequences

### Positive

- Controllers can observe deterministic route suggestions without changing which route actually executes.
- First-match/default evidence is persisted and included in the plan hash, making policy changes auditable.
- Child metadata gives future scorecards structured task-kind, parent-complexity, suggested-route, and actual-route context without prompt parsing.
- Candidate route typos fail at config load instead of becoming misleading evidence at dispatch time.
- The existing Job API, route snapshot, worker adapter, fallback, retry, provider/model, thinking-level, artifact, and cleanup boundaries remain unchanged.

### Costs and risks

- Shadow suggestions add evidence but provide no automatic performance improvement or route optimization.
- Planner task-kind and complexity classifications can be incomplete or adversarial, so scorecards must retain classification context and should not treat a rule match as a verified recommendation.
- A configured candidate route may be present and valid by name but still fail or perform poorly when measured; config-load validation is not live inference or promotion evidence.
- Metadata and plans can contain repository or task information subject to the existing retention and trusted-local limitations.

## What went well

The existing separation between orchestration policy and route resolution makes it possible to add evidence without adding controller-vendor, provider-vendor, or worker-adapter branches. Existing plan hashing and recursive JSON metadata validation also provide natural deterministic boundaries for the new evidence.

## What did not go well

Without measured scorecards, a route suggestion can look like a ranking even though it has not been compared against the route that actually ran. The documentation and decision therefore need to state repeatedly that shadow mode is non-authoritative and that automatic selection remains deferred.

## Corrective actions and gates

- [x] Keep route-selection configuration optional, shadow-only, bounded, ordered, and strict at config load — Stage 1 bounded-delegation contract.
- [x] Persist first-match/default evidence in the plan, include it in the plan hash, and retain the default route for actual child execution — deterministic policy and public orchestration verification.
- [x] Copy task kind, parent assessment complexity, and shadow evidence into child `agentknotDelegation` metadata — public child Job evidence verification.
- [ ] Build separate measured route/model scorecards on comparable workloads, including completion, artifact/check outcomes, intervention, latency, and usage or cost — required before proposing automatic selection.
- [ ] Revisit automatic model/provider selection only through a new PRD/SPEC impact analysis, roadmap gate, and decision record; do not infer a ranking from shadow evidence alone.

## Deferred work

Automatic model/provider ranking, automatic route switching, DeepSeek configuration, planner-selected routes, provider fallback changes, formal Luna/max changes, artifact application, and security-sandbox claims remain outside this decision. Shadow evidence does not authorize commits, merges, pushes, deployment, or any other artifact promotion.

## Privacy and security review

The slice adds task kind, parent assessment complexity, route names, and policy evidence to existing plans and child metadata; it intentionally adds no credentials or authorization data. Worktree isolation and structured metadata do not make AgentKnot an operating-system security sandbox, and existing prompt, output, patch, callback, and retention limitations remain.

# 0053: Restore controller-owned planning and use a strict handoff

- Type: Incident / Decision
- Status: Resolved / Accepted
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Affected versions/commits: `c6b5dee` and earlier pre-model automatic-entry implementations
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [0030](./0030-pre-model-controller-dispatch.md), [0048](./0048-controller-hook-failure-blocking.md), [0050](./0050-context-dependent-continuation-handoff.md)

## Summary

The installed prompt hook displayed “AgentKnot is planning, running workers, and verifying” because it synchronously sent the raw submitted prompt to an AgentKnot planner Job before the upstream controller model ran. That behavior violated the project boundary: Codex, Claude, or another controller owns conversation intent, planning, decomposition, and product decisions; AgentKnot is execution middleware.

The pre-model planner path is removed. Every new `OrchestrationRequest` now carries a strict controller-authored `TaskAssessment`. AgentKnot validates that untrusted handoff, applies deterministic policy/routing/caps, persists accepted-handoff and plan evidence, schedules isolated children, and verifies completion/artifacts. The prompt hook only resolves workspace and delegation policy and injects a non-blocking handoff obligation.

## Expected invariant

- Controller replacement must not move controller reasoning into middleware.
- AgentKnot may enforce deterministic policy but must not make product or planning decisions.
- Worker/provider/model selection remains configuration; neither controller assessment nor hook selects a route.
- Downstream output is evidence only and requires upstream inspection before integration.

## Evidence

- The prior hook called `agentknot orchestrate --prompt event.prompt --handoff-json --progress`, waited up to 3,660 seconds, parsed terminal children and artifacts, previewed patches, and blocked controller submission on failure.
- Core configuration carried a planner route/fallback, orchestration created a planner Job, and public records/events exposed planner-specific state.
- The user-visible status explicitly attributed planning to AgentKnot, revealing the responsibility drift.
- Core-removal draft Job `job_7a536092-a524-4983-af2a-5ff80dbdd674` hit its event bound without a completion envelope. Its artifact was treated only as a draft, verified against the exact dirty-tree baseline, compiled, and tested in a disposable checkout before upstream application.
- CLI/HTTP Job `job_4ccbcc71-28cc-4324-909f-176b40f36224` completed through Pi/OpenCode Go/Luna/max with a valid completion report and artifact.
- Controller-plugin Job `job_6bde5623-4da6-49b5-8c73-9f91836f9056` produced a scope-valid artifact through native OpenCode/Luna/max but omitted its completion envelope and was correctly marked failed; upstream reviewed it as a draft rather than accepting the terminal claim.
- Mechanical fixture Job `job_254f1674-36ea-41e7-8707-1c46658aabee` completed through native OpenCode/DeepSeek Flash/max. All three artifacts matched their recorded SHA-256, base commit, and dirty base tree before application.
- Focused controller/CLI/HTTP/public-entry verification passed 40/40 after cutover.
- The complete deterministic suite passed 249/249 after the final fixture convergence.
- Live orchestration `orchestration_2e53fcde-426c-4fce-9a31-083d1f91965a` accepted a controller-authored do-not-delegate assessment without creating a planner Job; its only lifecycle events were queued, handoff accepted, review skipped, artifact validation skipped, and succeeded. A separate Luna/max live doctor inference also succeeded.

## Root cause and decision rationale

Earlier experiments optimized upstream token use by running semantic planning before the controller model. That improved some measured Codex paths but confused an optimization with the architecture contract. A middleware planner sees only the current prompt, duplicates controller reasoning, cannot reliably recover conversation context, adds a model call and long blocking hook lifecycle, and makes “automatic” behavior depend on an extra configured intelligence role.

The retained split is:

1. Controller: intent, planning, decomposition, complexity, task kind, independence, acceptance criteria, and integration decisions.
2. AgentKnot: strict admission, deterministic policy, route selection, concurrency/depth limits, persistence, isolation, lifecycle, completion, review, and artifact evidence.
3. Worker/reviewer: bounded execution or advisory evidence with no promotion authority.

The assessment remains untrusted. Strict exact-key validation and deterministic policy prevent a controller from bypassing keep-upstream kinds, child caps, depth, route configuration, or artifact authority.

## Compatibility

New TypeScript, HTTP, and CLI orchestration submissions require `assessment` / `--assessment-json`. Planner and fallback configuration fields are rejected as stale unknown fields. The package has no published compatibility contract requiring a second schema or migration framework, so new records remain schemaVersion 1. Historical stored records may retain the former `planning` status and planner fields and remain readable; new executions never emit them.

## Consequences

- The hook no longer consumes provider quota, waits for workers, transports terminal output, or blocks a user prompt. AgentKnot child lookups are bounded to five seconds and the host hook to ten seconds.
- The status message now says only that workspace delegation policy is being checked.
- Codex permits implicit Skill invocation, so automatic use still does not require a per-prompt user reminder; the controller model must consciously author the handoff.
- Prior pre-model token measurements remain historical evidence only. They cannot be cited as current-path savings; the controller-owned path needs fresh same-task measurement.
- Planner configuration, fallback handling, planner Jobs/worktrees/events/metadata, raw-prompt hook orchestration, progress forwarding, terminal parsing, and preview reinjection are deleted.

## Alternatives considered

### Rename the hook status

Rejected. The implementation, not merely the wording, owned planning.

### Keep a middleware planner as optional fallback

Rejected. It retains two planning owners, more configuration/state/tests, ambiguous token behavior, and silent architecture drift.

### Add a schema v2 and legacy decoder framework

Rejected for the unpublished 0.0.x contract. Historical v1 snapshots remain readable without expanding production migration machinery.

### Move deterministic route selection into the controller

Rejected. Complexity/task kind are semantic controller evidence; route/model choice remains human-authored AgentKnot configuration.

## Corrective actions and gates

- [x] Require and strictly validate controller assessments across TypeScript, HTTP, and CLI.
- [x] Remove planner configuration, Job execution, fallback, events, metadata, and current statuses.
- [x] Add persisted `orchestration.handoff.accepted` evidence before dispatch.
- [x] Replace synchronous prompt-hook orchestration with bounded non-blocking obligation context.
- [x] Preserve Codex/Claude parity, explicit bypass, session binding, and package independence.
- [x] Remove stale current README/PRD/SPEC/ROADMAP planner claims and mark historical evidence as pre-cutover.
- [ ] Re-run same-task upstream/downstream token measurement on the controller-owned handoff before making a new savings claim.

## Privacy and security review

The new hook reduces exposure: raw submitted prompts, controller transcripts, worker output, and artifact previews no longer pass through pre-model hook execution. The controller sends only the bounded parent task and assessment it deliberately authors through the normal orchestration surface. Existing local storage, provider credential, and unauthenticated-loopback limitations remain unchanged.

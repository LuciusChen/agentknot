# 0004: Put bounded automatic delegation in the control plane

- Type: Decision
- Status: Accepted
- Date: 2026-08-08
- Owners: AgentKnot maintainers
- Affected versions/commits: AgentKnot 0.0.1 development after `a97edac`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [incident 0005](./0005-concurrent-job-event-persistence.md)

## Summary

AgentKnot adds a controller-neutral orchestration API above its leaf Job API. A configured planner produces a strict task assessment, deterministic project-owned policy decides which bounded subtasks are eligible, the complete plan is persisted, and only then are depth-one child jobs dispatched through the existing isolated job lifecycle.

This moves delegation judgment out of controller-specific prompts and target-repository conventions without turning AgentKnot into a recursive swarm, scheduler, or automatic code-integration system.

## Context

The original MVP could execute a task once a controller chose a route, but every Codex, Claude, CI, or custom integration still had to decide whether and how to delegate. `AGENTS.md`, MCP, and skills can remind one controller to call AgentKnot, but they cannot provide shared policy, persistence, limits, or behavior to every project and controller.

The user requirement was stronger: projects that adopt AgentKnot should receive judicious delegation without repeated manual reminders, both the upstream controller and downstream provider/model should remain replaceable, and AgentKnot should improve itself by exercising that same path.

Relay was reviewed as a boundary reference. Its draft auto-routing design places classification and team composition in the control plane because prompt-only worker spawning was unreliable in its evaluation. AgentKnot adopts that ownership lesson, not Relay's runtime, fleet, channel, or team abstractions.

## Expected invariant

- Controller identity remains audit metadata, never a routing or policy branch.
- A model may assess a task but may not unilaterally exceed configured kinds, routes, child count, depth, or concurrency.
- The exact effective policy and plan exist durably before child execution begins.
- Every child uses the ordinary Job API and Git worktree isolation.
- Product decisions, artifact promotion, commits, pushes, merges, and deployment remain upstream.
- Planner or runtime failure must have an explicit, persisted outcome and must never silently redispatch after restart.

## Evidence and timeline

1. A Pi/Luna design review was submitted through AgentKnot as job `job_7776af86-6b59-4023-a48c-cab95611f851` before implementation. It recommended a layer above the leaf orchestrator, strict JSON, a separate parent store, persist-before-dispatch evidence, a process-wide cap, depth one, and fail-without-resume semantics.
2. Deterministic tests were added for strict planner parsing, policy filtering, over-cap rejection, suggestion mode, malformed-planner fallback, persisted-before-child ordering, cancellation, shared concurrency, HTTP access, and startup reconciliation.
3. The repository configuration was changed to use Luna for both planner and worker in `auto` mode with an explicit four-child and four-concurrency dogfood setting, depth one, so the self-orchestration check exercises real parallel Pi processes. The product defaults are two children and two concurrent executions when limits are omitted, and the parser ceiling is six for each; non-parallel assessments reduce effective parent concurrency to one.
4. The first real self-orchestration completed as `orchestration_da237ca1-440d-4071-a5bc-e782faadf011`: one Luna planner produced four eligible review tasks, all four Luna child jobs started within 133 milliseconds, all succeeded, every patch artifact was empty as requested for a read-only review, and no managed worktree remained.

## Decision rationale

The orchestration layer sits above `Orchestrator.start()` so planner and worker executions inherit one route, lifecycle, isolation, retry, event, artifact, and cleanup contract. A model is useful for semantic decomposition, but deterministic code owns admission and safety limits. This combination keeps the planner and provider replaceable while making policy reviewable and testable.

The API is explicit rather than magical. AgentKnot cannot and should not intercept arbitrary native Codex or Claude conversations. Controller bridges call the same CLI, HTTP, or TypeScript orchestration entry point; MCP and skills are optional conveniences over that contract.

## Alternatives considered

### Keep delegation only in `AGENTS.md` or controller prompts

This is easy to start but is advisory, controller-specific, inconsistently applied, and unable to persist a plan or enforce shared caps. It remains useful as a bridge instruction but not as the product boundary.

### Require MCP or a skill as the primary integration

These mechanisms are not universal across controllers and make replacement harder. They may wrap AgentKnot, but the portable contract remains CLI, HTTP, and TypeScript.

### Let the planner spawn workers directly

Prompt-only spawning makes limits, provenance, persistence order, route choice, and retries difficult to prove. It was rejected in favor of deterministic control-plane dispatch.

### Adopt Relay or OhMyPi as the core

Both may remain useful references or optional edges, but adopting their larger conventions would add collaboration or distribution scope not required for the local handoff problem. Pi RPC remains the first narrow worker adapter.

### Build a restartable dependency scheduler first

That would delay the core user outcome and broaden failure semantics significantly. V1 therefore supports only a persisted depth-one plan and deterministically fails interrupted parents without resume.

## Consequences

### Positive

- Codex, Claude, CI, and custom callers can receive the same delegation behavior.
- Pi/Luna can be replaced by another configured planner or worker route.
- Policy and model judgment are separated and independently testable.
- Every dispatched child has parent/plan provenance and isolated artifacts.
- AgentKnot can dogfood the exact path it offers other repositories.

### Costs and risks

- A controller bridge must deliberately call the orchestration API; configuration cannot intercept unrelated chats.
- Planner output may be malformed or manipulated by repository content, so validation and keep-upstream policy remain essential.
- The shared concurrency limit is only process-local; stores do not protect multiple writers.
- PID liveness is vulnerable to reuse, and a hard crash may leave managed worktrees or child processes requiring manual cleanup.
- Parent and child snapshots are separate files without a transactional commit across them.
- Cancellation and adapter termination are cooperative, not an operating-system sandbox.
- Depth one is an orchestration-engine invariant; without local API authorization, a host-capable worker can still submit a separate top-level request.
- No child patch is selected or integrated automatically; the upstream controller still performs review and promotion.

## Follow-up

- Add bounded record sizes, retention/redaction, persistence-failure tests, and stronger single-writer enforcement under Stage 1.
- Keep recursive/dynamic teams, dependency graphs, durable queues, and multi-process scheduling behind later evidence gates.

## Addenda

### 2026-08-08 — First self-orchestration promotion check

The promotion check used commit `3474c5f` and the repository's `auto` policy with Luna as planner and worker, four children, depth one, and concurrency four. Planner job `job_b3ae05fd-194b-487e-8237-3a4e2a0ebdad` completed before `orchestration.planned` was persisted. Worker jobs `job_04d68cf7-e209-4ec7-8a6f-9c64668e0781`, `job_6565c67a-aecb-4566-adeb-74b71e0b3c82`, `job_5880f910-b484-45cc-b482-d38ea7661f1f`, and `job_5a98561b-050a-4636-a281-833b05b11618` then overlapped for more than 90 seconds. The run exposed a concurrent file-store event race and lifecycle/provenance gaps; those findings led directly to incident record 0005 and follow-up fixes rather than being treated as a ceremonial pass.

This run is evidence for one normal successful planner-to-plan-to-child path only. The planner completing before `orchestration.planned` is an observed event ordering, not evidence that planner failure, timeout, cancellation, or shared-semaphore waiting fails fast. The malformed-planner upstream fallback test covers a separate failure path; the self-orchestration result must not be cited as proof of those failure semantics.

### 2026-08-08 — Actual-edit self-orchestration

The second promotion check used commit `2a8dc96` and parent `orchestration_f964d6ad-fb2a-44fc-9307-a4bf559bd49a`. Planner job `job_d89a74d3-9a24-4ea7-a3f5-f288a87849d6` produced plan `334f469ad36e7cc5d6e78163c6001531e0772ae720728d75bafde70ed11d892c`; four isolated Luna children started within 131 milliseconds and all produced non-empty patches. The tasks covered metadata validation (`job_8b42a41d-5c7c-46ce-919e-cf39d794d608`, SHA-256 `cb6b0811bdbc6c0900103dd829cb0973143587f764c1faa3979600ae278ee981`), CLI and public-entry tests (`job_7cf71a9d-8a93-409f-953f-4ec43eb3f62f`, `8c92a21b2b9966bbaf9f2398b9a2ae5ff4fcef68e04d974804ea71ec3ca4e5f4`), cancellation and retry tests (`job_a2c5b559-ecb6-4e4e-9bdd-371cfc3c9e55`, `37453bc6ebf33ed6b6c055375b6eb3c25c4452fff381aebdca589b2471ec64e9`), and documentation (`job_d62687ff-d56a-43b1-9302-bffa0bc13cf1`, `df445620d81cbd6867745335fc258894137f8bd75c32f5427a01d11d0021f208`).

The upstream controller verified every artifact digest, reviewed the patches, and integrated them selectively with `apply_patch`; AgentKnot did not auto-apply worker output. The integrated tree then passed the TypeScript build, `git diff --check`, and all 40 tests. This demonstrates the intended repair workflow: upstream diagnosis and acceptance boundaries, concurrent downstream implementation in isolated worktrees, and upstream-controlled promotion.

### 2026-08-08 — Sliding task-pool refinement

The initial four-child/four-concurrency configuration proved parallel execution but coupled plan capacity to active slots. [Decision 0007](./0007-non-overlapping-task-pools.md) changes the repository dogfood setting to six possible children and four active slots, defines parallel tasks as independently verifiable and dependency-free with non-overlapping expected write scopes, and preserves the existing sliding refill loop. Historical four-worker evidence above remains accurate for the earlier run; it is no longer the current repository limit.

# 0004: Put bounded automatic delegation in the control plane

- Type: Decision
- Status: Accepted; real self-orchestration evidence pending
- Date: 2026-08-08
- Owners: AgentKnot maintainers
- Affected versions/commits: AgentKnot 0.0.1 development after `a97edac`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

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
3. The repository configuration was changed to use Luna for both planner and worker in `auto` mode with four children maximum, depth one, and concurrency four so the self-orchestration check exercises real parallel Pi processes. Non-parallel assessments reduce effective parent concurrency to one.
4. A real orchestration of AgentKnot itself is required before this record can mark self-orchestration evidence complete.

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

- Run the real self-orchestration promotion check and append job/orchestration IDs and observed gaps here.
- Add bounded record sizes, retention/redaction, persistence-failure tests, and stronger single-writer enforcement under Stage 1.
- Keep recursive/dynamic teams, dependency graphs, durable queues, and multi-process scheduling behind later evidence gates.

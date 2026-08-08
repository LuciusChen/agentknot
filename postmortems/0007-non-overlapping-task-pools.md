# 0007: Prefer non-overlapping task pools over fixed batches

- Type: Decision
- Status: Accepted
- Date: 2026-08-08
- Owners: AgentKnot maintainers
- Affected versions/commits: AgentKnot 0.0.1 development after `9fb29ad`
- Related: [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [bounded delegation decision](./0004-bounded-automatic-delegation.md)

## Summary

AgentKnot treats task count and active concurrency as separate limits. The planner should produce only useful independently verifiable subtasks and mark them parallel only when they have no execution-order dependency and no overlapping expected write scope. The dispatcher runs a sliding task pool: it starts up to `maxConcurrency`, starts fewer when fewer tasks exist, and admits the next pending task whenever a worker settles.

## Context

The first dogfood configuration set both `maxChildren` and `maxConcurrency` to four. That demonstrated four-way execution but could be misread as a requirement to manufacture four tasks or dispatch work in fixed batches. During the next self-orchestration, implementation, test, and documentation tasks edited overlapping files even though their topics differed. Isolated worktrees prevented runtime corruption but left avoidable integration conflicts for the upstream controller.

## Expected invariant

- Decomposition optimizes useful throughput, not child count.
- A two-task plan uses at most two workers even when four slots are available.
- A six-task plan with four slots starts four and continuously refills freed slots until the pool is empty.
- `parallelizable: false` reduces the parent to one active child.
- Planning guidance cannot be described as proof that actual worker patches are disjoint.

## Decision rationale

This matches ordinary agile decomposition: partition work by stable boundaries and independently testable outcomes, then let capacity pull the next ready item. Fixed batches waste capacity when tasks finish at different times, while forcing a target task count creates artificial coordination. Keeping `maxChildren` bounded separately from `maxConcurrency` preserves admission safety without coupling plan size to machine capacity.

The repository dogfood setting is `maxChildren: 6` and `maxConcurrency: 4`; product defaults remain two and two. The existing dispatcher already used a refill loop, so the implementation change makes the distinction visible in configuration, planner instructions, documentation, and deterministic tests.

## Alternatives considered

### Always request exactly four subtasks

Rejected. Some goals have one or two useful independent boundaries; synthetic splitting adds latency and integration work.

### Dispatch fixed rounds of four

Rejected. A slow task would hold the next round even when other slots are idle.

### Let every child edit any relevant file

Rejected as planning policy. Worktree isolation protects the source during execution but does not prevent overlapping patches from conflicting during review.

### Enforce declared paths before execution

Deferred. Planner-declared paths are model output and may be incomplete. A future gate should compare actual patch paths and report conflicts rather than claiming hard enforcement prematurely.

## Consequences

- Planner prompts now require bounded file/component scope and explicit non-goals for parallel tasks.
- Worker prompts require reporting necessary out-of-scope changes instead of silently broadening edits.
- Six tasks can flow through four active slots without recursive delegation or an unbounded queue.
- This remains a process-local sliding window, not a restartable durable queue.
- Actual patch conflict detection and dependency graphs remain deferred.

## Corrective actions and gates

- [x] Separate the dogfood task-pool size from its active concurrency cap.
- [x] Test fewer tasks than slots and more tasks than slots.
- [x] Define non-overlap and dependency-free semantics in planner/worker instructions.
- [ ] Extract actual changed paths from child patch artifacts and report overlaps before promotion.
- [ ] Add explicit dependencies only after Stage 1 lifecycle and queue gates justify a graph model.

## Privacy and security review

The decision changes scheduling and prompt policy only. It introduces no credentials, remote execution, automatic promotion, or new source access.

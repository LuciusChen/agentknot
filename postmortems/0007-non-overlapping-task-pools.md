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
- Semantic conflict detection and dependency graphs remain deferred; exact child path-overlap evidence is now implemented separately.

## Corrective actions and gates

- [x] Separate the dogfood task-pool size from its active concurrency cap.
- [x] Test fewer tasks than slots and more tasks than slots.
- [x] Define non-overlap and dependency-free semantics in planner/worker instructions.
- [x] Extract actual changed paths from child patch artifacts and report overlaps before promotion ([decision 0026](./0026-child-artifact-path-overlap-review.md)).
- [ ] Add explicit dependencies only after Stage 1 lifecycle and queue gates justify a graph model.

## Privacy and security review

The decision changes scheduling and prompt policy only. It introduces no credentials, remote execution, automatic promotion, or new source access.

## Addenda

### 2026-08-09: Raise dogfood active slots to six

The repository later raised `maxConcurrency` from four to the existing supported ceiling of six while keeping `maxChildren: 6`. This is a configuration-only dogfood change: product defaults remain two, the scheduler still starts only available eligible tasks, non-parallel plans still run one child at a time, and the non-overlap/dependency rules remain unchanged. Raising the ceiling cannot reduce the latency of a plan containing only two or three useful subtasks.

### 2026-08-09: Revert to the measured four-slot limit

Immediate validation challenged the assumption behind the preceding configuration change, but the first probe used concurrent direct Job calls that bypass the orchestration semaphore and therefore was not a valid scheduler-capacity test. The repository restored `maxConcurrency: 4` because it was the last proven orchestration value. Formal orchestration `orchestration_1f1f6b0d-8637-49b3-b04f-cc608e5e5f23` then started four Luna/max children within 27 ms and all four succeeded. [Incident 0018](./0018-pi-concurrency-startup-ceiling.md) records the probe error and the direct-Job admission boundary.

### 2026-08-09: Re-raise only after exact-route formal soaks

The same six-child read-only workload then succeeded through formal Pi/OpenCode Go/Luna/max orchestration at configured concurrency four, five, and six (`orchestration_b60edde1-22fb-4192-9823-9a5209fb2044`, `orchestration_6cc868ab-04d2-4be7-89a2-d43a79e291ed`, and `orchestration_3c726dc0-72ec-4b70-b628-9c829661b8cf`). At six, all children started within 44 ms and completed on their first attempt with empty artifacts and no retained Pi or managed-worktree residue. The repository dogfood setting is therefore six active slots again. Product defaults remain two, useful task count still bounds actual workers, non-parallel plans still run one child, and this local evidence is not a universal route-capacity guarantee.

### 2026-08-09: Persist actual child path-overlap evidence

[Decision 0026](./0026-child-artifact-path-overlap-review.md) closes the deferred changed-path gate with additive parent-level review evidence. Exact repeated paths are potential integration conflicts only; semantic analysis, acceptance, and promotion remain outside the execution loop.

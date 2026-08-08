# Changelog

All release-relevant changes to AgentKnot are recorded here. The project follows semantic versioning once versions are intentionally published; commits to `main` are not releases by themselves.

## [Unreleased]

### Added

- Controller-neutral automatic delegation through CLI, HTTP, and TypeScript orchestration APIs.
- Strict planner assessments, deterministic task-kind policy, persisted plans, parent/child provenance, and bounded depth-one concurrent dispatch.
- Separate file and memory orchestration stores with ordered lifecycle events, cancellation propagation, and fail-without-resume startup reconciliation.
- `off`, `suggest`, and `auto` delegation configuration with per-request `inherit`, `never`, `suggest`, and `force` controls.
- Git worktree patch artifacts that include tracked, non-ignored untracked, binary, and worker-committed changes.
- Product requirements, technical specification, evidence-gated roadmap, and decision/postmortem records.

### Changed

- Live event observers are advisory; observer failures are persisted without retrying or failing successful worker execution.
- Stale nonterminal leaf jobs are marked failed once on startup instead of remaining indefinitely active.
- Automatic delegation defaults to two concurrent children when enabled without an explicit cap; the repository dogfood configuration uses Pi with OpenCode Go/Luna for planning and up to four concurrent delegated workers.
- Background Pi workers disable ambient skill discovery by default while retaining repository instructions.

### Fixed

- Concurrent worker events are serialized per job and file snapshots use unique temporary names, preventing event gaps and temporary-file rename races.
- Planner jobs now share the same process-wide concurrency budget as delegated child jobs.
- Planner or child jobs admitted immediately before a parent persistence failure are cancelled and awaited instead of continuing as orphan executions.
- Restart reconciliation refreshes embedded parent child outcomes from authoritative leaf Job records.
- Child records and delegation metadata carry the admitting plan hash and policy version.
- Pi RPC waits for `agent_settled`, preserving queued continuation and retry output before declaring completion.
- Worktree retries start from the same base commit and clean only AgentKnot-owned worktree registrations.

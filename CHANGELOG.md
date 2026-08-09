# Changelog

All release-relevant changes to AgentKnot are recorded here. The project follows semantic versioning once versions are intentionally published; commits to `main` are not releases by themselves.

## [Unreleased]

### Added

- Controller-neutral automatic delegation through CLI, HTTP, and TypeScript orchestration APIs.
- Strict planner assessments, deterministic task-kind policy, persisted plans, parent/child provenance, and bounded depth-one concurrent dispatch.
- Separate file and memory orchestration stores with ordered lifecycle events, cancellation propagation, and fail-without-resume startup reconciliation.
- `off`, `suggest`, and `auto` delegation configuration with per-request `inherit`, `never`, `suggest`, and `force` controls.
- Git worktree patch artifacts that include tracked, non-ignored untracked, binary, and worker-committed changes.
- Read-only artifact listing, SHA-256/size/base-commit verification, and bounded integrity-gated patch preview through TypeScript, CLI, and HTTP.
- Opt-in `doctor --live --route NAME` diagnostics that perform one bounded real inference through the exact resolved route, without Job or artifact persistence; the repository promotion check covers Pi/OpenCode Go/Luna at `thinkingLevel: "max"`.
- Canonical `GET /health/live` process liveness with an explicit not-checked storage/route/inference payload; `GET /health` remains an identical compatibility alias and HTTP readiness remains intentionally absent.
- Deterministic Pi RPC conformance fixtures for split JSONL/UTF-8 input, malformed frames, premature exit, missing settlement, timeout, and cancellation.
- Product requirements, technical specification, evidence-gated roadmap, and decision/postmortem records.

### Changed

- Live event observers are advisory; observer failures are persisted without retrying or failing successful worker execution.
- Stale nonterminal leaf jobs are marked failed once on startup instead of remaining indefinitely active.
- Automatic delegation defaults to `maxChildren: 2` and `maxConcurrency: 2` when dispatch limits are omitted; each value is capped at 6 and concurrency cannot exceed the child count. The repository dogfood configuration uses a six-task pool with four concurrent Pi/OpenCode Go/Luna execution slots.
- Planner instructions reserve parallel execution for independently verifiable subtasks without execution-order dependencies or overlapping expected write scopes; the scheduler starts only the available tasks up to the concurrency cap and refills slots as workers complete.
- Controller metadata now follows one recursive JSON-compatible object contract across TypeScript and HTTP leaf/orchestration APIs.
- Background Pi workers disable ambient skill discovery by default while retaining repository instructions.
- The repository Luna route now uses Pi's `max` thinking level for planning, delegated worker execution, and live diagnostic probes that select that route.
- Configuration-only `doctor` output explicitly says that live inference was not checked; `doctor --live` uses a 30-second control-plane timeout, reports provider errors with a nonzero exit status, reports unsupported adapters honestly, never falls back to another route, and does not add a preflight to normal jobs.

### Fixed

- Read-oriented CLI commands no longer perform startup reconciliation or mutate persisted Job and Orchestration records; only execution-owning `run`, `orchestrate`, and valid `serve` invocations retain recovery, and invalid `serve` arguments fail before runtime construction ([postmortem 0010](postmortems/0010-read-only-cli-runtime-reconciliation.md)).
- Concurrent worker events are serialized per job and file snapshots use unique temporary names, preventing event gaps and temporary-file rename races ([postmortem 0005](postmortems/0005-concurrent-job-event-persistence.md)).
- Planner jobs now share the same process-wide concurrency budget as delegated child jobs.
- Planner or child jobs admitted immediately before a parent persistence failure are cancelled and awaited instead of continuing as orphan executions.
- Restart reconciliation refreshes embedded parent child outcomes from authoritative leaf Job records.
- Child records and delegation metadata carry the admitting plan hash and policy version.
- Pi RPC waits for `agent_settled`, preserving queued continuation and retry output before declaring completion.
- Pi RPC timeout and cancellation now use bounded `SIGTERM` → `SIGKILL` supervision for the exact owned child and bounded stdio draining, preventing a child that ignores `SIGTERM` from leaving the Job active indefinitely; malformed JSONL and exit-without-settlement errors now retain protocol context ([postmortem 0009](postmortems/0009-pi-rpc-child-supervision.md)).
- Pi configuration-only diagnostics now use the same effective worker environment as `run` and `probe` for command discovery, required environment names, and Pi auth-directory/home resolution; empty credential values remain absent and secret values are not returned.
- Worktree retries start from the same base commit and clean only AgentKnot-owned worktree registrations.

# 0018: Do not use direct Job bursts as orchestration capacity evidence

- Type: Incident
- Status: Resolved
- Date: 2026-08-09
- Severity: Local dogfood validation error
- Owners: Upstream controller
- Affected versions/commits: `9502a0e`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decision 0007](./0007-non-overlapping-task-pools.md)

## Summary

The repository dogfood setting was raised from four to six active slots based only on the configuration ceiling. The first validation then used a temporary script that called several direct `runtime.run()` requests in one `Promise.all`. Cohorts of three through six all exited before Pi settlement, while a single Job succeeded. This was initially misread as an orchestration capacity limit.

Inspection showed that direct leaf Jobs bypass `OrchestrationService`'s shared semaphore. A formal four-child Luna/max orchestration subsequently succeeded, so the repository temporarily restored four slots. Later formal six-child orchestrations at configured concurrency four, five, and six all succeeded through the exact Pi/OpenCode Go/Luna/max path. The repository therefore uses six slots again; the direct-burst failures still do not establish the maximum orchestration capacity or a Pi hard limit.

The source workspace stayed clean. Every failed direct Job reached a terminal failed state and captured an empty, checksum-valid patch artifact. No fallback or model substitution occurred.

## Violated assumptions

1. Configuration validity was treated as operational capacity evidence. The parser's maximum of six only bounds accepted policy.
2. Concurrent direct Job calls were treated as equivalent to child dispatch. In v1, `delegation.dispatch.maxConcurrency` caps planner and child executions inside `OrchestrationService`; `Orchestrator.start()` has no global admission semaphore.

## Evidence

- Six direct Jobs: three Luna/max and three DeepSeek Flash/max Jobs started at `2026-08-09T03:44:13.001Z`; all failed within 533 ms with `Pi RPC exited before agent_settled (code=0, signal=null)`.
- Five direct Luna/max Jobs started at `2026-08-09T03:46:43.201Z`; all failed within 492 ms with the same error.
- Four and three direct Luna/max cohorts at `03:49:19.409Z` and `03:49:32.918Z` also failed in full, proving the result was not a threshold between four and five.
- Single direct control Job `job_e4609639-a16f-40ec-8bed-ca4930bce503` succeeded and produced a valid test-only artifact.
- Formal orchestration `orchestration_1f1f6b0d-8637-49b3-b04f-cc608e5e5f23` recorded `configuredConcurrency: 4` and `effectiveConcurrency: 4`. Its four Luna/max children started between `03:51:26.107Z` and `03:51:26.134Z`, and all four succeeded.
- The formal run used the repository's ordinary planner → persisted plan → bounded child dispatch path; each read-only child produced an empty, valid artifact.
- Follow-up formal orchestrations `orchestration_b60edde1-22fb-4192-9823-9a5209fb2044`, `orchestration_6cc868ab-04d2-4be7-89a2-d43a79e291ed`, and `orchestration_3c726dc0-72ec-4b70-b628-9c829661b8cf` each dispatched six read-only Luna/max children at configured concurrency four, five, and six respectively. All 18 children succeeded on their first attempt with empty artifacts and no provider error.
- In the six-slot run, all six child Jobs started from `11:40:09.714Z` through `11:40:09.758Z` and the orchestration completed in 130.69 seconds. No owned Pi RPC process or managed child worktree remained afterward.

The failed bursts used separate managed Git worktrees and one process-local FileJobStore namespace. They produced no retained session statistics. The approximately half-second exits remain unexplained, but they are evidence about unpaced direct admission, not an orchestration concurrency ceiling.

## Corrective actions and gates

- [x] Restore repository `maxConcurrency` to four while retaining `maxChildren: 6` and sliding refill.
- [x] Verify four through the exact Pi/OpenCode Go/Luna/max orchestration path.
- [x] Document that the delegation semaphore does not limit concurrent direct Job callers.
- [x] Keep product defaults at two and the configuration syntax ceiling at six.
- [x] Before raising dogfood concurrency again, require a formal orchestration soak at the proposed value through the exact worker/provider/model/thinking route; the four/five/six sequence above satisfied this gate before retaining six.
- [ ] Define the supported direct-Job admission model under the existing Stage 1 concurrency work before adding a global limiter; avoid double-acquisition or deadlock between leaf and orchestration capacity.
- [ ] Improve Pi pre-settlement diagnostics only as a bounded Stage 1 reliability slice; do not infer a retryable provider error from exit code 0.

## Privacy and security review

The record contains Job IDs, timestamps, route labels, aggregate outcomes, and public repository commits only. It contains no credentials, provider responses, or model output. Temporary state remained under `/tmp`; no third-party extension, including pi-intercom, was installed.

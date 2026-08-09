# 0031: Bound Pi output draining when an event sink never settles

- Type: Incident and experiment
- Status: Resolved
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `4ab055b`
- Related: [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decision 0030](./0030-pre-model-controller-dispatch.md)

## Summary

`PiRpcWorkerAdapter.run()` already bounded exact-child termination and the first stdout/stderr drain wait. After that deadline it destroyed the owned streams but unconditionally awaited the same output task. A `WorkerEventSink` that returned a never-settling Promise could therefore keep cancellation or timeout pending forever even after Pi exited.

The fix adds one early return after the existing drain deadline destroys the two owned streams. `Promise.allSettled` remains attached to both output tasks, so late rejection stays observed; the adapter does not attempt to cancel an external Promise or perform broader process cleanup. One deterministic regression enters the blocked sink, aborts with an exact Error object, requires settlement within 2.5 seconds, and verifies the recorded fake-Pi PID is gone.

## Root cause and boundary

Stream destruction cannot release JavaScript that is already suspended inside `await emit(...)`. The prior final `await output` therefore converted a bounded stream drain into an unbounded adapter cleanup. The owning fix belongs in `awaitChildOutput`, not the Orchestrator, semaphore, provider route, or event store.

Ordinary event-sink rejection still follows the existing settlement rejection path and remains covered by the shared conformance test. A malicious or defective external sink promise may remain pending in memory because JavaScript Promises are not cancellable; it no longer retains the owned Pi process or blocks Job cancellation.

## Controller-path experiment

The same non-empty implementation prompt ran from commit `4ab055b` in two clean detached worktrees using Codex `gpt-5.6-sol` at `xhigh`.

| Controller path | Codex input | Cached input | Codex output | Result |
| --- | ---: | ---: | ---: | --- |
| Controller-first, hooks/plugins disabled | 2,266,538 | 2,157,824 | 10,097 | Codex implemented locally, then repository instructions caused a manual read-only AgentKnot review before final verification. |
| Pre-model AgentKnot hook | 141,781 | 112,128 | 2,765 | One Luna/max worker produced a verified two-file patch before Codex reviewed, applied, and tested it once. |

The reported Codex input reduction was 2,124,757 tokens, or 93.7%; non-cached input fell from 108,714 to 29,653, or 72.7%. This is a controller-first/manual-delegation comparison, not a pure direct baseline, because `AGENTS.md` still required the first Codex path to delegate a bounded review. It does not close the pure-direct gate in decision 0029 or establish universal savings.

Automatic orchestration `orchestration_cd7c15d9-84a4-49f9-b5d1-4b68f46c6fe0` used planner `job_58be5fb9-9ff9-41d8-83ba-c105a3de1d47` and one medium, non-parallel Luna/max implementation child `job_36eedbe3-ac53-4083-b24e-ac655c93f406`. The child completed once, reported 878,233 downstream tokens, and produced a 2,828-byte artifact with SHA-256 `af2d6ebdb5cf841cfe1e873251758ebd85c2768fb6d155c0c642393520a434d2` against base `4ab055b`; size, hash, base, and the two changed paths all verified before preview. Planner plus worker used 885,638 downstream tokens and provider-reported cost `0.027615755`.

The controller-first path's later read-only planner and reviewer used 181,412 downstream tokens and provider-reported cost `0.01764358`. These downstream totals are not a same-work comparison: pre-model AgentKnot owned implementation and tests, whereas the controller-first AgentKnot call owned only review. They are recorded to show the intended capacity shift rather than claim downstream savings.

Both controller paths found the same one-line production fix and passed 158/158 tests. Their regression tests differed only in construction and placement; upstream selected the shorter test to avoid implementation bloat rather than treating either worker artifact as authority. Upstream reran the selected Pi file (35/35), the full suite (158/158), and the bounded host lifecycle soak (52/52) with no matching process or managed-worktree residue.

## Corrective actions and remaining gates

- [x] Stop awaiting the output task after the existing drain grace expires and owned streams are destroyed.
- [x] Prove exact abort-reason propagation, bounded settlement, and exact child PID cleanup with a deterministic regression.
- [x] Preserve ordinary event-sink failure propagation and the existing API/schema/route contracts.
- [x] Record one non-empty controller-first versus pre-model automatic comparison without mislabeling it as pure direct.
- [ ] Retain the pure-direct, multi-child, real Claude, and real-controller failure/timeout gates in decisions 0029 and 0030.

## Privacy and security review

The record contains public repository paths, commit and Job/orchestration identifiers, aggregate token/cost counts, and artifact hashes. It contains no credentials or provider response text. Both temporary worktrees are removed after upstream integration and verification.

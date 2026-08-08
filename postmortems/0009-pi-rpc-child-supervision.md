# 0009: Bound Pi RPC child termination after timeout and cancellation

- Type: Incident
- Status: Resolved
- Severity: Medium
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: AgentKnot 0.0.1 through `1b2c7c7`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [README](../README.md), [CHANGELOG](../CHANGELOG.md)

## Summary

The Pi RPC adapter rejected its protocol wait and sent `SIGTERM` when an attempt timed out or was cancelled, but then awaited child stdout and stderr indefinitely. A Pi process that ignored `SIGTERM` could therefore keep the adapter and public Job completion active forever. Deterministic conformance fixtures exposed the lifecycle gap; exact-child bounded `SIGTERM` → `SIGKILL` supervision and bounded stream draining now make both paths settle.

## Context

AgentKnot owns Job state, timeout, cancellation, and terminal persistence, while the Pi adapter owns the Pi process it starts. The existing cleanup assumed that one `SIGTERM` would make that process exit and close its pipes. That assumption had not been tested with a child that deliberately ignored the signal.

## Expected invariant

A supported adapter must settle after its attempt signal is aborted so the orchestrator can persist the intended terminal state and finish workspace/artifact cleanup. The Pi adapter must terminate the exact child it owns without using broad host process matching.

## Severity, impact, and terminal state

- Severity: worker lifecycle reliability / potential process leak.
- Under the controlled reproduction, a timeout intended to produce `failed` and controller cancellation intended to produce `cancelled` both remained nonterminal because adapter cleanup never returned.
- The fixture child and its stdio remained active until external cleanup. No real-provider child leak, credential exposure, source mutation, artifact application, commit, push, merge, or deployment was observed.

## Immediate containment

The conformance fixture recorded the exact child PID and ignored `SIGTERM`. Tests retained an exact-PID `SIGKILL` cleanup fallback so a failing regression could not leak the fixture process while the adapter fix was developed and reviewed.

## Evidence and timeline

1. At base commit `1b2c7c7706ae78b949f8419e4d1192c2ab8e8c57`, `PiRpcWorkerAdapter.run()` rejected its settlement promise on abort and sent `SIGTERM`.
2. Its `finally` block then awaited stdout/stderr tasks without a deadline. A child holding those pipes open after ignoring `SIGTERM` prevented the adapter from returning.
3. AgentKnot orchestration `orchestration_14949ca6-6cf2-4408-8aa4-b53c6d353abd` delegated the bounded implementation to child Job `job_fca8fe02-678f-4645-9da1-5a2fdb3795e7`; its verified patch artifact had SHA-256 `20ffa5a793c5085b479db41f8559a35ba943fd6dae5211c6c09cd91b91781f7c` and the expected base commit.
4. Upstream review applied the artifact, added early rejection observation, and ran the public conformance suite. Both timeout and cancellation completed, the fixture observed `SIGTERM`, and the recorded child PID no longer existed after completion.
5. The full suite passed 70/70 tests.

## Root cause

The adapter treated abort propagation as sufficient process supervision. Its cleanup had an unbounded wait on streams whose lifetime depended on the child exiting, while child termination was a best-effort single signal. The test suite covered cooperative children but not an owned child that ignored `SIGTERM`.

## Alternatives considered

### Keep cancellation cooperative only

Rejected for the bundled Pi adapter. AgentKnot starts and owns that exact process, so leaving its Job permanently active after a known abort contradicts the Stage 1 lifecycle gate.

### Kill processes by name or use broad host cleanup

Rejected. `pkill`, name matching, or unrelated process scans could terminate user-owned Pi sessions and would exceed the adapter's ownership boundary.

### Supervise the exact spawned child with bounded escalation

Accepted. The adapter sends `SIGTERM`, waits briefly, escalates that child to `SIGKILL`, and bounds draining of its owned streams. This directly addresses the hang without claiming control over arbitrary descendants.

## Consequences

- Pi-backed timeout and cancellation now settle even when the exact Pi child ignores `SIGTERM`.
- Malformed JSONL includes line context, and exit before `agent_settled` distinguishes whether `agent_end` was seen.
- Normal success, retry handling, strict JSONL framing, streaming UTF-8 decoding, route selection, and thinking-level propagation remain unchanged.
- Custom adapters remain responsible for their own termination contract; the core cannot hard-kill a process it does not own.

## What went well

The existing adapter boundary made exact ownership clear, and the public Orchestrator tests could prove both terminal semantics and disappearance of the recorded child PID. Worktree artifact handoff kept downstream code isolated until its hash, base, scope, and content were reviewed upstream.

## What did not go well

The original tests implicitly assumed cooperative termination and did not cover a signal-resistant process. Awaiting stdio looked like orderly cleanup but had no bound, so the intended timeout did not bound the complete attempt lifecycle.

## Corrective actions and gates

- [x] Add deterministic split-frame, split-UTF-8, malformed-frame, premature-exit, missing-settlement, timeout, and cancellation Pi RPC fixtures — Stage 1 worker conformance.
- [x] Use bounded exact-child `SIGTERM` → `SIGKILL` supervision and bounded owned-stream draining in normal runs and live probes — Stage 1 lifecycle gate.
- [x] Verify timeout and cancellation through the public Orchestrator and assert that the recorded exact PID is gone — regression gate.
- [ ] Add sustained real-worker success/failure/timeout/cancellation and inherited-pipe soak coverage before promoting another adapter — Stage 1 soak gate.

## Deferred work

The fix does not kill arbitrary descendants or process groups, prove OS-level sandboxing, add a universal hard-kill mechanism for custom adapters, or make process-local cancellation restartable. Those require explicit ownership and portability contracts before implementation.

## Privacy and security review

The reproduction used a local fixture PID and marker files. No provider credentials, prompts, repository contents, or authentication files were copied into the record. Exact-child signaling narrows impact compared with process-name or host-wide cleanup.

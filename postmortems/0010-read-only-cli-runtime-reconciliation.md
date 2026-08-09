# 0010: Prevent read-only CLI runtime reconciliation from mutating active jobs

- Type: Incident
- Status: Resolved
- Severity: High
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: AgentKnot 0.0.1 through `3e3fb30`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [README](../README.md)

## Summary

While an AgentKnot orchestration was running in one process namespace, a second `agentknot show` command was used as a read-only status check. CLI startup called `createRuntime()`, which unconditionally ran stale-execution reconciliation. The second namespace could not observe the executor PID, so it persisted a false `failed` terminal state for the still-running child Job. The original runtime later completed successfully and overwrote the record with its in-memory snapshot, hiding the transient failed event and demonstrating both a read-side mutation and an unsupported concurrent-writer race.

## Context

Stage 1 marks genuinely interrupted nonterminal records failed instead of pretending to resume them. The affected implementation stored a runtime ID and PID, then called `process.kill(pid, 0)` from every newly constructed runtime to decide whether the recorded executor was alive. The CLI constructed a full runtime before dispatching read-oriented commands such as `show`, list, artifact inspection, routes, delegation inspection, and doctor.

## Expected invariant

A read-only status or artifact inspection must not change Job or Orchestration state. This incident is resolved when those paths have no recovery authority. Before AgentKnot can support multiple execution-owning runtimes, startup recovery must also avoid treating namespace-local PID absence as globally authoritative and concurrent writers must not silently overwrite each other's terminal evidence.

## Severity, impact, and terminal state

- Severity: High — control-plane state correctness and single-writer violation.
- Child Job `job_4bf06b2d-a7fd-4734-ae43-037acc496895` was running under orchestration `orchestration_29f715b3-a3ed-4b88-86b3-86bd1d510716` when `agentknot show` started a second runtime.
- At `2026-08-08T22:29:44.184Z`, the second runtime persisted `job.failed` with `ExecutionInterruptedError`, `reason: runtime_restart`, and `previousStatus: running` even though the original worker was still executing.
- At `2026-08-08T22:29:54.065Z`, the original runtime persisted `job.succeeded`. The final record is succeeded and contains the verified artifact, but the transient failed event was overwritten rather than retained.
- No source mutation, credential exposure, artifact auto-application, model fallback, commit, push, merge, or deployment resulted.

## Immediate containment

No further secondary CLI status commands were run while the orchestration was active. The original orchestration session was allowed to settle, after which the child and parent both reported succeeded. Artifact listing and verification were performed only after terminal completion. Documentation temporarily warned operators to inspect active records through their existing serving HTTP runtime instead of constructing a second CLI runtime.

## Resolution

On 2026-08-09, runtime construction gained a `reconcileOnStartup` option. It defaults to `true` for TypeScript compatibility, while every read-oriented CLI path passes `false`. CLI `run`, `orchestrate`, and a parameter-valid `serve` remain execution owners and pass `true`; invalid `serve` arguments fail before runtime construction.

The regression suite launches separate CLI processes against stale Job and Orchestration fixtures and verifies byte-for-byte stability after `show`, lists, artifact inspection, route/delegation inspection, both doctor modes, and invalid commands. It separately proves that `run`, `orchestrate`, and a short-lived real server on an ephemeral port retain startup recovery. The full suite passes 78/78. This closes the read-side mutation path without claiming safe concurrent execution owners, namespace-independent PID identity, leases, compare-and-set storage, or restart resume.

## Evidence and timeline

1. The formal route was Pi/OpenCode Go/`gpt-5.6-luna` with `thinkingLevel: max`; the worker had already completed its 74-test run and was preparing its final response.
2. `agentknot show job_4bf06b2d-a7fd-4734-ae43-037acc496895` invoked `createRuntime()` before reading the record.
3. `createRuntime()` called `reconcileInterruptedJobs()`. `isExecutorProcessAlive()` used `process.kill(recordedPid, 0)` from a distinct PID namespace and received an absent-process result.
4. The status command returned a snapshot whose terminal event sequence 526 was the false `job.failed` described above.
5. The original runtime then produced artifact SHA-256 `b6a2c68cbc07d60749c55d4ee479bdb81a713440b22851a403db17a04b44c9d4`, base commit `beaeeca3bfa37da4eefc2424d9fd9d08ee901f1f`, and a successful orchestration result.
6. The final child snapshot is succeeded with terminal sequence 542; it no longer contains the second runtime's failed event, proving last-writer whole-snapshot replacement rather than a serialized shared event history.

## Root cause

Runtime construction combines two responsibilities: opening stores for reads and performing destructive startup recovery. PID liveness is process-namespace-local evidence, but the reconciliation logic treats `ESRCH` as globally authoritative. File stores allow separate runtimes to write whole snapshots without a lease or cross-process single-writer guard, so the false recovery and real completion raced.

## Alternatives considered

### Treat the final success as proof that no bug exists

Rejected. The persisted record was observably false for approximately ten seconds, and the later overwrite erased conflicting terminal evidence instead of resolving it transactionally.

### Make PID checks namespace-aware immediately

Deferred as a complete solution. Host PID identity, namespaces, PID reuse, start time, and remote/container execution require a broader ownership or lease contract.

### Separate read-only construction from explicit recovery

Adopted. Read-oriented CLI commands do not need startup mutation. Execution-owning entry points retain explicit fail-without-resume behavior while recovery identity and single-writer rules remain separate follow-up work.

## Consequences

- Read-oriented CLI commands now open stores without reconciliation and can inspect active records without acquiring recovery authority.
- Execution-owning CLI commands retain deterministic fail-without-resume startup behavior.
- PID liveness remains useful evidence only within its documented namespace and single-writer assumptions.
- The environment-alignment artifact from this run remained verifiable and was reviewed independently; this incident does not invalidate its content.

## What went well

The original orchestration session remained attached and returned a complete artifact, allowing integrity and base verification after terminal completion. Ordered timestamps and runtime metadata made the false transition attributable without exposing credentials or worker content.

## What did not go well

A status check assumed to be read-only invoked state-changing startup behavior. The current tests prove active PID preservation only inside one process namespace and do not exercise a second CLI runtime whose PID view differs. Whole-snapshot storage allowed the later writer to erase the conflicting event.

## Corrective actions and gates

- [x] Split runtime construction so read-oriented CLI commands never run reconciliation — deterministic cross-process CLI test — Stage 1 blocker.
- [x] Make recovery an explicit execution-owner action and document which entry points may invoke it — CLI/HTTP/TypeScript contract tests.
- [ ] Add a PID-namespace simulation or injectable liveness boundary that proves an unobservable PID is not sufficient authority for read-side mutation.
- [ ] Add cross-process single-writer protection or an equivalent compare-and-set/lease contract before claiming safe concurrent file-store mutation.
- [ ] Verify that conflicting terminal transitions cannot be silently removed by a later snapshot save.

## Deferred work

Restartable execution, durable leases, multi-process scheduling, remote workers, and distributed consensus remain outside Stage 1. The resolution narrows read-only behavior without claiming those capabilities.

## Privacy and security review

This record retains IDs, timestamps, route identity, commit IDs, and artifact hash. It omits credential values, auth-file contents, raw model reasoning, prompt bodies, and repository artifact content. The incident involved state authority rather than secret disclosure.

## Addenda

2026-08-09: [Decision 0022](./0022-file-runtime-single-writer-ownership.md) completed the PID-namespace and cross-process single-writer follow-ups through pre-reconciliation advisory ownership. A new owner no longer uses PID liveness as takeover authority, and a conforming prior owner cannot keep writing after the new owner acquires both locks. The unchecked items above are preserved as the historical state of this incident record.

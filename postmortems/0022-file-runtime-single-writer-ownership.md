# 0022: Enforce one file-runtime writer before recovery

- Type: Decision
- Status: Accepted
- Date: 2026-08-09
- Owners: Upstream controller
- Affected versions/commits: after `c832377`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [incident 0010](./0010-read-only-cli-runtime-reconciliation.md), [incident 0021](./0021-job-persistence-failure-boundaries.md)

## Summary

File-backed execution now requires one conforming owner for both canonical storage directories. `createRuntime()` acquires non-blocking kernel advisory locks before reconciliation or admission, refuses a second owner, and releases ownership after explicit close or process death. Once both locks are held, every prior nonterminal snapshot is deterministically interrupted without treating numeric PID liveness as ownership proof.

Read-only runtime construction takes no ownership and cannot call execution or reconciliation methods. This establishes the Stage 1 single-writer boundary without adding a lease, heartbeat, database, compare-and-swap protocol, or npm dependency.

## Context and evidence

Whole-snapshot atomic rename prevents partial target JSON but cannot merge concurrent read-modify-write branches. Two execution owners could previously start against the same directories; either could overwrite newer events or terminal state. Bare `process.kill(pid, 0)` also cannot distinguish PID reuse or cross-namespace visibility, and incident 0010 showed that reconciliation based on a false-negative PID observation can race the real owner.

Formal Luna/max orchestration `orchestration_5b0d84ab-46c9-4f81-af77-e9455a99c392` ran three independent read-only audits. Its children confirmed the store race, PID ambiguity, public runtime wiring, and absence of second-owner tests. All three resolved through Pi/OpenCode Go/`gpt-5.6-luna` at `thinkingLevel=max`, succeeded with checksum-valid empty artifacts, and left the source clean.

## Decision rationale

The runtime claims the real paths of the configured Job and Orchestration directories in stable lexical order. A small owned helper invokes the host `flock` command for each directory and signals only after the non-blocking lock is held. Partial acquisition is released. The helper holds the kernel lock while its parent keeps stdin open, so parent exit or crash releases ownership without stale lock cleanup or time-based expiry.

The storage directories must be distinct. One-shot CLI commands close after their terminal result, failed server listen closes immediately, and long-lived TypeScript callers call `AgentKnotRuntime.close()` after work settles. Closing while admission or completion is tracked is refused. Read-only runtimes do not acquire locks and their mutation methods refuse calls.

After exclusive ownership succeeds, a pre-existing nonterminal record cannot belong to another conforming live writer. Startup therefore applies the existing fail-without-resume result regardless of the record's PID. PID and runtime ID remain audit evidence; neither is a fencing token.

## Alternatives considered

- Documentation-only “multi-process unsupported” was rejected because the second process would still mutate state before discovering the mistake.
- PID lockfiles were rejected because crash cleanup, PID reuse, namespaces, and two-contender stale-lock reclamation require unsafe guesses or a lease.
- Heartbeats and expiring ownership were rejected as leases outside Stage 1.
- A database, journal, CAS generation, native lock addon, or third-party lock package was rejected as disproportionate implementation and dependency growth.
- Locking only the configuration file or Job directory was rejected because different configs can share either store.

## Consequences and limits

- A second conforming owner fails before reconciliation, worktree creation, Job admission, or HTTP listen.
- Same-process duplicate `createRuntime()` and cross-process duplicate `serve` are both refused; read-only inspection remains concurrent.
- A killed server releases its locks and a replacement owner starts normally.
- `flock` is now a host runtime requirement for execution-owning file-backed `createRuntime()` paths; missing helper startup is a clear `RuntimeOwnershipError`. Direct in-memory construction is unaffected.
- Advisory locks cannot stop a hostile or custom writer that ignores them. Manual construction with file stores remains responsible for the same single-writer invariant.
- Lock ownership prevents supported writer races but does not add stable-storage `fsync`, resume, cross-file transactions, or cleanup of crash-left worker descendants/worktrees.
- Unexpected helper loss is detected before later runtime operations; it is not a general fencing protocol for arbitrary external writers.

## Corrective actions and gates

- [x] Acquire canonical directory locks before startup reconciliation or admission.
- [x] Refuse partial, duplicate, missing-helper, and lost-helper ownership clearly.
- [x] Make read-only runtime construction a non-mutating capability boundary.
- [x] Make ownership release explicit and refuse release while tracked work is active.
- [x] Prove second-owner refusal and `SIGKILL` release/restart through the real CLI `serve` path.
- [x] Prove prior queued/running Job and parent records fail once under exclusive recovery without PID authority.
- [ ] Complete the broader Stage 1 crash-state/resource soak.

## Privacy and security review

Locks are held on canonical local storage directories and contain no prompt, model output, credential, callback, or artifact content. The helper receives only directory paths and the current Node executable. It is exact-child local process coordination, not an OS sandbox or hostile-writer defense.

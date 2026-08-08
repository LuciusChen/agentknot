# 0005: Serialize concurrent job event persistence

- Type: Incident
- Status: Resolved
- Severity: High
- Date: 2026-08-08
- Owners: AgentKnot maintainers
- Affected versions/commits: AgentKnot 0.0.1 through `3474c5f`
- Related: [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [automatic delegation decision](./0004-bounded-automatic-delegation.md)

## Summary

The first real parallel self-orchestration found that concurrent worker event emissions could race while mutating and saving one file-backed Job record. `FileJobStore` also reused one deterministic temporary filename per job. A burst adapter reproduced failed renames with `ENOENT`, and concurrent event sequence assignment had no per-job serialization guarantee.

The fix serializes event append/save mutations per job and gives every snapshot write a unique temporary filename. A deterministic 100-event burst test now proves terminal success, gap-free sequences, complete persisted events, and no leftover temporary files.

## Impact

A worker adapter with concurrent event sources, including a protocol adapter reading stdout and stderr concurrently, could make an otherwise correct job fail during persistence. Depending on interleaving, the persisted snapshot could also lose event ordering evidence. The first real four-worker self-orchestration itself completed, but the delegated review reproduced the store race separately and showed that the documented concurrency contract was incomplete.

No credential exposure, source-workspace mutation, automatic artifact application, or released version was involved.

## Expected invariant

- Event sequence numbers for one job are gap-free and assigned in persisted order.
- Every event snapshot is saved before live observation.
- Concurrent adapter event sources cannot corrupt or race the file replacement path.
- Successful worker execution is not converted to failure by an avoidable same-process snapshot race.

## Evidence and timeline

1. Self-orchestration `orchestration_da237ca1-440d-4071-a5bc-e782faadf011` ran four real Luna workers concurrently.
2. Test-gap worker `job_6565c67a-aecb-4566-adeb-74b71e0b3c82` inspected `Orchestrator.#appendEvent`, the Pi stdout/stderr tasks, and `FileJobStore.#write`.
3. Its read-only reproduction emitted 100 events with `Promise.all()` against the file store; repeated runs failed with `ENOENT` while renaming the shared temporary file.
4. The primary controller reproduced the ownership problem from code, added per-job mutation serialization and unique temporary names, and added a deterministic public-path regression test.

## Root cause

`Orchestrator.#appendEvent()` mutated the shared in-memory `job.events` array and saved immediately without a per-job critical section. `FileJobStore.#write()` used `${jobPath}.${pid}.tmp`, so two saves for the same job wrote and renamed the same temporary path. Atomic rename protects replacement of the target snapshot; it does not serialize writers or make a shared temporary filename safe.

The orchestration parent path already had a per-record mutation queue and unique temporary filenames, but that invariant had not been carried back to the older leaf Job path.

## Corrective actions and gates

- [x] Serialize every leaf event append/save mutation per job.
- [x] Use a UUID in every `FileJobStore` temporary filename.
- [x] Add a 100-event concurrent adapter regression test using the public `Orchestrator.run()` path and `FileJobStore`.
- [x] Assert terminal success, exact event count, gap-free sequence numbers, snapshot equality, and no `.tmp` files.
- [x] Keep multi-process writes explicitly unsupported; same-process serialization is not a filesystem lock or compare-and-swap protocol.

The same self-review also found that planner executions were outside the global worker semaphore and that parent persistence failure could orphan admitted leaf jobs. The follow-up change places planners under the shared cap and cancels/awaits admitted planners or children when parent start-evidence persistence fails.

## Deferred work

- Fault-injection coverage for permanent store failure at terminal and callback bookkeeping boundaries.
- Multi-process locking or compare-and-swap if AgentKnot later supports more than one writer.
- Bounded record sizes, retention, and redaction under the existing Stage 1 gates.

## Privacy and security review

This record includes generated IDs and control-flow evidence only. It contains no API keys, auth-file contents, repository source, or model prompt/output beyond the minimal finding summary.

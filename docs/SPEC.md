# AgentKnot technical specification

- Status: Living architecture contract
- Version: 0.1
- Last updated: 2026-08-08
- Applies to: AgentKnot 0.0.x unless a section is marked proposed

## Purpose

This document fixes the boundaries and invariants that keep AgentKnot vendor-neutral while the implementation evolves. It describes current behavior precisely and marks future contracts as proposed. Code and deterministic tests remain the final evidence for implemented behavior.

The product intent and non-goals live in [PRD.md](./PRD.md). Sequencing and promotion gates live in [ROADMAP.md](./ROADMAP.md).

## System context

```text
                   JobRequest
Codex ---------+
Claude --------+--> CLI / HTTP / TypeScript API
CI ------------+             |
custom caller -+             v
                         Orchestrator
                     /       |        \
                JobStore   route   WorkspaceManager
                               \       /
                              WorkerAdapter
                                   |
                         worker process/protocol
                                   |
                            provider / model
```

The controller, worker, provider, and model are separate concepts:

- A **controller** decides what work to request and submits it through the Job API.
- The **orchestrator** owns the job lifecycle and policies shared by every worker.
- A **worker adapter** translates one worker runtime and protocol into AgentKnot contracts.
- A **provider/model route** is configuration passed to the worker. It is not currently a standalone runtime abstraction.
- The **workspace manager** prepares and cleans attempts and captures artifacts independently of the worker.

## Boundary ownership

| Concern | Owner | Must not leak into |
| --- | --- | --- |
| Prompt, workspace, caller identity | `JobRequest` | worker-specific request types |
| Route resolution | configuration/orchestrator | controller identity branches |
| State, attempts, retry, timeout, cancellation | orchestrator | provider-specific code |
| Process startup and wire protocol | worker adapter | Job API and store |
| Provider/model flags | resolved route and worker adapter | controller-specific code |
| Worktree creation, capture, cleanup | workspace manager | worker adapter |
| Persistent snapshots | `JobStore` | live event listeners |
| HTTP transport and active-request map | HTTP server | worker protocols |
| Artifact acceptance/application | external controller or human | AgentKnot execution loop |

Moving a responsibility across this table requires a SPEC update and a decision record before implementation.

## Current public contracts

The canonical TypeScript definitions are in `src/types.ts`. Other transports and documentation must derive from or remain mechanically checked against that contract; one runtime payload must not acquire multiple hand-maintained definitions.

### `JobRequest`

| Field | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | Non-empty worker instruction |
| `workspace` | yes | Existing directory, normalized to an absolute path |
| `route` | no | Configured route name; otherwise the configured default |
| `source` | no | Opaque caller identity and audit metadata |
| `callbackUrl` | no | Trusted HTTP(S) endpoint for one terminal snapshot delivery attempt |
| `metadata` | no | Controller-owned metadata intended to remain JSON-compatible across file and HTTP transports |

`source` must never alter route selection or execution logic.

The HTTP boundary currently validates `metadata` only as a non-null object. Stricter JSON-value validation is required before AgentKnot can claim identical metadata fidelity across every entry point.

### `ResolvedRoute`

A route snapshot contains:

- route name;
- worker name;
- provider name;
- model name;
- optional thinking level;
- required environment-variable names;
- maximum attempts;
- per-attempt timeout.

The resolved snapshot is stored with the job. Configuration changes after admission do not mutate it.

The current provider/model fields describe how the selected worker should run. They do not prove that AgentKnot has a provider adapter, validates the provider catalog, or can move a live job between providers.

### `WorkerAdapter`

The current minimum worker contract is:

```ts
interface WorkerAdapter {
  readonly name: string;
  doctor(route: ResolvedRoute): Promise<WorkerHealth>;
  run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult>;
}
```

The adapter owns:

- availability checks specific to its runtime;
- translation from resolved route settings to worker startup/protocol input;
- strict decoding of worker output;
- normalization of worker activity into AgentKnot worker events;
- worker-process termination when its implementation supports cancellation.

The adapter does not own job state transitions, retries, attempt numbering, workspace isolation, artifact capture, callback delivery, or persistence.

### Workspace modes

`none` passes the supplied directory directly to the worker. It offers no isolation and currently produces no Git patch artifact.

`git-worktree`:

1. resolves the containing Git repository and requested subdirectory;
2. requires a valid `HEAD` and a clean tracked and non-ignored worktree/index;
3. records the base commit before execution;
4. creates a detached managed worktree for each attempt at that same base;
5. gives the worker the corresponding subdirectory in the managed worktree;
6. captures tracked, non-ignored untracked, binary, and worker-committed changes as a binary Git patch;
7. records artifact path, attempt, size, SHA-256, and base commit;
8. removes only the exact worktree owned by that attempt.

Ignored dependencies and build output are not present in a detached worktree. The worker must provision any required ignored state. Worktree mode protects Git repository state; it does not isolate host files, processes, credentials, or networks.

### Job store

`MemoryJobStore` provides process-local snapshots.

`FileJobStore` writes a complete JSON snapshot to a temporary file with mode `0600` and atomically renames it over the job path. It provides persistent audit snapshots under the assumptions of one AgentKnot process and a local filesystem with normal rename semantics.

Current persistence does not provide:

- `fsync` durability guarantees;
- a journal or event log independent of snapshots;
- multi-process locking or compare-and-swap updates;
- schema migration;
- restartable execution or automatic reconciliation;
- retention, compaction, or record-size limits.

A record left `queued` or `running` after process failure remains historical evidence. The current runtime does not resume it.

## Job lifecycle

### State machine

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
```

`queued` currently means the request has been admitted and persisted. Execution starts immediately; there is no capacity scheduler, dispatch queue, lease, or backpressure mechanism.

Retries remain inside one `running` job:

```text
attempt 1 failed -> job.retrying -> attempt 2
```

Every attempt increments `job.attempt`. In Git worktree mode, every retry starts from the recorded base commit rather than inheriting prior-attempt edits.

### Ordering invariants

For one job:

1. The initial job snapshot is created before `job.queued` is appended.
2. Event sequence numbers start at one and increase by one.
3. An event is appended to the snapshot and the snapshot is saved before the live `onEvent` listener receives it.
4. State fields are changed before the corresponding lifecycle event is saved.
5. A terminal event is saved before `completion` resolves.
6. Artifact capture and cleanup happen before the attempt outcome is finalized.
7. Callback bookkeeping happens after terminal execution and does not change execution status.

The current `onEvent` listener is awaited. If it rejects, that error can affect execution. This coupling is a known limitation; live observation is intended to become advisory, but that change is proposed rather than current behavior.

### Terminal semantics

A succeeded job has `result`, terminal timestamps, resolved route evidence, attempt count, and any captured artifacts.

A failed or cancelled job has `error`, terminal timestamps, attempt count, ordered events, and any artifacts captured from failed attempts.

Cancellation is cooperative at the `WorkerAdapter` boundary. The orchestrator aborts the attempt signal and rejects a normal worker result received after abort. A custom adapter that never settles and ignores the signal can currently prevent completion indefinitely. The Pi adapter owns termination of the Pi child process.

A timeout aborts the same attempt signal. It is not a universal hard kill independent of adapter behavior.

### Callback semantics

When `callbackUrl` is supplied, AgentKnot currently:

- makes one HTTP POST after terminal execution;
- sends the complete job snapshot as JSON;
- waits at most ten seconds for the request;
- records delivery boolean, HTTP status, or error;
- does not sign, authenticate, retry, deduplicate, or allowlist the request;
- never converts a succeeded job to failed because callback delivery failed.

Callbacks are for trusted local controllers until a later security contract passes its roadmap gate.

## Events

Current lifecycle event types are:

- `job.queued`
- `job.started`
- `job.retrying`
- `job.succeeded`
- `job.failed`
- `job.cancelled`
- `job.artifact`

Current normalized worker event types are:

- `worker.started`
- `worker.text.delta`
- `worker.tool.started`
- `worker.tool.updated`
- `worker.tool.completed`
- `worker.retry.started`
- `worker.retry.completed`
- `worker.raw`
- `worker.stderr`

Core consumers may depend on the normalized event name, job ID, sequence, timestamp, and JSON-compatible data. They must not depend on an undocumented Pi RPC payload hidden inside `worker.raw`.

`worker.raw`, text deltas, prompts, tool data, and result output are currently stored without a global size or retention policy. They may contain sensitive user or repository content. No document may imply automatic redaction until that feature exists and is verified.

Pi RPC is strict LF-delimited JSONL. Its adapter must decode streaming UTF-8 explicitly and must not assume that process chunks align with JSON messages or use Node `readline` behavior as its protocol definition.

## HTTP surface

Current endpoints are:

```text
POST /v1/jobs
GET  /v1/jobs
GET  /v1/jobs/:id
GET  /v1/jobs/:id/events
POST /v1/jobs/:id/cancel
GET  /v1/routes
GET  /health
```

`POST /v1/jobs` starts execution in the serving process and returns `202` with the admitted snapshot.

Cancellation uses a process-local active-job map. After a server restart, a persisted nonterminal record is not an active cancellable execution.

`GET /health` is currently a liveness response for the HTTP process. It does not validate storage, routes, credentials, workers, or provider availability. Route-specific readiness is exposed by the CLI `doctor` command; it is not currently an HTTP endpoint.

There is no authentication, authorization, TLS termination, CORS policy, rate limiting, admission limit, or untrusted-network security contract. The server should remain bound to trusted local interfaces unless an external trusted proxy supplies those controls.

## Safety and secrets

### Enforced intent

- Credentials stay in environment variables or Pi's external credential store.
- Configuration declares required environment-variable names, not their values.
- AgentKnot does not intentionally copy API keys or auth-file contents into job records.
- Managed worktree cleanup targets an exact path created and owned by AgentKnot.
- Git patch artifacts are never applied automatically.

### Explicit limitations

- Prompts, model output, stderr, tool arguments/results, patches, and controller metadata may themselves contain secrets.
- A worker has the operating-system permissions of its process.
- Worktree isolation is not a filesystem, process, credential, or network sandbox.
- Callback URLs can cause outbound requests from the AgentKnot host and receive the full job snapshot.
- The current system has no retention or automatic redaction policy.

## Capability evolution

AgentKnot does not yet expose a capability registry. Before adding one, each capability must describe behavior already implemented and tested, not an aspiration.

A future worker capability contract may need to distinguish:

- structured versus inferred events;
- cooperative cancellation versus process-supervised termination;
- session resume;
- active follow-up input;
- file-change evidence;
- terminal visualization;
- approval requests;
- usage and model-resolution evidence.

This list is a design prompt, not a declaration that current workers support those capabilities.

Runtime selection and provider fallback must be completed before a job starts. A started attempt must not silently switch runtime, worker, provider, or model unless a future explicit policy records a new attempt and the exact reason.

## Compatibility and schema rules

- Public runtime input must be validated at its transport boundary.
- Existing job snapshots must retain their resolved route and event meaning.
- New optional fields may be added compatibly; changing state or event semantics requires a versioned contract and migration decision.
- One wire payload should have one canonical type/schema. HTTP, CLI, callbacks, and TypeScript APIs must not describe the same payload independently without a mechanical compatibility check.
- Worker-specific fields belong in adapter-owned metadata or raw evidence, not in the controller-neutral top-level contract.
- Removal or renaming of public states, event types, artifact fields, or endpoint semantics requires an explicit migration plan.

## Verification requirements

Any change to a stable contract must include deterministic evidence at the owning boundary.

At minimum, the conformance suite must eventually prove:

- controller source neutrality and independent route resolution;
- route snapshot immutability;
- valid and invalid request/configuration handling;
- gap-free persisted event order and persist-before-live delivery;
- terminal state behavior for success, failure, retry, cancellation, and timeout;
- callback failure isolation;
- adapter decoding of split UTF-8, split JSONL frames, malformed frames, premature exit, and terminal settlement;
- clean source repositories and independent retry worktrees;
- patches for tracked, non-ignored untracked, binary, and worker-committed changes;
- artifact checksum and base-application validity;
- exact cleanup on success, failure, retry, timeout, and cancellation;
- documented crash/restart behavior;
- supported concurrency and record-size limits once those claims exist.

Passing a unit test for an internal helper is not sufficient when a public transport, worker process, Git lifecycle, or persistence boundary changed.

## Architecture change test

Before changing this specification, answer:

1. Is the new behavior needed for the product thesis in [PRD.md](./PRD.md)?
2. Which boundary owns the behavior?
3. Can the change be made through an adapter or policy without changing the core contract?
4. What current behavior becomes incompatible?
5. Which deterministic contract test and real-worker soak prove the change?
6. Which roadmap gate prevents premature promotion?
7. Does the decision require a new immutable record under [`postmortems/`](../postmortems/README.md)?

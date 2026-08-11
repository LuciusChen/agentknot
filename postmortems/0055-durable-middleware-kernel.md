# 0055: Replace process ownership with a durable middleware kernel

- Type: Incident / Architecture Decision
- Status: Accepted / In progress
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Affected versions/commits: `201c984` and earlier file-runtime implementations
- Related: [0001](./0001-vendor-neutral-control-plane.md), [0022](./0022-file-runtime-single-writer-ownership.md), [0038](./0038-shared-local-controller-runtime.md), [0040](./0040-product-owned-local-service-discovery.md), [0053](./0053-controller-owned-planning-handoff.md), [0054](./0054-portable-service-lifecycle.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Incident

AgentKnot's shared HTTP server made concurrent controller sessions usable only while one exact process stayed alive. The server kept active completion and cancellation handles in process-local maps, while the runtime held lifetime-exclusive locks for both snapshot directories. A second process could read records but could not continue execution; an execution-owning restart marked every nonterminal Job and Orchestration failed with `runtime_restart`.

That design produced several visible failures: a status read from another process could destroy active work before the read-only boundary was corrected; resumed controllers depended on endpoint discovery and an externally supervised process; waiting could distinguish transport loss from progress only while the admitting process retained its Promise; and portable installation became entangled with systemd/launchd even though operating-system service management is not AgentKnot's product boundary.

## Invariants retained

- AgentKnot remains vendor-neutral orchestration middleware between replaceable controllers and replaceable worker/provider/model routes.
- The upstream controller owns intent, semantic planning, decomposition, acceptance criteria, product decisions, and artifact integration.
- AgentKnot owns strict admission, deterministic policy and routing, scheduling, isolation, lifecycle, durable evidence, completion, and notification.
- Workers and reviewers produce bounded evidence only. They cannot apply, commit, merge, push, deploy, or promote artifacts.
- Controller, transport, worker, provider, and model identities are data or adapters, never privileged branches in the kernel.

## Decision

1. Introduce one versioned controller handoff contract. The current strict `OrchestrationRequest` and controller-authored `TaskAssessment` are its v1 payload; no second planner request or controller-specific schema is added.
2. Make one orchestration kernel the only application-level implementation. CLI, HTTP, TypeScript, future MCP, and controller plugins are adapters over that kernel rather than independent lifecycle owners.
3. Replace directory-lifetime ownership and process-local authority with durable records, append-only sequenced events, idempotent admission, and renewable execution leases carrying fencing generations. In-memory handles may accelerate a live process but never decide whether durable work exists or can be observed.
4. Treat `queued`, `running`, `waiting`, `disconnected`, `lost`, and terminal outcomes as distinct facts. Transport disconnection does not change execution state. Lease expiry produces explicit lost/recovery evidence; a new process must not fail healthy work merely because it opened the store.
5. Persist enough state to reclaim admitted work. Recovery starts a new fenced execution attempt from the last durable boundary; it does not pretend to reattach to an arbitrary worker process unless that worker adapter explicitly supports resume.
6. Deliver completion and progress from persisted event cursors. Callback, long-poll, SSE, and future native controller wakeups are notification transports, not state authority, and all are resumable/idempotent at the middleware boundary.
7. Keep deployment non-invasive and cross-platform. Foreground execution, an application-managed local process, containers, and optional native service managers may host the same kernel, but correctness must not require `.zshrc` edits, systemd, launchd, Unix-domain sockets, or a particular controller lifecycle.
8. Keep automatic delegation capability-based. A prompt hook may perform only bounded workspace/policy discovery and inject an obligation. Deterministic automatic submission requires a controller-native lifecycle callback that can supply the controller-authored assessment; otherwise the compatibility adapter is explicitly best-effort and never moves planning into AgentKnot.
9. Delete the file-runtime lock, process-local wait authority, and superseded service/discovery compatibility code after parity gates pass. Do not preserve two production schedulers or two authoritative stores.

## Why this preserves the middleware boundary

Durability does not make AgentKnot a controller or an agent-chat product. It makes the already-owned execution responsibilities reliable across client sessions and process lifetimes. The controller still decides what bounded work should exist. AgentKnot accepts that structured decision, records it, executes configured routes, and returns evidence. Relay-style agent communication may remain an optional transport integration; it is not the orchestration kernel or planning authority.

## Consequences

- Multiple controller sessions and replaceable entry transports can share durable work without sharing a process-local Promise.
- A service manager becomes an optional hosting choice, not a correctness prerequisite or controller-installation side effect.
- Recovery semantics become explicit and testable, but require transactional storage, fencing, idempotency, and scheduler work before the old ownership path can be removed.
- Existing JSON snapshots remain readable during the cutover. They are not a permanent second write path; the migration gate requires one authoritative durable store and removal of stale compiled/test output.
- Route capacity must eventually be computed from durable active leases, not one process's counters, before multiple execution hosts may claim production support.

The first foundation review exposed five correctness gaps before commit: cancellation could race into success, released leases reused fence `1`, record admission and first lease were separate transactions, legacy filenames could disagree with payload identity, and in-process wait races left timeout timers alive. The corrected foundation now atomically admits record/idempotency/first lease, rejects success after accepted cancellation, retains an inactive lease row so later claims increment the fence, validates migration identity, and uses durable polling without detached wait timers. Job and Orchestration lease/cancellation mechanics share one lifecycle owner rather than duplicated loops.

## Rejected alternatives

### Keep one supervised server forever

Rejected as the correctness model. It centralizes process lifetime but leaves execution authority and waits in memory, makes native service setup part of normal use, and cannot provide fenced recovery.

### Add more hook retries or shell configuration

Rejected. Hooks are controller-edge adapters, not schedulers or daemon managers. More retry and discovery branches increase coupling without repairing state authority.

### Move planning or review conversations into AgentKnot

Rejected. It duplicates controller reasoning, consumes downstream calls before a valid handoff, and changes middleware into an agent collaboration product.

### Preserve the file store and bolt on a second queue database

Rejected as the end state. Snapshot plus append-only event projections may coexist inside one transactional store, but two independent authorities would create split-brain behavior and implementation bloat.

## Gates

- [x] Record the controller/kernel/adapter responsibility boundary and supersede the affected single-owner conclusions in 0022, 0038, 0040, and 0054.
- [x] Define versioned handoff, event cursor, lease, fencing, idempotency, and recovery contracts in the SPEC.
- [x] Add one transactional local durable store with append-only events and atomic state transitions.
- [ ] Reclaim queued work and expire/recover running work without false success or false healthy-runtime failure.
- [x] Make wait/cancel/status derive authority from durable state and events rather than HTTP process maps.
- [ ] Converge CLI, HTTP, TypeScript, MCP, and controller adapters on the same kernel contract.
- [ ] Prove two independent controller sessions, process restart, duplicate admission, stale lease, late completion, cancellation, and cursor resume deterministically.
- [ ] Remove lifetime directory ownership, process-local authority, required native-service setup, and superseded hook/discovery paths after parity.
- [ ] Re-run same-task upstream/downstream token and completion-quality measurements after the new handoff path is stable.

## Privacy and security review

The durable store contains controller-authored prompts/assessments, worker events/output, route identities, process/lease metadata, and artifact identities. Existing byte bounds and mode-0600 local storage remain required. Lease owner IDs and idempotency keys must be opaque, bounded, non-secret identifiers; they must not embed provider credentials or controller transcripts. A local durable kernel does not itself provide remote authentication or a hostile-process sandbox.

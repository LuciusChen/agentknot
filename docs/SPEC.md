# AgentKnot technical specification

- Status: Living architecture contract
- Version: 0.1
- Last updated: 2026-08-14
- Applies to: AgentKnot 0.0.x unless a section is marked proposed

## Purpose

This document fixes the boundaries and invariants that keep AgentKnot vendor-neutral while the implementation evolves. It describes current behavior precisely and marks future contracts as proposed. Code and deterministic tests remain the final evidence for implemented behavior.

The product intent and non-goals live in [PRD.md](./PRD.md). Sequencing and promotion gates live in [ROADMAP.md](./ROADMAP.md).

## System context

```text
             JobRequest / OrchestrationRequest
Codex ---------+
Claude --------+--> CLI / HTTP / TypeScript API
CI ------------+             |
custom caller -+             v
                 OrchestrationService / Orchestrator
                       |          /       |        \
              policy + plan  JobStore   route   WorkspaceManager
                       |                     \       /
             OrchestrationStore             WorkerAdapter
                                   |
                         worker process/protocol
                                   |
                            provider / model

upstream controller -> WorkOrderService -> WorkOrderStore
                              |
                              +-- bind identity of an already admitted Job

upstream controller -> CandidateService -> CandidateStore
                              |
                              +-- read-only WorkOrder/Job validation

upstream controller -> ReviewService -> ReviewStore
                              |
                              +-- read-only Candidate validation

upstream controller -> DispositionService -> DispositionStore
                              |
                              +-- read-only Candidate/Review validation
```

The controller, worker, provider, and model are separate concepts:

- A **controller** owns intent, planning, decomposition, and product decisions, then submits a leaf request or strict orchestration assessment.
- The **orchestration service** validates a controller-authored assessment, applies deterministic delegation policy, persists the plan, and submits selected children through the Job API.
- The **orchestrator** owns the job lifecycle and policies shared by every worker.
- A **worker adapter** translates one worker runtime and protocol into AgentKnot contracts.
- A **provider/model route** is configuration passed to the worker. It is not currently a standalone runtime abstraction.
- The **workspace manager** prepares and cleans attempts and captures artifacts independently of the worker.
- A **WorkOrder** is an immutable command root above execution. It may reference one already admitted executor Job identity but does not create or control that Job.

## Boundary ownership

| Concern | Owner | Must not leak into |
| --- | --- | --- |
| Immutable user command, WorkOrder issue, and purpose-specific executor Job identity binding | `WorkOrderService` and `WorkOrderStore` | Job admission/lifecycle, Orchestration state, or acceptance inference |
| Immutable, status-free Candidate evidence, read-only WorkOrder/Job validation, and exact recorded artifact identity binding | `CandidateService` and `CandidateStore` | WorkOrder/Job status or lifecycle, Review, Disposition, acceptance, artifact application, or promotion |
| Immutable, status-free Review evidence, read-only Candidate validation, and bounded findings | `ReviewService` and `ReviewStore` | Candidate/WorkOrder/Job/Orchestration records or statuses, orchestration quality-review evidence, Disposition, acceptance, discard, artifact application, or promotion |
| Immutable, status-free final Candidate decision, read-only Candidate/Review validation, deterministic one-per-Candidate identity, and accept/discard conflict semantics | `DispositionService` and `DispositionStore` | Candidate/Review source records or statuses, orchestration quality-review verdicts, artifact mutation, application, promotion, commit, merge, or push |
| Native command/Skill presentation, stateless `SessionStart` obligation, and controller-specific audit `source` | controller integration adapter | orchestration policy, routes, worker adapters, or artifact promotion |
| Parent task, assessment, workspace, caller identity | upstream controller and `OrchestrationRequest` admission | controller-vendor branches, worker-specific request types, or middleware model planning |
| Delegation mode, task-kind policy, child/depth/concurrency caps, and optional human-authored route-selection policy | orchestration service/configuration | controller-vendor branches or worker adapters |
| Assessment validation and deterministic plan composition | orchestration service | controller/model discretion at dispatch time |
| Parent policy/plan/events/child provenance | `OrchestrationStore` | leaf `JobStore` semantics |
| Route resolution | configuration/orchestrator | controller identity branches |
| Job state, whole-worker attempts, timeout, cancellation | orchestrator | provider-specific code |
| In-session downstream request retry and settled-failure disposition | worker adapter | route fallback or controller policy |
| Process startup and wire protocol | worker adapter | Job API and store |
| Provider/model flags | resolved route and worker adapter | controller-specific code |
| Worktree creation, capture, cleanup | workspace manager | worker adapter |
| Persistent snapshots | `JobStore` | live event listeners |
| HTTP transport and active-request map | HTTP server | worker protocols |
| Cursor-follow event batches and compact wait activity | durable subscription kernel plus a route-neutral projection; private frame normalization remains in worker adapters | controller resume semantics, task resubmission, provider-health inference, or private tool payloads |
| Shared local execution ownership for concurrent controller clients | one independent broker runtime | controller packages, MCP/CLI clients, or additional file-store writers |
| Explicit local broker lifecycle | `broker run|up|status|down` around the same compiled entry, with exact instance identity | kernel semantics, controller policy, OS service configuration, shell profiles, or worker credentials |
| Artifact listing, verification, and preview | orchestrator/workspace manager | worker adapter or execution loop |
| Terminal completion summary and provenance ordering | orchestrator with workspace-manager artifact evidence | worker adapter/provider claims |
| Child artifact path-overlap review | orchestration service using terminal Job evidence | worker/controller claims or semantic diff parsing |
| Optional artifact validation and disposable validation worktree | orchestration service with orchestrator/workspace manager | worker/reviewer claims, source-tree promotion, or worker adapters |
| Persisted usage aggregation and complete/partial/unavailable semantics | read-only runtime usage projection | worker adapters, controller transcript parsing, route re-evaluation, or pricing normalization |
| Artifact acceptance/rejection and final Candidate decision | external controller or human through the explicit Disposition API when recording is desired | Job/Orchestration terminal state or artifact mutation |
| Artifact promotion/application | external controller or human | AgentKnot execution loop |

Moving a responsibility across this table requires a SPEC update and a decision record before implementation.

## Stage 3 durable-kernel contract

This section is the accepted Stage 3 contract. It supersedes the controller-owned process and native-service conclusions in decisions 0022, 0038, 0040, and 0054 as recorded by decisions 0055 and 0057. Transactional records are durable state authority; one independent broker remains the local scheduler owner, and fenced leaf/parent recovery resumes admitted work after broker restart.

### Controller handoff v1

The versioned controller handoff is the existing `OrchestrationRequest` plus its strict `TaskAssessment`, not a new planner payload. `assessment.schemaVersion: 1` is the handoff schema version for 0.0.x. The controller authors intent, decomposition, complexity, task kinds, independence, and acceptance criteria. AgentKnot validates and records that evidence, then applies configuration-owned deterministic policy and routing. No controller adapter, transport, or middleware model may synthesize a semantic assessment from the raw prompt.

The optional schemaVersion 1 `TaskAssessment.context` is the controller-authored `ContextManifest`; the compatibility name `TaskContext` refers to the same structure. Its existing `summary`, `relevantPaths`, and `constraints` remain required when the manifest is present. Optional `references` contain exact bounded objects with required `id`, `kind`, `locator`, `source`, and `trust: "unverified"`, plus optional `revision`, `sha256:<lowercase-hex>` `digest`, and `summary`. Reference IDs are unique within the manifest, all strings reject control characters, and the complete serialized manifest remains within the existing 2 KiB limit. Validation returns fresh objects, admission persists and plan-hashes the metadata, and child prompt construction projects it once. A `workspace-file` locator must be a portable repository-relative forward-slash path with non-empty segments and no dot, parent, absolute, drive, or backslash form. Prompt construction labels those references as selectively readable with ordinary workspace tools and requires content to be read before it becomes evidence; all other kinds remain metadata-only and must not be resolved. This grants no tool capability, prevents no ordinary workspace listing/search, verifies no locator or content, and is not a sandbox boundary. TypeScript, HTTP, CLI, and MCP accept the same manifest contract. References remain explicitly controller-authored; no transport or core path generates them from `relevantPaths` ([experiment/decision 0082](../postmortems/0082-real-repository-selective-context-gate.md)).

The optional additive `idempotencyKey` is a bounded opaque controller/caller identity for one intended admission. Reusing the same scoped key with the same canonical request returns the original durable identity; reusing it with a different request is a conflict. It does not grant route, depth, or promotion authority and must not contain credentials or a transcript.

### Durable state and events

One transactional local store is authoritative for each durable record kind. A successful transition atomically commits:

- a bounded materialized record projection;
- a monotonically increasing compare-and-swap revision;
- the new append-only event suffix with gap-free per-record sequence numbers.

Persisted events cannot be removed or rewritten. Readers resume after a sequence cursor and may reconstruct or validate a projection from the log. Live listeners, long-poll, SSE, callback, and controller wakeups may accelerate delivery only after commit; none is state authority. Two store instances attempting to save the same prior revision cannot silently overwrite each other.

The implemented persistence foundation is `SqliteDurableRecordStore`: it uses one mode-0600 local SQLite database, WAL, `synchronous=FULL`, bounded record serialization, atomic projection/event transactions, and compare-and-swap revisions. WorkOrder, Candidate, Review, and Disposition persistence reuse that projection/event transaction without execution leases, cancellation, or idempotent admission. Candidate creation atomically writes one immutable Candidate projection and its `candidate.created` event, but its read-only WorkOrder/Job validation occurs before that write in separate stores and is not part of a cross-store transaction. Review creation likewise atomically writes one immutable Review projection and its `review.created` event after a separate read-only Candidate existence check. Disposition recording atomically writes one deterministic Candidate-derived immutable projection and its `disposition.recorded` event after separate read-only Candidate/Review validation; create races are re-read and classified by the domain service, while the generic persistence layer remains domain-error-free. None of these domain paths has cross-store recovery or reconciliation. Production `createRuntime()` uses the same foundation with the additional scoped idempotency, cancellation, and execution-lease operations for Job and Orchestration records and imports only legacy JSON snapshots whose filename identity matches the record, without rewriting or deleting them. Job/Orchestration admission commits record, first event, optional idempotency mapping, and first lease atomically. Accepted cancellation fences a concurrent success transition. Leaf recovery replays integrity-checked admitted input after a higher fence is claimed. Dispatching parents persist their controller-authored plan and immutable input before execution; recovery reclaims that exact plan, adopts identity-matching existing children/reviewers, admits only missing deterministic children, and marks interrupted command validation unavailable instead of pretending to reattach. Historical planning/no-plan records fail explicitly.

### Execution leases and fencing

An execution lease contains opaque `ownerId`, positive monotonically increasing `fence`, acquisition time, heartbeat time, and expiry time. Claim, renew, and release are transactional compare-and-swap operations:

- an unexpired lease cannot be claimed by another owner;
- the same owner may renew only its current unexpired fence;
- after expiry or explicit release, a new claim receives a strictly larger fence;
- stale owners cannot renew, release, append execution effects, or publish terminal completion after a newer fence exists.

Lease expiry means ownership evidence was lost; it does not by itself mean the task failed or the client disconnected. Recovery may reclaim the last durable boundary as a new fenced attempt. AgentKnot must not claim that it reattached to an arbitrary child process unless the selected worker adapter exposes and passes an explicit resume contract.

### Kernel and adapter convergence

One orchestration kernel owns admission, deterministic policy/routing, scheduling, durable transitions, isolation, cancellation intent, completion, and artifact evidence. TypeScript may call it directly; CLI and HTTP expose it; `agentknot mcp` is a stdio client over the selected broker. Controller packages and native Skills are optional presentation edges; each package has one identical stateless `SessionStart` obligation for `startup`, `resume`, `clear`, and `compact`, and no `UserPromptSubmit` hook. Entry transports do not own a second scheduler, state machine, route policy, or active-work truth.

Correctness does not require a shell-profile edit, systemd, launchd, a Unix-domain socket, or one controller process. `broker run` hosts the foreground kernel; `broker up` explicitly launches that same entry as an application-managed process and waits for exact readiness. A failed or concurrent losing startup supervises only its exact spawned child through bounded termination and confirmed exit before returning. Containers and external supervisors may host `broker run`, but AgentKnot installs no OS service definition. Controller-native Skills describe the strict handoff and common MCP/CLI/HTTP operations, while the narrow `SessionStart` obligation avoids per-prompt hidden-context injection.

### Migration gates

The durable store is the production record/event authority after deterministic duplicate admission, append conflict, stale writes, lease renew/reclaim/fencing, same-ID wait/cancel, cancellation/success races, cursor resume, FIFO Job-capacity admission, and leaf/parent restart recovery. A process-level hard-kill gate proves one parent adopts the same child at its next attempt without duplicate Job admission. CLI/HTTP/TypeScript and the MCP client converge on the same broker contract; two controller-labelled clients and one long-lived MCP process share/reconnect to it. Route-pool choice and direct/child/reviewer execution capacity are durable. One broker lifetime lock is intentionally retained to prevent competing production schedulers; removing it requires a separate multi-executor recovery/configuration protocol, not merely more upstream sessions.

## Current public contracts

The canonical TypeScript definitions are in `src/work-order.ts`, `src/candidate.ts`, `src/review.ts`, `src/disposition.ts`, `src/types.ts`, and `src/orchestration-types.ts`. Other transports and documentation must derive from or remain mechanically checked against those contracts; one runtime payload must not acquire multiple hand-maintained definitions.

### `WorkOrderCommand` and executor Job binding

`WorkOrderCommand` contains a non-empty objective, normalized workspace, acceptance criteria, constraints, and an optional opaque base revision. `WorkOrderService.issue` defensively normalizes and copies that command into a new schemaVersion 1 `WorkOrderRecord` with status `issued` and sequence-one `work-order.issued`. The WorkOrder API exposes issue, get, list, and event-cursor reads but no general update operation, so the issued command cannot be silently replaced.

`bindExecutorJob(workOrderId, expectedWorkOrderRevision, executorJobId)` is the only implemented post-issue WorkOrder mutation. The caller/controller must already have admitted the named Job; WorkOrder binding does not depend on `JobStore`, validate or create the Job, start execution, or coordinate its lifecycle. Job admission and WorkOrder binding are separate operations and are not one cross-database transaction.

For an unbound issued WorkOrder, the current public event sequence is the expected revision. A successful bind atomically updates only the WorkOrder projection and appends one `work-order.executor-job.bound` event carrying the executor Job identity. Replaying the same identity returns the existing bound record without another event even when the caller repeats the original revision. A different Job identity raises a binding conflict; a stale revision before the first bind raises a stale-revision conflict. The WorkOrder command and `issued` status remain unchanged, and the Job and Orchestration records are read-only with respect to this operation.

`agentknot task` is a controller/presentation composition over those public operations, not a new domain object or state machine. It issues one WorkOrder, admits one ordinary Job, binds the returned durable Job identity, waits through the existing Job lifecycle, verifies any recorded artifacts, and reports the task intent, technical execution status, bounded result summary, captured changed paths, clearly labeled worker-reported checks, artifact-integrity outcome, and next controller action. Default output sanitizes human-visible text and omits WorkOrder/Job IDs, artifact paths, hashes, base revisions, and raw records. `--json` returns one schema-versioned presentation envelope containing the complete WorkOrder, Job when bound, and artifact-verification report when available. `agentknot task-show WORK_ORDER_ID [--json]` reopens the WorkOrder authority and uses its bound Job identity to reproduce the selected presentation after process restart. The command chooses a separate `work-orders/` directory beside configured Job storage. When a server transport is selected, WorkOrder state remains in that same controller-local configured directory while Job execution remains on the selected server; the same local configuration context is therefore required to resume by WorkOrder ID.

The developer `task` and `task-show` commands do not make WorkOrder responsible for Job lifecycle. WorkOrder issue, Job admission, and WorkOrder binding remain ordered separate transactions; a failure between admission and binding can leave an unbound WorkOrder or an independently running Job, and no reconciliation is implied. Reporting Job success, artifact integrity, or worker checks is technical evidence only and never WorkOrder acceptance. These commands create no Candidate, Review, Disposition, promotion, apply, commit, merge, or push behavior; Candidate creation is the separate explicit `task-candidate` action below.

Job terminal success is not WorkOrder acceptance. The minimal `CandidateRecord`, `ReviewRecord`, and `DispositionRecord` remain separate domain records rather than interpretations of Job/Orchestration status or advisory-review evidence. Candidate alone also has one explicit WorkOrder-rooted CLI composition; Review and Disposition remain TypeScript-only.

### `CandidateRecord` artifact evidence

`CandidateService.create` is the explicit domain creation path. It validates only persisted projections: the WorkOrder must exist and already name the requested `executorJobId`; the Job must exist; and its recorded artifacts must include a `kind: "git-patch"` entry whose `path`, `sha256`, and `baseCommit` exactly match the requested identity. The service does not require or infer a Job status, read/hash/copy artifact bytes, normalize the path, or apply the artifact.

A schemaVersion 1 `CandidateRecord` contains `id`, `workOrderId`, `executorJobId`, `artifact: { path, sha256, baseCommit }`, `createdAt`, and its append-only event list; the current record is immutable and status-free and contains no `updatedAt`. Creation emits one `candidate.created` event. `SqliteCandidateStore` wraps `SqliteDurableRecordStore` with the `Candidate` kind in a caller-selected local `agentknot.sqlite` directory and exposes create/read/list/event-cursor operations; the Candidate snapshot and event insert are atomic, while general Candidate save is rejected.

The WorkOrder and Job reads precede Candidate persistence and are separate read-only store operations, not one cross-store transaction. Candidate creation therefore does not provide validation/persistence atomicity or reconciliation across those stores. It only adds Candidate evidence and leaves WorkOrder/Job records, events, statuses, leases, and lifecycle unchanged. `agentknot task-candidate WORK_ORDER_ID [--json]` opens the sibling local Candidate store, reads the named WorkOrder and bound Job through the selected local or remote Job transport, selects the artifact for `completionSummary.attempt` with the existing result/attempt fallback, and requires both `JobStatus: succeeded` and a matching currently valid artifact-verification entry before the first Candidate write. A later sequential call returns an already matching Candidate even after restart; the read still reports current verification and exits nonzero when integrity is no longer valid. Candidate creation and the prior WorkOrder/Job/verification reads remain separate operations, while list-before-create reuse is not a concurrent exactly-once guarantee. Default output omits WorkOrder/Job/Candidate IDs, path, hash, and base commit; `--json` returns the complete records and verification evidence. There is no Candidate HTTP endpoint. Candidate is not Review or Disposition and does not decide acceptance, discard, promotion, or artifact application.

### `ReviewRecord` evidence

`ReviewService.create` is the explicit domain creation path. It validates only that the requested `candidateId` exists in the read-only Candidate projection, then writes the independent Review projection. It does not read WorkOrder, Job, or Orchestration records, infer or require their statuses, or copy any Candidate fields beyond the link identity.

A schemaVersion 1 `ReviewRecord` contains only `id`, `candidateId`, bounded non-empty `reviewer`, bounded non-empty `summary`, defensively copied `findings`, `createdAt`, and its append-only event list. Each finding contains exactly one independent `severity` of `low`, `medium`, or `high`, a bounded non-empty `message`, and bounded non-empty `evidence`; the domain limits are 256 UTF-8 bytes for reviewer identity, 2 KiB for summary, at most 10 findings, and 1 KiB for each finding message/evidence. The record is immutable and status-free: it has no verdict, recommendation, acceptance/discard value, lifecycle status, or `updatedAt`, and multiple ReviewRecords may reference the same CandidateRecord.

`SqliteReviewStore` wraps `SqliteDurableRecordStore` with the `Review` kind in a caller-selected local `agentknot.sqlite` directory and exposes create/read/list/event-cursor operations. The snapshot and one `review.created` event commit atomically; general Review save is rejected. Candidate validation and Review persistence are separate stores and not one cross-store transaction, with no recovery or reconciliation. The API is TypeScript-only and adds no CLI/HTTP workflow, reviewer launching, automatic review, source-record transition, Disposition, acceptance, discard, artifact application, commit, merge, push, or promotion behavior.

The domain Review contract is deliberately separate from `OrchestrationRecord.qualityReview`: its verdict/findings are not imported, aliased, reinterpreted, migrated, or automatically converted into ReviewRecord fields. Orchestration quality-review evidence remains execution evidence.

### `DispositionRecord` final controller decision

`DispositionService.record` is the explicit domain recording path. It validates that the requested Candidate exists, that the requested Review exists, and that the Review's `candidateId` matches, using read-only Candidate and Review stores before writing the independent Disposition projection; those reads and persistence are not one cross-store transaction. A missing Candidate, missing Review, or mismatched Review is rejected without a Disposition write.

A schemaVersion 1 `DispositionRecord` contains only `id`, `candidateId`, `reviewId`, `decision: "accept" | "discard"`, bounded non-empty `decidedBy`, bounded non-empty `rationale`, `createdAt`, and one `disposition.recorded` event. `decidedBy` is limited to 256 UTF-8 bytes, rationale to 2 KiB, and the complete durable projection to the fixed 16 MiB Disposition-record budget. It is immutable and status-free: it has no `status` or `updatedAt`, and it does not import or reinterpret orchestration advisory verdicts/findings. The record identity is `disposition_` plus the fixed 64-character lowercase SHA-256 digest of the Candidate ID, so one Candidate has one deterministic identity. The first create succeeds; an exact semantic replay returns the committed record without another event; and a different Review ID, decision, decider, or rationale raises `DispositionConflictError`, including when independent store instances race.

`SqliteDispositionStore` wraps `SqliteDurableRecordStore` with the `Disposition` kind and exposes record/create, get, getForCandidate, list, and event-cursor reads. The snapshot and its one event commit through the existing atomic create transaction; general Disposition save is rejected, and explicit unsupported schema versions fail. The TypeScript-only API records the controller's final accept/discard decision but never applies, promotes, commits, merges, pushes, deletes, or otherwise mutates the Candidate artifact or canonical workspace. It adds no CLI/HTTP workflow, automatic disposition, source-record transition, lifecycle status, recovery, reconciliation, or promotion behavior; Job success remains technical execution evidence rather than acceptance.

### Independent local broker discovery

A successful `agentknot broker run --host 127.0.0.1` (or compatibility alias `serve`) publishes one product-owned per-user broker record only after HTTP `listen` succeeds, using the actual listening port. The registering broker holds one per-user discovery ownership lock for its lifetime; graceful close removes only its own identity, and a failed runtime or listen leaves no new record. Only the exact host string `127.0.0.1` auto-registers; wildcard and non-loopback binds remain explicit through `--server URL` or `AGENTKNOT_SERVER_URL`.

The record is schema-versioned, strict, bounded, mode `0600`, and stored below one stable product-owned per-user application-state location: `~/.local/state/agentknot/broker` on Linux, `~/Library/Application Support/AgentKnot/broker` on macOS, or `%LOCALAPPDATA%\AgentKnot\broker` on Windows (with the documented home-relative platform fallback). Transient session variables such as `XDG_RUNTIME_DIR` and `XDG_CACHE_HOME` are deliberately not rendezvous selectors, because controller and broker processes may inherit different values. The record is not in a shell profile, repository, controller transcript, or Job store. It contains URL, random broker instance identity, and start time but no prompt, credential, route, or worker output. `agentknot client --json` is read-only and reports `unconfigured`, `available`, or `unavailable`. A stale or malformed discovery record is terminal for ordinary client operations: they do not open local storage, create a runtime, or select another worker, provider, or model. Only the explicit broker lifecycle operation may start the independent process.

For client-capable CLI commands, explicit `--config PATH` is the deliberate local override; otherwise explicit `--server URL`, then `AGENTKNOT_SERVER_URL`, select the shared broker before implicit discovery. An explicitly set `AGENTKNOT_CONFIG` remains the existing local opt-in. `--config` and `--server` are mutually exclusive. Broker lifecycle, `doctor`, and `usage` remain local operations.

`agentknot mcp` resolves `AGENTKNOT_SERVER_URL` or the current discovery record on every execution/evidence tool call, allowing one long-lived controller MCP process to follow broker restart or endpoint change. It never accepts `--config`, calls `createRuntime`, acquires scheduler storage, or chooses a route/model. Its explicit `agentknot_broker_start` lifecycle tool may spawn the same compiled `broker run` entry from a previously validated product-owned launch profile; the spawned broker, not MCP, creates and owns the runtime. Codex and Claude packages install no `UserPromptSubmit` hook or process-owning controller code; their only hook is the narrow stateless `SessionStart` obligation described below.

### Portable explicit broker lifecycle

`agentknot broker run` executes the broker in the foreground. `agentknot broker up --config PATH [--port PORT]` first validates the configuration, writes one strict launch profile containing only its absolute path and port, spawns that exact compiled foreground entry with separate argv and the caller-selected discovery environment overlaid on the inherited process environment, detaches it using Node process primitives, and polls discovery plus the broker identity endpoint until the random instance identity, start time, and PID match. A concurrently started broker is reused rather than duplicated. Failure to become ready is explicit. The launch profile is a preference, not liveness, scheduler ownership, credentials, or durable Job state.

Launch profiles are schema-versioned, bounded to 4 KiB, atomically replaced, and mode `0600` below the platform application-config directory: `$XDG_CONFIG_HOME/agentknot` or `~/.config/agentknot` on Linux, `~/Library/Application Support/AgentKnot` on macOS, and `%APPDATA%\AgentKnot` on Windows. `agentknot_broker_status` reports only whether such a profile is configured. `agentknot_broker_start` accepts no path or model arguments; it starts or reuses the exact profiled broker and returns the ordinary lifecycle result. If no profile exists, it fails with the one-time `broker up --config` prerequisite. An explicit `AGENTKNOT_SERVER_URL` forbids local broker activation.

`agentknot broker status` distinguishes `stopped`, exact `running`, and `unavailable` discovery/endpoint states. `agentknot broker down` sends `SIGTERM` only to the PID returned by a live endpoint whose random identity matches the protected discovery record, waits for shutdown, and removes a crash-stale record only after acquiring its ownership lock and rechecking identity. It never trusts a PID or port alone. The lifecycle writes no systemd unit, LaunchAgent, shell profile, repository setting, or controller-session state. External supervisors and containers may run `broker run`; AgentKnot does not install or manage them.

### Experimental controller integrations

The repository contains separate optional Codex and Claude client packages plus their native marketplace manifests. Each exposes one `agentknot-delegate` Skill, one identical `.mcp.json` entry that launches `agentknot mcp`, and one identical stateless `SessionStart` hook for `startup`, `resume`, `clear`, and `compact`. Codex supports explicit `$agentknot-delegate` plus metadata-permitted implicit selection; Claude uses `/agentknot:agentknot-delegate`. Both implement the same controller-authored handoff and are removable without changing broker behavior.

The controller first constructs one bounded parent task and one strict assessment. The preferred adapter calls `agentknot_broker_status`; if it reports `stopped` or `unavailable` with `launchConfigured: true`, the controller tries `agentknot_broker_start` once before `agentknot_delegation_policy` and `agentknot_orchestration_start`. The lifecycle may remove only an identity-matching crash-stale discovery record; malformed or unidentified ownership still fails. `agentknot_orchestration_follow` performs one bounded durable cursor wait, later `agentknot_orchestration_status` calls remain non-blocking snapshot reads, and `agentknot_artifact_preview` reads one exact patch. Missing launch configuration or failed startup is reported without repository scanning, a controller-local runtime, or route/model fallback. The Skill's CLI fallback uses the same broker API through `agentknot client --json` and `orchestrate --server ... --handoff-json`. Informational chat, requirements/product decisions, artifact acceptance/promotion, commit, push, merge, and deployment remain upstream.

`--handoff-json` is a CLI-only projection of the authoritative terminal `OrchestrationRecord`, not a second persisted schema. It retains schema version, orchestration identity/status, source/delegation audit values, plan decision/hash/reasoning, assessment classification, compact subtask route evidence, one copy of child status/output/error, result action/artifact review, optional quality-review and artifact-validation evidence, terminal error, and compact read-only artifact size/SHA-256/base/changed-path verification. Persisted validation stdout and stderr become at most 2 KiB tails apiece in this projection. It omits request prompt/workspace/metadata, policy and execution snapshots, events, acceptance criteria, execution prompts, and the duplicate result child array. Full CLI, HTTP, and TypeScript record surfaces are unchanged. The controller must not infer omitted evidence and separately previews only integrity-valid non-empty patch bytes.

Each package contains the same controller-owned handoff Skill, common MCP manifest, and stateless `SessionStart` hook. For `startup`, `resume`, `clear`, and `compact`, the hook reads only bounded event JSON and emits one concise controller obligation. It performs no filesystem, Git, network, broker, policy, runtime, prompt, transcript, or session-state work; no `UserPromptSubmit` hook injects per-prompt context. New, continued, resumed, and repository-switched sessions still rely on the upstream controller for semantic eligibility, current workspace, and strict assessment authoring; deterministic session context is not proof of automatic Skill invocation.

`agentknot --server URL` and `AGENTKNOT_SERVER_URL` select the existing HTTP API as the CLI transport. A client-capable command with no explicit selector uses the registered endpoint according to the discovery contract above. In server mode the CLI never calls `createRuntime()`, loads configuration, acquires file locks, or reconciles snapshots. `run` and `orchestrate` submit and wait for terminal records; catchable termination requests cancellation from the server. They follow `GET /v1/jobs/:id/events?after=SEQUENCE` or the Orchestration equivalent. The server returns after committed event activity, terminal state, or a fixed five-second heartbeat. Active responses contain the committed event delta, `nextSequence`, compact schema version, ID, status/phase, update time, route/child status, and an additive `JobActivityProjection` for each available Job. That projection is derived only from already persisted events and contains lifecycle state, `complete | partial | truncated` evidence coverage, the last observation sequence/time/type plus optional sanitized tool name or retry attempt, and at most four sanitized active-tool names/count. It contains no prompt, workspace, worker text, stderr, raw frame, tool call ID, argument, or result. Partial or truncated evidence clears active-tool claims. Observation age means only time since the latest committed event; broker-client disconnection and bounded same-ID reconnect are separate transport updates, and no silence duration is called provider or process loss. Terminal responses contain `nextSequence` and the full exact record once; they do not duplicate its retained event history beside the record. After transport failure the client retries only that durable ID and cursor at most three times and never creates replacement work. No parallel `/wait` HTTP surface is retained. `--progress` renders compact evidence to stderr, suppressing duplicate unchanged snapshots for 15 seconds. Route, Job, Orchestration, delegation, and artifact read surfaces use the same server. `--server` and `--config` are mutually exclusive; `doctor`, `usage`, and live `run --events` are unavailable through this client slice. Ordinary operations retain a fixed timeout and bounded response body, and each heartbeat remains shorter than that operation timeout; total orchestration duration remains governed by route timeouts. An unavailable server is terminal after bounded same-ID reconnect and never triggers local execution or route/model fallback ([decisions 0062](../postmortems/0062-durable-event-subscription.md), [0065](../postmortems/0065-retire-http-wait-aliases.md), and [incident/decision 0072](../postmortems/0072-compact-worker-activity-and-pi-frame-coalescing.md)).

The `SessionStart` hook does not participate in orchestration or discovery; it only emits the bounded session obligation. No `UserPromptSubmit` or raw-prompt forwarding hook participates in admission. Broker availability is checked through the common MCP tool in the controller turn; prompt text does not traverse a second controller adapter before that decision.

The `OrchestrationRequest.workspace` is the authoritative primary target and the only repository any worker may modify through its isolated copy. Other repositories named in the task are read-only references. If the requested edit target conflicts with that workspace, the controller keeps it upstream or submits an assessment that deterministic policy rejects; AgentKnot does not reinterpret either repository. For `repository-analysis`, the controller-authored subtask must name the primary target, referenced repositories (or none), exact file/component scope, and non-goals. The generated worker execution prompt repeats a route-neutral boundary: at most five decision-relevant findings and 4,000 characters, concise path/line evidence plus impact, no repository inventory, no source restatement, and no silent scope expansion. This task kind is read-only at settlement: if the controller-captured terminal-attempt artifact contains any changed path, the Job fails once with a non-retryable `WorkerReadOnlyTaskViolationError`; the artifact remains inspectable evidence and its integrity result is not rewritten.

An assessment may include one optional controller-authored `context` object. AgentKnot validates and defensively copies it, includes it in the deterministic plan hash, persists it with the admitted request, and projects the same text before every selected child's task-specific prompt. It is explicitly unverified navigation guidance. The worker prompt asks for acceptance-relevant verification, task-relevant `workspace-file` reads, and an explicit missing/stale-context report instead of scope expansion; this remains model behavior over ordinary tools rather than enforced retrieval. Explicit context constraints take precedence over the generic request to run relevant checks, and an explicit task output format takes precedence over the generic request for files/checks/risks prose. Correctness never depends on a retained Pi session, provider prompt cache, controller transcript, or separate memory service ([experiments/decisions 0081](../postmortems/0081-selective-workspace-context-ab.md) and [0082](../postmortems/0082-real-repository-selective-context-gate.md)).

One exact local broker owns startup recovery and the shared orchestration semaphore, and publishes its product-owned per-user record only after listening. Multiple controller sessions and MCP processes are ordinary clients and do not multiply `maxConcurrency`. Wait and cancellation authority derives from the kernel/store; parent and leaf restart recovery claim higher fences and retain exact durable identities. Non-127 binds remain explicit. The loopback API remains trusted-local with no authentication or TLS ([decisions 0055](../postmortems/0055-durable-middleware-kernel.md) and [0057](../postmortems/0057-independent-broker-and-thin-controller-clients.md)).

Codex `agents/openai.yaml` permits implicit Skill selection for eligible work, but that metadata alone does not prove that a fresh controller session invoked the Skill; a real miss is preserved in [decision 0074](../postmortems/0074-session-start-controller-entry.md). The `SessionStart` obligation makes the controller boundary visible at session lifecycle events without making semantic eligibility automatic. The controller must still make that decision and author the assessment in its normal model turn; AgentKnot does not synthesize it. The packages add no `UserPromptSubmit` hook, raw-prompt forwarding, bundled runtime, daemon, controller branch in the kernel, local semantic classifier, or special `/goal` API. Their MCP entry launches the separately installed controller-neutral client.

Deterministic evidence verifies exact Codex/Claude manifest, MCP, Skill, and `SessionStart` hook parity; the supported lifecycle sources and bounded stateless output; absence of `UserPromptSubmit`, prompt forwarding, and runtime ownership; strict assessment admission; compact handoff; and one long-lived MCP client across broker restart. The fresh-session promotion gate distinguishes deterministic session context from actual implicit Skill selection; historical hook/session experiments remain evidence for their incidents, while [decision 0074](../postmortems/0074-session-start-controller-entry.md) supersedes the relevant no-hook conclusion of [0063](../postmortems/0063-remove-per-prompt-controller-obligations.md).

### `OrchestrationRequest`

| Field | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | Non-empty controller goal |
| `workspace` | yes | Existing target repository directory |
| `assessment` | yes | Strict controller-authored `TaskAssessment`; validated before record admission |
| `source` | no | Opaque controller identity; never a policy branch |
| `metadata` | no | Controller-owned metadata copied to child provenance |
| `delegation` | no | `inherit`, `never`, `suggest`, or `force` |
| `idempotencyKey` | no | Bounded opaque key; exact canonical handoff reuse returns the original orchestration identity and conflicting reuse fails |

`assessment` contains exactly `schemaVersion: 1`, `recommendation: "delegate" | "do-not-delegate"`, `complexity: "low" | "medium" | "high"`, `parallelizable: boolean`, at most 20 non-empty `taskKinds`, bounded non-empty `reasoning`, optional `context`, and at most 20 subtasks. `context`, when present, contains exactly `schemaVersion: 1`, a non-empty summary of at most 1,000 characters, at most 20 unique non-empty repository-relative `relevantPaths`, and at most 20 unique non-empty `constraints`; each array entry is at most 500 characters and the complete compact UTF-8 JSON is at most 2 KiB. Absolute, drive-qualified, or parent-traversing paths fail. Each subtask contains exactly bounded non-empty `title`, `kind`, `prompt`, and 1–20 bounded non-empty `acceptanceCriteria`. A delegate recommendation requires at least one subtask; do-not-delegate requires none. Unknown/missing fields, oversized values, and inconsistent recommendations fail before an Orchestration record is admitted. Route, worker, provider, model, and effort are not assessment fields. CLI JSON is capped at 64 KiB and HTTP/TypeScript use the same validator and defensive copy.

`never` and `suggest` narrow global behavior. `force` may broaden the delegatable allowlist but never bypasses global `off`, `keepUpstream`, the child limit, depth one, isolation requirements, or configured routes.

### `JobRequest`

| Field | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | Non-empty worker instruction |
| `workspace` | yes | Existing directory, normalized to an absolute path |
| `route` | no | Configured route name; otherwise the configured default |
| `source` | no | Opaque caller identity and audit metadata |
| `callbackUrl` | no | Trusted HTTP(S) endpoint for one terminal snapshot delivery attempt |
| `metadata` | no | Controller-owned metadata intended to remain JSON-compatible across file and HTTP transports |
| `artifactReadGrant` | no | Exact single-use authority for one already recorded AgentKnot Git patch; contains logical identity whose bounded exact size is the byte ceiling, never a path or content |

`source` must never alter route selection or execution logic.

`artifactReadGrant`, when present, contains exactly `schemaVersion: 1`, a canonical `sourceJobId`, and the recorded artifact identity (`kind: "git-patch"`, positive attempt and size, lowercase SHA-256, Git base commit and optional base tree). The exact positive size, at most the 1 MiB artifact-preview ceiling, is also the grant's byte ceiling; no duplicate configurable budget field is retained. Admission rejects unknown fields. The grant is part of the canonical durable request and therefore survives retry/recovery and idempotency; it contains no artifact path, bytes, URL, provider, model, or worker field.

Every attempt reconstructs a single-use `WorkerArtifactReader`. A read resolves only the exact source Job and attempt from the Job store, requires a terminal source in the same normalized workspace, compares every granted identity field with the recorded artifact, and reruns ordinary integrity/base verification. It never falls back to another attempt, current workspace content, a caller path, or a network source. Missing, mismatched, stale, or truncated evidence fails once without worker retry. Before exact content is returned, AgentKnot persists a bounded `worker.artifact.read` event containing only source Job, attempt, digest, call number, outcome/reason, and byte count. An adapter that completes without one served read, suppresses a refused read, or attempts another read fails rather than fabricating evidence.

### Optional human-authored route selection

`delegation.dispatch.routeSelection` is an optional configuration object; omission disables route selection. `mode: "shadow"` records deterministic evidence without changing execution. `mode: "active"` applies the same human-authored rules to the planned and actual child route. Global delegation `mode: "auto"` remains separate from route-selection mode (see [decisions 0016](../postmortems/0016-shadow-route-selection.md) and [0020](../postmortems/0020-human-authored-active-route-selection.md)).

Its public shape is conceptually:

```ts
interface RouteSelectionConfig {
  mode: 'shadow' | 'active';
  rules: RouteSelectionRule[];
}

interface RouteSelectionRule {
  route: string;
  taskKinds?: string[];
  complexities?: TaskComplexity[];
}

type RouteSelectionEvidence =
  | { mode: 'shadow'; suggestedRoute: string; basis: 'rule'; ruleIndex: number }
  | { mode: 'shadow'; suggestedRoute: string; basis: 'default' }
  | { mode: 'active'; selectedRoute: string; basis: 'rule'; ruleIndex: number }
  | { mode: 'active'; selectedRoute: string; basis: 'default' };
```

The rules array contains 1–20 ordered rules. Every rule references an existing configured exact route or route pool and is validated at config load. If present, `taskKinds` and `complexities` must each be non-empty and contain unique values; complexities are limited to `low`, `medium`, and `high`. A rule with both predicates matches only when both predicates match the eligible subtask kind and parent assessment complexity, a rule with one predicate matches that predicate, and a rule with neither predicate is an explicit catch-all. The first matching rule wins. Complexity is assessed once by the controller for the parent orchestration; AgentKnot does not ask another model for a per-child complexity or route judgment.

For every eligible planned subtask, deterministic policy records `RouteSelectionEvidence` using the subtask's `kind` and parent assessment `complexity`. A rule match records `basis: 'rule'`, the configured route, and a zero-based `ruleIndex`; when no rule matches, evidence records `dispatch.defaultRoute` with `basis: 'default'` and no `ruleIndex`. The evidence is part of the persisted plan and its `planHash`.

In `shadow` mode, `PlannedSubtask.route` remains `dispatch.defaultRoute`; evidence uses `suggestedRoute`. In `active` mode, `PlannedSubtask.route` becomes the matched `selectedRoute`, or the default target when no rule matches. Dispatch passes that configured logical target to the ordinary child Job API, whose exact resolved snapshot remains execution authority. Child metadata carries the same evidence. Controller assessments cannot name routes. Active selection adds no runtime ranking or fallback: retry remains inside the admitted exact route. Repository dogfood uses the configured `deepseek-flash` route for low work and `luna` for medium/high/default work; route targets remain configuration rather than a core model/runtime rule.

### `JobArtifact`

A `git-patch` artifact is controller-captured Git evidence from one isolated attempt. In addition to its attempt, managed path, size, SHA-256, and recorded base commit, newly captured artifacts carry `baseTree`, the exact Git tree seen by the worker, plus `changedFiles`, a string array of repository-relative paths derived from Git. `changedFiles` includes `[]` when the worker delta is empty. The paths describe changes relative to the admitted source snapshot; they are not worker claims, semantic verification, or a completion summary. Older persisted artifacts may omit `baseTree` or `changedFiles` and remain readable with their prior HEAD-only inspection semantics.

Leaf Job and Orchestration admission validate `metadata` recursively as a JSON-compatible object at both TypeScript and HTTP boundaries before persistence. Unsupported values, nesting beyond 20 levels, or compact JSON above 64 KiB fail before a record is admitted. Caller-supplied Job and Orchestration request prompts likewise fail admission above 64 KiB of UTF-8. Derived child prompts pass through ordinary Job admission; the completion-report instruction is appended later at its adapter boundary. File and HTTP transports therefore preserve one metadata and request-prompt contract; the HTTP request-body ceiling remains an independent transport limit.

### `JobCompletionSummary`

`JobCompletionSummary` is an optional top-level field on `JobRecord` so schemaVersion 1 records written before this slice remain readable and byte-stable. Every newly terminal succeeded, failed, or cancelled Job receives the summary before its terminal event is appended and persisted. Its route-neutral shape is:

```ts
interface JobCompletionSummary {
  schemaVersion: 1;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  changedFiles:
    | { status: 'captured'; paths: string[]; artifact: { attempt: number; sha256: string; baseCommit: string } }
    | { status: 'unavailable'; reason: 'workspace-isolation-disabled' | 'artifact-unavailable' | 'artifact-paths-unavailable' };
  workerReported:
    | { status: 'reported'; report: WorkerCompletionReport }
    | { status: 'unavailable'; reason: 'absent' | 'malformed' | 'not-retained' };
}
```

The captured branch copies only `changedFiles` from the artifact whose attempt equals the terminal attempt and carries that artifact's attempt, SHA-256, and base commit; it never calls those paths semantically verified. Direct workspace mode reports `workspace-isolation-disabled`, a missing terminal-attempt artifact reports `artifact-unavailable`, and an artifact without usable path evidence reports `artifact-paths-unavailable`. Earlier retry artifacts remain in `JobRecord.artifacts` and are not summarized as terminal evidence.

### `OrchestrationResult.artifactReview`

Every newly produced `action: "delegated"` orchestration result adds `artifactReview`; legacy, upstream, and suggested results may omit it. The controller-neutral shape is:

```ts
interface OrchestrationArtifactReview {
  status: 'checked' | 'incomplete';
  conflicts: Array<{ path: string; subtaskIds: string[] }>;
  unavailable: Array<{
    subtaskId: string;
    jobId: string;
    reason:
      | 'job-not-found'
      | 'completion-summary-unavailable'
      | 'workspace-isolation-disabled'
      | 'artifact-unavailable'
      | 'artifact-paths-unavailable';
  }>;
}
```

The orchestration service reads each child's terminal `JobCompletionSummary.changedFiles`. It deduplicates paths within that child, groups exact repository-relative paths across distinct children, sorts conflicts by path, and preserves parent child order in `subtaskIds`. Worker reports, prose, controller-declared scopes, events, stderr, and artifacts from earlier retry attempts never participate.

`checked` means usable captured path evidence was available for every child, including a captured empty array. `incomplete` means at least one child lacked usable evidence and cannot be interpreted as a clean handoff; conflicts among the remaining evidence are still reported. A conflict is conservative potential integration-conflict evidence, not proof that same-path changes are incompatible. Conversely, no conflict does not prove semantic independence, patch integrity, current-base applicability, or acceptance. The additive result is persisted before the existing terminal orchestration event and is carried by existing TypeScript, CLI full-record, and HTTP full-record surfaces without a new endpoint or event.

### Optional advisory quality review

`delegation.qualityReview` is optional; omission disables this path. Its exact configuration contains `route` and a non-empty unique `complexities` subset of `low | medium | high`. The route must exist and resolve `maxAttempts: 1`. The route name is role/configuration data: controller, worker adapter, provider, model, and thinking level remain independently replaceable.

After child dispatch settles, review is eligible only when the configured parent complexity matches, the plan and parent contain exactly one subtask/child, that child and its authoritative Job succeeded, and verification finds exactly one integrity/base-valid, non-empty Git patch. Other cases persist `qualityReview.status: "skipped"` with a stable reason. The reviewer prompt is capped by ordinary 64 KiB Job admission and contains the parent goal, subtask prompt and acceptance criteria, verified artifact identity, and at most 8 KiB of structured worker completion claims labeled unverified. It excludes child prose and patch bytes. The reviewer Job carries the corresponding exact artifact-read grant and must consume it before successful settlement.

The reviewer is one separately persisted ordinary depth-one Job, not an orchestration child and not a recursive dispatch. It shares the Job-capacity boundary and source identity, carries reviewer-role provenance, uses no fallback, and is instructed not to edit, apply, repair, delegate, converse, commit, push, merge, or promote. `WorkerRunInput.artifactReader` is route-neutral. Pi alone maps it to an explicitly loaded product-owned `agentknot_artifact_read` tool over an attempt-owned Node child-process IPC channel; ambient discovery remains disabled, the tool accepts no arguments and is single-use, the adapter requests core bytes only when the tool executes, core persists its read event before the IPC response, the temporary extension contains no artifact bytes, and normalized tool events omit arguments and content. When configured Pi tool filters would exclude this required tool, the adapter changes only the spawned attempt's argv, not Pi settings or worker configuration. Other adapters must map the same generic reader without changing core Job semantics. Its output must be one JSON object no larger than 8 KiB with exactly schema version 1, verdict `accept | changes-requested | uncertain`, a non-empty summary no larger than 2 KiB, and at most ten `low | medium | high` findings whose non-empty message/evidence fields are each at most 1 KiB. `changes-requested` requires a finding and still completes the assigned review task; `blocked` is reserved for inability to complete the review itself.

Ordinary reviewer start/runtime/protocol failure is advisory `unavailable` evidence and does not rewrite a successful child or parent. Cancellation cancels and awaits a running reviewer before the parent cancels. Parent recovery reuses only the persisted reviewer Job identity, recovers its expired lease through ordinary Job rules when necessary, and never starts a second reviewer; missing or irrecoverable reviewer state becomes explicit unavailable evidence. Parent/Job persistence failures retain their existing control-plane semantics. A completed verdict is persisted before the orchestration terminal event, appears in the compact handoff, and never applies the patch or changes the parent's delegated success. Final controller acceptance, modification, rejection, tests, commit, and push remain outside this state.

### Optional controller-owned artifact validation

`delegation.artifactValidation` is optional; omission disables this path. Its exact configuration contains only `argv`, `timeoutMs`, and `maxOutputBytes`. `argv` contains 1–32 non-empty strings, `timeoutMs` is an integer from 1 through 300000, and `maxOutputBytes` is an integer from 1 through 65536 shared across stdout and stderr. Unknown fields fail configuration. The command is one trusted local process started with `shell: false` from the requested repository subdirectory; configuration supplies no shell expression, environment overlay, or alternate working directory. Executable lookup and the child environment use the AgentKnot process environment.

Validation is eligible only when the delegated parent has exactly one planned and actual child, the authoritative child Job succeeded, and artifact verification finds exactly one integrity/base-valid, non-empty Git patch. Other cases persist `artifactValidation.status: "skipped"` with a stable reason. Before command execution the workspace manager re-inspects the source for the same `HEAD` and exact tree, re-verifies the managed artifact, recreates the admitted snapshot in a fresh detached worktree, runs `git apply --check --binary`, and applies only the worker-delta patch there. It then runs the configured command and always attempts exact worktree cleanup. `source-drift` is explicit; the source repository is never a patch target.

The route-neutral `OrchestrationRecord.artifactValidation` union is `skipped | pending | unavailable | completed`. Pending and terminal evidence identifies child Job, artifact attempt/size/SHA-256/base, and terminal cleanup state. Completed evidence records overall `passed | failed` plus the exact argv, command outcome `passed | failed | timed-out | output-limit | cancelled`, exit code, signal, duration, complete retained stdout/stderr prefix under the shared configured cap, truncation flag, and cap. Source dirtiness, artifact revalidation/apply/start/cleanup failure, parent cancellation, and restart interruption are explicit unavailable reasons. Because the shell-free validation command has no resume protocol, recovery converts a persisted pending validation to `unavailable/runtime-restart` with cleanup `not-confirmed` rather than rerunning it or claiming reattachment.

Artifact validation is not a Job, route, worker, reviewer, repair loop, or promotion operation. It has a separate process-local capacity of one across orchestrations and starts concurrently with an eligible optional quality review after child dispatch settles. Command failure is advisory and cannot rewrite a successful child or delegated parent; persistence failure retains ordinary control-plane semantics. Cancellation terminates and awaits the exact spawned child before the parent settles, escalating from `SIGTERM` to `SIGKILL` after a bounded grace period. Descendants intentionally detached by that command are not supervised, and the process inherits host filesystem, network, credential, and environment authority; this is not an operating-system sandbox ([decision 0037](../postmortems/0037-controller-owned-artifact-validation.md)).

`WorkerCompletionReport` is an optional custom-adapter result, not a Job result field. A strict schemaVersion 1 report contains `taskOutcome: "completed" | "blocked"`, worker-claimed `changedFiles: string[]`, `checksRun` entries with a non-empty `command`, `outcome` of `passed`, `failed`, or `unknown`, and optional string `notes`, plus `remainingRisks: string[]` and `notes: string[]`. A valid `blocked` report crosses the existing `WorkerRunResult.completionReport` boundary and is interpreted centrally as one terminal `failed` Job with `retryable: false`, retained worker-reported and artifact evidence, and no `job.retrying` event—even when checks pass or the artifact is valid. At the adapter boundary, `completionReport: undefined` means no report envelope was detected and `completionReport: null` means an envelope was detected but its JSON was malformed or unsupported; a valid value is copied only after strict validation and a 256 KiB compact-JSON ceiling. Custom TypeScript adapters may omit the report. Built-in Pi normal runs require a valid envelope. When its first normal turn settles without an assistant error but has a missing, malformed, unsupported, or non-terminal envelope, Pi receives one protocol-only prompt in the same process/session. A valid second-turn suffix is returned normally; another invalid settlement throws `WorkerSettledError` and cannot consume a fresh whole-worker attempt. AgentKnot never derives completion from prose, events, stderr, statistics, or an empty verified artifact. Assistant errors bypass envelope recovery, and transient adapter, transport, process, timeout, or cancellation failures before the first settlement retain their existing semantics ([incident/decisions 0044](../postmortems/0044-required-worker-completion-and-canonical-worktree-id.md), [0069](../postmortems/0069-repeated-shared-context-scope-trials.md), and [0085](../postmortems/0085-in-session-completion-envelope-recovery.md)).

### `ResolvedRoute`

A route snapshot contains:

- route name;
- worker name;
- provider name;
- model name;
- optional thinking level;
- required environment-variable names;
- maximum attempts;
- per-attempt timeout;

The resolved snapshot is stored with the job. Configuration changes after admission do not mutate it.

The current provider/model fields describe how the selected worker should run. They do not prove that AgentKnot has a provider adapter, validates the provider catalog, or can move a live job between providers. Shadow `suggestedRoute` is evidence rather than a resolved route; active `selectedRoute` is resolved through the ordinary Job route before execution, after which the immutable Job snapshot is authoritative.

No request, assessment, route, worker prompt, or runtime path accepts a tool-execution count as task scope. Semantic scope is the admitted context, relevant paths, constraints, task prompt, non-goals, and acceptance criteria. Timeout, cancellation, bounded event/output/record retention, isolation, and required completion evidence remain route-neutral operational boundaries; they do not estimate task difficulty or prescribe how many tools a replaceable worker may need. New inputs containing the retired `maxToolCalls` field fail before admission, while historical records remain read-only evidence ([decision 0083](../postmortems/0083-remove-tool-count-task-boundaries.md)).

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
- retry of downstream requests while retaining that worker session's context;
- bounded recovery of required adapter protocol evidence while retaining that worker session's context;
- worker-process termination when its implementation supports cancellation.

The adapter does not own job state transitions, whole-worker attempt numbering, workspace isolation, artifact capture, callback delivery, or persistence. A custom adapter may return the optional strict `WorkerCompletionReport` as `completionReport`; `undefined` means absent and `null` explicitly means a detected malformed or unsupported envelope. The built-in Pi normal-run adapter enforces its required envelope before returning. The orchestrator owns runtime validation and terminal-summary placement.

An adapter that reaches a settled worker-session error after exhausting an in-session recovery policy it owns throws `WorkerSettledError`. The orchestrator records that exact bounded message as terminal and does not consume another configured whole-worker attempt. A pre-settlement transport/process failure may instead throw `WorkerTransientError`; when another configured attempt remains, the orchestrator persists the next attempt plus route-neutral reason and delay in the existing `job.retrying` event, then performs an abort-aware bounded exponential wait with deterministic per-Job jitter. The current schedule starts at one second, caps its exponential component at 30 seconds, and caps the effective delay at 60 seconds. A custom adapter may attach a non-negative millisecond `retryAfterMs` hint, which is honored up to that effective bound. Pi classifies exit before `agent_settled` through this contract. Other adapter failures retain ordinary Job-attempt behavior, including malformed transport/protocol before the first settlement and retryable custom-adapter exceptions. This contract does not parse provider strings or HTTP headers in core, infer account quota, switch routes, alter attempt reservation/recovery, or prevent a controller/human from explicitly admitting a later Job. Normalized in-session retry events may carry only bounded route-neutral scope, attempt, maximum, delay, outcome, and exhaustion reason; current scopes distinguish downstream calls from completion-envelope recovery, and compact wait activity exposes their scope/progress without raw error text or recovery prompts ([incident/decisions 0084](../postmortems/0084-worker-settled-retry-ownership.md), [0085](../postmortems/0085-in-session-completion-envelope-recovery.md), and [0087](../postmortems/0087-pre-settlement-worker-retry-backoff.md)).

The reusable route-neutral `WorkerAdapter` unit kit runs against Mock and Pi RPC. It requires healthy diagnostic shape, normalized start/text events and output, propagation of event-sink failures, and rejection when `run` receives an already-aborted signal. Route-resolution, lifecycle, workspace/artifact, and transport-specific evidence remains at its owning boundary. Mock remains deterministic-only evidence and Pi is the built-in real implementation; custom adapters remain replaceable at the worker boundary.

Every normal Pi Job materializes one mode-0600 product-owned extension beside the attempt and loads it after any explicitly configured extensions. Its final `tool_result` hook combines all-text result blocks and, before Pi constructs the next model request, limits aggregate UTF-8 text to 8 KiB. Bash retains the tail to favor exit/error and final-output evidence; every other all-text result retains the head. The replacement includes the original byte count, fixed maximum, retained direction, and a concise instruction to narrow the query or request a targeted range. Results at or below the bound, results containing non-text content, and the exact single-use `agentknot_artifact_read` result are unchanged. The attempt removes the private extension bundle during exact-child cleanup. This adapter-owned context boundary changes no tool-call count, Job/event schema, route, retry, worker output, artifact bytes, or persistence limit; it is not content redaction, a general sandbox, or proof of universal token savings ([incident/decision 0088](../postmortems/0088-bound-pi-tool-result-context.md)).

The JSON configuration boundary exposes the built-in `mock` and `pi-rpc` adapter kinds only; `createRuntime()` loads that configuration and registers those built-ins. A custom `WorkerAdapter` is a TypeScript construction path: callers provide an `AgentKnotConfig`, `JobStore`, and adapter map to `Orchestrator`, and construct `OrchestrationService` separately when they need orchestration. A custom adapter cannot be selected by adding an arbitrary adapter name to JSON, and adapter-specific behavior must remain at the worker boundary.

Optional `routePools` sit above complete exact routes. A pool name cannot collide with a route; it has exactly `strategy: "least-active"` and 2–20 unique existing route members. `JobRequest.route`, `delegation.dispatch.defaultRoute`, dispatch rules, and quality review may name an exact route or pool; top-level `defaultRoute` and `doctor` remain exact-route-only. Every quality-review pool candidate must resolve to `maxAttempts: 1`. In the production SQLite Job store, one immediate transaction counts unexpired execution leases for every candidate, reads the rotating cursor keyed by the ordered logical pool definition, selects the least-active member, persists the exact route and selection evidence, creates the optional idempotency identity and first fenced Job lease, advances the cursor, and commits. Explicit exact-member Jobs therefore participate without a second counter; concurrent stores cannot interleave selection and admission, and rejected admission advances nothing. Memory and legacy file stores retain process-local selection for test/migration use. Neither path observes provider health, quota, cost, latency, or model quality ([decision 0061](../postmortems/0061-atomic-durable-route-pool-admission.md)).

The Job keeps the logical target in `request.route`, snapshots one concrete immutable `ResolvedRoute` in `route`, and, for a pool, persists `routePoolSelection` with the pool, ordered candidates, strategy, pre-selection counts/cursor, selected exact route/member index, and rotating tie-break. Retries use only that exact route. Pool selection never switches worker, provider, model, thinking level, credentials, timeout, or attempt policy after admission, and a failed Job never falls back. Child and reviewer Jobs use this same evidence; parent records link their Job IDs rather than duplicating exact selection ([decisions 0042](../postmortems/0042-complete-route-pool-balancing.md) and [0047](../postmortems/0047-resumable-controller-binding-and-replaceable-role-pools.md)).

### Route diagnostics

Route diagnostics are a controller-neutral runtime operation separate from the Job API. The default CLI `doctor [--route NAME]` resolves a route and performs only the adapter's configuration, credential, and runtime health check. Its result must explicitly state that live inference was not checked; an `ok` result is not evidence that the provider accepted an inference request from the current network path.

The opt-in `doctor --live --route NAME` operation performs exactly one real inference probe through the exact resolved route: worker, provider, model, and optional thinking level are passed unchanged from route resolution. The core contains no route-name, provider, or model branch; current real promotion evidence covers the repository Pi/OpenCode Go/Luna/max route. The diagnostic never falls back or selects another route. A 30-second control-plane timer triggers cooperative abort, and a supported probe adapter must settle after abort and finish resource cleanup before the diagnostic returns.

Live probing is an optional worker-adapter capability with a controller-neutral result, not a provider-specific branch in the orchestrator. An adapter without that capability returns an explicit unsupported result. A probe adapter must honor the supplied `AbortSignal` and settle after abort; as with normal execution, a nonconforming custom adapter can prevent cleanup and completion. The supported Pi adapter supervises and terminates its child process and uses an exact temporary diagnostic workspace that is removed before return. A worker or provider failure is returned as a failed diagnostic with its provider error and a nonzero CLI exit status; unsupported is never treated as success. A successful probe is point-in-time evidence for the exact route and does not guarantee later job success.

A diagnostic probe does not create a `JobRecord`, lifecycle event, or artifact, and does not use the job retry or workspace-isolation lifecycle. Normal `run` and orchestration execution do not perform a diagnostic probe before starting a job.

### Workspace modes

`none` passes the supplied directory directly to the worker. It offers no isolation and currently produces no Git patch artifact.

`git-worktree`:

1. resolves the containing Git repository and requested subdirectory;
2. requires a valid `HEAD`, rejects dirty submodule contents, and snapshots at most 16 MiB of binary patch representation for the top-level staged, unstaged, and non-ignored untracked file tree through a temporary index and object directory;
3. records the base commit and exact source-tree identity without changing the real index, worktree, or repository object database; staging distinctions are intentionally collapsed into the file tree the worker sees;
4. creates a detached managed worktree for each attempt at that base, replays the one admitted snapshot there, and names it from the existing `job_...` identity exactly once;
5. gives the worker the corresponding subdirectory in the managed worktree;
6. copies the managed worktree's `skip-worktree` bits into the private capture index, stages intent-to-add entries without staging tracked removals, derives repository-relative changed paths with a NUL-delimited Git diff, then captures tracked modifications and deletions, non-ignored untracked, binary, and worker-committed changes as a binary Git patch of at most 16 MiB; sparse-checkout omissions therefore remain absent without full materialization or a network fetch;
7. captures only the worker delta relative to the snapshot, rejects a larger patch with non-retryable `ArtifactSizeLimitError`, and otherwise records artifact path, attempt, size, SHA-256, base commit, `baseTree`, and `changedFiles`; an empty worker delta records `[]`;
8. removes only the exact worktree owned by that attempt.

An absolute `workspaceIsolation.directory` is the exact managed root. A relative value is hashed together with the runtime base directory and used as a stable namespace below the platform temporary directory's private `agentknot-worktrees` root. It is deliberately not resolved below the runtime/config repository: otherwise an external target can inherit the host project's ancestor-discovered instructions, package manifest, or tool configuration. The same base/config pair resolves identically across broker replacement, while generated child names and exact-path cleanup retain their existing ownership checks ([incident/decision 0079](../postmortems/0079-external-worktree-ancestor-isolation.md)).

Ignored dependencies and build output are not present in a detached worktree. Dirty submodule contents are rejected because the superproject snapshot cannot represent them. The worker must provision any required ignored state. Worktree mode protects Git repository state; it does not isolate host files, processes, credentials, or networks.

### WorkOrder store

`SqliteWorkOrderStore` is the current WorkOrder authority. It composes `SqliteDurableRecordStore` rather than exposing the mutable execution-store facade. Issue commits the bounded snapshot and `work-order.issued` event in one transaction. Binding uses a purpose-specific transaction and the public expected event sequence while retaining the storage-internal CAS revision; projection and `work-order.executor-job.bound` either commit together or not at all. Closing and reopening the store preserves both the command and binding.

WorkOrder persistence is not part of `createRuntime()`, broker recovery, execution ownership, Job capacity, or cancellation. It opens a separate caller-selected SQLite directory. There is no atomic transaction spanning that database and Job admission storage, and no current WorkOrder-to-Job reconciliation process.

The developer task CLI selects the sibling `work-orders/` directory derived from configured Job storage; the underlying `SqliteWorkOrderStore.open(directory)` API remains caller-selected. `task-show` reopens that store and the existing Job read API rather than persisting a duplicate result projection. `task-candidate` additionally selects sibling `candidates/` storage, while `SqliteCandidateStore.open(directory)` remains caller-selected. Human and JSON formats are derived at read time and persist no second presentation record.

### Job store

`MemoryJobStore` provides process-local snapshots.

Production `createRuntime()` uses `SqliteJobStore` and `SqliteOrchestrationStore`. Each wraps one `agentknot.sqlite` authority in its configured record directory. A transition atomically saves the bounded materialized record and appends only its new event suffix; every record has an internal CAS revision, and a stale revision fails instead of overwriting a concurrent change. `eventsAfter(id, sequence)` reads the append-only cursor. Scoped idempotency maps one bounded opaque key plus canonical-request SHA-256 to one record identity; exact reuse returns that record and different-payload reuse fails. Execution lease and cancellation tables are part of the same database.

`DurableEventSubscription` is the shared Job/Orchestration read-side kernel. A service calls its process-local notifier only after a successful record save; notification never carries state. A subscriber captures the notifier version before reading events, rechecks it after waiter registration, and therefore cannot lose a commit in the read/register window. It yields only persisted events strictly after the caller cursor and ends after it has delivered the durable terminal suffix. An `AbortSignal` owns pending timer/listener cleanup. Because process-local notification cannot observe a different process, a bounded refresh re-reads the durable source; a replacement broker or independent reader therefore resumes from the same sequence without shared memory. Runtime `eventsAfter`/`subscribe`, HTTP event-follow, CLI wait, and MCP are adapters over this contract. MCP `agentknot_orchestration_wait` applies one default 40-second wait-phase deadline to the initial exact-ID snapshot and successive HTTP follow batches, resumes from the caller's acknowledged sequence, and returns either a terminal handoff or `{ state: "active", id, nextSequence }`; deadline expiry uses the already verified snapshot rather than issuing a fallback read. Cancellation propagates through the snapshot and in-flight follow without cancelling the durable orchestration. Standard MCP progress notifications are emitted only when the controller supplied a progress token and are never execution authority. The lower-level MCP follow tool still returns one batch. Live listeners, long-poll, future SSE/WebSocket, controller resume, and MCP Tasks may accelerate or project the durable cursor but cannot become record authority ([decisions 0062](../postmortems/0062-durable-event-subscription.md) and [0075](../postmortems/0075-bounded-mcp-wait-and-resume-gate.md)).

At first writable open, the SQLite stores import valid legacy `*.json` snapshots that do not already exist in the database. The basename without `.json` must equal the validated record ID; a mismatch fails closed instead of importing one identity through another filename. Import does not rewrite or delete the source evidence and is restart-safe per identity. Read-only runtime construction opens an existing SQLite database without schema writes; when no database exists yet, it retains byte-stable legacy file reads. `FileJobStore` and `FileOrchestrationStore` remain explicit legacy/test adapters during migration and are not a second production write path.

The orchestrator serializes append/save mutations per record so concurrent adapter event sources retain gap-free sequence numbers before the store applies CAS and append-only validation. New durable admission commits the queued projection, sequence-one event, optional idempotency mapping, and first execution lease in one transaction; failure leaves none of them. A lease-owning execution passes its current fence on every normal event, artifact, terminal, and callback-bookkeeping save. Another store instance can persist idempotent cancellation intent; the live owner polls it while renewing its lease and aborts cooperatively. The store rejects a success transition after cancellation was accepted, closing the terminal race even before the next heartbeat. Lease release leaves a non-active fence tombstone, so every later reclaim increments the generation; an old owner cannot renew, release, or save execution state even when the same owner ID is reused.

Execution-owning `createRuntime()` opens `.agentknot-runtime-lock.sqlite` through Node's built-in SQLite implementation in each real canonical Job and Orchestration storage directory, sets an in-memory journal, and holds one non-blocking `BEGIN EXCLUSIVE` transaction for the runtime lifetime. Directories must resolve to distinct locations and are acquired in deterministic path order. Locks are acquired before store construction, recovery, or admission; partial acquisition is closed if either directory is already owned. Read-only construction takes no lock and disables runtime execution/recovery methods. One-shot CLI execution closes ownership after completion, failed server listen closes it, process death releases the database locks through operating-system cleanup, and TypeScript callers use `AgentKnotRuntime.close()`, which refuses while tracked or recovered leaf work is active. `RuntimeOwnershipError` reports contention, preparation/acquisition failure, invalid shared storage, release failure, or premature close. Node.js 22.13 or newer is required; no external `flock` helper or native add-on is used.

These transitional locks coordinate production scheduler startup while multi-executor recovery/configuration authority is unfinished. They are separate from `agentknot.sqlite`, which is now the record/event/idempotency/lease/capacity authority. The lifetime lock is still advisory rather than a hostile-process security boundary and is scheduled for deletion only after the multi-executor gates pass.

Leaf admission uses one atomic store operation containing status `queued`, sequence-one `job.queued`, optional idempotency identity, and the first execution lease; an admission failure starts no worker and retains no partial identity. Git-worktree mode first materializes the admitted dirty-tree patch to one exact-ID mode-0600 file and stores only bounded size/SHA-256/commit/tree/path evidence in the record. A failed admission removes that exact unreferenced file; a hard crash before record admission may leave an orphan but cannot leave a durable record pointing at partial bytes. After admission, a failed event save rejects completion with `JobPersistenceError` classified as `event`, `artifact`, or `terminal`. It is a control-plane failure: it is never eligible for ordinary worker retry, never creates a substitute terminal event, and prevents callback delivery. The cancellation/success conflict is the deliberate exception: the rejected success projection is converted to one fenced `cancelled` terminal transition with no retained success result. If the failed save was the first record of a newly captured output patch, AgentKnot removes that exact unrecorded patch and its managed worktree; an artifact already saved before later observer-evidence failure remains recorded.

Every newly created leaf `JobRecord` has top-level `schemaVersion: 1`. When reading a file, `FileJobStore` treats an absent `schemaVersion` as legacy v1 and materializes `schemaVersion: 1` on the in-memory record returned by `get` or `list`; read-only access does not rewrite the snapshot. An explicit `schemaVersion` other than `1` fails with an unsupported-version error rather than defaulting to v1.

Memory, legacy file, and SQLite Job store adapters enforce the same 16 MiB ceiling on the exact pretty-printed UTF-8 JSON projection they would retain. A rejected admission leaves no record; a rejected save leaves the last successful projection authoritative. Legacy files remain readable above the current ceiling, but a later mutation must fit. This is a write bound, not compaction or retention.

Local Job/Orchestration database records, imported legacy snapshots, admitted workspace inputs, and captured output patch artifacts have no automatic expiry. AgentKnot supplies no garbage collector, storage-quota eviction, cascade deletion, or per-record purge API. An operator may remove an entire inactive configured record database or exact legacy/artifact path only after stopping execution and resolving parent, child, lease, and artifact evidence; deleting arbitrary SQLite rows or live database files is outside the contract.

AgentKnot does not redact content in prompts, model output, events, result metadata, retained stderr, callback bodies, or patches. Credentials remain external to route records and Pi session statistics are allowlisted, but field minimization, omission, replacement, and byte truncation are not proof of redaction. Snapshot and artifact files use mode `0600`; directory and backup protection remains the local operator's responsibility.

Current persistence still does not provide:

- schema migration;
- multi-host scheduling or worker-process reattachment;
- retention or compaction.

At execution-owning runtime startup, both transitional storage locks are acquired before records are inspected. A leaf Job is not mutated until its prior execution lease has expired and the new runtime claims a strictly higher fence. Durable cancellation is resolved first. A `queued` Job replays only from its integrity-checked admitted input; a `running` Job first appends `job.attempt.lost` and may execute only `attempt + 1` when the persisted route still has retry budget. Missing input evidence, an unavailable persisted worker adapter, invalid state, or exhausted budget becomes explicit terminal failure without route/model replacement. No path claims reattachment to the prior worker process. A recoverable parent reclaims its persisted controller-authored plan and immutable input, adopts identity-matching existing children/reviewers, and admits only missing deterministic work; historical `planning` or no-plan records fail explicitly, and interrupted command validation becomes unavailable rather than being rerun. Read-only runtimes skip all recovery and cannot invoke execution/recovery methods. Crash-left arbitrary worker/validation descendants and managed worktrees remain limitations.

### Orchestration store

`SqliteOrchestrationStore` is the production parent authority and uses the same transaction, CAS, event-cursor, idempotency, lease, cancellation, migration, and byte-bound contracts as `SqliteJobStore`. `MemoryOrchestrationStore` and `FileOrchestrationStore` remain process-local test and explicit legacy adapters. Every parent record captures the normalized request including the validated controller assessment, immutable effective delegation policy, executor identity, plan hash, exact child prompts and routes, route-selection evidence when configured, child Job IDs, ordered orchestration events, child outcomes, optional quality-review/artifact-validation evidence, and terminal result or error. Every child record, child-start event, and child Job provenance carries the admitting plan hash and policy version.

Every newly created parent `OrchestrationRecord` has top-level `schemaVersion: 1`. `FileOrchestrationStore` applies the same legacy-v1 materialization and read-only byte-stability rule, and explicitly unsupported schema versions fail clearly rather than being treated as v1.

All Orchestration store adapters enforce the same 16 MiB exact-projection ceiling as the Job stores. Child output duplicated into parent provenance is therefore bounded by both the leaf output limit and the final parent projection limit.

Parent durable admission atomically creates status `queued`, sequence-one `orchestration.queued`, optional idempotency identity, and the first execution lease. Later event persistence appends in memory only for the duration of the save and rolls back the event and timestamp if the save fails, leaving the last successful store projection authoritative. A child `JobPersistenceError` remains a control-plane failure: the parent cancels other active children and propagates the rejection without fabricating a worker-style child outcome. A cancellation-evidence save failure is reported but cannot prevent abort propagation to active children or review/validation work. Accepted durable cancellation prevents a simultaneous parent success and is materialized as cancellation-request plus terminal-cancelled evidence.

Production stores permit independent readers and enforce per-record CAS, idempotency, cancellation, fenced execution writes, leaf/parent reclaim, atomic route-pool selection, and FIFO Job capacity. They do not yet provide distributed consensus, multi-host scheduling, schema migration, or one transaction spanning the separate Job and Orchestration databases. `createRuntime()` therefore still takes the transitional scheduler-lifetime locks before execution/recovery; this is a multi-executor migration limit, not record or capacity authority.

## WorkOrder lifecycle

The only WorkOrder status is `issued`:

```text
issued -- bind existing executor Job identity --> issued
```

The arrow records an association and one append-only event; it is not a status transition and does not trigger execution. Explicit Candidate, Review, and Disposition operations are separate evidence writes, not WorkOrder or Job transitions, and none creates a `candidate-ready`, `reviewing`, `accepted`, or `discarded` status. Candidate, Review, and Disposition are immutable, status-free records; Disposition's `accept` or `discard` value is the controller's final recorded decision for Candidate evidence, not an artifact mutation or a change to `JobStatus`, WorkOrder status, or Orchestration status. Job/Orchestration completion remains technical evidence rather than acceptance.

## Job lifecycle

### State machine

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
```

`queued` means the request has been admitted and persisted. Execution enters the shared durable FIFO Job-capacity boundary, then takes a fenced renewable lease when admitted to run; the configured concurrency limit supplies bounded local backpressure but is not a distributed or multi-host scheduler. Before invoking an adapter, the current attempt number is persisted by `job.started`, `job.retrying`, or `job.recovery.started`; a crash therefore consumes the reserved attempt conservatively instead of repeating an adapter call whose start cannot be disproved. After lease expiry, a recovery owner may claim a higher fence and start the same queued git-worktree identity from its admitted input. A running record never restarts the same attempt: recovery first persists `job.attempt.lost`, then either reserves the next configured attempt or fails when its retry budget is exhausted. Jobs without immutable admitted input evidence fail recovery instead of reading mutable source state.

Retries remain inside one `running` job:

```text
attempt 1 failed -> job.retrying (next attempt reserved; optional bounded wait) -> attempt 2
```

Every attempt increments `job.attempt`. A structured pre-settlement worker failure waits only after `job.retrying` durably reserves the next attempt; cancellation interrupts that wait without starting another adapter process. In Git worktree mode, every retry starts from the recorded base commit rather than inheriting prior-attempt edits.

### Ordering invariants

For one job:

1. The initial `queued` job snapshot and sequence-one `job.queued` event are created atomically before worker execution.
2. Event sequence numbers start at one and increase by one.
3. An event is appended to the snapshot and the snapshot is saved before the live `onEvent` listener receives it.
4. State fields are changed before the corresponding lifecycle event is saved.
5. The terminal completion summary is populated before the corresponding terminal event is saved or observed.
6. A terminal event is saved before `completion` resolves.
7. Artifact capture and cleanup happen before the attempt outcome is finalized.
8. Callback bookkeeping happens after terminal execution and does not change execution status.

An append is visible to a live observer only after its whole snapshot save succeeds. A failed save rolls back the unsaved event in process, rejects completion as `JobPersistenceError`, and leaves the last successful persisted snapshot authoritative. State mutations prepared for the failed event are not advertised as durable.

The `onEvent` listener is awaited for ordering but is advisory. A rejection appends `job.observer.failed` with the observed sequence/type and error details; it does not retry or fail worker execution. Failure while persisting that observer-failure evidence remains a store failure.

Each attempt's worker-event sink is active only until that attempt settles. Events emitted later by a stale adapter callback are ignored, so they cannot cross into a retry, appear after terminal state, reach observers, or consume durable event budget.

### Terminal semantics

A succeeded job has `result`, terminal timestamps, resolved route evidence, attempt count, any captured artifacts, and a completion summary. A failed or cancelled job has `error`, terminal timestamps, attempt count, ordered events, any artifacts captured from failed attempts, and a completion summary. The summary's `attempt` and captured changed paths always refer to the terminal attempt; a worker report is retained only when a normal result was retained for that terminal success.

Artifact inspection is a read-only orchestrator/workspace operation. The TypeScript API exposes `listArtifacts(jobId)`, `verifyArtifacts(jobId)`, and `previewArtifact(jobId, attempt)` with the language-neutral `JobArtifactList`, `JobArtifactVerificationReport`, and `JobArtifactPreview` payloads. Verification resolves only recorded artifacts, validates managed paths, recomputes size and SHA-256 under 16 MiB, compares the base commit with current `HEAD`, and for artifacts carrying `baseTree` compares the exact current source tree. Same-HEAD content drift returns `base-tree-mismatch`; legacy artifacts retain HEAD-only verification. Preview remains available for intact diagnostic bytes despite a base mismatch, but never applies patches or mutates, commits, merges, or pushes the source repository.

Usage inspection is a separate read-only projection exposed by `AgentKnotRuntime.usage()` and CLI `agentknot usage [--json]`. It reads Job and Orchestration stores once and never invokes an adapter, requests fresh statistics, probes a route, acquires execution ownership, reconciles snapshots, or writes records. The schemaVersion 1 report scopes total/successful Jobs, Jobs with valid/unavailable statistics, observed worker attempts with valid/unavailable statistics, terminal orchestrations, and planned subtasks; it returns downstream usage, route-selection evidence, advisory quality-review evidence, upstream usage availability, and upstream/downstream proportion availability.

Every newly completed worker attempt appends one fixed-shape `attemptUsage` observation before artifact or terminal persistence. It contains only non-negative safe-integer `input`, `output`, `cacheRead`, `cacheWrite`, and provider-reported `total` token fields plus a non-negative finite provider-reported cost, or one of `missing`, `timeout`, `unsupported`, `invalid`, and `worker-failure`. A result that is later rejected by shared orchestration policy still retains its available usage; a pre-settlement process/protocol failure records `worker-failure` without inventing tokens. Durable recovery likewise records `worker-failure` for an expired-lease running attempt before retry, cancellation, or exhausted-recovery settlement, unless that exact attempt already persisted evidence. Attempt evidence is authoritative when present and each distinct attempt contributes at most once, so terminal result metadata cannot double-count the last attempt. Successful legacy Jobs without `attemptUsage` retain the prior `result.metadata.sessionStats` fallback; failed legacy Jobs do not acquire inferred usage. Exact available attempts may still be summed under partial coverage. A valid all-zero observation remains available, while malformed, unsafe, duplicate-attempt, empty-attempt, or aggregate-overflow evidence is unavailable rather than rounded. Provider totals are preserved instead of repaired from components, and provider cost has no implied currency, price conversion, billing equivalence, or cross-provider comparability ([decision 0086](../postmortems/0086-per-attempt-usage-evidence.md)).

The same report separately folds persisted `routePoolSelection` evidence across all Jobs. A classified entry must retain `least-active`, contain its selected member in the candidate list, match the exact `job.route.name`, and retain the rotating tie-break. Counts group by logical pool and exact selected route with complete/partial coverage; malformed observed evidence is unavailable rather than inferred. This distribution is admission evidence, not capacity, success-rate, latency, quality, health, or quota measurement.

The downstream cache-read hit rate is `sum(cacheRead) / (sum(input) + sum(cacheRead))`; sums are taken before division, and output plus cache-write tokens are excluded. A zero input-side denominator or unsafe aggregate makes the rate unavailable. Route-rule hit rate is `rule / (rule + default)` and is reported separately for active and shadow evidence. Only `plan.subtasks[].routeSelection` from terminal Orchestration records is counted, checked against that record's immutable policy snapshot and persisted subtask route. Rule basis is authoritative even if the rule names the default route; a catch-all is still a rule hit. Omitted, malformed, or policy-inconsistent evidence is unclassified, never recomputed from the current configuration, child route, task prompt, or model output.

No current persisted contract carries exact controller token usage comparable to downstream Pi totals. `upstream` and `proportions` therefore return `status: "unavailable"` with reason `controller-usage-not-persisted`; downstream must not be displayed as 100%. The runtime does not parse Codex/Claude transcripts or arbitrary request metadata, read account quota summaries, accept inferred values, or normalize differing token units. A future exact controller-usage boundary requires its own versioned contract before proportions can become available ([decision 0034](../postmortems/0034-persisted-usage-observability-boundary.md)).

Quality-review aggregation considers only terminal Orchestrations whose immutable policy configured `qualityReview`. Structurally valid persisted evidence is grouped into completed/skipped/unavailable outcomes, completed verdicts, finding severities, reviewer route names, and skipped/unavailable reasons; absent, pending, malformed, or policy-route-inconsistent evidence is unclassified. The usage projection does not read the separate TypeScript-only Disposition store, so its `controllerDisposition` field remains unavailable with the existing `controller-review-disposition-not-persisted` reason; an explicit DispositionRecord is the separate source of the controller's final Candidate decision. A direct reviewer Job outside orchestration contributes ordinary downstream token statistics but not orchestration quality-review outcomes.

Cancellation is cooperative at the `WorkerAdapter` boundary. The orchestrator aborts the attempt signal and rejects a normal worker result received after abort. A custom adapter that never settles and ignores the signal can currently prevent completion indefinitely. The Pi adapter owns its exact Pi child: after abort or any terminal path it uses a bounded `SIGTERM` grace period, escalates to `SIGKILL`, and drains or closes only that child's owned stdout/stderr streams before settling. This is exact-child supervision, not broad process-group or arbitrary-descendant cleanup.

A timeout aborts the same attempt signal. It is not a universal hard kill independent of adapter behavior.

### Callback semantics

When `callbackUrl` is supplied, AgentKnot currently:

- attempts at most one HTTP POST after terminal execution;
- sends the complete job snapshot as JSON;
- waits at most ten seconds for the request;
- refuses to make the request when the compact JSON body exceeds 8 MiB and attempts to record the measured-size error as undelivered;
- records delivery boolean, HTTP status, or error;
- does not sign, authenticate, retry, deduplicate, or allowlist the request;
- never converts a succeeded job to failed because callback delivery failed.

Callback delivery and callback bookkeeping are outside the execution failure path. Delivery is attempted at most once. If the terminal Job is already persisted but saving its callback delivery state fails, the completion promise rejects with that store error; the persisted terminal execution result remains authoritative, and AgentKnot neither rewrites it as failed nor sends the callback again. Because the bookkeeping write failed, persisted state cannot claim whether delivery occurred.

Callbacks are for trusted local controllers until a later security contract passes its roadmap gate.

## Orchestration lifecycle

### Handoff admission and plan composition

```text
queued -> upstream/suggested -> succeeded
       -> dispatching -> succeeded | failed | cancelled
       -> failed | cancelled
```

Global modes are `off`, `suggest`, and `auto`. Omitted delegation configuration resolves to `off`. Configured `suggest` or `auto` requires `workspaceIsolation.mode: "git-worktree"`. The controller assessment is validated before parent admission; it is not a Job or model call. Every dispatched child is an ordinary leaf Job, so route snapshots, isolation, retries, events, artifacts, and cleanup use the existing Job contract.

The controller owns the semantic rules formerly expressed through a middleware planner: delegation and parallelism are distinct; a single substantive task may be one non-parallel subtask; parallel subtasks require independent verification, no execution-order dependency, and non-overlapping expected write scopes; repository analysis names target, references, scope, and non-goals. AgentKnot treats all of these as untrusted declarations. The deterministic composer applies configured `delegate` and `keepUpstream` task-kind sets, child caps, depth one, route policy, and effective concurrency, assigns stable subtask IDs, captures exact execution prompts/routes, and hashes the plan. Disallowed kinds are retained upstream and an over-cap assessment is rejected rather than truncated.

When delegation dispatch limits are omitted, the product defaults to `maxChildren: 2` and `maxConcurrency: 2`; the configuration parser permits values from one through six, and `maxConcurrency` cannot exceed `maxChildren`. This repository's dogfood configuration uses six for both. Historical six-child orchestrations at configured concurrency four, five, and six remain point-in-time worker/provider capacity evidence, not evidence for the removed planner path. Capacity never requires the controller to manufacture tasks, and fewer eligible independent subtasks use fewer workers.

When route selection is configured, the deterministic composer evaluates ordered rules only after a subtask passes ordinary delegation policy and records first-match/default evidence. Shadow mode keeps `dispatch.defaultRoute`; active mode writes the configured selection into the planned route. Both add task kind, parent assessment complexity, and evidence to child metadata. This is human-authored policy, not controller-controlled routing or automatic model/provider ranking.

Optional quality review and artifact validation are evaluated after child dispatch and artifact-path review; neither participates in plan composition or child route selection. Review starts only the configured review route and never infers a reviewer model from the worker route, controller source, model name, or a claimed intelligence ordering. Validation starts only the configured exact argv and does not select a route or model.

Parent creation persists `orchestration.queued`; execution then persists `orchestration.handoff.accepted` with the validated assessment-derived plan before `orchestration.planned` and before the first child starts. `suggest` persists the same evidence without dispatch. There is no planner Job, planner route, planner error/fallback state, or middleware semantic retry.

### Dispatch and cancellation

Every direct, child, and configured reviewer Job enters the same FIFO capacity boundary owned by `Orchestrator`, using `delegation.dispatch.maxConcurrency` as the configured limit. The SQLite store admits and reclaims capacity with the current fenced Job lease; memory/legacy stores use an abort-aware FIFO semaphore. A parallel parent additionally fills at most its own effective concurrency and refills as children settle; `parallelizable: false` forces effective child concurrency one. Artifact validation is not a Job and uses one separate process-local slot so eligible validation and review can overlap. `maxDepth` is exactly one. Worker/reviewer prompts prohibit recursive delegation and publication actions.

Live control is an optional route-neutral adapter capability for one exact active Job attempt. `steer` and `follow-up` requests carry a caller-supplied idempotent control ID, exact attempt, kind, and bounded message. AgentKnot persists `job.control.requested` before delivery and then exactly one accepted, rejected, or lost settlement when persistence is available; terminal execution is fenced until every persisted request for that attempt has settlement evidence. A retry, restart, stale attempt, unsupported adapter, timeout, or uncertain receipt never triggers message replay. Pi RPC correlates private command IDs inside its adapter and quarantines late control responses from the main run. This surface does not add planning, general agent chat, cross-Job memory, or controller-transcript access.

Cancellation first persists `cancelRequestedAt` and `orchestration.cancel.requested`, then aborts active children, reviewer, or validation and prevents later work from launching. The parent completes only after launched work settles. The service computes additive artifact-path, optional quality-review, and optional artifact-validation evidence before the terminal event. One or more non-succeeded children make a delegated parent failed; unavailable/changes-requested review or failed/unavailable validation does not. AgentKnot does not integrate patch artifacts.

## Events

Current lifecycle event types are:

- `job.queued`
- `job.started`
- `job.retrying`
- `job.succeeded`
- `job.failed`
- `job.cancelled`
- `job.artifact`
- `job.observer.failed`
- `job.worker.events.truncated`

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

Core consumers may depend on the normalized event name, job ID, sequence, timestamp, and JSON-compatible data. They must not depend on an undocumented Pi RPC payload hidden inside `worker.raw`. Pi maps the canonical `tool_execution_start`, update, and end frames once; assistant-stream `toolcall_end` only completes model output and does not represent a second execution start. Event `data` is normalized through JSON and limited to 16 KiB as a standalone pretty-printed value; an oversized, non-object, or non-serializable value is replaced by `agentknotRecordLimit` evidence. An oversized normalized tool event keeps only bounded call/name/error lifecycle identity plus that marker; arguments and results are removed. Each Job retains at most 512 `worker.*` events. The first excess event is represented by one persisted `job.worker.events.truncated` carrying the cap and first dropped type; later worker events are neither persisted nor sent to the live observer. Lifecycle events are not counted, so terminal state can still be recorded after a worker-event flood ([incident 0066](../postmortems/0066-pi-duplicate-tool-start-events.md) and [incident/decision 0072](../postmortems/0072-compact-worker-activity-and-pi-frame-coalescing.md)).

### Pi normal-run record-volume boundary

For normal `PiRpcWorkerAdapter.run` executions only, exactly four Pi lifecycle envelope types are recognized as known bookkeeping frames: `turn_start`, `turn_end`, `message_start`, and `message_end`. The adapter does not emit `worker.raw` for those frames, but every received Pi frame still increments `metadata.rawEventCount`, including the four known envelopes; unknown event types continue to emit `worker.raw`. Consecutive text deltas are concatenated until a fixed byte threshold, immediately before every non-text event, and at stdout end; exact final output and non-text ordering remain unchanged. Tool and retry events, completion-report behavior, live-probe behavior, route/provider/model/thinking configuration, and the global event-type list are unchanged. This is bounded private-protocol normalization, not a Pi-token-saving claim or general truncation; it adds no schema migration, queue, plugin installation, configuration change, or probe change ([incident/decision 0072](../postmortems/0072-compact-worker-activity-and-pi-frame-coalescing.md)).

Terminal `result.output` retains at most a 1 MiB valid UTF-8 prefix. If shortened, `result.outputTruncation` records the original and maximum byte counts. Result metadata is JSON-normalized, limited to 64 KiB as a standalone pretty-printed object, and replaced with structured evidence if oversized or non-serializable. Error names are limited to 256 bytes and messages to 16 KiB, with an inline original-byte notice when truncated. The supported Pi adapter stream-decodes stderr and retains a valid UTF-8 suffix of at most 4 KiB before the global event-data and event-count limits apply.

These record budgets do not limit worker compute, upstream provider token use, patch artifact bytes, or retention duration. Prompts, retained model output, stderr, tool data, metadata, and patches may contain sensitive user or repository content. No document may imply automatic redaction until that separate feature exists and is verified ([decision 0023](../postmortems/0023-fixed-durable-record-budgets.md)).

Pi RPC is strict LF-delimited JSONL. Its adapter decodes streaming UTF-8 explicitly and does not assume that process chunks align with JSON messages or use Node `readline` behavior as its protocol definition. Each non-empty line must parse as a JSON object; malformed input reports line context. Process exit before `agent_settled` is an error, with `agent_end`-without-settlement distinguished from exit before `agent_end`.

Normal-run cleanup waits a fixed grace window for the owned stdout/stderr tasks. If they remain pending because an external `WorkerEventSink` Promise never settles, the adapter destroys only those owned streams and returns from output draining while retaining `Promise.allSettled` observation of the detached tasks. Abort or timeout can therefore settle after exact-child termination instead of waiting forever. This does not cancel the external promise, hide an ordinary sink rejection that reaches settlement before the grace deadline, or authorize process-wide cleanup.

Every Pi normal run and live probe appends each of `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-themes` exactly once after deduplicating configured arguments. Explicit resources remain unchanged. The adapter does not add `--no-context-files` or `--no-tools` by default. The repository reviewer explicitly allows only `read,grep,find,ls`. These controls reduce ambient variability and mutation capability but do not form an OS security sandbox.

For normal `run` jobs only, the Pi adapter appends one concise provider/model-neutral instruction after the supplied prompt. It asks the final assistant message to end with exactly one single-line suffix beginning `AGENTKNOT_WORKER_COMPLETION_REPORT_V1: ` and followed by schemaVersion 1 `WorkerCompletionReport` JSON containing `taskOutcome`, `changedFiles`, checks, risks, and notes. `taskOutcome` describes completion of the assigned worker-role task, not acceptability of an inspected subject: a completed review may request changes, while `blocked` is required whenever the assigned task itself was not completed. The advisory-review prompt reserves that transport-owned suffix as its only permitted content outside role JSON. The adapter parses only the exact final marked line. A valid blocked line is returned through the common adapter result and settled centrally as a non-retryable failed Job. After an otherwise successful first turn settles with an invalid suffix, the adapter sends exactly one new Pi `prompt` while the same RPC process/session is idle; Pi's `follow_up` command is not used because an idle follow-up only queues and does not start a turn. The prompt requests only the required envelope and does not authorize repeated task work or tools. Success stays in the same Job attempt and requests session statistics only after both turns; a second invalid settlement is terminal `WorkerSettledError`. Normalized `worker.retry.*` evidence uses scope `completion-envelope`, attempt/max `1/1`, and generic outcome/reason without persisting the prompt or raw worker/provider text. Ordinary prose, tool events, stderr, statistics, and valid empty patch artifacts are never substitutes. Doctor and live probe do not use this protocol ([incident/decisions 0044](../postmortems/0044-required-worker-completion-and-canonical-worktree-id.md), [0069](../postmortems/0069-repeated-shared-context-scope-trials.md), [experiment/incident 0080](../postmortems/0080-artifact-read-review-ab.md), and [incident/decision 0085](../postmortems/0085-in-session-completion-envelope-recovery.md)).

After a normal Pi session reaches a final `agent_settled`, the adapter sends at most one correlated `get_session_stats` RPC request before terminating its owned child. This includes successful output, a settled assistant/provider error, and a second invalid completion-envelope settlement. It allowlists non-negative message/tool counts, input/output/cache/total token counts, cost, and optional context usage into successful `result.metadata.sessionStats` for compatibility, while the orchestrator persists only the fixed-shape token/cost projection for each attempt. Timeout, unsupported responses, and invalid shapes remain explicit unavailable evidence and cannot change the Job outcome. A child that fails before settlement has no queryable statistic and records `worker-failure`; live probes do not collect usage statistics ([decision 0086](../postmortems/0086-per-attempt-usage-evidence.md)).

The Pi adapter derives one effective environment by overlaying configured worker environment values on `process.env`. Configuration-only doctor, live probe, and normal run use that snapshot consistently for bare-command `PATH` lookup, required environment presence, Pi's explicit agent directory, worker-home default auth directory, and spawned child environment. Empty or whitespace credential values are absent. A relative command containing a path separator, a relative `PATH` entry, or a relative `PI_CODING_AGENT_DIR` remains relative to AgentKnot's own process directory during doctor because that boundary has no worker workspace.

Orchestration events cover queued, controller handoff accepted, planned, dispatching, child start/completion, advisory review skipped/started/completed/unavailable, artifact validation skipped/started/completed/unavailable, cancellation requested, and terminal succeeded/failed/cancelled transitions. Their sequence is gap-free within one parent snapshot. Historical schemaVersion 1 records may still contain the former `planning` status/events; they remain readable but are never newly emitted. Leaf Job events remain authoritative for worker-level activity.

## HTTP surface

Current endpoints are:

```text
POST /v1/jobs
GET  /v1/jobs
GET  /v1/jobs/:id
GET  /v1/jobs/:id/events
POST /v1/jobs/:id/cancel
GET  /v1/jobs/:id/artifacts
GET  /v1/jobs/:id/artifacts/verify
GET  /v1/jobs/:id/artifacts/:attempt/preview
GET  /v1/delegation
POST /v1/orchestrations
GET  /v1/orchestrations
GET  /v1/orchestrations/:id
GET  /v1/orchestrations/:id/events
POST /v1/orchestrations/:id/cancel
GET  /v1/routes
GET  /health/live
GET  /health                    compatibility alias
```

`POST /v1/jobs` starts execution in the serving process and returns `202` with the admitted snapshot. Terminal full `JobRecord` JSON returned by HTTP, CLI `--json`, TypeScript methods, and callbacks includes the additive `completionSummary` when the record was newly terminal; no new endpoint or serializer is required, and human CLI rendering remains unchanged.

`GET /v1/jobs`, local/remote `agentknot jobs --json`, and `AgentKnotHttpClient.listJobs()` return one canonical `JobList` summary page capped at 1 MiB including its trailing newline. Each item includes only schema version, ID, status, logical route name, timestamps, and attempt. The page includes total, truncation, and `maxBytes`; exact `show`/`GET /v1/jobs/:id` remains the full-record surface. A single oversized summary may be omitted rather than violating the page bound.

Cancellation first persists an idempotent request by durable record ID. The current lease owner observes it while renewing, and an accepted request atomically prevents a later success transition; local abort handles only accelerate cooperative cleanup. Wait and status re-read durable records and do not require the admitting HTTP process's completion map. Leaf and parent recovery resolve persisted cancellation before replay, so outage-time cancellation becomes terminal without starting new adapter work.

After `run` or `orchestrate` admission, the CLI installs catchable `SIGINT` and `SIGTERM` handlers that cancel that exact execution, await cleanup, then release ownership. HTTP `close()` atomically closes admission, waits for in-flight admissions, asks the kernel to cancel and drain its active Jobs/orchestrations while the listener still serves liveness/read requests, returns 503 for new execution POSTs, then closes the listener. HTTP keeps no authoritative completion/cancellation map. The CLI releases runtime ownership only after HTTP close settles. Response-stream errors remain connection-local. A hard kill leaves exact leaf/parent recovery to the next expired-fence owner; arbitrary external descendant cleanup remains unavailable ([incident/decisions 0046](../postmortems/0046-clutch-review-listing-and-shutdown-gaps.md) and [0055](../postmortems/0055-durable-middleware-kernel.md)).

`createRuntime()` accepts `reconcileOnStartup`, which defaults to `true`. The default constructs an execution owner, acquires both transitional storage locks, and performs fenced leaf and parent recovery from admitted evidence. Passing `false` constructs an enforced read-only runtime: it opens configured stores without ownership or recovery and refuses execution/recovery calls. CLI `run`, `orchestrate`, `broker run`, and the deprecated parameter-valid `serve` alias use the owning path; read-oriented and invalid CLI commands use the read-only path. Therefore `show`, lists, usage reporting, artifact inspection, routes, delegation inspection, and both doctor modes cannot mutate Job or Orchestration records. See resolved [incident 0010](../postmortems/0010-read-only-cli-runtime-reconciliation.md), transitional [decision 0022](../postmortems/0022-file-runtime-single-writer-ownership.md), and [decisions 0055](../postmortems/0055-durable-middleware-kernel.md) and [0057](../postmortems/0057-independent-broker-and-thin-controller-clients.md).

The repository's POSIX `npm run test:stage1-soak` starts the public CLI/Pi/restart/worktree matrix in one unique detached process group, imposes a 60-second bound, forwards catchable termination to that exact group, escalates it after a two-second grace, and fails after cleaning the exact group if any attributed descendant remains after the test runner exits. This development runner does not strengthen runtime behavior under hard `SIGKILL` or host loss ([incident 0024](../postmortems/0024-stale-dogfood-test-processes.md)).

`GET /health/live` is the canonical liveness response for the HTTP process; `GET /health` is an identical compatibility alias. Both return `{"ok":true,"service":"agentknot","status":"live","checks":{"storage":"not-checked","routes":"not-checked","inference":"not-checked"}}` and do not access runtime methods, storage, credentials, workers, or providers. `GET /health/ready` is intentionally absent. Route diagnostics, including the opt-in live probe, are exposed by the CLI `doctor` command; they are not currently an HTTP endpoint. See [decision 0011](../postmortems/0011-explicit-http-liveness-contract.md).

There is no authentication, authorization, TLS termination, CORS policy, rate limiting, admission limit, or untrusted-network security contract. The server should remain bound to trusted local interfaces unless an external trusted proxy supplies those controls.

## Safety and secrets

### Enforced intent

- Credentials stay in environment variables or Pi's external credential store.
- Configuration declares required environment-variable names, not their values.
- AgentKnot does not intentionally copy API keys or auth-file contents into job records.
- The broker launch profile contains only schema version, validated absolute config path, and port; it contains no credentials, prompt, transcript, route, model, endpoint identity, or Job data.
- Pi session-stat metadata is allowlisted and excludes session paths, session identifiers, raw responses, and provider error text.
- Controller packages retain no workspace, session, prompt, transcript, credential, route, model, endpoint, or Job state. Their identical stateless `SessionStart` hook reads only bounded event JSON for `startup`, `resume`, `clear`, and `compact`; no `UserPromptSubmit` hook exists. Workspace selection comes from the upstream controller's task context and is explicit in the admitted request.
- Managed worktree cleanup targets an exact path created and owned by AgentKnot.
- Git patch artifacts are never applied automatically.
- Automatic delegation cannot be configured without Git worktree isolation, is depth-one, and never promotes child artifacts.
- Shadow route-selection evidence never overrides `dispatch.defaultRoute`. Active route selection can override it only through a validated configured rule; the resulting ordinary child `Job.route` remains authoritative, its configured thinking level is preserved, and no fallback or mid-attempt switch is added.
- Advisory review never promotes or repairs an artifact in the orchestration engine. Its prompt prohibitions and configured read-only Pi profile reduce mutation capability, but an arbitrary host-capable adapter is not an OS security sandbox and remains subject to the worker threat boundary.
- Artifact validation applies a recorded patch only to an exact disposable managed worktree, supervises only its exact configured child, and never turns command success into source-tree application or promotion. The trusted command inherits host process authority and is not sandboxed.

### Explicit limitations

- Prompts, model output, stderr, tool arguments/results, patches, and controller metadata may themselves contain secrets.
- A worker has the operating-system permissions of its process.
- Worktree isolation is not a filesystem, process, credential, or network sandbox.
- Callback URLs can cause outbound requests from the AgentKnot host and receive the complete job snapshot when its compact JSON is no more than 8 MiB.
- The current system has fixed record/artifact budgets and an indefinite local-retention policy, but no automatic expiry, purge, or content-redaction mechanism.

## Capability evolution

AgentKnot does not yet expose a capability registry. Before adding one, each capability must describe behavior already implemented and tested, not an aspiration.

A future worker capability contract may need to distinguish:

- structured versus inferred events;
- cooperative cancellation versus process-supervised termination;
- session resume;
- active follow-up input;
- worker-reported file-change evidence distinct from controller-captured Git paths;
- terminal visualization;
- approval requests;
- usage and model-resolution evidence.

This list is a design prompt, not a declaration that current workers support those capabilities.

Runtime selection and provider fallback must be completed before a job starts. A started attempt must not silently switch runtime, worker, provider, or model unless a future explicit policy records a new attempt and the exact reason.

Human-authored active route selection does not satisfy or claim a model-ranking or provider-optimization gate. Any future learned or automatically optimized selection requires separate measured scorecards on comparable workloads, with route outcomes and costs recorded before such a policy can be proposed.

## Compatibility and schema rules

- Public runtime input must be validated at its transport boundary.
- WorkOrder commands are immutable after issue. Executor Job binding is additive, purpose-specific, and CAS-protected; changing the command or replacing a bound Job requires a future explicit domain mechanism rather than a general save.
- CandidateRecord creation is explicit through `CandidateService` and the WorkOrder-rooted `task-candidate` CLI composition. A Candidate is immutable and status-free, stores one WorkOrder ID, one bound Executor Job ID, and one exact recorded `git-patch` identity (`path`, `sha256`, `baseCommit`), and has no general save or status transition. Its WorkOrder/Job reads and Candidate persistence are separate stores rather than one cross-store transaction; sequential CLI reuse does not claim concurrent exactly-once creation.
- ReviewRecord creation is explicit and TypeScript-only. A Review is immutable and status-free, stores one Candidate ID, bounded reviewer/summary text, and bounded structured findings, and has no general save, verdict, recommendation, acceptance/discard value, lifecycle status, or `updatedAt`. Its read-only Candidate validation and Review persistence are separate stores rather than one cross-store transaction; it never converts orchestration quality-review evidence.
- DispositionRecord recording is explicit and TypeScript-only. A Disposition is immutable and status-free, stores one Candidate ID, one belonging Review ID, `accept` or `discard`, bounded `decidedBy` and rationale, and one purpose-specific event; its deterministic fixed-length Candidate-derived identity permits one record per Candidate, exact replay, and explicit conflict without general save. Candidate/Review validation and Disposition persistence are separate stores rather than one cross-store transaction, and the record never mutates or promotes artifact/workspace state.
- Existing job snapshots must retain their resolved route and event meaning.
- New optional fields may be added compatibly; changing state or event semantics requires a versioned contract and migration decision. `JobArtifact.baseTree` and `changedFiles` are optional when reading persisted records, while newly captured git-worktree artifacts always emit both.
- `delegation.dispatch.routeSelection` is optional configuration, and its shadow/active evidence is additive plan/metadata evidence; omission remains disabled and does not change persisted Job or Orchestration `schemaVersion: 1`.
- `JobRecord.completionSummary` is optional for legacy v1 reads; existing records without it are not rewritten, while newly terminal records produced by this runtime include the additive summary.
- `OrchestrationResult.artifactReview` is optional for legacy/upstream/suggested results; newly terminal delegated results include the additive review without changing record schemaVersion 1.
- `delegation.qualityReview` and `OrchestrationRecord.qualityReview` are optional; omission preserves the prior lifecycle, while newly configured records carry additive reviewer policy/evidence without changing schemaVersion 1. Reviewer route/provider/model changes affect resolved reviewer Jobs, not the core record shape.
- `delegation.artifactValidation` and `OrchestrationRecord.artifactValidation` are optional; omission preserves the prior lifecycle, while newly configured records carry additive controller-owned command/cleanup evidence without changing schemaVersion 1 or creating a Job/route/model dependency.
- `WorkerRunResult.completionReport` remains optional for custom adapters: `undefined` is absent, `null` is a detected malformed or unsupported envelope, and a non-null value is strictly validated before it enters a summary; custom adapters that return only `output` remain valid, while the built-in Pi normal-run adapter requires a valid envelope before returning.
- Historical controller-session workspace-binding files are no longer read or written by current packages. They are superseded private adapter residue, not Job/Orchestration state or a public schema.
- One wire payload should have one canonical type/schema. HTTP, CLI, callbacks, and TypeScript APIs must not describe the same payload independently without a mechanical compatibility check.
- Worker-specific transport fields belong in adapter-owned metadata or raw evidence, not in the controller-neutral top-level contract; the explicitly versioned `WorkerCompletionReport` is the narrow route-neutral exception for worker claims under `JobCompletionSummary.workerReported`.
- Removal or renaming of public states, event types, artifact fields, or endpoint semantics requires an explicit migration plan.

## Verification requirements

Any change to a stable contract must include deterministic evidence at the owning boundary.

At minimum, the conformance suite must eventually prove:

- WorkOrder issue/read/list/event persistence, restart round-trip, immutable command fields, first executor Job binding, same-Job idempotent replay, different-Job conflict, stale first-bind rejection, concurrent different-Job conflict, and binding restart persistence without Job/Orchestration mutation;
- CandidateRecord creation/read/list/event-cursor persistence, restart round-trip, immutable/status-free shape, exact WorkOrder-to-bound-Job and `git-patch` identity validation, rejection of missing or mismatched source/artifact references, source-record nonmutation, defensive-copy behavior, and rejection of general Candidate updates;
- ReviewRecord creation/read/list/event-cursor persistence, restart round-trip, schemaVersion 1 status-free shape without verdict/recommendation/acceptance/discard/status/`updatedAt`, bounded invalid-input rejection, low/medium/high finding validation, defensive-copy behavior, missing-Candidate rejection, multiple reviews for one Candidate, source-record nonmutation, and rejection of general Review updates;
- DispositionRecord accept/discard recording/read/getForCandidate/list/event-cursor persistence, fixed-length Candidate-derived identity, exact replay without a second event, different-input and concurrent conflict, missing/mismatched Candidate/Review rejection, restart round-trip, strict bounds, defensive copies, source/artifact nonmutation, atomic create/event persistence, unsupported schema rejection, and general-save rejection;
- controller source neutrality and independent route resolution;
- Codex/Claude manifest, MCP, Skill, and identical `SessionStart` hook parity for `startup`, `resume`, `clear`, and `compact`; bounded stateless event handling; no `UserPromptSubmit` hook or raw-prompt forwarding; common explicit stopped-broker activation from a strict launch profile; and unavailable launch without target-repository or model fallback;
- atomic durable admission, canonical-request idempotency, append-only cursor resume, stale-CAS rejection, monotonic lease fences across expiry and release, cancellation/success races, late stale completion, and cross-process wait/cancel by record ID;
- single-broker SQLite scheduler-ownership contention/release, foreground and detached application lifecycle, exact instance/PID status and stop, stale-record cleanup, and hard-restart parent/child recovery without shell-profile, systemd, launchd, Unix-socket, or controller-lifecycle requirements;
- route snapshot immutability;
- valid and invalid request/configuration handling;
- gap-free persisted event order and persist-before-live delivery;
- terminal state behavior for success, failure, retry, cancellation, and timeout;
- callback failure isolation;
- adapter decoding of split UTF-8, split JSONL frames, malformed frames, premature exit, and terminal settlement;
- clean and supported dirty source repositories with independent retry worktrees;
- patches and Git-derived repository-relative `changedFiles` for tracked modifications and deletions, non-ignored untracked, binary, worker-committed, empty, retry, and unusual-filename changes;
- terminal completion summaries for success, direct mode, captured empty/nonempty paths, optional custom-adapter absent/malformed worker reports, failure, cancellation, retry terminal-attempt scoping, persist-before-observer ordering, callback/HTTP/CLI JSON surfaces, and legacy record byte stability;
- artifact checksum and base-application validity;
- exact cleanup on success, failure, retry, timeout, and cancellation;
- sparse-checkout no-op and in-cone-edit artifact capture, plus non-retryable failure with retained evidence when a delegated `repository-analysis` writes a path;
- documented crash/restart behavior;
- configuration-only doctor wording, successful and failed/unsupported live-probe outcomes, timeout/abort cleanup, CLI exit behavior, exact Pi propagation of route thinking level, and built-in Pi normal-run completion-report prompt injection, valid completed/blocked parsing, route-neutral non-retryable blocked settlement with retained report evidence, same-session recovery plus terminal exhaustion for missing/malformed/unsupported/non-terminal suffixes, output preservation, strict end anchoring, summary propagation, live-probe exclusion, and a public empty-artifact regression that cannot succeed without the envelope;
- strict controller-assessment validation across TypeScript/HTTP/CLI, deterministic policy filtering, persisted handoff/plan evidence before dispatch, parent/child provenance, shared FIFO Job concurrency, and orchestration cancellation;
- delegated parent artifact review for captured empty/disjoint paths, exact grouped multi-child overlaps, incomplete evidence, deterministic ordering, persistence before terminal observation, and source nonmutation;
- strict route-selection configuration rejection, candidate-route validation at config load, first-match/default behavior, zero-based match indexing, plan-hash coverage, shadow default-route authority, exact active-route dispatch, and public child metadata carrying task kind, parent complexity, and evidence;
- strict optional quality-review configuration, omission behavior, eligibility skips, separate reviewer admission, valid/invalid/truncated verdict output, advisory changes-requested/failure behavior, cancellation and restart reconciliation, semaphore participation, compact handoff, persisted usage aggregation, source neutrality, and source-workspace nonmutation;
- strict optional artifact-validation configuration, omission and eligibility skips, exact-artifact revalidation, exact admitted-tree/source-drift refusal, disposable dirty-baseline recreation and application, shell-free argv execution, pass/nonzero/timeout/output-limit/start/cancellation outcomes, bounded combined output including start errors, concurrent reviewer overlap, separate single-slot admission, cleanup/restart evidence, advisory parent behavior, compact handoff, and source-workspace nonmutation;
- the fixed documented concurrency and record-size limits under adversarial stress, including rejected writes and delivery refusal.

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

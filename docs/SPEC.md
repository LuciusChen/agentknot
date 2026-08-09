# AgentKnot technical specification

- Status: Living architecture contract
- Version: 0.1
- Last updated: 2026-08-09
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
```

The controller, worker, provider, and model are separate concepts:

- A **controller** decides what work to request and submits it through the Job API.
- The **orchestration service** classifies a goal, applies deterministic delegation policy, persists the plan, and submits selected children through the Job API.
- The **orchestrator** owns the job lifecycle and policies shared by every worker.
- A **worker adapter** translates one worker runtime and protocol into AgentKnot contracts.
- A **provider/model route** is configuration passed to the worker. It is not currently a standalone runtime abstraction.
- The **workspace manager** prepares and cleans attempts and captures artifacts independently of the worker.

## Boundary ownership

| Concern | Owner | Must not leak into |
| --- | --- | --- |
| Native command/Skill presentation and controller-specific audit `source` | controller integration adapter | orchestration policy, routes, worker adapters, or artifact promotion |
| Prompt, workspace, caller identity | `JobRequest` | worker-specific request types |
| Delegation mode, task-kind policy, child/depth/concurrency caps, and optional human-authored route-selection policy | orchestration service/configuration | controller-vendor branches or worker adapters |
| Planner assessment parsing and deterministic plan composition | orchestration service | planner-model discretion at dispatch time |
| Parent policy/plan/events/child provenance | `OrchestrationStore` | leaf `JobStore` semantics |
| Route resolution | configuration/orchestrator | controller identity branches |
| State, attempts, retry, timeout, cancellation | orchestrator | provider-specific code |
| Process startup and wire protocol | worker adapter | Job API and store |
| Provider/model flags | resolved route and worker adapter | controller-specific code |
| Worktree creation, capture, cleanup | workspace manager | worker adapter |
| Persistent snapshots | `JobStore` | live event listeners |
| HTTP transport and active-request map | HTTP server | worker protocols |
| Artifact listing, verification, and preview | orchestrator/workspace manager | worker adapter or execution loop |
| Terminal completion summary and provenance ordering | orchestrator with workspace-manager artifact evidence | worker adapter/provider claims |
| Child artifact path-overlap review | orchestration service using terminal Job evidence | worker/planner claims or semantic diff parsing |
| Persisted usage aggregation and complete/partial/unavailable semantics | read-only runtime usage projection | worker adapters, controller transcript parsing, route re-evaluation, or pricing normalization |
| Artifact acceptance/rejection | external controller or human | Job/Orchestration terminal state |
| Artifact promotion/application | external controller or human | AgentKnot execution loop |

Moving a responsibility across this table requires a SPEC update and a decision record before implementation.

## Current public contracts

The canonical TypeScript definitions are in `src/types.ts` and `src/orchestration-types.ts`. Other transports and documentation must derive from or remain mechanically checked against those contracts; one runtime payload must not acquire multiple hand-maintained definitions.

### Experimental controller integrations

The repository contains separate installable Codex and Claude plugin packages plus their native marketplace manifests. Each exposes one `agentknot-delegate` Skill. Codex uses explicit `$agentknot-delegate` and disables implicit Skill matching; Claude uses its required plugin namespace `/agentknot:agentknot-delegate`. Automatic entry is the separate pre-model hook path described below.

The explicit Skill is an adapter over the existing CLI, not another public payload: it first requires `command -v agentknot` to succeed, resolves the workspace Git root, calls `agentknot orchestrate --handoff-json` with `source: "codex"` or `source: "claude"`, consumes the compact terminal handoff and its embedded artifact verification, and uses the existing preview command only for valid non-empty artifacts. If the executable is absent, the Skill stops before orchestration and reports the prerequisite instead of substituting another command, worker, provider, or model. Informational chat, requirements/product decisions, artifact acceptance/promotion, commit, push, merge, and deployment remain upstream.

`--handoff-json` is a CLI-only projection of the authoritative terminal `OrchestrationRecord`, not a second persisted schema. It retains schema version, orchestration identity/status, source/delegation audit values, planner ID, plan decision/hash/reasoning, assessment classification, compact subtask route evidence, one copy of child status/output/error, result action/artifact review, terminal error, and compact read-only artifact size/SHA-256/base/changed-path verification. It omits request prompt/workspace/metadata, policy and execution snapshots, events, acceptance criteria, execution prompts, and the duplicate result child array. Full CLI, HTTP, and TypeScript record surfaces are unchanged. The controller must not infer omitted evidence and separately previews only integrity-valid non-empty patch bytes.

Each package includes the same default `hooks/hooks.json` `UserPromptSubmit` handler and dependency-free Node script. After native trust approval, the hook reads the event's exact prompt and current directory, bypasses explicit Skill invocation, resolves the Git root and configuration, and exits without context outside Git, without configuration, or unless the effective delegation mode is `auto`. It then synchronously calls the separately installed `agentknot` CLI with `orchestrate --source <controller> --workspace <root> --delegation inherit --handoff-json --prompt <exact prompt>` before the first controller-model request. Plugin code does not classify task semantics, select routes, broaden eligibility with `force`, or duplicate planner/product policy.

When the plan remains upstream, the hook supplies only the planner reason and prevents a duplicate orchestration call. When work dispatches, it supplies the compact handoff and reads only integrity-valid non-empty artifacts through `artifact-preview`; it never applies or promotes them. Child outputs share 24,000 characters, patch previews share 32,000 characters, and the complete additional context is capped at 60,000 characters. The host hook timeout is 3,660 seconds so the route's 3,600-second timeout remains responsible for worker cleanup. Codex `agents/openai.yaml` sets `policy.allow_implicit_invocation: false`, preserving explicit `$agentknot-delegate` without a second implicit path. The packages add no bundled CLI, MCP server, daemon, controller branch in `src`, local semantic classifier, or special `/goal` API.

Because `UserPromptSubmit` has no category matcher, every non-explicit prompt in an `auto` repository reaches the configured Luna planner before it may be retained upstream. This is an explicit latency, quota, and prompt-data consequence of `mode: "auto"`; `off` and `suggest` do not pre-dispatch. Hook or CLI failure reports that automatic entry failed to return a usable handoff, without claiming which lifecycle phase failed, and never silently substitutes a worker, provider, or model.

Manifest/Skill validation, deterministic controller parity, a populated delegated handoff fixture, and pre-model hook success/failure fixtures are current evidence. The failure matrix feeds malformed handoff JSON to both controller hooks and proves bounded unavailable context, exact inherited orchestration arguments, no artifact preview, and no route/worker/provider/model fallback argument. Temporary-install tests also remove either controller package and execute the survivor's copied hook and Skill against the same fake CLI contract; this proves package independence without making a real Claude request. Real Codex experiments separately prove a malformed planner with `fallback: "fail"` admits no child and a deterministic 500 ms Pi route timeout settles the failed parent only after SIGTERM/SIGKILL and managed-worktree cleanup. The timeout exposed and corrected an inaccurate pre-dispatch phase claim; the hook now reports only that no usable handoff returned ([incident 0033](../postmortems/0033-controller-timeout-phase-claim.md)). An initial real Codex five-file audit entered orchestration before the first controller-model request, used Luna/max for one medium non-parallel child, and reduced upstream input from 155,851 to 17,951 tokens without controller tool calls. Its smaller output cap was enlarged afterward and covered deterministically but not re-benchmarked. A later non-empty Pi lifecycle fix used the same Codex model and prompt in two clean worktrees: controller-first execution with a manual delegated review reported 2,266,538 input tokens, while pre-model dispatch reported 141,781 and returned an integrity-valid two-file Luna/max artifact before Codex applied and verified it. The 93.7% reduction is not a pure-direct comparison or a universal savings claim. A subsequent Codex pre-model run dispatched two disjoint Luna/max children concurrently and integrated both verified artifacts, proving multi-child mechanics without a new direct baseline or savings claim. Real Claude and broader workload evidence remain open ([incident 0031](../postmortems/0031-bounded-pi-output-drain.md), [experiment 0032](../postmortems/0032-pre-model-multi-child-evidence.md)).

### `OrchestrationRequest`

| Field | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | Non-empty controller goal |
| `workspace` | yes | Existing target repository directory |
| `source` | no | Opaque controller identity; never a policy branch |
| `metadata` | no | Controller-owned metadata copied to planner and child provenance |
| `delegation` | no | `inherit`, `never`, `suggest`, or `force` |

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

`source` must never alter route selection or execution logic.

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

The rules array contains 1–20 ordered rules. Every rule references an existing configured route and is validated at config load. If present, `taskKinds` and `complexities` must each be non-empty and contain unique values; complexities are limited to `low`, `medium`, and `high`. A rule with both predicates matches only when both predicates match the eligible subtask kind and parent assessment complexity, a rule with one predicate matches that predicate, and a rule with neither predicate is an explicit catch-all. The first matching rule wins. Complexity is assessed once for the parent orchestration in this slice; AgentKnot does not ask the planner for a second per-child complexity or route judgment.

For every eligible planned subtask, deterministic policy records `RouteSelectionEvidence` using the subtask's `kind` and parent assessment `complexity`. A rule match records `basis: 'rule'`, the configured route, and a zero-based `ruleIndex`; when no rule matches, evidence records `dispatch.defaultRoute` with `basis: 'default'` and no `ruleIndex`. The evidence is part of the persisted plan and its `planHash`.

In `shadow` mode, `PlannedSubtask.route` remains `dispatch.defaultRoute`; evidence uses `suggestedRoute`. In `active` mode, `PlannedSubtask.route` becomes the matched `selectedRoute`, or the default route when no rule matches. Dispatch passes that exact route to the ordinary child Job API, whose resolved snapshot remains execution authority. Child `agentknotDelegation` metadata carries `taskKind`, `parentComplexity`, and the same evidence. The planner has no route-selection field and cannot name routes. Active selection does not add runtime ranking or fallback: retry remains inside the selected route, and route failure is surfaced without switching model/provider. The repository policy selects DeepSeek Flash/max only for `low`; Luna/max remains planner, default, and the route for `medium`, `high`, and no match. Artifact handoff remains unchanged.

### `JobArtifact`

A `git-patch` artifact is controller-captured Git evidence from one isolated attempt. In addition to its attempt, managed path, size, SHA-256, and recorded base commit, it may expose `changedFiles`, a string array of repository-relative paths derived from Git. Newly captured git-worktree artifacts always include this field, including `[]` when the captured patch is empty. The paths describe repository changes relative to the recorded base; they are not worker claims, semantic verification, or a completion summary, and AgentKnot does not parse worker prose or tool events to populate them. Older persisted artifacts may omit `changedFiles` and remain valid.

Leaf Job and Orchestration admission validate `metadata` recursively as a JSON-compatible object at both TypeScript and HTTP boundaries before persistence. Unsupported values, nesting beyond 20 levels, or compact JSON above 64 KiB fail before a record is admitted. Caller-supplied Job and Orchestration request prompts likewise fail admission above 64 KiB of UTF-8. Derived planner and child prompts pass through ordinary Job admission; the Pi completion-report instruction is appended later at its adapter boundary. File and HTTP transports therefore preserve one metadata and request-prompt contract; the HTTP request-body ceiling remains an independent transport limit.

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

The orchestration service reads each child's terminal `JobCompletionSummary.changedFiles`. It deduplicates paths within that child, groups exact repository-relative paths across distinct children, sorts conflicts by path, and preserves parent child order in `subtaskIds`. Worker reports, prose, planner scopes, events, stderr, and artifacts from earlier retry attempts never participate.

`checked` means usable captured path evidence was available for every child, including a captured empty array. `incomplete` means at least one child lacked usable evidence and cannot be interpreted as a clean handoff; conflicts among the remaining evidence are still reported. A conflict is conservative potential integration-conflict evidence, not proof that same-path changes are incompatible. Conversely, no conflict does not prove semantic independence, patch integrity, current-base applicability, or acceptance. The additive result is persisted before the existing terminal orchestration event and is carried by existing TypeScript, CLI full-record, and HTTP full-record surfaces without a new endpoint or event.

### Optional advisory quality review

`delegation.qualityReview` is optional; omission disables this path. Its exact configuration contains `route` and a non-empty unique `complexities` subset of `low | medium | high`. The route must exist and resolve `maxAttempts: 1`. The route name is role/configuration data: controller, worker adapter, provider, model, and thinking level remain independently replaceable.

After child dispatch settles, review is eligible only when the configured parent complexity matches, the plan and parent contain exactly one subtask/child, that child and its authoritative Job succeeded, and verification finds exactly one integrity/base-valid, non-empty Git patch no larger than 32 KiB whose preview is non-null and non-truncated. Other cases persist `qualityReview.status: "skipped"` with a stable reason. The reviewer prompt is capped by ordinary 64 KiB Job admission and contains the parent goal, subtask prompt and acceptance criteria, verified artifact identity, at most 8 KiB of structured worker completion claims labeled unverified, and the verified patch bytes. It excludes child prose. The current repository's Pi reviewer profile disables tools and context-file discovery; that is configured dogfood containment, not core route coupling or an OS sandbox.

The reviewer is one separately persisted ordinary depth-one Job, not an orchestration child and not a recursive dispatch. It shares the orchestration semaphore and source identity, carries reviewer-role provenance, uses no fallback, and is instructed not to use tools, edit, apply, repair, delegate, converse, commit, push, merge, or promote. Its output must be one JSON object no larger than 8 KiB with exactly schema version 1, verdict `accept | changes-requested | uncertain`, a non-empty summary no larger than 2 KiB, and at most ten `low | medium | high` findings whose non-empty message/evidence fields are each at most 1 KiB. `changes-requested` requires a finding.

Ordinary reviewer start/runtime/protocol failure is advisory `unavailable` evidence and does not rewrite a successful child or parent. Cancellation cancels and awaits a running reviewer before the parent cancels. A pending reviewer found during fail-without-resume reconciliation becomes `unavailable` with `runtime-restart`. Parent/Job persistence failures retain their existing control-plane semantics. A completed verdict is persisted before the orchestration terminal event, appears in the compact handoff, and never applies the patch or changes the parent's delegated success. Final controller acceptance, modification, rejection, tests, commit, and push remain outside this state.

`WorkerCompletionReport` is an optional adapter result, not a Job result field. A strict schemaVersion 1 report contains worker-claimed `changedFiles: string[]`, `checksRun` entries with a non-empty `command`, `outcome` of `passed`, `failed`, or `unknown`, and optional string `notes`, plus `remainingRisks: string[]` and `notes: string[]`. At the adapter boundary, `completionReport: undefined` means no report envelope was detected and `completionReport: null` means an envelope was detected but its JSON was malformed or unsupported; a valid value is copied only after strict validation and a 256 KiB compact-JSON ceiling. The orchestrator maps an absent, malformed, or oversized report to the stable unavailable branch without failing an otherwise successful job. Failed or cancelled Jobs without a retained normal result use `not-retained`. AgentKnot never derives this report from output prose, normalized worker events, stderr, or session statistics. Normal Pi runs can emit the report through the exact marked suffix described below; live probes and doctor do not. Deterministic coverage and a real Pi/OpenCode Go/Luna/max dogfood emission satisfy the Stage 1 evidence gate.

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

The current provider/model fields describe how the selected worker should run. They do not prove that AgentKnot has a provider adapter, validates the provider catalog, or can move a live job between providers. Shadow `suggestedRoute` is evidence rather than a resolved route; active `selectedRoute` is resolved through the ordinary Job route before execution, after which the immutable Job snapshot is authoritative.

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

The adapter does not own job state transitions, retries, attempt numbering, workspace isolation, artifact capture, callback delivery, or persistence. An adapter may return the optional strict `WorkerCompletionReport` as `completionReport`; `undefined` means absent and `null` explicitly means a detected malformed or unsupported envelope. The orchestrator owns runtime validation and terminal-summary placement.

The reusable route-neutral `WorkerAdapter` unit kit runs against Mock and Pi RPC. It requires healthy diagnostic shape, normalized start/text events and output, propagation of event-sink failures, and rejection when `run` receives an already-aborted signal. A mock-only `createRuntime` execution also asserts the resolved terminal route/worker and matching `job.started` evidence without selecting or requiring Pi. Route-resolution, lifecycle, workspace/artifact, and transport-specific evidence remains at its owning core or adapter boundary. Mock is deterministic test evidence, not a second real adapter; the Stage 2 real-worker soak gate remains open.

The JSON configuration boundary exposes the built-in `mock` and `pi-rpc` adapter kinds only; `createRuntime()` loads that configuration and registers those built-ins. A custom `WorkerAdapter` is a TypeScript construction path: callers provide an `AgentKnotConfig`, `JobStore`, and adapter map to `Orchestrator`, and construct `OrchestrationService` separately when they need orchestration. A custom adapter cannot be selected by adding an arbitrary adapter name to JSON, and adapter-specific behavior must remain at the worker boundary.

OpenCode CLI is not a supported adapter. A pinned `v1.18.15` no-inference probe confirmed `run --format json`, explicit `provider/model` plus `--variant max`, `--pure`, working-directory selection, and ACP nd-JSON, but did not prove stronger lifecycle behavior than Pi. OpenCode configuration layers merge, its JSON run stream has no AgentKnot completion-report contract, and a separate OpenCode credential was unavailable; an adapter must not translate Pi auth into another store. Implementation stays deferred until same-route evidence clears [decision 0028](../postmortems/0028-native-opencode-adapter-evidence-gate.md).

### Route diagnostics

Route diagnostics are a controller-neutral runtime operation separate from the Job API. The default CLI `doctor [--route NAME]` resolves a route and performs only the adapter's configuration, credential, and runtime health check. Its result must explicitly state that live inference was not checked; an `ok` result is not evidence that the provider accepted an inference request from the current network path.

The opt-in `doctor --live --route NAME` operation performs exactly one real inference probe through the exact resolved route: worker, provider, model, and optional thinking level are passed unchanged from route resolution. The core contains no route-name, provider, or model branch; current real promotion evidence covers the repository Pi/OpenCode Go/Luna/max route. The diagnostic never falls back or selects another route. A 30-second control-plane timer triggers cooperative abort, and a supported probe adapter must settle after abort and finish resource cleanup before the diagnostic returns.

Live probing is an optional worker-adapter capability with a controller-neutral result, not a provider-specific branch in the orchestrator. An adapter without that capability returns an explicit unsupported result. A probe adapter must honor the supplied `AbortSignal` and settle after abort; as with normal execution, a nonconforming custom adapter can prevent cleanup and completion. The supported Pi adapter supervises and terminates its child process and uses an exact temporary diagnostic workspace that is removed before return. A worker or provider failure is returned as a failed diagnostic with its provider error and a nonzero CLI exit status; unsupported is never treated as success. A successful probe is point-in-time evidence for the exact route and does not guarantee later job success.

A diagnostic probe does not create a `JobRecord`, lifecycle event, or artifact, and does not use the job retry or workspace-isolation lifecycle. Normal `run` and orchestration execution do not perform a diagnostic probe before starting a job.

### Workspace modes

`none` passes the supplied directory directly to the worker. It offers no isolation and currently produces no Git patch artifact.

`git-worktree`:

1. resolves the containing Git repository and requested subdirectory;
2. requires a valid `HEAD` and a clean tracked and non-ignored worktree/index;
3. records the base commit before execution;
4. creates a detached managed worktree for each attempt at that same base;
5. gives the worker the corresponding subdirectory in the managed worktree;
6. stages intent-to-add entries and derives repository-relative changed paths with a NUL-delimited Git diff, then captures tracked, non-ignored untracked, binary, and worker-committed changes as a binary Git patch of at most 16 MiB;
7. rejects a larger patch with non-retryable `ArtifactSizeLimitError` before writing an artifact, otherwise records artifact path, attempt, size, SHA-256, base commit, and the Git-derived `changedFiles` array; an empty patch records `[]`;
8. removes only the exact worktree owned by that attempt.

Ignored dependencies and build output are not present in a detached worktree. The worker must provision any required ignored state. Worktree mode protects Git repository state; it does not isolate host files, processes, credentials, or networks.

### Job store

`MemoryJobStore` provides process-local snapshots.

`FileJobStore` writes a complete JSON snapshot to a unique temporary file with mode `0600` and atomically renames it over the job path. The exact temporary file is removed in `finally` when write or rename fails. The orchestrator serializes append/save mutations per job so concurrent adapter event sources retain gap-free sequence numbers. It provides persistent audit snapshots under one execution owner and a local filesystem with normal rename semantics.

Execution-owning `createRuntime()` uses the host `flock` command to hold non-blocking kernel advisory locks on the real paths of both the Job and Orchestration storage directories. Directories must resolve to distinct locations. Locks are acquired before store construction, reconciliation, or admission; partial acquisition is released if either directory is already owned. Read-only construction takes no lock and disables runtime execution/reconciliation methods. The helper processes hold only these directory locks and settle when the owning process closes their stdin; kernel/process cleanup releases locks after a crash. One-shot CLI execution closes ownership after completion, failed server listen closes it, and TypeScript callers use `AgentKnotRuntime.close()`, which refuses while tracked work is active. `RuntimeOwnershipError` reports conflict, helper startup/loss, invalid shared storage, or premature close.

These locks coordinate conforming file-backed runtimes, including separate PID namespaces sharing the same filesystem. They are advisory rather than a hostile-process security boundary: direct `FileJobStore`/`FileOrchestrationStore` writers and manually constructed runtimes remain responsible for not violating single-writer operation. No lease, heartbeat, journal, database, compare-and-swap, or distributed lock is claimed.

Leaf admission uses one `create` containing status `queued` and sequence-one `job.queued`; a create failure starts no worker. After admission, a failed event save rejects completion with `JobPersistenceError` classified as `event`, `artifact`, or `terminal`. It is a control-plane failure: it is never eligible for worker retry, never creates a substitute terminal event, and prevents callback delivery. The last successful store snapshot is authoritative and remains eligible for ordinary fail-without-resume startup reconciliation. If the failed save was the first record of a newly captured patch, AgentKnot removes that exact unrecorded patch and its managed worktree; an artifact already saved before later observer-evidence failure remains recorded.

Every newly created leaf `JobRecord` has top-level `schemaVersion: 1`. When reading a file, `FileJobStore` treats an absent `schemaVersion` as legacy v1 and materializes `schemaVersion: 1` on the in-memory record returned by `get` or `list`; read-only access does not rewrite the snapshot. An explicit `schemaVersion` other than `1` fails with an unsupported-version error rather than defaulting to v1.

Both Job stores enforce the same 16 MiB ceiling on the exact pretty-printed UTF-8 JSON snapshot they would retain. A rejected create leaves no record; a rejected save leaves the last successful snapshot authoritative. Legacy files remain readable above the current ceiling, but a later mutation must fit. This is a write bound, not compaction or retention.

Local Job and Orchestration snapshots and captured patch artifacts have no automatic expiry. They remain until an operator stops the execution owner, confirms no active work, and deletes only the exact intended record or per-Job artifact directory. AgentKnot supplies no garbage collector, storage-quota eviction, cascade deletion, or purge API in Stage 1; parent, child, and artifact evidence must be resolved explicitly before manual deletion.

AgentKnot does not redact content in prompts, model output, events, result metadata, retained stderr, callback bodies, or patches. Credentials remain external to route records and Pi session statistics are allowlisted, but field minimization, omission, replacement, and byte truncation are not proof of redaction. Snapshot and artifact files use mode `0600`; directory and backup protection remains the local operator's responsibility.

Current persistence does not provide:

- `fsync` durability guarantees;
- a journal or event log independent of snapshots;
- distributed locking, compare-and-swap updates, or protection from writers that ignore the runtime's advisory locks;
- schema migration;
- restartable or resumable execution;
- retention or compaction.

At execution-owning runtime startup, both storage locks are acquired before records are inspected. Therefore every prior `queued` or `running` Job belongs to an execution owner that no longer holds the storage and is marked failed exactly once with `ExecutionInterruptedError` and `reason: runtime_restart`; it is never replayed and observers/callbacks are not invoked. Every prior `queued`, `planning`, or `dispatching` Orchestration is handled the same way without redispatching its persisted plan, after its embedded child outcomes are refreshed from authoritative leaf Job records; a pending advisory review becomes explicitly unavailable with `runtime-restart`. A previously persisted cancellation request remains audit evidence, while restart interruption is the terminal cause. Recorded PID is audit evidence, not startup takeover authority, so PID reuse and namespace visibility do not suppress or authorize mutation in the supported path. Read-only runtimes skip reconciliation and cannot invoke execution/reconciliation methods. A second recovery is byte-stable. This is deterministic fail-without-resume reconciliation, not resumable execution; crash-left worker descendants and managed worktrees remain limitations.

### Orchestration store

`MemoryOrchestrationStore` and `FileOrchestrationStore` are separate from leaf job storage. The file store uses the same mode-`0600` unique-temporary-write-and-rename snapshot model and exact temporary-file cleanup on normal failure. Every parent record captures the normalized request, immutable effective delegation policy, executor identity, strict assessment and plan, plan hash, exact child prompts and routes, route-selection evidence when configured, planner/child job IDs, ordered orchestration events, child outcomes, and terminal result or error. Every child record, child-start event, and child Job provenance carries the admitting plan hash and policy version.

Every newly created parent `OrchestrationRecord` has top-level `schemaVersion: 1`. `FileOrchestrationStore` applies the same legacy-v1 materialization and read-only byte-stability rule, and explicitly unsupported schema versions fail clearly rather than being treated as v1.

Memory and file Orchestration stores enforce the same 16 MiB exact-snapshot ceiling as the Job stores. Child output duplicated into parent provenance is therefore bounded by both the leaf output limit and the final parent snapshot limit.

Parent admission atomically creates status `queued` with sequence-one `orchestration.queued`. Later event persistence appends in memory only for the duration of the save and rolls back the event and timestamp if the save fails, leaving the last successful store snapshot authoritative. A child `JobPersistenceError` remains a control-plane failure: the parent cancels other active children and propagates the rejection without fabricating a worker-style child outcome. A cancellation-evidence save failure is reported but cannot prevent abort propagation to the planner or active children. Parent and child files are not transactionally rolled back; restart reconciliation remains responsible for authoritative nonterminal snapshots after the owner exits.

The stores assume one execution owner, enforced for conforming file runtimes at `createRuntime()` rather than inside each store call. They provide no compare-and-swap, journal, schema migration, resume, distributed concurrency, or parent/child transaction spanning multiple snapshot files.

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

Artifact inspection is a read-only orchestrator/workspace operation. The TypeScript API exposes `listArtifacts(jobId)`, `verifyArtifacts(jobId)`, and `previewArtifact(jobId, attempt)` with the language-neutral `JobArtifactList`, `JobArtifactVerificationReport`, and `JobArtifactPreview` payloads. Verification resolves only artifacts recorded on the selected job, validates their managed storage paths, checks file metadata before reading, recomputes size and SHA-256 for files no larger than 16 MiB, and compares each recorded base commit with the current source repository `HEAD`. Missing, unreadable, path-mismatched, tampered, unsupported, oversized, or base-mismatched evidence returns stable issue codes and `valid: false`; an oversized managed file reports `artifact-size-limit-exceeded` without a computed checksum. Preview returns at most 1 MiB of UTF-8 Git patch text; content is `null` when file size or SHA-256 does not match or the file exceeds the artifact ceiling, while a base mismatch is reported without hiding otherwise intact diagnostic content. Inspection never applies patches or mutates, commits, merges, or pushes the source repository.

Usage inspection is a separate read-only projection exposed by `AgentKnotRuntime.usage()` and CLI `agentknot usage [--json]`. It reads Job and Orchestration stores once and never invokes an adapter, requests fresh statistics, probes a route, acquires execution ownership, reconciles snapshots, or writes records. The schemaVersion 1 report scopes total/successful Jobs, valid/unavailable session-stat records, terminal orchestrations, and planned subtasks; it returns downstream usage, route-selection evidence, advisory quality-review evidence, upstream usage availability, and upstream/downstream proportion availability.

Downstream aggregation accepts only successful terminal Jobs whose retained `result.metadata.sessionStats` contains non-negative safe-integer `input`, `output`, `cacheRead`, `cacheWrite`, and provider-reported `total` token fields plus a non-negative finite provider-reported cost. Each Job contributes at most once regardless of retry count. Missing statistics and the adapter's `timeout`, `unsupported`, or `invalid` states are unavailable rather than zero; malformed or unsafe persisted values are also invalid. Exact available records may still be summed under partial coverage. A valid all-zero record remains available, while an unsafe aggregate is unavailable rather than rounded. Provider totals are preserved instead of repaired from components, and provider cost has no implied currency, price conversion, billing equivalence, or cross-provider comparability.

The downstream cache-read hit rate is `sum(cacheRead) / (sum(input) + sum(cacheRead))`; sums are taken before division, and output plus cache-write tokens are excluded. A zero input-side denominator or unsafe aggregate makes the rate unavailable. Route-rule hit rate is `rule / (rule + default)` and is reported separately for active and shadow evidence. Only `plan.subtasks[].routeSelection` from terminal Orchestration records is counted, checked against that record's immutable policy snapshot and persisted subtask route. Rule basis is authoritative even if the rule names the default route; a catch-all is still a rule hit. Omitted, malformed, or policy-inconsistent evidence is unclassified, never recomputed from the current configuration, child route, task prompt, or model output.

No current persisted contract carries exact controller token usage comparable to downstream Pi totals. `upstream` and `proportions` therefore return `status: "unavailable"` with reason `controller-usage-not-persisted`; downstream must not be displayed as 100%. The runtime does not parse Codex/Claude transcripts or arbitrary request metadata, read account quota summaries, accept inferred values, or normalize differing token units. A future exact controller-usage boundary requires its own versioned contract before proportions can become available ([decision 0034](../postmortems/0034-persisted-usage-observability-boundary.md)).

Quality-review aggregation considers only terminal Orchestrations whose immutable policy configured `qualityReview`. Structurally valid persisted evidence is grouped into completed/skipped/unavailable outcomes, completed verdicts, finding severities, reviewer route names, and skipped/unavailable reasons; absent, pending, malformed, or policy-route-inconsistent evidence is unclassified. No current record states whether the controller later accepted, modified, or rejected the patch, so `controllerDisposition` remains unavailable with `controller-review-disposition-not-persisted`. A direct reviewer Job outside orchestration contributes ordinary downstream token statistics but not orchestration quality-review outcomes.

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

### Admission and planning

```text
queued -> planning -> upstream/suggested -> succeeded
                   -> dispatching -> succeeded | failed | cancelled
                   -> failed | cancelled
```

Global modes are `off`, `suggest`, and `auto`. Omitted delegation configuration resolves to `off`. Configured `suggest` or `auto` requires `workspaceIsolation.mode: "git-worktree"`. The planner and every child are ordinary leaf jobs, so route snapshots, isolation, retries, events, artifacts, and cleanup use the existing job contract.

The planner is a read-only model route and returns JSON only. AgentKnot rejects markdown fences, commentary, missing or unknown fields, invalid enums, oversize content, inconsistent recommendations, and plans above the configured child cap. Every delegated subtask must provide separate `title`, `kind`, `prompt`, and non-empty string-array `acceptanceCriteria` fields; criteria embedded only in prompt text do not satisfy the strict schema. Delegation and parallelism are distinct: one bounded substantive task may be returned as exactly one subtask with `parallelizable: false`, and the lack of a useful split alone must not cause `do-not-delegate`. A bounded task in a preferred delegatable kind that is expected to create or modify a repository file must receive a `delegate` recommendation even when small, low-complexity, or non-parallel; task size and generic handoff/review overhead alone are not retention reasons. Genuinely trivial read-only inspection or direct-answer work with no repository-file deliverable may remain upstream when direct execution and review are cheaper. This planner rule does not override configured `keepUpstream` kinds, limits, or explicit artifact/integration policy ([decision 0035](../postmortems/0035-delegation-first-small-repository-deliverables.md)). Planner instructions define `parallelizable: true` to require independently verifiable subtasks with no execution-order dependency and non-overlapping expected write scopes; each parallel subtask must state a bounded file/component scope and non-goals. This is a planning contract, not proof of actual patch disjointness. The deterministic composer applies `delegate` and `keepUpstream` task-kind sets, assigns stable depth-one subtask IDs, captures exact execution prompts and routes, and hashes the plan. An over-cap plan is rejected rather than silently truncated.

When delegation dispatch limits are omitted, the product defaults to `maxChildren: 2` and `maxConcurrency: 2`; the configuration parser permits values from one through six, and `maxConcurrency` cannot exceed `maxChildren`. This repository's dogfood configuration uses `maxChildren: 6` and `maxConcurrency: 6`, so those settings are not product defaults. Formal six-child orchestrations at configured concurrency four, five, and six all succeeded through Pi/OpenCode Go/Luna/max; the six-slot run started all children within 44 ms and every child completed on its first attempt. This remains point-in-time repository evidence rather than a general worker/provider capacity claim. Capacity never requires the planner to manufacture tasks, and fewer eligible independent subtasks use fewer workers.

When route selection is configured, the deterministic composer evaluates ordered rules only after a subtask passes the ordinary delegation policy and records first-match/default evidence. Shadow mode keeps the planned execution route at `dispatch.defaultRoute`; active mode writes the configured selection into the planned route. Both add task kind, parent assessment complexity, and evidence to child metadata. This is human-authored policy, not planner-controlled routing or automatic model/provider ranking.

Optional quality review is evaluated after child dispatch and artifact-path review; it does not participate in planning or child route selection. It starts only the configured review route and never infers a reviewer model from the worker route, controller source, model name, or a claimed intelligence ordering.

The parent plan and `orchestration.planned` event are persisted before the first child starts. `suggest` persists the same evidence without dispatch. With fallback `upstream`, planner failure returns a persisted upstream decision and error evidence; with fallback `fail`, planner failure makes the parent terminally failed before a dispatchable plan is persisted. A successful self-orchestration demonstrates only that run's normal planner-to-plan-to-child path; it is not, by itself, evidence for planner fail-fast behavior under failure, timeout, cancellation, or semaphore wait.

### Dispatch and cancellation

Planner, child, and configured reviewer jobs are launched through `Orchestrator.start()`. One shared semaphore caps all active planner, child worker, and reviewer executions across all parent orchestrations in one `OrchestrationService`; this is process-local and not a restartable or multi-process queue. `Orchestrator.start()` itself has no capacity semaphore, so independent callers that issue concurrent direct leaf Jobs bypass `delegation.dispatch.maxConcurrency` and own admission control. For a parallel parent, the dispatcher fills at most `maxConcurrency` slots from the persisted subtask pool, starts fewer workers when fewer tasks exist, and immediately admits the next pending subtask when a child settles. A parent whose validated assessment has `parallelizable: false` receives an effective child concurrency of one even when the configured global cap is higher. If persistence of parent evidence fails after a leaf admission, AgentKnot cancels and awaits that admitted job before failing the parent. `maxDepth` is exactly one in v1, and the orchestration engine does not recursively submit its own children. Worker/reviewer prompts prohibit recursive delegation, commit, push, merge, or artifact application. Because the local HTTP API is unauthenticated, v1 cannot prevent a worker with host access from independently invoking a new orchestration; depth one is an engine invariant, not a hostile-worker security boundary.

Cancellation first persists `cancelRequestedAt` and `orchestration.cancel.requested`, then aborts the planner, active children, or active reviewer and prevents later work from launching. Cancellation is process-local and cooperative through the underlying adapter. The parent completes only after launched jobs settle. The service computes additive artifact-path and optional quality-review evidence before persisting the existing terminal event. One or more non-succeeded children make a delegated parent failed; an unavailable or changes-requested advisory review does not. AgentKnot does not integrate their patch artifacts.

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

Core consumers may depend on the normalized event name, job ID, sequence, timestamp, and JSON-compatible data. They must not depend on an undocumented Pi RPC payload hidden inside `worker.raw`. Event `data` is normalized through JSON and limited to 16 KiB as a standalone pretty-printed value; an oversized, non-object, or non-serializable value is replaced by `agentknotRecordLimit` evidence. Each Job retains at most 512 `worker.*` events. The first excess event is represented by one persisted `job.worker.events.truncated` carrying the cap and first dropped type; later worker events are neither persisted nor sent to the live observer. Lifecycle events are not counted, so terminal state can still be recorded after a worker-event flood.

### Pi normal-run record-volume boundary

For normal `PiRpcWorkerAdapter.run` executions only, exactly four Pi lifecycle envelope types are recognized as known bookkeeping frames: `turn_start`, `turn_end`, `message_start`, and `message_end`. The adapter does not emit `worker.raw` for those frames, but every received Pi frame still increments `metadata.rawEventCount`, including the four known envelopes; unknown event types continue to emit `worker.raw`. Normalized text, tool, and retry events, final output, completion-report behavior, live-probe behavior, route/provider/model/thinking configuration, and the global event-type list are unchanged. This is a bounded record-volume filter, not a Pi-token-saving claim or general truncation; it adds no schema migration or plugin installation and does not change configuration or probes.

Terminal `result.output` retains at most a 1 MiB valid UTF-8 prefix. If shortened, `result.outputTruncation` records the original and maximum byte counts. Result metadata is JSON-normalized, limited to 64 KiB as a standalone pretty-printed object, and replaced with structured evidence if oversized or non-serializable. Error names are limited to 256 bytes and messages to 16 KiB, with an inline original-byte notice when truncated. The supported Pi adapter stream-decodes stderr and retains a valid UTF-8 suffix of at most 4 KiB before the global event-data and event-count limits apply.

These record budgets do not limit worker compute, upstream provider token use, patch artifact bytes, or retention duration. Prompts, retained model output, stderr, tool data, metadata, and patches may contain sensitive user or repository content. No document may imply automatic redaction until that separate feature exists and is verified ([decision 0023](../postmortems/0023-fixed-durable-record-budgets.md)).

Pi RPC is strict LF-delimited JSONL. Its adapter decodes streaming UTF-8 explicitly and does not assume that process chunks align with JSON messages or use Node `readline` behavior as its protocol definition. Each non-empty line must parse as a JSON object; malformed input reports line context. Process exit before `agent_settled` is an error, with `agent_end`-without-settlement distinguished from exit before `agent_end`.

Normal-run cleanup waits a fixed grace window for the owned stdout/stderr tasks. If they remain pending because an external `WorkerEventSink` Promise never settles, the adapter destroys only those owned streams and returns from output draining while retaining `Promise.allSettled` observation of the detached tasks. Abort or timeout can therefore settle after exact-child termination instead of waiting forever. This does not cancel the external promise, hide an ordinary sink rejection that reaches settlement before the grace deadline, or authorize process-wide cleanup.

Every Pi normal run and live probe appends each of `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-themes` exactly once after deduplicating those flags from configured command arguments. Explicit resource arguments remain unchanged, so a reviewed profile can name an exact extension, skill, prompt template, or theme without re-enabling ambient discovery. The adapter does not add `--no-context-files` or `--no-tools` by default, so ordinary repository workers retain instructions and built-in tools; an explicit worker profile such as the repository's bounded reviewer may configure those flags. These controls reduce ambient variability and capability but do not form a security sandbox.

For normal `run` jobs only, the Pi adapter appends a concise provider/model-neutral instruction after the supplied prompt. It asks the final assistant message to end with exactly one single-line suffix beginning `AGENTKNOT_WORKER_COMPLETION_REPORT_V1: ` and followed by schemaVersion 1 `WorkerCompletionReport` JSON containing `changedFiles`, `checksRun` entries with `command`, `outcome` (`passed`, `failed`, or `unknown`), and optional `notes`, `remainingRisks`, and `notes`; it states that every value is a worker-reported claim. The adapter parses only that exact marked line at the end of accumulated assistant text. A missing line leaves `completionReport` absent, while a detected malformed or unsupported line returns `completionReport: null`; neither case fails an otherwise successful run. A valid line is strictly validated with the existing report validator, copied into `completionReport`, and removed from `result.output` while the preceding output remains unchanged. Ordinary prose, tool events, stderr, raw events, and session statistics are never used for inference, and text after the marked line prevents detection. Configuration-only doctor and live probe do not append or parse this protocol. After a successful normal run reaches `agent_settled`, the Pi adapter sends one correlated `get_session_stats` RPC request before terminating its owned child. It allowlists non-negative message/tool counts, input/output/cache/total token counts, cost, and optional context usage into `result.metadata.sessionStats`; it does not retain session paths, session identifiers, or raw statistics. Timeout, unsupported responses, and invalid shapes are recorded only as `unavailableReason` and cannot change an otherwise successful result. Live probes do not request session statistics.

The Pi adapter derives one effective environment by overlaying configured worker environment values on `process.env`. Configuration-only doctor, live probe, and normal run use that snapshot consistently for bare-command `PATH` lookup, required environment presence, Pi's explicit agent directory, worker-home default auth directory, and spawned child environment. Empty or whitespace credential values are absent. A relative command containing a path separator, a relative `PATH` entry, or a relative `PI_CODING_AGENT_DIR` remains relative to AgentKnot's own process directory during doctor because that boundary has no worker workspace.

Orchestration events cover queued, planning, planner start/completion, planned, dispatching, child start/completion, advisory review skipped/started/completed/unavailable, cancellation requested, and terminal succeeded/failed/cancelled transitions. Their sequence is gap-free within one parent snapshot. Leaf job events remain authoritative for worker-level activity.

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

Cancellation uses process-local active-job and active-orchestration maps. After a server restart, a persisted nonterminal record is reconciled as failed and is not an active cancellable execution.

After `run` or `orchestrate` admission, the CLI installs catchable `SIGINT` and `SIGTERM` handlers that request cancellation of that exact active execution, await its completion and owned-resource cleanup, then close runtime ownership and exit unsuccessfully. The HTTP server's asynchronous `close()` first stops new connections, cancels every active Job and Orchestration tracked by that server, awaits their completion, and then closes runtime ownership. A hard kill cannot execute either cleanup path and receives only the fail-without-resume guarantees available to the next owner.

`createRuntime()` accepts `reconcileOnStartup`, which defaults to `true`. The default constructs an execution owner, acquires both storage locks, and performs fail-without-resume recovery. Passing `false` constructs an enforced read-only runtime: it opens configured stores without ownership or recovery and refuses execution/reconciliation calls. CLI `run`, `orchestrate`, and a parameter-valid `serve` use the owning path; read-oriented and invalid CLI commands use the read-only path, and invalid `serve` arguments are rejected before runtime construction. Therefore `show`, lists, usage reporting, artifact inspection, routes, delegation inspection, and both doctor modes cannot mutate Job or Orchestration records. See resolved [incident 0010](../postmortems/0010-read-only-cli-runtime-reconciliation.md) and [decision 0022](../postmortems/0022-file-runtime-single-writer-ownership.md).

The repository's POSIX `npm run test:stage1-soak` starts the public CLI/Pi/restart/worktree matrix in one unique detached process group, imposes a 60-second bound, forwards catchable termination to that exact group, escalates it after a two-second grace, and fails after cleaning the exact group if any attributed descendant remains after the test runner exits. This development runner does not strengthen runtime behavior under hard `SIGKILL` or host loss ([incident 0024](../postmortems/0024-stale-dogfood-test-processes.md)).

`GET /health/live` is the canonical liveness response for the HTTP process; `GET /health` is an identical compatibility alias. Both return `{"ok":true,"service":"agentknot","status":"live","checks":{"storage":"not-checked","routes":"not-checked","inference":"not-checked"}}` and do not access runtime methods, storage, credentials, workers, or providers. `GET /health/ready` is intentionally absent. Route diagnostics, including the opt-in live probe, are exposed by the CLI `doctor` command; they are not currently an HTTP endpoint. See [decision 0011](../postmortems/0011-explicit-http-liveness-contract.md).

There is no authentication, authorization, TLS termination, CORS policy, rate limiting, admission limit, or untrusted-network security contract. The server should remain bound to trusted local interfaces unless an external trusted proxy supplies those controls.

## Safety and secrets

### Enforced intent

- Credentials stay in environment variables or Pi's external credential store.
- Configuration declares required environment-variable names, not their values.
- AgentKnot does not intentionally copy API keys or auth-file contents into job records.
- Pi session-stat metadata is allowlisted and excludes session paths, session identifiers, raw responses, and provider error text.
- Managed worktree cleanup targets an exact path created and owned by AgentKnot.
- Git patch artifacts are never applied automatically.
- Automatic delegation cannot be configured without Git worktree isolation, is depth-one, and never promotes child artifacts.
- Shadow route-selection evidence never overrides `dispatch.defaultRoute`. Active route selection can override it only through a validated configured rule; the resulting ordinary child `Job.route` remains authoritative, its configured thinking level is preserved, and no fallback or mid-attempt switch is added.
- Advisory review never promotes or repairs an artifact in the orchestration engine. Its prompt-level prohibitions and the current no-tool Pi profile reduce capability, but an arbitrary host-capable adapter is not a security sandbox and remains subject to the worker threat boundary.

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
- Existing job snapshots must retain their resolved route and event meaning.
- New optional fields may be added compatibly; changing state or event semantics requires a versioned contract and migration decision. `JobArtifact.changedFiles` is optional when reading persisted records, while newly captured git-worktree artifacts always emit an array.
- `delegation.dispatch.routeSelection` is optional configuration, and its shadow/active evidence is additive plan/metadata evidence; omission remains disabled and does not change persisted Job or Orchestration `schemaVersion: 1`.
- `JobRecord.completionSummary` is optional for legacy v1 reads; existing records without it are not rewritten, while newly terminal records produced by this runtime include the additive summary.
- `OrchestrationResult.artifactReview` is optional for legacy/upstream/suggested results; newly terminal delegated results include the additive review without changing record schemaVersion 1.
- `delegation.qualityReview` and `OrchestrationRecord.qualityReview` are optional; omission preserves the prior lifecycle, while newly configured records carry additive reviewer policy/evidence without changing schemaVersion 1. Reviewer route/provider/model changes affect resolved reviewer Jobs, not the core record shape.
- `WorkerRunResult.completionReport` is optional at the adapter boundary: `undefined` is absent, `null` is a detected malformed or unsupported envelope, and a non-null value is strictly validated before it enters a summary; custom adapters that return only `output` remain valid.
- One wire payload should have one canonical type/schema. HTTP, CLI, callbacks, and TypeScript APIs must not describe the same payload independently without a mechanical compatibility check.
- Worker-specific transport fields belong in adapter-owned metadata or raw evidence, not in the controller-neutral top-level contract; the explicitly versioned `WorkerCompletionReport` is the narrow route-neutral exception for worker claims under `JobCompletionSummary.workerReported`.
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
- patches and Git-derived repository-relative `changedFiles` for tracked, non-ignored untracked, binary, worker-committed, empty, retry, and unusual-filename changes;
- terminal completion summaries for success, direct mode, captured empty/nonempty paths, absent/malformed worker reports, failure, cancellation, retry terminal-attempt scoping, persist-before-observer ordering, callback/HTTP/CLI JSON surfaces, and legacy record byte stability;
- artifact checksum and base-application validity;
- exact cleanup on success, failure, retry, timeout, and cancellation;
- documented crash/restart behavior;
- configuration-only doctor wording, successful and failed/unsupported live-probe outcomes, timeout/abort cleanup, CLI exit behavior, exact Pi propagation of route thinking level, and normal-run completion-report prompt injection, valid/missing/malformed/unsupported parsing, output preservation, strict end anchoring, summary propagation, and live-probe exclusion;
- strict planner validation, deterministic policy filtering, persisted-before-dispatch plan evidence, parent/child provenance, global process-local concurrency, and orchestration cancellation;
- delegated parent artifact review for captured empty/disjoint paths, exact grouped multi-child overlaps, incomplete evidence, deterministic ordering, persistence before terminal observation, and source nonmutation;
- strict route-selection configuration rejection, candidate-route validation at config load, first-match/default behavior, zero-based match indexing, plan-hash coverage, shadow default-route authority, exact active-route dispatch, and public child metadata carrying task kind, parent complexity, and evidence;
- strict optional quality-review configuration, omission behavior, eligibility skips, separate reviewer admission, valid/invalid/truncated verdict output, advisory changes-requested/failure behavior, cancellation and restart reconciliation, semaphore participation, compact handoff, persisted usage aggregation, source neutrality, and source-workspace nonmutation;
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

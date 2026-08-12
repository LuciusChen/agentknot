# AgentKnot product requirements

- Status: Living product contract
- Version: 0.1
- Last updated: 2026-08-12

## Product thesis

AgentKnot is a small, local-first, vendor-neutral execution control plane for validating and executing a controller-authored delegation handoff from interchangeable controllers through interchangeable agent workers and model routes.

Its job is to admit work, apply a bounded delegation policy, persist the plan and lifecycle evidence, invoke workers, and hand back results and artifacts. It does not own the worker's intelligence, the provider's model runtime, or a collaboration network.

```text
controller -> plan/assessment -> Orchestration API -> deterministic policy
                         |                         |
                         +-> upstream/suggestion  +-> bounded child Job APIs
controller ---------------------------> Job API -> worker -> provider/model
                                                    |
                                                    +-> evidence/artifacts
```

## Problem

Coding-agent workflows are often coupled at several layers at once: the controller, coding harness, model provider, model, workspace mutation policy, and result transport. Replacing Codex with Claude, Pi with another worker, or one provider with another can then require redesigning the entire workflow.

Directly invoking a worker also leaves recurring control-plane concerns to every caller: route configuration, job state, cancellation, retries, event normalization, workspace protection, artifact capture, and audit history.

Controllers already own conversation context, intent, planning, and product decisions. AgentKnot therefore needs one shared, strict orchestration handoff: controllers author the semantic assessment, while middleware validates it and applies common limits, routing, isolation, lifecycle, and evidence rules. Requiring middleware to plan from a raw prompt would duplicate controller reasoning, hide context, add latency, and couple the control plane to another model call.

That handoff may carry one small controller-authored context manifest shared by all children. It must reuse facts already in the controller conversation, not copy the transcript or make the controller scan the repository. Besides the existing summary, paths, and constraints, optional references may identify controller-known material through bounded provenance-bearing metadata. References remain unverified navigation hints; the experimental `workspace-file` kind may point to a portable repository-relative candidate that the worker is asked to read selectively with existing workspace tools, while every other kind remains unresolved. Ordinary tools can still list or search, so this guidance is neither enforced retrieval nor a sandbox boundary. The bounded common prefix narrows the worker's initial working set without making a worker session, memory service, external context provider, provider cache, or controller identity part of correctness. Explicit constraints override generic check guidance, explicit task output formats override generic completion prose, and insufficient context is reported with available evidence instead of permitting silent scope expansion. Task scope is never represented by a fixed tool-execution count: semantic context and acceptance criteria bound the work, while timeout, cancellation, bounded retained evidence, isolation, and completion envelopes remain operational safeguards ([decision 0083](../postmortems/0083-remove-tool-count-task-boundaries.md)). A real-repository regression keeps automatic candidate-reference generation out of the handoff ([experiment/decision 0082](../postmortems/0082-real-repository-selective-context-gate.md)).

AgentKnot provides one narrow contract for those concerns while keeping every execution choice explicit and replaceable.

## Primary users

The initial user is a developer or small engineering team that:

- discusses or approves work in one controller, such as Codex or Claude;
- wants a different coding worker or model to execute some bounded tasks;
- needs to change controllers, workers, providers, or models without rewriting the workflow;
- wants durable evidence of what ran and a reviewable patch instead of an implicit source-tree mutation;
- prefers a local service and local credentials over a mandatory hosted control plane.

Multi-tenant platform operators and large remote agent fleets are not initial users.

## Jobs to be done

1. Submit the same coding task from a CLI, HTTP client, TypeScript program, CI job, Codex, or Claude.
2. Choose the worker, provider, and model through a route rather than controller-specific code.
3. Observe a normalized job lifecycle without understanding the worker's private protocol.
4. Cancel or retry a bounded attempt according to an explicit policy.
5. Keep the supplied Git workspace unchanged while receiving a verifiable patch artifact.
6. Inspect enough evidence to decide whether a result should be accepted, revised, or discarded.
7. Diagnose why a job failed without exposing provider credentials.
8. Submit one controller-authored assessment and have the same policy decide whether to keep it upstream, suggest the validated split, or dispatch bounded child jobs regardless of controller vendor.
9. Optionally ask a separately configured route to review one bounded patch before the controller makes the final acceptance decision.
10. Optionally obtain controller-owned test evidence for one bounded patch without first applying it to the supplied source workspace.
11. Use durable AgentKnot identities concurrently from multiple upstream controller sessions without depending on the admitting process's Promise or transport connection.
12. Run the same middleware kernel in a foreground process, explicit application-managed process, container, or external supervisor without shell-profile edits or making systemd, launchd, Unix sockets, or one controller lifecycle a correctness prerequisite. A common client may explicitly activate a stopped or crash-stale broker from one product-owned launch profile; controller packages use one stateless `SessionStart` obligation for `startup`, `resume`, `clear`, and `compact`, and install no `UserPromptSubmit` hook.
13. Wait for delegated work with visible compact phase/activity evidence, distinguish an active worker from a lost middleware connection, and never resubmit the task merely because a client reconnects.

## Product principles

### Controller neutrality

`source` records who submitted a job. It must not select a code path. Codex, Claude, CI, and custom callers use the same Job API.

### Explicit routing

A route resolves worker, provider, model, thinking level, timeout, and retry settings before execution. Existing jobs retain that resolved snapshot even if configuration changes later. The optional human-authored `delegation.dispatch.routeSelection` policy supports `shadow` evidence and `active` execution. Shadow keeps `dispatch.defaultRoute`; active writes the first matching configured route into the planned child and ordinary Job request. The controller assesses complexity, but its strict assessment cannot name a route.

### Records first, live signals second

The durable job record and its ordered events are the authority. Streaming, callbacks, dashboards, or notifications are delivery conveniences and must not become the only copy of state.

Stage 3 makes that principle literal across controller sessions and process lifetimes: the target is one transactional local middleware kernel with compare-and-swap state, append-only sequenced events, idempotent admission, renewable fenced execution leases, restart recovery, and resumable event cursors. A transport disconnect is not an execution failure, and an in-memory Promise or operating-system service definition is never durable state authority. This target is accepted but remains partially implemented until the gates in [decision 0055](../postmortems/0055-durable-middleware-kernel.md) and the SPEC pass.

Each orchestration has one authoritative primary target workspace and workers may modify only its isolated copy; every other repository is a read-only reference. A requested edit target that conflicts with the admitted workspace must remain upstream as a visible mismatch. Repository analysis must also remain bounded at admission: unless exhaustive coverage is explicitly requested, the controller-authored subtask and worker contract name the primary target, references, exact scope, and non-goals, then return only a small decision-relevant evidence set rather than an inventory or source restatement.

### Honest capabilities

AgentKnot only advertises behavior that is implemented and verified. Proposed adapters, recovery, streaming, security, or sandbox features remain marked as proposed until their acceptance gates pass.

### Evidence-bearing completion

A terminal job must carry a result or an explicit error, its resolved route and attempts, and any produced artifacts. "The agent said it finished" is not sufficient evidence for artifact promotion. A new terminal Job also carries an additive schemaVersion 1 completion summary: controller-captured changed paths are tied to the terminal artifact when available, while worker claims, checks, risks, and notes remain explicitly reported evidence rather than semantic verification.

### Safe handoff by default

In Git worktree mode, attempts run away from the caller's working tree and return patch artifacts. Relative managed-root configuration is materialized outside the runtime/config project ancestry so a different target repository cannot inherit that host project's instructions, package manifest, or tool configuration. Supported dirty source state within the fixed 16 MiB patch-representation budget is captured at admission without mutating the real worktree, index bytes, or object database. A parent that will dispatch captures one immutable input with its deterministic plan; every worker/reviewer child derives from it, every leaf retry sees its derived snapshot, and artifacts contain only worker deltas. Sparse-checkout paths that Git intentionally leaves unmaterialized remain omissions rather than worker deletions. Artifact and terminal-summary identity includes the exact admitted tree when available. Integrity verification proves retained artifact identity, not semantic task completion or compliance. AgentKnot never applies, commits, merges, or pushes those patches automatically.

An optional advisory reviewer may inspect bounded verified patch evidence in a separate depth-one Job. The Job receives an exact single-use artifact grant rather than raw patch bytes in its initial prompt; core revalidates and audits the read while each worker adapter owns only its protocol mapping. Its strict verdict is evidence, not acceptance authority: it cannot mutate the artifact, start a repair loop, promote the patch, or replace controller validation. A completed review may request changes because completion describes the assigned review task, not acceptance of its subject. Repeated real A/B evidence supports the grant's narrower authority and audit trail but not a token- or latency-efficiency claim.

An optional trusted local validation policy may apply exactly one bounded verified patch to a second disposable worktree and execute one explicit shell-free command there. The resulting command and cleanup record is controller-owned evidence, not a worker claim or promotion decision; failure remains advisory and the source workspace stays unchanged.

### Minimal core, replaceable edges

Worker-specific process and protocol behavior belongs in worker adapters. Orchestration policy belongs in the core. Features that do not strengthen the execution handoff should remain outside the core.

Controller integrations and transports are replaceable edges over the same kernel. The controller owns semantic planning and the versioned handoff; AgentKnot owns reliable execution after admission. Controller-native Skills describe the handoff, and an identical stateless `SessionStart` hook for `startup`, `resume`, `clear`, and `compact` injects one concise controller obligation without injecting context on every prompt. The hook reads only bounded event JSON, performs no filesystem, Git, network, broker, policy, runtime, prompt, transcript, or session-state work, and no `UserPromptSubmit` hook exists. This deterministic session context does not guarantee semantic Skill selection or delegation; the controller still decides eligibility and authors the assessment. Common MCP/CLI/HTTP clients submit the controller-authored handoff to the independent broker; planning must not move into middleware. Foreground, container, external-supervisor, and explicit application-managed hosting all run the same kernel; AgentKnot does not install shell profiles or operating-system service definitions.

### Bounded automation

Automatic delegation must be explicit at the API boundary, carry a strict controller-authored assessment, remain depth-limited, concurrency-limited and isolated, and be recorded before execution. All direct, child, and reviewer Jobs share the durable FIFO capacity boundary configured by `delegation.dispatch.maxConcurrency`; a parent still starts no more than its own effective concurrency. Automatic delegation must never imply automatic artifact integration, product decisions, commits, or pushes.

## Current product scope

Version 0.0.1 currently implements:

- controller-neutral CLI, HTTP, and TypeScript entry points;
- a compact CLI orchestration handoff projection for controller consumption that omits duplicated prompts, policy snapshots, and event history without changing the persisted full record or artifact-review authority;
- experimental thin Codex and Claude client packages with controller-native handoff Skills, one identical stateless `SessionStart` hook for `startup`, `resume`, `clear`, and `compact`, no `UserPromptSubmit` hook, and the same `agentknot mcp` stdio broker client. The hook reads only bounded event JSON and injects one concise controller obligation; it performs no filesystem, Git, network, broker, policy, runtime, prompt, transcript, or session-state work. The upstream controller owns semantic classification, planning, decomposition, workspace selection, and acceptance criteria, then submits the parent task plus strict assessment through common MCP tools or the transport-equivalent CLI. Codex implicit-invocation metadata is only a selection hint, not proof of automatic Skill invocation; a fresh-session miss is recorded in [decision 0074](../postmortems/0074-session-start-controller-entry.md). MCP never creates a runtime in its own process; its explicit lifecycle tool may spawn the independent broker from a previously validated product-owned launch profile. The Skill neither infers target-repository configuration nor chooses routes/models ([decisions 0053](../postmortems/0053-controller-owned-planning-handoff.md), [0057](../postmortems/0057-independent-broker-and-thin-controller-clients.md), [0058](../postmortems/0058-controller-neutral-broker-activation.md), [0063](../postmortems/0063-remove-per-prompt-controller-obligations.md), and [0074](../postmortems/0074-session-start-controller-entry.md));
- immutable resolved route snapshots with worker, provider, and model dimensions;
- optional least-active pools over complete exact routes for leaf, child, and advisory-review targets, with immutable per-Job selection evidence, explicit member traffic included in load, rotating equal-load ties, and no retry-time route switching or fallback; the production SQLite path derives activity from unexpired Job leases and commits selection, Job admission, the first lease, and cursor atomically;
- deterministic Mock and Pi RPC worker adapters;
- the built-in structured advisory-review prompt reserves the transport-owned completion suffix as the only permitted content outside its role JSON, avoiding contradictory output requirements without weakening the parser;
- a reusable route-neutral adapter unit contract for healthy diagnostics, normalized start/text events and output, event-sink failure propagation, and already-aborted runs; Pi is the built-in real protocol implementation while Mock remains deterministic-only evidence;
- OpenCode Go/Luna and OpenCode Go/DeepSeek V4 Flash routes through Pi configuration;
- transactional SQLite-backed production Job/Orchestration projections with append-only ordered event cursors, CAS revisions, scoped idempotent admission, monotonically fenced execution leases, durable cancellation intent, and byte-stable identity-validated legacy JSON import; in-memory and explicit legacy file stores remain test/migration adapters;
- one generic durable event-subscription kernel for Job and Orchestration cursor replay, commit-before-notify ordering, missed-wakeup-safe same-process acceleration, cross-process durable refresh, and transport-neutral cancellation; TypeScript, HTTP/CLI, and MCP adapters consume the same state without making connections authoritative. The MCP adapter keeps one bounded call across multiple event batches and returns terminal evidence or an active same-ID cursor, avoiding a controller model turn per five-second heartbeat without claiming detached controller notification ([decisions 0062](../postmortems/0062-durable-event-subscription.md) and [0075](../postmortems/0075-bounded-mcp-wait-and-resume-gate.md));
- a compact route-neutral activity projection on cursor waits, derived from existing durable Job events with explicit evidence coverage, last-observation age, and bounded sanitized active-tool names; private transport text, stderr, raw frames, call IDs, arguments, and results are omitted, while client connectivity remains a separate state ([incident/decision 0072](../postmortems/0072-compact-worker-activity-and-pi-frame-coalescing.md));
- atomic durable admission containing the queued snapshot, first event, optional idempotency identity, and first execution lease, with later persistence failures isolated from worker retry and terminal-result fabrication and an accepted cancellation unable to become success;
- top-level `schemaVersion: 1` on new leaf Job and Orchestration records, with schema-less legacy-v1 file reads materialized in memory without rewriting and unsupported explicit versions rejected;
- immediate execution with cooperative timeouts, retries, and cancellation, plus bounded exact-child and output-drain supervision in the bundled Pi adapter even when an external event sink does not settle;
- adapter-level coalescing of consecutive Pi text frames so transport fragmentation does not exhaust durable worker-event retention before later tool/completion evidence, without changing exact final output or non-text ordering;
- reproducible Pi execution that disables ambient extension, skill, prompt-template, and theme discovery while preserving repository instructions and explicitly configured resources;
- sanitized per-job Pi session statistics for measuring message/tool counts, token use, cost, and context use without retaining session paths, identifiers, or raw responses;
- a read-only CLI and TypeScript usage projection over persisted terminal evidence, with exact available downstream token/cost aggregation, explicit cache-read and route-selection hit formulas, partial/unavailable coverage, and no fabricated controller usage or upstream/downstream proportion;
- optional route-neutral advisory quality review for one successful child and one bounded valid patch, selected by configured parent complexities and a configured single-attempt route or all-single-attempt pool, with an exact single-use artifact-read grant, strict verdict/findings, explicit skipped/unavailable states, no repair or promotion, controller disposition left unpersisted, and no measured efficiency claim;
- optional controller-owned artifact validation for one successful child and one bounded valid patch, using one configured shell-free argument vector in a fresh disposable worktree, with bounded command/cleanup evidence and no change to child/parent success or artifact promotion;
- one-shot completion callbacks to trusted URLs, with callback-bookkeeping persistence isolated from the terminal execution result and no automatic redelivery;
- direct-workspace compatibility mode and Git worktree attempt isolation, including supported staged, unstaged, and non-ignored untracked source snapshots;
- complete per-attempt Git patch artifacts, including tracked-file deletions without treating sparse-checkout omissions as deletions, with base commit, exact source-tree identity, size, and SHA-256;
- read-only artifact listing, integrity/base verification, and bounded patch preview through TypeScript, CLI, and HTTP;
- a shared Job-list summary page capped at 1 MiB across CLI, HTTP, and the HTTP client, with exact Job lookup retaining the full record;
- additive delegated-parent artifact review that compares controller-captured terminal paths, reports exact path overlap as potential integration-conflict evidence, and marks missing child evidence incomplete;
- additive schemaVersion 1 terminal Job completion summaries with terminal outcome/attempt, controller-captured artifact path provenance, and explicit unavailable states; custom adapters may supply a strict worker completion report, while normal Pi Jobs require one and fail when it is missing or malformed so process settlement and an empty valid artifact cannot masquerade as task completion; `taskOutcome` applies to the assigned worker-role task rather than an inspected subject's acceptability, and a valid worker-reported block is one terminal non-retryable failure across every route and remains available as worker-reported evidence; a delegated `repository-analysis` that produces any changed path likewise fails once as a read-only-contract violation while retaining the artifact for controller inspection;
- configuration validation and explicit configuration-only and opt-in live route diagnostics;
- canonical HTTP process liveness that explicitly reports storage, routes, and inference as not checked, without claiming route readiness;
- one exact independent `127.0.0.1` broker publishing a product-owned per-user record after listen, with `agentknot broker run|up|status|down` providing foreground or explicit application-managed lifecycle and `agentknot client --json` reporting `unconfigured`, `available`, or `unavailable`; a successful explicit `broker up` remembers only its validated config path and port in the platform application-config directory, and common MCP can explicitly start or reuse that profile without target-repository scanning; discovery and launch preference are conveniences, not state authority;
- transitional cross-platform production-scheduler ownership through one hidden Node built-in SQLite lifetime lock per canonical storage directory while multi-executor recovery/configuration authority remains undefined; production record/event/idempotency/lease/capacity authority is the separate transactional `agentknot.sqlite`;
- controller-neutral orchestration through CLI, HTTP, and TypeScript;
- `off`, `suggest`, and `auto` modes with per-request narrowing;
- strict controller-authored assessments followed by deterministic task-kind policy;
- immutable effective policy, plan hash, exact child prompts, routes, parent/child provenance, and ordered orchestration events;
- bounded depth-one delegation with product defaults of `maxChildren: 2` and `maxConcurrency: 2` when those values are omitted, an explicit repository dogfood pool of six tasks with six active slots backed by current six-child Pi/OpenCode Go/Luna/max orchestration evidence, and a configuration ceiling of six for each with concurrency never exceeding the child count;
- fenced leaf and parent startup recovery from admitted immutable input and controller-authored plans, with cancellation precedence, explicit lost-attempt evidence, deterministic child/reviewer identity reuse, and no replanning or route replacement;
- durable FIFO capacity admission shared by direct, child, and reviewer Jobs, with one transitional production scheduler per canonical Job/Orchestration storage pair until multi-executor recovery and configuration authority are defined; route-pool choice uses durable Job leases atomically, durable records reject stale CAS/fence writes, and read-only runtimes remain unable to execute work;
- catchable CLI and HTTP shutdown that closes admission, keeps the listener reachable during cancellation/drain, closes the listener, and only then releases runtime ownership, plus a bounded process-attributed Stage 1 soak;
- optional vendor-neutral route-selection policy under `delegation.dispatch`, disabled by omission and limited to 1–20 ordered rules whose route or pool targets validate at config load, with `shadow` evidence-only and `active` human-authored execution modes ([decisions 0016](../postmortems/0016-shadow-route-selection.md), [0020](../postmortems/0020-human-authored-active-route-selection.md), and [0042](../postmortems/0042-complete-route-pool-balancing.md));

Rules may match non-empty unique `taskKinds` and/or non-empty unique parent `complexities` from `low`, `medium`, and `high`; both predicates must match when both are present, a rule with neither is an explicit catch-all, and a zero-based rule index is recorded only for a match. Repository dogfood maps `low` to the configured `deepseek-flash` route and leaves `medium`, `high`, and no match on `luna`; route values are configuration evidence, not an intelligence ranking, learned optimization, quota signal, or fallback.

Route diagnostics have two explicit modes. The default `doctor` command is a fast configuration, credential, and runtime check and must say that live inference was not checked. The opt-in `doctor --live` path performs one bounded real inference through the exact selected worker, provider, model, and thinking level; its 30-second control-plane timer triggers cooperative abort, and a supported adapter must settle after abort and clean up its resources. It reports provider errors with failure status and unsupported adapters honestly, does not fall back or select another route, does not create Job or artifact records, and does not add a probe before normal jobs or orchestrations.

The current production stores provide transactional projections, append-only event cursors, CAS revisions, idempotent admission, durable cancellation intent, fenced leases, and FIFO Job-capacity rows. Leaf git-worktree admission retains a bounded reference to an exact-ID integrity-checked input patch. After the prior lease expires, an execution-owning runtime may reclaim a queued leaf from that immutable input or record a running attempt as lost before consuming only its next configured retry; lease reclaim atomically rebinds any acquired capacity row, durable cancellation wins before replay, and the exact persisted route remains fixed. Parent Orchestrations reclaim the admitted controller-authored plan and workspace snapshot, adopt deterministic existing children/reviewers, and admit only missing work; historical no-plan state fails explicitly. Production route pools atomically derive least-active choice from unexpired exact-route Job leases and persist their cursor with admission. Read-oriented runtimes perform no recovery. The system does not yet provide a multi-host scheduler, distributed coordination, worker-process reattachment, or automatic cleanup of arbitrary descendants and worktrees left by an uncatchable hard process crash.

Provider and model independence are currently routing properties implemented by the selected worker. AgentKnot does not yet expose an independent provider-runtime interface.

Pi is the sole built-in real worker adapter. OpenCode Go remains a configured downstream provider/model route for Pi, while other worker runtimes remain custom adapter or future integration choices; AgentKnot does not directly invoke the OpenCode CLI ([decision 0059](../postmortems/0059-retire-native-opencode-worker.md)).

Pi extensions are optional worker-profile inputs, not portable core dependencies. A community package can enter the repository dogfood route only after source/supply-chain review and repeated same-task comparison against the minimal Pi route show no regression in terminal completion, artifact validity, or tests and a measurable improvement in upstream intervention, token use, or elapsed work. Trials must use an exact version or immutable external path without global or repository-local installation, and must preserve the selected provider, model, and thinking level. AgentKnot never silently selects an extension or model fallback.

## Non-goals

AgentKnot is not intended to become:

- an agent chat network with channels, threads, direct messages, reactions, feeds, or presence;
- a general autonomous swarm or role-playing multi-agent framework;
- a model SDK, prompt framework, memory store, or knowledge base;
- a hosted multi-tenant control plane or cloud compute fleet;
- an IDE, terminal multiplexer, or graphical agent cockpit;
- an operating-system security sandbox;
- an implicit provider optimizer that silently changes models or falls back across providers;
- an automatic or learned model/provider ranking system: human-authored active rules do not claim measured intelligence and any optimizer still requires separate scorecards and a new gate;
- an account-quota estimator or quota-aware router derived from local history, configured budgets, console scraping, or incomplete per-machine observations;
- a system that automatically applies patches, creates branches or pull requests, merges, commits, or pushes;
- an operating-system service installer/manager, login daemon, per-controller runtime, repository scanner, or shell-profile mutator; explicit `broker up` only hosts the same middleware process and is not state authority;
- a reimplementation of Pi, MCP, OpenCode, Codex, Claude Code, or Relay.

Remote workers, dependency graphs, scheduling, and dashboards may be evaluated later, but only after the local single-job contract is dependable and a concrete use case justifies them.

## Reference workflow

1. The controller and user agree on a bounded task and acceptance criteria; the controller owns intent, planning, decomposition, and product decisions.
2. The controller chooses the leaf Job API for an already bounded leaf or authors a strict `TaskAssessment` for the orchestration API. The controller-native Skill describes this handoff, and the stateless `SessionStart` hook supplies one concise obligation at `startup`, `resume`, `clear`, and `compact`; it does not forward raw prompts or make the semantic decision. The controller uses common MCP, CLI, HTTP, or TypeScript admission. If common MCP reports a stopped or unavailable configured broker, the controller may explicitly try activation once before admission. A native `/goal` is not a separate AgentKnot protocol.
3. For orchestration, AgentKnot validates the assessment, including any optional bounded shared navigation context, snapshots effective policy, deterministically filters and caps subtasks, optionally evaluates configured shadow or active rules using subtask kind and parent complexity, and admits the resulting plan plus one immutable workspace snapshot before any child dispatch. The same context prefix precedes each selected child's task-specific instruction. The later accepted-handoff event exposes that already-admitted policy projection; execution never reclassifies the goal. The assessment cannot name routes, workers, providers, models, or effort.
4. An upstream or suggested decision returns without starting child jobs. An automatic decision submits each selected subtask through the ordinary Job API with depth-one provenance and bounded concurrency. One bounded substantive task may be one non-parallel child; a lack of useful parallel splitting does not by itself retain the task upstream. A bounded allowlisted task expected to create or modify a repository file is delegation-first even when small or low-complexity. A concrete allowlisted `repository-analysis` that must search, compare, or interpret project content and return independently verifiable findings is likewise delegation-first when read-only; only a direct lookup of one explicit fact from one already identified location may stay upstream on cost grounds. Shadow keeps `dispatch.defaultRoute`; active uses the matched configured route or the conservative default, and both carry selection evidence, task kind, and parent complexity in structured child metadata ([decisions 0035](../postmortems/0035-delegation-first-small-repository-deliverables.md) and [0051](../postmortems/0051-evidence-producing-repository-analysis.md)).
5. For a leaf job, the controller submits a `JobRequest` with a workspace, route, source identity, and optional callback.
6. AgentKnot validates the request and snapshots the route, then atomically creates the queued job record with `job.queued`; failure starts no worker.
7. AgentKnot begins execution, prepares an isolated attempt when configured, and invokes the route's worker adapter.
8. The adapter translates worker activity into normalized events while AgentKnot owns state, timeout, retry, cancellation, persistence, and cleanup.
9. AgentKnot captures the terminal attempt artifact, builds the completion summary, and persists it before the terminal event is delivered.
10. For delegated work, AgentKnot compares each child's controller-captured terminal paths. Exact paths owned by multiple children are persisted as potential integration conflicts; missing evidence makes the review incomplete. This does not replace artifact integrity/base verification or prove semantic compatibility.
11. When optional quality-review policy selects the parent complexity and exactly one successful child has exactly one bounded valid non-empty patch, AgentKnot starts the configured reviewer route once in a fresh depth-one Job. The reviewer receives the goal, acceptance criteria, verified artifact identity and patch, plus labeled-unverified worker claims, and returns bounded advisory evidence. Ineligible, failed, malformed, cancelled, or restart-interrupted review remains explicit and never silently becomes acceptance.
12. When optional artifact-validation policy is configured for the same one-child/one-patch shape, AgentKnot independently rechecks the recorded artifact and exact admitted source snapshot, recreates that snapshot in a second disposable worktree, applies only the worker delta, and executes exactly one configured argument vector there. Validation and optional review run concurrently; pass, failure, timeout, output limit, cancellation, startup failure, source drift, and cleanup are explicit evidence and never rewrite child or parent success.
13. The controller verifies and previews the selected child artifacts, considers overlap, optional reviewer evidence, and optional controller-owned validation, and deliberately accepts, modifies, or rejects the artifact or child set upstream. That decision does not mutate Job/Orchestration state and is not currently persisted by AgentKnot.
14. Only after acceptance may the controller perform a separate explicit promotion in its own repository workflow. AgentKnot does not automatically apply, commit, merge, or push artifacts.

If event, artifact-recording, or terminal persistence fails after admission, the leaf completion rejects as a control-plane persistence failure. It does not retry the worker, invent a failed terminal result, or deliver a terminal callback; the last successfully persisted snapshot remains authoritative and unrecorded patch evidence is removed.

The current `queued` state covers both newly admitted work and durable capacity waiting. `job.capacity.waiting` makes the latter explicit without creating another scheduler state authority.

The production scheduler remains single-owner while Stage 3 multi-executor recovery and configuration authority are unfinished. Execution-owning construction first claims both canonical storage directories; read-only clients can inspect the transactional store concurrently but cannot execute or recover through that runtime. Admitted executions additionally hold renewable fenced record leases, durable capacity rows, and cancellation intent, so capacity order, stale storage writes, cross-client cancellation, leaf/parent reclaim, and production route-pool choice do not depend on an HTTP process or activity map. The lifetime scheduler lock is not a distributed lock or hostile-process sandbox and will be removed only after the multi-executor gates pass.

## Product acceptance criteria

The product remains on course when all of the following are true:

- changing `source` from Codex to Claude changes audit metadata, not execution behavior;
- changing provider or model is a route change unless a genuinely new worker runtime is required;
- configuration-only `doctor` explicitly says live inference was not checked, while `doctor --live` performs only the bounded exact selected-route probe and leaves no Job or artifact record;
- every hosting mode runs the same kernel operations and durable records; foreground and explicit background use require no shell-profile or native-service mutation, while one stable per-user discovery rendezvous remains identical across transient controller environments and external supervisors remain hosting conveniences rather than state authority;
- controller packages install one narrow stateless `SessionStart` obligation for `startup`, `resume`, `clear`, and `compact`, no `UserPromptSubmit` hook, and never start or mutate service state, scan target repositories for fallback configuration, or silently switch to local execution or another model after an unavailable selected transport;
- durable admission atomically binds the queued record, first event, optional idempotency identity, and first fenced lease; stale revisions or fences cannot overwrite current work, accepted cancellation cannot commit as success, and released leases never reuse an old fence generation;
- the same Job API works through CLI, HTTP, and TypeScript entry points;
- the same orchestration policy and record shape work through CLI, HTTP, and TypeScript without controller-name branches;
- every automatically dispatched child is admitted through the ordinary Job API only after its plan and immutable parent workspace evidence are persisted, and serial/refill/reviewer admissions derive from that evidence rather than mutable source state;
- automatic delegation is isolated, depth-one, capped, non-recursive, and cannot select configured keep-upstream task kinds;
- omitted route-selection configuration disables selection; `shadow` and `active` accept strict 1–20 ordered rules over existing routes, first-match/default evidence is plan-hash-covered, shadow never replaces `dispatch.defaultRoute`, and active dispatches the exact selected route while metadata carries task kind, parent complexity, and evidence;
- every emitted job event is already present in the persisted record;
- newly written admitted prompts/metadata, persisted worker events/results/errors, complete Job/Orchestration snapshots, and callback bodies stay within the fixed documented UTF-8 budgets, with explicit truncation/replacement/refusal evidence rather than silent route changes; legacy over-limit snapshots remain readable but must fit before a later mutation;
- newly captured Git patch artifacts stay within 16 MiB; an oversized capture fails without retry or retained partial bytes, and inspection does not hash or preview an oversized managed file;
- every terminal job is inspectable after the invoking call returns;
- every newly terminal succeeded, failed, or cancelled Job has a schemaVersion 1 completion summary before its terminal event is persisted or observed, and retries summarize only the terminal attempt;
- completion summaries distinguish controller-captured artifact paths from worker-reported claims, never infer reports from prose/events/stderr/session statistics or empty artifacts, and preserve explicit unavailable reasons; custom adapters may omit reports, while normal Pi Jobs require the exact end-marked envelope and fail an attempt when it is absent, malformed, unsupported, or non-terminal;
- usage reporting counts exact persisted successful-Job statistics once, preserves provider-reported totals and cost without currency normalization, classifies route hits only from terminal plan/policy evidence, and reports controller usage and cross-boundary proportions unavailable until comparable exact controller data is persisted;
- advisory quality review is disabled by omission, uses an explicitly configured single-attempt route or all-single-attempt pool, persists the selected exact Job route, and records completed, skipped, unavailable, or restart-interrupted evidence without changing child success or promoting artifacts;
- artifact validation is disabled by omission, admits only one successful child with one integrity/base-valid non-empty patch no larger than 32 KiB, executes one bounded shell-free configured command in a disposable worktree, persists command and cleanup evidence before the terminal parent event, and never mutates the source or promotes the artifact;
- new leaf Job and Orchestration records carry `schemaVersion: 1`, legacy file reads remain byte-stable, and unsupported explicit versions fail rather than defaulting to v1;
- Git worktree mode leaves the source worktree/index/object database unchanged, supports dirty top-level source snapshots, and returns only worker-delta artifacts without applying them;
- controllers can verify and preview recorded artifacts without source mutation, while acceptance and promotion remain explicit upstream decisions;
- delegated parent results compare terminal controller-captured paths deterministically, report repeated paths without calling them semantic conflicts, and mark missing evidence incomplete rather than clean;
- retries start from the same recorded base rather than prior-attempt edits;
- after admission, catchable CLI or HTTP shutdown rejects new admissions, cancels and awaits active work before listener close and ownership release; late events from a settled attempt cannot enter a retry or terminal record;
- normal snapshot and artifact write failures remove only their exact temporary file, and the bounded Stage 1 soak leaves no attributed process or managed-worktree residue;
- credentials are not intentionally copied into configuration, records, events, logs, callbacks, or artifact metadata;
- local records and artifacts remain until deliberate exact operator deletion, with no automatic expiry, cascade deletion, or content-redaction claim;
- current, proposed, experimental, and deferred capabilities are distinguishable in documentation;
- a feature that crosses a stable boundary has a spec change, tests, and an explicit roadmap gate.

## Success signals

Before broadening the product, AgentKnot should demonstrate:

- repeated real use by at least two controller types through the same API contract;
- reliable use of more than one provider/model route without controller changes;
- deterministic conformance tests for every supported worker adapter;
- no source-workspace mutations or managed-worktree leaks in the supported isolation path;
- actionable job records for success, failure, retry, timeout, and cancellation;
- an explicit human-controlled artifact inspection and promotion workflow.

These are evidence requirements, not claims that the current MVP has already met every condition.

## Risks

- Product language such as "durable", "queue", "timeout", "provider-neutral", or "isolation" can imply stronger guarantees than the implementation provides.
- Raw worker events, prompts, output, and tool results remain capable of containing sensitive content even though their admitted or persisted representations now have fixed byte/count budgets; size bounds are not redaction.
- Local snapshots and patch artifacts are retained indefinitely by default; operators must control filesystem access and deliberately delete exact inactive records because Stage 1 has no automatic retention service or purge API.
- Worker completion reports are claims at the adapter boundary; accepting their strict shape does not verify changed paths, check outcomes, remaining risks, or notes.
- Exact child path overlap is conservative potential-conflict evidence: same-path patches can be compatible, disjoint paths can still be semantically coupled, and every selected artifact still requires integrity/base review.
- An advisory reviewer is another model-mediated judgment: `accept` can miss a defect and `changes-requested` can be wrong. Bounded evidence, strict output, independent upstream checks, and measured route/profile trials reduce but do not remove that risk; current model pairings do not establish a portable intelligence ranking.
- A custom adapter may ignore cooperative cancellation unless the adapter contract and process supervision enforce termination.
- Hard `SIGKILL`, host loss, or another uncatchable failure bypasses shutdown handlers; fenced leaf and parent recovery repair supported admitted boundaries after lease expiry, but no path universally proves ownership of leftover external processes or worktrees.
- Callback delivery is currently unauthenticated, untrusted-network unsafe, non-retrying, and capable of sending the complete bounded job record when its serialized body is no more than 8 MiB.
- A controller may be model-driven and can author a mistaken or repository-influenced assessment; strict validation and deterministic policy reduce but do not eliminate prompt-injection or task-classification risk. Shadow suggestions and active configured routing both inherit the limits of the parent complexity and task-kind classification; active mode therefore keeps a conservative Luna default and never adds fallback.
- Shadow route evidence is not a measured model ranking; separate scorecards must compare routes on the same bounded workloads before any automatic selection is proposed.
- Transactional CAS and fenced record leases prevent conforming stale writers; production route-pool selection and the shared direct/child/reviewer FIFO capacity boundary use those leases atomically. The transitional lifetime scheduler lock remains until multi-executor recovery/configuration gates pass, and multi-host or hostile-writer safety is not claimed ([decisions 0055](../postmortems/0055-durable-middleware-kernel.md) and [0061](../postmortems/0061-atomic-durable-route-pool-admission.md)).
- A custom process with direct filesystem access can ignore application contracts or alter the database/artifacts; mode-0600 files and middleware fencing are not an operating-system sandbox or distributed-consensus boundary.
- Depth one constrains AgentKnot's own parent/child engine; the unauthenticated local API cannot prevent a host-capable worker from independently submitting another top-level orchestration.
- Adding integrations before an adapter conformance contract exists can move provider-specific policy into the core.
- Copying collaboration or fleet features from adjacent projects would dilute the local execution-handoff problem AgentKnot exists to solve.

## Drift control

Every material feature proposal must answer:

1. Which primary user problem or job-to-be-done does it solve?
2. Which component owns it: controller, Job API/orchestrator, worker adapter, provider/model route, workspace manager, or external integration?
3. Does it preserve the invariants in [SPEC.md](./SPEC.md)?
4. Which stage and exit gate in [ROADMAP.md](./ROADMAP.md) admit it?
5. Is it current, proposed, experimental, or deferred?
6. What test or operational evidence will prove it works?
7. Does a rejected alternative or important tradeoff require a postmortem/decision record?

If those questions do not have concrete answers, the work should not enter implementation.

## External reference boundary

[Agent Workforce Relay](https://github.com/AgentWorkforce/relay) is a useful reference for runtime boundaries, capability honesty, durable delivery, and contract gates. Relay's communication, social collaboration, hosted, and fleet concerns are deliberately outside AgentKnot's product boundary. Integration with Relay may someday be an adapter; copying Relay into AgentKnot is not a goal.

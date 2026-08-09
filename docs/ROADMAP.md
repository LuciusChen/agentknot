# AgentKnot roadmap

- Status: Living execution plan
- Last updated: 2026-08-09
- Planning model: evidence-gated stages, not date promises

## How to use this roadmap

This roadmap exists to stop attractive adjacent features from displacing the core execution-handoff problem.

- Only one stage is the default product focus at a time.
- A stage exits when its evidence gates pass, not when its feature list looks complete.
- Later-stage work may be researched early, but it must not change current contracts or become advertised support.
- A new feature must map to the PRD, preserve the SPEC, name its boundary owner, and identify an exit gate.
- Work without those links belongs in an experiment, external integration, or rejected/deferred decision record.

The source of product truth is [PRD.md](./PRD.md). Stable technical behavior is defined in [SPEC.md](./SPEC.md). Historical decisions and failures live under [`postmortems/`](../postmortems/README.md).

## Stage overview

| Stage | Outcome | Status |
| --- | --- | --- |
| 0 | Prove the vendor-neutral execution slice | Complete |
| 1 | Make local execution and its bounded delegation slice dependable and honestly specified | In progress |
| 2 | Prove controller and worker portability through contracts | Not started |
| 3 | Add bounded local automation and security policy | Not started |
| 4 | Evaluate remote/team operation only from demonstrated demand | Conditional |

## Stage 0: Vendor-neutral execution slice

### Outcome

Prove that a controller-neutral job can be routed through a real worker/model path while AgentKnot owns lifecycle and protects the source workspace.

### Delivered

- CLI, HTTP, and TypeScript Job API entry points.
- Independent worker/provider/model route fields.
- Deterministic mock worker and real Pi RPC worker.
- OpenCode Go/Luna and xAI/Grok route configuration through Pi.
- File and memory job stores with ordered snapshot events.
- Cooperative timeout, retry, cancellation, and one-shot callback behavior.
- Git worktree attempt isolation, patch capture, hashing, and cleanup.
- Tests for routing, HTTP submission, Pi normalization, lifecycle paths, and worktree artifacts.

### Exit evidence

- A Codex-labelled and Claude-labelled request use the same execution path.
- A real Pi/Luna job completes through AgentKnot.
- Git worktree tests prove source cleanliness and patch applicability.
- The implementation remains useful without Relay, OhMyPi, OpenCode CLI, or controller-specific plugins.

Stage 0 proves the shape of the system. It does not establish production-grade durability, hard sandboxing, restart recovery, authenticated networking, or scale.

## Stage 1: Dependable local job loop

### Outcome

Make leaf-job semantics and the bounded delegation slice reliable enough that a controller can submit, observe, diagnose, verify, and explicitly promote a result without relying on optimistic wording or manual archaeology.

### Product-contract work

- Keep PRD, SPEC, ROADMAP, README, and postmortems linked and current.
- [x] Add a capability/status table that distinguishes current, experimental, proposed, and deferred behavior.
- [x] Version persisted leaf Job and Orchestration records before incompatible schema evolution begins; new records use `schemaVersion: 1`, legacy file reads materialize missing versions without rewriting, and explicit unsupported versions fail.
- [x] Validate controller metadata recursively as JSON-compatible values so TypeScript/HTTP admission and file storage preserve one contract.
- [x] Add the optional vendor-neutral `delegation.dispatch.routeSelection` shadow slice: omission disables it, only `shadow` is valid, candidate routes validate at config load, ordered 1–20 rules use first-match/default evidence, and child metadata exposes the evidence without changing the actual default route ([decision 0016](../postmortems/0016-shadow-route-selection.md)).
- [x] Define a structured completion summary: changed files, checks run, remaining risks, and worker-reported notes, without treating worker assertions as verified facts. The additive summary, deterministic normal-Pi emission slice, and real Pi/OpenCode Go/Luna/max dogfood evidence are complete.
  - [x] Add the additive schemaVersion 1 `JobRecord.completionSummary` with terminal outcome/attempt, terminal-attempt artifact provenance, and stable unavailable reasons.
  - [x] Validate optional custom-adapter and normal-Pi worker reports strictly, preserving absent/malformed/unretained states without inferring from prose, events, stderr, or session statistics.
  - [x] Append the exact provider/model-neutral report instruction only to normal Pi runs, parse only an end-anchored single-line suffix, strip valid suffixes from output, and keep malformed/unsupported envelopes advisory.
  - [x] Add and verify strict `WorkerCompletionReport` emission from the promoted Pi path with an actual Pi/OpenCode Go/Luna/max dogfood job.

### Lifecycle and persistence work

- Make live event-listener failure advisory so observer failure cannot accidentally retry or fail worker execution.
- Define and test persistence-failure behavior at admission, event append, terminal transition, artifact recording, and callback bookkeeping.
- On startup, detect stale nonterminal records and deterministically mark or reconcile them; resumable execution is not required in this stage.
- Define the supported single-process concurrency model and reject unsupported multi-process writers clearly.
- Bound event, raw worker data, stderr, result, callback payload, and record growth.
- Add an explicit retention and redaction policy, including the limits of redacting prompts, patches, and model output.

### Bounded delegation slice admitted into Stage 1

The product requirement changed after Stage 0: controller-independent automatic delegation is part of the core handoff, not merely a later unattended scheduler. Stage 1 therefore admits one deliberately narrow parent/child slice while keeping general dependency graphs and queues deferred.

Delivered in this slice:

- one `OrchestrationRequest` contract shared by CLI, HTTP, and TypeScript;
- `off`, `suggest`, and `auto` global modes with bounded per-request overrides;
- a read-only planner job with strict JSON validation and explicit upstream/fail fallback;
- deterministic allow/keep policy, depth exactly one, product defaults of two children and two concurrent executions when limits are omitted, the repository's explicit six-task/six-slot dogfood setting, and a six-child/six-concurrency configuration ceiling;
- planner guidance that reserves parallel plans for independently verifiable, dependency-free subtasks with non-overlapping expected write scopes, plus a sliding dispatcher that refills bounded worker slots from the persisted task pool;
- immutable effective policy, plan hash, exact prompts/routes, parent-child IDs, and persist-before-dispatch events;
- optional shadow route-selection evidence keyed by eligible subtask kind and parent assessment complexity, with 1–20 ordered validated rules, first-match/default outcomes, plan-hash coverage, and structured child metadata while `PlannedSubtask.route` and the ordinary child `Job.route` remain `dispatch.defaultRoute`; rules use non-empty unique task-kind and/or `low`/`medium`/`high` complexity predicates, with both predicates conjunctive and predicate-free rules explicit catch-alls;
- child execution only through the ordinary isolated Job API;
- cancellation propagation and fail-without-resume restart reconciliation;
- AgentKnot self-use through the real Pi/Luna route as a required promotion check for this slice.

The shadow slice is evidence-only and does not change actual dispatch, fallback, retry, provider/model/thinking resolution, or the formal repository Luna/max route; no artifact is applied automatically.

Still outside this slice:

- recursive delegation, dynamic replanning, dependencies between children, or model-chosen route changes;
- automatic model/provider ranking or route switching; the explicit experimental DeepSeek Flash/max leaf route remains outside dispatch and fallback, and repeated comparable trials are required before shadow evidence can support a future automatic-selection proposal;
- restart resume, a durable capacity queue, leases, multi-process writers, or distributed concurrency;
- automatic patch selection, application, commit, push, merge, deployment, or pull-request creation;
- implicit interception of native controller conversations. Controllers must call the orchestration API.

### Worker reliability work

Delivered in this slice:

- Deterministic malformed JSONL, split UTF-8/frame, premature-exit, missing-settlement, timeout, and cancellation fixtures exercise the real Pi adapter and public Orchestrator boundary.
- The Pi adapter settles after abort with bounded exact-child `SIGTERM` → `SIGKILL` supervision and bounded owned-stream draining; it does not perform broad process cleanup.
- Pi configuration-only doctor and spawned execution now share one effective worker environment for command discovery, required names, and auth-directory/home lookup, with deterministic precedence and secret-non-disclosure coverage.
- Pi normal runs and live probes disable all ambient resource discovery while preserving explicit reviewed resources and repository context; successful normal jobs capture sanitized advisory session statistics for empirical worker-profile comparisons, and normal runs have deterministic, strictly validated completion-report emission while live probes remain unchanged.
- The bounded normal-run Pi record-volume slice omits only the four known lifecycle envelopes (`turn_start`, `turn_end`, `message_start`, `message_end`) from `worker.raw`, counts every received frame in `metadata.rawEventCount`, and preserves unknown event types as `worker.raw`; normalized text/tool/retry events, final output, completion reports, live-probe behavior, route/provider/model/thinking configuration, and global event types remain unchanged.
- This slice makes no Pi-token-saving claim and adds no general truncation, schema migration, plugin installation, configuration/probe changes, or global event-type changes; broad retention and record-size limits remain separate open Stage 1 lifecycle work.
- Canonical `GET /health/live` and its explicit not-checked payload distinguish HTTP process liveness from route readiness; legacy `GET /health` remains an identical compatibility alias, and readiness inference stays opt-in through CLI diagnostics.

Next evidence gate:

- The first isolated candidate, `pi-readseek@0.9.10`, passed source review, live loading, artifact verification, and target tests but was rejected after one same-task Luna/max pair materially regressed token use, elapsed time, tool calls, and persisted record size; see [experiment 0013](../postmortems/0013-pi-readseek-profile-ab.md).
- The narrower `pi-lean-ctx@3.9.18` profile passed source and supply-chain review and produced selected passing artifacts in two same-task Luna/max pairs. Its 39.0% token reduction on a larger implementation reversed into 36.2% more tokens and 45.7% more elapsed time on an independent smaller test task, so it did not clear the repeatability gate; see [experiment 0014](../postmortems/0014-pi-lean-ctx-profile-ab.md).
- [x] Apply the profile promotion gate: neither reviewed candidate is a general dogfood profile, the repository and global Pi state remain unpolluted, and the minimal route remains formal.
- Reopen profile work only with a new bounded hypothesis and a reliable selection rule that can avoid workloads where the profile regresses; keep task-dependent automatic selection deferred until that rule has evidence.
- The explicit DeepSeek V4 Flash/max route passed a live probe and one same-task test-only A/B. It used 38.4% fewer Pi tokens and lower provider-reported cost than Luna/max, but took 23.5% longer and produced a larger patch; Luna's smaller patch was selected. Keep the candidate explicit-only until repeated task-class trials establish a reliable rule ([experiment 0017](../postmortems/0017-deepseek-flash-route-ab.md)).

### Runtime reconciliation correctness

Delivered:

- Read-oriented CLI construction skips startup reconciliation, while `run`, `orchestrate`, and parameter-valid `serve` remain explicit execution owners; deterministic cross-process CLI tests prove reads and invalid commands leave persisted bytes unchanged.

Still open:

- Define and test the PID-namespace and concurrent-writer boundary before relying on PID liveness to fail nonterminal records.
- Preserve single-writer evidence: a stale-recovery write must not race an active runtime and then disappear under a later whole-snapshot save.

### Route-diagnostics slice admitted into Stage 1

Stage 1 keeps route diagnostics fast by default while adding one explicit live-inference path for the observed false-ready failure mode.

- Configuration-only `doctor` checks configuration, credentials, and runtime availability and explicitly says that live inference was not checked.
- Opt-in `doctor --live --route NAME` performs one bounded real inference through the exact selected worker, provider, model, and thinking level; current real promotion evidence covers the repository Luna/max route.
- The control plane uses a 30-second timeout, reports provider errors with failure status, and reports adapters without probe support as unsupported rather than ready.
- The probe never falls back or selects another route, creates no Job or artifact records, and does not add a probe before normal job or orchestration execution.

### Artifact handoff work

Delivered in this slice:

- TypeScript, CLI, and HTTP contracts for artifact listing, size/SHA-256 verification, current-source base-commit verification, and integrity-gated bounded patch preview.
- Git-derived repository-relative `changedFiles` arrays on newly captured worktree artifacts, including `[]` for empty patches, with intent-to-add and NUL-delimited path handling for tracked, untracked, binary, committed, retry, and unusual-filename changes.
- Deterministic tests for valid, missing, tampered, and base-mismatched evidence that prove inspection does not mutate the source repository; changed-file evidence remains controller-captured artifact data and is now carried into the terminal summary only with artifact identity, never as semantic verification.

Still outside this slice:

- Define an explicitly invoked promotion operation only if it can refuse a dirty or mismatched target safely and always requires controller/human intent.
- Compare actual changed paths across child patch artifacts and flag semantic integration conflicts; planner-declared non-overlap is guidance rather than enforcement until this exists.
- Never turn successful worker completion into automatic patch application, commit, merge, or push.

### Exit gates

- Every README capability is implemented and tested or visibly marked proposed/deferred.
- Crash/restart behavior for every nonterminal state is deterministic and tested.
- Every orchestration persists a valid plan before dispatch, never exceeds its child/depth/concurrency bounds, and leaves artifact integration upstream.
- Shadow route-selection omission, strict invalid configuration, first-match/default behavior, plan-hash coverage, default-route execution authority, and public child metadata are covered at the configuration and orchestration boundaries.
- Every newly terminal Job has an additive completion summary before terminal observation, and the strict Pi report path has deterministic coverage plus real Pi/OpenCode Go/Luna/max emission evidence.
- Observer and callback failures cannot change a correct execution result.
- A supported adapter cannot leave a timed-out or cancelled job indefinitely active.
- A read-only CLI or API inspection cannot reconcile or mutate an active Job or Orchestration record.
- Configuration-only doctor output distinguishes runtime readiness from live inference; the opt-in probe is exact-route, bounded, honest about provider errors and unsupported adapters, and leaves no Job or artifact evidence.
- Record and event sizes remain within documented limits under stress fixtures.
- Every artifact is checksum-valid and applies against its recorded base in the supported Git matrix.
- No source mutation, child-process leak, managed-worktree leak, duplicate/gapped event sequence, or cross-attempt state leak appears in the soak suite.
- A controller can inspect and deliberately accept or reject an artifact using a documented workflow; inspection is read-only, while promotion remains an explicit upstream action.

### Explicitly not in Stage 1

- dynamic provider fallback;
- dependency graphs or agent swarms;
- remote workers or cloud fleets;
- channels, chat, reactions, or presence;
- a dashboard;
- an operating-system sandbox claim;
- automatic model/provider ranking or route selection, which remains deferred until separate measured scorecards and an explicit roadmap gate exist.

## Stage 2: Portable controller and worker contracts

### Outcome

Prove that controllers and worker runtimes can change independently without core branches or misleading capability claims.

### Planned work

- Publish minimal Codex and Claude controller examples that submit the same `JobRequest` and consume the same terminal/evidence contract.
- Introduce an implemented-capabilities schema only after at least two real workers need meaningfully different lifecycle behavior.
- Build a worker-adapter conformance kit for startup, route resolution, events, cancellation, termination, errors, artifacts, and health diagnostics.
- Promote Pi from first adapter to reference-tested adapter rather than privileged architecture.
- Evaluate a native OpenCode, Codex, Claude, Grok, or AI SDK harness adapter only when it provides a demonstrated lifecycle or observability benefit over Pi.
- Keep provider/model selection as route data unless a second implementation proves that a standalone provider abstraction is required.
- Define exact versus inferred observability if multiple runtimes offer different event fidelity.

### Exit gates

- At least two controller types pass the same end-to-end contract without controller-name branches.
- At least two real worker adapters pass the same conformance suite.
- Unsupported lifecycle and observability features are represented as unavailable, not emulated deceptively.
- Swapping controller, worker, provider, or model changes configuration or an adapter, not unrelated orchestrator modules.
- A real-worker soak covers success, failure, cancellation, timeout, and artifact handoff for every promoted adapter.
- Removing one adapter leaves the core and other adapters functional.

### Decision rule for native adapters

Do not add a native provider or harness adapter merely because a provider exists. Add it only if Pi cannot supply a required capability or the new path materially improves correctness, lifecycle control, observability, isolation, or maintenance. Record that evidence in a decision postmortem.

## Stage 3: Bounded local automation and policy

### Outcome

Allow unattended local workflows without turning AgentKnot into an unbounded remote execution service.

### Candidate work

- authenticated local API access and explicit authorization scopes;
- signed, idempotent callbacks with URL policy and bounded retries;
- Server-Sent Events or another resumable live-event delivery path backed by persisted sequence numbers;
- admission limits, concurrency, backpressure, and a restart-aware local queue;
- explicit retry/fallback policies with recorded reasons and budgets;
- human approval gates for artifact promotion and sensitive operations;
- per-route path, command, network, time, token/cost, and credential policies;
- a pluggable OS-sandbox backend with accurate guarantees;
- CI/webhook/scheduled triggers that submit ordinary jobs rather than bypassing the Job API.

### Exit gates

- Authentication and callback threat models are documented and adversarially tested.
- Queue admission, leases/recovery, ordering, concurrency, and cancellation have deterministic semantics across restart.
- Live streams can resume from persisted sequence state and never become state authority.
- Every fallback or retry records the attempted route, reason, budget, and resulting evidence.
- An approval cannot be bypassed by controller identity or worker output.
- Any sandbox claim is backed by tests for filesystem, process, credential, and network boundaries it actually enforces.

General dependency graphs, nested/dynamic teams, and restartable multi-job scheduling are considered only after the queue and single-job contracts pass these gates. The Stage 1 bounded depth-one delegation slice does not imply those capabilities.

## Stage 4: Conditional remote and team operation

### Trigger conditions

This stage is not a commitment. It may begin only when real use demonstrates all of the following:

- local single-node limits are the primary obstacle;
- multiple users or machines need one job authority;
- the operational cost of authentication, tenancy, leases, remote secrets, and recovery is justified;
- an existing communication/fleet project cannot satisfy the need through an integration.

### Possible scope

- remote worker registration with honest capabilities;
- leases, heartbeats, bounded delivery, idempotency, and dead-letter behavior;
- authenticated tenancy and role policy;
- remote artifact transport and integrity verification;
- an optional Relay integration for communication or fleet delivery instead of rebuilding those layers;
- a read-only operations view derived from durable records.

### Exit gates

- The source of truth, failure domains, identity, delivery guarantees, and recovery behavior are unambiguous.
- Lost nodes, duplicate delivery, late completion, stale leases, and split-brain execution have tested outcomes.
- Remote secrets and artifacts have a reviewed transport and retention model.
- Local-only operation remains supported and simpler.

## Deferred unless the roadmap changes explicitly

- Relay-style channels, threads, DMs, reactions, feeds, presence, or social collaboration.
- A generic multi-agent swarm DSL.
- Automatic code acceptance, commit, merge, push, deployment, or pull-request creation.
- Automatic model/provider ranking or silent model/provider optimization; shadow evidence remains non-authoritative until separate measured scorecards and an explicit roadmap gate establish a safe selection rule.
- An AgentKnot-owned IDE or terminal emulator.
- A proprietary model/provider SDK layer that duplicates worker capabilities.
- Cloud hosting or a marketplace as a prerequisite for local use.

Moving an item out of this section requires a PRD change, a SPEC impact analysis, an objective stage gate, and a decision record explaining why the original boundary no longer serves the product.

## Per-change roadmap check

Before implementation starts, record in the issue, task, or plan:

- PRD problem/job-to-be-done;
- current roadmap stage and named exit gate;
- owning architectural boundary;
- current versus proposed capability status;
- deterministic verification and any real-worker soak;
- security and persistence consequences;
- documentation and postmortem updates required.

If a change cannot name a current-stage exit gate, it should normally wait.

# AgentKnot roadmap

- Status: Living execution plan
- Last updated: 2026-08-08
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
| 1 | Make the local single-job loop dependable and honestly specified | In progress |
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

Make current single-job semantics reliable enough that a controller can submit, observe, diagnose, verify, and explicitly promote a result without relying on optimistic wording or manual archaeology.

### Product-contract work

- Keep PRD, SPEC, ROADMAP, README, and postmortems linked and current.
- Add a capability/status table that distinguishes current, experimental, proposed, and deferred behavior.
- Version persisted job records before incompatible schema evolution begins.
- Validate controller metadata as JSON values so CLI/HTTP/TypeScript and file storage preserve one contract.
- Define a structured completion summary: changed files, checks run, remaining risks, and worker-reported notes, without treating worker assertions as verified facts.

### Lifecycle and persistence work

- Make live event-listener failure advisory so observer failure cannot accidentally retry or fail worker execution.
- Define and test persistence-failure behavior at admission, event append, terminal transition, artifact recording, and callback bookkeeping.
- On startup, detect stale nonterminal records and deterministically mark or reconcile them; resumable execution is not required in this stage.
- Define the supported single-process concurrency model and reject unsupported multi-process writers clearly.
- Bound event, raw worker data, stderr, result, callback payload, and record growth.
- Add an explicit retention and redaction policy, including the limits of redacting prompts, patches, and model output.

### Worker reliability work

- Add malformed JSONL, split UTF-8/frame, premature-exit, missing-settlement, timeout, and cancellation fixtures for Pi RPC.
- Specify the requirement for adapters to settle after abort and supervise their child processes.
- Ensure `doctor` evaluates the same effective environment and route inputs that `run` uses.
- Distinguish HTTP liveness from route readiness in naming and documentation.

### Artifact handoff work

- Add commands/API for artifact listing, checksum verification, base-commit verification, and patch preview.
- Define an explicitly invoked promotion operation only if it can refuse a dirty or mismatched target safely and always requires controller/human intent.
- Never turn successful worker completion into automatic patch application, commit, merge, or push.

### Exit gates

- Every README capability is implemented and tested or visibly marked proposed/deferred.
- Crash/restart behavior for every nonterminal state is deterministic and tested.
- Observer and callback failures cannot change a correct execution result.
- A supported adapter cannot leave a timed-out or cancelled job indefinitely active.
- Record and event sizes remain within documented limits under stress fixtures.
- Every artifact is checksum-valid and applies against its recorded base in the supported Git matrix.
- No source mutation, child-process leak, managed-worktree leak, duplicate/gapped event sequence, or cross-attempt state leak appears in the soak suite.
- A controller can inspect and deliberately accept or reject an artifact using a documented workflow.

### Explicitly not in Stage 1

- dynamic provider fallback;
- dependency graphs or agent swarms;
- remote workers or cloud fleets;
- channels, chat, reactions, or presence;
- a dashboard;
- an operating-system sandbox claim.

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

Dependency graphs and multi-job orchestration are considered only after the queue and single-job contracts pass these gates.

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
- Silent model/provider optimization that makes execution evidence ambiguous.
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

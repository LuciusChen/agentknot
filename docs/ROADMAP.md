# AgentKnot roadmap

- Status: Living execution plan
- Last updated: 2026-08-15
- Planning model: evidence-gated stages, not date promises
- Current default focus: Stage 2 contract completion; Stage 3 foundation is delivered but its next slices are queued

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
| 1 | Make local execution and its bounded delegation slice dependable and honestly specified | Complete |
| 2 | Prove controller and worker portability through contracts | Current default focus |
| 3 | Make the local middleware kernel durable and recoverable | Foundation delivered; next slices queued |
| 4 | Evaluate remote/team operation only from demonstrated demand | Conditional |

## Current command-driven domain evolution

This sequence is a narrow domain evolution layered above the historical execution stages below; it does not rewrite or delete their delivered evidence, roadmap gates, postmortems, or Job/Orchestration semantics.

```text
WorkOrder -> Executor Job -> Candidate -> Review -> Disposition
```

- [x] Add durable schemaVersion 1 WorkOrder issue/read/list/event persistence with one immutable command and only the `issued` status.
- [x] Add explicit CAS binding from an issued WorkOrder to one executor Job identity that the caller/controller already admitted. Same-Job replay is idempotent; a different Job or stale first-bind revision conflicts. Binding neither launches nor controls the Job, and Job success is not WorkOrder acceptance.
- [x] Add a minimal WorkOrder-rooted developer CLI that composes issue, ordinary Job admission, explicit binding, terminal observation, artifact verification, and restart-safe reporting without adding another workflow record or changing existing statuses. Default completion reports are human-readable and hide internal IDs/artifact identity; explicit JSON mode retains complete machine evidence.
- [x] Add the minimal immutable, status-free `CandidateRecord` artifact-evidence record linked to one WorkOrder and its bound Executor Job by exact recorded `git-patch` identity (`path`, `sha256`, `baseCommit`), without changing WorkOrder or Job status. Explicit TypeScript creation validates read-only WorkOrder/Job projections, then atomically writes the Candidate snapshot and `candidate.created` event through the existing durable SQLite/event infrastructure; the validation reads and Candidate persistence are separate stores and not one cross-store transaction.
- [x] Add one explicit WorkOrder-rooted Candidate CLI composition. `task-candidate WORK_ORDER_ID` selects the successful bound Job's terminal-attempt artifact, requires current exact integrity verification before the first write, persists through the existing Candidate service/store, and reloads matching evidence after restart with human-default or complete JSON presentation. It adds no Job launch, Review, Disposition, acceptance, or promotion; sequential reuse is not a concurrent exactly-once guarantee.
- [x] Add the minimal immutable, schemaVersion 1, status-free `ReviewRecord` linked only to one existing CandidateRecord. Explicit TypeScript `ReviewService.create` validates Candidate existence read-only, then atomically writes one Review snapshot and `review.created` event through `SqliteReviewStore` in a separate store; bounded reviewer identity, summary, and low/medium/high findings are defensively copied, multiple reviews per Candidate are allowed, and no verdict or source-record transition is added. Existing orchestration advisory-review evidence remains a separate contract and is never converted.
- [x] Add explicit Disposition after review. Acceptance and discard remain distinct from Job technical success: `DispositionRecord` is an immutable, status-free, TypeScript-only final controller decision linked to one existing Candidate and one belonging Review, with deterministic one-per-Candidate identity, atomic event persistence, exact replay, and explicit conflict semantics; `accept` never applies or promotes the artifact.

The minimal CandidateRecord, ReviewRecord, and DispositionRecord slices remain separate explicit domain APIs. Candidate alone has the narrow WorkOrder-rooted `task-candidate` CLI composition; Review and Disposition have no CLI/HTTP workflow, and no reviewer launching, automatic review or disposition, artifact application, promotion, or Job/WorkOrder/Orchestration status transition is added. Candidate/Job/WorkOrder validation and Candidate persistence remain separate stores, Candidate validation and Review persistence remain separate stores, and Candidate/Review validation and Disposition persistence remain separate stores; no cross-store recovery or reconciliation is added. The domain and focused CLI tests plus existing durable snapshot/event gate bound these slices. None authorizes automatic apply, commit, merge, push, or promotion.

The implemented ReviewRecord and DispositionRecord slices are narrow domain-contract completions alongside the delivered CandidateRecord slice; they do not advance the historical execution stages or alter their Job, Orchestration, worker, routing, isolation, cancellation, or recovery gates.

## Stage 0: Vendor-neutral execution slice

### Outcome

Prove that a controller-neutral job can be routed through a real worker/model path while AgentKnot owns lifecycle and protects the source workspace.

### Delivered

- CLI, HTTP, and TypeScript Job API entry points.
- Independent worker/provider/model route fields.
- Deterministic mock worker and real Pi RPC worker.
- OpenCode Go/Luna and OpenCode Go/DeepSeek V4 Flash route configuration through Pi.
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

**Status: complete (2026-08-09).** The full deterministic suite and the bounded host soak pass with no attributed process, managed-worktree, source, or temporary-file residue. Real AgentKnot → Pi → OpenCode Go → Luna/max dogfood supplied the promoted-route evidence; deterministic public-boundary fixtures cover failure paths that should not consume provider capacity.

### Outcome

Make leaf-job semantics and the bounded delegation slice reliable enough that a controller can submit, observe, diagnose, verify, and explicitly promote a result without relying on optimistic wording or manual archaeology.

### Product-contract work

- Keep PRD, SPEC, ROADMAP, README, and postmortems linked and current.
- [x] Add a capability/status table that distinguishes current, experimental, proposed, and deferred behavior.
- [x] Version persisted leaf Job and Orchestration records before incompatible schema evolution begins; new records use `schemaVersion: 1`, legacy file reads materialize missing versions without rewriting, and explicit unsupported versions fail.
- [x] Validate controller metadata recursively as JSON-compatible values so TypeScript/HTTP admission and file storage preserve one contract.
- [x] Add the initial optional vendor-neutral `delegation.dispatch.routeSelection` shadow slice: omission disables it, the initial mode was shadow-only, candidate routes validate at config load, ordered 1–20 rules use first-match/default evidence, and child metadata exposes the evidence without changing the actual default route ([decision 0016](../postmortems/0016-shadow-route-selection.md)).
- [x] Add the explicitly requested human-authored `active` mode without a ranking engine: it reuses the bounded ordered rules, persists exact selected-route evidence, dispatches only the configured match or conservative default, and never falls back. Repository dogfood maps parent complexity `low` to DeepSeek Flash/max and leaves `medium`/`high`/default on Luna/max ([decision 0020](../postmortems/0020-human-authored-active-route-selection.md)).
- [x] Define a structured completion summary: changed files, checks run, remaining risks, and worker-reported notes, without treating worker assertions as verified facts. The additive summary, deterministic built-in-adapter emission slice, and real Pi/OpenCode Go/Luna/max dogfood evidence are complete.
  - [x] Add the additive schemaVersion 1 `JobRecord.completionSummary` with terminal outcome/attempt, terminal-attempt artifact provenance, and stable unavailable reasons; require valid completion envelopes from normal Pi Jobs so clean process exit or an empty valid artifact cannot stand in for task completion ([incident/decision 0044](../postmortems/0044-required-worker-completion-and-canonical-worktree-id.md)).
  - [x] Validate optional custom-adapter reports strictly and require valid reports from normal Pi Jobs, preserving custom absent/malformed and terminal unretained states without inferring from prose, events, stderr, session statistics, or empty artifacts.
  - [x] Append the exact provider/model-neutral report instruction only to normal Pi runs, parse only an end-anchored single-line suffix, and strip valid suffixes from output. Missing/malformed/unsupported/non-terminal envelopes receive one same-session protocol recovery; a second invalid settlement fails the current attempt non-retryably ([decision 0085](../postmortems/0085-in-session-completion-envelope-recovery.md)).
  - [x] Keep the repository Pi reviewer profile inside its permission boundary while requiring a valid completion envelope after the reviewer turn.
  - [x] Keep advisory-review JSON instructions compatible with the transport-owned completion suffix instead of asking the model to satisfy mutually exclusive output contracts.
  - [x] Require `taskOutcome: completed | blocked` so an explicit incomplete task cannot be marked successful merely because checks or artifact capture succeeded.
  - [x] Add and verify strict `WorkerCompletionReport` emission from the promoted Pi path with an actual Pi/OpenCode Go/Luna/max dogfood job.

### Lifecycle and persistence work

- [x] Make live event-listener failure advisory so observer failure cannot accidentally retry or fail worker execution.
- Define and test persistence-failure behavior at admission, event append, terminal transition, artifact recording, and callback bookkeeping.
  - [x] Keep callback-bookkeeping persistence outside the execution failure path: attempt delivery once, preserve the already-persisted terminal result, never redeliver, and reject completion with the store error when its delivery state cannot be saved ([incident 0019](../postmortems/0019-callback-bookkeeping-persistence-boundary.md)).
  - [x] Atomically admit `queued` with `job.queued`; classify event, artifact-recording, and terminal-transition save failures as control-plane persistence errors without worker retry, substitute terminal state, or callback delivery; remove unrecorded patches and retain the last good snapshot for restart reconciliation ([incident 0021](../postmortems/0021-job-persistence-failure-boundaries.md)).
  - [x] Atomically admit parent `queued` with `orchestration.queued`, roll back unsaved parent events, propagate child control-plane persistence failures without fabricating worker outcomes, and ensure cancellation persistence cannot block abort propagation.
- [x] On startup, after exclusive storage ownership is established, fail every prior nonterminal Job/Orchestration once without replay or PID-based takeover; resumable execution remains outside this stage.
- [x] Enforce the supported single-writer file runtime with non-blocking advisory locks on both canonical storage directories, clear second-owner refusal, read-only runtime capability checks, active-work close refusal, and crash-release/restart coverage; no lease, heartbeat, database, or dependency package is added ([decision 0022](../postmortems/0022-file-runtime-single-writer-ownership.md)).
- [x] Bound prompt/metadata admission, event payload/count, Pi stderr retention, result/report/error data, callback payload, and complete Job/Orchestration snapshot growth with fixed UTF-8 budgets and explicit evidence ([decision 0023](../postmortems/0023-fixed-durable-record-budgets.md)).
- [x] Bound new Git patch artifacts at 16 MiB and define the local retention/redaction boundary: indefinite retention until exact manual deletion, no automated purge/cascade, and no claim that prompts, patches, model output, or other arbitrary content are redacted ([decision 0025](../postmortems/0025-local-retention-and-redaction-boundary.md)).

### Bounded delegation slice admitted into Stage 1

The product requirement changed after Stage 0: controller-independent automatic delegation is part of the core handoff, not merely a later unattended scheduler. Stage 1 therefore admits one deliberately narrow parent/child slice while keeping general dependency graphs and queues deferred.

Delivered in this slice:

- one `OrchestrationRequest` contract shared by CLI, HTTP, and TypeScript;
- `off`, `suggest`, and `auto` global modes with bounded per-request overrides;
- a strict controller-authored assessment validated before orchestration admission, with no middleware planner Job or fallback model call;
- deterministic allow/keep policy, depth exactly one, product defaults of two children and two concurrent executions when limits are omitted, and the repository's evidence-backed six-task/six-slot dogfood setting after successful exact-route formal soaks at four, five, and six; the configuration ceiling and repository evidence do not claim universal route capacity, and direct, child, and reviewer Jobs now share that configured durable capacity boundary;
- a controller handoff contract that separates delegation from parallelism, permits one bounded substantive non-parallel child, reserves parallel plans for independently verifiable dependency-free subtasks with non-overlapping expected write scopes, and uses a sliding dispatcher that refills bounded worker slots from the persisted task pool;
- immutable effective policy, plan hash, exact prompts/routes, parent-child IDs, and persist-before-dispatch events;
- optional human-authored route selection keyed by eligible subtask kind and parent assessment complexity, with `shadow` and `active` modes, 1–20 ordered validated rules, first-match/default outcomes, plan-hash coverage, and structured child metadata; shadow leaves `PlannedSubtask.route` and the ordinary child `Job.route` on `dispatch.defaultRoute`, while active dispatches the exact configured selection; rules use non-empty unique task-kind and/or `low`/`medium`/`high` complexity predicates, with both predicates conjunctive and predicate-free rules explicit catch-alls;
- child execution only through the ordinary isolated Job API;
- cancellation propagation and fail-without-resume restart reconciliation;
- AgentKnot self-use through the real Pi/Luna route as a required promotion check for this slice.

Shadow remains evidence-only. Active selection changes only the pre-dispatch route according to validated human configuration; it does not add fallback, mid-attempt switching, ranking, controller-owned route names, or automatic artifact application. The repository keeps Luna/max as the conservative default and uses DeepSeek Flash/max only for configured low-complexity work.

Still outside this slice:

- recursive delegation, dynamic replanning, dependencies between children, or model-chosen route changes;
- automatic/learned model-provider ranking, silent optimization, fallback, or mid-attempt route switching; the human-authored active rule is not ranking evidence, and repeated comparable trials remain required before any optimizer proposal;
- restart resume, a durable capacity queue, leases, multi-process writers, or distributed concurrency;
- automatic patch selection, application, commit, push, merge, deployment, or pull-request creation;
- middleware semantic interception of native controller conversations. Controllers or controller Skills must author the assessment and call the orchestration API.

### Worker reliability work

Delivered in this slice:

- Deterministic malformed JSONL, split UTF-8/frame, premature-exit, missing-settlement, timeout, and cancellation fixtures exercise the real Pi adapter and public Orchestrator boundary.
- The Pi adapter settles after abort with bounded exact-child `SIGTERM` → `SIGKILL` supervision and bounded owned-stream draining; it does not perform broad process cleanup.
- Pi configuration-only doctor and spawned execution now share one effective worker environment for command discovery, required names, and auth-directory/home lookup, with deterministic precedence and secret-non-disclosure coverage.
- Pi normal runs and live probes disable all ambient resource discovery while preserving explicit reviewed resources and repository context; successful normal jobs capture sanitized advisory session statistics for empirical worker-profile comparisons, and normal Pi runs require deterministic, strictly validated completion-report emission while live probes remain unchanged.
- The bounded normal-run Pi record-volume slice omits only the four known lifecycle envelopes (`turn_start`, `turn_end`, `message_start`, `message_end`) from `worker.raw`, counts every received frame in `metadata.rawEventCount`, and preserves unknown event types as `worker.raw`; normalized text/tool/retry events, final output, completion reports, live-probe behavior, route/provider/model/thinking configuration, and global event types remain unchanged.
- The original Pi-envelope slice made no Pi-token-saving claim and added no general truncation, schema migration, plugin installation, configuration/probe changes, or global event-type changes. Decision 0023 subsequently added controller-neutral fixed record budgets and `job.worker.events.truncated`; decision 0025 independently fixed patch artifacts at 16 MiB and documented indefinite local retention with no automatic content-redaction claim.
- Canonical `GET /health/live` and its explicit not-checked payload distinguish HTTP process liveness from route readiness; legacy `GET /health` remains an identical compatibility alias, and readiness inference stays opt-in through CLI diagnostics.

Next evidence gate:

- The first isolated candidate, `pi-readseek@0.9.10`, passed source review, live loading, artifact verification, and target tests but was rejected after one same-task Luna/max pair materially regressed token use, elapsed time, tool calls, and persisted record size; see [experiment 0013](../postmortems/0013-pi-readseek-profile-ab.md).
- The narrower `pi-lean-ctx@3.9.18` profile passed source and supply-chain review and produced selected passing artifacts in two same-task Luna/max pairs. Its 39.0% token reduction on a larger implementation reversed into 36.2% more tokens and 45.7% more elapsed time on an independent smaller test task, so it did not clear the repeatability gate; see [experiment 0014](../postmortems/0014-pi-lean-ctx-profile-ab.md).
- [x] Apply the profile promotion gate: neither reviewed candidate is a general dogfood profile, the repository and global Pi state remain unpolluted, and the minimal route remains formal.
- Reopen profile work only with a new bounded hypothesis and a reliable selection rule that can avoid workloads where the profile regresses; keep task-dependent automatic selection deferred until that rule has evidence.
- The DeepSeek V4 Flash/max route passed live probes and one same-task test-only A/B. It used 38.4% fewer Pi tokens and lower provider-reported cost than Luna/max, but took 23.5% longer and produced a larger patch; Luna's smaller patch was selected. It is now used only by the explicit human-authored `low` dogfood rule, without claiming a measured ranking; medium/high/default work remains Luna/max ([experiment 0017](../postmortems/0017-deepseek-flash-route-ab.md), [decision 0020](../postmortems/0020-human-authored-active-route-selection.md)).

### Runtime reconciliation correctness

Delivered:

- Read-oriented CLI construction skips startup reconciliation, while `run`, `orchestrate`, and parameter-valid `serve` remain explicit execution owners; deterministic cross-process CLI tests prove reads and invalid commands leave persisted bytes unchanged.
- Execution-owning file runtimes lock both canonical storage directories before reconciliation/admission, reject same-process and cross-process second owners, release after one-shot completion or process crash, and make `reconcileOnStartup: false` a read-only runtime capability. Once ownership is acquired, prior nonterminal records are interrupted without trusting PID visibility or reuse.
- Parameterized restart coverage exercises `queued`/`running` Jobs and `queued`/`planning`/`dispatching` orchestrations, retains prior cancellation intent as evidence, makes restart interruption terminal without replay, and proves a second recovery is byte-stable.
- Catchable CLI termination and HTTP close cancel and await admitted work before ownership release. Per-attempt event sinks stop accepting data when the attempt settles, failed snapshot/artifact writes remove their exact temporary files, and timeout capture leaves source/worktree state clean.
- Relative managed-worktree configuration now resolves to a stable private platform-temporary namespace rather than below the runtime/config repository. A real external-repository review had inherited AgentKnot's ancestor `package.json`, run AgentKnot's own validation command, and rebuilt the live broker's `dist`; deterministic coverage proves external targets no longer nest below that host project ([incident/decision 0079](../postmortems/0079-external-worktree-ancestor-isolation.md)).
- The POSIX `test:stage1-soak` runner bounds the signal/Pi/restart/worktree matrix to 60 seconds, attributes it to one unique process group, and fails after exact-group cleanup if descendants remain. The interrupted-tool path was reproduced, the exact residue was contained, and the final host run passed 47/47 with no matching process or worktree residue ([incident 0024](../postmortems/0024-stale-dogfood-test-processes.md)).

An uncatchable hard kill or host loss can still leave arbitrary descendants or a managed worktree. Startup reconciliation repairs persisted nonterminal state but does not claim universal ownership or cleanup of those external resources.

### Route-diagnostics slice admitted into Stage 1

Stage 1 keeps route diagnostics fast by default while adding one explicit live-inference path for the observed false-ready failure mode.

- Configuration-only `doctor` checks configuration, credentials, and runtime availability and explicitly says that live inference was not checked.
- Opt-in `doctor --live --route NAME` performs one bounded real inference through the exact selected worker, provider, model, and thinking level; current real promotion evidence covers the repository Luna/max route.
- The control plane uses a 30-second timeout, reports provider errors with failure status, and reports adapters without probe support as unsupported rather than ready.
- The probe never falls back or selects another route, creates no Job or artifact records, and does not add a probe before normal job or orchestration execution.

### Artifact handoff work

Delivered in this slice:

- TypeScript, CLI, and HTTP contracts for artifact listing, size/SHA-256 verification, current-source base-commit verification, and integrity-gated bounded patch preview.
- Git-derived repository-relative `changedFiles` arrays on newly captured worktree artifacts, including `[]` for empty patches, with removal-safe intent-to-add and NUL-delimited path handling for tracked modifications and deletions, untracked, binary, committed, retry, and unusual-filename changes ([incident 0060](../postmortems/0060-artifact-capture-omitted-deletions.md)).
- Deterministic tests for valid, missing, tampered, and base-mismatched evidence that prove inspection does not mutate the source repository; changed-file evidence remains controller-captured artifact data and is now carried into the terminal summary only with artifact identity, never as semantic verification.
- A fixed 16 MiB capture/inspection ceiling that fails oversized patch capture without retry or partial artifact retention and prevents verify/preview from reading oversized managed files.
- Supported dirty-source admission through a temporary Git snapshot: staged, unstaged, and non-ignored untracked content within the existing 16 MiB patch budget reaches every retry without changing the source index bytes/worktree/object database; artifacts and terminal artifact summaries carry the exact source tree, contain only worker deltas, and fail verification/validation on later source drift. Dirty submodule contents remain an explicit refusal ([decision 0049](../postmortems/0049-dirty-workspace-snapshot-isolation.md)).
- Additive delegated-parent `artifactReview` evidence that compares only controller-captured terminal paths, deterministically groups exact overlaps across children as potential integration conflicts, and marks missing evidence incomplete ([decision 0026](../postmortems/0026-child-artifact-path-overlap-review.md)).
- A documented upstream workflow that separates read-only inspection and path review, deliberate controller/human accept or reject, and any later explicit promotion; none of these review steps applies, commits, merges, or pushes a patch.

Still outside this slice:

- Define an explicitly invoked promotion operation only if it can refuse a dirty or mismatched target safely and always requires controller/human intent.
- Never turn successful worker completion into automatic patch application, commit, merge, or push.

### Exit gates

- [x] Every README capability is implemented and tested or visibly marked proposed/deferred.
- [x] Crash/restart behavior for every nonterminal state is deterministic and tested.
- [x] Every orchestration persists a valid plan before dispatch, never exceeds its child/depth/concurrency bounds, and leaves artifact integration upstream.
- [x] Route-selection omission, strict invalid configuration, first-match/default behavior, plan-hash coverage, shadow default-route authority, exact active-route dispatch, and public child metadata are covered at the configuration and orchestration boundaries.
- [x] Every newly terminal Job has an additive completion summary before terminal observation, and the strict Pi report path has deterministic coverage plus real Pi/OpenCode Go/Luna/max emission evidence.
- [x] Observer and callback failures cannot change a correct execution result.
- [x] A supported adapter cannot leave a timed-out or cancelled job indefinitely active.
- [x] A read-only CLI or API inspection cannot reconcile or mutate an active Job or Orchestration record.
- [x] Configuration-only doctor output distinguishes runtime readiness from live inference; the opt-in probe is exact-route, bounded, honest about provider errors and unsupported adapters, and leaves no Job or artifact evidence.
- [x] Record and event sizes remain within documented limits under stress fixtures.
- [x] Every artifact is checksum-valid and applies against its recorded base in the supported Git matrix.
- [x] No source mutation, child-process leak, managed-worktree leak, duplicate/gapped event sequence, or cross-attempt state leak appears in the bounded soak suite.
- [x] A controller can inspect and deliberately accept or reject an artifact using a documented workflow; inspection is read-only, while promotion remains an explicit upstream action.

### Explicitly not in Stage 1

- dynamic provider fallback;
- dependency graphs or agent swarms;
- remote workers or cloud fleets;
- channels, chat, reactions, or presence;
- a dashboard;
- an operating-system sandbox claim;
- automatic or learned model/provider ranking and silent optimization, which remain deferred; the current active mode executes only human-authored deterministic rules.

## Stage 2: Portable controller and worker contracts

**Status: current default focus (2026-08-12).** Experimental Codex and Claude packages expose the same controller-authored handoff contract and identical stateless `SessionStart` hooks for `startup`, `resume`, `clear`, and `compact`; deterministic checks cover their manifests, Skills, MCP entry, bounded hook behavior, and absence of `UserPromptSubmit`. One fresh Codex session selected the Skill without an AgentKnot prompt, admitted a strict assessment through the existing broker, and completed one Luna/max child with a required report and verified empty artifact; real Claude parity remains open, and one successful shape is not a universal invocation guarantee ([decision 0074](../postmortems/0074-session-start-controller-entry.md)). The generic worker boundary remains controller/provider neutral. The native secondary CLI adapter was retired; Pi RPC is the sole built-in real worker implementation while a future second adapter remains subject to a fresh evidence gate ([decision 0059](../postmortems/0059-retire-native-opencode-worker.md)).

### Outcome

Prove that controllers can change independently and keep worker runtimes replaceable without core branches or misleading capability claims.

### Planned work

- Define one controller-integration contract that normalizes controller-native task entry into the existing `OrchestrationRequest` or `JobRequest`; controller commands and native Skills/plugins are adapters at this boundary, not new orchestration policy or controller-name branches in core.
- Ship thin, installable Codex and Claude integrations rather than documentation-only examples. Each integration must provide a deterministic explicit task/delegation entry and, where the controller supports it, the shared bounded `SessionStart` obligation for `startup`, `resume`, `clear`, and `compact` without a `UserPromptSubmit` hook or hidden per-prompt injection.
- Treat `/goal` as one controller UX entry, not the protocol. Goal, task, delegate, controller-native skill/plugin invocation, and existing CLI/HTTP/TypeScript callers must converge on the same persisted request, limits, route policy, terminal record, and artifact-review workflow.
- Keep trigger scope honest: informational conversation and product decisions remain upstream. Each controller package has one identical stateless `SessionStart` hook for `startup`, `resume`, `clear`, and `compact` that reads only bounded event JSON and injects one concise controller obligation; it performs no filesystem, Git, network, broker, policy, runtime, prompt, transcript, or session-state work, and no `UserPromptSubmit` hook exists. The obligation is deterministic session context, not semantic eligibility or guaranteed Skill invocation. Controller-native Skills may trigger eligible delegation, but packages resolve no workspace/policy/service state, forward no raw prompt through a pre-model adapter, own no semantic classification/planning, start no runtime/orchestration implicitly, wait for no worker in a hook, choose no route/model, and promote no artifact. The controller authors the strict assessment and workspace in its normal model turn ([decisions 0063](../postmortems/0063-remove-per-prompt-controller-obligations.md) and [0074](../postmortems/0074-session-start-controller-entry.md)).
- [x] Remove the pre-model middleware planner and cut over every TypeScript/HTTP/CLI orchestration submission to a required controller-authored `TaskAssessment`. Persist accepted-handoff evidence, retain deterministic policy/routing/scheduling, expose Codex implicit Skill-selection metadata without treating it as an invocation guarantee, and delete synchronous raw-prompt orchestration, blocking failures, progress forwarding, terminal parsing, preview reinjection, planner configuration, and planner Job state. Historical schemaVersion 1 planning snapshots remain readable only ([decision 0053](../postmortems/0053-controller-owned-planning-handoff.md) and [0074](../postmortems/0074-session-start-controller-entry.md)).
- Keep integration context bounded so the upstream controller can hand off eligible implementation, test, analysis, and documentation work without first reproducing the worker's repository-reading and implementation effort.
- [x] Add one optional controller-authored shared navigation context to `TaskAssessment`: summary, repository-relative initial paths, and hard constraints already present in the controller conversation, capped at 2 KiB and projected as one identical prefix before every child delta. Include it in admission and the plan hash, but add no transcript capture, repository scan, fixed worker session, memory service, provider/model branch, or cache correctness dependency ([incident/decision 0068](../postmortems/0068-bounded-shared-task-context.md)).
- [x] Evolve that same schemaVersion 1 context into a controller-neutral `ContextManifest` with optional bounded `ContextReference` metadata. Preserve old requests, require actual source and explicit unverified trust, allow optional revision/digest/summary, reject duplicates and aggregate oversize, and cover deterministic prompt projection plus MCP admission without resolving locators in that initial slice ([decision 0077](../postmortems/0077-task-context-reference-manifest.md)).
- [x] Add the first concrete read/authorization boundary for quality review: one durable exact AgentKnot Git-patch grant, same-workspace terminal-source and full identity/base revalidation per attempt, a single-use route-neutral reader, content-free durable audit evidence, and a Pi-only explicit tool mapping that requests bytes on invocation over attempt-owned child-process IPC and sanitizes events. Keep general `ContextReference` locators metadata-only; no semantic retrieval, vector store, transcript capture, fixed worker session, external memory dependency, arbitrary path, artifact-content temporary file, or network source is added. This establishes the capability but makes no token-savings claim until repeated A/B evidence exists ([decision 0078](../postmortems/0078-exact-artifact-read-grant.md)).
- [x] Run repeated same-task quality-review A/B trials comparing prompt-embedded patch evidence with the exact read grant. Three serial real Luna/max runs admitted 18 reviewer Jobs over two valid patches and one seeded defect. No run cleared the predefined 3/3 reliability/efficiency gate; five complete pairs produced only two read-grant token wins, and their descriptive aggregate used 8.7% more total tokens, 17.8% more input-plus-cache-read-plus-output, and 4.8% more latency. The experiment also exposed and fixed the route-neutral completion-role contradiction for `changes-requested` reviews. Retain the exact artifact grant for authority/auditability, make no efficiency claim, and do not add grant issuers for other `ContextReference` kinds ([experiment/incident 0080](../postmortems/0080-artifact-read-review-ab.md)).
- [x] Add the deliberately narrow selective-context step: only `kind: "workspace-file"` receives a strict portable repository-relative locator and may be read on demand with the worker's existing workspace tools; every other locator stays metadata-only. Three hidden-oracle pairs on each configured DeepSeek Flash/max and Luna/max route produced exact answers with one target read and no decoy reads. Provider-reported total tokens fell 30.13% and 32.66%, respectively, but neither route cleared the full gate because latency rose 26.47% and 53.07%; Luna's input-plus-cache-read-plus-output also rose 298.77%. Keep the capability explicit and experimental, generate no references automatically, and add no retrieval framework, memory/session service, new adapter tool, or general locator resolution ([experiment/decision 0081](../postmortems/0081-selective-workspace-context-ab.md)).
- [x] Test automatic candidate-reference handoff against one real AgentKnot repository owner task before promotion. The 28,487-token / 18.137-second `relevantPaths` arm beat both a generic-reference arm (+5.55% tokens, +22.70% latency) and a controller-known role-summary arm (+23.21%, +39.68%); ordinary tools still searched or read multiple candidates and exact JSON-only output failed in every arm. Remove the uncommitted default-contract draft, keep references explicit, and compact the shared Skill plus `SessionStart` obligation. A controlled fresh Codex Skill-load pair measured 164 fewer input tokens. Reject the attempted delegated pair as invalid because one arm introduced a task-specific tool-count limit and the assessment/wait/verification paths diverged; rerun only with context-bounded arms and no execution-count field ([experiments/decisions 0082](../postmortems/0082-real-repository-selective-context-gate.md) and [0083](../postmortems/0083-remove-tool-count-task-boundaries.md)).
- [x] Remove contradictory generic check guidance and run six post-correction real scope trials across prompt construction, broker lifecycle, retry analysis, workspace isolation, HTTP cursor following, and usage reporting. Two Luna/max runs used 6 and 8 tool calls; four DeepSeek Flash/max runs used 3, 5, 3, and 2. Every run completed on attempt one without forbidden commands or path expansion. Preserve this as behavioral evidence only: the pre-correction Luna run accidentally expanded a targeted npm command to 259 tests, and prompt constraints remain distinct from tool enforcement ([experiment 0069](../postmortems/0069-repeated-shared-context-scope-trials.md)).
- [x] Make a valid `taskOutcome: blocked` report one route-neutral terminal failure. Adapters return the report through `WorkerRunResult`; the orchestrator validates it, records `failed`, `retryable: false`, retains the report and artifact evidence, and never emits `job.retrying`. The later built-in Pi completion-recovery policy changes only missing/invalid suffix handling after successful settlement; blocked semantics and failures before first settlement remain unchanged. No model-specific handling or second completion schema is added ([incident/decision 0069](../postmortems/0069-repeated-shared-context-scope-trials.md)).
- [x] Separate downstream request retry from whole-worker Job replay. A live worker retains its context while applying its own downstream policy; after it settles failed, `WorkerSettledError` terminates that Job without starting a fresh session. Pre-settlement process/protocol/transport failures still consume configured AgentKnot attempts. Compact activity exposes only route-neutral downstream retry progress, with no provider parsing, quota inference, or route fallback ([incident/decision 0084](../postmortems/0084-worker-settled-retry-ownership.md)).
- [x] Pace structured pre-settlement worker failures before consuming the next reserved whole-Job attempt. Persist one route-neutral reason and bounded delay in `job.retrying`, use deterministic per-Job exponential jitter, honor only adapter-supplied structured retry delay hints within a fixed ceiling, and let cancellation interrupt the wait. Keep settled-session failure terminal, the exact route immutable, and provider-string parsing, quota inference, fallback, recovery redesign, and a second retry state machine out of core ([incident/decision 0087](../postmortems/0087-pre-settlement-worker-retry-backoff.md)).
- [x] Bound normal-run Pi text tool results before they become the next model input. Load one product-owned attempt-local extension after configured extensions, cap aggregate text at 8 KiB with explicit UTF-8-safe evidence, keep Bash tail/read-search head semantics, and exempt exact artifact reads. The same-task Luna/max probe improved tokens/cost but regressed latency; retain the deterministic safety boundary without claiming universal efficiency, adding a tool-count limit, parsing shell commands, or changing Job lifecycle ([incident/decision 0088](../postmortems/0088-bound-pi-tool-result-context.md)).
- [x] Recover one missing or invalid Pi completion envelope without replaying completed task work. After the first normal turn settles successfully, issue one protocol-only idle-session `prompt`, expose bounded `completion-envelope` progress, and accept a valid suffix on the same PID and Job attempt. A second invalid settlement fails non-retryably; assistant errors and failures before the first settlement retain their owning semantics. Deterministic recovery, exhaustion, privacy, and pre-settlement retry tests pass. One forced real DeepSeek Flash/max validation succeeded at attempt one with two user/assistant turns, zero tools, and 9,415 session tokens; without a comparable replay baseline it establishes behavior, not token savings ([incident/decision 0085](../postmortems/0085-in-session-completion-envelope-recovery.md)).
- [x] Preserve context-dependent continuation without transcript parsing. The upstream controller already holding the conversation reconstructs one bounded self-contained task and assessment before eligible repository execution; the stateless `SessionStart` hook retains no workspace focus or session state. Paths remain workspace evidence only and normal keep-upstream policy is re-applied ([decisions 0050](../postmortems/0050-context-dependent-continuation-handoff.md), [0053](../postmortems/0053-controller-owned-planning-handoff.md), and [0074](../postmortems/0074-session-start-controller-entry.md)).
- [x] Delegate bounded evidence-producing repository analysis even when read-only and low-complexity. Keep the free-form `repository-analysis` allowlist value in the controller-assessment/worker contract; preserve direct single-fact lookups upstream, existing exclusions, human-authored route policy, and all artifact authority. Add no prompt classifier, controller branch, route fallback, ranking, or repair loop ([incident/decisions 0051](../postmortems/0051-evidence-producing-repository-analysis.md) and [0053](../postmortems/0053-controller-owned-planning-handoff.md)).
- [x] Bound delegated repository analysis after real workers expanded narrow comparisons into long inventories. Treat the admitted workspace as the one authoritative writable target, keep every other repository read-only, and require explicit references, exact scope, non-goals, at most five decision-relevant findings and 4,000 characters, concise evidence, and no source restatement. A later route/task tool-count circuit incorrectly duplicated that semantic boundary and made normal work depend on fixed counts; remove it from assessment, Job, CLI/HTTP/MCP, route configuration, prompts, and execution. Retain timeout/cancellation/size/isolation/completion boundaries and reject new legacy count fields before admission ([incident/decisions 0052](../postmortems/0052-bounded-analysis-and-observable-waiting.md), [0067](../postmortems/0067-route-tool-execution-budget.md), and [0083](../postmortems/0083-remove-tool-count-task-boundaries.md)).
- [x] Preserve sparse-checkout semantics at the artifact boundary and enforce the existing read-only analysis contract at settlement. Copy only Git's `skip-worktree` state into the temporary capture index so omitted tracked paths do not become false deletions, without expanding or fetching the checkout. If a delegated `repository-analysis` produces changed paths, retain the artifact but fail once without retry. Keep integrity verification independent from completion and semantic compliance ([incident 0070](../postmortems/0070-sparse-worktree-artifact-boundary.md)).
- Historical pre-cutover deployment repeated the earlier task with the same Pi/Luna/max child route. Worker duration fell 44.2%, tool calls 46.7%, reported total tokens 73.8%, and retained result characters 84.0%; total orchestration improved only 24.1%. This is worker-boundary evidence and not evidence for the current controller-owned handoff ([evidence 0052](../postmortems/0052-bounded-analysis-and-observable-waiting.md)).
- [x] Make bounded deliverable-producing work delegation-first even when the edit is small: the controller authors that recommendation and AgentKnot still enforces all configured exclusions and artifact review. Historical same-task automatic Codex evidence remains capacity-shift evidence only; do not add a middleware semantic classifier, route fallback, or learned ranking ([decisions 0035](../postmortems/0035-delegation-first-small-repository-deliverables.md) and [0053](../postmortems/0053-controller-owned-planning-handoff.md)).
- [x] Add one opt-in, advisory quality-review slice for simple delegated edits: after exactly one successful child produces one integrity-valid, non-empty, non-truncated patch, a human-configured reviewer route may run once in a fresh depth-one Job and return a strict `accept | changes-requested | uncertain` verdict with bounded findings. The reviewer receives the parent goal, acceptance criteria, AgentKnot-verified patch evidence, and explicitly labeled worker test claims; it cannot edit, repair, recurse, converse, promote, commit, push, or override the upstream controller. Omission disables the feature; ineligibility and review failure remain explicit rather than silently accepted. Controller identity, worker adapter, provider, model, and effort remain route/configuration data; the current DeepSeek Flash/max worker → Luna/max reviewer pairing is dogfood evidence only, not a core rule or fixed ranking. Record reviewer findings, upstream modifications/rejections, final checks, tokens, and elapsed time on real tasks with completion quality ahead of savings. Do not add Relay-style general messaging, automatic model ranking, a repair loop, multi-artifact semantic integration, or a second worker-adapter abstraction for this slice ([decision/experiment 0036](../postmortems/0036-bounded-advisory-quality-review.md)).
- [x] Add one opt-in controller-owned artifact-validation slice for a single delegated patch: re-verify the exact bounded artifact and admitted source base, apply it only in a fresh disposable worktree, execute one trusted shell-free configured argument vector, persist bounded command and cleanup evidence, and overlap it with optional model review. Omission disables the path; command failure stays advisory and cannot promote the patch or rewrite child/parent success. Keep generic command policy, multiple validation steps, repair, automatic integration, and sandbox claims outside this slice ([decisions 0037](../postmortems/0037-controller-owned-artifact-validation.md) and [0049](../postmortems/0049-dirty-workspace-snapshot-isolation.md)).
- [x] Route concurrent Codex/Claude/CLI controller sessions through one explicitly selected local HTTP execution owner. Add a thin CLI client mode for the existing orchestration/handoff/artifact workflow, let both controller clients select it without repository scanning or local config discovery, refuse server failure without local/model fallback, and prove two separate client processes share one runtime. Do not add another broker, queue, protocol, daemon manager, or remote-service claim ([incident/decision 0038](../postmortems/0038-shared-local-controller-runtime.md)).
- [x] Replace duplicated Job/Orchestration 100 ms full-record polling with a controller- and transport-neutral durable cursor subscription. Notify only after commit, close the read/register race, replay after sequence across reconnect/broker replacement, retain durable refresh as the independent-process fallback, and make HTTP/CLI/MCP consume event batches plus five-second compact heartbeats. Before release, remove the unused `/wait` aliases and share reconnect/terminal mechanics. Do not add transcript parsing, automatic resubmission, agent messaging, a second queue, or controller-specific core branches ([incident/decisions 0052](../postmortems/0052-bounded-analysis-and-observable-waiting.md), [0062](../postmortems/0062-durable-event-subscription.md), and [0065](../postmortems/0065-retire-http-wait-aliases.md)).
- [x] Collapse repeated five-second MCP follow/model turns into one bounded `agentknot_orchestration_wait` request over the existing durable cursor. On deadline return the same ID and acknowledged sequence for idempotent reattachment; on cancellation abort only the transport wait; never resubmit work or move planning/session ownership into middleware. Emit optional standard MCP progress only when requested by the controller, and retain one-batch follow for diagnostics ([incident/decision 0075](../postmortems/0075-bounded-mcp-wait-and-resume-gate.md)).
- [ ] Add detached terminal notification only after a controller adapter demonstrates a supported idempotent resume entry. Core may expose durable terminal evidence; controller-specific resume remains in adapters, and unsupported controllers retain the synchronous wait path. Do not infer resume from transcripts or add general agent messaging.
- [x] Supersede hook-owned discovery/session state and native-service installation with one independent broker and common clients. `broker run|up|status|down` provides foreground or explicit cross-platform application lifecycle with exact instance/PID checks and no system configuration; `agentknot mcp` is a restart-tolerant pure broker client. Controller packages now use native Skills plus one narrow stateless `SessionStart` obligation and no `UserPromptSubmit` hook; the package hook does not own broker or session state ([decisions 0057](../postmortems/0057-independent-broker-and-thin-controller-clients.md), [0063](../postmortems/0063-remove-per-prompt-controller-obligations.md), and [0074](../postmortems/0074-session-start-controller-entry.md)).
- [x] Remove clean-worktree admission as an automatic-controller usability blocker without weakening isolation: snapshot supported dirty top-level state once per Job, reuse it across attempts, return only worker deltas, and refuse later tree drift or unrepresentable dirty submodules. Reuse the workspace manager and worktree backend; add no second scheduler, promotion path, controller branch, or provider/model fallback ([decision 0049](../postmortems/0049-dirty-workspace-snapshot-isolation.md)).
- During each integration slice, identify and delete superseded examples, prompt reminders, compatibility shims, duplicate request builders, and dead controller-specific branches after parity is proven; do not retain a second legacy path indefinitely.
- Introduce an implemented-capabilities schema only after at least two real workers need meaningfully different lifecycle behavior.
- [ ] Promote a second real worker adapter without changing core Job semantics. Pi RPC remains the sole built-in real adapter; any future runtime must pass the shared conformance, lifecycle, artifact, and cleanup gates before it becomes supported ([decision 0059](../postmortems/0059-retire-native-opencode-worker.md)).
- [x] Add one route pool above complete routes. The initial process-local `least-active` implementation includes explicit member Jobs, rotates equal-load ties, snapshots the exact member, and never switches during retry; production SQLite selection is now superseded by atomic durable lease accounting in Stage 3. Child and quality-review targets use the same Job boundary, with every reviewer candidate limited to one attempt; pool membership remains configuration and does not require a particular worker runtime ([decisions 0042](../postmortems/0042-complete-route-pool-balancing.md), [0047](../postmortems/0047-resumable-controller-binding-and-replaceable-role-pools.md), [0053](../postmortems/0053-controller-owned-planning-handoff.md), and [0061](../postmortems/0061-atomic-durable-route-pool-admission.md)).
- [x] Retire the native secondary CLI worker and remove its adapter-only configuration, exports, fixtures, and current capability claims without changing core Job, route-pool, scheduling, isolation, lifecycle, or evidence contracts ([decision 0059](../postmortems/0059-retire-native-opencode-worker.md)).
- [x] Close the Clutch dogfood gaps: give reviewers bounded repository-read tools, replace unbounded full-record Job lists with a shared 1 MiB summary page and exact lookup, and keep the HTTP listener reachable during cancellation/drain before storage-lock release. Do not add pagination cursors, a general shell reviewer, or another runtime owner ([incident/decision 0046](../postmortems/0046-clutch-review-listing-and-shutdown-gaps.md)).
- Promote Pi from first adapter to reference-tested adapter rather than privileged architecture.
- Evaluate another real worker adapter only when it provides a demonstrated lifecycle or observability benefit over Pi and passes the complete evidence gate.
- [ ] Re-evaluate Pi's durable `AgentHarness` only after a released package implements restored creation, prompt execution, terminal results, and observation instead of exporting placeholder methods. Keep Pi RPC as the reference transport until side-by-side conformance and soak cover completion, cancellation, timeout, usage, normalized events, concurrent Jobs, cleanup, and artifacts. Any migration stays inside the replaceable worker-adapter boundary: Pi sessions, lanes, queues, and storage never become AgentKnot Job authority, and the superseded Pi path is removed after parity ([dependency review 0071](../postmortems/0071-defer-pi-durable-harness-migration.md)).
- Keep provider/model selection as route data unless a second implementation proves that a standalone provider abstraction is required.
- Define exact versus inferred observability if multiple runtimes offer different event fidelity.
- [x] Add one bounded read-only usage report over persisted evidence: exact downstream adapter-reported token/cost coverage, an explicitly defined cache-read hit rate, and active/shadow route-selection rule/default counts. Pi RPC normalizes exact provider evidence into the route-neutral shape. Controller usage and upstream/downstream proportions remain structurally unavailable until an exact controller boundary supplies comparable data; no controller transcripts are parsed and no live collector or inferred usage is added ([decision 0034](../postmortems/0034-persisted-usage-observability-boundary.md)).
- [x] Retain one fixed-shape usage observation for every completed worker attempt so failed and retried downstream consumption is no longer hidden by the terminal Job result. Available token/cost values and explicit unavailable reasons aggregate once per attempt; new attempt evidence suppresses terminal-metadata double counting, while successful legacy Jobs retain their prior fallback. Human coverage is attempt-based and no controller usage, quota inference, pricing normalization, or provider/model branch is added ([decision 0086](../postmortems/0086-per-attempt-usage-evidence.md)).
- [x] Keep provider account-quota headroom outside routing and reporting. Shared credentials may be consumed by other clients and machines, and local observations cannot establish true account-wide remaining/reset state. AgentKnot therefore retains exact per-Job provider-reported usage/cost but does not scrape provider consoles, subtract local observations from configured budgets, present inferred remaining quota, or route on that inference ([decision 0034](../postmortems/0034-persisted-usage-observability-boundary.md)).

### Controller integration slice delivered

- Added separate optional Codex and Claude client packages with the same `.mcp.json → agentknot mcp` boundary, controller-authored Skill, and identical stateless `SessionStart` hook for `startup`, `resume`, `clear`, and `compact`. The superseded `UserPromptSubmit` obligation remains absent; the SessionStart hook injects one concise controller obligation from bounded event JSON and owns no filesystem, Git, network, CLI, policy, runtime, workspace, transcript, or session state ([decisions 0063](../postmortems/0063-remove-per-prompt-controller-obligations.md) and [0074](../postmortems/0074-session-start-controller-entry.md)).
- Pre-release smoke at `17c5c67` used a no-local clean clone, lockfile install, clean build, 17 broker/controller-integration tests, `npm pack`, installation of that tarball into an empty consumer, executable CLI and TypeScript export checks, and one isolated mock broker/Job lifecycle with confirmed listener cleanup. It consumed no provider inference and changed no global controller or service configuration. This is packability/installability evidence only; the root package remains intentionally private and unpublished until versioning and publication are explicitly authorized.
- Resume and repository switching now rely on the upstream controller's actual task/workspace context rather than duplicate hook state. The stateless `SessionStart` hook provides only the same lifecycle obligation after startup, resume, clear, or compact; the long-lived MCP client resolves current discovery per tool call, so a controller process follows broker restart without owning the scheduler or scanning a checkout ([decisions 0057](../postmortems/0057-independent-broker-and-thin-controller-clients.md) and [0074](../postmortems/0074-session-start-controller-entry.md)).
- Added a controller-neutral `orchestrate --handoff-json` projection so controller Skills receive terminal action, route/child evidence, one child output copy, errors, artifact review, and compact artifact verification without ingesting full events, repeated prompts, policy snapshots, execution prompts, or separate verification output. Full records remain authoritative and unchanged; only valid non-empty plain patch preview remains a separate review step.
- Added deterministic parity coverage for native manifests, Skills, MCP entrypoints, and identical `SessionStart` hooks, plus a populated delegated CLI handoff fixture and strict assessment CLI/HTTP coverage. Current evidence verifies bounded stateless lifecycle input, no `UserPromptSubmit` or raw-prompt forwarding path, and no runtime ownership. A post-correction fresh Codex repository-analysis task closed the corresponding real-entry gate; real Claude parity remains open ([decision 0074](../postmortems/0074-session-start-controller-entry.md)).
The following measurements are historical pre-cutover evidence. They remain useful for worker lifecycle and capacity-shift analysis but do not describe the current `SessionStart` entry or planning owner:

- Real Codex pre-model experiments covered planner failure with `fallback: "fail"`, zero child admission, planner-worktree cleanup, and a deterministic 500 ms Pi child timeout. The planner/fallback path is now removed ([incident 0033](../postmortems/0033-controller-timeout-phase-claim.md) and [decision 0053](../postmortems/0053-controller-owned-planning-handoff.md)).
- Recorded four Codex substantive paths on the same five-file read-only audit. Direct execution used 155,851 input tokens; host-model Skill and compact-workflow selection regressed to 178,071 and 249,154. Initial pre-model dispatch used 17,951, an 88.5% reduction, and made no controller tool calls after one Luna/max medium non-parallel child completed. A later non-empty lifecycle-fix comparison reduced Codex input from 2,266,538 on a controller-first/manual-delegation path to 141,781 with pre-model dispatch (93.7%); the latter returned a verified two-file Luna/max artifact that Codex reviewed, applied, and tested once. The second baseline is not pure direct and neither comparison establishes universal savings or real Claude parity ([incident 0031](../postmortems/0031-bounded-pi-output-drain.md)). A subsequent no-baseline Codex run proved automatic two-child dispatch, disjoint verified artifacts, and one upstream integration/validation pass; it establishes multi-child mechanics but no new savings ratio ([experiment 0032](../postmortems/0032-pre-model-multi-child-evidence.md)).
- Corrected the planner's broad trivial-work exception without changing the controller-entry or runtime boundary. On one same-task `summarizeRanges` pair, a bounded single-file edit that was previously retained upstream became one low-complexity DeepSeek Flash/max child after Luna/max planning. Real Codex input-plus-output fell from 74,610 to 48,878 (34.5%); non-cached-input-plus-output increased, and the automatic run added 42,670 downstream Pi tokens, so this is evidence of upstream-capacity shifting rather than universal total-compute or billing savings ([decision/experiment 0035](../postmortems/0035-delegation-first-small-repository-deliverables.md)).
- Added no controller branch, second scheduler, local semantic classifier, learned router, or duplicate request builder. The MCP server process is a thin protocol client; the independent broker owns execution, the controller owns semantic eligibility/planning, and deterministic configuration owns routes and limits.
- Decision [0053](../postmortems/0053-controller-owned-planning-handoff.md) supersedes the pre-model planning ownership in 0030/0048/0050 while retaining controller-owned handoff, deterministic routing, and artifact authority. Decision [0057](../postmortems/0057-independent-broker-and-thin-controller-clients.md) supersedes hook-owned workspace/session binding, and [0074](../postmortems/0074-session-start-controller-entry.md) records the later narrow `SessionStart` obligation without restoring hook-owned state or planning.

### Worker portability evidence

- The route-neutral unit kit runs against Mock and Pi RPC. Production references to the built-in protocols remain at their adapter boundaries; Pi emits one normalized tool start from each canonical execution-start frame rather than duplicating the preceding assistant-stream signal. A mock-only `createRuntime` test still proves terminal route/worker and `job.started` evidence without selecting the real Pi runtime ([incident 0066](../postmortems/0066-pi-duplicate-tool-start-events.md)).
- Pi output draining now stops awaiting after its existing grace deadline if an external event sink never settles, while exact-child/stream cleanup remains bounded and ordinary sink rejection remains covered. A deterministic real-adapter fixture verifies abort-reason identity, a strict settlement deadline, and exact PID disappearance without a new helper, fixture mode, API, or schema ([incident 0031](../postmortems/0031-bounded-pi-output-drain.md)).
- The unused xAI/Grok repository route and current-product examples were removed. Historical decision evidence remains unchanged; formal dogfood candidates are Luna/max and the human-authored low-complexity DeepSeek Flash/max route, with no fallback.

### Usage observability slice delivered

- Added `AgentKnotRuntime.usage()` plus `agentknot usage [--json]` as one read-only fold over persisted Job and Orchestration evidence. Exact available downstream token totals and provider-reported cost retain complete/partial coverage; zero remains distinct from missing or invalid data.
- Added fixed-shape per-attempt usage evidence before artifact/terminal persistence. Settled Pi failures retain available statistics, pre-settlement failures retain explicit `worker-failure`, policy-rejected results keep their usage, retries contribute each attempt once, and legacy successful records continue to fold from terminal metadata without double counting. CLI coverage now reports available versus observed attempts ([decision 0086](../postmortems/0086-per-attempt-usage-evidence.md)).
- Defined cache-read hit rate as `cacheRead / (input + cacheRead)` after aggregation and route-rule hit rate as `rule / (rule + default)`, with active and shadow evidence kept separate. Route classifications come only from terminal plan evidence checked against its immutable policy snapshot; missing or inconsistent evidence remains unclassified.
- Kept controller usage and upstream/downstream proportions explicitly unavailable because the current persisted controller contract has no comparable exact usage. The slice adds no transcript parser, telemetry store, live collector, import path, dashboard, HTTP endpoint, provider price table, or route/model behavior.

### Advisory quality-review slice delivered

- Added one optional route-neutral reviewer policy for configured parent complexities. Exactly one successful child with one bounded verified patch may start one separate single-attempt depth-one Job; strict verdict/findings, explicit skip/unavailable reasons, cancellation, restart reconciliation, compact handoff, and ordinary semaphore participation are covered without a repair loop or artifact promotion.
- The first real same-task run exposed an overpowered reviewer profile: it accepted a correct 834-byte patch but used 186,867 tokens, 17 tools, and about 129 seconds while inspecting unrelated repository material. The subsequent historical `bounded-review` experiment received only supplied evidence and disabled tools/context discovery; it accepted a controller-validated 4/4 patch with no modification using 10,931 tokens, while a seeded defect received `changes-requested` in 4,920 tokens. Clutch later proved that no repository inspection was too restrictive, so the current Pi reviewer profile permits bounded read-only repository inspection without edit or command authority ([incident/decision 0046](../postmortems/0046-clutch-review-listing-and-shutdown-gaps.md)).
- A subsequent real Codex pre-model run reused the exact historical direct-baseline commit, prompt, controller model, and effort. AgentKnot planned one low-complexity worker, persisted an accepted bounded review, and supplied the verified patch before the controller turn. Codex only applied the preview and ran one validation command; independent validation passed 4/4 with only `src/ranges.js` changed. Upstream input-plus-output was 47,569 versus the historical direct 74,610 (-36.2%); the three downstream jobs reported 66,323 tokens, so this proves a bounded upstream-capacity shift without claiming lower total compute or a universal completion rate.
- A second same-prompt pair used a different existing-code parser defect at fixture commit `34e91ae`. Direct and automatic Codex paths produced behaviorally equivalent single-file fixes and independently passed 5/5. The reviewed automatic path reduced upstream input-plus-output from 92,671 to 48,174 (-48.0%), but non-cached-input-plus-output rose from 12,287 to 13,102 (+6.6%), elapsed time rose from about 54.9 to 99.1 seconds (+80.5%), and its three downstream jobs reported 60,596 tokens. Repeated upstream raw-token savings therefore do not justify latency, billing, or total-compute claims.
- Extended the persisted usage fold with route-neutral review outcomes, verdicts, finding severities, reviewer routes, and explicit coverage. Final controller acceptance/modification/rejection remains unavailable because it is not persisted; four accepted real runs across two workload shapes and one seeded defect do not establish a universal reviewer completion rate or model ranking.

### Controller-owned artifact-validation slice delivered

- Added strict optional `delegation.artifactValidation` configuration for one explicit argument vector, timeout, and shared output cap. Eligibility is limited to one successful child and one integrity/base-valid non-empty patch.
- Re-verifies the exact admitted source snapshot and recorded artifact, recreates that base in a second disposable worktree, checks and applies only the worker delta there, runs the command without a shell, and records pass/nonzero/timeout/output-limit/cancellation/start/cleanup evidence. The source repository is never the patch target.
- Runs validation concurrently with an eligible advisory reviewer using a separate single process-local validation slot. Both evidence fields are serialized with their events before the parent terminal event; validation failure remains advisory and no repair or promotion path is added.
- Added deterministic configuration, command supervision, worktree, concurrency, persistence, restart, cancellation, compact-handoff/controller-integration, and source-nonmutation coverage. Controller Skills consume the advisory validation evidence without rerunning it before patch disposition, while retaining one post-application integrated check. Real orchestration `orchestration_6db8c5c2-3498-4e4d-9387-5381a413f0bd` used Luna/max planning, DeepSeek Flash/max implementation, and Luna/max review on a clean 3/5 parser fixture; its 744-byte single-file artifact passed controller-owned `npm test` 5/5 in 149 ms while review remained active, then review accepted and the parent succeeded with no source/worktree residue ([decision 0037](../postmortems/0037-controller-owned-artifact-validation.md)).

### Shared controller-runtime slice delivered

- Added `--server URL` / `AGENTKNOT_SERVER_URL` CLI transport over the existing HTTP API for Job and Orchestration submission, waiting, cancellation, inspection, delegation policy, routes, and artifacts. Client mode never constructs a file runtime or runs reconciliation; server failure has no local or model fallback.
- Codex and Claude packages use the same selected broker through MCP without repository-local config discovery. Their Skills prohibit checkout scanning and local-runtime fallback after broker failure.
- A deterministic gate starts two independent CLI processes from a directory with no configuration, labels their requests `codex` and `claude`, submits them concurrently to one broker, and verifies two distinct successful durable records. A separate stdio gate proves MCP contains no runtime and follows broker replacement.
- A real canonical file-backed server subsequently accepted two concurrent CLI processes through the explicit option and environment-variable paths. Both no-model acceptance requests succeeded as distinct durable records under one execution owner, proving the installed multi-session path without consuming provider quota.

### Independent broker/discovery slice delivered

- One exact `127.0.0.1` broker acquires per-user discovery ownership, publishes only after listen, exposes matching random identity/PID evidence, and removes only its own record on graceful shutdown.
- `broker up` launches the same compiled `broker run` entry, waits for exact readiness, and reuses an existing broker; `status` distinguishes stopped/running/unavailable; `down` verifies live identity before signalling and cleans only identity-matching crash residue.
- A successful `broker up` persists one strict config-path/port launch profile in the platform application-config directory. Common MCP exposes explicit status/start tools, so any controller can restore a stopped or identity-matching crash-stale broker without target-repository inference, controller-package side effects, shell mutation, or OS service installation ([decision 0058](../postmortems/0058-controller-neutral-broker-activation.md)).
- CLI and MCP clients use the registered endpoint without shell-profile edits, per-session exports, or repeated server flags. Stale or malformed discovery never opens local storage or selects a local/model fallback.
- [x] Make the broker rendezvous independent of transient controller environments after real Codex MCP processes omitted `XDG_RUNTIME_DIR` while a shell-launched broker used it. Replace the same-environment gate with heterogeneous-session coverage and prove fresh MCP plus concurrent DeepSeek/Luna upstream requests reuse one exact broker ([incident/decision 0073](../postmortems/0073-stable-multi-session-broker-rendezvous.md)).
- Process-level gates cover foreground/detached lifecycle, duplicate startup, two controller clients, broker replacement under one long-lived MCP process, hard broker restart, and exact parent/child recovery ([decision 0057](../postmortems/0057-independent-broker-and-thin-controller-clients.md)).

### Superseded native-service slice removed

- Built-in SQLite lifetime locks remain as one-broker split-brain protection and release on process death.
- The unpublished `agentknot service` command, systemd-user/launchd renderer, platform branches, and their tests were deleted. AgentKnot writes no OS service definition; external supervisors may run the foreground broker independently.
- Decision 0057 supersedes decision 0054's hosting mechanism while preserving its portability, explicitness, and no-shell-mutation requirements.

### Exit gates

- Installed Codex and Claude integrations each pass the same end-to-end request, terminal-record, and artifact-evidence contract without controller-name branches in core.
- Each promoted controller integration proves deterministic explicit entry plus the identical bounded `SessionStart` obligation for `startup`, `resume`, `clear`, and `compact`, with no `UserPromptSubmit` hook. The obligation is session context, not proof of implicit Skill invocation; a fresh-session package-driven task must still show that the controller selects the Skill, authors the strict assessment, and uses the independent broker. In `auto` mode raw prompts must not reach AgentKnot; the controller owns eligibility/planning and informational chat and product decisions remain upstream.
- Controller integrations contain no orchestration, route-selection, artifact-promotion, or product-decision policy that duplicates the AgentKnot core, and removing one integration leaves the core and other controller integrations functional.
- Code or documentation superseded by a promoted controller or worker path is removed in the same slice after parity tests pass; no unowned compatibility shim, duplicate request path, or stale capability claim remains.
- At least two real worker adapters pass the same conformance suite.
- Unsupported lifecycle and observability features are represented as unavailable, not emulated deceptively.
- The usage report distinguishes complete, partial, and unavailable persisted evidence; zero is never substituted for missing statistics, route hits come from the recorded plan rather than current configuration, and unknown controller usage never produces a fabricated 0/100 upstream/downstream split.
- Optional artifact validation is disabled by omission, cannot mutate the supplied source, persists exact bounded command/cleanup evidence before terminal completion, and remains advisory regardless of its result.
- Swapping controller, worker, provider, or model changes configuration or an adapter, not unrelated orchestrator modules.
- A real-worker soak covers success, failure, cancellation, timeout, and artifact handoff for every promoted adapter.
- Removing one adapter leaves the core and other adapters functional.

### Decision rule for native adapters

Do not add a native provider or harness adapter merely because a provider exists. Add it only if Pi cannot supply a required capability or the new path materially improves correctness, lifecycle control, observability, isolation, or maintenance. Record that evidence in a decision postmortem.

## Stage 3: Durable local middleware kernel

**Status: foundation delivered early; next slices queued behind the current Stage 2 contract focus.** Stage 3 work was pulled forward only where multi-session and restart defects made the old process-local behavior unusable. This does not make Stage 2 complete or authorize simultaneous expansion of both stages.

### Outcome

Make the controller-neutral execution handoff durable across controller sessions and process restarts without turning AgentKnot into a planner, agent-chat product, operating-system service manager, or unbounded remote execution service.

### Foundation delivered

- [x] Reuse the durable SQLite projection/event transaction for immutable WorkOrder issue and purpose-specific executor Job identity binding, while keeping WorkOrder outside Job/Orchestration execution, recovery, cancellation, and lifecycle ownership.
- [x] Record the controller/kernel/adapter boundary and keep semantic planning upstream in the existing strict controller-authored handoff ([decision 0055](../postmortems/0055-durable-middleware-kernel.md)).
- [x] Make production Job and Orchestration persistence transactional: bounded projections, append-only sequenced events, CAS revisions, scoped canonical-request idempotency, atomically admitted first leases, renewable fenced execution leases, and durable cancellation intent.
- [x] Make same-ID wait, status, and cancellation derive authority from durable stores. HTTP no longer owns separate active-execution maps, and independent store/runtime instances prove duplicate identity, stale-write/fence rejection, event-cursor resume, and cross-session cancellation.
- [x] Fence cancellation against a simultaneous success transition, retain monotonically increasing fence generations after release, validate legacy filename/record identity, and keep record plus idempotency plus first lease in one admission transaction.
- [x] Persist an integrity-checked admitted git-worktree input outside the bounded projection, then recover leaf Jobs only after a higher lease fence is claimed: cancellation wins, `queued` replays the admitted input, and `running` records a lost attempt before using only the next configured retry.
- [x] Admit a dispatching parent's deterministic policy projection and integrity-checked workspace input together before child execution, then derive every worker/reviewer Job admission from that parent evidence so parent recovery never rereads mutable source or performs semantic planning.
- [x] Reclaim queued/dispatching parent Orchestrations from the persisted plan/input boundary. Reuse deterministic child/reviewer idempotency identities, adopt terminal child evidence, admit only missing children, fail historical no-plan state explicitly, and mark interrupted command validation unavailable rather than rerunning it. A hard-kill process test proves the same parent and child complete at the next child attempt with one Job total.
- [x] Establish the independent broker boundary: foreground and explicit detached lifecycle, strict discovery identity, bounded exact-child cleanup for failed or concurrent losing starts, controller-neutral HTTP and stdio MCP clients, two simultaneous controller clients, and optional stateless controller clients. Delete systemd/launchd service-host code and controller-session binding code after parity ([decisions 0057](../postmortems/0057-independent-broker-and-thin-controller-clients.md) and [0064](../postmortems/0064-broker-startup-child-cleanup.md)).
- [x] Let common clients explicitly restore a stopped or identity-matching crash-stale broker from one protected product launch profile. Keep process activation out of controller packages and keep configuration selection out of target-repository inference ([decision 0058](../postmortems/0058-controller-neutral-broker-activation.md)).
- [x] Bind production `least-active` route-pool selection to atomic durable Job admission: count unexpired exact-route leases, persist rotation across broker replacement, include explicit member Jobs, and commit the selected record/idempotency/first lease/cursor together without adding fallback or provider-specific routing ([decision 0061](../postmortems/0061-atomic-durable-route-pool-admission.md)).
- [x] Derive compact route-neutral worker activity from durable Job events and coalesce private Pi text-frame noise before the fixed event budget. Keep evidence coverage and broker-client connectivity explicit and separate; add no provider-loss inference or second state authority ([incident/decision 0072](../postmortems/0072-compact-worker-activity-and-pi-frame-coalescing.md)).
- [x] Move direct, child, and reviewer Job execution into one FIFO capacity boundary. SQLite admission and reclaim use the current fenced lease; memory/legacy stores retain one abort-aware process-local FIFO fallback. Keep the production lifetime lock until multi-executor recovery and configuration authority are separately defined.
- [x] Add bounded route-neutral `steer`/`follow-up` for one active attempt with explicit adapter capabilities and durable request/accepted/rejected/lost evidence. Fence terminal state on unsettled requests, quarantine late Pi responses, and never replay across retry or restart.

### Queued next slices

1. Converge callbacks, resumable streams, and optional controller notifications on persisted event cursors. Transports remain replaceable delivery adapters; no chat network or transcript parser is added.
2. Run Claude parity only after a real Claude plan is available. The corresponding installed-package Codex gate is complete: a fresh session saw the advertised optional `TaskAssessment.context` schema and identical `SessionStart` obligation, selected the Skill without an AgentKnot prompt, admitted one eligible repository task through the independent broker, and returned verified terminal evidence. Repeat that Codex gate only after its integration contract changes; `allow_implicit_invocation` metadata alone remains insufficient evidence ([decision 0074](../postmortems/0074-session-start-controller-entry.md)).
3. Define multi-executor recovery and configuration authority before removing the one-broker lifetime lock; durable Job capacity alone is not distributed scheduling.
4. Add authenticated local automation, callback URL/signing/retry policy, admission/backpressure, approval, route policy, and sandbox backends only as separate evidence-gated hardening slices.

### Exit gates

- Authentication and callback threat models are documented and adversarially tested.
- Duplicate admission, queue ordering, leases/fencing/recovery, concurrency, cancellation, stale owners, and late completion have deterministic semantics across restart.
- Live streams can resume from persisted sequence state and never become state authority.
- Two independent controller sessions can submit, observe, and resume the same durable execution contract without sharing a process-local Promise or requiring shell-profile/native-service mutation; one long-lived MCP client follows broker restart.
- Controller adapters never submit raw prompts for middleware planning; every admitted orchestration contains a strict controller-authored assessment.
- One authoritative production store and scheduler remain; native service-manager and stateful hook/session paths are deleted rather than kept as parallel compatibility systems. Discovery remains a client convenience, and the lifetime lock remains one-broker protection until a durable multi-executor protocol exists.
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
- Automatic or learned model/provider ranking and silent model/provider optimization; human-authored active rules do not satisfy this gate, and a future optimizer still requires separate measured scorecards and an explicit roadmap change.
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

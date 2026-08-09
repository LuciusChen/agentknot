# AgentKnot

AgentKnot is a small, vendor-neutral control plane for developers and teams that discuss work in one coding agent but want policy-driven execution through interchangeable workers and model providers. It removes controller-specific delegation logic while preserving an auditable plan, isolated job evidence, and explicit artifact handoff.

The controller is intentionally not an SDK-specific concept. Codex, Claude, a CI job, or a custom application submits the same `JobRequest` or `OrchestrationRequest` through the CLI, HTTP API, or TypeScript API. Routes independently select:

```text
controller → AgentKnot orchestration policy → persisted plan → bounded child jobs
                         └──────→ Job API → worker adapter → provider/model
```

An optional orchestration route-selection policy can either record vendor-neutral shadow suggestions or apply explicit human-authored rules. The planner assesses task complexity but cannot name a route; configured policy remains the execution authority.

The first real worker adapter uses [Pi RPC](https://pi.dev/docs/latest/rpc), a strict JSONL protocol. It can run Pi with OpenCode Go and GPT-5.6 Luna without installing the OpenCode CLI.

To try it, install dependencies and run the deterministic Quick Start below. Use `agentknot run` for an already bounded leaf task or `agentknot orchestrate` when AgentKnot should decide whether and how to delegate.

## Capability status

The labels below are availability claims, not maturity ratings. **Current** means implemented and covered by deterministic tests. **Experimental** means evaluation-only and not a promoted default; its evidence gates are part of the status. **Proposed** and **Deferred** are not available.

| Status | Capability | Evidence or gate |
| --- | --- | --- |
| **Current** | Controller-neutral leaf jobs and bounded depth-one orchestration through CLI, HTTP, and TypeScript, with `off`, `suggest`, and `auto` delegation modes. | Implemented and covered by deterministic API, policy, lifecycle, and persistence tests; callers must invoke the Job or orchestration API rather than relying on native-chat interception. |
| **Experimental** | Thin installable Codex and Claude controller plugins with explicit delegation and pre-model automatic entry. | Both repository marketplaces install successfully, their manifests and Skills pass native validators, and deterministic tests cover the shared CLI/evidence boundary plus pre-model hook execution. In one initial five-file Codex audit, pre-model entry used 17,951 upstream input tokens versus 155,851 direct, an 88.5% reduction; the final larger output cap is deterministic-test-covered but was not re-benchmarked. Claude parity and broader workloads remain promotion gates. The separately installed `agentknot` CLI is required ([decisions 0027](postmortems/0027-controller-native-integration-boundary.md), [0029](postmortems/0029-controller-cli-and-single-child-delegation.md), and [0030](postmortems/0030-pre-model-controller-dispatch.md)). |
| **Current** | Independent worker/provider/model routing with the mock and Pi RPC adapters. | Implemented and covered by routing and adapter tests; the formal planner and conservative default worker remain Pi/OpenCode Go/Luna/max, with the configured low-complexity dogfood rule selecting DeepSeek Flash/max. |
| **Current** | Reusable route-neutral `WorkerAdapter` conformance tests for Mock and Pi RPC. | The shared unit kit covers healthy diagnostics, normalized start/text events and output, event-sink failure propagation, and pre-aborted runs. Pi transport tests remain separate; Mock is deterministic, not the second real adapter required by Stage 2. |
| **Current** | Optional human-authored route-selection rules for eligible orchestration children. | `delegation.dispatch.routeSelection` is disabled by omission and accepts `shadow` or `active`; both modes use 1–20 ordered, validated rules and persist first-match/default evidence, while only `active` changes the planned and actual child route. The repository maps parent complexity `low` to DeepSeek Flash/max and conservatively leaves `medium`, `high`, and no-match work on Luna/max. There is no learned ranking or fallback; see [decisions 0016](postmortems/0016-shadow-route-selection.md) and [0020](postmortems/0020-human-authored-active-route-selection.md). |
| **Current** | Ordered job/orchestration snapshots and normalized events with retries, timeouts, cancellation, one-shot callbacks, and bounded exact-child Pi supervision. | Implemented and covered by deterministic lifecycle, persistence, callback, and Pi conformance tests; catchable CLI/server shutdown cancels and awaits admitted work, late attempt events are ignored, and the bounded Stage 1 soak verifies exact process-group cleanup. File-backed execution owners hold advisory locks on both storage directories so a second conforming writer is refused before reconciliation or admission. |
| **Current** | Fixed UTF-8 budgets for prompts, metadata, worker events, result output, completion reports, errors, snapshots, callbacks, and patch artifacts. | Oversized admission fails early, bounded evidence carries explicit replacement/truncation state, snapshots and patch artifacts each have a 16 MiB ceiling, and callbacks above 8 MiB are not sent; local records/artifacts remain until exact manual deletion and content is not automatically redacted ([decisions 0023](postmortems/0023-fixed-durable-record-budgets.md) and [0025](postmortems/0025-local-retention-and-redaction-boundary.md)). |
| **Current** | Versioned persisted Job and Orchestration records. | New records carry top-level `schemaVersion: 1`; file reads materialize missing versions as legacy v1 in memory without rewriting bytes and reject explicit unsupported versions. |
| **Current** | Additive terminal Job completion summaries and bounded Pi normal-run report emission. | Newly terminal success, failure, and cancellation records include terminal outcome/attempt, controller-captured terminal-artifact path evidence or a stable unavailable reason, and an explicit worker-reported reported/unavailable branch; custom adapters and normal Pi runs may provide a strict report, while missing or malformed Pi envelopes remain explicit unavailable evidence. Deterministic coverage and a real Pi/OpenCode Go/Luna/max dogfood emission satisfy the Stage 1 gate. |
| **Current** | Git worktree attempt isolation, patch artifacts, read-only inspection, and delegated-child path-overlap review. | Newly captured artifacts include controller-derived repository-relative `changedFiles` (including `[]`); delegated parent results group exact paths owned by multiple children as potential conflicts and mark missing evidence incomplete. This is not semantic verification or acceptance, and artifacts are never applied, committed, merged, or pushed automatically ([decision 0026](postmortems/0026-child-artifact-path-overlap-review.md)). |
| **Current** | Configuration-only `doctor`, opt-in exact-route `doctor --live`, and HTTP process liveness. | Implemented and covered by diagnostic and HTTP contract tests; live probes are point-in-time evidence and are not run as normal-job preflights. |
| **Experimental** | Reviewed Pi worker profiles/extensions; none is promoted. | Evaluation only: use an exact version or immutable path without global or repository installation, then run repeated same-task Luna/max A/B trials against the minimal profile; completion, artifact verification, and target tests must not regress and session-statistics, elapsed-time, retry, or upstream-intervention evidence must show a repeatable net benefit before promotion. `pi-readseek@0.9.10` regressed its first pair. `pi-lean-ctx@3.9.18` produced two selected, passing artifacts and saved 39.0% total Pi tokens on the larger task, but on an independent smaller task it used 36.2% more tokens and took 45.7% longer; the inconsistent profile is not promoted. See [experiments 0013](postmortems/0013-pi-readseek-profile-ab.md) and [0014](postmortems/0014-pi-lean-ctx-profile-ab.md). |
| **Experimental** | Pi/OpenCode Go/DeepSeek V4 Flash at `thinkingLevel=max` for configured low-complexity dogfood work. | The route passed live probes and one isolated same-task comparison. It is now selected only by the repository's human-authored `low` rule; it is not a claimed intelligence ranking, fallback target, or replacement for Luna on medium/high work. Upstream artifact review remains required. See [experiment 0017](postmortems/0017-deepseek-flash-route-ab.md) and [decision 0020](postmortems/0020-human-authored-active-route-selection.md). |
| **Proposed** | Additional native worker adapters and an independent provider-runtime interface. | A pinned OpenCode CLI `v1.18.15` probe confirmed a structured CLI/ACP surface and an independent credential path, but two same-task A/B pairs showed no repeatable token or elapsed-time benefit over Pi, so implementation remains deferred. Any candidate still requires the Stage 2 contract and real-worker gates ([decision 0028](postmortems/0028-native-opencode-adapter-evidence-gate.md)). |
| **Proposed** | Authenticated local automation, signed callbacks, restart-aware queues/backpressure, approval/policy controls, and an OS-sandbox backend. | Not available; each capability requires its own threat model and the Stage 3 authentication, recovery, approval, and boundary tests. |
| **Proposed** | An explicit artifact-promotion operation. | Not available; it may be considered only if dirty-target, base-mismatch, checksum, and explicit controller/human-approval checks are safe and tested. |
| **Deferred** | Automatic patch application, commit, merge, push, deployment, or pull-request creation. | Not available by design; artifact inspection ends with an upstream controller or human decision. |
| **Deferred** | Remote/team/fleet operation, collaboration surfaces, recursive or dependency-graph swarms, and silent provider/model fallback or optimization. | Not available; these remain conditional or deferred until an explicit PRD/SPEC change and evidence-gated roadmap stage. |

Outside the experimental plugins, controllers still choose whether a request enters the leaf Job API or orchestration API. In a Git repository whose resolved AgentKnot policy is explicitly `mode: "auto"`, the plugin hook submits each non-explicit prompt to the existing planner before the first controller-model request; non-Git, unconfigured, `off`, `suggest`, and explicit-Skill prompts bypass this path. AgentKnot—not plugin code—classifies the request and applies the existing keep-upstream, route, concurrency, depth, and artifact rules. Other integrations can call the same CLI, `POST /v1/orchestrations`, or `runtime.orchestrate()` boundary.

## Product and architecture contracts

AgentKnot keeps current behavior, future intent, execution order, and historical rationale separate so roadmap ideas do not silently become product claims:

- [Product requirements](docs/PRD.md) define the user problem, product thesis, scope, and non-goals.
- [Technical specification](docs/SPEC.md) defines current contracts, invariants, limitations, and verification requirements.
- [Roadmap](docs/ROADMAP.md) sequences work through objective exit gates rather than dates or feature wishlists.
- [Changelog](CHANGELOG.md) records release-relevant changes under an unreleased version until publication.
- [Postmortems and decision records](postmortems/README.md) preserve incidents, experiments, tradeoffs, and rejected alternatives without rewriting history.

Material changes should map to all four layers before implementation starts.

AgentKnot borrows the useful boundary ideas of harness/session/event systems such as Agent Relay, but has no Agent Relay runtime dependency and does not copy its cloud, chat, fleet, or workspace layers.

## Development setup

Requires Node.js 22 or newer.

```bash
npm install
npm run build
npm test
```

Run the deterministic route before installing any agent:

```bash
node dist/src/cli.js routes
node dist/src/cli.js run \
  --route mock \
  --source codex \
  --workspace . \
  "Inspect this project and propose the next implementation step"
```

Jobs are written under `.agentknot/jobs/` by default.

## Automatic delegation

Use the orchestration entry point when AgentKnot should decide whether to retain the goal upstream, suggest a split, or dispatch bounded child jobs:

```bash
node dist/src/cli.js orchestrate \
  --source codex \
  --workspace /path/to/target-repository \
  "Implement the approved feature and verify its public contract"
```

The repository configuration dogfoods `mode: "auto"` with Luna/max as planner and conservative default worker, plus one human-authored active rule that sends parent complexity `low` to DeepSeek Flash/max. `medium`, `high`, and no-match work stay on Luna/max. The product defaults are `maxChildren: 2` and `maxConcurrency: 2` when dispatch limits are omitted; this repository keeps a six-task pool with six active execution slots. Formal six-child orchestrations at concurrency four, five, and six all succeeded through Pi/OpenCode Go/Luna/max; at six, all children started within 44 ms and completed on their first attempt. Six is therefore the current repository dogfood setting, not a universal Pi or provider capacity guarantee. The scheduler starts only the useful available tasks up to the cap and immediately refills a slot when a worker completes, so two tasks still use two workers and a non-parallel plan still uses one. This delegation semaphore covers planners and orchestration children, not callers that invoke several direct leaf `Job` requests concurrently; direct bursts require caller-side admission control in v1. The planner only returns a strict assessment and is instructed to mark work parallel only when subtasks are independently verifiable, have no execution-order dependency, and have non-overlapping expected write scopes. Delegation and parallelism are separate: one bounded substantive task may become exactly one non-parallel child, and lack of a useful split alone is not a reason to retain it in Codex or Claude. Objectively trivial one-read work stays upstream when planner, worker, and review overhead would cost more. The planner never names routes: deterministic policy filters task kinds, evaluates the configured rules, persists the effective policy, exact worker prompts, selected routes, evidence, and plan hash, and only then starts child jobs. Child metadata carries the task kind, parent assessment complexity, and selection evidence. A non-parallel assessment automatically reduces its parent to one active child. Product decisions, artifact integration, commits, and pushes remain with the upstream controller.

The successful self-orchestration was evidence for one normal planner-to-plan-to-child run, not standalone evidence of planner fail-fast behavior. Planner failure, timeout, cancellation, and waiting for a shared dispatch slot have separate outcomes and must be established by their deterministic tests; with the default `upstream` fallback, malformed or failed planner output is recorded in a persisted upstream plan, while `fail` terminates the parent before dispatch.

Per request, `--delegation never`, `--delegation suggest`, and `--delegation force` can narrow or request behavior. `force` does not bypass global `off`, the child limit, depth limit, or `keepUpstream` policy. Set global mode to `off` when a caller only wants the leaf Job API. `suggest` and `auto` require Git worktree isolation.

### Codex and Claude controller integrations

Stage 2 includes experimental installable plugins under `integrations/`. They are thin controller adapters: both submit the same orchestration request, consume the same terminal record, inspect the same artifact evidence, and leave routing, product decisions, artifact promotion, commit, push, merge, and deployment outside the plugin.

Controller Skills use `agentknot orchestrate --handoff-json`, a compact projection of the persisted terminal record that keeps status, action, route evidence, child IDs and output, errors, parent artifact review, and one compact artifact verification result while omitting event history, policy snapshots, repeated prompts, and execution prompts. The full durable record remains available through existing inspection surfaces. Skills preview only valid non-empty patch content, avoiding repeated full-record and verification output in the upstream context.

Build and install the AgentKnot CLI once before either controller plugin. The skills check this prerequisite and stop before orchestration if it is absent; they never substitute another worker, provider, or model.

```bash
npm run build
npm install --global --prefix "$HOME/.local" /path/to/agentknot
command -v agentknot
agentknot routes
```

Ensure `$HOME/.local/bin` is on the controller process `PATH`.

Install the Codex plugin from a local checkout, then start a new Codex session:

```bash
codex plugin marketplace add /path/to/agentknot
codex plugin add agentknot@agentknot
```

Invoke the full review workflow explicitly with `$agentknot-delegate`. Implicit Codex Skill matching is disabled; automatic entry is owned by the pre-model hook only when the repository policy is `auto`.

Install the Claude Code plugin from the same checkout, then start a new Claude session:

```bash
claude plugin marketplace add /path/to/agentknot
claude plugin install agentknot@agentknot
```

Invoke it explicitly as `/agentknot:agentknot-delegate`; Claude's native Skill surface remains available, while configured automatic entry uses the same pre-model hook contract. A controller's `/goal` may preserve an upstream goal, but `/goal` is not the AgentKnot protocol and does not itself bypass the plugin or orchestration API.

After installation or any hook change, review and trust the plugin hook in the controller's native hook UI, then start a new session. `UserPromptSubmit` has no task-category matcher. The hook is a dependency-free I/O adapter: it finds the Git root, requires resolved delegation `mode: "auto"`, and synchronously calls `agentknot orchestrate --delegation inherit --handoff-json` before the first controller-model request. The existing Luna planner decides whether work stays upstream or dispatches; configured low children use DeepSeek Flash/max and medium/high/default children use Luna/max. Explicit Skill prompts bypass the hook, and Codex keeps implicit Skill loading disabled.

For delegated work, the hook supplies compact terminal evidence and integrity-valid non-empty patch previews but never applies them. All child outputs share a 24,000-character budget, previews share 32,000 characters, and total model-visible hook context is capped at 60,000 characters. A configured `auto` repository therefore forwards every non-explicit submitted prompt to the configured planner, including prompts the planner later retains upstream; use `off` or `suggest` where that latency or data boundary is unacceptable. No MCP server, wrapper daemon, local semantic classifier, learned router, or fallback model is added; see [decision 0030](postmortems/0030-pre-model-controller-dispatch.md).

### Human-authored route selection

`delegation.dispatch.routeSelection` is optional and disabled when omitted. `mode: "shadow"` records what a rule would choose while retaining `dispatch.defaultRoute`; `mode: "active"` makes the matching configured route authoritative for the planned child and ordinary Job. The global delegation mode remains a separate setting.

The repository dogfood policy is intentionally small:

```json
{
  "dispatch": {
    "defaultRoute": "luna",
    "maxChildren": 6,
    "maxDepth": 1,
    "maxConcurrency": 6,
    "routeSelection": {
      "mode": "active",
      "rules": [
        { "route": "deepseek-flash", "complexities": ["low"] }
      ]
    }
  }
}
```

There must be 1–20 ordered rules, every `route` must name an existing configured route and every candidate is validated at config load, and a present `taskKinds` or `complexities` array must be non-empty and unique. Complexity values are only `low`, `medium`, and `high`; when both predicates are present they must both match, and a rule with neither predicate is an explicit catch-all, so the first matching rule wins.

For each eligible planned subtask, AgentKnot evaluates the subtask kind and parent assessment complexity. An active match persists evidence such as `{ "mode": "active", "selectedRoute": "deepseek-flash", "basis": "rule", "ruleIndex": 0 }`; with no match it persists `{ "mode": "active", "selectedRoute": "luna", "basis": "default" }`, with no `ruleIndex`. `ruleIndex` is zero-based and appears only for a rule match. In this first slice complexity is assessed once for the parent orchestration, so all children share that complexity; there is no second per-child model judgment.

The suggestion is observable in the persisted plan and in the child `agentknotDelegation` metadata, alongside `taskKind` and `parentComplexity`, so future scorecards do not need to parse prompts; a child metadata fragment is:

```json
{
  "agentknotDelegation": {
    "role": "worker",
    "taskKind": "documentation",
    "parentComplexity": "medium",
    "routeSelection": {
      "mode": "active",
      "selectedRoute": "deepseek-flash",
      "basis": "rule",
      "ruleIndex": 0
    }
  }
}
```

`PlannedSubtask.route` and the child Job's ordinary `Job.route` are `deepseek-flash` in this example. If no rule matches, both remain `luna`. Each selected route resolves its configured provider, model, `thinkingLevel`, timeout, and retry snapshot before execution. A route failure is reported on that route and never causes silent model fallback.

Use `agentknot orchestrate` with the configured file, then inspect the orchestration record and each child Job record through CLI JSON, `GET /v1/orchestrations/:id`, or `GET /v1/jobs/:id`. `shadow` remains available for measurement without execution changes. `active` is deterministic human policy, not a performance ranking: AgentKnot does not learn model intelligence, choose from prices, or silently optimize/fallback.

## Pi + OpenCode Go + Luna

Install Pi using its documented package:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Provide the OpenCode API key without committing it to configuration:

```bash
export OPENCODE_API_KEY="..."
```

Alternatively, start `pi`, run `/login`, and store the key under the `opencode-go` provider in Pi's credential file. AgentKnot accepts either Pi's auth file or the configured environment variable and never copies the key into a Job record.

Route diagnostics have two deliberately different modes. `doctor` is the fast configuration, credential, and runtime check; its successful result explicitly says that live inference was not checked, so it does not prove that the provider accepted a request from the current network path. For Pi routes, it evaluates command `PATH`, required environment names, `PI_CODING_AGENT_DIR`, and the worker home from the same `process.env`-plus-worker-environment snapshot passed to `run` and `probe`, without returning credential values. The Stage 1 live check is opt-in and remains route-neutral. For this repository, selecting `luna` resolves Pi, `opencode-go`, `gpt-5.6-luna`, and `thinkingLevel: "max"`:

```bash
node dist/src/cli.js doctor --route luna --live
```

`doctor --live` performs one bounded real inference probe with the exact selected worker, provider, model, and thinking level. Its 30-second control-plane timer triggers cooperative abort, and the supported Pi adapter supervises its child process, waits for cleanup, and removes an isolated temporary diagnostic workspace before returning. The command does not fall back to another route, returns the provider error and a nonzero exit status when inference is unavailable, and reports an honest unsupported result when the selected adapter has no probe capability. It creates no Job or artifact record, and normal `run` or orchestration execution does not perform an extra probe. A successful probe is point-in-time evidence for that exact route, not a guarantee that later jobs will succeed.

Check the route, then run it against any target repository:

```bash
node dist/src/cli.js doctor --route luna

node dist/src/cli.js run \
  --route luna \
  --source codex \
  --workspace /path/to/target-repository \
  "Implement the agreed design, run relevant tests, and summarize the changes"
```

AgentKnot starts:

```text
pi --no-skills \
  --no-extensions \
  --no-prompt-templates \
  --no-themes \
  --mode rpc \
  --provider opencode-go \
  --model gpt-5.6-luna \
  --no-session
```

The adapter disables ambient extension, skill, prompt-template, and theme discovery for every background Pi run and live probe. Explicit `--extension`, `--skill`, `--prompt-template`, and `--theme` arguments remain available for reviewed worker profiles, while repository context files such as `AGENTS.md` stay enabled. A profile must not depend on global or repository-local Pi installation state: use an exact reviewed package version or immutable external path, compare it with the minimal route on the same real task, and promote it to dogfood only after repeated completion/artifact/test evidence shows a net benefit. Recommendation alone is not promotion evidence; see [decision 0012](postmortems/0012-evidence-gated-pi-profiles.md).

AgentKnot sends the prompt over stdin as JSONL and waits for Pi's `agent_settled` event, so retries and queued continuation events finish before the job is marked complete. After a successful normal run it requests `get_session_stats` and stores only sanitized counts, token totals, cost, and optional context usage under result metadata; unsupported, malformed, or timed-out statistics are advisory and do not turn successful work into failure. These statistics and other Pi activity remain evidence for diagnostics, not a completion report. For normal `run` jobs only, the adapter appends a provider/model-neutral instruction asking the final assistant message to end with one line beginning `AGENTKNOT_WORKER_COMPLETION_REPORT_V1: ` followed by the schemaVersion 1 `WorkerCompletionReport` JSON. The report contains worker-reported `changedFiles`, `checksRun`, `remainingRisks`, and `notes`; every value is a worker claim, not AgentKnot verification. A valid suffix is strictly validated and removed from `result.output` while preceding output is preserved, a missing suffix is absent, and a detected malformed or unsupported suffix is `null` without failing the job. The instruction and parser are not used by `doctor` or `doctor --live`, and no text after the marked line is accepted. The adapter decodes streaming UTF-8 independently of process chunk boundaries, reports malformed frames and missing settlement explicitly, and uses bounded `SIGTERM` → `SIGKILL` supervision for the exact Pi child on timeout or cancellation. It does not perform process-wide cleanup or claim ownership of arbitrary descendants.

Normal `PiRpcWorkerAdapter.run` executions have one bounded record-volume rule: exactly the Pi lifecycle envelopes `turn_start`, `turn_end`, `message_start`, and `message_end` are omitted from `worker.raw`; every received Pi frame still increments `metadata.rawEventCount`, including those four envelopes, and unknown event types remain `worker.raw`. Normalized text/tool/retry events, final output, completion reports, live-probe behavior, route/provider/model/thinking configuration, and global event types are unchanged. This is not a Pi-token-saving claim or general truncation and adds no schema migration, plugin installation, configuration/probe change, or global event-type change.

## Switching controller or provider

The control protocol does not change when the caller changes:

```bash
agentknot run --source codex  --route luna "..."
agentknot run --source claude --route luna "..."
```

The source is identity and audit metadata; it is not used to choose implementation code.

Provider changes are route-only:

```bash
agentknot run --source claude --route deepseek-flash "..."
```

The included `deepseek-flash` route keeps Pi and OpenCode Go but selects DeepSeek V4 Flash/max. Repository automatic delegation uses it only for the human-authored low-complexity rule; explicit callers may select it directly. Luna/max remains the conservative default, and neither route is a fallback for the other.

## HTTP automation

Start the local control plane:

```bash
agentknot serve --host 127.0.0.1 --port 7391
```

Submit asynchronously:

```bash
curl -sS http://127.0.0.1:7391/v1/jobs \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "Implement the approved plan and run tests",
    "workspace": "/path/to/repository",
    "route": "luna",
    "source": "claude"
  }'
```

The response is `202 Accepted` with a job ID. Poll or cancel it:

```bash
curl -sS http://127.0.0.1:7391/v1/jobs/JOB_ID
curl -sS http://127.0.0.1:7391/v1/jobs/JOB_ID/events
curl -sS -X POST http://127.0.0.1:7391/v1/jobs/JOB_ID/cancel
```

Inspect a completed job's patch artifacts without applying them:

```bash
agentknot artifacts JOB_ID --json
agentknot artifact-verify JOB_ID --json
agentknot artifact-preview JOB_ID 1 --json
```

The equivalent HTTP endpoints are `GET /v1/jobs/:id/artifacts`, `GET /v1/jobs/:id/artifacts/verify`, and `GET /v1/jobs/:id/artifacts/:attempt/preview`. Verification recomputes the recorded size and SHA-256 and compares the recorded base commit with the current source repository `HEAD`. Preview returns at most 1 MiB of UTF-8 Git patch text and withholds content when file integrity fails; a base mismatch remains visible in the verification evidence so the controller can inspect but must not promote blindly. These operations read job metadata, artifact bytes, and Git metadata only. They never apply, commit, push, or otherwise mutate the source repository.

For a completed delegated orchestration, inspect `result.artifactReview` through `orchestration-show`, the full HTTP orchestration record, or the TypeScript result. `checked` means every child had controller-captured terminal path evidence; `incomplete` must not be read as a clean handoff. Each `conflicts` entry groups an exact repository-relative path found in multiple children. It is potential integration-conflict evidence only: same-path changes may be compatible, and disjoint paths can still be semantically coupled.

The deliberate handoff workflow is: inspect the parent and child records; verify every candidate artifact's size, SHA-256, and base; preview intact patches; review all overlap and unavailable evidence; then explicitly accept or reject the artifact or child set in the upstream controller. Acceptance does not apply anything. Any promotion is a separate explicit repository action after acceptance; AgentKnot has no promotion command and never mutates the source during orchestration, inspection, acceptance, or rejection.

Read-oriented CLI commands, including `show`, lists, artifact inspection, route and delegation inspection, and both doctor modes, open persisted records without ownership or startup reconciliation. A TypeScript runtime created with `reconcileOnStartup: false` has the same read-only capability boundary: its execution and reconciliation methods refuse calls. `run`, `orchestrate`, and a valid `serve` invocation are execution owners. They acquire non-blocking advisory locks on the canonical Job and Orchestration storage directories before any reconciliation or admission; a second conforming owner exits clearly, while read-only commands remain available. Invalid `serve` arguments are rejected before runtime construction.

The file-backed owner helper uses the host `flock` command and holds kernel locks for the runtime lifetime. One-shot CLI commands release them after completion; a server process crash releases them through the kernel. TypeScript callers must call `await runtime.close()` after all admitted work settles; closing while admission or completion is active is refused. After a new owner acquires both locks, all prior nonterminal snapshots are failed once without replay, regardless of recorded PID, so PID reuse or a different PID namespace is not used as takeover authority. Directly constructed stores/runtimes remain an advanced in-process API and do not bypass the documented single-writer responsibility ([decision 0022](postmortems/0022-file-runtime-single-writer-ownership.md)).

After a CLI `run` or `orchestrate` request has been admitted, catchable `SIGINT`/`SIGTERM` cancels that exact execution, awaits its worker cleanup and terminal persistence, and only then releases runtime ownership. HTTP server close first stops new admission, cancels all active Jobs and orchestrations, awaits their completions, and then releases the runtime. A hard kill cannot run these handlers; the next owner fails persisted nonterminal records without replay, but arbitrary descendants or worktrees left by an uncatchable host failure still require exact operator cleanup. `npm run test:stage1-soak` runs the signal, Pi, restart, and worktree matrix in a unique POSIX process group with a 60-second bound and fails after cleaning that exact group if descendants remain ([incident 0024](postmortems/0024-stale-dogfood-test-processes.md)).

Persisted Job and Orchestration records carry top-level `schemaVersion: 1`. File stores accept a missing field as legacy v1 only while reading, materialize it on the returned in-memory record, leave read-only snapshot bytes unchanged, and fail clearly for an explicit unsupported version. This slice adds no migration command or automatic on-disk rewrite.

A newly terminal JobRecord also carries an additive `completionSummary` in TypeScript values, CLI `--json`, HTTP full-record responses, and callback snapshots without a new endpoint or serializer. Its changed paths are copied only from the terminal attempt's controller-captured artifact and retain artifact attempt/SHA-256/base-commit identity; direct mode, missing artifacts, or missing artifact path data produce stable unavailable reasons. A strict custom-adapter or normal-Pi `completionReport` is placed under `workerReported` only after validation; `undefined` means no envelope was detected and `null` means a detected envelope was malformed or unsupported. AgentKnot never derives it from prose, worker events, stderr, or session statistics. Human CLI rendering is unchanged. A real Pi/OpenCode Go/Luna/max dogfood job emitted and persisted the strict report, closing the Stage 1 evidence gate; the report remains a claim rather than controller verification.

Durable record budgets are fixed rather than configuration-dependent in Stage 1. Caller-supplied Job and Orchestration request prompts are limited to 64 KiB; controller metadata to 64 KiB of compact JSON and depth 20; each JSON-normalized event-data object to 16 KiB as a standalone value; and each Job to 512 worker events. An oversized event payload is replaced with structured evidence. The first worker event beyond the count cap becomes `job.worker.events.truncated`; later worker events are neither persisted nor delivered to the live observer. Terminal output retains at most a 1 MiB valid UTF-8 prefix and exposes `result.outputTruncation`; strict worker reports are limited to 256 KiB. File and memory Job/Orchestration stores reject new writes above 16 MiB of stored JSON; legacy larger files remain readable, but later mutation must fit. Callback JSON above 8 MiB is not sent, and AgentKnot attempts to persist an undelivered size error under the same snapshot ceiling. These record limits bound retained evidence and delivery payloads, not worker compute; patch bytes and local retention have the separate fixed boundary described in [decision 0025](postmortems/0025-local-retention-and-redaction-boundary.md), and no size control is sensitive-content redaction ([decision 0023](postmortems/0023-fixed-durable-record-budgets.md)).

Set `callbackUrl` in the request to receive the terminal job snapshot by HTTP POST. The single request is skipped when its JSON body exceeds 8 MiB.

Leaf Job admission is one store create containing the queued state and `job.queued` event. A create failure starts no worker. If a later event, artifact record, or terminal transition cannot be saved, completion rejects with `JobPersistenceError`; AgentKnot does not retry the worker, synthesize a terminal event, or deliver the callback, and the last successfully persisted snapshot remains authoritative. An unrecorded patch file is removed together with its managed worktree. Startup reconciliation can later fail a persisted nonterminal snapshot without replaying it.

Submit a goal to the policy-driven path:

```bash
curl -sS http://127.0.0.1:7391/v1/orchestrations \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "Implement the approved feature and review the test gaps",
    "workspace": "/path/to/repository",
    "source": "claude",
    "delegation": "inherit"
  }'
```

Poll `/v1/orchestrations/ORCHESTRATION_ID`, inspect its `/events`, or cancel an orchestration active in the serving process. `GET /v1/delegation` exposes the effective global policy without exposing credentials.

## Configuration

The separation between worker and provider is deliberate. Workspace isolation is an orchestrator lifecycle, not a worker or provider feature:

```json
{
  "workspaceIsolation": {
    "mode": "git-worktree",
    "directory": ".agentknot/worktrees"
  },
  "workers": {
    "pi": {
      "adapter": "pi-rpc",
      "command": "pi",
      "noSession": true
    }
  },
  "routes": {
    "luna": {
      "worker": "pi",
      "provider": "opencode-go",
      "model": "gpt-5.6-luna",
      "thinkingLevel": "max",
      "requiredEnv": ["OPENCODE_API_KEY"],
      "maxAttempts": 2,
      "timeoutMs": 3600000
    },
    "deepseek-flash": {
      "worker": "pi",
      "provider": "opencode-go",
      "model": "deepseek-v4-flash",
      "thinkingLevel": "max",
      "requiredEnv": ["OPENCODE_API_KEY"],
      "maxAttempts": 2,
      "timeoutMs": 3600000
    }
  },
  "delegation": {
    "mode": "auto",
    "planner": { "strategy": "hybrid", "route": "luna" },
    "dispatch": {
      "defaultRoute": "luna",
      "maxChildren": 6,
      "maxDepth": 1,
      "maxConcurrency": 6,
      "routeSelection": {
        "mode": "active",
        "rules": [
          { "route": "deepseek-flash", "complexities": ["low"] }
        ]
      }
    },
    "policy": {
      "delegate": ["architecture-review", "test-gap-analysis", "documentation", "independent-implementation"],
      "keepUpstream": ["requirements-decision", "product-decision", "artifact-integration", "commit", "push"]
    },
    "fallback": "upstream"
  }
}
```

Use `--config PATH` or `AGENTKNOT_CONFIG` for another configuration file. JSON configuration selects the built-in `mock` and `pi-rpc` worker adapter kinds; it cannot register an arbitrary TypeScript adapter by name. For a custom worker, construct `Orchestrator` in TypeScript with an `AgentKnotConfig`, `JobStore`, and `Map<string, WorkerAdapter>`, and construct `OrchestrationService` separately when orchestration is required; `createRuntime()` is the file-configured path and does not accept a custom adapter factory.

When `workspaceIsolation.mode` is `git-worktree`, AgentKnot requires the supplied workspace's Git repository to have a `HEAD` and a clean index/worktree, including non-ignored untracked files. Each attempt is a detached worktree at the same base commit, and the worker receives the matching repository subdirectory. After every attempt, a binary Git patch up to 16 MiB is written under the configured storage directory (including non-ignored untracked files and commits made by the worker after the base commit), and metadata records Git-derived repository-relative `changedFiles` on the job, including an empty array for an empty patch; the exact managed worktree is then removed. A larger patch fails the Job without retry or retained partial artifact. This changed-file list is controller-captured artifact evidence, not a worker claim or semantic verification; the terminal completion summary carries it only with artifact identity and keeps worker-reported claims separate, without parsing worker prose or tool events. Patches are artifacts only; AgentKnot never applies them to the source repository. Older persisted artifacts may omit `changedFiles`. Detached worktrees contain committed files only, so ignored dependencies and build outputs must be provisioned by the worker when needed. The compatibility mode is `none` (or an omitted section), which passes the caller's directory directly and does not provide isolation.

## API surface

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

`GET /health/live` is the canonical process-liveness endpoint. It returns `status: "live"` and explicitly marks storage, routes, and inference as `not-checked`; `GET /health` returns the identical payload for compatibility. There is intentionally no `GET /health/ready` contract. Use CLI `doctor` for configuration diagnostics and explicit `doctor --live --route NAME` when point-in-time provider inference evidence is required.

## Safety model

Automatic delegation requires `git-worktree` mode. Planner and worker agents read and execute commands in separate managed detached worktrees; the supplied source workspace is not modified and resulting patches are handed off as artifacts. A persisted plan never grants automatic artifact application. In compatibility mode `none`, leaf jobs may operate directly in the supplied workspace, but `suggest` and `auto` configuration is rejected. AgentKnot does not claim to be an operating-system sandbox. Run workers only against repositories and credentials appropriate for that worker.

Callback URLs are supplied by trusted local controllers and can make HTTP requests from the AgentKnot host. The body cap does not authenticate, sign, or allowlist the destination. Do not expose the MVP HTTP server to untrusted networks.

Local Job/Orchestration snapshots and patch artifacts are retained indefinitely until an operator deletes their exact files after stopping the execution owner and confirming no active work. Stage 1 has no expiry, garbage collector, cascade deletion, or purge API. Prompts, output, events, metadata, stderr evidence, callbacks, and patches can contain sensitive content; byte limits, allowlisted statistics, and credential-field minimization are not automatic redaction. See [decision 0025](postmortems/0025-local-retention-and-redaction-boundary.md).

## Roadmap

Stage 1's dependable local job loop is complete: the deterministic suite and bounded host soak cover lifecycle, catchable shutdown, fail-without-resume recovery, exact-child Pi cleanup, worktree cleanup, persistence bounds, and artifact handoff, with real Pi/OpenCode Go/Luna/max dogfood evidence. Current limits include one conforming file-runtime writer, fail-without-resume rather than resume, depth one, no automatic artifact integration, no semantic verification of captured paths, and no authentication for the local HTTP service. Stage 2 work remains evidence-gated; broader queues, dependency graphs, remote operation, and fleets are not implied by Stage 1 completion.

See [the roadmap](docs/ROADMAP.md) for scope, non-goals, and exit gates. Native adapters, provider fallback, streaming, sandbox backends, OhMyPi compatibility, remote/fleet features, and automatic model/provider selection are proposals or deferred rather than current capabilities; any future ranking requires separate measured scorecards.

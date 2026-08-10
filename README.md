# AgentKnot

AgentKnot is a small, vendor-neutral control plane for developers and teams that discuss work in one coding agent but want policy-driven execution through interchangeable workers and model providers. It removes controller-specific delegation logic while preserving an auditable plan, isolated job evidence, and explicit artifact handoff.

The controller is intentionally not an SDK-specific concept. Codex, Claude, a CI job, or a custom application submits the same `JobRequest` or `OrchestrationRequest` through the CLI, HTTP API, or TypeScript API. Routes independently select:

```text
controller → AgentKnot orchestration policy → persisted plan → bounded child jobs
                         └──────→ Job API → worker adapter → provider/model
```

An optional orchestration route-selection policy can either record vendor-neutral shadow suggestions or apply explicit human-authored rules. The planner assesses task complexity but cannot name a route; configured policy remains the execution authority.

The reference real worker adapter uses [Pi RPC](https://pi.dev/docs/latest/rpc), a strict JSONL protocol. A second promoted real adapter invokes OpenCode CLI's JSON run surface directly, proving that Pi is replaceable without changing Job semantics. Neither path fixes provider, model, or effort in core.

To try it, install dependencies and run the deterministic Quick Start below. Use `agentknot run` for an already bounded leaf task or `agentknot orchestrate` when AgentKnot should decide whether and how to delegate.

## Capability status

The labels below are availability claims, not maturity ratings. **Current** means implemented and covered by deterministic tests. **Experimental** means evaluation-only and not a promoted default; its evidence gates are part of the status. **Proposed** and **Deferred** are not available.

| Status | Capability | Evidence or gate |
| --- | --- | --- |
| **Current** | Controller-neutral leaf jobs and bounded depth-one orchestration through CLI, HTTP, and TypeScript, with `off`, `suggest`, and `auto` delegation modes. | Implemented and covered by deterministic API, policy, lifecycle, and persistence tests; callers must invoke the Job or orchestration API rather than relying on native-chat interception. |
| **Experimental** | Thin installable Codex and Claude controller plugins with explicit delegation and pre-model automatic entry. | Both repository marketplaces install successfully, their manifests and Skills pass native validators, and deterministic tests cover the shared CLI/evidence boundary, pre-model success/failure hook execution, and either package surviving removal of the other. Malformed handoff evidence is bounded, triggers no preview, and cannot add a fallback route/model call. Real Codex experiments also cover planner failure with zero children and a deterministic 500 ms Pi route timeout whose exact PID and managed worktree were gone before the controller continued. A read-only direct comparison reduced upstream input by 88.5%. A separate non-empty implementation comparison reduced Codex input from 2,266,538 on the controller-first/manual-delegation path to 141,781 with pre-model dispatch (93.7%); this second baseline is not a pure direct run. One later Codex run proved automatic two-child dispatch, disjoint verified artifacts, and upstream integration, but intentionally added no costly direct baseline. Real Claude parity remains a promotion gate. The separately installed `agentknot` CLI is required ([decisions 0027](postmortems/0027-controller-native-integration-boundary.md), [0029](postmortems/0029-controller-cli-and-single-child-delegation.md), [0030](postmortems/0030-pre-model-controller-dispatch.md), [incident 0031](postmortems/0031-bounded-pi-output-drain.md), [experiment 0032](postmortems/0032-pre-model-multi-child-evidence.md), and [incident 0033](postmortems/0033-controller-timeout-phase-claim.md)). |
| **Current** | Independent worker/provider/model routing with built-in Mock, Pi RPC, and OpenCode JSON adapters. | Routing and core Job semantics are adapter-neutral; the planner remains exact Pi/OpenCode Go/Luna/max, the medium/high/default worker target is the human-configured Luna route pool, and the low-complexity rule remains exact Pi/OpenCode Go/DeepSeek Flash/max. |
| **Current** | Reusable route-neutral `WorkerAdapter` conformance tests for Mock, Pi RPC, and OpenCode JSON. | The shared unit kit covers healthy diagnostics, normalized start/text events and output, event-sink failure propagation, and pre-aborted runs. Protocol-specific lifecycle and artifact tests remain at each adapter boundary. |
| **Current** | Optional human-authored route selection and complete-route pools for eligible work. | Active/shadow rules choose configured route targets. A `least-active` pool selects one complete exact route before Job creation, counts explicit member Jobs, rotates equal-load ties, and persists the pool plus exact selection. The repository sends `low` to exact DeepSeek Flash/max and medium/high/default children to the Pi-Luna/native-OpenCode-Luna pool. Deterministic verification passes 234/234; one real simultaneous pair selected and completed both members, and usage reported one hit each. Retries never switch routes; there is no learned ranking, health scoring, or fallback ([decisions 0020](postmortems/0020-human-authored-active-route-selection.md) and [0042](postmortems/0042-complete-route-pool-balancing.md)). |
| **Current** | Optional independent advisory review for one bounded delegated patch. | `delegation.qualityReview` names any configured single-attempt route and eligible parent complexities. One separately persisted depth-one reviewer Job receives bounded verified patch evidence and returns strict `accept`, `changes-requested`, or `uncertain` evidence; it cannot apply, repair, promote, or override the controller. The repository's current no-tool reviewer profile reduced reviewer tokens by 94.1% on one same-task correction and caught a seeded no-mutation defect. Two distinct same-prompt Codex comparisons accepted the reviewed artifacts unchanged, passed their independent checks, and used 36.2% and 48.0% fewer upstream input-plus-output tokens than direct baselines. The second path was 80.5% slower and used 6.6% more non-cached-input-plus-output, so this remains bounded dogfood evidence rather than a fixed model ranking or universal efficiency claim ([decision/experiment 0036](postmortems/0036-bounded-advisory-quality-review.md)). |
| **Current** | Read-only persisted-evidence usage report through CLI and TypeScript. | `agentknot usage` and `runtime.usage()` aggregate exact available downstream adapter-reported token totals and provider cost, report cache-read and active/shadow route-rule hit rates, and keep partial or missing evidence explicit. Pi RPC and OpenCode JSON both normalize exact provider evidence into this shape. Upstream controller usage and upstream/downstream proportions remain unavailable until a comparable exact controller contract exists ([decision 0034](postmortems/0034-persisted-usage-observability-boundary.md)). |
| **Current** | Ordered job/orchestration snapshots and normalized events with retries, timeouts, cancellation, one-shot callbacks, and bounded exact-child Pi supervision. | Implemented and covered by deterministic lifecycle, persistence, callback, and Pi conformance tests; catchable CLI/server shutdown cancels and awaits admitted work, late attempt events are ignored, and the bounded Stage 1 soak verifies exact process-group cleanup. File-backed execution owners hold advisory locks on both storage directories so a second conforming writer is refused before reconciliation or admission. |
| **Current** | Fixed UTF-8 budgets for prompts, metadata, worker events, result output, completion reports, errors, snapshots, callbacks, and patch artifacts. | Oversized admission fails early, bounded evidence carries explicit replacement/truncation state, snapshots and patch artifacts each have a 16 MiB ceiling, and callbacks above 8 MiB are not sent; local records/artifacts remain until exact manual deletion and content is not automatically redacted ([decisions 0023](postmortems/0023-fixed-durable-record-budgets.md) and [0025](postmortems/0025-local-retention-and-redaction-boundary.md)). |
| **Current** | Versioned persisted Job and Orchestration records. | New records carry top-level `schemaVersion: 1`; file reads materialize missing versions as legacy v1 in memory without rewriting bytes and reject explicit unsupported versions. |
| **Current** | Additive terminal Job completion summaries and required real-worker completion reports. | Newly terminal success, failure, and cancellation records include terminal outcome/attempt, controller-captured terminal-artifact path evidence or a stable unavailable reason, and an explicit worker-reported reported/unavailable branch. Normal Pi and OpenCode Jobs must end with one valid strict completion envelope; missing or malformed envelopes fail the attempt even when the worker process exits cleanly and the captured patch is empty and valid. Custom TypeScript adapters may still omit the optional report, while every accepted report remains an unverified worker claim ([incident/decision 0044](postmortems/0044-required-worker-completion-and-canonical-worktree-id.md)). |
| **Current** | Git worktree attempt isolation, patch artifacts, read-only inspection, and delegated-child path-overlap review. | Newly captured artifacts include controller-derived repository-relative `changedFiles` (including `[]`); delegated parent results group exact paths owned by multiple children as potential conflicts and mark missing evidence incomplete. This is not semantic verification or acceptance, and artifacts are never applied, committed, merged, or pushed automatically ([decision 0026](postmortems/0026-child-artifact-path-overlap-review.md)). |
| **Current** | Configuration-only `doctor`, opt-in exact-route `doctor --live`, and HTTP process liveness. | Implemented and covered by diagnostic and HTTP contract tests; live probes are point-in-time evidence and are not run as normal-job preflights. |
| **Current** | Product-owned local service discovery for one exact `127.0.0.1` `serve` process. | After listen, the server publishes one per-user record that later CLI commands and Codex/Claude hooks discover; `agentknot client --json` reports `unconfigured`, `available`, or `unavailable`. Deterministic verification passes 213 of 213, including cross-process and hook-parity gates; stale or malformed records do not trigger local or model fallback. |
| **Experimental** | Reviewed Pi worker profiles/extensions; none is promoted. | Evaluation only: use an exact version or immutable path without global or repository installation, then run repeated same-task Luna/max A/B trials against the minimal profile; completion, artifact verification, and target tests must not regress and session-statistics, elapsed-time, retry, or upstream-intervention evidence must show a repeatable net benefit before promotion. `pi-readseek@0.9.10` regressed its first pair. `pi-lean-ctx@3.9.18` produced two selected, passing artifacts and saved 39.0% total Pi tokens on the larger task, but on an independent smaller task it used 36.2% more tokens and took 45.7% longer; the inconsistent profile is not promoted. See [experiments 0013](postmortems/0013-pi-readseek-profile-ab.md) and [0014](postmortems/0014-pi-lean-ctx-profile-ab.md). |
| **Experimental** | Pi/OpenCode Go/DeepSeek V4 Flash at `thinkingLevel=max` for configured low-complexity dogfood work. | The route passed live probes and one isolated same-task comparison. It is now selected only by the repository's human-authored `low` rule; it is not a claimed intelligence ranking, fallback target, or replacement for Luna on medium/high work. Upstream artifact review remains required. See [experiment 0017](postmortems/0017-deepseek-flash-route-ab.md) and [decision 0020](postmortems/0020-human-authored-active-route-selection.md). |
| **Current** | Native OpenCode JSON worker and configured `opencode-luna` pool member. | The pinned `v1.18.15` adapter passes deterministic protocol/lifecycle coverage plus repeated real Luna/max success, error/nonzero, cancellation, timeout, cleanup, and non-empty artifact evidence. Pi remains the exact planner/reference path, while native OpenCode shares medium/high/default child traffic through a human-authored complete-route pool. Its success signal remains inferred, and OpenCode may create its 40-byte project ID at `.git/opencode`; no efficiency, capacity, ranking, or fallback claim is made ([decisions 0041](postmortems/0041-native-opencode-worker-portability.md), [0042](postmortems/0042-complete-route-pool-balancing.md), and [0043](postmortems/0043-native-opencode-lifecycle-soak.md)). |
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

The repository configuration dogfoods `mode: "auto"` with exact Pi/Luna/max planning, a `luna-workers` default pool containing Pi/Luna/max and native OpenCode/Luna/max, plus one human-authored active rule that sends parent complexity `low` to exact Pi/DeepSeek Flash/max. `medium`, `high`, and no-match children use the pool. Least-active admission counts every active member Job, including explicitly addressed routes, and rotates equal-load ties; each Job persists its logical pool target and selected immutable exact route. Retries stay on that route and never become fallback. The product defaults are `maxChildren: 2` and `maxConcurrency: 2` when dispatch limits are omitted; this repository keeps a six-task pool with six active execution slots. Formal six-child orchestrations at concurrency four, five, and six previously succeeded through Pi/OpenCode Go/Luna/max; at six, all children started within 44 ms and completed on their first attempt. Six is therefore the current repository dogfood setting, not a universal worker or provider capacity guarantee. The scheduler starts only the useful available tasks up to the cap and immediately refills a slot when a worker completes, so two tasks still use two workers and a non-parallel plan still uses one. This delegation semaphore covers planners and orchestration children, not callers that invoke several direct leaf `Job` requests concurrently; direct bursts require caller-side admission control in v1. The planner only returns a strict assessment and is instructed to mark work parallel only when subtasks are independently verifiable, have no execution-order dependency, and have non-overlapping expected write scopes. Delegation and parallelism are separate: one bounded substantive task may become exactly one non-parallel child, and lack of a useful split alone is not a reason to retain it in Codex or Claude. A bounded allowlisted task expected to create or modify a repository file is delegation-first even when small, low-complexity, or non-parallel; generic handoff/review overhead alone is not an upstream reason. Genuinely trivial read-only inspection or a direct answer with no repository-file deliverable may stay upstream when direct execution and review are cheaper ([decision 0035](postmortems/0035-delegation-first-small-repository-deliverables.md)). The planner never names routes: deterministic policy filters task kinds, evaluates the configured rules, persists the effective policy, exact worker prompts, selected targets, evidence, and plan hash, and only then starts child jobs. Child Jobs carry task kind, parent complexity, configured selection evidence, and any pool resolution evidence. A non-parallel assessment automatically reduces its parent to one active child. Product decisions, artifact integration, commits, and pushes remain with the upstream controller.

The successful self-orchestration was evidence for one normal planner-to-plan-to-child run, not standalone evidence of planner fail-fast behavior. Planner failure, timeout, cancellation, and waiting for a shared dispatch slot have separate outcomes and must be established by their deterministic tests; with the default `upstream` fallback, malformed or failed planner output is recorded in a persisted upstream plan, while `fail` terminates the parent before dispatch.

An optional `delegation.qualityReview` policy can run one fresh advisory reviewer Job after exactly one successful child produces exactly one integrity-valid, base-valid, non-empty, non-truncated patch within the review budgets. Eligibility is selected by the parent assessment complexity; the reviewer route is ordinary configuration and can resolve to any worker adapter, provider, model, and effort. Its strict result is persisted as `qualityReview`, but `changes-requested` does not rewrite child or parent success and `accept` does not promote the patch. Skips and failures remain explicit. The controller still inspects, applies if accepted, and validates the artifact. The current repository profile disables reviewer tools and context-file discovery because the complete bounded evidence is already in the prompt; that Pi-specific profile is dogfood configuration, not a core dependency or universal reviewer requirement.

An optional `delegation.artifactValidation` policy adds controller-owned test evidence without asking the worker or reviewer to validate its own claim. For exactly one successful child with exactly one integrity-valid, base-valid, non-empty patch no larger than 32 KiB, AgentKnot creates a second disposable worktree at the recorded base, applies only that recorded patch there, and runs exactly one configured argument vector without a shell. Validation and optional model review start concurrently after child completion. The persisted evidence records the exact arguments, pass/fail/timeout/cancellation/output-limit result, exit status, duration, bounded output, and cleanup outcome. It remains advisory: failure does not rewrite child or parent success, and neither pass nor review acceptance promotes the patch.

Current dogfood evidence used Luna/max planning, the human-authored low-complexity DeepSeek Flash/max route, and Luna/max review on a clean parser fixture whose baseline passed 3/5 tests. The 744-byte one-file artifact passed the controller-owned `npm test` 5/5 in 149 ms while the independent reviewer was still running; the reviewer later returned `accept`, both evidence records preceded the parent terminal event, and the source fixture/worktrees remained clean. This proves the isolated validation lifecycle, not a general completion-rate or token-savings claim ([decision 0037](postmortems/0037-controller-owned-artifact-validation.md)).

Per request, `--delegation never`, `--delegation suggest`, and `--delegation force` can narrow or request behavior. `force` does not bypass global `off`, the child limit, depth limit, or `keepUpstream` policy. Set global mode to `off` when a caller only wants the leaf Job API. `suggest` and `auto` require Git worktree isolation.

### Codex and Claude controller integrations

Stage 2 includes experimental installable plugins under `integrations/`. They are thin controller adapters: both submit the same orchestration request, consume the same terminal record, inspect the same artifact evidence, and leave routing, product decisions, artifact promotion, commit, push, merge, and deployment outside the plugin.

Controller Skills use `agentknot orchestrate --handoff-json`, a compact projection of the persisted terminal record that keeps status, action, route evidence, child IDs and output, errors, parent artifact review, and one compact artifact verification result while omitting event history, policy snapshots, repeated prompts, and execution prompts. The full durable record remains available through existing inspection surfaces. Skills preview only valid non-empty patch content, avoiding repeated full-record and verification output in the upstream context.

The handoff also carries optional advisory `qualityReview` and controller-owned `artifactValidation`. Controller integrations are instructed not to rerun a successful disposable-worktree validation before deciding on the patch; if they deliberately apply it, they still validate the integrated workspace once because that is a different state.

Build and install the AgentKnot CLI once before either controller plugin. The skills check this prerequisite and stop before orchestration if it is absent; they never substitute another worker, provider, or model.

```bash
npm run build
npm install --global --prefix "$HOME/.local" /path/to/agentknot
command -v agentknot
agentknot routes
```

Ensure `$HOME/.local/bin` is on the controller process `PATH`.

For concurrent controller sessions, start one AgentKnot server with the authoritative configuration on the exact loopback host:

```bash
agentknot serve --config /path/to/agentknot.config.json --host 127.0.0.1 --port 7391
agentknot client --json
```

After the one exact `127.0.0.1` `serve` process listens, it publishes a product-owned per-user record containing the actual URL. Later client-capable CLI commands and the Codex or Claude hooks discover that server without a shell-profile edit, per-session export, or repeated `--server` flag. `agentknot client --json` reports `{"status":"unconfigured"}`, `{"status":"available","url":"..."}`, or `{"status":"unavailable","url":"...","error":"..."}`. A stale endpoint or malformed record is an explicit failure: it does not open local storage, start a local runtime, or select another worker, provider, or model. Only the exact host `127.0.0.1` auto-registers; non-127 binds, including wildcard or other loopback spellings, remain explicit through `--server URL` or `AGENTKNOT_SERVER_URL`. This slice adds no daemon, service installer, new protocol, repository scan, or shell mutation.

In discovered or explicitly selected server mode the CLI and both hooks submit, wait, cancel, list, verify, and preview through that server. They do not open local storage, run startup reconciliation, or discover a repository-local AgentKnot configuration. The server owns the shared task pool and configured concurrency once, so more upstream sessions do not manufacture extra worker capacity. `--config PATH` remains the deliberate local override; otherwise `--server URL` and `AGENTKNOT_SERVER_URL` are explicit server overrides, with `--config` and `--server` mutually exclusive. An explicitly set `AGENTKNOT_CONFIG` remains the existing local opt-in. `doctor` and `usage` stay local and are not redirected through discovery. Server failure is explicit and never falls back to a local runtime or another model.

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

After installation or any hook change, review and trust the plugin hook in the controller's native hook UI, then start a new session. `UserPromptSubmit` has no task-category matcher. The hook is a dependency-free I/O adapter: it finds the Git root, honors explicit `AGENTKNOT_SERVER_URL` or `AGENTKNOT_CONFIG`, and otherwise calls `agentknot client --json` once. An available record is passed as `--server` to every remaining CLI call; `unconfigured` preserves the existing repository-local opt-in, while unavailable or malformed discovery fails without local or model fallback. The hook then synchronously calls `agentknot orchestrate --delegation inherit --handoff-json` before the first controller-model request. The existing exact Luna planner decides whether work stays upstream or dispatches; configured low children use exact Pi/DeepSeek Flash/max and medium/high/default children use the Pi-Luna/native-OpenCode-Luna pool. Explicit Skill prompts bypass the hook, and Codex keeps implicit Skill loading disabled.

For delegated work, the hook supplies compact terminal evidence and integrity-valid non-empty patch previews but never applies them. All child outputs share a 24,000-character budget, previews share 32,000 characters, and total model-visible hook context is capped at 60,000 characters. A configured `auto` repository therefore forwards every non-explicit submitted prompt to the configured planner, including prompts the planner later retains upstream; use `off` or `suggest` where that latency or data boundary is unacceptable. No MCP server, wrapper daemon, local semantic classifier, learned router, or fallback model is added; see [decision 0030](postmortems/0030-pre-model-controller-dispatch.md).

### Human-authored route selection

`delegation.dispatch.routeSelection` is optional and disabled when omitted. `mode: "shadow"` records what a rule would choose while retaining `dispatch.defaultRoute`; `mode: "active"` makes the matching configured exact route or pool target authoritative for the planned child and ordinary Job request. The global delegation mode remains a separate setting.

The repository dogfood policy is intentionally small:

```json
{
  "dispatch": {
    "defaultRoute": "luna-workers",
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

There must be 1–20 ordered rules, every `route` target must name an existing configured exact route or route pool and every candidate is validated at config load, and a present `taskKinds` or `complexities` array must be non-empty and unique. Complexity values are only `low`, `medium`, and `high`; when both predicates are present they must both match, and a rule with neither predicate is an explicit catch-all, so the first matching rule wins.

For each eligible planned subtask, AgentKnot evaluates the subtask kind and parent assessment complexity. An active match persists evidence such as `{ "mode": "active", "selectedRoute": "deepseek-flash", "basis": "rule", "ruleIndex": 0 }`; with no match it persists `{ "mode": "active", "selectedRoute": "luna-workers", "basis": "default" }`, with no `ruleIndex`. This legacy field name carries the configured target, which may now be a pool. `ruleIndex` is zero-based and appears only for a rule match. Complexity is assessed once for the parent orchestration, so all children share that complexity; there is no second per-child model judgment.

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

`PlannedSubtask.route`, the child's `request.route`, and its exact `Job.route.name` are all `deepseek-flash` in this example. If no rule matches, the first two retain `luna-workers`; pool admission then snapshots either `luna` or `opencode-luna` into `Job.route.name` and persists the choice in `routePoolSelection`. The selected exact route fixes worker, provider, model, `thinkingLevel`, timeout, and retry policy before execution. A failure remains on that route and never causes silent worker or model fallback.

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

AgentKnot sends the prompt over stdin as JSONL and waits for Pi's `agent_settled` event, so retries and queued continuation events finish before the job is marked complete. After a successful normal run it requests `get_session_stats` and stores only sanitized counts, token totals, cost, and optional context usage under result metadata; unsupported, malformed, or timed-out statistics are advisory and do not turn successful work into failure. These statistics and other Pi activity remain evidence for diagnostics, not a completion report. For normal `run` jobs only, the adapter appends a provider/model-neutral instruction asking the final assistant message to end with one line beginning `AGENTKNOT_WORKER_COMPLETION_REPORT_V1: ` followed by the schemaVersion 1 `WorkerCompletionReport` JSON. The report contains worker-reported `changedFiles`, `checksRun`, `remainingRisks`, and `notes`; every value is a worker claim, not AgentKnot verification. A valid suffix is strictly validated and removed together with its separating newline from `result.output`; a missing, trailing, malformed, or unsupported suffix fails the attempt instead of converting intermediate progress into success. The instruction and parser are not used by `doctor` or `doctor --live`, and no text after the marked line is accepted. The adapter decodes streaming UTF-8 independently of process chunk boundaries, reports malformed frames and missing settlement explicitly, and uses bounded `SIGTERM` → `SIGKILL` supervision for the exact Pi child on timeout or cancellation. Output draining also has a fixed grace window: if an external event sink never settles, the adapter destroys only the owned streams and stops awaiting that task so abort cleanup can finish; the external promise itself cannot be cancelled. It does not perform process-wide cleanup or claim ownership of arbitrary descendants.

Normal `PiRpcWorkerAdapter.run` executions have one bounded record-volume rule: exactly the Pi lifecycle envelopes `turn_start`, `turn_end`, `message_start`, and `message_end` are omitted from `worker.raw`; every received Pi frame still increments `metadata.rawEventCount`, including those four envelopes, and unknown event types remain `worker.raw`. Normalized text/tool/retry events, final output, completion reports, live-probe behavior, route/provider/model/thinking configuration, and global event types are unchanged. This is not a Pi-token-saving claim or general truncation and adds no schema migration, plugin installation, configuration/probe change, or global event-type change.

`OpenCodeJsonWorkerAdapter` invokes `opencode run --pure --format json` and passes the exact resolved `provider/model`, optional thinking variant, and isolated worktree path. It shares the strict JSONL decoder, required completion-report parser, and bounded exact-child supervision with Pi. Because OpenCode exposes no `agent_settled`, normal Job success requires a valid `step_finish`, clean process exit, and the valid final completion envelope; intermediate text plus process success is insufficient. Completed text/tool parts have lower lifecycle fidelity than Pi and are not described as token streaming or tool-start/update events. Exact `step_finish` usage is retained in the same route-neutral usage shape. The adapter uses OpenCode's own private auth store or explicit required environment; `unsetEnvironment` can remove an ambient key and never reads Pi auth. `--pure` disables plugins, but OpenCode's data directory still owns auth/session state, so this is not full data isolation or a sandbox ([decisions 0041](postmortems/0041-native-opencode-worker-portability.md) and [0044](postmortems/0044-required-worker-completion-and-canonical-worktree-id.md)).

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
agentknot serve --config /path/to/agentknot.config.json --host 127.0.0.1 --port 7391
```

The server is the single execution and file-store owner for any number of trusted local clients. Client-capable `run`, `orchestrate`, `routes`, `jobs`, `show`, `delegation`, orchestration inspection, and artifact inspection use the existing HTTP API without constructing another runtime. They honor explicit `--config`, `--server`, `AGENTKNOT_SERVER_URL`, and the existing `AGENTKNOT_CONFIG` local selection before implicit discovery; without those selectors, the registered endpoint is used before the default local configuration. `doctor`, `usage`, and live `--events` remain local-only in this slice. `--server URL` and `AGENTKNOT_SERVER_URL` remain available as explicit overrides, and server lifecycle is explicit; this is not a durable queue, remote fleet, or automatic service manager.

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

Without shared-server mode, read-oriented CLI commands, including `show`, lists, artifact inspection, route and delegation inspection, and both doctor modes, open persisted records without ownership or startup reconciliation. A TypeScript runtime created with `reconcileOnStartup: false` has the same read-only capability boundary: its execution and reconciliation methods refuse calls. Local `run`, local `orchestrate`, and a valid `serve` invocation are execution owners. They acquire non-blocking advisory locks on the canonical Job and Orchestration storage directories before any reconciliation or admission; a second conforming owner exits clearly. Concurrent upstream sessions must use one selected server rather than multiple checkout-relative execution runtimes. Invalid `serve` arguments are rejected before runtime construction.

The file-backed owner helper uses the host `flock` command and holds kernel locks for the runtime lifetime. One-shot CLI commands release them after completion; a server process crash releases them through the kernel. TypeScript callers must call `await runtime.close()` after all admitted work settles; closing while admission or completion is active is refused. After a new owner acquires both locks, all prior nonterminal snapshots are failed once without replay, regardless of recorded PID, so PID reuse or a different PID namespace is not used as takeover authority. Directly constructed stores/runtimes remain an advanced in-process API and do not bypass the documented single-writer responsibility ([decision 0022](postmortems/0022-file-runtime-single-writer-ownership.md)).

After a CLI `run` or `orchestrate` request has been admitted, catchable `SIGINT`/`SIGTERM` cancels that exact execution, awaits its worker cleanup and terminal persistence, and only then releases runtime ownership. HTTP server close first stops new admission, cancels all active Jobs and orchestrations, awaits their completions, and then releases the runtime. A hard kill cannot run these handlers; the next owner fails persisted nonterminal records without replay, but arbitrary descendants or worktrees left by an uncatchable host failure still require exact operator cleanup. `npm run test:stage1-soak` runs the signal, Pi, restart, and worktree matrix in a unique POSIX process group with a 60-second bound and fails after cleaning that exact group if descendants remain ([incident 0024](postmortems/0024-stale-dogfood-test-processes.md)).

Persisted Job and Orchestration records carry top-level `schemaVersion: 1`. File stores accept a missing field as legacy v1 only while reading, materialize it on the returned in-memory record, leave read-only snapshot bytes unchanged, and fail clearly for an explicit unsupported version. This slice adds no migration command or automatic on-disk rewrite.

A newly terminal JobRecord also carries an additive `completionSummary` in TypeScript values, CLI `--json`, HTTP full-record responses, and callback snapshots without a new endpoint or serializer. Its changed paths are copied only from the terminal attempt's controller-captured artifact and retain artifact attempt/SHA-256/base-commit identity; direct mode, missing artifacts, or missing artifact path data produce stable unavailable reasons. A strict custom-adapter report is placed under `workerReported` only after validation; custom adapters may omit it, but the built-in Pi and OpenCode normal-run boundaries require one valid envelope and fail the attempt when it is absent or malformed. AgentKnot never derives a report from prose, worker events, stderr, session statistics, or an empty verified patch. Human CLI rendering is unchanged, and every accepted report remains a claim rather than controller verification ([incident/decision 0044](postmortems/0044-required-worker-completion-and-canonical-worktree-id.md)).

### Usage report

Inspect accumulated persisted evidence without starting a worker, probing a route, or reconciling records:

```bash
agentknot usage
agentknot usage --json
```

The default view groups coverage, downstream tokens, cache efficiency, routing outcomes, advisory-review outcomes, and controller-data gaps for human review; use `--json` for the stable machine-readable report.

The same projection is available as `await runtime.usage()`. It counts every successful Job at most once from its terminal `result.metadata.sessionStats`, sums exact available input/output/cache-read/cache-write/total fields and provider-reported numeric cost, and reports coverage as complete or partial. A valid all-zero record stays valid; missing, timed-out, unsupported, malformed, unsafe, or aggregate-overflow data never becomes zero. The cache-read hit rate is calculated after aggregation as `cacheRead / (input + cacheRead)`, excluding output and cache-write tokens. Routing also reports classified persisted pool selections grouped by logical pool and exact member, so Pi/native-OpenCode distribution is visible without inferring it from provider text.

Route-selection hits come from terminal orchestration plans and their immutable policy snapshots, not the current configuration or a prompt reclassification. Active and shadow evidence remain separate; `basis: "rule"` is a hit even when a rule selects the default route, while `basis: "default"` is an explicit default selection. Missing, malformed, or policy-inconsistent evidence is unclassified and makes coverage partial.

Quality-review counts likewise come only from terminal records whose immutable policy configured a reviewer. The report groups completed, skipped, and unavailable outcomes, strict verdicts, finding severities, reviewer route names, and stable skip/failure reasons. It does not infer whether the controller later accepted, modified, or rejected the patch; that disposition remains `controller-review-disposition-not-persisted`.

AgentKnot does not currently persist exact Codex or Claude controller token usage. The report therefore returns `controller-usage-not-persisted` for `upstream` and `proportions`; it never reports upstream as zero or downstream as 100%. Codex `Stop`/`SessionEnd` hooks do not provide token fields, and transcript parsing is not a stable contract. A future controller adapter may supply comparable exact usage, but this slice adds no transcript parser, telemetry collector, import format, pricing table, dashboard, or HTTP endpoint.

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
    },
    "bounded-review": {
      "adapter": "pi-rpc",
      "command": "pi",
      "commandArgs": ["--no-tools", "--no-context-files"],
      "noSession": true
    },
    "opencode": {
      "adapter": "opencode-json",
      "command": "/absolute/path/to/opencode",
      "unsetEnvironment": ["OPENCODE_API_KEY"]
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
    },
    "quality-review": {
      "worker": "bounded-review",
      "provider": "opencode-go",
      "model": "gpt-5.6-luna",
      "thinkingLevel": "max",
      "requiredEnv": ["OPENCODE_API_KEY"],
      "maxAttempts": 1,
      "timeoutMs": 3600000
    },
    "opencode-luna": {
      "worker": "opencode",
      "provider": "opencode-go",
      "model": "gpt-5.6-luna",
      "thinkingLevel": "max",
      "maxAttempts": 1,
      "timeoutMs": 3600000
    }
  },
  "routePools": {
    "luna-workers": {
      "strategy": "least-active",
      "routes": ["luna", "opencode-luna"]
    }
  },
  "delegation": {
    "mode": "auto",
    "planner": { "strategy": "hybrid", "route": "luna" },
    "dispatch": {
      "defaultRoute": "luna-workers",
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
    "qualityReview": {
      "route": "quality-review",
      "complexities": ["low"]
    },
    "artifactValidation": {
      "argv": ["npm", "test"],
      "timeoutMs": 300000,
      "maxOutputBytes": 65536
    },
    "fallback": "upstream"
  }
}
```

Use `--config PATH` or `AGENTKNOT_CONFIG` for another configuration file. Route and worker names above describe the repository's current dogfood instance only: controller identity, planner, worker, reviewer, adapter, provider, model, and effort are not fixed in core. A leaf `--route`, dispatch default, or dispatch rule may name a pool; top-level default, planner, doctor, and quality-review settings remain exact routes. Pools contain 2–20 unique exact routes, use process-local `least-active` with rotating equal-load ties, and never switch a selected Job during retry. `qualityReview.route` may reference any configured exact route whose resolved `maxAttempts` is exactly one; omission disables review. `artifactValidation` is also optional. Its `argv` contains 1–32 non-empty strings, `timeoutMs` is 1–300000, and `maxOutputBytes` is 1–65536 shared across stdout and stderr. It supplies no shell, command interpolation, custom environment, or alternate working directory; the command runs from the requested repository subdirectory in the disposable validation worktree and inherits the AgentKnot process environment. JSON configuration selects the built-in `mock`, `pi-rpc`, and `opencode-json` worker adapter kinds; it cannot register an arbitrary TypeScript adapter by name. `opencode-json` fixes `run --pure --format json`, maps the exact route to `--model provider/model` and optional `--variant`, uses OpenCode's private auth store or the route's required environment, and can explicitly remove inherited variables through `unsetEnvironment`. For a custom worker, construct `Orchestrator` in TypeScript with an `AgentKnotConfig`, `JobStore`, and a `Map<string, WorkerAdapter>`, and construct `OrchestrationService` separately when orchestration is required; `createRuntime()` is the file-configured path and does not accept a custom adapter factory.

When `workspaceIsolation.mode` is `git-worktree`, AgentKnot requires the supplied workspace's Git repository to have a `HEAD` and a clean index/worktree, including non-ignored untracked files. Each attempt is a detached worktree at the same base commit, named from the existing `job_...` identity exactly once, and the worker receives the matching repository subdirectory. After every attempt, a binary Git patch up to 16 MiB is written under the configured storage directory (including non-ignored untracked files and commits made by the worker after the base commit), and metadata records Git-derived repository-relative `changedFiles` on the job, including an empty array for an empty patch; the exact managed worktree is then removed. A larger patch fails the Job without retry or retained partial artifact. This changed-file list is controller-captured artifact evidence, not a worker claim, task-completion proof, or semantic verification; the terminal completion summary carries it only with artifact identity and keeps worker-reported claims separate, without parsing worker prose or tool events. Patches are artifacts only; AgentKnot never applies them to the source repository. Older persisted artifacts may omit `changedFiles`. Detached worktrees contain committed files only, so ignored dependencies and build outputs must be provisioned by the worker when needed. The compatibility mode is `none` (or an omitted section), which passes the caller's directory directly and does not provide isolation.

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

Automatic delegation requires `git-worktree` mode. Planner and worker agents read and execute commands in separate managed detached worktrees; the supplied source workspace is not modified and resulting patches are handed off as artifacts. A configured artifact-validation command applies one bounded patch only inside another managed disposable worktree and never to the supplied source. It is trusted local command execution with the AgentKnot process's permissions and environment, not a sandbox; only the exact spawned child is supervised, so commands that intentionally leave descendants are outside the cleanup guarantee. A persisted plan never grants source-tree application or artifact promotion. In compatibility mode `none`, leaf jobs may operate directly in the supplied workspace, but `suggest` and `auto` configuration is rejected. Run workers and validation commands only against repositories and credentials appropriate for those processes.

Callback URLs are supplied by trusted local controllers and can make HTTP requests from the AgentKnot host. The body cap does not authenticate, sign, or allowlist the destination. Do not expose the MVP HTTP server to untrusted networks.

Local Job/Orchestration snapshots and patch artifacts are retained indefinitely until an operator deletes their exact files after stopping the execution owner and confirming no active work. Stage 1 has no expiry, garbage collector, cascade deletion, or purge API. Prompts, output, events, metadata, stderr evidence, callbacks, and patches can contain sensitive content; byte limits, allowlisted statistics, and credential-field minimization are not automatic redaction. See [decision 0025](postmortems/0025-local-retention-and-redaction-boundary.md).

## Roadmap

Stage 1's dependable local job loop is complete: the deterministic suite and bounded host soak cover lifecycle, catchable shutdown, fail-without-resume recovery, exact-child Pi cleanup, worktree cleanup, persistence bounds, and artifact handoff, with real Pi/OpenCode Go/Luna/max dogfood evidence. Current limits include one conforming file-runtime writer, fail-without-resume rather than resume, depth one, no automatic artifact integration, no semantic verification of captured paths, and no authentication for the local HTTP service. Stage 2 work remains evidence-gated; broader queues, dependency graphs, remote operation, and fleets are not implied by Stage 1 completion.

See [the roadmap](docs/ROADMAP.md) for scope, non-goals, and exit gates. Native adapters, provider fallback, streaming, sandbox backends, OhMyPi compatibility, remote/fleet features, and automatic model/provider selection are proposals or deferred rather than current capabilities; any future ranking requires separate measured scorecards.

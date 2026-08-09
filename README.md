# AgentKnot

AgentKnot is a small, vendor-neutral control plane for developers and teams that discuss work in one coding agent but want policy-driven execution through interchangeable workers and model providers. It removes controller-specific delegation logic while preserving an auditable plan, isolated job evidence, and explicit artifact handoff.

The controller is intentionally not an SDK-specific concept. Codex, Claude, a CI job, or a custom application submits the same `JobRequest` or `OrchestrationRequest` through the CLI, HTTP API, or TypeScript API. Routes independently select:

```text
controller → AgentKnot orchestration policy → persisted plan → bounded child jobs
                         └──────→ Job API → worker adapter → provider/model
```

The first real worker adapter uses [Pi RPC](https://pi.dev/docs/latest/rpc), a strict JSONL protocol. It can run Pi with OpenCode Go and GPT-5.6 Luna without installing the OpenCode CLI.

To try it, install dependencies and run the deterministic Quick Start below. Use `agentknot run` for an already bounded leaf task or `agentknot orchestrate` when AgentKnot should decide whether and how to delegate.

## Capability status

The labels below are availability claims, not maturity ratings. **Current** means implemented and covered by deterministic tests. **Experimental** means evaluation-only and not a promoted default; its evidence gates are part of the status. **Proposed** and **Deferred** are not available.

| Status | Capability | Evidence or gate |
| --- | --- | --- |
| **Current** | Controller-neutral leaf jobs and bounded depth-one orchestration through CLI, HTTP, and TypeScript, with `off`, `suggest`, and `auto` delegation modes. | Implemented and covered by deterministic API, policy, lifecycle, and persistence tests; callers must invoke the Job or orchestration API rather than relying on native-chat interception. |
| **Current** | Independent worker/provider/model routing with the mock and Pi RPC adapters. | Implemented and covered by routing and adapter tests; current real promotion evidence is specific to Pi/OpenCode Go/Luna/max and does not make another configured route available. |
| **Current** | Ordered job/orchestration snapshots and normalized events with retries, timeouts, cancellation, one-shot callbacks, and bounded exact-child Pi supervision. | Implemented and covered by deterministic lifecycle, persistence, callback, and Pi conformance tests; Pi also suppresses ambient resources and captures sanitized advisory session statistics, while custom adapters retain their own termination obligations. |
| **Current** | Versioned persisted Job and Orchestration records. | New records carry top-level `schemaVersion: 1`; file reads materialize missing versions as legacy v1 in memory without rewriting bytes and reject explicit unsupported versions. |
| **Current** | Additive terminal Job completion summaries and bounded Pi normal-run report emission. | Newly terminal success, failure, and cancellation records include terminal outcome/attempt, controller-captured terminal-artifact path evidence or a stable unavailable reason, and an explicit worker-reported reported/unavailable branch; custom adapters and normal Pi runs may provide a strict report, while missing or malformed Pi envelopes remain explicit unavailable evidence. Deterministic emission is covered; an actual Luna/max dogfood job remains the Stage 1 promotion gate. |
| **Current** | Git worktree attempt isolation, patch artifacts with controller-captured changed-file evidence, and read-only artifact listing, verification, and bounded preview. | Implemented and covered by worktree, changed-path, and artifact tests; newly captured artifacts include Git-derived repository-relative `changedFiles` (including `[]` for an empty patch), while artifacts remain handoff data and are never applied, committed, merged, or pushed automatically. |
| **Current** | Configuration-only `doctor`, opt-in exact-route `doctor --live`, and HTTP process liveness. | Implemented and covered by diagnostic and HTTP contract tests; live probes are point-in-time evidence and are not run as normal-job preflights. |
| **Experimental** | Reviewed Pi worker profiles/extensions; none is promoted. | Evaluation only: use an exact version or immutable path without global or repository installation, then run repeated same-task Luna/max A/B trials against the minimal profile; completion, artifact verification, and target tests must not regress and session-statistics, elapsed-time, retry, or upstream-intervention evidence must show a repeatable net benefit before promotion. `pi-readseek@0.9.10` regressed its first pair. `pi-lean-ctx@3.9.18` produced two selected, passing artifacts and saved 39.0% total Pi tokens on the larger task, but on an independent smaller task it used 36.2% more tokens and took 45.7% longer; the inconsistent profile is not promoted. See [experiments 0013](postmortems/0013-pi-readseek-profile-ab.md) and [0014](postmortems/0014-pi-lean-ctx-profile-ab.md). |
| **Proposed** | Additional native worker adapters, a worker conformance kit, and an independent provider-runtime interface. | Not available; requires a demonstrated lifecycle or observability benefit, or evidence that route data is insufficient, followed by the applicable Stage 2 contract and real-worker gates. |
| **Proposed** | Authenticated local automation, signed callbacks, restart-aware queues/backpressure, approval/policy controls, and an OS-sandbox backend. | Not available; each capability requires its own threat model and the Stage 3 authentication, recovery, approval, and boundary tests. |
| **Proposed** | An explicit artifact-promotion operation. | Not available; it may be considered only if dirty-target, base-mismatch, checksum, and explicit controller/human-approval checks are safe and tested. |
| **Deferred** | Automatic patch application, commit, merge, push, deployment, or pull-request creation. | Not available by design; artifact inspection ends with an upstream controller or human decision. |
| **Deferred** | Remote/team/fleet operation, collaboration surfaces, recursive or dependency-graph swarms, and silent provider/model fallback or optimization. | Not available; these remain conditional or deferred until an explicit PRD/SPEC change and evidence-gated roadmap stage. |

Controllers still choose whether a request enters the leaf Job API or the orchestration API. AgentKnot cannot intercept arbitrary native Codex or Claude chats; a thin controller integration must call `agentknot orchestrate`, `POST /v1/orchestrations`, or `runtime.orchestrate()`.

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

The repository configuration dogfoods `mode: "auto"` with Luna as both planner and worker. The product defaults are `maxChildren: 2` and `maxConcurrency: 2` when dispatch limits are omitted; this repository uses a six-task pool with four active execution slots, while configuration permits at most 6 for each and never allows concurrency above the child count. The scheduler starts only the available tasks up to the cap and immediately refills a slot when a worker completes, so two tasks use two workers and six tasks use at most four at once. The planner only returns a strict assessment and is instructed to mark work parallel only when subtasks are independently verifiable, have no execution-order dependency, and have non-overlapping expected write scopes. Deterministic policy then filters task kinds, persists the effective policy, exact worker prompts, plan hash, and route choices, and only then starts child jobs. A non-parallel assessment automatically reduces its parent to one active child. Product decisions, artifact integration, commits, and pushes remain with the upstream controller.

The successful self-orchestration was evidence for one normal planner-to-plan-to-child run, not standalone evidence of planner fail-fast behavior. Planner failure, timeout, cancellation, and waiting for a shared dispatch slot have separate outcomes and must be established by their deterministic tests; with the default `upstream` fallback, malformed or failed planner output is recorded in a persisted upstream plan, while `fail` terminates the parent before dispatch.

Per request, `--delegation never`, `--delegation suggest`, and `--delegation force` can narrow or request behavior. `force` does not bypass global `off`, the child limit, depth limit, or `keepUpstream` policy. Set global mode to `off` when a caller only wants the leaf Job API. `suggest` and `auto` require Git worktree isolation.

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

## Switching controller or provider

The control protocol does not change when the caller changes:

```bash
agentknot run --source codex  --route luna "..."
agentknot run --source claude --route luna "..."
```

The source is identity and audit metadata; it is not used to choose implementation code.

Provider changes are route-only:

```bash
agentknot run --source claude --route grok "..."
```

The included `grok` route uses Pi with the xAI provider. Update the model ID in `agentknot.config.json` to match the account's available catalog.

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

Read-oriented CLI commands, including `show`, lists, artifact inspection, route and delegation inspection, and both doctor modes, open persisted records without startup reconciliation. `run`, `orchestrate`, and a valid `serve` invocation are execution owners and retain fail-without-resume reconciliation. Invalid `serve` arguments are rejected before runtime construction. This resolves the read-side mutation in [incident 0010](postmortems/0010-read-only-cli-runtime-reconciliation.md), but does not make multiple concurrent execution-owning runtimes or cross-namespace PID liveness safe.

Persisted Job and Orchestration records carry top-level `schemaVersion: 1`. File stores accept a missing field as legacy v1 only while reading, materialize it on the returned in-memory record, leave read-only snapshot bytes unchanged, and fail clearly for an explicit unsupported version. This slice adds no migration command or automatic on-disk rewrite.

A newly terminal JobRecord also carries an additive `completionSummary` in TypeScript values, CLI `--json`, HTTP full-record responses, and callback snapshots without a new endpoint or serializer. Its changed paths are copied only from the terminal attempt's controller-captured artifact and retain artifact attempt/SHA-256/base-commit identity; direct mode, missing artifacts, or missing artifact path data produce stable unavailable reasons. A strict custom-adapter or normal-Pi `completionReport` is placed under `workerReported` only after validation; `undefined` means no envelope was detected and `null` means a detected envelope was malformed or unsupported. AgentKnot never derives it from prose, worker events, stderr, or session statistics. Human CLI rendering is unchanged, and the full Pi evidence gate remains open until an actual Luna/max dogfood job proves emission.

Set `callbackUrl` in the request to receive the terminal job snapshot by HTTP POST.

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
    }
  },
  "delegation": {
    "mode": "auto",
    "planner": { "strategy": "hybrid", "route": "luna" },
    "dispatch": {
      "defaultRoute": "luna",
      "maxChildren": 6,
      "maxDepth": 1,
      "maxConcurrency": 4
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

When `workspaceIsolation.mode` is `git-worktree`, AgentKnot requires the supplied workspace's Git repository to have a `HEAD` and a clean index/worktree, including non-ignored untracked files. Each attempt is a detached worktree at the same base commit, and the worker receives the matching repository subdirectory. After every attempt, a binary Git patch is written under the configured storage directory (including non-ignored untracked files and commits made by the worker after the base commit), and metadata records Git-derived repository-relative `changedFiles` on the job, including an empty array for an empty patch; the exact managed worktree is then removed. This changed-file list is controller-captured artifact evidence, not a worker claim or semantic verification; the terminal completion summary carries it only with artifact identity and keeps worker-reported claims separate, without parsing worker prose or tool events. Patches are artifacts only; AgentKnot never applies them to the source repository. Older persisted artifacts may omit `changedFiles`. Detached worktrees contain committed files only, so ignored dependencies and build outputs must be provisioned by the worker when needed. The compatibility mode is `none` (or an omitted section), which passes the caller's directory directly and does not provide isolation.

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

Callback URLs are supplied by trusted local controllers and can make HTTP requests from the AgentKnot host. Do not expose the MVP HTTP server to untrusted networks.

## Roadmap

The active focus remains dependable local execution, now including the smallest bounded orchestration slice required for controller-independent automatic delegation. Current limits include single-process writers, fail-without-resume restart reconciliation, depth one, no automatic artifact integration, no semantic verification of captured paths, and no authentication for the local HTTP service. The additive completion summary and deterministic normal-Pi report emission are implemented at their owning boundaries, but the full strict worker-report gate remains open until an actual Luna/max dogfood job proves emission. Broader queues, dependency graphs, remote operation, and fleets remain evidence-gated.

See [the roadmap](docs/ROADMAP.md) for scope, non-goals, and exit gates. Native adapters, provider fallback, streaming, sandbox backends, OhMyPi compatibility, and remote/fleet features are proposals rather than current capabilities.

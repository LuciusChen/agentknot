# AgentKnot

AgentKnot is a small, vendor-neutral control plane for developers and teams that discuss work in one coding agent but want policy-driven execution through interchangeable workers and model providers. It removes controller-specific delegation logic while preserving an auditable plan, isolated job evidence, and explicit artifact handoff.

The controller is intentionally not an SDK-specific concept. Codex, Claude, a CI job, or a custom application submits the same `JobRequest` or `OrchestrationRequest` through the CLI, HTTP API, or TypeScript API. Routes independently select:

```text
controller → AgentKnot orchestration policy → persisted plan → bounded child jobs
                         └──────→ Job API → worker adapter → provider/model
```

The first real worker adapter uses [Pi RPC](https://pi.dev/docs/latest/rpc), a strict JSONL protocol. It can run Pi with OpenCode Go and GPT-5.6 Luna without installing the OpenCode CLI.

To try it, install dependencies and run the deterministic Quick Start below. Use `agentknot run` for an already bounded leaf task or `agentknot orchestrate` when AgentKnot should decide whether and how to delegate.

## Current status

This is an MVP. It already provides:

- controller-neutral CLI, HTTP, and TypeScript entry points;
- policy-driven `off`, `suggest`, and `auto` delegation modes;
- strict planner output validation, immutable plan/policy evidence, and bounded child dispatch;
- independent worker/provider/model routing;
- Pi RPC and deterministic mock adapters;
- durable job and orchestration snapshots with ordered events;
- timeouts, retries, cancellation, and completion callbacks;
- optional vendor-neutral Git worktree isolation with per-attempt patch artifacts;
- normalized text, tool, retry, lifecycle, artifact, and stderr events;
- configuration validation, route diagnostics, and HTTP service liveness.

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

The repository configuration dogfoods `mode: "auto"` with Luna as both planner and worker. The planner only returns a strict assessment. Deterministic policy then filters task kinds, caps the plan at four non-recursive children and four concurrent worker processes, persists the effective policy, exact worker prompts, plan hash, and route choices, and only then starts child jobs. A non-parallel assessment automatically reduces its parent to one active child. Product decisions, artifact integration, commits, and pushes remain with the upstream controller.

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
  --mode rpc \
  --provider opencode-go \
  --model gpt-5.6-luna \
  --no-session
```

It disables automatic skill discovery for the background coding worker, sends the prompt over stdin as JSONL, and waits for Pi's `agent_settled` event, so retries and queued continuation events finish before the job is marked complete. Repository context files such as `AGENTS.md` remain available.

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
      "commandArgs": ["--no-skills"],
      "noSession": true
    }
  },
  "routes": {
    "luna": {
      "worker": "pi",
      "provider": "opencode-go",
      "model": "gpt-5.6-luna",
      "thinkingLevel": "high",
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
      "maxChildren": 4,
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

Use `--config PATH` or `AGENTKNOT_CONFIG` for another configuration file.

When `workspaceIsolation.mode` is `git-worktree`, AgentKnot requires the supplied workspace's Git repository to have a `HEAD` and a clean index/worktree, including non-ignored untracked files. Each attempt is a detached worktree at the same base commit, and the worker receives the matching repository subdirectory. After every attempt, a binary Git patch is written under the configured storage directory (including non-ignored untracked files and commits made by the worker after the base commit), metadata is recorded on the job, and the exact managed worktree is removed. Patches are artifacts only; AgentKnot never applies them to the source repository. Detached worktrees contain committed files only, so ignored dependencies and build outputs must be provisioned by the worker when needed. The compatibility mode is `none` (or an omitted section), which passes the caller's directory directly and does not provide isolation.

## API surface

```text
POST /v1/jobs
GET  /v1/jobs
GET  /v1/jobs/:id
GET  /v1/jobs/:id/events
POST /v1/jobs/:id/cancel
GET  /v1/delegation
POST /v1/orchestrations
GET  /v1/orchestrations
GET  /v1/orchestrations/:id
GET  /v1/orchestrations/:id/events
POST /v1/orchestrations/:id/cancel
GET  /v1/routes
GET  /health
```

## Safety model

Automatic delegation requires `git-worktree` mode. Planner and worker agents read and execute commands in separate managed detached worktrees; the supplied source workspace is not modified and resulting patches are handed off as artifacts. A persisted plan never grants automatic artifact application. In compatibility mode `none`, leaf jobs may operate directly in the supplied workspace, but `suggest` and `auto` configuration is rejected. AgentKnot does not claim to be an operating-system sandbox. Run workers only against repositories and credentials appropriate for that worker.

Callback URLs are supplied by trusted local controllers and can make HTTP requests from the AgentKnot host. Do not expose the MVP HTTP server to untrusted networks.

## Roadmap

The active focus remains dependable local execution, now including the smallest bounded orchestration slice required for controller-independent automatic delegation. Current limits include single-process writers, fail-without-resume restart reconciliation, depth one, no automatic artifact integration, and no authentication for the local HTTP service. Broader queues, dependency graphs, remote operation, and fleets remain evidence-gated.

See [the roadmap](docs/ROADMAP.md) for scope, non-goals, and exit gates. Native adapters, provider fallback, streaming, sandbox backends, OhMyPi compatibility, and remote/fleet features are proposals rather than current capabilities.

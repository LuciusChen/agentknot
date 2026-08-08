# AgentKnot

AgentKnot is a small, vendor-neutral control plane for delegating coding tasks to interchangeable agent workers and model providers.

The controller is intentionally not an SDK-specific concept. Codex, Claude, a CI job, or a custom application submits the same `JobRequest` through the CLI, HTTP API, or TypeScript API. Routes independently select:

```text
controller → AgentKnot Job API → worker adapter → model provider/model
```

The first real worker adapter uses [Pi RPC](https://pi.dev/docs/latest/rpc), a strict JSONL protocol. It can run Pi with OpenCode Go and GPT-5.6 Luna without installing the OpenCode CLI.

## Current status

This is an MVP. It already provides:

- controller-neutral CLI, HTTP, and TypeScript entry points;
- independent worker/provider/model routing;
- Pi RPC and deterministic mock adapters;
- durable job snapshots and ordered events;
- timeouts, retries, cancellation, and completion callbacks;
- optional vendor-neutral Git worktree isolation with per-attempt patch artifacts;
- normalized text, tool, retry, lifecycle, artifact, and stderr events;
- configuration validation, route diagnostics, and HTTP service liveness.

## Product and architecture contracts

AgentKnot keeps current behavior, future intent, execution order, and historical rationale separate so roadmap ideas do not silently become product claims:

- [Product requirements](docs/PRD.md) define the user problem, product thesis, scope, and non-goals.
- [Technical specification](docs/SPEC.md) defines current contracts, invariants, limitations, and verification requirements.
- [Roadmap](docs/ROADMAP.md) sequences work through objective exit gates rather than dates or feature wishlists.
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
GET  /v1/routes
GET  /health
```

## Safety model

In `git-worktree` mode, worker agents read, edit, and execute commands in a managed detached worktree; the supplied source workspace is not modified and the resulting patch is handed off as an artifact. In compatibility mode `none`, workers operate directly in the supplied workspace. AgentKnot does not claim to be an operating-system sandbox. Run workers only against repositories and credentials appropriate for that worker.

Callback URLs are supplied by trusted local controllers and can make HTTP requests from the AgentKnot host. Do not expose the MVP HTTP server to untrusted networks.

## Roadmap

The active focus is the dependable local single-job loop: precise persistence and restart semantics, bounded records, failure-contract tests, and an explicit artifact inspection/promotion workflow. Controller/worker portability, local automation policy, and any remote operation are later evidence-gated stages.

See [the roadmap](docs/ROADMAP.md) for scope, non-goals, and exit gates. Native adapters, provider fallback, streaming, sandbox backends, OhMyPi compatibility, and remote/fleet features are proposals rather than current capabilities.

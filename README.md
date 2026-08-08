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
- normalized text, tool, retry, lifecycle, and stderr events;
- configuration validation and health checks.

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
pi --mode rpc \
  --provider opencode-go \
  --model gpt-5.6-luna \
  --no-session
```

It sends the prompt over stdin as JSONL and waits for Pi's `agent_settled` event, so retries and queued continuation events finish before the job is marked complete.

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

The separation between worker and provider is deliberate:

```json
{
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
      "thinkingLevel": "high",
      "requiredEnv": ["OPENCODE_API_KEY"],
      "maxAttempts": 2,
      "timeoutMs": 3600000
    }
  }
}
```

Use `--config PATH` or `AGENTKNOT_CONFIG` for another configuration file.

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

Worker agents can read, edit, and execute commands in the supplied workspace. AgentKnot does not claim to be an operating-system sandbox. Run workers only against repositories and credentials appropriate for that worker, and use Git or another checkpoint before autonomous edits.

Callback URLs are supplied by trusted local controllers and can make HTTP requests from the AgentKnot host. Do not expose the MVP HTTP server to untrusted networks.

## Next milestones

- controller authentication and callback signing;
- per-route sandbox and approval policies;
- OpenCode and Grok native worker adapters;
- worktree isolation and patch/artifact handoff;
- dynamic routing and provider fallback policies;
- live event streaming over Server-Sent Events;
- OhMyPi compatibility adapter.

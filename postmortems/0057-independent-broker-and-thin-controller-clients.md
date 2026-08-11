# 0057: Make the broker independent and controller clients thin

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Affected versions/commits: unpublished Stage 3 controller/service integration through `81e7788`
- Related: [0001](./0001-vendor-neutral-control-plane.md), [0027](./0027-controller-native-integration-boundary.md), [0038](./0038-shared-local-controller-runtime.md), [0040](./0040-product-owned-local-service-discovery.md), [0045](./0045-controller-session-workspace-binding.md), [0053](./0053-controller-owned-planning-handoff.md), [0054](./0054-portable-service-lifecycle.md), [0055](./0055-durable-middleware-kernel.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Incident

The controller integration accumulated responsibilities that belong at different boundaries. A Codex/Claude prompt hook discovered workspaces, persisted session bindings, queried a CLI for endpoint and policy state, and injected the next action. Separately, AgentKnot installed systemd-user or launchd definitions to keep the HTTP owner alive. In a restricted resumed Codex session, the hook's compound command and loopback request were outside the controller sandbox capability even while the service process itself was healthy. Repeated service-manager changes could not repair that controller-to-middleware boundary.

The visible result was repeated `UserPromptSubmit` failures or long policy checks, no reliable automatic handoff, and an architecture that looked like a Codex plugin or service adapter instead of independent middleware. Platform-specific service installation also contradicted the requirement that normal installation be non-invasive and portable.

## Expected invariant

AgentKnot is independent vendor-neutral middleware. Controllers are replaceable clients; workers, providers, and models are replaceable downstream routes. The controller owns semantic planning and acceptance. The middleware owns admission, deterministic policy/routing, scheduling, isolation, lifecycle, and durable evidence. No controller plugin, hook, shell profile, systemd unit, launchd agent, Unix socket, or controller session may be the middleware runtime or state authority.

## Evidence

- The old hook could resolve a repository and print an obligation, but its policy lookup failed when the controller could not execute the selected localhost/CLI path. A native service manager did not change that capability boundary.
- The hook had grown controller-session storage, Git identity, prompt-path parsing, structured tool-path tracking, endpoint discovery, policy parsing, and multiple lifecycle events. None of those functions is required to remind an upstream controller of a stable handoff contract.
- Agent Relay's relevant architectural pattern is an independent broker/node with SDK/HTTP/WebSocket clients and optional harness integrations. Its explicit background node lifecycle uses an application-spawned detached process plus readiness and connection records; MCP is a broker client, not the broker owner. AgentKnot adopts that layering, not Relay's chat, fleet, cloud, or workspace product.
- Process-level tests now prove one broker can serve independent Codex- and Claude-labelled clients, be rediscovered by long-lived MCP across replacement, reject duplicate startup, and recover the same parent/child identity after a hard broker restart.

## Decision

1. `AgentKnotRuntime` and its orchestration kernel run in one independent broker process. CLI, HTTP, TypeScript, and MCP are interfaces to that same kernel; no entry transport creates a second scheduler when using the broker.
2. `agentknot broker run` is the explicit foreground host. `agentknot broker up|status|down` is the cross-platform application-managed lifecycle. `up` spawns the same compiled foreground entry with separate argv, waits for a matching random instance identity and PID, and does not write operating-system service configuration. `serve` remains only a compatibility alias for `broker run`.
3. Local discovery remains a strict per-user client convenience. Broker status and shutdown first match the discovery identity against the live broker identity; stale-record cleanup acquires the discovery ownership lock and cannot remove a newer instance.
4. Remove `agentknot service` plus the systemd/launchd renderer and tests. Native supervisors or containers may still run `broker run` externally, but AgentKnot neither installs nor configures them.
5. `agentknot mcp` is a pure stdio broker client. It resolves the selected broker on every tool call, so one controller MCP process survives broker restart or endpoint change. It exposes policy, configured routes, orchestration admission/status/cancellation, and read-only artifact preview. It never calls `createRuntime`, chooses a model, plans a task, or promotes an artifact.
6. Codex and Claude packages are optional thin edges. Their only prompt hook is stateless and performs no filesystem, Git, CLI, network, policy, runtime, or service operation. It injects a short controller obligation; the normal controller turn authors the strict assessment and calls the common MCP contract. Explicit Skills retain a transport-equivalent CLI fallback.
7. Retain one broker's lifetime ownership of the configured scheduler directories until a separately designed durable multi-executor capacity protocol exists. Durable records remain state authority across broker restart; the lock prevents two local schedulers from executing the same work. Multiple upstream controllers do not require multiple brokers.

## Why this is middleware rather than a Codex plugin

The broker starts and operates without Codex or Claude. Its API accepts a controller-neutral source string and strict handoff. The MCP process can be launched by any compliant client and contains no controller branch. Codex and Claude packages contain presentation and invocation metadata only; deleting either package leaves the broker, API, CLI, other controller, and every downstream route intact.

## Alternatives rejected

### Continue repairing systemd or launchd

Rejected. It changes process supervision but not whether a controller can reach the middleware, adds platform-specific installation state, and makes normal use invasive.

### Let each controller session create its own runtime

Rejected. Concurrent execution owners contend or risk duplicate dispatch, resume still depends on a controller process, and core lifecycle becomes controller-coupled.

### Move planning into the broker so the hook can submit raw prompts

Rejected. It changes the product into a controller/planner, duplicates upstream reasoning, increases downstream work, and violates the strict controller-authored handoff.

### Keep the old workspace/session-binding hook beside MCP

Rejected. The controller already owns task workspace and planning context. Maintaining a second inferred focus state creates stale-path bugs, resume coupling, prompt overhead, and dead code after MCP becomes the common client boundary.

## Consequences

- Normal use writes only configured AgentKnot storage plus the per-user discovery record; it does not modify shell or OS service configuration.
- `broker up` is explicit, portable Node process hosting, not automatic login persistence. Operators who need reboot supervision may configure any external supervisor around `broker run` without changing AgentKnot semantics.
- A broker must exist before execution/evidence tools can succeed. Decision [0058](./0058-controller-neutral-broker-activation.md) adds an explicit common-client start operation from a previously validated product launch profile; missing/failed activation remains reported and no controller-local runtime or alternate model is selected.
- MCP adds the official split `@modelcontextprotocol/server` v2 package and Zod only. The deprecated monolithic SDK was evaluated and removed because it pulled 93 packages; the server-only dependency adds three packages.
- Hook code and its old session-binding tests are deleted instead of kept as a compatibility implementation. Older active controller processes retain their cached plugin until explicitly reinstalled or restarted.

## Verification gates

- [x] Foreground and detached broker lifecycle uses Node process primitives on the same code path, with no systemd/launchd/shell-profile writes.
- [x] `status` and `down` verify exact live instance identity and PID; crash cleanup removes only the matching stale record.
- [x] Two independent controller clients share one broker without constructing a local runtime.
- [x] One long-lived stdio MCP client follows broker restart and route change without owning storage.
- [x] A hard-killed broker recovers one exact parent and child after lease expiry, consumes only the next child attempt, and creates no duplicate Job.
- [x] Codex and Claude hooks are stateless, bounded, fail-closed to empty output on malformed input, and make no external call.
- [x] The Codex plugin validates with the common MCP companion manifest.
- [ ] Run one real eligible repository task through a freshly reinstalled controller package and record terminal artifact evidence plus upstream/downstream usage after the broker/MCP path is stable.

## Privacy and security review

No prompt, transcript, credential, or worker output is added to discovery. The record remains user-owned mode `0600` and contains only URL, random instance ID, and start time. The broker identity endpoint returns process identity but no control token or secret; `down` is a same-user local CLI operation and sends a signal only after the live endpoint matches the unguessable discovery identity. Remote binding, authentication, and hostile-local-user isolation remain outside this local trusted-user slice.

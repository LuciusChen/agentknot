# 0058: Let common clients explicitly activate a non-running broker

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Affected versions/commits: unpublished independent-broker slice after `81e7788`
- Related: [0039](./0039-live-plugin-cache-refresh.md), [0054](./0054-portable-service-lifecycle.md), [0055](./0055-durable-middleware-kernel.md), [0057](./0057-independent-broker-and-thin-controller-clients.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Incident

The independent broker lifecycle was correct when an operator ran `agentknot broker up`, but the common MCP contract exposed only broker status. A detached broker launched from a controlled agent command was later absent: such hosts may reap command descendants when the command or controller boundary ends. A resumed Chirp controller correctly observed `stopped`, but it had no controller-neutral tool to restore the broker and could only report the prerequisite.

The missing capability was not automatic delegation, routing, or recovery. It was explicit application activation at the common client boundary. Reintroducing startup inside a Codex/Claude hook or installing a login service would repeat the architecture error resolved by decision 0057.

## Expected invariant

Any compliant controller should be able to inspect and explicitly activate the same independent broker without knowing AgentKnot repository layout. Hooks remain stateless obligations. Activation must select no worker/provider/model, create no controller-local runtime, and install no system service. A missing or invalid launch selection must fail visibly.

## Decision

1. A successful explicit `agentknot broker up --config PATH [--port PORT]` remembers one broker launch profile containing only schema version, the validated absolute config path, and port.
2. The profile lives in AgentKnot's platform application-config directory: XDG or `~/.config` on Linux, Application Support on macOS, and APPDATA on Windows. It is bounded to 4 KiB, strict, atomically replaced, and mode `0600` where POSIX modes apply.
3. `agentknot_broker_status` adds `launchConfigured` without exposing the path. `agentknot_broker_start` accepts no input, starts or reuses the exact profiled broker through the existing lifecycle implementation, and returns the ordinary lifecycle result.
4. The MCP process remains a client/lifecycle control surface. It may spawn the compiled `broker run` entry but never calls `createRuntime`; the independent broker process remains the runtime and scheduler owner.
5. Controller hooks still perform no discovery, file, network, or process operation. Their obligation tells the normal controller turn to try start once only when status is stopped or unavailable and launch is configured. Identity-matching crash residue may be cleaned; malformed or unidentified state still fails.
6. An explicit `AGENTKNOT_SERVER_URL` forbids local activation. Missing, malformed, or unsafe profile state fails without target-repository scanning, local execution, or route/model fallback.

## Alternatives rejected

### Silent startup from the prompt hook

Rejected. It makes controller integration own lifecycle again, hides latency/failure in `UserPromptSubmit`, and reintroduces sandbox and resume coupling.

### systemd, launchd, login items, or shell-profile startup

Rejected. These are invasive, platform-specific installation state and are not required for correctness. External supervisors remain an optional operator choice around `broker run`.

### Infer configuration from the controller's current repository

Rejected. The current repository is the task target, not necessarily the middleware deployment. Scanning it repeats the wrong-project and resumed-session failures already removed from the hooks.

### Put a runtime inside each MCP process

Rejected. It couples scheduling to controller lifetime and permits competing schedulers. MCP starts the independent broker executable instead.

## Consequences

- Initial setup still requires one explicit validated config selection. Later stopped-broker recovery is one visible controller tool call.
- The launch profile is preference only. Discovery remains current liveness; transactional records and leases remain execution authority.
- A controller/session host may still terminate processes within its own containment boundary. The next compliant client can repeat the idempotent start operation and durable recovery reclaims admitted work after lease expiry.
- Long-lived reboot supervision remains outside AgentKnot installation. Containers and external supervisors may host `broker run` without changing the protocol.

## Verification gates

- [x] Profile path resolution covers Linux/XDG, macOS, and Windows application-config conventions without shell state.
- [x] Profile write/read is strict, atomic, bounded, and mode `0600` on POSIX.
- [x] CLI `broker up` records its exact validated absolute config path and port.
- [x] A stdio MCP process observes stopped/configured, starts the broker, hard-kills it, observes unavailable/crash-stale state, starts it again through identity-safe cleanup, admits work, and a separate client observes the same broker.
- [x] The same MCP process follows a later broker replacement without creating a runtime.
- [x] Codex and Claude hooks remain stateless and byte-identical in behavior; neither invokes startup.
- [ ] Run the freshly installed package in a resumed non-AgentKnot repository session and retain the real status/start/admission evidence.

## Privacy and security review

The profile contains a local filesystem path and port, which are operational metadata but not credentials. It never contains configuration bytes, environment values, prompts, transcripts, routes, models, worker output, or record identities. The start tool accepts no arbitrary command or path and uses the same exact identity/readiness checks as explicit CLI lifecycle. Local broker authentication and hostile same-user process isolation remain separate hardening work.

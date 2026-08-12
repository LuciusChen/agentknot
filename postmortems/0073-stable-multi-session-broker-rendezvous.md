# 0073: Use one stable broker rendezvous across controller environments

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-12
- Owners: AgentKnot maintainers
- Affected versions: pre-release work after `1571002`
- Related: [0040](./0040-product-owned-local-service-discovery.md), [0057](./0057-independent-broker-and-thin-controller-clients.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Incident

An additional Codex session could not reuse the running local broker. It reported that another AgentKnot runtime already owned the storage directory even though its own status lookup said the broker was stopped or unavailable. This made the advertised multi-upstream path unusable.

Host evidence showed one healthy broker, PID `147522`, listening on `127.0.0.1:7391` and owning `/run/user/1000/agentknot`. Two independently started Codex MCP processes had no `XDG_RUNTIME_DIR`; they therefore looked below `~/.cache/agentknot`. The broker and controllers used different discovery records for the same OS user. A controller could not probe the existing owner and attempted startup, which correctly lost the ownership race but surfaced the wrong operational outcome.

The existing cross-process test did not protect this boundary: it gave server and clients the same fixture environment. It proved shared discovery only after assuming the property that failed in production.

## Impact and terminal state

- Severity: high local availability defect for concurrent or resumed controller sessions.
- User impact: a healthy broker became undiscoverable from another controller environment, which then attempted a conflicting runtime start and could not delegate.
- Immediate containment: address the already running broker explicitly while replacing the environment-dependent rendezvous.
- Terminal state: resolved. Heterogeneous controller environments now resolve one stable per-user record and reuse the same broker identity; no shell profile or OS service was added.

## Decision

- Local broker discovery uses one stable platform per-user application-state path derived from the user home (or Windows Local AppData), not a transient runtime or cache selector: `~/.local/state/agentknot/broker` on Linux, `~/Library/Application Support/AgentKnot/broker` on macOS, and `%LOCALAPPDATA%\AgentKnot\broker` on Windows with a home-relative fallback.
- `XDG_RUNTIME_DIR` and `XDG_CACHE_HOME` remain ordinary process environment but do not choose the broker rendezvous. A shell, MCP host, fresh controller, and resumed controller for the same user must resolve the same path even when those variables differ or are absent.
- The detached lifecycle overlays the explicitly selected discovery environment onto the child environment. This keeps library callers and their spawned broker consistent without mutating shell profiles, controller configuration, native service definitions, or target repositories.
- Existing record validation, mode checks, atomic replacement, random identity, HTTP identity probing, and SQLite lifetime ownership remain unchanged. The fix changes only rendezvous selection and child environment propagation; it does not weaken single-owner safety or add a second transport.

## Evidence

- The previous same-environment resolver test was replaced with a heterogeneous-session test. It supplies `XDG_RUNTIME_DIR` to one side and omits it from the other, asserts one Linux result, and checks the platform paths. The existing detached-start test now captures and asserts the actual child environment rather than inferring it only from readiness.
- After building the fix, the exact old owner was stopped and a new broker started as PID `153599`, instance `711355d4-e504-436f-82bf-06aa508eee68`. Concurrent `broker start` calls with and without `XDG_RUNTIME_DIR` both returned `already-running` for that same PID and identity.
- A freshly spawned stdio MCP process with `XDG_RUNTIME_DIR` removed reported that exact broker as running. This is the new-session/resume process boundary; no native service or shell mutation was involved.
- Two real concurrent upstream-labelled orchestrations then used the same broker. `orchestration_a07527a9-1b23-455f-9a1f-58fac0f2f314` selected Pi/OpenCode Go/DeepSeek V4 Flash/max; `orchestration_dc8b5a41-adaf-494e-8f4b-0a9caf9659c3` selected Pi/OpenCode Go/Luna/max. Both succeeded on attempt one with distinct Jobs, strict reported completion summaries, integrity-valid empty artifacts tied to the same admitted dirty-tree snapshot, and no `runtime_restart`, storage contention, or cross-session event identity.

## Consequences

- New controller processes and processes created by resume load the installed MCP command and find the same running broker without an environment prompt or repository scan.
- A controller process that already loaded old JavaScript modules cannot be hot-patched in memory; restarting that controller process is the normal code-upgrade boundary, not an AgentKnot configuration requirement.
- The earlier `XDG_RUNTIME_DIR` placement statement in decision 0040 is superseded by this decision. No user service, systemd unit, LaunchAgent, shell profile, Unix socket, controller-specific runtime, or provider/model fallback is introduced.

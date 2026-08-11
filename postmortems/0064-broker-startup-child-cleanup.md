# 0064: Bound broker startup child cleanup

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Implementation: Delivered in this slice
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Related: [decision 0057](./0057-independent-broker-and-thin-controller-clients.md), [decision 0058](./0058-controller-neutral-broker-activation.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Context

`broker up` spawned the product-owned broker as a detached child and polled discovery for readiness. If readiness exceeded its deadline, startup sent `SIGTERM` to the child PID and immediately returned an error. A child that ignored `SIGTERM` could therefore outlive the failed startup call. A concurrent startup could also observe another broker becoming authoritative without explicitly accounting for its own losing child.

The defect was verified with a real child process that never becomes ready and deliberately ignores `SIGTERM`. Under the previous behavior, the startup promise rejected while that exact child remained alive. A CLI/MCP status difference observed from inside the Codex sandbox was not used as product evidence because the two callers saw different PID and network namespaces.

## Decision

- Keep the independent, explicit, cross-platform broker lifecycle introduced by decision 0057.
- Supervise the exact `ChildProcess` created by a startup attempt rather than relying only on its numeric PID.
- On startup failure or a concurrent losing start, send `SIGTERM`, wait for a bounded grace period, escalate to `SIGKILL`, and wait for confirmed exit.
- If exact-child cleanup still cannot be confirmed, return cleanup failure together with the original startup failure.
- Preserve successful detached steady-state behavior and identity-safe reuse of an already-running broker.
- Add no systemd/launchd unit, shell-profile mutation, controller hook, Unix-only transport, target-repository inference, or model fallback.

## Consequences

A failed startup no longer returns while its known detached child is still unaccounted-for. Concurrent starts retain one authoritative broker and clean up the exact losing child. Startup failure may take the bounded termination grace period before returning, which is preferable to leaking an execution owner or storage-lock holder.

## Verification

- A real spawned child ignores `SIGTERM`, misses readiness, receives escalation, exits, and leaves no discovery record.
- The regression asserts bounded settlement and exact-child exit.
- Existing detached lifecycle, duplicate-start, stale-record, multi-client, and broker-replacement coverage remains green.
- The complete deterministic suite passes with an isolated application runtime directory.

## Alternatives rejected

- **Return immediately after signalling the PID:** retains the verified child-leak race.
- **Install an operating-system service:** is unnecessary for exact-child supervision, invasive, and not portable.
- **Use a controller hook as lifecycle owner:** couples execution correctness to one controller and contradicts decision 0057.
- **Treat sandbox PID visibility as liveness truth:** confuses namespace isolation with product process state and cannot establish a portable defect.

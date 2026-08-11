# 0062: Make durable cursor subscription the wait authority

- Type: Incident / Architecture Decision
- Status: Accepted
- Implementation: Delivered in this slice
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Related: [decision 0052](./0052-bounded-analysis-and-observable-waiting.md), [decision 0055](./0055-durable-middleware-kernel.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Context

AgentKnot already persisted ordered Job and Orchestration events and SQLite exposed `eventsAfter(id, sequence)`, but the service `wait` implementations independently fetched a full record every 100 ms. HTTP wrapped those loops in five-second heartbeats and clients repeatedly called `/wait`. Documentation described middleware-owned wakeup before a shared wakeup primitive existed. Long worker execution therefore looked like opaque controller polling, duplicated Job/Orchestration code, and offered no public replay subscription contract.

Relay provided a useful pattern, not a protocol to copy: durable records are authoritative, real-time delivery is an acceleration path, and disconnected consumers resume from durable inbox/cursor state. AgentKnot needs that property without importing Relay channels, direct messages, controller identities, WebSocket, or agent-chat semantics.

## Decision

- Add one generic `DurableEventSubscription<Event, Record>` over a source with `get` and optional `eventsAfter`. It exposes cursor replay, an `AsyncIterable` subscription, indefinite terminal wait with `AbortSignal`, and the existing bounded snapshot-wait behavior.
- A Job or Orchestration mutation notifies subscribers only after its save succeeds. The persisted record and append-only events remain the sole authority; a notification contains no alternate state.
- Each process-local record signal carries a monotonically increasing version. A subscriber captures that version before reading durable events and checks it again after registering its waiter, closing the read/register missed-wakeup race.
- Process-local notification is only the fast path. A bounded refresh re-reads the durable source so an independent reader, broker replacement, or commit from another process is eventually observed without shared memory. Reconnection continues after the last acknowledged event sequence.
- `Orchestrator`, `OrchestrationService`, and `AgentKnotRuntime` expose the same generic cursor/subscription behavior. Memory and legacy file stores implement cursor reads from their persisted projection; SQLite continues to use its append-only event table.
- HTTP cursor-follow requests return active events after `after` with `nextSequence`, or the terminal record once with its cursor so retained events are not duplicated in one bounded response. The HTTP client, CLI, and the MCP `agentknot_orchestration_follow` adapter reuse that boundary. The old `/wait` endpoint remains a compatibility adapter over the same kernel for now, not a second authority.
- Transport disconnect, iterator cancellation, or MCP client exit does not change Job/Orchestration state. Listener/timer cleanup is owned by the subscription wait and `AbortSignal`.
- The kernel has no controller, worker, provider, model, credential, channel, MCP Task, WebSocket, or operating-system-service branch. Those remain replaceable adapters or configuration.

## Consequences

Same-broker progress wakes readers immediately after commit instead of waiting for the next 100 ms record poll. Cursor replay makes reconnect and broker replacement explicit. Job and Orchestration terminal waits no longer duplicate loops, and MCP-capable controllers may use one bounded follow call rather than repeatedly sampling status.

Cross-process notification is intentionally not claimed: in the absence of a database-native change feed, the durable refresh is the compatibility fallback. A future store may supply a more efficient watcher without changing the public cursor contract. Detached controller resume remains adapter work and general agent-to-agent messaging remains out of scope.

## Verification

- Cursor replay yields only events after the supplied sequence and terminates after the terminal event.
- A deterministic notification inside the read/register window is not lost.
- An independent subscriber with no shared notification observes an external durable change through refresh.
- Abort rejects a pending read and removes its timer/listener.
- Bounded waits return the latest durable snapshot at timeout and wake immediately after a committed terminal mutation.
- HTTP disconnect retries the same durable identity and sequence; MCP follows one cursor batch through the common broker.
- The complete deterministic suite passes 254 of 254 after the change.

## Alternatives rejected

- **Relay-style channels or direct agent messages:** solve a different collaboration problem and would change AgentKnot from orchestration middleware into a communication product.
- **WebSocket or SSE as kernel state:** transport connections are not durable and cannot be the completion authority.
- **Controller-specific resume hooks in core:** violate controller neutrality and still cannot replace cursor replay after restart.
- **Database polling in every adapter:** duplicates lifecycle logic and preserves missed-wakeup races.
- **MCP Tasks as the internal record model:** host support is optional and the transport must remain replaceable.

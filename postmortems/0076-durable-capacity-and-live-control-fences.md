# 0076: Fence shared Job capacity and live-control settlement

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-12
- Owners: AgentKnot maintainers
- Affected versions: pre-release work after `1571002`
- Related: [0055](./0055-durable-middleware-kernel.md), [0062](./0062-durable-event-subscription.md), [0075](./0075-bounded-mcp-wait-and-resume-gate.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Incident

A whole-slice downstream audit found that the new shared Job-capacity and route-neutral live-control paths had narrow settlement races even though the existing 292-test baseline passed:

- reclaiming an expired Job lease did not rebind its already acquired `execution_capacity` row in the same transaction, so another waiter could delete the stale row and acquire before the reclaimed owner registered its new fence;
- the process-local semaphore awaited an asynchronous waiting callback before enqueueing, so callback latency could reorder FIFO admission;
- a Pi RPC control response arriving after the bounded response wait could fall through to the main response handler and reject an otherwise healthy worker run;
- a persisted `job.control.requested` event could be followed by failed receipt and lost-evidence writes, while the worker attempt still persisted success;
- recovery handled durable cancellation before marking pending control requests lost; activity projection also treated capacity waiting as only the final queued event.

The six-path advisory review was `orchestration_59d03c2b-9f45-4712-bda7-5842b3e9564b`. Five workers completed; the documentation worker `job_bf418c92-d223-4375-b920-47f35073cb98` exhausted its 40-call budget and failed. No worker patch was applied, and the failed worker supplied no acceptance evidence.

Final two-path read-only review `orchestration_f534c496-ffb1-4b52-9476-b46edc89224d` completed both Luna/max children. It found three remaining transport-boundary blockers: graceful cleanup released runtime ownership before listener close, HTTP control responses were structurally checked without matching the requested identity, and the bounded MCP cursor could advance from initial-snapshot events rather than completed follow batches. The controller verified and corrected each path before acceptance; worker patches remained empty and advisory.

## Decision

1. Direct, child, and reviewer Jobs share one FIFO capacity boundary. SQLite capacity identity follows the current fenced execution lease atomically; memory/legacy stores retain one abort-aware FIFO semaphore.
2. The configured limit remains `delegation.dispatch.maxConcurrency`. The production lifetime lock remains until a separate multi-executor recovery and configuration-authority protocol exists; durable capacity is not a multi-host scheduling claim.
3. Live control is attempt-bound and advisory. AgentKnot persists the request before delivery and fences the attempt's terminal transition until every persisted request has accepted, rejected, or lost evidence.
4. Recovery marks pending control requests lost before honoring an already persisted cancellation. No control message is replayed across retry or restart.
5. Pi adapter-private control responses are correlated by reserved IDs and quarantined even after timeout. They never settle the main run.
6. Capacity waiting is a lifecycle interval derived from durable events, not merely the last event. A recovery emits fresh waiting evidence for its new execution pass.
7. Runtime close tracks live-control operations. HTTP close attempts listener release even when drain fails; server cleanup settles HTTP close before runtime ownership release, then performs discovery cleanup, while aggregating independent failures.

## Verification

- SQLite interleaving coverage proves a waiter cannot steal capacity between expired-lease reclaim and reclaimed-owner admission.
- A direct semaphore regression proves asynchronous waiting callbacks preserve FIFO.
- A delayed rejected Pi control response arrives after the five-second adapter wait without failing the worker run.
- Forced accepted/lost persistence failures prove a Job cannot persist success while a delivered control request lacks settlement evidence.
- Recovery coverage proves pending control is marked lost before cancellation, and activity tests retain waiting across observer events and recovery.
- HTTP client tests reject exact-record responses whose ID differs from the requested Job or Orchestration.
- HTTP control tests reject mismatched Job, control ID, attempt, and kind; failed-drain coverage proves the listener is still released before runtime ownership can be released.
- MCP deadline coverage proves a cursor does not advance over newer initial-snapshot events until a follow batch acknowledges them.
- The focused build and 97 directly related tests passed before the final full-suite gate.
- After the final review corrections, strict no-unused TypeScript checking, diff checking, and the full 299-test suite passed.

## Consequences

Control persistence failure may leave a Job durably running for higher-fence recovery instead of fabricating a terminal result. This is deliberate fail-closed behavior. The capacity queue does not infer provider health, quota, intelligence, or model choice, and live control does not add controller planning, general agent chat, cross-Job memory, or worker-process reattachment.

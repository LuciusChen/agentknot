# 0075: Bound MCP waiting without controller-session ownership

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-12
- Owners: AgentKnot maintainers
- Affected versions/commits: Unreleased MCP controller boundary
- Related: [decision 0053](./0053-controller-owned-planning-handoff.md), [decision 0062](./0062-durable-event-subscription.md), [decision 0065](./0065-retire-http-wait-aliases.md), [decision 0074](./0074-session-start-controller-entry.md), [SPEC](../docs/SPEC.md), and [ROADMAP](../docs/ROADMAP.md)

## Summary

The MCP Skill told controllers to call the one-batch orchestration follow tool until completion. A five-second heartbeat therefore ended the tool call and returned control to the upstream model even when no semantic decision was needed. Real use showed repeated model turns during one downstream execution.

The correction adds a bounded MCP adapter operation that consumes multiple existing durable follow batches inside one tool call. It returns the terminal handoff when available, otherwise the same orchestration ID and acknowledged sequence for idempotent reattachment. It does not add a broker queue, session registry, controller branch, or automatic resubmission.

## Expected invariant

AgentKnot owns deterministic admission, routing, scheduling, isolation, lifecycle, and durable evidence. The upstream controller owns semantic planning, acceptance, and artifact promotion. A connection may accelerate delivery but cannot own execution state. Cancelling or replacing a controller connection must not cancel or duplicate an admitted orchestration unless the controller separately requests orchestration cancellation.

## Evidence

1. A post-0074 Codex run repeatedly invoked `agentknot_orchestration_follow` after five-second active heartbeats while the same durable child continued to run.
2. The HTTP follow protocol already preserved one orchestration ID, a monotonic sequence cursor, compact progress, terminal evidence, and bounded reconnect. The missing aggregation was only in the MCP adapter.
3. The installed Codex 0.147.0 feature list reported `mcp_2026_07_28: false`. The installed MCP TypeScript SDK 2.0 exposes Task wire types but does not implement a Task runtime, so MCP Tasks are not a current portable completion channel.
4. Codex MCP tool calls have a bounded timeout, and the current controller call metadata does not supply a progress token. The adapter can support standard progress notifications for controllers that do supply one, but must not depend on them for correctness.
5. A public stdio-MCP test proves that one call advances through multiple HTTP cursor batches, emits requested progress, returns an active same-ID cursor at its deadline, reaches terminal state after reattachment without a POST/resubmission, and aborts both a hanging snapshot read and a hanging HTTP follow on MCP cancellation.

Relevant external protocol surfaces are the [Codex MCP documentation](https://developers.openai.com/codex/mcp), [Codex App Server API](https://developers.openai.com/codex/app-server), and the [MCP Tasks extension](https://tasks.extensions.modelcontextprotocol.io/).

## Root cause and decision

The durable subscription kernel returned at the correct transport boundary, but the controller Skill treated the low-level one-batch operation as the user-facing wait operation. Every heartbeat therefore crossed a model boundary. Progress observation and semantic model work were accidentally coupled.

`agentknot_orchestration_wait` now:

- reads one exact durable orchestration and rejects a cursor ahead of durable state;
- applies one default maximum of 40 seconds to the initial exact-ID snapshot and subsequent follow loop;
- consumes successive committed event batches and reconnects only to the same ID;
- returns terminal handoff evidence, or `{ state: "active", id, nextSequence }` advanced only through completed follow batches for idempotent reattachment;
- aborts only its current HTTP follow when the MCP request is cancelled;
- emits standard MCP progress only when the controller supplied a progress token.

The existing `agentknot_orchestration_follow` remains a one-batch diagnostic primitive. No retired HTTP `/wait` alias is restored.

## Alternatives considered

- **Wait indefinitely:** rejected because controller tool timeouts and disconnections must remain bounded and recoverable.
- **Treat heartbeats as model turns:** rejected because it spends upstream inference on transport observation without improving decisions.
- **Inject completion into Codex or Claude sessions from core:** rejected because middleware has no portable authority to mutate a controller transcript or resume an arbitrary session.
- **Bind core execution to Codex App Server threads:** rejected because it is controller-specific and would make the middleware a Codex adapter. A future optional adapter may use a supported resume entry without changing core.
- **Adopt MCP Tasks immediately:** deferred because the installed controller and SDK runtime do not currently support the required path.
- **Add OS notifications, native services, shell hooks, or session polling:** rejected as invasive, controller/session-coupled delivery rather than middleware execution semantics.

## Consequences

For a long active run, the default operation reduces the observation boundary from approximately one upstream tool/model return every five seconds to one per 40-second wait phase, without claiming a strict total-call deadline or measured token ratio because terminal artifact handoff happens after that phase. Current controllers that do not request MCP progress may still display only the generic running tool state during that interval.

This is not detached terminal notification. That roadmap item remains open until a controller adapter demonstrates a supported, idempotent resume entry. The durable cursor and same-ID result are the neutral prerequisite; controller-specific notification must stay outside core.

## Corrective actions and gates

- [x] Add the bounded MCP wait adapter over the shared HTTP cursor/reconnect implementation.
- [x] Prove same-ID cursor resume, no resubmission, optional progress, terminal return, and transport-only cancellation through public stdio MCP.
- [x] Update the Codex and Claude Skills to prefer bounded wait and reserve one-batch follow for diagnostics.
- [ ] Demonstrate a supported idempotent controller resume entry before advertising detached terminal notification.

## Dogfood note

The implementation slice attempted a bounded downstream self-review in `orchestration_02da63cb-b9da-4ce7-b085-14f74745e28a`. Its child exhausted the effective ten-tool-call budget on both attempts and produced no completion evidence. That result is recorded as a failed self-dogfood attempt and is not used as review or acceptance evidence for this change.

A corrected high-complexity, four-path review used a task-specific 16-call budget in `orchestration_1eae4b10-3c92-4660-b997-4164c40e82b2`. Its Luna/max child `job_d705430b-51b5-4957-a1a7-e886854706a5` completed with no patch and no blocking finding. It identified that the initial implementation bounded only the follow loop and omitted MCP cancellation from snapshot reads. The upstream controller first propagated cancellation through both reads and added public preflight-cancellation coverage, then the later whole-slice audit converged both reads and follow onto one wait-phase deadline without an expiry fallback snapshot. The worker verdict remained advisory; the controller performed the corrections and final acceptance.

Final pre-commit review `orchestration_f534c496-ffb1-4b52-9476-b46edc89224d` then found that deadline expiry could derive `nextSequence` from newer initial-snapshot events that had not passed through the resumed follow loop, and that the catch path distinguished only the time of abort rather than the actual composed-signal reason. The HTTP wait update now exposes its completed-batch cursor, MCP begins at the caller cursor, and only the exact wait-signal timeout becomes an active response. Public stdio coverage holds a follow past the deadline with newer snapshot events and proves the returned cursor does not skip them.

## Privacy and security review

The wait result and progress notification contain only existing bounded durable status/activity projections, record identity, and sequence state. They add no prompt, transcript, worker text, credentials, tool arguments/results, controller-session identity, or artifact content.

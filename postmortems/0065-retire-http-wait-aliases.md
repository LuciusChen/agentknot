# 0065: Retire pre-release HTTP wait aliases

- Type: Architecture Decision
- Status: Accepted
- Implementation: Delivered in this slice
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Related: [decision 0062](./0062-durable-event-subscription.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Context

Decision 0062 introduced durable cursor subscriptions and moved every in-tree remote consumer to `GET /v1/jobs/:id/events?after=SEQUENCE` or the Orchestration equivalent. The earlier `/wait` endpoints remained as compatibility aliases, duplicating Job and Orchestration request branches while no CLI, HTTP client, MCP client, test fixture, or released external version depended on them.

The HTTP client also maintained mechanically identical reconnect and cursor-follow loops for Job and Orchestration records.

## Decision

- Remove the unpublished `/wait` aliases and retain cursor follow as the only remote waiting protocol.
- Keep bounded heartbeats, same-ID reconnect, transport-failure reporting, and cancellation behavior unchanged.
- Share one generic reconnect loop between Job and Orchestration client waits.
- Share one generic cursor-follow decoder between Job and Orchestration clients.
- Share one terminal-status predicate across the leaf, parent, HTTP client, and HTTP server paths.

## Consequences

The server has one less compatibility surface and fewer duplicated branches. Remote clients resume only through a sequence cursor, so documentation and implementation describe one protocol. Existing response checks remain at their prior depth; this slice does not add a second domain validator to the HTTP client.

This does not remove the TypeScript runtime's bounded `waitForJob` or `waitForOrchestration` methods; those are local durable-subscription APIs, not the retired HTTP aliases.

## Verification

- Repository search shows no in-tree consumer of the removed HTTP paths.
- Both removed paths return 404 for otherwise existing Job and Orchestration identities.
- Existing cursor-follow, reconnect, abort, Job, Orchestration, CLI, and MCP tests remain green.

## Alternatives rejected

- **Keep aliases until a versioned release:** creates a compatibility obligation for a surface with no released consumer.
- **Duplicate the complete persisted schema validator in the HTTP client:** would replace one shallow cast problem with a large second domain model and increase implementation drift.
- **Remove local durable wait APIs:** would conflate transport cleanup with the shared subscription kernel.

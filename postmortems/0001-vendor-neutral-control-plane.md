# 0001: Separate controller, worker, and provider/model routing

- Type: Decision
- Status: Accepted
- Date: 2026-08-08
- Owners: AgentKnot maintainers
- Affected versions/commits: Initial 0.0.x architecture
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [Agent Workforce Relay](https://github.com/AgentWorkforce/relay)

## Summary

AgentKnot uses one controller-neutral Job API, a core orchestrator, narrow worker adapters, and independently named provider/model route fields. Codex, Claude, CI, and custom applications are callers rather than privileged runtimes. Pi is the first real worker, not the permanent center of the architecture.

## Context

The motivating workflow was to discuss and approve an implementation in one control environment, then delegate execution to Pi using OpenCode Go/Luna, with the ability to replace Luna with Grok and later replace Codex with Claude.

A direct Codex-to-Pi script would solve the first demonstration but couple the controller, worker, provider, credential flow, and lifecycle. Copying a broader agent-communication system would solve problems AgentKnot does not yet have.

Relay provided useful evidence that runtime/harness details can live behind a declared contract while a separate layer owns durable coordination. Its channels, messaging, workspace, cloud, and fleet responsibilities do not match AgentKnot's smaller local execution-handoff goal.

## Expected invariant

- Controller identity is audit metadata and never selects core behavior.
- The orchestrator owns job lifecycle; adapters own worker processes and protocols.
- Worker, provider, and model can evolve independently at their actual boundaries.
- Only implemented capabilities are advertised.

## Evidence chronology

1. The CLI, HTTP, and TypeScript paths were implemented over the same `JobRequest` and orchestrator.
2. Mock and Pi RPC workers were registered through the same `WorkerAdapter` interface.
3. OpenCode Go/Luna and xAI/Grok were represented as routes using the Pi worker.
4. Real Pi/Luna execution was run through AgentKnot without an OpenCode CLI dependency.
5. The same route accepts free-form `source` values such as Codex and Claude without behavior branches.

## Decision rationale

The smallest stable seam is a job execution contract, not agent-to-agent conversation. It gives controllers one automation surface and keeps provider-specific startup inside the selected worker. Routes make model choice explicit and auditable without prematurely inventing a full provider SDK.

AgentKnot therefore owns admission, route snapshots, state, attempts, persistence, cancellation, retries, workspace lifecycle, normalized events, and artifact handoff. Worker adapters own availability, process startup, protocol translation, and child-process termination.

## Alternatives considered

### Build only a Codex plugin or skill

This would automate the immediate controller but make Claude and CI second-class integrations. It was rejected as the core architecture; controller-specific convenience wrappers may still call the neutral Job API.

### Use Pi directly

Pi already provides a capable coding harness and remains the preferred first worker. Direct use does not provide a shared durable job, routing, attempt isolation, callback, or controller-neutral automation contract.

### Make MCP or skills the only integration

MCP and skills are useful controller entry points but should be optional adapters. HTTP, CLI, and TypeScript allow more automated and non-interactive callers without changing execution semantics.

### Copy Relay's broader architecture

Relay solves durable agent communication and collaboration across runtimes. Reproducing channels, threads, presence, fleets, or hosted infrastructure would expand scope before AgentKnot proves dependable local execution. Relay remains a reference or possible future integration, not a runtime dependency.

### Add a provider interface immediately

The current real worker, Pi, already accepts provider/model settings. A separate provider runtime abstraction would be speculative until another worker path demonstrates different ownership. Provider independence is therefore an explicit routing property today.

## Consequences

### Positive

- Controllers share one API and audit model.
- Pi can be replaced or complemented without rewriting lifecycle policy.
- Provider/model changes are normally configuration changes.
- The system can be dogfooded by delegating bounded reviews to Pi/Luna.
- Relay concepts can be adopted selectively without inheriting its product surface.

### Costs and risks

- The terms "provider-neutral" and "durable" can be overstated relative to current implementation.
- Adapter contracts need conformance tests before multiple real workers are promoted.
- Controller-specific interactive features must be translated into the neutral contract or remain external.
- A future independent provider runtime may require a versioned boundary change.

## What went well

The first vertical slice demonstrated the separation with both deterministic and real workers before adding broader abstractions. Routes already permit Luna and Grok configuration without a controller branch.

## What did not go well

Early roadmap language listed native adapters, dynamic routing, fallback, streaming, and OhMyPi together without gates, making exploratory ideas look like near-term commitments. The original short `AGENTS.md` also did not preserve architectural boundaries strongly enough.

## Corrective actions and gates

- [x] Define product thesis and non-goals in the PRD.
- [x] Freeze boundary ownership and current limitations in the SPEC.
- [x] Replace an unstructured milestone list with gated stages.
- [ ] Add controller contract examples for Codex and Claude — Stage 2.
- [ ] Add worker-adapter conformance tests before promoting a second real adapter — Stage 2.
- [ ] Introduce a provider runtime abstraction only after evidence shows route data is insufficient — separate decision record.

## Deferred work

Native worker adapters, provider fallback, remote agents, and Relay integration remain deferred to their roadmap gates. No collaboration or fleet feature is implied by this decision.

## Privacy and security review

No credentials or job payloads are included in this record.

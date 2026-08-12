# 0071: Defer Pi durable-harness migration until executable parity

- Type: Architecture Decision / Dependency Review
- Status: Accepted / Deferred
- Date: 2026-08-12
- Owners: AgentKnot maintainers
- Affected versions: AgentKnot `1571002`; Pi `0.84.1` and Pi `main` on 2026-08-12
- Related: [decision 0001](./0001-vendor-neutral-control-plane.md), [decision 0003](./0003-skill-minimal-pi-workers.md), [decision 0059](./0059-retire-native-opencode-worker.md), [ROADMAP](../docs/ROADMAP.md), [SPEC](../docs/SPEC.md)

## Summary

Pi has publicly exported the proposed `AgentHarness` type surface, but its durable execution surface is not usable yet. The released `@earendil-works/pi-agent-core@0.84.1` package and Pi's current `main` both reject `prompt`, `resume`, `steer`, `followUp`, `watch`, lane management, and restored-session creation with `HarnessNotImplemented`.

AgentKnot therefore keeps Pi RPC as its reference real-worker transport. A future Pi harness migration is allowed only inside the worker-adapter boundary and only after a released implementation passes the existing route-neutral conformance, lifecycle, completion, artifact, cancellation, timeout, usage, and soak gates. Pi session state must not become the authority for AgentKnot Job or Orchestration state.

## Context

Pi's former `packages/agent/docs/harness-v2.md` was consolidated into [`packages/agent/docs/harness.md`](https://github.com/earendil-works/pi/blob/main/packages/agent/docs/harness.md) on 2026-08-11. The new specification describes a durable conversation runtime with sessions, multiple lanes, a usage ledger, recoverable operations, snapshots, events, `steer`, and `followUp`. Those capabilities could eventually improve worker lifecycle fidelity and permit a more structured implementation of route-neutral activity and control features.

AgentKnot currently launches Pi `0.84.1` in `--mode rpc`. Pi's current RPC implementation still receives an `AgentSessionRuntime`, not the new durable `AgentHarness`. AgentKnot maps that documented JSONL protocol into its own `WorkerAdapter` events, terminal completion contract, usage evidence, and process supervision.

## Evidence

- The user-supplied `harness-v2.md` raw URL returns HTTP 404 because commit [`85a2060`](https://github.com/earendil-works/pi/commit/85a2060811a23f1580c13ab59a210b1409092837) consolidated the specification into `harness.md`; this is a rename, not proof of withdrawal.
- The current specification calls itself an **implementation specification** and includes an explicit multi-slice build order. Its public target surface includes `AgentLane.prompt`, `resume`, `abort`, `steer`, `followUp`, `watch`, multiple lanes, events, and usage.
- npm publishes `@earendil-works/pi-agent-core@0.84.1`, and the package root exports `AgentHarness` and its types.
- In that released package, the execution methods above call an unavailable helper that throws `HarnessNotImplemented`. Restoring a non-empty session also throws `HarnessNotImplemented("create.restore")`.
- Pi `main` retained the same placeholders when checked on 2026-08-12. Its `packages/coding-agent/src/server/create-harness.ts` is integration scaffolding, while `packages/coding-agent/src/modes/rpc/rpc-mode.ts` still operates on `AgentSessionRuntime`.
- Pi's current [RPC documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) continues to specify the commands and evidence AgentKnot uses, including `set_thinking_level`, `get_session_stats`, `agent_settled`, `steer`, and `follow_up`.

## Decision rationale

“Source-visible and exported” is not the same as “implemented and safe to depend on.” Migrating now would replace a functioning, documented process protocol with an in-process API whose primary execution methods deliberately fail. It would also couple AgentKnot's release cadence and process isolation to an actively changing pre-1.0 runtime without delivering a user-visible capability.

The existing architecture already contains the dependency correctly: Pi CLI and RPC semantics live in `PiRpcWorkerAdapter`; Job durability, scheduling, routing, completion provenance, and artifacts do not. When the new harness becomes executable, a new or revised Pi adapter can map its events and results onto the same core contract. No Pi lane, storage, queue, event, or session type may enter core records or public Job schemas.

## Consequences

- No current AgentKnot code path changes solely because the harness specification exists.
- Pi RPC remains supported and must continue to receive compatibility tests as Pi versions move.
- The new harness is a candidate for better exact worker activity, durable worker resume, and live control, not a replacement for AgentKnot's broker, scheduler, Job store, completion envelope, or artifact authority.
- Initial parity must preserve the current isolated, sessionless-per-attempt behavior. Reusing one durable Pi session or its lanes across AgentKnot Jobs is a separate context-retention feature with cross-Job isolation and quality risks; it is not an incidental part of the transport migration.
- A future migration may substantially replace `src/adapters/pi-rpc.ts`, its Pi fixtures, and adapter-specific tests. It should not require changes to route selection, orchestration planning, worktree ownership, artifact review, or controller integrations.
- AgentKnot must not advertise harness-backed resume, lanes, watch, `steer`, or `followUp` until the selected released Pi version implements them and AgentKnot exposes any corresponding feature through a route-neutral capability contract.

## Alternatives considered

- **Migrate to the exported API now:** rejected because the execution surface is an intentional placeholder.
- **Build against Pi `main` internals:** rejected because current `main` is also incomplete and would create an unversioned dependency.
- **Fork or finish Pi's harness inside AgentKnot:** rejected because AgentKnot is middleware, not the owner of Pi's runtime implementation.
- **Ignore the new design until RPC breaks:** rejected because the published direction identifies a real future compatibility risk and useful lifecycle capabilities worth tracking.

## Corrective actions and gates

- [ ] Maintainers — recheck a released Pi package after `prompt`, restored `create`, `watch`, and terminal results no longer throw `HarnessNotImplemented`.
- [ ] Maintainers — determine whether Pi coding-agent's supported headless boundary remains RPC, moves to a server/client protocol, or exposes a stable in-process harness; do not infer this from type exports.
- [ ] Maintainers — run side-by-side conformance for success, explicit incomplete output, provider failure, cancellation, timeout, completion evidence, exact tool events, usage, process/resource cleanup, concurrent Jobs, and worktree artifacts.
- [ ] Maintainers — keep the parity adapter one isolated Pi session per Job attempt; evaluate durable cross-Job context or lane reuse only as a separate evidence-backed feature.
- [ ] Maintainers — add route-neutral control or resume capabilities only when at least one implemented worker supplies exact semantics and unsupported workers can report the capability as unavailable without emulation.
- [ ] Maintainers — remove the superseded Pi path after parity and soak; do not retain two production Pi implementations indefinitely.

## Privacy and security review

The review used public Pi source, documentation, npm metadata, and local version/configuration fields. No credential value, provider response, private prompt, or repository artifact was retained.

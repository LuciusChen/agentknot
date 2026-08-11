# 0059: Retire the native secondary CLI worker

- Type: Decision
- Status: Accepted
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Supersedes: The current implementation claims in [decisions 0041](./0041-native-opencode-worker-portability.md), [0042](./0042-complete-route-pool-balancing.md), and [0043](./0043-native-opencode-lifecycle-soak.md)
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Context

The native OpenCode CLI worker was promoted as a second real runtime to demonstrate that Pi could be replaced without changing controller-neutral Job semantics. The surrounding generic contracts remain useful, but the repository no longer needs to ship or maintain direct OpenCode CLI execution as a built-in path. Keeping the adapter would retain a large protocol, credential, lifecycle, fixture, and documentation surface for a runtime that is not required by the current local execution handoff.

## Decision

- Remove the native `opencode-json` worker adapter, its configuration kind, registry branch/export, direct routes, fixtures, and adapter-specific tests.
- Keep Mock as deterministic built-in evidence and Pi RPC as the sole built-in real worker adapter.
- Keep the generic `WorkerAdapter`, route, route-pool, scheduling, isolation, lifecycle, completion-summary, usage, and controller-neutral contracts unchanged.
- Keep provider/model selection as route data. Pi routes may continue to use configured downstream providers such as OpenCode Go; AgentKnot does not invoke the OpenCode CLI directly.
- Do not add a compatibility shim, replacement adapter, capability registry, or special-case route. A future real worker must clear a new complete conformance and lifecycle evidence gate before promotion.
- Treat decisions 0041–0043 and other native-worker records as historical evidence. They are not rewritten; current product/specification/roadmap documentation no longer presents their retired implementation as available.

## Consequences

The built-in JSON configuration boundary now accepts only `mock` and `pi-rpc` worker kinds. The repository dogfood configuration uses Pi for normal and reviewer routes while retaining its configured downstream provider/model routes. Generic route pools remain available for any complete configured routes, but the repository no longer claims a heterogeneous Pi/native-OpenCode pool.

Removing the adapter also removes its independent OpenCode credential-path handling, CLI command invocation, JSONL settlement rules, OpenCode-specific statistics normalization, and Git common-directory side-effect documentation from current runtime behavior. Pi's existing provider credential and session-statistics boundaries remain unchanged.

Historical native OpenCode Jobs, artifacts, measurements, and lifecycle evidence remain valid records of the earlier implementation and are not evidence that the retired adapter is available now. This retirement does not claim that Pi is an operating-system sandbox or that provider/model routes are interchangeable without configuration.

## Verification

- TypeScript configuration and the built-in registry expose only Mock and Pi RPC adapters.
- Native adapter source, direct-adapter tests, and the fake native fixture are absent.
- Repository configuration contains no native OpenCode worker, route, command, or pool member.
- Current README, PRD, SPEC, and ROADMAP describe Pi as the sole built-in real worker and retain only intentional downstream-provider references.
- The complete deterministic repository test suite passes 242/242 after removing the 15 adapter-only tests.

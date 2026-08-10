# 0041: Add a native OpenCode worker to prove downstream portability

- Type: Decision / Experiment
- Status: Accepted
- Implementation: Delivered in this slice
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Supersedes: The implementation deferral in [decision 0028](./0028-native-opencode-adapter-evidence-gate.md)
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Context

Decision 0028 correctly rejected a native OpenCode adapter when its only proposed value was an inconsistent token or elapsed-time advantage over Pi. The product question has since become sharper: a worker means the complete downstream runtime/protocol boundary, not an API key slot inside Pi. AgentKnot cannot claim that Pi is replaceable until a second real runtime reaches the existing `WorkerAdapter` boundary without changing core Job semantics.

The user selected this portability and lifecycle evidence as the material benefit that reopens the gate. It does not turn the earlier mixed A/B measurements into an efficiency claim. Provider, model, and thinking level remain route data; the adapter must not contain a Luna/DeepSeek allowlist, intelligence ranking, fallback, or Pi credential translation.

## Decision

- Add the built-in JSON configuration kind `opencode-json`. It invokes pinned or user-configured OpenCode CLI with adapter-owned `run --pure --format json`, the exact resolved `provider/model`, optional exact `--variant`, explicit `--dir`, and the supplied prompt.
- Keep Job state, attempts, timeout, cancellation policy, workspace isolation, artifact capture, persistence, callbacks, and terminal summaries unchanged in core.
- Share strict chunk-safe JSONL decoding, command discovery, bounded exact-child termination, output draining, and the route-neutral completion-report suffix with Pi instead of copying those mechanisms.
- Infer OpenCode success only after at least one valid `step_finish`, no `error`, clean process exit, and no abort. This is weaker than Pi's explicit `agent_settled` and remains named as inferred process settlement.
- Normalize `step_start`, completed text parts, terminal tool evidence, stderr, and unknown events only at the adapter boundary. Do not invent token streaming, tool-start/update, retry, interactive approval, or explicit settled events that OpenCode JSON does not expose.
- Accept OpenCode-owned mode-0600 auth or explicitly required environment credentials. `unsetEnvironment` lets a worker remove selected inherited variables so the repository dogfood route can use its independently configured OpenCode credential instead of an ambient Pi/provider key. Credential values are never copied, translated, persisted, or reported.
- Reuse the strict AgentKnot completion-report prompt contract for normal Jobs. This contract belongs to `WorkerAdapter` output, not Pi. Live probes do not append it.
- Normalize exact provider-reported OpenCode `step_finish` input/output/cache/total tokens and cost into the existing route-neutral persisted usage shape. Provider totals are retained as reported and are not reconstructed from components.
- Add a manually selectable `opencode-luna` dogfood route using the pinned OpenCode `v1.18.15` executable, OpenCode Go, `gpt-5.6-luna`, and `thinkingLevel=max`. Planner/default/low-complexity policies remain unchanged and do not silently select or fall back to this route.

## Evidence

- The delegated Luna/max read-only audit completed as orchestration `orchestration_56e9fafa-56c4-40e3-bbee-d0a3d0191ba0` with one verified empty artifact. It confirmed that the current `WorkerAdapter`, route, orchestrator, workspace, and diagnostic contracts need no core semantic change.
- Deterministic OpenCode fixtures pass the shared adapter conformance kit and adapter-specific cases for exact argv, independent private auth, split JSONL, malformed/error/incomplete/nonzero settlement, event-sink failure, pre-abort, active cancellation, core timeout, SIGTERM-to-SIGKILL exact-child cleanup, live probe, usage, completion report, registry construction, and controller-captured worktree artifacts.
- Exact-route live inference through `opencode-luna` succeeded using `credentialSource: opencode-auth-file`; no Pi worker or model fallback was involved.
- A real isolated native Job succeeded on attempt one through OpenCode Go/Luna/max, retained 6,439 provider-reported total tokens and cost `0.000943025`, emitted a valid completion report, captured a checksum-valid empty patch, left the source clean, and removed the managed worktree.

## Consequences and remaining gates

- Pi is no longer privileged by the runtime architecture: two real built-in worker protocols can reach the same core contract. Pi remains the promoted default/reference path; native OpenCode is experimental and manually selected.
- `--pure` disables plugins, while explicit workdir and AgentKnot worktrees isolate repository mutations. OpenCode's ordinary data directory remains OpenCode-owned because it also contains the independently provisioned auth entry; this slice does not claim full config/data/cache isolation or an OS sandbox.
- The pinned JSON surface reports completed text/tool parts and process exit, not Pi-equivalent lifecycle fidelity. Exact child ownership does not imply arbitrary descendant cleanup.
- Stage 2 remains in progress until repeated real native success/failure/cancellation/timeout soak evidence is retained and the generic heterogeneous route-pool decision is implemented separately. No efficiency, completion-rate, model-quality, capacity, fallback, or automatic-routing claim is made here.

## Alternatives rejected

- **Keep Pi as the only real adapter:** rejected because it leaves whole-runtime replaceability architectural rather than demonstrated.
- **Treat a second API key inside Pi as a second downstream:** rejected because credentials are configuration inside one worker, not a different runtime/protocol boundary.
- **Hard-code Luna and DeepSeek in the adapter:** rejected because workers, providers, models, and effort are independent route dimensions and will change.
- **Add route pooling inside the adapter:** rejected because heterogeneous balancing belongs above complete resolved routes and must not depend on Pi or OpenCode internals.
- **Copy Pi auth into OpenCode:** rejected unchanged from decision 0028 because it defeats independent downstream configuration and expands the credential boundary.

## Addendum: 2026-08-10

[Decision 0042](./0042-complete-route-pool-balancing.md) delivered the separate generic pool layer. The repository now uses native OpenCode/Luna/max as one human-configured `luna-workers` member alongside Pi/Luna/max for medium/high/default children; the first real two-Job pool run selected and completed both routes without fallback. This does not change the native adapter's remaining repeated failure/cancellation/timeout soak gate.

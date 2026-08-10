# 0028: Defer a native OpenCode adapter until it proves value over Pi

- Type: Decision
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `d010e87`
- Related: [decision 0001](./0001-vendor-neutral-control-plane.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

Do not implement a native OpenCode CLI worker merely because its protocol is usable. A second real adapter must first demonstrate a correctness, lifecycle, observability, isolation, maintenance, or measured efficiency benefit over Pi on the same approved OpenCode Go route. It must also have its own credential path; AgentKnot will not read Pi auth and translate or copy it into OpenCode.

The unused xAI/Grok repository route is removed in the same slice. The formal candidates remain Pi/OpenCode Go/Luna/max and the human-authored low-complexity Pi/OpenCode Go/DeepSeek V4 Flash/max route, with no fallback.

## Evidence

Read-only orchestration `orchestration_3a1fff9b-6473-46f6-ae3a-d3d12a752ae0` split contract, OpenCode, and Pi reviews across three Luna/max workers. They found that Pi already supplies structured events, exact-child bounded cleanup, route propagation, isolated working directories, credential-source diagnostics, completion reports, and controller-owned artifact handoff.

The official [OpenCode `v1.18.15` release](https://github.com/anomalyco/opencode/releases/tag/v1.18.15) release archive checksum had already been verified against SHA-256 `d842e0e8c622c672a481b7dc6f0329009b64db96b2ba6041e56f4f93f0293b1c`. Its pinned executable is retained outside the repository at `/home/lucius/.local/lib/agentknot/workers/opencode/1.18.15/opencode`, with installed-binary SHA-256 `c1971d3d4d42abe8e15b2e320ecc1acbdb8377914d4e2cfa47c9bce2316caa7d`. A direct isolated `--pure` OpenCode CLI probe of `opencode-go/gpt-5.6-luna` with variant `max` succeeded. The executable and [CLI contract](https://opencode.ai/docs/cli/) confirmed:

- `run --format json`, `--model provider/model`, `--variant max`, `--pure`, and `--dir`;
- ACP startup with nd-JSON and an explicit working directory;
- no native AgentKnot completion-report or artifact contract.

Material unknowns remain: the documented JSON run surface has no explicit final-success envelope, [configuration sources merge rather than replace one another](https://opencode.ai/docs/config/), and exact-child/descendant cleanup has not passed the AgentKnot soak. An independent `opencode-go` credential exists in OpenCode's own mode-0600 auth store; its value is not recorded here, and AgentKnot does not read or translate it. The direct probe used no repository plugin or repository mutation.

Two same-task Luna/max pairs produced correct scoped results:

- On the read-only audit, AgentKnot→Pi completed in 74.010 seconds with 16 tool calls, 178,364 total tokens, provider-reported cost `0.009371415`, a valid zero-byte patch artifact, and a clean source repository. A fully metered direct OpenCode repeat completed in about 44.0 seconds with 19 tool calls, 118,110 total tokens, cost `0.008065585`, and a clean source repository: 33.8% fewer tokens, 40.5% less elapsed time, and 13.9% lower reported cost, but 3 more tool calls. An earlier correct direct run took about 65.1 seconds, but its aggregate token stream was not retained.
- On the documentation-writing task, direct OpenCode completed in 86.777 seconds with 16 tool calls, 280,479 total tokens, cost `0.013217465`, and a 12,888-byte patch that changed exactly the three allowed paths, passed `git diff --check`, and applied to the recorded base. AgentKnot→Pi completed in 86.225 seconds with 16 tool calls, 263,982 total tokens, cost `0.01546192`, and a controller-captured 12,976-byte artifact whose size, SHA-256, base commit, and changed paths all verified. Direct OpenCode therefore used 6.3% more tokens and 0.6% more elapsed time while reporting 14.5% lower cost. Both source repositories remained clean; no tests were requested or run.

The read-only gain did not repeat on the writing task. Lower provider-reported cost in both pairs is useful evidence, but it does not by itself prove a token, lifecycle, or maintenance advantage. The deterministic no-inference fixture matrix, adapter-owned write/artifact/test comparison, cancellation/timeout/cleanup soak, shared conformance kit, and real-worker lifecycle soak remain open.

## Decision

- Keep `pi-rpc` as the only real built-in adapter and keep provider/model selection as route data.
- Do not add an OpenCode config variant, adapter module, fixture suite, or capabilities schema yet.
- Do not couple an OpenCode candidate to Pi's auth file or copy credentials between worker stores.
- Permit only `opencode-go/gpt-5.6-luna` with `max` and `opencode-go/deepseek-v4-flash` with `max`; do not add a fallback or secondary model.
- Require `--pure`, isolated config/data/cache paths, provider allowlisting, explicit working directory, and AgentKnot-owned artifact capture in any future experiment.
- Preserve Pi code and tests until a second adapter is independently promoted; nothing is superseded yet.

## Promotion gates

- [x] Verify the pinned release checksum and no-inference command surface.
- [x] Provision the pinned executable outside the repository for repeatable tests and provide an independent OpenCode credential without exposing its value.
- [ ] Pass deterministic no-inference fixtures for argv, JSON framing, malformed/partial output, exit semantics, pre-abort, active cancellation, timeout, and exact-child cleanup.
- [ ] Demonstrate a repeatable same-task material benefit against Pi without worse completion, artifact, test, or safety evidence; the read-only token/time gain reversed on the documentation-writing pair, and adapter-owned artifact/test/safety equivalence has not yet been demonstrated.
- [ ] Pass the shared adapter conformance kit and a real success/failure/cancellation/timeout/artifact soak.
- [ ] Delete any implementation made obsolete by promotion; do not retain duplicate worker paths without a supported use case.

## Alternatives considered

- **Implement the CLI adapter immediately:** rejected because protocol availability alone does not clear the native-adapter decision rule and would add a large unpromoted surface.
- **Read Pi auth and pass its key to OpenCode:** rejected because it couples the candidate to the adapter it is meant to replace and adds a credential-translation boundary.
- **Use Codex or Claude as the second worker:** rejected for this evaluation because it would consume controller quota and change the approved downstream model route.
- **Keep the unused Grok route as an example:** rejected because generic config tests already prove provider neutrality and the example contradicted current dogfood policy.

## Consequences

Stage 2 remains in progress: Mock is not the required second real adapter, and OpenCode CLI remains deferred pending the open gates. The decision prevents roughly 600–1000 lines of speculative adapter and test surface while keeping a concrete, evidence-based path to revisit it.

Removing the unused Grok route narrows repository dogfood configuration but does not change historical records or the generic ability to define other provider/model route data in a separate configuration.

## Privacy and security review

The independent `opencode-go` credential remains in OpenCode's own mode-0600 auth store; its value is not recorded here, and AgentKnot does not read or translate it. The direct `--pure` probe did not read Pi auth, load a repository plugin, or mutate the source repository. The pinned executable is retained outside the repository. A future experiment must isolate OpenCode config/data/cache paths and continue to keep credential values out of config, records, events, logs, and artifacts.

## Addendum: 2026-08-10

[Decision 0041](./0041-native-opencode-worker-portability.md) supersedes this record's implementation deferral after the product requirement changed from finding a repeatable efficiency advantage to demonstrating whole-worker runtime portability. The earlier mixed token/elapsed A/B evidence remains unchanged and supports no savings claim. Native OpenCode is now implemented as an experimental, manually selected adapter with deterministic lifecycle/artifact coverage, independent auth, exact-route live inference, and one real isolated Job; Pi remains the promoted default while repeated real failure/cancellation/timeout soaks remain open. Full OpenCode data-directory isolation is not claimed because the OpenCode-owned data store also contains its independent credential.

## Addendum: 2026-08-10 lifecycle promotion

[Decision 0043](./0043-native-opencode-lifecycle-soak.md) subsequently closed the real lifecycle/artifact gate. Native OpenCode is now a promoted supported adapter and human-configured pool member; Pi remains the reference/planner path. The earlier efficiency result remains mixed and supports no savings claim. OpenCode's first-use `.git/opencode` project-ID metadata write is documented rather than misreported as complete Git-directory immutability.

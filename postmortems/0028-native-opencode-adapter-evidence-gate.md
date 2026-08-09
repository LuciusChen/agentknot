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

The official [OpenCode `v1.18.15` release](https://github.com/anomalyco/opencode/releases/tag/v1.18.15) Linux x64 archive was downloaded to an exact temporary directory, verified against release SHA-256 `d842e0e8c622c672a481b7dc6f0329009b64db96b2ba6041e56f4f93f0293b1c`, and removed after the probe. Without inference, the binary and [CLI contract](https://opencode.ai/docs/cli/) confirmed:

- `run --format json`, `--model provider/model`, `--variant max`, `--pure`, and `--dir`;
- ACP startup with nd-JSON and an explicit working directory;
- no native AgentKnot completion-report or artifact contract.

Material unknowns remain: the documented JSON run surface has no explicit final-success envelope, [configuration sources merge rather than replace one another](https://opencode.ai/docs/config/), and exact-child/descendant cleanup has not passed the AgentKnot soak. No OpenCode executable was installed, `OPENCODE_API_KEY` was absent, and no credential, plugin, model inference, or repository mutation was used.

## Decision

- Keep `pi-rpc` as the only real built-in adapter and keep provider/model selection as route data.
- Do not add an OpenCode config variant, adapter module, fixture suite, or capabilities schema yet.
- Do not couple an OpenCode candidate to Pi's auth file or copy credentials between worker stores.
- Permit only `opencode-go/gpt-5.6-luna` with `max` and `opencode-go/deepseek-v4-flash` with `max`; do not add a fallback or secondary model.
- Require `--pure`, isolated config/data/cache paths, provider allowlisting, explicit working directory, and AgentKnot-owned artifact capture in any future experiment.
- Preserve Pi code and tests until a second adapter is independently promoted; nothing is superseded yet.

## Promotion gates

- [x] Verify the pinned release checksum and no-inference command surface without installing it.
- [ ] Provision the pinned executable outside the repository for repeatable tests and provide an independent OpenCode credential without exposing its value.
- [ ] Pass deterministic no-inference fixtures for argv, JSON framing, malformed/partial output, exit semantics, pre-abort, active cancellation, timeout, and exact-child cleanup.
- [ ] Run a same-task Luna/max comparison against Pi and demonstrate a repeatable material benefit without worse completion, artifact, test, or safety evidence.
- [ ] Pass the shared adapter conformance kit and a real success/failure/cancellation/timeout/artifact soak.
- [ ] Delete any implementation made obsolete by promotion; do not retain duplicate worker paths without a supported use case.

## Alternatives considered

- **Implement the CLI adapter immediately:** rejected because protocol availability alone does not clear the native-adapter decision rule and would add a large unpromoted surface.
- **Read Pi auth and pass its key to OpenCode:** rejected because it couples the candidate to the adapter it is meant to replace and adds a credential-translation boundary.
- **Use Codex or Claude as the second worker:** rejected for this evaluation because it would consume controller quota and change the approved downstream model route.
- **Keep the unused Grok route as an example:** rejected because generic config tests already prove provider neutrality and the example contradicted current dogfood policy.

## Consequences

Stage 2 remains in progress: Mock is not the required second real adapter, and OpenCode CLI is still proposed. The decision prevents roughly 600–1000 lines of speculative adapter and test surface while keeping a concrete, evidence-based path to revisit it.

Removing the unused Grok route narrows repository dogfood configuration but does not change historical records or the generic ability to define other provider/model route data in a separate configuration.

## Privacy and security review

The probe checked only whether `OPENCODE_API_KEY` was present and did not print or read a value. It did not read Pi auth, invoke inference, install OpenCode, load a repository plugin, or retain the downloaded binary. A future experiment must isolate OpenCode config/data/cache paths and continue to keep credential values out of config, records, events, logs, and artifacts.

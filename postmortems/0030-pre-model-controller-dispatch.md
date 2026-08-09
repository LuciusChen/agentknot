# 0030: Dispatch configured automatic work before the controller model

- Type: Incident and decision
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `5e65b25`
- Related: [decision 0004](./0004-bounded-automatic-delegation.md), [decision 0027](./0027-controller-native-integration-boundary.md), [decision 0029](./0029-controller-cli-and-single-child-delegation.md)

## Summary

Controller-model instructions did not reliably cause delegation to replace upstream repository work. Even after AgentKnot returned a correct compact result, Codex repeated the audit and consumed more upstream input than direct execution. In repositories whose resolved delegation policy is explicitly `auto`, the installed controller hook now runs the existing orchestration CLI before the first controller-model request and injects bounded terminal evidence. The hook remains an adapter: AgentKnot owns semantic classification, routes, limits, and artifact policy.

## Expected invariant

Automatic delegation should reduce duplicated upstream implementation and analysis while preserving controller neutrality, configured model selection, depth/concurrency limits, immutable records, and upstream artifact acceptance. A worker result must remain evidence, never authority to apply, commit, push, merge, or deploy.

## Evidence

One fixed five-file read-only audit was run through four Codex paths:

| Path | Upstream input tokens | Result |
| --- | ---: | --- |
| Direct Codex | 155,851 | Correct mismatch and test gap |
| Host-selected implicit Skill | 178,071 | Same result; extra Skill/model round |
| Static compact workflow | 249,154 | Same result; Codex repeated repository reads |
| Pre-model AgentKnot hook | 17,951 | Same result; no Codex tool calls |

The initial pre-model path reduced upstream input by 137,900 tokens, or 88.5%, on this workload. Orchestration `orchestration_5aedcc85-c0a3-4ff8-97e5-3ff5af6cd860` used a Luna/max planner, assessed the task `medium` and non-parallel, dispatched exactly one Luna/max child `job_91c244b4-abc4-4e9a-972a-06e52d6fa251`, and returned a valid empty patch artifact. That run exposed that its 3,000-character per-child cap truncated 1,413 characters of otherwise valid audit output; before commit, the cap was replaced by a shared 24,000-character budget and covered deterministically without spending another Codex A/B. The 17,951-token figure therefore proves the pre-model mechanism, not the exact final-cap cost or universal savings.

The audit also found that the prior deterministic handoff test covered only a mode-off result with no children or artifacts. A new CLI fixture now runs a real delegated orchestration through the Pi RPC test process and verifies populated child output plus integrity-valid artifact evidence. A separate fake-CLI hook test verifies exact-prompt `inherit` dispatch, pre-model handoff context, valid non-empty preview embedding, and explicit-Skill bypass.

## Root cause

Skill descriptions and developer-context reminders influence a controller model but cannot guarantee that it will invoke AgentKnot or refrain from repeating delegated work. Each selection, wait, and verification continuation also re-enters the growing Codex context. Compact output removed control-plane duplication but did not remove those model decisions.

`UserPromptSubmit` supplies the exact prompt and runs before the first model request. Moving the existing CLI call there eliminates the host-model selection round. Because this event has no task matcher, the repository's explicit `mode: "auto"` setting is the structural opt-in and AgentKnot's existing planner is the only semantic classifier.

## Decision

- Non-Git, unconfigured, `off`, `suggest`, and explicit-Skill prompts bypass automatic hook execution.
- In `auto`, the hook resolves the Git root and calls `agentknot orchestrate --source <controller> --workspace <root> --delegation inherit --handoff-json --prompt <exact prompt>` synchronously before the controller model.
- The hook never uses `force`. The planner recommendation, deterministic delegate/keep-upstream kinds, configured active route rules, child/concurrency/depth limits, and fallback remain authoritative.
- A plan retained upstream injects only its reason. A dispatched plan injects compact handoff evidence and previews only integrity-valid non-empty artifacts. It never applies or promotes patches.
- All child outputs share 24,000 characters, previews share 32,000 characters, and total additional context is capped at 60,000 characters. Truncation is explicit.
- The host hook timeout is 3,660 seconds, leaving the configured 3,600-second Luna/DeepSeek route timeout responsible for cancellation and cleanup.
- Codex keeps the full Skill explicit-only. No core controller branch, MCP server, wrapper, daemon, local semantic classifier, learned model router, or fallback is added.

## Alternatives considered

- **Stronger static instructions:** rejected by the 249,154-token run; Codex still repeated the audit.
- **Implicit Skill matching:** rejected by the 178,071-token run and three earlier bypasses; selection was neither reliable nor cheaper.
- **A second local semantic classifier:** rejected because it would duplicate multilingual product/delegation policy in plugin code and add maintenance surface.
- **Dispatch every repository regardless of policy:** rejected; only resolved `auto` is an explicit pre-model data and latency opt-in.
- **Automatic patch application:** rejected; it would violate the artifact handoff boundary.

## Consequences

Every non-explicit prompt submitted inside an `auto` repository is sent to the configured Luna planner before the controller model, including vague continuation, informational, requirements, and product-decision prompts that the planner later retains upstream. This consumes downstream quota, adds planner latency, and expands the prompt-data boundary. Users must select `off` or `suggest` when that tradeoff is unacceptable.

Evidence now covers the initial read-only direct comparison and one non-empty controller-first/manual-delegation comparison. In the second run, pre-model dispatch returned a verified patch before Codex applied and validated it, but the baseline was not pure direct. A later no-baseline Codex run proved automatic two-child dispatch, disjoint verified artifacts, and upstream integration; it does not establish a multi-child savings ratio. Real Claude parity, failure/timeout behavior through a real controller, broader task distributions, and repeated savings remain Stage 2 promotion gates ([incident 0031](./0031-bounded-pi-output-drain.md), [experiment 0032](./0032-pre-model-multi-child-evidence.md)).

## Corrective actions and gates

- [x] Run orchestration before the first Codex model request only under resolved `auto` policy.
- [x] Bound child output, preview, and complete additional-context size.
- [x] Add deterministic pre-model hook and populated delegated-handoff coverage.
- [x] Add deterministic Codex/Claude malformed-handoff coverage for bounded unavailable context, no artifact preview, and no fallback command or route/model argument.
- [x] Preserve explicit Skill invocation without a duplicate automatic run.
- [x] Record the first same-task upstream-token reduction without generalizing it.
- [x] Record one non-empty controller-first versus pre-model implementation comparison without treating it as a pure-direct or universal result ([incident 0031](./0031-bounded-pi-output-drain.md)).
- [x] Prove automatic pre-model dispatch of two non-overlapping children and controller-owned artifact integration ([experiment 0032](./0032-pre-model-multi-child-evidence.md)).
- [ ] Prove the same terminal/artifact contract through a real Claude controller invocation.
- [ ] Compare the same multi-child task against an approved direct/controller-first baseline before making a savings claim.
- [ ] Exercise real-controller planner failure, route timeout, and cleanup behavior.

The deterministic malformed-handoff fixture closes only the thin-adapter catch boundary. Its fake CLI records exactly `delegation` followed by inherited `orchestrate`; it does not start a real planner or worker and therefore cannot close the final real-controller failure, timeout, or cleanup gate.

## Privacy and security review

The hook does not persist an additional prompt copy, but the ordinary orchestration record retains the submitted prompt under existing record limits and retention rules. Hook failures expose a bounded error message, not credentials, and never trigger a fallback route. Controller hook trust remains mandatory after installation or source changes.

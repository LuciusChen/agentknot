# 0032: Prove pre-model multi-child dispatch without a direct baseline

- Type: Experiment
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `00438e6`
- Related: [decision 0030](./0030-pre-model-controller-dispatch.md), [incident 0031](./0031-bounded-pi-output-drain.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

One real Codex pre-model request asked for two independently verifiable test changes with disjoint file scopes. AgentKnot planned and dispatched both before the controller-model turn, both Luna/max workers returned integrity-valid artifacts, the parent reported no path overlap, and Codex reviewed and integrated only those previews before one upstream validation pass. This establishes multi-child mechanics, not a new token-savings ratio.

## Evidence

Orchestration `orchestration_d45e32e2-6ba3-4a33-a0ef-3a700ebd99a8` used Pi through OpenCode Go with `gpt-5.6-luna` and `thinkingLevel: "max"` for its planner and both children. The medium, parallelizable assessment assigned `test/controller-integration.test.ts` and `test/runtime.test.ts` to separate jobs. The children started 14 ms apart, completed on their first attempts, and produced artifacts whose captured paths were disjoint; parent `artifactReview` was `checked` with no conflicts or unavailable evidence.

The controller-integration artifact added a temporary-install matrix that removes either copied controller package and runs the survivor's manifest, Skill, and hook against the same fake AgentKnot CLI. It does not invoke a real Claude model. The runtime artifact strengthened a mock-only execution path so its terminal route/worker and `job.started` evidence prove Pi is not selected. Upstream pruned redundant fixture data before accepting the changes; no production, integration, API, schema, configuration, or route code changed.

Codex reported 189,112 input tokens, of which 166,912 were cached, plus 4,341 output tokens. No same-task direct/controller-first run was performed because it would repeat the high upstream cost already observed; these absolute counts cannot support a savings claim. The Luna planner and two workers reported 1,153,663 total tokens: 1,015,379 cache reads, 117,018 cache writes, 21,182 output, and 84 input, with provider-reported cost `0.03749864`. These totals describe capacity shifted downstream, not efficiency against an unmeasured baseline.

After upstream review, the targeted compiled controller/runtime tests passed 5/5 and the complete deterministic suite passed 160/160. The worker artifact SHA-256 values were `c70f4e3880b00bb4b08d962b9647bf60f264412d26eb5df17b5c7b61b0cbaedc` and `adcb25e2b3857c75553a378b47d3367d5946a9a99e226945b8e0284035f8ab12`; no worker committed, pushed, merged, deployed, or directly modified the controller workspace.

## Decision and remaining gates

- Accept the run as evidence that pre-model automatic entry can dispatch and reconcile multiple non-overlapping children while leaving artifact integration upstream.
- Accept deterministic package-removal coverage as evidence that either thin controller package can be absent without the survivor depending on its path.
- Do not claim a new Codex savings percentage until a same-task baseline is explicitly budgeted.
- Do not treat fake Claude hook execution as real-controller parity. Claude has no active subscription in this environment, so the real Claude gate remains open rather than falling back to another controller or model.
- Keep real-controller planner failure, route timeout, cleanup, broader workload, and second-real-worker gates open.

## Privacy and cleanup

The record contains public repository paths, Job/orchestration identifiers, aggregate token/cost counts, and artifact hashes but no credentials or provider response text. The detached controller worktree is removed after upstream verification.

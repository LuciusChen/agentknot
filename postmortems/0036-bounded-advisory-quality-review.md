# 0036: Bound advisory quality review to supplied evidence

- Type: Decision and experiment
- Status: Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `e89f3b9`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decision 0034](./0034-persisted-usage-observability-boundary.md), [decision/experiment 0035](./0035-delegation-first-small-repository-deliverables.md)

## Summary

AgentKnot now supports one optional independent advisory review after a single successful child produces one bounded verified patch. The reviewer is an ordinary separately configured depth-one Job and returns strict `accept`, `changes-requested`, or `uncertain` evidence; it cannot repair or promote the patch and never replaces controller acceptance and tests.

The first real run showed that reusing the general coding-worker profile made review dramatically more expensive than the implementation and caused unrelated repository inspection. The repository therefore uses a role-named `bounded-review` worker profile that receives only the supplied evidence and disables tools and context-file discovery. Controller, adapter, provider, model, and effort remain configuration; the observed DeepSeek-worker/Luna-reviewer pair is not a core rule or intelligence ranking.

## Context and expected invariant

Pre-model delegation reduced measured controller usage, but the controller still had to reason over every patch. A separate capable reviewer can catch bounded defects before that controller pass, provided it improves completion quality rather than merely moving or multiplying work.

The required invariant is narrow: review is advisory evidence over one already verified patch. It must be opt-in, route-neutral, single-attempt, depth-one, bounded, independently persisted, and incapable of silently applying, repairing, retrying through another model, or overriding the controller. Ineligible or failed review must be explicit rather than interpreted as acceptance.

## Evidence chronology

All end-to-end trials used the same clean synthetic `summarizeRanges` repository at commit `121ef607`, the same requested behavior, Git worktree isolation, and no fallback. The current repository configuration selected one low-complexity implementation route and one separate quality-review route; those concrete route resolutions are experiment inputs, not product constants.

1. Exact-route `doctor --live` succeeded for the configured `quality-review` route at `thinkingLevel=max`.
2. Orchestration `orchestration_3fa54478-1851-4e91-bea3-6784e2648115` selected one low-complexity worker and produced integrity/base-valid artifact `28094b6a414de4318490337f1f64a4f66e292343f9a916cb08cd459e93652928`, changing only `src/ranges.js`. The reviewer returned `accept`; the controller previewed and applied it without modification, and the unchanged fixture suite passed 4/4.
3. That first reviewer reused the general Pi coding-worker profile. Job `job_ddc3ced9-6df3-4ed0-90a1-0e6b8c530835` used 186,867 reported tokens, 17 tool calls, provider-reported cost `0.015376825`, and about 128.8 seconds. It repeatedly inspected the tiny fixture, searched unrelated AgentKnot documents, and performed checks already outside its bounded role. The worker implementation itself used 40,076 tokens and about 23.0 seconds.
4. The repository reviewer profile was narrowed through configuration only: the route now resolves worker profile `bounded-review`, whose Pi command arguments disable tools and context-file discovery. The prompt also says to judge only supplied evidence. No controller, provider, model, or route-name branch was added to core.
5. Repeated orchestration `orchestration_d0fcb8fc-b2bf-4942-a6b9-bcb120d16851` produced valid artifact `80f0f6cb8a4942ee432e3594cb42ea477fedf5f3502029b2f3ed629ca5651f60`. Reviewer job `job_21a96a9e-4f43-438f-b170-057f782b2170` again returned `accept`; the controller applied it unchanged and the fixture passed 4/4. The reviewer used 10,931 tokens, zero tools, provider-reported cost `0.0058256`, and about 71.4 seconds: 94.1% fewer reviewer tokens, 100% fewer tools, 62.1% lower reported cost, and 44.6% less reviewer elapsed time than the first profile.
6. A seeded negative-control patch sorted the caller's input array in place while falsely claiming tests passed. Direct configured review job `job_880c4a7c-2559-45dd-a05d-d66a5cbf2188` returned `changes-requested` with one high-severity finding tied to `values.sort(...)` and the explicit no-mutation criterion. It used 4,920 tokens, zero tools, and provider-reported cost `0.0023995`.
7. The persisted usage report classified both end-to-end review outcomes as completed/accept with complete review-record coverage. The seeded direct Job contributes downstream usage but correctly does not count as an orchestration review. Final controller disposition remains structurally unavailable because AgentKnot does not persist it.

## Decision rationale

- Configuration enables review only by naming an existing route and selected parent complexities; omission leaves the prior lifecycle unchanged.
- The reviewer route must resolve exactly one attempt. Review failure is evidence, not a reason to retry or switch models.
- Eligibility is deliberately limited to exactly one successful child and one integrity/base-valid, non-empty, non-truncated patch no larger than 32 KiB. Multi-child and multi-artifact semantic review remain outside this slice.
- The reviewer receives the parent goal, subtask acceptance criteria, verified artifact identity and patch bytes, and bounded structured worker claims labeled unverified. Worker prose is excluded.
- The strict result is persisted before parent completion and included in compact handoff, but it does not change child success, fail a successful parent, or apply the patch.
- The repository's current no-tool profile is a measured containment choice for this bounded evidence shape. Another deployment may select a different worker adapter, provider, model, effort, or capability profile without changing orchestration code.
- Usage aggregation reports review outcomes, verdicts, findings, routes, reasons, and coverage. It does not fabricate controller acceptance or a reviewer accuracy/completion-rate score.

## Alternatives considered

- Leaving all review to the upstream controller was rejected as the only path because it preserves the observed controller bottleneck and provides no measured downstream review option.
- Relay-style agent chat, discussion rounds, voting, or a repair loop was rejected as unnecessary coordination and implementation expansion for one patch.
- Letting the reviewer edit or test in the source worktree was rejected because it would blur reviewer, worker, and artifact-promotion authority. The first tool-enabled run also demonstrated severe context and latency expansion.
- Hardcoding a Luna reviewer, DeepSeek worker, Codex controller, or model-strength order was rejected. Current names are route configuration and experiment evidence only.
- Automatically treating `changes-requested` as parent failure or `accept` as promotion was rejected because a model verdict is advisory and can be wrong.
- Persisting a new controller-disposition workflow was deferred; the current controller contract has no exact acceptance event, and adding one was not required to validate the reviewer lifecycle.

## Consequences and gates

- Review adds latency and downstream compute even after containment. The bounded repeat still took about 71 seconds and 10,931 reviewer tokens for a small patch, so this evidence does not justify expanding review to every complexity or artifact shape.
- Four accepted real runs across two workload shapes and one seeded defect do not estimate false-positive/false-negative rates or establish a model ranking. Broader route comparisons require comparable workloads and recorded controller disposition before automatic reviewer selection can be proposed.
- A configured arbitrary adapter still runs with its process authority. Prompt restrictions and the current no-tool Pi flags are capability hygiene, not an operating-system sandbox.
- No general messaging bus, reviewer repair turn, automatic ranking, fallback, new adapter abstraction, or artifact-promotion path was added.

## Verification

Deterministic tests cover strict configuration and parser rejection, bounded prompt contents, source/controller neutrality, one eligible reviewer Job, malformed output, changes-requested advisory behavior, empty/multi-child skips, cancellation, restart reconciliation, compact handoff, usage aggregation, and source nonmutation. Real exact-route liveness, four end-to-end positive runs across two workload shapes with independent controller application/tests, and one seeded negative review provide current dogfood evidence.

## Privacy and security review

The durable experiment identifiers, route resolutions, aggregate statistics, artifact hashes, and synthetic patch behavior contain no credentials or user repository content. The first reviewer accessed unrelated local project documents; no secret was observed or copied here. The incident reinforces that worker capability flags reduce accidental scope but do not sandbox a host-capable model process.

## Addenda

### 2026-08-10: Codex pre-model upstream measurement

A fresh Codex `gpt-5.6-sol`/`xhigh` run reused the exact historical direct-baseline fixture commit `121ef607` and prompt from decision 0035. The current plugin entered AgentKnot before the controller-model turn. Orchestration `orchestration_adde359c-d427-4931-a877-934158597be0` selected one low-complexity implementation child, and its worker corrected an initially failing duplicate-range case before producing the final artifact. The configured bounded reviewer returned `accept` with no finding.

The downstream planner, worker, and reviewer Jobs reported 4,843, 56,224, and 5,256 tokens respectively (66,323 total). Reviewer job `job_25297b33-6f8c-4772-923d-a64163e4faaa` used zero tools and completed in about 30.5 seconds. The whole orchestration completed in about 63.8 seconds with no fallback.

The controller received the compact verified preview, stated that it would apply that patch, changed only `src/ranges.js`, and ran `npm test` plus a changed-file check. Stable `turn.completed.usage` reported 46,944 input tokens, including 40,192 cached input tokens, and 625 output tokens: 47,569 input-plus-output. Independent controller-side validation then passed all 4/4 fixture tests with the same single-file diff and no further modification.

Against the same-task direct baseline of 73,578 input plus 1,032 output (74,610 input-plus-output), the current automatic path reduced upstream input by 36.2% and input-plus-output by 36.2%. Non-cached-input-plus-output also fell from 9,330 to 7,377. This one pair strengthens the claim that delegation plus bounded review can reduce upstream controller work without losing the observed result quality. It still does not establish lower total compute, subscription-quota equivalence, broad completion rate, causality for the reviewer alone, or a portable model ranking. Final disposition remains absent from the persisted AgentKnot schema; controller acceptance here is experiment evidence from the stable Codex event/tool boundary, not a new product capability.

### 2026-08-10: Distinct parser-fix repeat

A second fixture at commit `34e91ae2dee7a377e9f4b1f8256935187314b2dc` changed the workload from implementing a missing range function to repairing an existing assignment parser. The same prompt, fixture baseline, Codex `gpt-5.6-sol` controller, and `xhigh` effort were used for direct and automatic paths. Both changed only `src/assignments.js`, implemented the documented first-separator, trimming, empty-value, validation, and last-duplicate behavior, passed 5/5 tests under independent validation, and left no additional workspace changes. Their patches were behaviorally equivalent; the automatic patch checked for a missing separator before slicing and was accepted unchanged by the controller.

Direct Codex used 91,115 input tokens, including 80,384 cached input tokens, plus 1,556 output tokens: 92,671 input-plus-output and 12,287 non-cached-input-plus-output. It completed in about 54.9 seconds. The automatic controller used 47,529 input tokens, including 35,072 cached input tokens, plus 645 output tokens: 48,174 input-plus-output and 13,102 non-cached-input-plus-output. Raw upstream input-plus-output fell 48.0%, while the non-cached measure rose 6.6% and end-to-end elapsed time rose 80.5% to about 99.1 seconds.

Automatic orchestration `orchestration_a172f586-450c-43ee-bd7d-ceb6440b5bdd` classified the repair as low complexity, selected the configured active route, produced one integrity-valid single-file artifact, and completed without fallback. Planner job `job_56f86f61-8d63-4ddb-aedb-a6b97d6e2dd8`, implementation job `job_aa584113-f9cf-41f3-b02a-09a91679d18a`, and reviewer job `job_9e9d3dcd-d9b8-453c-b24e-b8c0392d09a1` reported 4,799, 51,645, and 4,152 tokens respectively (60,596 total). The bounded reviewer used zero tools and returned `accept` with no finding.

The second distinct pair repeats the upstream raw-token reduction while preserving observed completion quality, but it also exposes the tradeoff more clearly: planning, delegated execution, and review added substantial downstream work and serial latency, and the non-cached controller measure regressed. The evidence supports bounded upstream-capacity shifting, not a claim that AgentKnot makes every small task faster, cheaper, or globally more token-efficient. Controller acceptance remains test-boundary evidence rather than persisted product state.

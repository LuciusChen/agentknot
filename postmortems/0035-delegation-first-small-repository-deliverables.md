# 0035: Delegate small repository deliverables before the controller model

- Type: Decision and experiment
- Status: Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `df77b12`
- Related: [decision 0029](./0029-controller-cli-and-single-child-delegation.md), [decision 0030](./0030-pre-model-controller-dispatch.md), [decision 0034](./0034-persisted-usage-observability-boundary.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

AgentKnot now instructs its existing planner to delegate a bounded allowlisted task that is expected to create or modify a repository file even when the task is small, low-complexity, or non-parallel. Generic planner/worker handoff and review overhead is no longer sufficient reason to retain such work upstream. Genuinely trivial read-only inspection or a direct answer with no repository-file deliverable may still remain upstream.

This is a planner-contract correction, not a second classifier. It adds no schema field, controller branch, hook policy, token threshold, learned ranking, route fallback, or automatic artifact promotion.

## Context and expected invariant

The pre-model controller hook exists to reduce expensive controller work by completing eligible repository work before the first controller-model turn. Decision 0029 nevertheless allowed objectively trivial work to remain upstream whenever handoff and review appeared more expensive. On a small but complete implementation fixture, Luna/max used that broad exception to return `do-not-delegate`; the controller would then pay for both planning and the full implementation.

The intended invariant is narrower: task size does not decide delegation for a concrete repository deliverable. Existing task-kind allowlists, `keepUpstream` exclusions, depth and concurrency limits, route policy, artifact verification, and explicit upstream integration remain authoritative.

## Evidence

All comparisons used the same initial fixture commit `121ef607`, the same `summarizeRanges` prompt, and Codex `gpt-5.6-sol` at `xhigh`. The direct Codex baseline completed the implementation and 4/4 tests with 73,578 input tokens, including 65,280 cached input tokens, plus 1,032 output tokens: 74,610 input-plus-output tokens.

Before the correction, orchestration `orchestration_c77fb957-0e31-4885-80c5-55e36b2dd894` classified the task as low and non-parallel but retained it upstream solely because the edit was trivial and handoff/review overhead appeared larger. Its Luna/max planner used 9,707 total Pi tokens, after which Codex would still have to implement the task. A separately requested DeepSeek V4 Flash/max leaf job completed the same edit with an integrity-valid single-file artifact and 4/4 tests, using 29,029 total Pi tokens.

After the prompt-only correction, orchestration `orchestration_e197637b-06b4-40fe-b0d5-b3d9d663dc0f` classified the same task as low, delegated one non-parallel `independent-implementation` child, and deterministically selected the configured `deepseek-flash` rule. Luna/max planning used 4,794 total Pi tokens and the DeepSeek worker used 33,841. Artifact SHA-256 `919c62a25a4b02cca7f24bb2256d00f44c7909b88ed8fb785e6bdf62a38a0fd2` was base-valid, changed only `src/ranges.js`, applied cleanly after upstream preview, and passed 4/4 controller-run tests.

A fresh real Codex pre-model run then produced orchestration `orchestration_792ac9a2-fc22-4bfa-aec8-fe26b4afc41e`. It again selected one low-complexity DeepSeek child with no fallback. Codex reviewed the supplied patch, applied it, ran the tests once, and changed no other file. Stable `turn.completed.usage` reported 47,981 input tokens, including 37,120 cached input tokens, plus 897 output tokens: 48,878 input-plus-output tokens. Against the direct baseline, upstream input fell 34.8% and upstream input-plus-output fell 34.5%. The controller's non-cached-input-plus-output count increased from 9,330 to 11,758, so the measured raw reduction came from fewer cached input tokens and must not be generalized to every quota formula.

The automatic run shifted work downstream: its Luna/max planner reported 4,790 total tokens and its DeepSeek V4 Flash/max worker reported 37,880, with provider-reported costs `0.000940675` and `0.0005705952`. These downstream units are reported separately from Codex usage. Summing different model/provider token totals is not a supported efficiency or billing metric.

The reverse-boundary probe also held. Orchestration `orchestration_e2b1d99d-3a5d-4131-a209-ea54a6acf65c` asked only for the package name from `package.json`; Luna/max classified it as a genuinely trivial read-only inspection with no repository-file deliverable, returned `do-not-delegate`, and admitted no child.

## Decision rationale

- A bounded allowlisted task expected to create or modify a repository file is delegation-first even when small, low-complexity, or non-parallel.
- A read-only analysis result in worker output is not automatically a repository-file deliverable. Nontrivial read-only analysis may still be delegated under the existing policy; genuinely trivial inspection and direct answers may remain upstream.
- `requirements-decision`, `product-decision`, `artifact-integration`, `commit`, and `push` exclusions continue to win. Artifact application, acceptance, integration, commit, merge, push, and deployment stay upstream.
- The planner remains the only semantic classifier. The deterministic composer continues to validate and filter the planner result but does not infer a missing subtask from prompt text.
- Current human-authored routing remains unchanged: low-complexity eligible work selects DeepSeek Flash/max; Luna/max remains planner and medium/high/default route. No route or model fallback is added.

## Alternatives considered

- A controller-hook keyword or file-intent classifier was rejected because it would duplicate semantic policy outside AgentKnot core.
- A new `producesRepositoryDeliverable` assessment field was rejected because one observed planner error did not justify a schema and parser expansion.
- A token threshold or learned delegate/retain score was rejected because comparable controller usage is not persisted and automatic ranking remains deferred.
- Bypassing planning for small edits was rejected because it would remove the existing task-kind, exclusion, limit, and route evidence boundary.
- Delegating every request was rejected because informational chat, product decisions, trivial read-only answers, and artifact integration must remain upstream.

## Consequences and gates

- The smallest known implementation is two planner instructions plus deterministic prompt/low-route assertions; there is no new runtime branch.
- One same-task pair demonstrates a 34.5% upstream raw-token reduction, not universal savings, lower total compute, lower latency, or a subscription-quota conversion formula.
- Planner behavior remains model-mediated. Broader workload distributions are required before tightening more categories or claiming a stable completion-rate improvement.
- Exact upstream/downstream proportions remain unavailable in `agentknot usage`; this experiment reads stable Codex CLI usage at the test boundary and does not change persisted contracts.
- Real Claude parity remains open because no Claude subscription is active; no substitute controller or model was used.

## Verification and cleanup

The planner contract and existing low-complexity active-route test pass within the complete 164/164 deterministic suite. Both real post-correction orchestrations completed through Pi/OpenCode Go with Luna/max planning and DeepSeek V4 Flash/max execution. The final Codex workspace independently passed 4/4 tests and contained only the expected `src/ranges.js` change.

The detached audit worktree was removed after recording the evidence. The two synthetic fixture roots were moved recoverably from `/tmp` to the user's trash because direct recursive deletion is disabled in this environment. Durable AgentKnot Job and Orchestration records remain as local measurement evidence. No credentials, prompts beyond the synthetic fixture, provider response bodies, or account quota data are recorded here.

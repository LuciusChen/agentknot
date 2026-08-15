# 0088: Bound Pi text tool results before the next model call

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-15
- Owners: AgentKnot maintainers
- Related: [record limits 0023](./0023-fixed-durable-record-budgets.md), [bounded analysis 0052](./0052-bounded-analysis-and-observable-waiting.md), [selective-context gate 0082](./0082-real-repository-selective-context-gate.md), [tool-count removal 0083](./0083-remove-tool-count-task-boundaries.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Incident

A minimal WorkOrder-rooted, read-only Luna/max task named exactly two documentation locations and prohibited broader scope. It completed correctly on attempt one, but the worker used Bash `rg` with broad terms against the 819-line SPEC. Pi's built-in tool boundary retained up to 50 KiB for the next model call, while AgentKnot replaced the corresponding 102,874-byte JSON event only after Pi had already consumed the result. The Job reported 42,257 total provider tokens for a two-paragraph answer.

The durable 16 KiB event-data limit protected storage but could not reduce downstream model context. The root boundary is Pi's `tool_result` before its next model request, not WorkOrder, Job lifecycle, orchestration, persistence, or a later presentation formatter.

## Rejected prompt-only correction

Adding four generic evidence-access sentences to the WorkOrder Executor prompt reduced one repeat to 37,909 reported tokens and 16.982 seconds, but the worker still produced a 102,908-byte broad-search event and described it as bounded. Prompt guidance did not enforce the intended boundary, so the prompt and its tests were reverted instead of being promoted on one favorable aggregate.

An initial adapter limiter handled exactly one text block. A real repeat exposed one multi-block Bash result that escaped it, used five tools, and reported 42,533 tokens. The implementation was corrected to combine all text blocks under one aggregate bound before evaluation.

## Decision

- Normal Pi Jobs load one product-owned ephemeral extension after explicitly configured extensions. Ambient extension discovery remains disabled.
- The extension hooks final `tool_result` before Pi builds the next model request and limits aggregate text to 8 KiB.
- Bash retains the UTF-8-safe tail; other tools retain the UTF-8-safe head. The model receives a concise truncation notice so it can narrow the next query, while structured original/max/direction details remain available in normalized tool evidence.
- Results already within the limit and non-text content remain unchanged.
- The exact `agentknot_artifact_read` result is exempt. Its separately authorized size and identity remain the review evidence contract and are not silently weakened here.
- The attempt-local mode-0600 extension bundle is removed with the exact Pi child. No new dependency, configuration, persisted field, Job state, tool-count limit, command parser/rewriter, route fallback, provider/model branch, retrieval service, or WorkOrder/Orchestration behavior is added.
- The limit reduces context volume but is not redaction. Retained text may still contain sensitive content, and Pi may retain its own full Bash output path according to its existing behavior.

## Same-task evidence

All arms used the same Luna/max route, objective, acceptance criteria, constraints, and two target documents. Later arms ran against a workspace containing only the uncommitted limiter implementation outside those target documents, so these are bounded operational observations rather than a release-wide A/B.

| Arm | Correct | Tools | Provider total tokens | Cost | Duration | Large-result evidence |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Baseline | yes | 3 | 42,257 | 0.00343371 | 23.090 s | one event replaced at 102,874 JSON bytes |
| Prompt-only, rejected | yes | 4 | 37,909 | 0.00329815 | 16.982 s | one event replaced at 102,908 JSON bytes |
| Single-block limiter, rejected | yes | 5 | 42,533 | 0.002925185 | 24.357 s | one multi-block result escaped; one result limited |
| Aggregate limiter | yes | 4 | 35,875 | 0.002614085 | 31.296 s | 34,974- and 8,984-byte text results both limited to 8 KiB |

Against the original baseline, the accepted aggregate arm used 6,382 fewer reported tokens (-15.1%) and 23.9% less reported cost, while taking 8.206 seconds longer (+35.5%) and one additional tool call. The token/cost result supports this exact context boundary; the latency regression prevents a general speed or universal efficiency claim.

## Verification

- Deterministic tests cover head and tail retention, aggregate multi-block limiting, UTF-8 boundaries, structured evidence, unchanged bounded results, exact artifact-read exemption, generated extension loading, explicit-extension ordering, and attempt-directory cleanup.
- The final real task completed at attempt one with the correct two-boundary answer, no retry, one integrity-valid empty artifact, and no canonical workspace mutation.
- Build passed, the focused Pi/extension tests passed 49/49, the complete repository suite passed 355/355, and the final diff check passed before promotion.

## Consequences

One accidental broad tool result can no longer place Pi's full 50 KiB default into the next AgentKnot model request. A worker may spend another tool call narrowing the evidence, as the real task did; correctness, latency, and total tokens therefore still depend on the route and task. This boundary neither prevents broad commands nor proves semantic scope compliance, but it makes their per-result context cost deterministic and visible before model consumption.

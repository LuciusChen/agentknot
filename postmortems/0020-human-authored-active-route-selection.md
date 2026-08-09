# 0020: Apply human-authored route rules without claiming model ranking

- Type: Decision
- Status: Accepted
- Date: 2026-08-09
- Owners: Upstream controller
- Affected versions/commits: after `d30d44f`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decision 0016](./0016-shadow-route-selection.md), [experiment 0017](./0017-deepseek-flash-route-ab.md)

## Summary

AgentKnot adds `delegation.dispatch.routeSelection.mode: "active"` alongside `shadow`. Both modes use the same bounded ordered rules over eligible subtask kind and parent assessment complexity. Shadow records a suggestion; active makes the first matching configured route, or `dispatch.defaultRoute` when unmatched, authoritative before child admission.

The repository policy is intentionally conservative: `low` selects Pi/OpenCode Go/DeepSeek V4 Flash/max, while `medium`, `high`, and unmatched work use Pi/OpenCode Go/Luna/max. The Luna/max route remains the planner route. Neither mode adds fallback.

## Context and rationale

Shadow mode established auditable classification and route evidence without changing execution. One same-task A/B found that DeepSeek Flash/max used fewer Pi tokens and lower provider-reported cost but ran longer and produced a larger patch. That evidence was insufficient for a general intelligence or performance ranking.

The user explicitly chose a narrower product policy: configure the quality/cost split manually instead of asking AgentKnot to infer which model is smarter. Reusing the existing rules avoids a scoring service, benchmark database, provider abstraction, or second planning pass.

## Contract

- The planner returns task kind and one parent complexity; it never returns a route or provider/model name.
- Configuration contains every candidate route and the exact ordered matching rules.
- Active selection is evaluated only after ordinary delegation eligibility policy.
- The selected route is persisted in the plan and plan hash before dispatch, copied to child-start evidence, and resolved by the ordinary leaf Job API.
- Child metadata records active `selectedRoute`, first-match/default basis, optional zero-based rule index, task kind, and parent complexity.
- Retry remains inside the selected route. Failure is reported without switching to Luna, DeepSeek, Grok, or another model.
- Provider, model, and `thinkingLevel=max` remain properties of the configured resolved route.
- Artifacts remain isolated handoff data and are never applied automatically.

## Boundaries and risks

Complexity is assessed once for the parent orchestration, so all children share that band in this first slice. Per-child scoring, learned ranking, price lookup, dynamic optimization, fallback, and mid-attempt switching remain outside the contract. A malformed or adversarial planner assessment can still misclassify complexity; strict parsing and a conservative Luna default limit but do not remove that risk.

The active rule is a human choice, not a claim that DeepSeek is objectively best for low work or Luna objectively best for every harder task. Route outcomes and session statistics remain evidence for later review.

## Verification gates

- [x] Strict config accepts only omitted, `shadow`, or `active` selection and validates every candidate route and rule.
- [x] Deterministic policy tests cover active rule match, conservative default, plan-hash impact, and unchanged shadow behavior.
- [x] Orchestration tests prove the selected route reaches the persisted plan, child-start event, resolved Job, and public child metadata.
- [x] Re-run exact live probes for both Luna/max and DeepSeek Flash/max with no fallback; both succeeded on 2026-08-09.
- [x] Complete a real low-complexity dogfood orchestration through the active DeepSeek rule: `orchestration_97ce1a83-13a5-4bd1-b2b4-e2d7afd93106` dispatched two independent children on `deepseek-flash`; both resolved Pi/OpenCode Go/DeepSeek V4 Flash/max, succeeded, and produced checksum/base-valid single-file artifacts. Upstream rejected the verbose patches as-is and integrated their test intent compactly to avoid fixture duplication.
- [ ] Keep automatic/learned ranking deferred until separate comparable scorecards and an explicit decision gate exist.

## Privacy and security review

The feature adds route names, task kinds, parent complexity, and rule-match evidence to already persisted plans and child metadata. It adds no credentials, external price data, network policy, plugins, model output retention, or worker permissions. Existing trusted-local, prompt, patch, and retention limitations remain.

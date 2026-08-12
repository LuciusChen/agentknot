# 0080: Keep exact artifact reads without claiming measured review efficiency

- Type: Experiment / Incident
- Status: Accepted / Resolved
- Date: 2026-08-12
- Owners: AgentKnot maintainers
- Related: [decision 0036](./0036-bounded-advisory-quality-review.md), [decision 0078](./0078-exact-artifact-read-grant.md), [ROADMAP](../docs/ROADMAP.md)

## Question and protocol

Does removing verified patch bytes from the initial reviewer prompt and serving them through one exact read grant reduce real downstream review cost without reducing completion or verdict quality?

Three serial trials used the configured `quality-review` route exactly as data: Pi / OpenCode Go / `gpt-5.6-luna` / `thinkingLevel=max`, one attempt, no fallback. Each trial paired three temporary committed Git fixtures in balanced A/B, B/A, A/B order: a small valid patch, a valid multi-file patch, and a seeded division defect. Arm A embedded the exact integrity-valid preview in the reviewer prompt. Arm B used the otherwise identical prompt plus the exact source-Job/artifact grant and required one served audit event. Fixture writes were deterministic and provider-free; all six reviews per trial used fresh real Pi sessions. Metrics came only from terminal Job timestamps, normalized tool events, strict verdict/completion evidence, and provider-reported `sessionStats`.

The predefined gate required one run with all three pairs usable in both arms, no oracle regression, at least 10% reductions in both reported total and input-plus-cache-read-plus-output, no more than 10% latency increase, and read-grant token wins in at least two pairs. Failed or missing evidence was never replaced. A one-off 456-line runner produced mode-0600 reports and was then deleted rather than retained as product surface.

## What happened

The first run completed both positive pairs, but both seeded-defect reviews failed without a retained normal result. The second run added failure evidence and showed the exact cause in both arms: the reviewers correctly requested changes and said the review was complete, but the later generic completion suffix reported `taskOutcome: blocked`. The orchestrator correctly treated that envelope as a terminal non-retryable failure. A reviewer-prompt clarification alone did not override the later transport instruction.

The shared completion instruction was therefore corrected without a reviewer, worker, adapter, provider, model, or route branch: `taskOutcome` describes whether the assigned worker-role task finished, not whether an inspected subject is acceptable. A completed review may request changes; `blocked` remains reserved for an assigned task that could not be completed. In the third run, both seeded-defect arms succeeded with `changes-requested` and `taskOutcome: completed`, proving the correction on the real route.

OpenCode Go returned three independent `rate_limit_exceeded` failures across the later runs. The single-attempt reviewer contract preserved them as failures without retry or fallback. A five-second interval between admissions did not eliminate the upstream limit. No run therefore reached three complete pairs, and the predefined gate did not pass.

## Evidence

Across the three runs there were 18 admitted real reviewer Jobs and five complete, oracle-valid A/B pairs. This cross-run aggregate is descriptive only, not a substitute for the failed per-run gate:

| Evidence across five complete pairs | Embedded A | Exact-read B | B relative to A |
| --- | ---: | ---: | ---: |
| Provider-reported total tokens | 43,070 | 46,821 | +8.7% |
| Input + cache-read + output | 29,365 | 34,602 | +17.8% |
| Persisted Job latency | 116.537 s | 122.077 s | +4.8% |
| Normalized tool starts | 35 | 34 | -2.9% |
| Provider-reported cost | 0.006284785 | 0.005386075 | -14.3% |

The exact-read arm won reported total tokens in two of five complete pairs and lost in three. Direction reversed between repeats of both positive fixture shapes. The seeded negative pair in the final run used 4,653 versus 7,025 total tokens and 13.169 versus 18.568 seconds, despite both returning the correct verdict. Provider cost moved differently from token totals and remains advisory.

Complete-pair Job IDs were:

- small valid: `job_d78773f6-4153-425b-bd7a-067415f59b5f` / `job_763e498d-92b8-4fe7-869e-d438bdb8438c`, then `job_961104a7-0f17-4cd8-a5a6-cc6cfde6e0c9` / `job_5019e938-312b-41a7-a906-7605e2e5565c`;
- multi-file valid: `job_1064624a-3a21-427f-bf5b-3cb806e0982a` / `job_eadcb3f6-b150-458d-92db-0187f405351e`, then `job_16fd84fb-6719-4a8a-a9ee-1fb5f6771989` / `job_1fd497c7-45a5-414f-9d78-763d8e999995`;
- seeded defect after the completion fix: `job_35413ed4-4400-44bb-abcf-4344fd0e550a` / `job_05491716-2873-4568-ada6-89bc340996e1`.

For this session, the local raw reports remain outside the repository at `/tmp/agentknot-artifact-read-ab-20260812{,-v2,-v3}.json`, mode 0600, with SHA-256 values `7dbb603cf2b3735f03a54ee1cf9c90d8ab98e891d368d8f1a9d3f3a5f6d5b5b2`, `0a68893edef7794860dc08d7a5e360fa5f318f3d83e714e77e64012159456520`, and `e22eb2cb1b62e8120e4d7fb916e0f93fdfd6ba96f29b3a2580831d9ee97ca37b`.

## Decision

Keep the exact artifact-read grant because it provides narrower authority, same-workspace identity revalidation, single-use access, and content-free durable audit evidence. Do not claim that it saves tokens or latency. Do not issue capabilities for arbitrary `ContextReference` kinds from this result. Do not add retry, fallback, learned selection, model-specific prompt logic, or a retained benchmark framework.

The completion-role correction is accepted independently of the inconclusive efficiency gate because the reproduced contradiction made a successfully finished negative review impossible to represent. The unsuccessful reviewer-specific clarification was removed once the shared instruction became the single contract; tests cover that shared final instruction and the full suite remains the release gate.

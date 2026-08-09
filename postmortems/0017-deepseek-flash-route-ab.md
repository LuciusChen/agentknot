# 0017: Keep DeepSeek Flash explicit after one mixed route A/B

- Type: Experiment
- Status: Inconclusive
- Date: 2026-08-09
- Owners: Upstream controller
- Affected versions/commits: `8efdca2`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [shadow decision 0016](./0016-shadow-route-selection.md)

## Summary

Pi's OpenCode Go catalog exposed `deepseek-v4-flash` with thinking support. A live `thinkingLevel=max` probe succeeded, followed by one isolated same-task comparison against `gpt-5.6-luna` at `thinkingLevel=max`. Both routes produced valid, passing test-only artifacts. DeepSeek used fewer tokens and lower provider-reported cost, but was slower and produced the larger implementation; the upstream controller selected Luna's smaller patch.

DeepSeek Flash is therefore configured only as an explicit experimental leaf route. Luna/max remains the planner and delegated-worker route. No shadow rule, automatic ranking, route switching, or fallback uses DeepSeek.

## Expected invariant

Route candidates are ordinary vendor-neutral configuration. Candidate evaluation must hold the task, worker, provider, thinking level, retry budget, timeout, source commit, isolation, and acceptance checks constant. A single metric or trial cannot establish model intelligence or authorize automatic selection, and downstream patches remain artifacts until upstream review.

## Evidence

- Catalog: `opencode-go/deepseek-v4-flash`, thinking supported.
- Live probe: exact Pi/OpenCode Go/DeepSeek V4 Flash/max route succeeded without creating a Job.
- Source base: `8efdca2a75c52456cc6779902828a3a80cd85d9f`.
- Task: add the same two focused shadow-route regression cases without production changes.
- Both jobs used Pi/OpenCode Go, `thinkingLevel=max`, one attempt, a 3,600,000 ms timeout, separate Git worktree/storage namespaces, and no Pi plugins.

| Evidence | Luna/max | DeepSeek Flash/max |
| --- | ---: | ---: |
| Job | `job_0aaba577-87a5-4a7e-9615-3dd1c2db64c9` | `job_ea191519-c4e2-464f-a659-5544f7a026df` |
| Outcome / full tests | succeeded / 112 of 112 | succeeded / 112 of 112 |
| Artifact verification | valid | valid |
| Attempts | 1 | 1 |
| Elapsed | 117.317 s | 144.941 s |
| Pi total tokens | 847,763 | 522,531 |
| Tool calls | 24 | 27 |
| Provider-reported cost | 0.02204237 | 0.0044451176 |
| Patch bytes | 3,042 | 3,481 |

Relative to Luna, DeepSeek used 38.4% fewer total tokens and 79.8% lower provider-reported cost, while taking 23.5% longer, making 12.5% more tool calls, and producing a 14.4% larger patch. Provider-reported cost is advisory and is not assumed to be normalized across providers or stable over time.

## Decision rationale

The task's acceptance gate was binary and both routes passed it, so implementation size became the relevant anti-bloat discriminator. Luna's patch covered the requested behavior with fewer changes and was selected for upstream application. DeepSeek's lower token and cost observations are useful enough to justify further explicit trials, but the latency and patch-size tradeoffs make the first result insufficient for a task-class rule.

No scorecard service, persistence record, CLI command, ranking abstraction, or automatic router is added. Existing Job records and manual upstream acceptance are enough for the next bounded trials.

## Consequences and gates

- [x] Add `deepseek-flash` as an explicit experimental route with OpenCode Go and `thinkingLevel=max`.
- [x] Keep `delegation.planner.route` and `delegation.dispatch.defaultRoute` on `luna`.
- [x] Keep shadow selection disabled in repository configuration and prohibit silent fallback.
- [ ] Repeat comparable trials across at least the task kinds and complexity bands that might receive a distinct route rule.
- [ ] Require completion, upstream acceptance, artifact verification, and target tests before comparing tokens, cost, latency, retries, tool calls, or implementation size.
- [ ] Propose automatic selection only after a repeatable rule and a separate PRD/SPEC/roadmap decision; inconclusive or high-risk work remains Luna/max.

## Privacy and security review

The record contains route names, Job IDs, aggregate statistics, artifact hashes, and a public repository commit only. Temporary configuration used separate `/tmp` storage, included no credentials, and configured no Grok route. No worker artifact was applied automatically.

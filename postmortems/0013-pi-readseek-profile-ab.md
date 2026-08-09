# 0013: Reject the first pi-readseek profile after measured regressions

- Type: Experiment
- Status: Rejected
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: `0e1e787`
- Related: [decision 0012](./0012-evidence-gated-pi-profiles.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

An isolated `pi-readseek@0.9.10` worker profile completed the same real documentation task as the minimal Pi profile, produced a valid artifact, and reported 83 passing tests. It was not promoted because it used 5.805 times the total Pi tokens, took 2.716 times as long, made 4.933 times the tool calls, and produced a 2.693-times-larger persisted Job record. The repository keeps the minimal Pi route.

## Context

AgentKnot self-hosting should improve downstream completion while reducing upstream intervention and token burden. Decision 0012 therefore requires an exact-version, no-pollution, same-task A/B before a community extension can enter real dogfood dispatch.

The task was an already admitted Stage 0 documentation item: replace the README capability list with an availability table that distinguishes current, experimental, proposed, and deferred behavior, update the changelog and roadmap, and run the full test suite. A direct leaf Job fixed the route and prompt instead of allowing planner decomposition to confound the comparison.

## Package review and isolation

- npm package: `pi-readseek@0.9.10`, integrity `sha512-sUfQUb8v1eDG0BIX6zfH5w4T4Emb5IWEYYoOEwJrWfxvgr83g8iGAtKeEqA0EsFuFP4+Rc7sy0GG3Yr9r1hdDg==`.
- Native dependency: `@jarkkojs/readseek@0.9.10` and Linux x64 binary `0.9.10`; the package includes an LGPL-2.1-or-later component and starts the local binary.
- The extension registers anchored edit/write/grep, structural search/navigation, digest, and document tools. It reads global/project settings and initializes `~/.pi/readseek`, so it was not safe to point directly at the normal worker home.
- Dependencies, lockfile, HOME, settings, index data, Job store, and worktrees were placed under one `/tmp` experiment directory. The target repository and global Pi package configuration were not used for installation. Image analysis was disabled. Pi auth was read from the existing explicit agent directory without copying credential contents.
- Ambient extensions, skills, prompt templates, and themes remained disabled; the reviewed extension was the only explicit resource.
- The exact route for both arms was Pi → OpenCode Go → `gpt-5.6-luna` with `thinkingLevel: "max"`, one attempt, and no fallback. The explicit extension route passed a live inference probe before the task.

## Evidence

Both jobs ran from base `0e1e7878a83434bb5963082b04036fc9ef86cb38`, succeeded on attempt one, produced checksum-valid artifacts, and reported `npm test` with 83 passing tests.

| Measure | Minimal | `pi-readseek@0.9.10` | Profile/minimal |
| --- | ---: | ---: | ---: |
| Job | `job_9890c24c-886d-44c9-ad24-6ffe945ec833` | `job_0dc2c8c0-6d91-4760-9256-52bb22c710fa` | — |
| Elapsed | 76.694 s | 208.327 s | 2.716× |
| Tool calls | 15 | 74 | 4.933× |
| Assistant messages | 8 | 35 | 4.375× |
| Raw events | 233 | 885 | 3.798× |
| Input tokens | 24 | 105 | 4.375× |
| Output tokens | 7,595 | 15,575 | 2.051× |
| Cache-read tokens | 170,878 | 1,165,641 | 6.821× |
| Cache-write tokens | 36,689 | 67,772 | 1.847× |
| Total tokens | 215,186 | 1,249,093 | 5.805× |
| Final context usage | 37,518 | 68,273 | 1.820× |
| Reported cost | 0.010854305 | 0.02948341 | 2.716× |
| Persisted Job size | 846,541 B | 2,279,406 B | 2.693× |
| Artifact size | 5,762 B | 7,578 B | 1.315× |

The extension used its tools in practice, beginning with parallel `readSeek_digest` calls for the authority documents and later anchored writes/checks. This did not reduce downstream work for the documentation workload. Both artifacts required the same upstream integrity and content review. The profile artifact's replace-in-place table structure was selected as the better integration starting point, then corrected upstream; this one useful output did not offset the repeatability, resource, and latency regressions.

## Decision rationale

Completion and tests were equal, so there was no completion-rate gain in this pair. The profile was materially worse on every measured efficiency dimension and expanded persisted evidence, an existing Stage 1 risk. The magnitude is large enough to reject this configuration without spending more Luna calls to reproduce the same negative result. This result applies to `pi-readseek@0.9.10` with `edit`, `grep`, and `write` overrides on a documentation-heavy AgentKnot task; it is not a claim that every future version or narrowly targeted code task must behave identically.

## Consequences

- `pi-readseek` is not added to `agentknot.config.json`, the repository dependencies, global Pi state, or dogfood dispatch.
- The minimal Pi worker remains the formal route and rollback is unnecessary because no promotion occurred.
- Future candidate profiles must reduce tool/schema surface or context rather than adding broad navigation tools to every task.
- Artifact review remains upstream even when a profile output is selected.

## What went well

The adapter's ambient isolation and session-stat telemetry made the comparison reproducible and exposed a regression that subjective output review could have missed. Separate worktrees preserved the same base and valid artifacts without mutating main. The explicit HOME contained the extension's index and npm writes under `/tmp`.

## What did not go well

The first candidate added a large tool and prompt surface to a task that did not need structural code navigation. The worker made many more tool calls and the full raw-event persistence amplified the cost into a 2.28 MB Job record. One pair cannot estimate completion probability, but it can establish that this configuration does not clear the promotion gate.

## Corrective actions and gates

- [x] Reject this profile and keep the minimal formal route.
- [x] Preserve exact job, artifact, route, and sanitized usage evidence.
- [ ] Evaluate a narrower context-reduction candidate with the same isolation rules and a workload suited to its claimed benefit.
- [ ] Add persisted record-size limits before promoting profiles that materially expand raw tool output.

## Deferred work

A future readseek version or task-specific profile may be reconsidered only after a narrower hypothesis and a new exact-version review. It must not inherit promotion from this experiment.

## Privacy and security review

No credential values, auth-file contents, private prompt content, or raw model output are copied into this record. The recorded prompt was repository documentation work. Temporary package/index/Job data stayed outside the repository; its retention is local and separate from the committed project.

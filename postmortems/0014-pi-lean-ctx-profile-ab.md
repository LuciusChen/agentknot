# 0014: Keep pi-lean-ctx experimental after one beneficial A/B pair

- Type: Experiment
- Status: Needs replication
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: `72ceac8` and the unreleased persisted-record versioning slice
- Related: [decision 0012](./0012-evidence-gated-pi-profiles.md), [experiment 0013](./0013-pi-readseek-profile-ab.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

An isolated `pi-lean-ctx@3.9.18` worker profile completed the same real persisted-record versioning task as the minimal Pi profile and produced a smaller valid artifact that passed the same 88-test worker check. Compared with the minimal arm, it reduced elapsed time by 30.5%, total Pi tokens by 39.0%, reported cost by 22.9%, assistant messages by 48.0%, and raw events by 12.5%. The reviewed profile artifact was used as the upstream integration starting point and passed the unmodified repository test suite after upstream corrections.

The profile is not promoted from this one pair. Tool calls increased by 11.8% and final context usage increased by 13.0%, and one run cannot establish a completion-rate improvement. The formal dogfood route therefore remains the minimal Pi profile until an independent repeat clears decision 0012's evidence gate.

## Context

Experiment 0013 showed that adding a broad navigation and editing surface could make a passing worker much less efficient. The next hypothesis was narrower: replacing only Pi's local read, shell, list, find, and grep tools with bounded-output equivalents could reduce downstream context and repeated assistant work without moving orchestration or product decisions into the worker.

The accepted task was the next Stage 0 roadmap slice: add top-level schema version 1 to newly persisted Job and Orchestration records, materialize a missing version as legacy v1 in memory without rewriting a read-only snapshot, reject explicit unsupported versions, test both stores, update the authority documents, and run the full suite. A direct leaf Job fixed the task and avoided planner decomposition as a confounder.

## Expected invariant

- Both arms use Pi → OpenCode Go → `gpt-5.6-luna` with `thinkingLevel: "max"`, the same committed base, one attempt, and no fallback.
- A community extension remains explicit, exact-versioned, isolated from the repository and normal Pi HOME, and removable in one profile change.
- Completion, artifact integrity, tests, and upstream review do not regress.
- The worker may produce an artifact but cannot apply, commit, push, merge, or deploy it.
- A profile is formally promoted only after repeated evidence, not one favorable result.

## Package review and isolation

- npm package: `pi-lean-ctx@3.9.18`, integrity `sha512-zzxuaHSfHy8njZaGJMsIUI6tidAuus4MgLO47gqvpzYTZRsS9Lx3DCdcvKCz9ONs168lT1pEBT+Za9L62HgLCg==`.
- Source: `https://github.com/yvgude/lean-ctx`, release `v3.9.18`, Apache-2.0.
- Linux x86-64 GNU binary SHA-256: `8e3676b2a3394e337815a8fe52aa3d56d47f198ffad266c783eb870e7a9e6678`.
- The reviewed package, native binary, dependencies, lockfile, HOME, Job store, and worktrees lived under `/tmp`; no package was installed in AgentKnot, global Pi state, or the target repository. The temporary dependency tree reported zero audit findings at review time.
- The explicit profile set `LEAN_CTX_PI_MODE=replace`, `LEAN_CTX_PI_ENABLE_MCP=0`, `LEAN_CTX_PI_TOOL_PROFILE=lean`, `LEAN_CTX_PI_DISABLE_TOOLS=lean_ctx,ctx_edit`, and `LEAN_CTX_BIN` to the verified temporary binary. This exposed only replacements for read, bash, ls, find, and grep while retaining Pi's native edit and write tools.
- MCP, persistent knowledge/cache features, cross-job memory, and the extension's advanced tools were disabled. Ambient Pi extensions, skills, prompt templates, and themes remained disabled.
- Source review found that the extension can compress or omit command output. Its passing worker-reported tests therefore did not replace an upstream test run against the unmodified shell and repository.
- The explicit profile passed a real Luna/max inference probe before the A/B task.

## Evidence

Both jobs ran from base `72ceac8a8f69e0523d5f8be86b5f0f5fe5b5494f`, succeeded on attempt one, produced checksum-valid artifacts that passed `git apply --check`, and reported 88 passing tests.

| Measure | Minimal | `pi-lean-ctx@3.9.18` | Profile change |
| --- | ---: | ---: | ---: |
| Job | `job_a3aadb40-4d38-4961-80c6-05296494a3a2` | `job_c512eebc-86f6-4991-bfab-eb7ede528180` | — |
| Artifact SHA-256 | `3f13c7c16c98c4107ca6bd4223d6393bef0f71a0974e73af5cc57a6a4f512442` | `ae26db4585fe15b113436c10b19451057ec9c3caeafef4bedca5bc0a6195f2fc` | — |
| Elapsed | 344.084 s | 239.261 s | -30.5% |
| Tool calls | 76 | 85 | +11.8% |
| Assistant messages | 50 | 26 | -48.0% |
| Raw events | 1,050 | 919 | -12.5% |
| Input tokens | 150 | 78 | -48.0% |
| Output tokens | 28,673 | 25,219 | -12.0% |
| Cache-read tokens | 3,868,603 | 2,292,456 | -40.7% |
| Cache-write tokens | 118,153 | 131,631 | +11.4% |
| Total tokens | 4,015,579 | 2,449,384 | -39.0% |
| Final context usage | 118,751 | 134,192 | +13.0% |
| Reported cost | 0.070673955 | 0.054517635 | -22.9% |
| Persisted Job size | 2,871,015 B | 2,774,432 B | -3.4% |
| Artifact size | 29,265 B | 25,066 B | -14.3% |

The profile artifact implemented version materialization at both the file-store read and write boundaries, which was a stronger integration base than the minimal artifact's read-only boundary. Upstream reviewed that difference, applied the profile artifact manually, improved unsupported-value redaction and test temporary-directory cleanup, and reran the repository's unmodified `npm test`: 88 of 88 passed. This is a real development use of the extension output, not a recommendation-only benchmark.

Pi session statistics are downstream worker evidence. They do not directly measure Codex input tokens, so the experiment supports a downstream-efficiency claim and a plausible reduction in upstream review burden, not a measured upstream-token percentage.

## Decision rationale

The first pair clears the quality floor and shows a material net efficiency benefit despite two negative secondary measures. It is therefore worth continuing and using the reviewed artifact, but it does not clear the repeated-evidence promotion gate. Treating the result as experimental preserves the minimal profile as a stable control and makes rollback immediate while another real workload tests whether the gain generalizes.

## Consequences

- The selected profile artifact is integrated only after upstream review and raw verification; the extension still cannot mutate main directly.
- `pi-lean-ctx` is not added to repository dependencies, global Pi state, or the formal dogfood route from this one pair.
- A repeat trial should watch tool-call count, final context usage, compressed-output omissions, and completion quality in addition to headline token and elapsed reductions.
- The exact package and native binary create a supply-chain and upgrade-review obligation if the profile is later promoted.
- The temporary experiment dependency tree was approximately 192 MB, so promotion needs a reproducible external acquisition/cache strategy rather than copying the trial installation into the repository.

## What went well

Exact-route liveness, isolated package state, immutable hashes, session statistics, worktree artifacts, and an unchanged upstream test run kept the trial measurable. The narrower tool surface avoided the dramatic prompt and raw-event expansion observed with `pi-readseek`.

## What did not go well

The final context and tool-call counts moved in the wrong direction, showing that total token reduction alone does not explain the worker's behavior. One A/B pair cannot measure completion probability or rule out workload-specific luck. The experiment setup is reproducible from recorded inputs but is not yet a maintained AgentKnot profile.

## Corrective actions and gates

- [x] Review and pin the package and native binary without repository or global installation.
- [x] Run the same real task through minimal and explicit lean profiles on Luna/max and preserve Job/artifact evidence.
- [x] Apply only the selected artifact upstream, inspect it, correct it, and rerun the full unmodified test suite.
- [ ] Repeat the A/B on an independent real AgentKnot workload with the same route and quality gates.
- [ ] Promote a named dogfood profile only if the repeat confirms a net benefit and document a reproducible external install/cache plus one-step minimal fallback.
- [ ] Reject or narrow the profile if compressed output causes missed evidence, quality regression, or repeated context/tool-call growth that outweighs its gains.

## Deferred work

Task-dependent automatic profile selection, MCP features, persistent knowledge, repository-local package installation, and general plugin management remain outside this experiment. Promotion of this exact profile would not authorize those capabilities.

## Privacy and security review

No credentials, auth-file contents, private model output, or raw event payloads are copied into this record. Package code ran with worker process authority, so the temporary HOME and disabled optional capabilities reduce contamination but do not constitute an operating-system sandbox. The package and binary hashes identify exactly what was reviewed.

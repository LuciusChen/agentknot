# 0037: Validate one delegated patch in a disposable worktree

- Type: Decision
- Status: Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `cb286c4`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decision 0002](./0002-git-worktree-artifact-handoff.md), [decision 0006](./0006-read-only-artifact-inspection.md), [decision/experiment 0036](./0036-bounded-advisory-quality-review.md)

## Summary

AgentKnot may optionally produce controller-owned validation evidence for exactly one successful delegated child and one bounded verified patch. It rechecks the recorded artifact and clean base, applies the patch only in a fresh disposable worktree, and executes one configured shell-free argument vector there. Validation starts concurrently with an eligible advisory model review, remains advisory regardless of result, and never promotes or applies the artifact to the supplied source workspace.

This narrows the upstream controller's routine burden without asking the worker or reviewer to certify its own work. It is deliberately not a generic workflow runner, validation graph, repair loop, approval system, or sandbox.

## Context and expected invariant

Pre-model delegation and bounded model review shifted substantial controller work downstream, but the controller still had to apply each patch before obtaining independent test evidence. Worker-reported checks are claims, and asking the same or another model to run routine deterministic tests adds tokens and latency without increasing authority over the result.

The invariant is that deterministic validation can strengthen handoff evidence while preserving decision 0002: the caller's source remains unchanged, the patch remains an artifact, and only the upstream controller or human can accept and promote it. Validation must be bounded, optional, durable, cancellation-aware, and route/model-neutral.

## Evidence chronology

1. Exact-route live inference for the configured Pi/OpenCode Go/Luna/max route succeeded at `thinkingLevel=max` before implementation; no provider or model fallback was used.
2. Read-only delegated architecture audit orchestration `orchestration_10ffd0c5-3527-4f90-a0be-4b537456e01e` used one Luna/max child and concluded that a narrow controller-owned evidence operation fits the current Stage 2 handoff boundary, while generic command policy belongs in Stage 3.
3. Delegated implementation orchestration `orchestration_08f6479b-3af2-4bdf-b17d-e2709f038331` produced an integrity-valid configuration/test artifact. The upstream controller inspected and applied that patch; downstream did not commit, push, merge, deploy, or promote it.
4. Deterministic tests cover exact argv execution, nonzero exit, timeout, cancellation, shared stdout/stderr limit, bounded process-start errors, disposable patch application, dirty-source refusal, reviewer/validation overlap, advisory failure, persistence ordering, restart reconciliation, compact handoff, and cleanup.
5. Real orchestration `orchestration_6db8c5c2-3498-4e4d-9387-5381a413f0bd` used Luna/max planning, selected DeepSeek Flash/max for one low-complexity implementation, and used Luna/max for bounded review. The clean fixture baseline passed 3/5. The child produced one 744-byte integrity/base-valid patch changing only `src/assignments.js`; controller-owned `npm test` passed 5/5 in 149 ms with no output truncation and cleanup `cleaned`.
6. Artifact validation started at `02:00:40.088Z`, review started 16 ms later, validation completed at `02:00:40.263Z`, review returned `accept` at `02:02:00.214Z`, and the parent succeeded one millisecond later. This proves actual overlap and persist-before-terminal ordering. The fixture remained at its original clean `HEAD`, AgentKnot listed no managed validation worktree afterward, and no matching Pi process remained.

## Decision rationale

- Configuration is exactly `delegation.artifactValidation.{argv,timeoutMs,maxOutputBytes}`. Omission preserves the prior lifecycle.
- `argv` is 1–32 non-empty strings and is passed directly to one spawned process with `shell: false`; configuration cannot inject a shell expression, alternate working directory, or environment overlay.
- Timeout is 1–300000 ms. Retained stdout plus stderr is one shared 1–65536 byte valid-UTF-8 prefix; output overflow terminates the exact child and is recorded.
- Eligibility is exactly one planned/actual successful child and one integrity/base-valid non-empty patch no larger than 32 KiB. Broader artifact shapes stay with the controller.
- The workspace manager re-inspects the clean source and `HEAD`, re-verifies exact artifact identity, creates a detached worktree at that base, checks/applies only the managed patch, executes from the requested repository subdirectory, and cleans the exact worktree.
- Validation is not a Job or model route. One separate process-local slot bounds validation across orchestrations, while `Promise.allSettled` allows it to overlap the optional reviewer after child dispatch.
- Pending, skipped, unavailable, and completed evidence is serialized with ordered parent events before the terminal event. Command failure, timeout, and output limit become completed advisory failure; inability to establish trustworthy validation or cleanup becomes explicit unavailable evidence.
- Cancellation aborts and awaits validation. Runtime restart never resumes it and marks pending evidence unavailable with cleanup unconfirmed.
- Compact controller handoff retains the command identity/outcome and at most 2 KiB tails for each stream; the full persisted record retains the configured shared bound.

## Alternatives considered

- Requiring the upstream controller to apply every patch and run tests was rejected as the only path because it reproduces routine deterministic work in the expensive controller context.
- Treating worker-reported or reviewer-reported tests as controller validation was rejected because those are untrusted claims and can be stale, fabricated, or run against the wrong bytes.
- Asking Luna to review Luna, or adding Relay-style reviewer conversation, was rejected as a substitute for deterministic execution. A model review and an actual command answer different questions and can run concurrently.
- Running arbitrary shell strings, multiple commands, dependency graphs, route-specific validators, or automatic command selection was deferred. Those require the Stage 3 command-policy and security gates and would cause implementation growth beyond the immediate handoff need.
- Applying the patch to the source before testing was rejected because it breaks artifact-only handoff and makes failure cleanup materially riskier.
- Converting validation failure into child/parent failure or automatic repair was rejected because the worker succeeded under its contract; validation is later evidence for upstream disposition, not retroactive execution authority.

## Consequences and gates

- A configured command can reduce routine upstream tool calls and provide stronger evidence than model claims, but it adds local elapsed time and host resource use.
- The command inherits the AgentKnot process environment and operating-system authority. `shell: false`, a disposable worktree, and exact-child supervision reduce accidental scope but do not create filesystem, network, credential, or descendant-process isolation.
- Ignored dependencies and build outputs are absent from a detached worktree unless the tool can resolve or provision them. Validation failure must remain visible rather than being interpreted automatically as a bad patch.
- One command cannot encode every repository's test matrix. Multiple steps, per-route policies, untrusted command sources, sandbox backends, remote execution, and automatic repair remain outside this decision.
- The current repository enables `npm test` as dogfood configuration. That command is repository policy, not a portable core default.

## Verification

The slice requires the full deterministic suite, the bounded Stage 1 lifecycle soak, clean source/worktree checks, and one real delegated artifact whose configured command passes inside the disposable validation worktree. The real record must also show that model review and command validation are independently persisted before the parent terminal event.

## Privacy and security review

Persisted argv, stdout, stderr, errors, patches, and paths may contain sensitive repository or environment-derived content. Output limits are not redaction. Configuration must not place credential values in argv, and operators must run only trusted commands against credentials and repositories appropriate for the AgentKnot process.

## Addenda

### 2026-08-10: Real isolated validation and review overlap

The fixture's committed tests intentionally began at 3/5. The delegated worker also reported running them, but that statement was not used as validation authority. AgentKnot independently re-read the recorded artifact, applied its exact verified bytes in a second worktree, and persisted the complete 5/5 test output, exit code zero, 149 ms duration, and successful cleanup.

Reviewer job `job_e21a9e59-9249-4531-b9a5-d9c04f2e1f13` used zero tools and reported 11,538 provider-total tokens over about 80.1 seconds. The deterministic command used no model route and completed while that reviewer was active. The comparison does not make their roles interchangeable: the command proves the repository's configured tests against exact patch bytes, while review evaluates the supplied behavior and patch semantics. This run used the CLI directly rather than a Codex model turn, so it contains no upstream-token measurement and makes no additional savings claim.

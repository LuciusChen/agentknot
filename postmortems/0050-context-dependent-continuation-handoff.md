# 0050: Recover bounded continuation tasks without reading controller transcripts

- Type: Incident / Decision
- Status: Resolved / Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected versions/commits: `c9553fe` and earlier controller packages
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decisions 0030](./0030-pre-model-controller-dispatch.md), [0045](./0045-controller-session-workspace-binding.md), [0047](./0047-resumable-controller-binding-and-replaceable-role-pools.md), and [incident/decision 0048](./0048-controller-hook-failure-blocking.md)

## Summary

A resumed Codex session submitted `go on` and then `go on ~/.emacs.d/straight/repos/chirp`. Both installed `UserPromptSubmit` executions resolved the intended Chirp workspace and completed normal AgentKnot orchestration, but each planner correctly retained the exact submitted text because it contained no bounded deliverable. The hook then injected `do not invoke AgentKnot again for this prompt`, which prevented the controller from using its own conversation context to reconstruct the concrete ongoing task and delegate it normally.

The shared Codex/Claude hook now keeps the exact-text planner decision while removing that blanket prohibition. It conditionally instructs the controller to recover one concrete bounded self-contained task from context it already owns, submit that recovered task through the normal AgentKnot entry once before repository execution, and accept a second normal keep-upstream decision if policy requires it. The hook still does not read transcripts, classify continuation phrases, infer task semantics from a path, choose a route/model, or bypass product exclusions.

## Expected invariant

Workspace continuity and task semantics are separate. A session binding must make a resumed repository addressable, but a path alone must not invent a task. At the same time, an exact-prompt upstream decision must not forbid a controller that already has the missing conversation context from constructing an ordinary bounded AgentKnot request. Informational chat, requirements/product decisions, artifact integration, commit, push, merge, and deployment remain upstream.

## Evidence and timeline

- Controller session: `019feaf6-b3a9-7321-8010-8998a45e7bf1`.
- At `2026-08-10T11:23:15Z`, `go on` entered orchestration `orchestration_6dcb531b-fe7f-4626-9728-598dcc313ae5`. Planner Job `job_cc6f3c16-61ce-4c77-989f-703f231fc381` succeeded on Pi/OpenCode Go/Luna/max and returned an upstream plan with no child.
- At `2026-08-10T11:24:15Z`, `go on ~/.emacs.d/straight/repos/chirp` entered orchestration `orchestration_fb1f2821-f9ab-4f01-a9b0-243cad206d22`. Planner Job `job_e15640aa-0cd9-465e-a752-1952ff69edd5` succeeded on native OpenCode/OpenCode Go/Luna/max and likewise retained the prompt upstream.
- The second hook output explicitly said the request did not define a bounded deliverable or file/component scope, then appended the blanket `do not invoke AgentKnot again` instruction. The controller proceeded with repository tools and finished the prior code-convergence task itself.
- Both successful planner records prove that resume binding, explicit-path workspace resolution, shared-service access, and heterogeneous planner routing were working. No child was expected from either exact text alone.
- A delegated read-only architecture review, orchestration `orchestration_a112855f-c371-4f1e-972b-b4d4d304fefd`, independently identified the same hook boundary and recommended a wording-only controller-context bridge. Its native OpenCode/Luna/max child `job_2974ab93-cee0-4b0b-8cdc-2af827904ecf` returned a valid completion envelope and verified empty artifact.

## Root cause and decision rationale

The planner intentionally receives `request.prompt`, not the controller transcript. The hook cannot know that `go on` refers to a previously agreed refactor. `plan.willDispatch: false` was therefore correct for the exact text. The defect was conflating that result with a prohibition on a different, context-enriched request that only the upstream controller could construct.

The correction stays at the adapter wording boundary:

1. Preserve the planner reason and normal non-blocking upstream result for the submitted text.
2. Prohibit resubmitting that same context-free text.
3. If and only if the controller's existing context contains one concrete bounded repository task, require the controller to reconstruct a self-contained task and use the normal AgentKnot entry before doing its repository work upstream.
4. Reapply every normal planner, keep-upstream, route, depth, concurrency, artifact, and promotion rule to the recovered task.

This requires one controller-model pass and therefore is a compatibility bridge, not equivalent to first-pass pre-model dispatch or evidence of the same token reduction.

## Alternatives considered

- Scan or parse controller transcripts in the hook. Rejected because transcript formats are controller-specific, unstable, potentially sensitive, and outside the thin adapter boundary.
- Treat repository paths or dirty diffs as task semantics. Rejected because they identify state, not user intent or acceptance criteria.
- Hardcode continuation phrases such as `go on` or `继续`. Rejected because it is language-specific, incomplete, and still cannot reconstruct the task.
- Persist only prior user prompts. Rejected because contextual prompts may depend on assistant findings, decisions, or tool evidence absent from those prompts.
- Automatically delegate an inferred “continue current work” Job. Rejected because the worker would receive an ambiguous goal and could silently diverge.
- Add transcript or continuation fields to core orchestration schemas. Rejected because no new protocol is needed; the controller can form an ordinary self-contained request through the existing boundary.

## Consequences

- Resume and explicit-path continuation can now recover delegation when the controller conversation contains enough task context.
- Self-contained prompts keep the efficient pre-model path; contextual recovery spends one upstream turn before any downstream work.
- The hook remains controller-neutral and source-neutral. Codex and Claude package copies stay byte-identical after their explicit marker differences are normalized.
- A controller could still fail to follow the conditional instruction. Deterministic hook tests prove the supplied contract, not real-model compliance; one real resumed-controller regression remains required before promotion claims.

## Corrective actions and gates

- [x] Maintainers — replace the blanket no-reinvocation sentence in both shared hook copies with conditional recovered-task guidance.
- [x] Maintainers — cover Codex and Claude explicit-path, continuation, `SessionEnd` resume, exact prompt/workspace forwarding, ignored transcript-shaped event data, retained planner reasoning, and absence of the old prohibition.
- [x] Maintainers — preserve the existing explicit-invocation bypass and normal delegation-policy exclusions.
- [ ] Maintainers — reinstall the refreshed Codex package and run one real resumed context-dependent prompt; require a newly reconstructed AgentKnot request before any controller repository tool call.
- [ ] Maintainers — collect upstream/downstream usage for that real regression without claiming parity with self-contained pre-model dispatch.

## Privacy and security review

No transcript content is copied, parsed, persisted, or sent to AgentKnot by this change. The controller itself already owns its conversation and sends only the reconstructed task it selects. Session workspace records retain only their existing Git-root and hashed common-directory identity evidence.

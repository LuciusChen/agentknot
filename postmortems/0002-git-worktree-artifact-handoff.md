# 0002: Use Git worktrees and patch artifacts for handoff

- Type: Decision
- Status: Accepted
- Date: 2026-08-08
- Owners: AgentKnot maintainers
- Affected versions/commits: 0.0.x worktree isolation implementation
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [dirty snapshot decision 0049](./0049-dirty-workspace-snapshot-isolation.md)

## Summary

AgentKnot's protected repository workflow runs each attempt in a detached Git worktree created from one inspected base commit. It captures the attempt as a verifiable patch artifact and removes the managed worktree. It never applies the patch to the caller's source workspace automatically.

## Context

Delegating implementation directly to a background worker in the caller's working directory gives that worker immediate mutation authority. Retries can inherit partial changes, cancellation can leave unknown state, and a successful model response does not provide a clean acceptance boundary.

The orchestrator needed a worker-neutral mechanism that protects the source repository and works for Pi or another future worker without moving Git policy into each adapter.

## Expected invariant

- Workspace lifecycle belongs to the orchestrator, not a worker adapter.
- The caller's source repository remains unchanged in `git-worktree` mode.
- Every retry starts from the same recorded base commit.
- Artifacts identify their base and integrity and are handoff data only.
- Cleanup targets only exact AgentKnot-owned paths.

## Evidence chronology

1. Git worktree isolation was placed in a dedicated workspace manager invoked by the orchestrator around each attempt.
2. Source admission was restricted to repositories with `HEAD` and a clean tracked and non-ignored state.
3. Patch capture was expanded to include tracked, non-ignored untracked, binary, and worker-committed changes.
4. Patch comparison was anchored to the recorded base commit rather than the detached worktree's potentially advanced `HEAD`.
5. Retry tests established distinct worktree paths created from one base.
6. Cancellation handling was hardened so a worker that returns normally after abort cannot produce success.
7. Cleanup was narrowed to exact managed paths; broad repository-wide worktree pruning was avoided.

## Decision rationale

Git worktrees provide a small, vendor-neutral attempt boundary using tooling already present in coding repositories. A binary patch is reviewable, hashable, portable, and separate from acceptance. Keeping this lifecycle in the orchestrator gives all workers the same retry and artifact semantics.

This is repository-state isolation, not host security. The implementation and docs must preserve that distinction.

## Alternatives considered

### Run directly in the source workspace

This remains compatibility mode `none`, but it cannot promise source cleanliness, attempt independence, or patch artifacts. It is unsuitable as the protected default for unattended delegation.

### Let each worker manage branches or worktrees

That would duplicate policy across Pi and future adapters and make retries worker-dependent. It was rejected because workspace lifecycle is an orchestrator concern.

### Automatically apply a successful patch

Worker completion is not equivalent to acceptance. Auto-application was rejected because it removes the review boundary and can overwrite concurrent human work. Promotion must be explicit and separately verified.

### Use containers immediately

Containers or another sandbox backend may later bound host permissions, but they add image, dependency, filesystem, credential, and platform policy. They do not replace the Git artifact contract and were deferred until a concrete threat model justifies them.

## Consequences

### Positive

- Source workspaces remain reviewable and clean under the protected mode.
- Attempts are deterministic with respect to Git base.
- Workers remain unaware of orchestration isolation policy.
- Failed and cancelled attempts can still yield diagnostic artifacts.

### Costs and risks

- Ignored dependencies and build outputs are missing from detached worktrees.
- Untracked ignored files are deliberately not included in patches.
- Large or sensitive patches require retention and redaction policy.
- Git repositories without a clean state or valid `HEAD` are rejected.
- Worktree isolation does not restrict host filesystem, process, network, or credential access.
- Artifact inspection and explicit promotion are not yet complete product workflows.

## What went well

Tests exercised tracked, untracked, binary, committed, retry, cancellation, and cleanup behavior instead of treating worktree creation alone as sufficient isolation. Review found subtle base-commit and cancellation-result failure modes before the contract was documented as stable.

## What did not go well

The first implementation risked comparing only against the worktree's current `HEAD`, which can omit worker-created commits. Broad cleanup approaches such as repository-wide pruning would also have exceeded AgentKnot's ownership. These failure classes should have been explicit invariants before implementation.

## Corrective actions and gates

- [x] Capture diffs from the recorded base commit.
- [x] Include non-ignored untracked and binary changes.
- [x] Reject a normal worker result received after cancellation/timeout.
- [x] Use exact owned-path cleanup and test source cleanliness.
- [x] Add artifact list, verification, and bounded preview — Stage 1; see [decision 0006](./0006-read-only-artifact-inspection.md).
- [ ] Add a deliberate promotion workflow only if its refusal and approval contract can be made safe — Stage 1.
- [ ] Add artifact size/retention and sensitive-content policy — Stage 1.
- [ ] Add sustained leak and patch-application soak coverage — Stage 1.
- [ ] Evaluate OS sandbox backends separately from Git isolation — Stage 3.

## Deferred work

Automatic application remains a non-goal. An explicitly invoked promotion command may be added only with dirty-target, base-mismatch, checksum, and approval checks.

## Privacy and security review

Patch contents may contain sensitive repository data. This record contains no patch data, credentials, job prompts, or local artifact paths.

## Addenda

### 2026-08-08 — Read-only inspection delivered

Decision 0006 completes listing, size/SHA-256/current-base verification, and integrity-gated bounded preview without changing the original upstream-only promotion boundary. Retention, redaction, clean-application verification, and deliberate promotion remain open.

### 2026-08-10 — Clean-source admission superseded

Decision 0049 replaces the clean tracked/non-ignored admission restriction with a temporary exact-tree snapshot for supported dirty top-level state. The worktree, retry, worker-delta artifact, exact cleanup, and upstream-only promotion invariants remain unchanged.

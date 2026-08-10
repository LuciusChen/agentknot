# 0049: Snapshot dirty workspaces without weakening artifact isolation

- Type: Decision
- Status: Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Related: [worktree decision 0002](./0002-git-worktree-artifact-handoff.md), [controller hook incident 0048](./0048-controller-hook-failure-blocking.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

Git worktree mode admits supported dirty repositories. At Job admission AgentKnot collapses staged and unstaged top-level content plus non-ignored untracked files into one exact Git tree, without changing the caller's worktree, real index, or repository object database. Every attempt receives that snapshot; its artifact contains only the worker delta and records the tree identity used for later drift checks.

## Context

The controller hook correctly blocked when Chirp was dirty, but that made ordinary in-progress development impossible to delegate automatically. Creating a worktree at `HEAD` alone would silently omit the user's uncommitted state. Creating a synthetic commit in the source object database would preserve content but leave hidden user data and dangling objects behind.

## Decision

- Snapshot through an AgentKnot-owned temporary index and temporary object directory. Disable Git optional locks for the source-status probe, start the temporary index at `HEAD`, add the current top-level file tree, write its tree identity, and emit one binary patch from `HEAD`; reject patch representation above the existing 16 MiB artifact budget and delete the temporary Git state before admission continues.
- Create the existing detached managed worktree at the recorded `HEAD` and replay the snapshot patch only there. Reuse the same in-memory snapshot for every retry.
- Reconstruct the snapshot index in temporary Git state when capturing the attempt, so the retained artifact is the worker delta even if the worker stages or commits changes.
- Persist additive `JobArtifact.baseTree` evidence. Verification compares both `HEAD` and, when present, the exact current tree. Artifact validation recreates the unchanged dirty snapshot before applying the worker delta; later source drift is `source-drift`.
- Exclude ignored files as before. Reject dirty submodule contents because the superproject tree records only a gitlink and cannot represent those nested files honestly.
- Preserve legacy artifacts: missing `baseTree` keeps prior HEAD-only inspection, while validation still refuses a dirty legacy base.

## Consequences

Automatic delegation now works during normal staged/unstaged development without copying those changes into the returned artifact or touching the user's staging choices. Staging boundaries themselves are not visible to workers; the snapshot represents the final file tree. Snapshot material is held only for the Job lifetime and its patch representation is capped at 16 MiB before Job creation. Ignored dependencies remain absent, dirty submodules remain unsupported, and filesystem changes racing snapshot construction are not claimed to be an atomic operating-system snapshot.

The change adds no worker/provider/model rule, fallback, second isolation backend, artifact promotion, commit, push, merge, deployment, or host sandbox claim.

## Verification gates

- [x] Staged, unstaged, and non-ignored untracked files appear in the worker worktree; ignored files do not.
- [x] The artifact contains only worker-changed paths and applies against the unchanged dirty source.
- [x] Source index bytes, status, staged/unstaged diffs, object counts, and managed-worktree cleanup remain unchanged.
- [x] Oversized dirty snapshot representation fails before Job admission.
- [x] Verification accepts the unchanged dirty tree and reports `base-tree-mismatch` after same-HEAD drift.
- [x] Disposable validation recreates the dirty baseline before applying the worker delta.
- [x] Retries receive the same admitted snapshot and never inherit prior-attempt changes.
- [x] Dirty submodule content fails before Job admission.

## Privacy and security review

Snapshot bytes can contain non-ignored user source and live in AgentKnot process memory until the Job settles. Temporary index/object paths are exact owned directories removed in `finally`; snapshot capture does not retain those bytes as source-repository objects. Ordinary artifact retention still contains only worker deltas and follows decision 0025. This is Git state isolation, not protection from a worker with host filesystem access.

# 0079: Keep external target worktrees outside the host project ancestry

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-12
- Owners: AgentKnot maintainers
- Affected versions/commits: AgentKnot 0.0.x before this decision
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decision 0002](./0002-git-worktree-artifact-handoff.md), [decision 0078](./0078-exact-artifact-read-grant.md)

## Incident

The first real exact-artifact-read dogfood run targeted a temporary Git repository. Its DeepSeek worker completed and produced a valid one-file patch, but the Luna reviewer failed because its product extension file disappeared during startup. The concurrent validation unexpectedly ran AgentKnot's own 303-test suite and rebuilt `dist`.

The target repository had no `package.json`. Its managed worktree was nevertheless created under `/home/lucius/repos/agentknot/.agentknot/worktrees` because the repository configuration used the relative directory `.agentknot/worktrees`. `npm test` walked upward from the external target worktree, found AgentKnot's package manifest, and rebuilt the live broker installation. The same ancestry could expose AgentKnot's `AGENTS.md` or other host-project context to a worker handling a different repository.

## Root cause

`WorkspaceIsolationManager.#managedRoot()` resolved every relative worktree directory against the runtime base directory. That interpretation is safe only when every target is the runtime repository itself, an assumption that contradicts AgentKnot's middleware role and multi-repository use.

The artifact-read extension initially amplified the race by lazily loading its compiled file from `dist`. The broker's already imported JavaScript remained resident during rebuild, but the not-yet-loaded extension path was briefly absent.

## Resolution

Relative `workspaceIsolation.directory` values are now stable namespace inputs, hashed with the runtime base directory and placed below the platform temporary directory's private `agentknot-worktrees` root. Absolute directories retain exact prior semantics. Attempt names, Git registrations, and cleanup remain bound to the exact generated path.

The Pi artifact extension source is loaded into broker memory with the adapter module and materialized as one content-free attempt file. It no longer depends on a later read from mutable `dist`. The attempt removes that exact file and directory. The extension registers its one product tool during the supported load phase and does not call Pi action methods before the extension runtime is initialized; artifact bytes travel only over the later attempt-owned IPC request.

## Non-claims

This prevents ancestor discovery from crossing into the runtime/config project. It does not sandbox host files, process environment, credentials, network access, or worker tools. A hard crash can still leave a Git worktree registration or temporary path under the existing documented limitations.

## Verification

A deterministic external-target test places a conflicting package manifest in the host project and proves the worker path is outside that ancestry. Final real rerun `orchestration_dfc0c230-c835-42c6-a150-cfd07ba25ba1` placed both the worker and disposable validation path below the hashed platform-temporary root. Validation failed only because the minimal fixture deliberately has no `package.json`; it did not discover or run AgentKnot's package or test suite. The DeepSeek child and Luna review both completed successfully, and the final deterministic suite passes 305/305.

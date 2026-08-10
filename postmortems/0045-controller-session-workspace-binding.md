# 0045: Bind an explicit repository to the controller session

- Type: Incident / Decision
- Status: Resolved / Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected versions/commits: controller plugins through `65e1c8c`
- Related: [decisions 0027](./0027-controller-native-integration-boundary.md), [0030](./0030-pre-model-controller-dispatch.md), [0040](./0040-product-owned-local-service-discovery.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

A new Codex session started from `/home/lucius` with a first prompt that explicitly named `~/.emacs.d/straight/repos/chirp`. The hook inspected only the event cwd, found that `/home/lucius` was not a Git worktree, and silently bypassed AgentKnot. Codex then read and edited Chirp directly; a later continuation prompt contained no path and also could not enter automatic delegation.

Codex and Claude hooks now resolve one workspace from either the event cwd's Git root or unambiguous explicit existing absolute/`~/...` paths in the prompt. When the hook event supplies `session_id`, it retains that root in small product-owned plugin state for later continuation prompts and removes the exact record on `SessionEnd`.

## Expected invariant

Configured automatic delegation should not depend on starting the controller process inside the target repository when the user has already supplied one unambiguous existing repository path. Convenience must not add repository/home scanning, controller-transcript parsing, semantic classification in the hook, or controller-specific routing behavior.

## Evidence

- Codex session `019fea3e-6cb7-78e3-a5ca-70fe91436ba1` began with `cwd=/home/lucius`.
- Its first prompt explicitly named the Chirp checkout with a `~/...` path.
- No new AgentKnot orchestration was admitted for that prompt, while the controller subsequently operated in Chirp directly.
- The prior hook called `git rev-parse --show-toplevel` only against `event.cwd` and exited on failure. It did not inspect explicit path tokens or retain session workspace state.
- The documented controller hook fields provide `session_id`, `cwd`, and the submitted prompt. Transcript format is not a stable integration contract and is not used.

## Decision

Workspace resolution follows this bounded order:

1. If `event.cwd` resolves into Git, its root is authoritative and may refresh the session binding.
2. Otherwise inspect at most 16 explicit absolute or `~/...` path tokens from the exact prompt. Only existing files or directories that resolve into Git count. All valid candidates must converge on one root; multiple roots bypass automatic entry.
3. Otherwise read the exact controller/source session binding and revalidate that it is still the same Git root.
4. If no root resolves, exit without invoking AgentKnot.

The binding is a schemaVersion 1 JSON record containing only controller source and absolute workspace. Its filename is SHA-256 over source plus `session_id`, its size is capped at 4 KiB, and its mode is `0600` below an AgentKnot-owned XDG runtime/cache directory. Writes use an exact temporary file and atomic rename. A missing session ID permits one-shot explicit-path resolution but creates no record. Symlinked, non-regular, insecure-mode, malformed, oversized, or stale records are ignored; `SessionEnd` performs best-effort exact deletion.

Both plugin packages carry the same implementation and hooks so removing one package leaves the other functional. No Job, Orchestration, HTTP, CLI, configuration, or persisted runtime schema changes.

## Alternatives considered

- Scan home or known checkout directories for repositories. Rejected because it is surprising, potentially expensive, and expands the prompt/data boundary.
- Parse the controller transcript to discover later tool working directories. Rejected because transcript shape is not a stable hook contract and would couple AgentKnot to controller internals.
- Add a local semantic classifier or infer repository names from prose. Rejected because semantic delegation remains AgentKnot planner policy and path guessing risks routing work to the wrong repository.
- Require every user to start a new controller process in the repository or repeat `--workspace` in every prompt. Rejected because the explicit path already provides deterministic intent and continuation prompts are an ordinary session workflow.
- Store session workspace in the shared AgentKnot server. Rejected for this slice because it would add a public endpoint, authorization questions, remote/session lifecycle semantics, and core state for controller-local structural data.

## Consequences

Sessions opened from home or a repository parent can automatically delegate after one explicit repository path, and later short continuations reuse the same root. A prompt that genuinely spans multiple repositories does not auto-dispatch from a non-Git cwd; the controller/user must make the target explicit in a later prompt or invoke the Skill directly. Crash-ended sessions may leave a small path-only record keyed by the hash of its controller source and exact session ID; no directory sweep or retention subsystem is introduced.

The hook still forwards every non-explicit prompt in a resolved `auto` workspace to the configured planner, with the existing latency, downstream quota, and prompt-retention consequences. Binding chooses only the workspace and never chooses whether to delegate or which route/model runs.

## Corrective actions and gates

- [x] Codex and Claude — resolve one explicit absolute/tilde path from a non-Git cwd — deterministic parity fixture.
- [x] Codex and Claude — reuse the root for a path-free continuation under the same `session_id` — deterministic parity fixture.
- [x] Codex and Claude — remove the exact binding on `SessionEnd` and prove the next path-free prompt bypasses — deterministic parity fixture.
- [x] Maintainers — prove two explicit paths resolving to different Git roots bypass without an AgentKnot CLI call — deterministic ambiguity fixture.
- [x] Maintainers — run the complete suite with isolated runtime ownership — 237 of 237 tests passed.
- [x] Maintainers — after the complete suite passed, refresh the installed Codex plugin to `0.1.0+codex.local-20260810-145700` while preserving every prior cache root used by active sessions; Claude has no installed local cache in this environment and its repository package remains covered by the parity/install fixtures — installation handling under decision 0039.

## Privacy and security review

The record stores one absolute repository path, which may reveal a local project name. It stores no prompt, transcript, credential, provider/model, route, Job ID, artifact, or source content. The incident evidence omits the original task details beyond the repository path needed to explain the resolution failure.

## Addenda

### 2026-08-10 — resumed sessions retain the binding

The `SessionEnd` deletion decision above is superseded by [decision 0047](./0047-resumable-controller-binding-and-replaceable-role-pools.md). Normal controller exit followed by resume is a continuation of the same source/session identity, so the binding is retained. New writes add a non-secret hash of the Git common-directory path/device/inode and revalidate it with the root before reuse, rejecting a replaced repository at the same path. The original explicit-path resolution evidence and all other containment rules remain unchanged.

### 2026-08-10 — the binding is a target, not a model hint

Persisted evidence later showed the same cross-repository comparison prompt once admitted with `/home/lucius/coding-guidelines` as its workspace and later with `/home/lucius/repos/agentknot`; the planner prompt previously called this only an “execution workspace” and allowed another named repository to become an edit target. That exceeded the actual one-workspace isolation contract and left target/reference roles open to model reinterpretation. The admitted workspace is now explicitly the sole writable primary target in planner and worker prompts; all other repositories are read-only references, and conflicting edit intent is retained upstream as a visible workspace mismatch. This adds no path-role classifier, request field, schema, or multi-workspace execution.

### 2026-08-11 — distinguish the logical source from the managed worktree

A worker later refused valid delegated work because its prompt called the source checkout writable while execution was correctly isolated elsewhere. The execution prompt now calls `request.workspace` the authoritative logical target but states that the active managed worktree/current working directory is the only writable repository and the source path must not be accessed directly. Decision [0053](./0053-controller-owned-planning-handoff.md) also removes the middleware planner; session binding still identifies the target, while the upstream controller authors task semantics.

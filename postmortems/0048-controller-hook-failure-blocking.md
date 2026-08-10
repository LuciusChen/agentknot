# 0048: Block controller prompts when automatic entry fails

- Type: Incident / Decision
- Status: Resolved / Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected versions/commits: through `b21d29c`
- Related: [decision 0001](./0001-vendor-neutral-control-plane.md), [decision 0002](./0002-git-worktree-artifact-handoff.md), [incident 0033](./0033-controller-timeout-phase-claim.md), [decision 0045](./0045-controller-session-workspace-binding.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)
- Severity: Medium upstream-token and operator-trust risk

## Summary

A fresh Codex session in the Chirp repository ran the installed `UserPromptSubmit` hook, but `agentknot orchestrate` rejected the dirty source repository and exited nonzero with a structured terminal handoff on stdout. Node's `execFile` rejection path discarded that stdout. The hook injected only a generic failure context instructing the controller to continue upstream, so Codex immediately repeated repository discovery and review itself.

Automatic-entry failures now return the host's blocking `UserPromptSubmit` result. The adapter retains only a bounded orchestration ID, terminal status, and error message from nonzero structured stdout. The submitted prompt does not reach the controller model until the operator resolves the reported prerequisite and retries.

## Expected invariants

- An automatic-entry failure must not silently turn the same repository task into controller-model work.
- A nonzero CLI exit may still carry authoritative bounded terminal evidence on stdout.
- Error reporting must remain lifecycle-phase-neutral and must not expose full failed handoffs or artifacts.
- Dirty source repositories remain rejected by protected Git-worktree execution; controller adapters do not invent a snapshot or direct-workspace fallback.

## Evidence and root cause

- The Chirp hook displayed `completed`, proving the host executed the hook, but its context said automatic entry failed and then Codex ran `pwd`, `rg`, `git status`, and `git log` itself.
- Replaying the exact hook command returned a failed terminal orchestration whose error was `Workspace repository is not clean: /home/lucius/.emacs.d/straight/repos/chirp`.
- The hook awaited `execFile`. On nonzero exit it entered the outer catch using only the generic command exception message, unlike service discovery, which already recovered stdout before parsing it.
- The catch emitted ordinary additional context ending in `Continue upstream`. That made failure advisory and allowed the controller-model request to proceed.
- Existing parity tests covered malformed successful stdout but did not cover structured stdout paired with a nonzero exit or assert that failure blocks the controller-model request.

## Decisions

- Reuse the existing bounded nonzero-stdout recovery helper around `orchestrate`; add no new transport, schema, or runtime branch.
- Parse the compact handoff, and when its explicit terminal status is not `succeeded`, report only bounded ID, status, and `error.message`.
- Return `{ "decision": "block", "reason": "..." }` for discovery, CLI, terminal-orchestration, and handoff-parsing failures. This stops only the submitted prompt; it does not disable the hook or mutate delegation policy.
- Keep `plan.willDispatch: false` non-blocking because it is an intentional planner decision, not automatic-entry failure.
- Preserve the clean-source worktree invariant. Dirty-snapshot execution or a direct-workspace worker would require a separate product decision and evidence.
- Keep the shared controller script byte-identical. Source namespaces and invocation markers remain adapter inputs; worker, provider, model, and effort remain deployment configuration.

## Alternatives considered

- Continue upstream but include the exact error. Rejected because it still spends controller tokens on work the configured automatic boundary failed to delegate.
- Treat a dirty repository as read-only-safe and bypass isolation. Rejected because task intent may change during planning and protected worktree evidence depends on an exact clean base.

This rejection applied to bypassing isolation. Decision 0049 later added exact dirty-source snapshots while preserving protected worktrees and worker-delta artifacts; it does not revive the bypass alternative.
- Serialize the complete failed handoff into the blocking reason. Rejected because children, artifacts, and repeated request data are unnecessary and enlarge the controller boundary.
- Retry or select another worker/model. Rejected because entry failure is not evidence that another route is correct, and silent fallback violates persisted route authority.

## Consequences

An `auto` repository now fails closed at the submitted-prompt boundary. Operators see the actual bounded prerequisite and must resolve it or explicitly change delegation policy before retrying. This can interrupt a prompt that previously continued upstream, but the interruption is visible and prevents hidden duplicate work. Deliberate upstream planning results behave as before.

## Corrective actions and gates

- [x] Controller adapters — recover structured orchestration stdout on nonzero exit and reject explicit non-success status.
- [x] Controller adapters — emit a blocking, bounded, phase-neutral reason for every contained automatic-entry failure.
- [x] Tests — run the same malformed and structured-nonzero cases through Codex and Claude packages, proving exact inherited arguments, no preview, and no fallback.
- [x] Maintainers — refresh and reinstall Codex plugin `0.1.0+codex.20260810173230`, preserve older active-session roots through compatibility links, confirm `/hooks` reports `UserPromptSubmit` installed/active, and reproduce the Chirp dirty-repository failure in fresh controller session `019feb05-3152-7c42-ad87-585abe0a3882`. It blocked on orchestration `orchestration_70fc0e79-89e2-467c-b502-90e77eff17f6` without a controller reply or repository tool call.
- [x] Maintainers — run the complete isolated suite after documentation review — 245/245 passed; the first attempt's two storage-ownership failures were caused by the deliberately running shared service, and the same complete suite passed after that service was stopped and was then restored on `127.0.0.1:7391` with its service-only PATH.

## Privacy and security review

The block reason contains at most the existing bounded generic error or one compact orchestration ID, status, and error message. It does not include the prompt, child output, patch bytes, provider response, credential, or full durable record. Existing absolute workspace paths may appear in operational errors exactly as they did in CLI output.

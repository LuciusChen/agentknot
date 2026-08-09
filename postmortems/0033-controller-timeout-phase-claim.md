# 0033: Remove the false pre-dispatch claim from hook failures

- Type: Incident and experiment
- Status: Resolved
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `b1d116c`
- Related: [decision 0030](./0030-pre-model-controller-dispatch.md), [incident 0031](./0031-bounded-pi-output-drain.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

Both thin controller hooks wrapped configuration, policy lookup, orchestration, terminal-status, JSON parsing, and handoff assembly in one catch boundary, but every caught error told the controller that automatic entry was unavailable "before dispatch." A real Codex timeout experiment proved that the same branch runs after a child was persisted and started. The message contradicted the authoritative orchestration record even though AgentKnot correctly completed timeout and cleanup. Both hooks now say only that automatic entry failed to return a usable handoff.

## Impact and invariant

No worker, route, artifact, or cleanup behavior was wrong, and no fallback occurred. The impact was misleading controller context: a controller could report that no dispatch happened after a child actually ran and failed. Controller adapters may summarize an unavailable handoff, but they must not infer a lifecycle phase that the CLI error does not prove; durable Job and Orchestration records remain authoritative.

## Evidence chronology

The experiments used real Codex `gpt-5.6-sol` at `xhigh`, the installed AgentKnot Codex hook, the actual AgentKnot CLI/runtime, clean temporary Git repositories, and existing deterministic Pi RPC fixtures. They did not invoke Claude, Luna, DeepSeek, Grok, or a real provider.

1. An initial planner-failure attempt created AgentKnot storage in a temporary repository that did not ignore `.agentknot/`. Worktree admission correctly rejected the now-dirty repository before starting a planner. This setup error is excluded from planner-failure evidence. Adding and committing `.gitignore` fixed the experiment rather than weakening cleanliness checks.
2. Planner-failure orchestration `orchestration_95352992-35a5-47fd-a605-b3e75ee596a5` ran one deterministic planner Job, rejected its `not json` output under `fallback: "fail"`, persisted no plan or child, removed the planner worktree, and failed in 57 ms. Codex reported 13,590 input tokens, 9,984 cached input, and 16 output tokens.
3. Before the wording fix, timeout orchestration `orchestration_3d116b01-bfe6-4eba-b327-19b9ae79aea9` persisted `orchestration.child.started`, timed the child out after 500 ms, observed its ignored SIGTERM marker, killed exact PID `2142241`, removed the managed worktree, and failed the parent in 664 ms. Codex then incorrectly said automatic entry was unavailable before dispatch; it reported 13,582 input tokens, 9,984 cached input, and 16 output tokens.
4. The hooks and deterministic failure assertions were changed to `AgentKnot automatic entry failed to return a usable handoff:` and to reject the old phrase. The two hook files remained byte-identical and the complete suite passed 162/162.
5. After refreshing and reinstalling Codex plugin cachebuster `0.1.0+codex.20260809133142`, timeout orchestration `orchestration_56118006-ed33-4680-9905-500a45dd179b` again persisted a child start, timed out, removed exact PID `2147071` and the managed worktree, and failed in 667 ms. A new Codex thread accurately reported that no usable handoff returned, using 13,744 input tokens, 9,984 cached input, and 19 output tokens.

## Root cause and correction

The hook error branch described where failure happened even though it only knew that `execFile`, JSON parsing, or handoff construction threw. CLI nonzero status can represent planner failure before child admission or a failed orchestration after child dispatch and cleanup. The correction removes only the unsupported phase claim; it does not add error schemas, inspect internal records, parse stderr semantically, retry, select another route, or move cleanup into the controller plugin.

## Corrective actions and remaining gates

- [x] Use phase-neutral bounded failure context in both controller hooks.
- [x] Preserve the no-silent-worker/provider/model-substitution instruction.
- [x] Prove real Codex planner failure admits no child and removes its planner worktree.
- [x] Prove a real Codex deterministic Pi route timeout settles only after exact PID and managed-worktree cleanup.
- [x] Refresh, validate, reinstall, and exercise the Codex plugin in a new thread.
- [ ] Repeat controller parity through real Claude after a Claude subscription is available.
- [ ] Treat real provider timeout behavior as separate provider evidence rather than generalizing from the deterministic fixture.

## Privacy and cleanup

The record contains only public source paths, temporary repository names, durable record identifiers, fixture PIDs, and aggregate token counts. It contains no credentials or provider response text. Both exact temporary repositories and their generated records were moved to the system trash after documentation and verification, so the cleanup remains recoverable until the trash is emptied.

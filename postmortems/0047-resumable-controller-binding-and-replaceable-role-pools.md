# 0047: Resume controller bindings and make orchestration roles replaceable

- Type: Incident / Decision
- Status: Resolved / Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected versions/commits: through `330e700`
- Related: [decision 0001](./0001-vendor-neutral-control-plane.md), [decision 0042](./0042-complete-route-pool-balancing.md), [decision 0045](./0045-controller-session-workspace-binding.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

Two dogfood assumptions contradicted the vendor-neutral product boundary. Configuration allowed pools for leaf and child dispatch, but validation forced planner and quality-review roles to one exact route. The repository then fixed planning/review to Pi and its low-complexity rule to one Pi/DeepSeek route, starving the independently configured OpenCode backend. Separately, `SessionEnd` deleted the controller-to-workspace binding, so exiting and resuming the same controller session from a non-repository cwd lost automatic delegation.

Planner and quality-review targets may now use the existing complete-route pools. The dogfood policy names logical role/capability pools containing multiple complete Pi and OpenCode routes; selected Jobs retain exact worker/provider/model/effort evidence. The shared hook accepts any bounded adapter-provided source namespace rather than branching on controller names. Bindings survive normal `SessionEnd` and are reused only for the same source/session after Git-root and common-directory identity validation.

## Expected invariants

- Planner, worker, reviewer, adapter, provider, model, and effort are deployment configuration, not core role identities.
- More than one replaceable downstream can participate in each configured orchestration role without adding another scheduler.
- Resuming the same controller conversation must load the current hook and recover its previously verified repository without scanning home or parsing transcripts.

## Evidence and root causes

- Persisted native `opencode-luna` Jobs proved the second backend worked, but its last call was 2026-08-10 13:51 CST. Later planner, review, and low-route traffic named exact Pi routes; one failed planner admitted no children into the heterogeneous pool.
- `parseDelegation` accepted pools only for dispatch defaults/rules. It checked planner and quality review only against exact routes even though `Orchestrator.start()` already resolves any configured target to one immutable exact route.
- The hook's `SessionEnd` branch unlinked the exact session binding. A resumed prompt such as “继续” from a non-Git cwd therefore had no structural workspace evidence.
- A subsequent source-neutral adapter revision added an explicit-invocation marker argument to the packaged hook command. Existing sessions retained the earlier two-argument command but resolved the newly installed script, which validated the missing third argument before its error-containment block and exited 1 on every resumed prompt.
- The Chirp controller thread retained `/home/lucius` as its session cwd while its actual tool calls used `file:///home/lucius/.emacs.d/straight/repos/chirp`. After the exit-code repair, the pre-model hook therefore had no workspace evidence and correctly but invisibly skipped orchestration even though the requested UI fixes were delegatable. A fixed manual binding restored that one live thread but would not follow a later project switch.
- The long-running Codex app-server also retained an old versioned plugin root. Reinstallation left that root as a broken symlink to a removed intermediate cache, so current and resumed sessions both failed before Node started. Repointing the retained root to the verified installed cache restored exit-zero execution without killing the multi-session server; a full app-server restart remains the normal clean pickup boundary.

## Decisions

- Reuse route pools rather than add role registries, capability classes, nested pools, or a second balancing algorithm.
- Planner targets accept any exact route or pool. Quality-review targets accept any exact route or pool only when every candidate has `maxAttempts: 1`.
- Dogfood uses `advanced-workers`, `routine-workers`, and `review-workers`. Their current membership is evidence/configuration only and may mix or replace worker runtimes, providers, and models without code changes. Task policy selects logical targets; the admitted Job snapshots one complete exact route and never switches on retry.
- Keep a session binding after normal `SessionEnd`. The file remains source/session-keyed and mode/size checked, storing only the workspace plus a hash of its canonical Git common-directory path/device/inode identity. Both are revalidated before reuse, so replacing a repository at the same path invalidates the binding. A valid cwd or one unambiguous explicit path overwrites it; invalid bindings are deleted. There is still no home scan or transcript parsing.
- Treat the adapter-provided marker as required for new hook commands, but accept omission through the two bounded invocation markers used by the previous packaged adapters. This compatibility is independent of the source namespace and contains no controller-specific workspace, endpoint, orchestration, worker, or model branch.
- Add a source-neutral `PostToolUse` observation path. Exactly one Git root from bounded structured `tool_input.cwd`, `workdir`, or `workspace` values becomes the latest session focus and may overwrite the previous repository; ambiguous values do nothing. Commands, outputs, and transcripts remain opaque. This makes repository switching explicit lifecycle evidence rather than a permanent first-binding guess.

## Alternatives considered

- Add special planner/reviewer adapters. Rejected because roles are prompts and policy above the existing WorkerAdapter boundary.
- Hardcode round-robin between Pi and OpenCode. Rejected because the downstream set is configurable and the existing least-active pool already persists selection evidence.
- Route synthetic work merely to consume the second credential. Rejected because balancing must serve task quality, not dashboard utilization.
- Delete bindings on every exit and require `cd` before resume. Rejected because resume is a normal controller lifecycle and the same session ID is sufficient bounded identity.
- Store controller sessions in the shared server. Deferred because controller-local path binding does not need a new authenticated public API.

## Consequences

Backend participation now depends on configured candidate membership and actual admitted work rather than a role-specific Pi shortcut. Pool selection is process-local least-active balancing, not model ranking, health scoring, quota awareness, or fallback. A failed selected route remains failed. Session-binding files can outlive a controller process; they contain one absolute repository path plus a non-secret repository-identity hash, are unusable without the same source/session identifier, and every reuse revalidates both.

## Corrective actions and gates

- [x] Maintainers — accept pools for planner and reviewer targets — config validation tests.
- [x] Maintainers — persist exact planner/reviewer pool selection in their Job records — orchestration test.
- [x] Maintainers — configure multiple worker runtimes for dogfood planning, routine work, advanced work, and review — controller integration test.
- [x] Controller adapters — retain and revalidate the same binding across `SessionEnd`/resume, rejecting a replaced repository at the same path — parity tests.
- [x] Controller adapters — execute a retained two-argument hook command against the upgraded script without exit 1 or recursive explicit invocation — Codex/Claude resume regression tests.
- [x] Controller adapters — move one source-neutral session from repository A to B using only structured tool working-directory evidence and prove the next orchestration targets B — deterministic regression test.
- [ ] Maintainers — run one real useful orchestration and prove the native OpenCode credential receives non-synthetic role or child traffic.
- [x] Maintainers — run the complete isolated suite and record the final count before merge — final 243/243 passed after the dynamic workspace-focus follow-up.

## Privacy and security review

Session records contain only source, one absolute repository path, and a non-secret hash of the repository identity under a hashed source/session filename. They contain no prompt, transcript, credential, route, Job ID, provider response, source content, or artifact. Usage evidence here reports only route names, timestamps, and one redacted Job prefix.

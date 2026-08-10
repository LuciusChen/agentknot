# 0043: Close the native OpenCode lifecycle gate and bound Git metadata

- Type: Decision / Experiment
- Status: Accepted
- Implementation: Evidence gate closed; no runtime shim added
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Related: [decision 0028](./0028-native-opencode-adapter-evidence-gate.md), [decision 0041](./0041-native-opencode-worker-portability.md), [decision 0042](./0042-complete-route-pool-balancing.md), [ROADMAP](../docs/ROADMAP.md)

## Context

The native OpenCode JSON adapter had deterministic lifecycle coverage, real Luna/max successes, and one real heterogeneous pool success, but promotion still required repeated real failure, cancellation, timeout, cleanup, and adapter-owned artifact evidence. The soak also needed to distinguish a clean Git working tree from writes to Git's common metadata directory.

## Evidence

One isolated runtime matrix invoked the pinned OpenCode `v1.18.15` executable with SHA-256 `c1971d3d4d42abe8e15b2e320ecc1acbdb8377914d4e2cfa47c9bce2316caa7d`. Every case used exact route `opencode-luna`: worker `opencode`, provider `opencode-go`, model `gpt-5.6-luna`, `thinkingLevel=max`, and `maxAttempts=1`.

| Case | Job | Observed PID | Terminal evidence |
| --- | --- | ---: | --- |
| nonzero 1 | `job_28cef98c-5c57-4d20-8129-3dd0796afaaf` | 2752215 | failed on the OpenCode error/nonzero path |
| nonzero 2 | `job_036eb2fe-d3c7-410d-9925-f102c04a1d18` | 2752285 | failed on the OpenCode error/nonzero path |
| cancellation 1 | `job_36d45d96-c3e5-4a48-b9e5-82e1cad89e19` | 2752349 | cancelled after observing the exact native child |
| cancellation 2 | `job_60ebfee9-d3a2-4c9c-8e5d-12aae91fb6c9` | 2752398 | cancelled after observing the exact native child |
| timeout 1 | `job_4f2c328b-a8f8-4f7d-9894-5b0aa724fd65` | 2752446 | failed on the 1,500 ms core timeout |
| timeout 2 | `job_81717adb-1813-4ade-88c4-f1ce1daafab6` | 2752573 | failed on the 1,500 ms core timeout |

The authoritative isolated report is `/tmp/agentknot-stage2-native-soak-9mIQhE/report.json`; a later `consolidated-report.json` mixed a supplemental nonzero run from another root and is explicitly not evidence. Upstream independently rechecked the authoritative report, persisted Job snapshots, exact route/argv evidence, artifact bytes, repositories, worktree registries, and process table. All six PIDs returned `ESRCH`; all six Jobs stayed on attempt one without pool selection, retry, fallback, or model substitution. Each produced a checksum-valid empty patch with `changedFiles: []`; every source retained its base HEAD and empty porcelain status, and every managed-worktree root and registration list was empty after settlement.

A separate real success used the shared execution owner and exact native route. `job_02299bdd-7e68-40e5-bb49-cd73c9f77851` appended one requested line in an isolated fixture and succeeded on attempt one. AgentKnot captured a 209-byte patch changing only `README.md`, SHA-256 `ad661ec788213690c96445e098755b8daeabb4d9a6c2f9478632cc50608d144d`; independent verification found exact size/hash/base equality and the source remained unchanged. OpenCode reported 61,947 provider tokens, cost `0.00293381`, and a valid route-neutral completion report. The patch was reviewed but not applied.

The first final full-suite run passed 233 of 234 because the deterministic timeout fixture's 30 ms deadline fired before its fake Node child could write the PID file under concurrent test load. Product timeout behavior had already settled correctly; the assertion then waited for a PID that had never been published. The fixture deadline was raised to 500 ms without changing runtime code or the asserted timeout/cleanup semantics, and the focused test plus final full suite passed.

## Git common-directory observation

OpenCode created a mode-0644, 40-byte `.git/opencode` file containing its project ID in four cases that progressed far enough to initialize the project; the two promptly cancelled cases ended before that write. This file is outside Git status and patch evidence but is still repository metadata. The same file already existed in the AgentKnot source repository before this slice and was not changed here.

This is upstream OpenCode behavior, not an AgentKnot plugin or artifact write. In the [pinned project source](https://github.com/anomalyco/opencode/blob/v1.18.15/packages/core/src/project.ts), `Project.resolve` reads `opencode` from the repository common directory and `Project.commit` writes the resolved ID there after project migration. The source labels this a temporary bridge; the [documented CLI environment variables](https://opencode.ai/docs/cli/#environment-variables) expose no switch that disables only this write.

## Decision

- Close the native OpenCode adapter's repeated real lifecycle/artifact promotion gate. `opencode-json` is a current supported adapter; Pi remains the reference/planner route, not a privileged core abstraction.
- Keep native settlement fidelity explicit: success is inferred from valid `step_finish`, clean exit, and no abort, rather than Pi's explicit settled event.
- Define the existing controller-owned source/artifact invariant as unchanged working-tree content, unchanged HEAD/base, valid captured patch, and no managed worktree/process residue. It does not claim byte-for-byte immutability of every file inside Git's common directory.
- Document `.git/opencode` as an OpenCode-owned first-use metadata side effect. Do not add an AgentKnot cleanup/interception shim: deleting or restoring a shared common-directory file could race another OpenCode process and corrupt user-owned runtime state.
- Do not claim token savings, model quality, provider capacity, health scoring, or fallback from this promotion. The repository may keep native OpenCode in a human-authored complete-route pool while Pi remains the exact planner/reference path.

## Consequences

Stage 2 remains open for its separate controller gates, including real Claude parity when a Claude subscription is available. The whole-worker replaceability gate is now closed without a new scheduler, capability schema, filesystem overlay, Git wrapper, or cleanup daemon.

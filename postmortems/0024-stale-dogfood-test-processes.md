# 0024: Contain stale dogfood test processes

- Type: Incident
- Status: Resolved
- Date: 2026-08-09
- Severity: Medium
- Owners: AgentKnot maintainers
- Affected versions/commits: historical dogfood runs before and at `658f9a6`
- Related: [ROADMAP Stage 1 crash/soak gate](../docs/ROADMAP.md), [Pi supervision incident 0009](./0009-pi-rpc-child-supervision.md)

## Summary

A host-process audit after the Luna/max record-budget review found four obsolete test invocations still running after their originating development/audit work had ended. Each chain had reached `dist/test/pi-rpc.test.js` and retained one `fake-pi-conformance.mjs` child. The oldest had run for about 5.5 hours; three others for about 1.5 hours. All exact obsolete process groups were terminated with `SIGTERM`, and a follow-up scan found no matching test or fake-Pi process.

## Impact and containment

The processes consumed local resources and violated the Stage 1 expectation that completed development checks leave no child-process residue. They did not own an active AgentKnot orchestration, storage lock, managed worktree, or source mutation. No production worker, callback, commit, push, merge, or deployment was involved.

The audit resolved exact PID/PPID/PGID/SID chains before cleanup. It sent `SIGTERM` only to process groups `789870`, `1192966`, `1197075`, `1198562`, and the nested namespace group `1198563`; no broad process-name kill was used. A subsequent host scan returned only the scanning command itself.

## Evidence

- One chain was `npm test → node --test → dist/test/pi-rpc.test.js → fake-pi-conformance.mjs` with elapsed time `05:29:53`.
- Three later chains used `npm test`, `npm test --runInBand`, or direct `node --test --test-concurrency=1`; elapsed times were `01:25:53`–`01:30:39`.
- All current Luna audit Jobs and orchestration `orchestration_52171ea3-ae0e-485d-96f7-654019a6da36` were already terminal succeeded before cleanup.
- The current repository suite completed 133/133 immediately before the host audit.
- A fresh 133/133 run after cleanup left only the two expected Codex Node processes; the stale condition did not reproduce in the ordinary current test path.

## Root cause status

The observation proves that old dogfood tool invocations outlived their useful work; it does not yet prove whether the originating tool session was interrupted, timed out, detached, or hit a historical Pi test cleanup defect. The current suite did not reproduce a hang. This incident therefore remains contained rather than resolved, and it does not weaken exact-child supervision claims for the supported Pi adapter without a direct reproduction.

## Corrective actions and gates

- [x] Resolve exact host process ancestry and clean only obsolete groups.
- [x] Verify no matching test/fake-Pi process remains after cleanup.
- [x] Add a bounded dogfood/soak runner or equivalent process-residue assertion that can attribute descendants to its own invocation.
- [x] Reproduce the interrupted-tool path before changing Pi supervision or claiming the incident resolved.
- [x] Include host process-residue evidence in the Stage 1 crash/soak exit audit.

## Privacy and security review

Recorded evidence contains only process IDs, command names, elapsed times, public test paths, and one orchestration ID. It contains no credentials, environment values, prompts, model output, source content, or artifact bytes.

## Addenda

### 2026-08-09: interrupted-tool reproduction and resolution

The first execution of the new signal/restart/worktree soak inside the development sandbox returned after its CLI signal fixture failed at the host-`flock` boundary, but its test-runner chain remained visible on the host. The exact ancestry was `1701361` (`node --test`) → `1701626` (`dist/test/pi-rpc.test.js`) → `1701777` (`fake-pi-conformance.mjs`), all in the sandbox invocation's process group. This directly reproduced the interrupted-tool residue shape without involving a live AgentKnot orchestration or provider request. The three exact PIDs were terminated leaf-first with `SIGTERM`; a host recheck found none. One unrelated old, clean detached worktree was separately identified by exact path, removed through `git worktree remove --force`, and the repository worktree list then contained only the source workspace.

`scripts/stage1-soak.mjs` now starts its test matrix in a new uniquely attributable POSIX process group, enforces a 60-second bound, forwards catchable `SIGINT`/`SIGTERM`, escalates that exact group after two seconds, and treats any descendant remaining after the test runner exits as a failed soak before exact-group cleanup. The final host run passed 47/47 and both the runner's group check and an independent host scan found no matching test or fake-Pi process. The full deterministic suite passed 144/144.

This resolves the Stage 1 development-runner invariant and requires no broad cleanup or Pi protocol change. It does not claim cleanup after hard `SIGKILL`, host loss, or failure outside the attributed group; those remain explicit operating-system boundaries.

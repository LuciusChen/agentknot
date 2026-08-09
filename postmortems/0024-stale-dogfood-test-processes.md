# 0024: Contain stale dogfood test processes

- Type: Incident
- Status: Contained
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
- [ ] Add a bounded dogfood/soak runner or equivalent process-residue assertion that can attribute descendants to its own invocation.
- [ ] Reproduce the interrupted-tool path before changing Pi supervision or claiming the incident resolved.
- [ ] Include host process-residue evidence in the Stage 1 crash/soak exit audit.

## Privacy and security review

Recorded evidence contains only process IDs, command names, elapsed times, public test paths, and one orchestration ID. It contains no credentials, environment values, prompts, model output, source content, or artifact bytes.

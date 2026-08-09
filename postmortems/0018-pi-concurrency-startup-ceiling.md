# 0018: Restore four slots after Pi startup failures

- Type: Incident
- Status: Resolved
- Date: 2026-08-09
- Severity: Local dogfood capacity regression
- Owners: Upstream controller
- Affected versions/commits: `9502a0e`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decision 0007](./0007-non-overlapping-task-pools.md)

## Summary

The repository dogfood configuration was raised from four to six active slots because six is the accepted configuration ceiling. A real six-process normal-job batch then failed in full within about 0.5 seconds, with every Pi RPC child exiting code 0 before `agent_settled`. A five-process Luna-only probe failed identically. A subsequent single Luna normal job succeeded, and prior four-worker dogfood runs had already succeeded, so the repository restored the measured four-slot limit.

The source workspace stayed clean. Every failed Job reached a terminal failed state and captured an empty, checksum-valid patch artifact. No fallback or model substitution occurred.

## Violated assumption

Configuration validity was treated as operational capacity evidence. The parser's maximum of six only bounds accepted policy; it does not prove that a specific worker/provider/model environment can start six normal jobs concurrently.

## Evidence

- Commit under test: `9502a0e59955fddfa46736065f3bc6913cdb63af`.
- Six-process cohort: three Luna/max and three DeepSeek Flash/max Jobs, all started at `2026-08-09T03:44:13.001Z`; all failed within 533 ms with `Pi RPC exited before agent_settled (code=0, signal=null)`.
- Five-process cohort: five Luna/max Jobs started at `2026-08-09T03:46:43.201Z`; all failed within 492 ms with the same error.
- Single-process control: Luna/max Job `job_e4609639-a16f-40ec-8bed-ca4930bce503` succeeded, produced a non-empty test-only artifact, and reported focused plus full tests passing.
- Earlier four-child Luna dogfood runs provide the current successful upper-bound evidence.

The probes used separate managed Git worktrees and a single process-local FileJobStore namespace. The failure occurred before model settlement and produced no retained session statistics, so this evidence identifies an operational startup boundary but does not prove whether the limiting component is Pi, provider admission, or another shared local resource.

## Corrective actions and gates

- [x] Restore repository `maxConcurrency` to four while retaining `maxChildren: 6` and sliding refill.
- [x] Keep product defaults at two and the configuration syntax ceiling at six.
- [x] Document that configuration ceilings are not route-capacity claims.
- [ ] Before raising dogfood concurrency again, require a normal-job soak at the proposed value through the exact Pi/provider/model/thinking route.
- [ ] Improve Pi pre-settlement diagnostics only as a bounded Stage 1 reliability slice; do not guess a retryable provider error from exit code 0.

## Privacy and security review

The record contains Job IDs, timestamps, route labels, aggregate outcomes, and a public repository commit only. It contains no prompts, credentials, provider responses, or model output. Temporary test state remained under `/tmp`; no third-party extension, including pi-intercom, was installed.

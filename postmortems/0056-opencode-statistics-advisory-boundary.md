# 0056: Keep OpenCode accounting evidence advisory

- Type: Incident / Boundary correction
- Status: Accepted
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Affected versions/commits: native `opencode-json` through `676ea36`
- Related: [0034](./0034-persisted-usage-observability-boundary.md), [0041](./0041-native-opencode-worker-portability.md), [0044](./0044-required-worker-completion-and-canonical-worktree-id.md), [SPEC](../docs/SPEC.md)

## Incident

A resumed Codex session for the Chirp repository correctly entered automatic delegation and admitted orchestration `orchestration_0a3e120d-f5d2-46d1-a800-c327feb13398`. Child `job_fb83ab14-1b46-4e2f-83f9-6521e5a2e874` selected the configured native OpenCode Go / `gpt-5.6-luna` / `max` route, ran for about 96 seconds, and emitted tool activity. AgentKnot then failed the attempt with `OpenCode step_finish contained invalid token statistics`.

The failure does not establish that the requested repository task completed: no valid completion envelope or artifact was retained. It does establish that automatic entry, workspace binding, admission, and route selection worked before the adapter converted an accounting-schema mismatch into a terminal worker failure.

## Root cause

The OpenCode adapter coupled two independent evidence classes in one `step_finish` handler:

- the presence of `step_finish` contributes inferred lifecycle settlement; and
- its provider-reported token and cost fields contribute optional usage accounting.

Pi already treated unavailable or invalid statistics as advisory. OpenCode instead threw while parsing accounting fields, despite the usage specification already defining missing and invalid records as partial coverage rather than task failure. This made provider schema drift more authoritative than the strict completion envelope.

## Correction

- A structurally present `step_finish` remains required lifecycle evidence.
- Clean exit, absence of an error/abort, and one valid terminal completion envelope remain mandatory.
- Missing, malformed, non-finite, or overflowing token, cost, aggregate, or tool-count evidence records `sessionStats.unavailableReason: "invalid"`.
- Valid provider statistics remain exact; AgentKnot does not reconstruct totals or guess changed schema fields.
- Malformed JSONL, explicit error events, missing `step_finish`, nonzero exit, and blocked/missing/malformed completion envelopes still fail.

This changes only observability authority. It does not add a fallback route, switch worker/provider/model, infer completion from intermediate progress, or weaken artifact verification.

## Verification gates

- [x] Deterministic OpenCode fixture covers valid completion with invalid provider statistics.
- [x] Existing missing-envelope, malformed JSONL, error, incomplete, nonzero, cancellation, timeout, and exact valid-statistics cases remain strict.
- [x] After rollout, bounded real Job `job_8509e1c2-88ca-4418-80ea-2c0bd53adea7` succeeded through native OpenCode Go / `gpt-5.6-luna` / `max` with one valid completion envelope, exact valid statistics, an integrity-valid empty artifact, and no source change.
- [ ] On the next naturally occurring provider accounting-schema mismatch, confirm the persisted terminal record reports partial usage coverage without changing an otherwise valid result; do not fabricate provider drift or spend another repository task solely to force this evidence.

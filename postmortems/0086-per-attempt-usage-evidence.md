# 0086: Persist fixed-shape downstream usage per worker attempt

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-13
- Owners: AgentKnot maintainers
- Related: [usage boundary 0034](./0034-persisted-usage-observability-boundary.md), [settled retry ownership 0084](./0084-worker-settled-retry-ownership.md), [completion recovery 0085](./0085-in-session-completion-envelope-recovery.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Incident

Usage aggregation read only a successful Job's terminal `result.metadata.sessionStats`. When a pre-settlement failure retried the whole worker, earlier attempts could consume provider capacity but disappeared from the report. A failed Job with a settled provider error likewise retained no usage even when its live Pi session could still answer `get_session_stats`.

Incident 0085 made the gap concrete: a missing completion envelope caused one full repeated task, but only the final attempt's 43,901 reported tokens survived. The code could prove duplicated execution, yet could not measure its full downstream cost or compare it with same-session recovery.

## Rejected first implementation

The delegated patch correctly identified the attempt boundary but copied each complete session-stat object into `JobRecord.attemptUsage`, independently applying the 64 KiB metadata allowance to every attempt. Route `maxAttempts` is configuration rather than a small fixed constant, and the usage fold needs only five token fields plus cost. Repeating message counts, context usage, and arbitrary bounded objects would have enlarged durable records without improving the report.

The promoted design instead uses one fixed-shape projection. Successful terminal metadata remains unchanged for compatibility, but it is not duplicated in the usage total when attempt evidence exists.

## Decision

- Every completed worker attempt appends one `{ attempt, usage }` observation before artifact or terminal persistence.
- Available usage contains only non-negative safe-integer input, output, cache-read, cache-write, and provider-total tokens plus non-negative finite provider-reported cost.
- Unavailable usage is exactly one of `missing`, `timeout`, `unsupported`, `invalid`, or `worker-failure`. No missing value becomes zero.
- A returned result is observed before shared policy interpretation, so a valid `taskOutcome: blocked`, read-only violation discovered after return, or later artifact/terminal failure does not erase already reported consumption.
- `WorkerSettledError` may carry the fixed usage projection. Pi requests session statistics at most once after final settlement for success, assistant/provider error, or exhausted completion-envelope recovery.
- A process, protocol, timeout, or cancellation failure before queryable settlement records `worker-failure`; AgentKnot does not estimate tokens.
- Durable recovery records `worker-failure` for an expired-lease running attempt before it retries, honors a pending cancellation, or fails for exhausted attempts. Existing evidence for that attempt is never duplicated.
- `attemptUsage` is authoritative when present. The usage report validates distinct attempt numbers, folds every valid attempt once across succeeded and failed Jobs, and never also counts terminal metadata.
- A successful legacy Job without `attemptUsage` retains the previous terminal `result.metadata.sessionStats` fallback. Failed legacy Jobs gain no inferred evidence and no migration rewrite is required.
- Human coverage uses available versus observed attempts. Existing Job-level scope fields remain additive compatibility data.
- The contract is controller-, worker-, route-, provider-, and model-neutral. It adds no account-quota inference, pricing/currency normalization, fallback, or controller-token claim.

## Verification

- A two-attempt Pi fixture records `worker-failure` for the exited first child and exact token/cost evidence for the successful second child.
- A settled downstream error records exact available token/cost evidence without a fresh Job attempt.
- A second invalid completion-envelope settlement records the adapter's explicit statistics timeout and remains non-retryable.
- A route-neutral result later failed by `taskOutcome: blocked` retains exact attempt usage.
- Retry, cancellation, and exhausted-recovery fixtures retain one unavailable observation for the exact lease-lost attempt, including recovery paths that do not enter the ordinary adapter `finally` block.
- The usage fold sums two available retry attempts, reports a third unavailable attempt, ignores deliberately inflated terminal metadata, and retains existing legacy/all-zero behavior.
- The final focused orchestrator, runtime-recovery, Pi RPC, and usage suites pass 74/74; the complete repository suite passes 311/311 and `git diff --check` passes.
- Real Luna/max Job `job_93090c54-85a7-4d82-ac7c-d02d13e5349b` succeeded on attempt one with zero tools and an empty verified artifact. Its fixed attempt observation retained 4,013 provider-reported tokens and cost 0.000682525, while the compatibility metadata retained the same terminal statistic; the usage fold counted the attempt once.

## Consequences

Future reports can measure known whole-worker retry consumption when the adapter can obtain it, and can distinguish unmeasured failures from zero usage. This closes the evidence loss identified in 0085 but does not retroactively recover old attempts, establish controller/downstream proportions, prove billing savings, or make account-wide quota observable. A future Worker adapter may supply the same normalized evidence without adopting Pi's session-stat protocol.

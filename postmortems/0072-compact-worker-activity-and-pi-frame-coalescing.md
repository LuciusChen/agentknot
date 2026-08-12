# 0072: Preserve useful worker activity under Pi text-frame floods

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-12
- Owners: AgentKnot maintainers
- Affected versions: pre-release work after `1571002`
- Related: [decision 0023](./0023-fixed-durable-record-budgets.md), [decision 0052](./0052-bounded-analysis-and-observable-waiting.md), [decision 0062](./0062-durable-event-subscription.md), [decision 0071](./0071-defer-pi-durable-harness-migration.md), [ROADMAP](../docs/ROADMAP.md), [SPEC](../docs/SPEC.md)

## Summary

A real bounded DeepSeek V4 Flash/max audit (`job_243695c5-908a-404f-8fe9-a1e235c4346f`) emitted enough one-character Pi text frames to consume the fixed 512-worker-event retention budget, emit `job.worker.events.truncated`, and hide later tool activity from controllers even though execution continued. The wait surface also exposed only a generic last event, leaving users unable to distinguish tool progress, quiet computation, and broker-client disconnection without opening a full record.

AgentKnot now coalesces consecutive Pi text deltas at the adapter boundary without changing final output, derives one compact route-neutral activity projection from already durable Job events, and exposes it through existing cursor heartbeats. The projection is evidence about the most recently committed observation, never a provider/process health inference. No new Job field, durable event type, connection authority, worker session, or planning behavior was added.

## Impact and terminal state

- Severity: medium observability and evidence-retention defect.
- User/controller impact: live waits were opaque, and a noisy worker transport could evict later normalized tool events from retained evidence.
- Execution impact: the observed Jobs still settled; truncation did not by itself prove incomplete work or provider loss.
- Immediate containment: split the broad audit into an exact activity seam and inspect the failed Job's tool/event history instead of accepting an empty verified patch as completion evidence.
- Terminal state: resolved. Deterministic tests pass, and a post-change real audit retained 42 events from 6,311 raw frames, including 10 tool starts, 9 updates, 10 completions, 8 coalesced text deltas, the artifact and terminal event, with no truncation and a reported completion envelope.

## Root cause

Pi RPC emits text at transport-frame granularity. AgentKnot previously persisted every normalized text delta individually, so the durable event budget reflected provider chunking rather than meaningful controller observations. The compact wait projection then reported only the last event type and timestamp; it did not reconstruct active tools or make evidence coverage explicit.

The fixed event cap was working as designed. Increasing it would only postpone the same failure, enlarge records, and preserve transport noise. Inferring provider loss from elapsed silence would create a different false claim because quiet model work, a long tool, a disconnected client, and an unavailable broker are separate states.

## Decision

1. Pi RPC buffers only consecutive text deltas and flushes a bounded aggregate before any non-text event and at stream end. Exact `WorkerRunResult.output`, raw-frame counts, completion parsing, and non-text ordering remain unchanged.
2. `projectJobActivity(JobRecord)` derives a bounded additive projection from existing durable events. It reports lifecycle state, evidence coverage, the last observation, and at most four sanitized active tool names. It never copies prompts, paths, call IDs, text, stderr, raw frames, tool arguments, or results.
3. `complete`, `partial`, and `truncated` describe evidence coverage. Partial or truncated streams clear active-tool claims; they do not guess what is still running.
4. Client connectivity is reported separately. Observation age means only time since the most recent committed event and is never labelled provider or process loss.
5. When a tool event's data exceeds the record budget, the retained limit marker keeps only bounded tool identity and error status needed for lifecycle projection; private arguments/results remain removed.
6. Cursor follow remains the sole remote wait contract. The activity view adds no second queue, session, polling authority, or controller-specific transport.

## Alternatives considered

- **Increase the 512-event cap:** rejected because transport fragmentation would still determine retention and record size would grow.
- **Persist every raw frame but compact only HTTP output:** rejected because later durable evidence would already have been lost.
- **Add activity fields to `JobRecord`:** rejected because the event log already contains the necessary evidence and a second mutable projection would add consistency work.
- **Expose tool arguments/results for richer progress:** rejected because compact heartbeats should not repeat large or sensitive worker payloads.
- **Treat a quiet age as worker loss:** rejected because no heartbeat or process-health contract supports that conclusion.
- **Wait for Pi's proposed durable harness:** rejected for this correction because its execution surface is not implemented; the adapter boundary already supports exact normalization.

## Verification

- Unit projection tests cover capacity/start/terminal state, concurrent tools, name/count bounds, completion, retry, partial evidence, truncation, and omission of private payloads.
- Pi adapter tests emit thousands of one-character frames, assert a bounded text-event count, and reconstruct the exact original output.
- Record-limit tests prove oversized tool events retain lifecycle identity but omit arguments/results.
- HTTP and CLI tests prove compact activity is route-neutral, bounded, privacy-safe, and rendered separately from connectivity.
- One real post-change AgentKnot audit, `job_4818883a-202a-4a01-b69c-6d7c752fc24a`, used Pi/OpenCode Go/DeepSeek V4 Flash/max and completed with 6,311 raw frames, 42 retained events, no truncation, and a strict completion report.

## Consequences and follow-up

- Other worker adapters remain responsible for normalizing their private transport into useful event granularity; core contains no Pi frame rule.
- The activity projection is observational and non-authoritative. Terminal Job state and completion evidence remain authoritative.
- Route-neutral live `steer`/`follow-up` is a separate capability and must use explicit adapter capability plus request/receipt semantics. It must not be smuggled into the activity projection or silently replayed across a lost attempt.
- Future Pi harness adoption must pass the same ordering, privacy, truncation, and completion gates before replacing RPC.

# 0087: Pace pre-settlement worker retries without changing ownership

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-15
- Owners: AgentKnot maintainers
- Related: [worker retry ownership 0084](./0084-worker-settled-retry-ownership.md), [usage evidence 0086](./0086-per-attempt-usage-evidence.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Incident

Several ordinary Pi/OpenCode Go Jobs failed every configured attempt with `Pi RPC exited before agent_settled (code=0, signal=null)`. One five-attempt Job consumed its complete attempt budget in about 2.3 seconds because the orchestrator restarted each lost worker immediately. The same period included a successful live route probe and a successful bounded inference against the configured provider, so the available evidence did not establish exhausted account quota or permanent route failure. It established a pre-settlement worker/transport failure and an overly aggressive whole-Job retry cadence.

The existing retry-ownership boundary remained correct. Pi already retries downstream calls while retaining its live context; once that session emits `agent_settled` with an error, a fresh Job attempt risks repeating completed inspection and edits. Only failures before that settlement boundary are eligible for AgentKnot whole-worker retry.

## Decision

- Add route-neutral `WorkerTransientError` for adapter-observed failure before the first settled worker-session boundary. Pi uses it when its exact child exits before `agent_settled`.
- Preserve configured attempt count, exact admitted route, durable next-attempt reservation, workspace isolation, and Job status semantics.
- Before the reserved next attempt starts, persist the existing `job.retrying` event with `reason: pre-settlement-worker-failure` and the effective delay.
- Use exponential delay starting at one second, deterministic per-Job/per-attempt jitter of plus or minus 20 percent, a 30-second exponential cap, and a 60-second absolute delay cap.
- Permit an adapter to attach a structured non-negative millisecond retry hint. The orchestrator treats it as a minimum delay up to the absolute cap and records both requested and effective values.
- Make the wait abort-aware. Cancellation settles through the existing cancellation path and starts no additional worker attempt.
- Keep `WorkerSettledError` terminal. Core does not parse provider/model/rate-limit/authentication/quota strings or HTTP headers, infer account capacity, switch routes, add fallback, or resubmit a new Job.
- Leave generic custom-adapter retry behavior compatible. Adapters opt into paced retry only when they can identify the pre-settlement transient boundary.

## Verification

- The Pi exit-before-settlement fixture now returns `WorkerTransientError`, records a one-second-class jittered delay, starts exactly one later PID, and succeeds on the same exact route at attempt two.
- A route-neutral adapter fixture supplies a 1.5-second structured hint; the persisted event records that hint and the second invocation begins only after the delay.
- A 120-second hint is capped at 60 seconds in durable evidence; cancellation interrupts the wait immediately and the adapter is invoked only once.
- The settled downstream exhaustion fixture still runs one PID, fails at attempt one with `WorkerSettledError`, and emits no `job.retrying` event.
- Build and the focused Pi/orchestrator suites pass 68/68; the complete repository suite passes 351/351 and `git diff --check` passes.

## Consequences

Short transport/process disturbances no longer burn the complete configured attempt budget almost instantaneously, and controllers can inspect the intended wait from existing Job history. The delay does not repair an unavailable provider, prove the cause of a child exit, guarantee eventual success, or create exactly-once execution. A crash after `job.retrying` still follows the existing conservative reserved-attempt and recovery contract; this decision does not redesign recovery.

# 0084: Keep downstream retry inside the settled worker session

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-13
- Owners: AgentKnot maintainers
- Related: [decision 0001](./0001-vendor-neutral-control-plane.md), [decision 0009](./0009-pi-rpc-child-supervision.md), [activity decision 0072](./0072-compact-worker-activity-and-pi-frame-coalescing.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Incident

Three bounded Luna/max dogfood reviews encountered the same explicit temporary upstream `rate_limit_exceeded` error. Pi 0.84.1 already classified retryable downstream calls and retried them inside the live session with its default 2s/4s/8s policy. Many individual calls recovered. When one call finally exhausted that policy, Pi settled the session with the provider error.

AgentKnot then treated the settled error like an arbitrary adapter exception and immediately started a fresh isolated Job attempt. That discarded the worker context, repeated repository inspection, and again hit the same external condition. The first review ran for 13m35s and retained 111 normalized tool starts across two attempts. Reproductions `orchestration_52fc5ac8-b091-421f-9b96-c3f8c238fd79` / `job_3b0e8631-8a58-441b-a776-9a70ffa28c88` and `orchestration_8006f56e-3360-452f-9000-a0e56d53f354` / `job_a02074ed-23f9-4ac2-a139-b2fc1a345580` also replayed twice and produced no usable worker report. A point-in-time live probe succeeded between failures, so the evidence establishes intermittent route failure, not exhausted account quota or permanent unavailability.

The adapter also normalized Pi retry events to only attempt/delay/outcome. Compact progress therefore said `retrying` without distinguishing downstream backoff from broker reconnect or whole-worker replay.

## Decision

- When an adapter supports retry while its worker session retains the relevant context, that adapter owns the downstream retry policy.
- After that worker session settles failed, the adapter throws route-neutral `WorkerSettledError`. The orchestrator records the bounded error and terminates the Job without consuming another whole-worker attempt.
- Pre-settlement process exit, malformed RPC/protocol, transport loss, and ordinary custom-adapter exceptions retain configured AgentKnot attempt retry.
- Normalized retry events carry `scope: downstream`, attempt, optional maximum, delay, outcome, and a generic exhaustion reason. Compact activity may display progress such as `retrying:downstream:2/3`; it never copies the raw downstream error.
- Core does not parse Pi, provider, model, rate-limit, region, authentication, or quota strings. No automatic route/model switch is introduced. A later Job remains an explicit controller/human decision.

## Verification

- A deterministic Pi fixture emits downstream retry exhaustion and a settled assistant error under a route with two AgentKnot attempts. Exactly one child PID runs; the Job fails at attempt one with no `job.retrying` event and no private retry error in persisted events.
- The existing exit-before-settlement fixture still starts exactly two child PIDs and succeeds on attempt two.
- Activity projection validates downstream retry scope and `2/3` progress independently from connectivity.
- A post-restart live probe still returned the same temporary route error, confirming that the deterministic regression—not transient provider recovery—is the implementation evidence for the ownership fix.
- Focused Pi, orchestrator, activity, CLI, and HTTP tests pass before the full release suite.

## Consequences

A temporary downstream failure can still fail a Job; AgentKnot cannot manufacture capacity or infer when it will recover. The change prevents immediate wasteful replay and makes the failure domain visible. Explicit later resubmission can use new durable identity after the operator/controller reviews any retained artifact evidence. Silent fallback remains prohibited.

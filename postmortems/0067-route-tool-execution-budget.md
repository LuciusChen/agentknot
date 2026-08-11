# 0067: Add an optional route tool-execution budget

- Type: Incident / Architecture Decision
- Status: Accepted
- Implementation: Delivered in this slice
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Related: [decision 0052](./0052-bounded-analysis-and-observable-waiting.md), [incident 0066](./0066-pi-duplicate-tool-start-events.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Context

Repository-analysis prompts already constrain semantic scope, but execution had only a per-attempt timeout. The 512-worker-event record budget limits retained evidence; it does not stop a worker from continuing to use tools after events are truncated. Persisted successful dogfood Jobs therefore prove the missing execution boundary rather than merely suggesting it: current exact routes reached 146 completed tool calls and 758.7 seconds on Luna, 43 calls on DeepSeek Flash, and 17 calls on quality review. Other successful Luna Jobs reached 131 calls and 955.1 seconds. These runs are not evidence that the work was wrong, but they show that a one-hour timeout was the only execution stop.

Pi also duplicated every start before incident 0066. Any execution budget had to wait until the adapter exposed one normalized start for one real tool execution; otherwise the middleware would enforce a protocol artifact rather than work.

## Decision

- Add optional positive-integer `maxToolCalls` to an exact route and its immutable `ResolvedRoute` snapshot.
- Count `worker.tool.started` independently in each worker attempt. When the next start exceeds the configured limit, abort the exact attempt, do not persist the excess event, and fail with `WorkerToolCallLimitError` without retry.
- Omission keeps existing timeout behavior. The field applies through the route-neutral event contract and contains no Pi, provider, model, controller, task-kind, or complexity branch.
- Keep semantic scope, task decomposition, and acceptance criteria upstream. This limit is an execution safety circuit, not a planner or model-quality judgment.
- Configure repository dogfood at Luna 160, DeepSeek Flash 64, and quality review 64. Each value is above the maximum successful completed-tool count observed for that current route, so the new configuration would not reject a known successful current-route Job.

## Consequences

A worker cannot explore indefinitely until the route timeout when a route opts into the budget. An over-budget attempt is explicit and cannot silently retry or switch routes. Custom workers remain replaceable, but adapters must normalize one `worker.tool.started` per real execution for the configured limit to be meaningful.

The budget does not guarantee latency, token savings, completion quality, or an exact provider-tool count. It does not make a 159-call task desirable, and it does not replace tighter controller-authored scope. Route owners may omit or change it as their worker protocols and evidence change.

## Verification

- A deterministic custom adapter emits three normalized tool starts on a route limited to two.
- The exact attempt signal is aborted on the third start, only two starts are persisted, the Job fails on attempt one, and `maxAttempts: 2` does not cause a retry.
- Configuration rejects zero, fractional, and greater-than-1000 values and snapshots a valid value.
- Persisted SQLite evidence was grouped by successful exact route before choosing dogfood values; no current-route observed maximum exceeds its configured limit.
- Pi normalization emits one start for the paired `toolcall_end` plus canonical `tool_execution_start` fixture before the budget is enabled in dogfood.

## Alternatives rejected

- **Use the 512-event retention budget as execution control:** truncation bounds storage but deliberately does not cancel work.
- **Hard-code limits by model or task complexity:** couples core to current downstreams and moves policy judgment into middleware.
- **Set Luna to 96 based only on recent audits:** would reject multiple known successful Luna Jobs, including 100–146-call runs, before comparable quality evidence justified that tradeoff.
- **Leave timeout as the only stop:** permits an already-out-of-scope worker to continue tools for the full hour.

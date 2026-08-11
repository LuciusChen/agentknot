# 0066: Remove duplicate Pi tool-start events

- Type: Incident
- Status: Resolved
- Implementation: Delivered in this slice
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Related: [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Context

Pi emits `message_update/toolcall_end` when the model has finished constructing a tool call and later emits `tool_execution_start` when that tool actually begins. The adapter mapped both frames to `worker.tool.started`.

Persisted production evidence made the duplication deterministic: the latest audit Jobs recorded 116 starts for 58 completions, 148 for 74, 174 for 87, 134 for 67, and 150 for 75. These were not additional tool invocations. They enlarged every record and made the fixed 512-worker-event limit arrive earlier, obscuring later progress.

## Decision

- Treat Pi `tool_execution_start` as the sole source of normalized `worker.tool.started`.
- Keep `tool_execution_update` and `tool_execution_end` mappings unchanged.
- Treat `message_update/toolcall_end` as assistant-stream protocol detail, not an execution lifecycle event.
- Do not add Pi-specific event names to core or infer missing starts from completed events.

## Consequences

Each current Pi tool execution produces one normalized start and one completion, plus any genuine updates. Durable records and live progress no longer double-count starts. The change is adapter-local and does not alter worker, provider, model, routing, completion-envelope, retry, or artifact semantics.

## Verification

- A fixture emits both `toolcall_end` and `tool_execution_start` for the same tool identity.
- The adapter emits exactly one `worker.tool.started` and one `worker.tool.completed`.
- Existing Pi lifecycle, raw-event accounting, completion, statistics, abort, timeout, and artifact tests remain green.

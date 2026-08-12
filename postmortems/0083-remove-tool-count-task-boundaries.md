# 0083: Remove fixed tool-count task boundaries

- Type: Incident / Architecture Decision
- Status: Accepted / Implemented
- Date: 2026-08-13
- Owners: AgentKnot maintainers
- Supersedes: [decision 0067](./0067-route-tool-execution-budget.md)
- Related: [context decision 0068](./0068-bounded-shared-task-context.md), [scope evidence 0069](./0069-repeated-shared-context-scope-trials.md), [experiment 0082](./0082-real-repository-selective-context-gate.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Incident

AgentKnot exposed `maxToolCalls` through controller-authored subtasks, direct Job requests, CLI, HTTP, MCP, route configuration, immutable route snapshots, worker prompts, and runtime enforcement. A controller could therefore turn a fixed count into normal task scope. The 2026-08-13 upstream A/B made the flaw concrete: one arm authored `maxToolCalls: 10` while the other used a configured value of 64, invalidating the end-to-end comparison.

A tool count does not describe the task boundary. The same count can represent necessary verification, repeated mistakes, a verbose adapter protocol, or scope expansion. Tying correctness to it also makes replaceable workers and evolving tool protocols behave differently under the same semantic task.

## Decision

- Remove `maxToolCalls` from `AssessedSubtask`, `JobRequest`, `RouteConfig`, `ResolvedRoute`, CLI, HTTP, MCP, child request construction, worker prompts, and runtime event handling.
- Reject new configuration, direct Job, HTTP, MCP, and assessment inputs that carry the retired field instead of silently ignoring it.
- Keep historical persisted records readable as evidence, but never apply their old count to new execution or recovery behavior.
- Define semantic scope only through the admitted context summary, relevant paths, constraints, task prompt, explicit non-goals, and acceptance criteria.
- Retain operational failure boundaries that do not estimate task complexity: per-attempt timeout, cancellation, retry policy, bounded events/results/records, workspace isolation, artifact limits, and required completion envelopes.
- Treat normalized tool events as observability evidence, not a budget counter or quality score.

No controller, worker, adapter, provider, model, route, or task-kind exception is introduced.

## Compatibility

This is an intentional pre-release input break. New callers receive an explicit migration error for the retired field. Historical Job and Orchestration snapshots may still display it because persisted evidence is not rewritten; runtime code no longer reads it. New route snapshots and requests cannot contain it.

## Verification

- Strict assessment validation rejects a legacy subtask field and generated prompts contain no tool-count instruction.
- TypeScript and HTTP Job admission reject legacy overrides before persistence; CLI no longer exposes the option; MCP schema is strict.
- Configuration rejects the retired route field and the dogfood configuration contains no fixed counts.
- A deterministic worker emits twelve normalized tool starts and completes successfully, proving event count alone cannot abort a task.
- Existing timeout, cancellation, event-size, output-size, isolation, artifact, completion-envelope, and retry tests remain the full release gate.
- A real Luna/max architecture audit completed using only context paths, constraints, non-goals, and acceptance criteria in Orchestration `orchestration_19d9fbe3-d934-4e3f-b27c-2512bb8ac46d`, Job `job_7708bb0d-ff6e-4609-b142-04931bfbdaf6`; its configured historical route count did not shape the task assessment.
- A post-removal Luna/max dogfood review admitted no count in either request or route and retained 111 normalized tool starts across two Job attempts without a count-based abort. Route-neutral `steer` was accepted and durably recorded when the review needed semantic convergence. Both attempts ultimately ended on the provider's explicit temporary `rate_limit_exceeded` error, so Orchestration `orchestration_ad55904f-0d2a-4540-b727-a363f7049282` and Job `job_54696ec9-c6ab-4cc7-8554-f4323b160103` are execution/control evidence only and provide no review or acceptance evidence; AgentKnot did not switch routes.

## Consequence for measurements

The fixed Skill-load micro pair in decision 0082 remains valid because both arms used the same single read and fixed reply. The delegated pair is invalid and supplies no comparative token or latency conclusion. Future end-to-end trials must use equivalent semantic contexts and acceptance criteria, omit execution-count fields, record actual paths/commands and completion evidence, and repeat enough pairs to separate model and cache variance from product effects.

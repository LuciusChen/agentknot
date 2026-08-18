# 0091: Long-wait safety pilot

- Type: Experiment / Architecture Decision
- Status: Accepted / Implemented
- Date: 2026-08-18
- Owners: AgentKnot maintainers
- Affected commit: `0af090ae44caa3f9d322c5eae6c62f70ff2e239b`
- Related: [bounded MCP wait 0075](./0075-bounded-mcp-wait-and-resume-gate.md), [summary-first pilot 0089](./0089-summary-first-handoff-real-controller-pilot.md), [wait-turn pilot 0090](./0090-controller-wait-turn-amplification-pilot.md)

## 1. Question

Can an explicit 180-second orchestration wait be cancelled while it is blocked, without changing durable cancellation or lifecycle behavior? Does the installed Codex client accept such a wait, and can the same be established for the installed Claude MCP client?

This experiment tests only wait lifecycle and client transport behavior. It does not test tokens, cost, latency improvement, coding correctness, a new default, or a production maximum change.

## 2. Current wait semantics

Production remains unchanged: `agentknot_orchestration_wait.waitMs` defaults to 40,000 ms and is capped at 40,000 ms. An active response carries `nextSequence`; a later call resumes the same durable Orchestration. Progress notifications are advisory, and cancellation is a separate durable control operation. Aborting an MCP wait stops observation but does not itself cancel admitted work.

The isolated service worktree changed only the schema maximum from 40,000 to 180,000 for this experiment. The default, durable follow loop, cursor, active and terminal result shapes, progress, Job and Orchestration lifecycle, and summary-first handoff were untouched. The temporary diff SHA-256 is `30c2ce15323a837c12929427bbed1b77c2af9b1fd3a26e5d258c296bf4b9adb4`.

## 3. Cancellation hypothesis

While an `agentknot_orchestration_wait` request is blocked with `waitMs=180000`, a concurrent durable cancellation should stop the Worker, persist terminal Job and Orchestration states, and wake the open wait. It should not retry or duplicate execution, and it should not require waiting for the requested wait deadline.

The experiment does not establish a universal propagation-time service-level objective. It distinguishes durable cancellation from aborting only the observing MCP request.

## 4. Client compatibility hypothesis

A client whose configured tool timeout exceeds 180 seconds should be able to keep one MCP request open across a 90-second synthetic execution, receive periodic progress, and receive the terminal handoff without an active cursor. Compatibility must be observed independently for each client; Codex success cannot be generalized to Claude.

## 5. Experimental setup

All final cases used AgentKnot base commit `0af090ae44caa3f9d322c5eae6c62f70ff2e239b` plus the isolated one-line schema diff. Node.js was `v26.7.0`; the repository declares `@modelcontextprotocol/server` `^2.0.0`. The target was clean commit `1189bfcdfdf4ba9898959e8ea6b94c6a5c4749a6`, tree `bf7155677197f27c4e2c6e2c80a1be55fdb7fb48`.

The synthetic Pi JSONL-compatible Worker changed no repository file. It emitted progress every 5 seconds, normally settled after 120 seconds for cancellation cases or 90 seconds for compatibility cases, and used one route with `maxAttempts=1`. The cancellation config SHA-256 was `85cf277da70a5a191b6a4e300e6d649cede41b490826129659e56181cf09c67e`; the compatibility config SHA-256 was `52f308db2887b464d14a6b968f934bf2d00b6b0bad1391cc99c25e14e03780c6`.

Cancellation used the experiment MCP client identity `agentknot-long-wait-pilot/1` over stdio to the normal AgentKnot MCP CLI and HTTP broker. The three cases used fresh instances of the same immutable request, config, target, and server runtime; a cancelled terminal Orchestration cannot itself be reused. Their only intentional differences were `waitMs` and cancellation timing. The two 180-second cases cancelled while the first wait was open. The 40-second control cancelled immediately after its first active response and then resumed by cursor to observe terminal state.

Compatibility used a gate so the 90-second Worker interval began only after the proxy observed the actual client's wait request. This avoids treating model startup time as MCP blocking time. Codex 0.147.0 used `gpt-5.6-sol`, low effort, stdio MCP, and an explicit existing test configuration of `tool_timeout_sec=240`. Claude Code 2.1.220 used its stdio MCP configuration without a custom timeout.

Three setup-only attempts were excluded before the final Codex run: an initial Worker harness rejected adapter-appended arguments, one Codex prompt used the wrong tool argument name, and one wait began after its ungated task had already settled. They were not final cases, and none of their durable records were reused. The final gated Codex run used the exact public argument names and a fresh Orchestration.

Experiment-only evidence tooling is `scripts/long-wait-safety-pilot.mjs` (SHA-256 `e2d4bc3d285812a3126ce5408942c74fcc7eaba4ac0ee5644cfe6d06ba10ebb6`) and the existing uncommitted MCP proxy (SHA-256 `7484edcc6cc7f4425041f9bd7de7aa18022661ded43992b11d16f8aaf12edfa5`). Neither is production runtime.

## 6. Cancellation results

All three final cancellation cases produced exactly one child, one `job.started` event, and one Worker start. No case retried. Durable evidence contained `orchestration.cancel.requested`, `job.cancelled`, and `orchestration.cancelled`; both final states were `cancelled`. The open 180-second waits returned terminal rather than waiting for their deadlines.

| Case | waitMs | cancelAt | cancel to wait response | cancel to Worker stop | cancel to durable Orchestration terminal | Final state |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Long wait A | 180,000 ms | 20,000 ms | 44 ms | 4 ms | 22 ms | Orchestration cancelled; Job cancelled |
| Long wait B | 180,000 ms | 60,000 ms | 56 ms | 4 ms | 34 ms | Orchestration cancelled; Job cancelled |
| 40-second control | 40,000 ms | 40,004 ms, after active | 34 ms | 4 ms | 21 ms | Orchestration cancelled; Job cancelled |

The durable cancel-request event appeared 2 ms after the local request timestamp in every case. The Job terminal event appeared after 21, 32, and 21 ms. Cancellation delivery responses took 4, 3, and 3 ms respectively. The two long waits received 5 and 13 progress notifications; the control received 9 across its active and terminal waits.

The largest observed cancellation-to-wait-return interval was 56 ms. This demonstrates prompt propagation in these three local cases, not a generally guaranteed upper bound. A separate MCP request abort was not required to cancel the durable work: the concurrent durable cancellation woke the wait. An abort signal remains necessary when a client wants to stop only its observation request without changing the admitted Orchestration.

## 7. Client probe results

The final Codex request was accepted at `2026-08-18T01:35:15.806Z`, remained blocked for 90.174 seconds, received 19 progress notifications totaling 2,746 transport bytes, and returned one terminal `succeeded` response. It had no active return, timeout, disconnect, reconnect, resubmission, or output-reader call. The proxy observed one transport session and one wait call. The terminal structured content was 2,236 UTF-8 bytes and the text JSON was 2,236 bytes; the complete MCP response logged by the proxy was 4,820 bytes.

Durable evidence independently records one child and one Job attempt, 17 periodic Worker updates, a valid empty patch artifact, `job.succeeded`, and `orchestration.succeeded`. The target checkout remained clean.

The Claude MCP server connected successfully, but the Claude model session failed authentication with HTTP 401 (`OAuth session expired and could not be refreshed`) before issuing any tool call. The proxy observed zero wait calls and zero progress notifications. Therefore long-wait acceptance, timeout behavior, terminal delivery, and in-wait cancellation for Claude are **unavailable**, not compatibility failures. No credential refresh or client-timeout workaround was attempted. Its gated synthetic fixture never began work and was durably cancelled only for cleanup; that cleanup is not a Claude cancellation result.

| Client | waitMs | Accepted | Progress | Terminal | Timeout | Cancel result |
| --- | ---: | --- | ---: | --- | --- | --- |
| Codex 0.147.0 | 180,000 ms | yes | 19 | succeeded after 90.174 s | no | not exercised through Codex; transport-level cancellation cases passed |
| Claude Code 2.1.220 | 180,000 ms | unavailable: no wait request | 0 | unavailable | unavailable | unavailable |

## 8. Evidence tables

### Cancellation identity and durable state

| Case | Orchestration | Progress bytes | Worker alive after terminal | Worker starts | Job starts | Retry or duplicate |
| --- | --- | ---: | --- | ---: | ---: | --- |
| Long wait A | `orchestration_7a646b6f-4da1-4c69-8832-a8fd54b6915a` | 859 | no | 1 | 1 | no |
| Long wait B | `orchestration_ec4b4769-fb02-4788-9f87-f0f09252756a` | 2,253 | no | 1 | 1 | no |
| 40-second control | `orchestration_2b7e4118-5e52-4f2a-b98f-4ee9f3b544f3` | 1,679 | no | 1 | 1 | no |

### Wait response sequence

| Case | Wait calls | Active returns | Terminal returns | First nextSequence | Final nextSequence |
| --- | ---: | ---: | ---: | ---: | ---: |
| Long wait A | 1 | 0 | 1 | 7 | 7 |
| Long wait B | 1 | 0 | 1 | 7 | 7 |
| 40-second control | 2 | 1 | 1 | 4 | 7 |
| Codex compatibility | 1 | 0 | 1 | 6 | 6 |

Resource cleanup was checked after terminal settlement: the recorded Worker PIDs were not alive, both managed-worktree directories were empty, the target checkout was clean, and the isolated broker was stopped. There was no broker restart during any final case.

## 9. What is proven

- In two local, durable cases, a concurrent cancellation interrupted a 180-second open wait after approximately 20 and 60 seconds and returned terminal promptly.
- The cancellation propagated to the Worker and durable Job and Orchestration state without retry or duplicate execution.
- Cancellation did not require aborting the observing MCP request; it woke that request through the existing durable state transition.
- Codex 0.147.0 with `tool_timeout_sec=240` can carry one 90.174-second AgentKnot MCP wait with progress to terminal success.
- The isolated maximum change is sufficient for this Codex probe; no new wait abstraction or lifecycle change was needed.

## 10. What is not proven

- Claude long-wait or cancellation compatibility is unavailable because authentication failed before a wait request.
- Cancellation under remote latency, provider stalls, broker restart, disconnect, reconnect, or multiple simultaneous callers was not tested.
- The observed 56 ms maximum is not a product SLA.
- A client-side abort was not exercised and is not equivalent to durable Orchestration cancellation.
- The experiment does not justify changing the 40-second production default or maximum.
- It does not show that long waits universally reduce tokens, cost, latency, or Controller work.
- It does not establish that every MCP client, Codex configuration, or Claude configuration supports 180 seconds.

## 11. Decision

**B. allow-explicit-long-wait.**

Retain the previous opt-in direction, scoped to clients with a known compatible tool timeout. The cancellation evidence removes the concern that an open long wait is inherently non-cancellable, and the Codex probe confirms compatibility for the tested configuration. Production remains unchanged because Claude compatibility is unavailable, client-side abort and reconnect were not exercised here, and one local cancellation fixture is not sufficient to change defaults.

## 12. Next phase

After restoring Claude authentication outside this experiment, repeat only the 90-second success and one in-wait cancellation probe without changing server or client timeouts. Separately review a minimal proposal that widens only the explicit `waitMs` maximum while retaining the 40-second default, active cursor, progress, cancellation, and durable semantics. The proposal should document a per-client timeout prerequisite and remain unpromoted until review; it should not add capability schemas, new tools, or workflow abstractions.

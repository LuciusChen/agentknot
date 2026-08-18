# 0090: Controller wait-turn amplification pilot

- Type: Experiment / Architecture Decision
- Status: Draft / Awaiting review
- Date: 2026-08-17
- Owners: AgentKnot maintainers
- Related: [durable event subscription 0062](./0062-durable-event-subscription.md), [bounded MCP wait 0075](./0075-bounded-mcp-wait-and-resume-gate.md), [summary-first pilot 0089](./0089-summary-first-handoff-real-controller-pilot.md), [SPEC](../docs/SPEC.md)

## 1. Question

Does the 40-second bound on `agentknot_orchestration_wait` create avoidable active-cursor returns and Controller model turns for a natural 90–160 second orchestration? Can one explicit, longer MCP wait cover the same durable execution without changing cancellation, progress, reconnect, cursor, lifecycle, or terminal-handoff semantics?

This experiment compares only bounded 40-second wait with an explicit 180-second wait. It does not test or introduce Controller-usage persistence, a result contract, memory, DAGs, a budget manager, a new output reader, another wait tool, or a different workflow.

## 2. Existing 40-second behavior

`orchestrationWaitSchema` currently gives `waitMs` both a 40,000 ms default and a 40,000 ms maximum. MCP composes the request cancellation signal and a wait deadline with `AbortSignal.any`. One call reads the current durable Orchestration, then `AgentKnotHttpClient.#waitForRecord` loops across successive HTTP event batches on the same ID and monotonic cursor. The HTTP server bounds each durable follow batch with a 5,000 ms heartbeat.

The loop survives a retryable transport failure by reconnecting to the same base URL, record ID, and completed-batch cursor up to three times with a one-second delay. It does not re-admit work or discover a replacement endpoint inside the same request. Deadline expiry returns `state=active` with the cursor from completed follow batches; a caller resumes that same Orchestration. Explicit MCP cancellation aborts the in-flight snapshot or follow but does not cancel the durable Orchestration.

Progress notifications are optional and require the client's MCP `progressToken`. The final pilot's Codex client supplied one. Notifications were visible to the transport proxy but their text did not appear in the persisted Codex session transcript. That is evidence about this client/version, not a general promise that progress never enters any Controller context.

Both bundled Controller Skills therefore instruct a Controller to reattach after each active result. Raising an explicit schema maximum is sufficient for a compatibility experiment; no durable wait, cursor, active response, terminal response, lifecycle, or tool-name change is necessary.

## 3. Historical rationale

The exact reason for choosing 40 seconds is **unknown**. Commit `17c5c670` introduced the same value as both default and maximum. Postmortem 0075 records only that Codex MCP tool calls were bounded and that correctness could not depend on progress. It does not document a measured client limit or a 40-second requirement.

The current [official Codex MCP configuration documentation](https://developers.openai.com/codex/mcp) says `tool_timeout_sec` defaults to 60 seconds and is configurable. Treating 40 seconds as a 20-second safety margin is therefore an inference, not recorded historical evidence. The repository pins `@modelcontextprotocol/server` 2.0.0, but neither that dependency nor the repository establishes a Codex hard timeout. The current Claude request timeout is also **unknown** from repository evidence.

Potentially affected callers are schema tests that expect values above 40,000 to fail, Controller Skills that omit `waitMs`, and clients whose transport deadline is below a requested long wait. A 120–180 second experiment need only widen the explicit schema maximum and adjust focused schema coverage. It does not require changing the 40-second default.

## 4. Per-turn analysis of postmortem 0089

Exact values below come from each saved Codex session's `event_msg.token_count.info.last_token_usage`; cumulative values come from `total_token_usage`. `Non-cached = input - cached input`. The timestamp is the usage event closing the model turn. A tool result is consumed by the following model invocation, so the row issuing the next tool is the row whose input includes the preceding result.

The previous pilot had an experimental-control defect for wait-turn analysis: its outer `functions.exec` yielded every 10 seconds in control and every 30 seconds in treatment. Those outer yields created extra `functions.wait` model turns. This does not invalidate 0089's serialized-handoff or correctness findings, but it prevents a causal token comparison of the AgentKnot wait strategy in that pair.

### 0089 control timeline

| Turn | UTC | Tool request | Tool response state | Input | Cached | Non-cached | Output | Reasoning | Cumulative input | Cumulative total |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 09:13:46.641 | Skill read | complete | 15,448 | 11,008 | 4,440 | 247 | 95 | 15,448 | 15,695 |
| 2 | 09:13:48.949 | Tool discovery | complete | 16,821 | 11,008 | 5,813 | 51 | 19 | 32,269 | 32,567 |
| 3 | 09:13:51.999 | Broker status | running | 19,020 | 16,128 | 2,892 | 101 | 47 | 51,289 | 51,688 |
| 4 | 09:13:54.478 | Delegation policy | available | 19,216 | 15,104 | 4,112 | 62 | 7 | 70,505 | 70,966 |
| 5 | 09:14:07.167 | Orchestration start | admitted | 19,438 | 18,176 | 1,262 | 608 | 64 | 89,943 | 91,012 |
| 6 | 09:14:23.316 | Wait 1, cursor 0 | outer yield: pending | 20,506 | 18,176 | 2,330 | 152 | 66 | 110,449 | 111,670 |
| 7 | 09:14:37.408 | Outer wait, cell 6 | pending | 20,686 | 19,200 | 1,486 | 91 | 58 | 131,135 | 132,447 |
| 8 | 09:14:50.597 | Outer wait, cell 6 | pending | 20,805 | 20,224 | 581 | 42 | 9 | 151,940 | 153,294 |
| 9 | 09:14:52.828 | Outer wait, cell 6 | active, cursor 4 | 20,875 | 20,224 | 651 | 39 | 6 | 172,815 | 174,208 |
| 10 | 09:15:08.212 | Wait 2, cursor 4 | outer yield: pending | 21,219 | 20,224 | 995 | 159 | 21 | 194,034 | 195,586 |
| 11 | 09:15:21.158 | Outer wait, cell 7 | pending | 21,406 | 20,224 | 1,182 | 40 | 7 | 215,440 | 217,032 |
| 12 | 09:15:34.153 | Outer wait, cell 7 | pending | 21,474 | 21,248 | 226 | 31 | 0 | 236,914 | 238,537 |
| 13 | 09:15:37.219 | Outer wait, cell 7 | active, cursor 8 | 21,533 | 21,248 | 285 | 31 | 0 | 258,447 | 260,101 |
| 14 | 09:15:52.155 | Wait 3, cursor 8 | outer yield: pending | 21,867 | 21,248 | 619 | 115 | 22 | 280,314 | 282,083 |
| 15 | 09:16:05.278 | Outer wait, cell 8 | pending | 22,010 | 21,248 | 762 | 31 | 0 | 302,324 | 304,124 |
| 16 | 09:16:18.582 | Outer wait, cell 8 | pending | 22,069 | 20,224 | 1,845 | 31 | 0 | 324,393 | 326,224 |
| 17 | 09:16:21.161 | Outer wait, cell 8 | active, cursor 8 | 22,128 | 21,248 | 880 | 31 | 0 | 346,521 | 348,383 |
| 18 | 09:16:37.255 | Wait 4, cursor 8 | outer yield: pending | 22,462 | 21,248 | 1,214 | 156 | 16 | 368,983 | 371,001 |
| 19 | 09:16:39.222 | Outer wait, cell 9 | terminal | 22,646 | 22,272 | 374 | 31 | 0 | 391,629 | 393,678 |
| 20 | 09:16:45.240 | Artifact preview | valid | 24,133 | 22,272 | 1,861 | 260 | 88 | 415,762 | 418,071 |
| 21 | 09:17:03.786 | Artifact apply | applied | 25,567 | 23,296 | 2,271 | 969 | 440 | 441,329 | 444,607 |
| 22 | 09:17:07.794 | Final validation | passed | 26,560 | 25,344 | 1,216 | 98 | 14 | 467,889 | 471,265 |
| 23 | 09:17:12.570 | Final response | accepted | 26,840 | 26,368 | 472 | 171 | 105 | 494,729 | 498,276 |

### 0089 treatment timeline

| Turn | UTC | Tool request | Tool response state | Input | Cached | Non-cached | Output | Reasoning | Cumulative input | Cumulative total |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 09:01:39.434 | Skill read | complete | 15,462 | 11,008 | 4,454 | 318 | 150 | 15,462 | 15,780 |
| 2 | 09:01:43.426 | Tool discovery | complete | 17,119 | 15,104 | 2,015 | 130 | 94 | 32,581 | 33,029 |
| 3 | 09:01:48.228 | Plan bookkeeping | complete | 19,578 | 16,128 | 3,450 | 153 | 15 | 52,159 | 52,760 |
| 4 | 09:01:51.314 | Broker status | running | 19,755 | 19,200 | 555 | 79 | 22 | 71,914 | 72,594 |
| 5 | 09:01:54.838 | Delegation policy | available | 19,937 | 19,200 | 737 | 66 | 8 | 91,851 | 92,597 |
| 6 | 09:02:08.549 | Orchestration start | admitted | 20,163 | 19,200 | 963 | 633 | 83 | 112,014 | 113,393 |
| 7 | 09:02:26.726 | Wait 1, cursor 0 | outer yield: pending | 21,046 | 19,200 | 1,846 | 223 | 124 | 133,060 | 134,662 |
| 8 | 09:02:55.736 | Outer wait, cell 7 | active, cursor 4 | 21,297 | 20,224 | 1,073 | 67 | 34 | 154,357 | 156,026 |
| 9 | 09:03:10.986 | Wait 2, cursor 4 | outer yield: pending | 21,671 | 20,224 | 1,447 | 161 | 18 | 176,028 | 177,858 |
| 10 | 09:03:39.997 | Outer wait, cell 8 | active, cursor 8 | 21,860 | 21,248 | 612 | 43 | 10 | 197,888 | 199,761 |
| 11 | 09:03:54.831 | Wait 3, cursor 8 | outer yield: pending | 22,208 | 11,008 | 11,200 | 113 | 14 | 220,096 | 222,082 |
| 12 | 09:04:23.840 | Outer wait, cell 9 | active, cursor 8 | 22,349 | 21,248 | 1,101 | 39 | 6 | 242,445 | 244,470 |
| 13 | 09:04:37.109 | Wait 4, cursor 8 | terminal | 22,693 | 21,248 | 1,445 | 190 | 40 | 265,138 | 267,353 |
| 14 | 09:04:47.571 | Artifact preview | valid | 24,186 | 21,248 | 2,938 | 419 | 109 | 289,324 | 291,958 |
| 15 | 09:05:13.123 | Artifact apply | applied | 25,781 | 22,272 | 3,509 | 1,348 | 793 | 315,105 | 319,087 |
| 16 | 09:05:17.221 | Final validation | passed | 27,153 | 25,344 | 1,809 | 123 | 32 | 342,258 | 346,363 |
| 17 | 09:05:23.067 | Git status | clean scope | 27,458 | 23,296 | 4,162 | 232 | 164 | 369,716 | 374,053 |
| 18 | 09:05:27.682 | Plan bookkeeping | complete | 27,719 | 26,368 | 1,351 | 177 | 9 | 397,435 | 401,949 |
| 19 | 09:05:31.993 | Final response | accepted | 27,920 | 27,392 | 528 | 145 | 79 | 425,355 | 430,014 |

Every active result was followed by a new Controller model turn. The next AgentKnot-wait turns after active responses added 21,219 / 20,224 / 995, 21,867 / 21,248 / 619, and 22,462 / 21,248 / 1,214 input / cached / non-cached tokens in control; treatment added 21,671 / 20,224 / 1,447, 22,208 / 11,008 / 11,200, and 22,693 / 21,248 / 1,445.

Across the four AgentKnot wait-invocation turns, control used 86,054 input (80,896 cached, 5,158 non-cached), 17.394% of its Controller input. Treatment used 87,618 (71,680 cached, 15,938 non-cached), 20.599%. Including outer polling turns raises the observed wait interval to 301,686 versus 153,124 input, but the asymmetric 10/30-second outer yields make that comparison invalid.

The model turn that consumed the terminal handoff and requested artifact preview used 24,133 input (22,272 cached, 1,861 non-cached) in control and 24,186 (21,248 cached, 2,938 non-cached) in treatment. Treatment's extra post-terminal Git-status and plan turns used 55,177 input (49,664 cached, 5,513 non-cached). Exact events separate wait, handoff-consumption, and bookkeeping turns, but cannot allocate portions within a model input to one field or prove causation from adjacent content alone.

## 5. Hypothesis

For a naturally 90–160 second bounded orchestration, if the MCP client supports a longer request, an explicit wait long enough to cover most execution should reduce active returns and Controller model turns while preserving the same durable cursor, progress, cancellation, reconnect, and terminal-handoff semantics.

The experiment does not hypothesize that total tokens or latency always decrease, that every client supports long waits, that progress never affects context, or that 180 seconds should become the default.

## 6. Compatibility probe

Both experimental AgentKnot worktrees were detached at `0af090ae44caa3f9d322c5eae6c62f70ff2e239b` and carried the same one-line, uncommitted experimental diff: change only `orchestrationWaitSchema.waitMs.max` from 40,000 to 180,000 while leaving its default at 40,000. The diff SHA-256 was `30c2ce15323a837c12929427bbed1b77c2af9b1fd3a26e5d258c296bf4b9adb4`. Both experimental builds passed, and focused public MCP tests passed 3/3.

Codex 0.147.0 was configured symmetrically with `tool_timeout_sec=240`. The treatment request remained open for 153.303 seconds, received 31 progress notifications, and returned the exact terminal shape. There was no MCP timeout, Controller auto-cancel, tool error, reconnect, or resubmission. Thus this Codex/configuration combination is compatible with one explicit 180-second wait.

One setup-only run was excluded before the final pair because brokers bound to nonstandard loopback addresses were not discovered as intended. It used separate homes, stores, ports, and target worktrees and was stopped rather than repaired in-session. It is neither an arm nor a long-wait compatibility failure. No excluded durable records were reused.

## 7. Experimental controls

The final pair used:

- AgentKnot base commit `0af090ae44caa3f9d322c5eae6c62f70ff2e239b`, tree `4d62ca88d42ad049e3e765ea97ee98928c330893`, plus the identical experimental diff above;
- target commit `1189bfcdfdf4ba9898959e8ea6b94c6a5c4749a6`, tree `bf7155677197f27c4e2c6e2c80a1be55fdb7fb48`;
- prompt SHA-256 `4da7b4daeac9befbcc6709fad69645f4afee8df254effef77331ac58a5826a55`;
- TaskAssessment SHA-256 `ec4d877dbd8fa17e331eabf8c9d1d2ceeab97ced627ae6a1e668aca615e63ec8`;
- config SHA-256 `0064d8f09be97eb1711d2078624336c7b3796d7c905bd691e0e39c8d4435b6cb`;
- Controller `gpt-5.6-sol`, effort `xhigh`, Codex 0.147.0, Node.js v26.7.0;
- Executor Pi / OpenCode Go / `deepseek-v4-flash` / `max`;
- reviewer Pi / OpenCode Go / `gpt-5.6-luna` / `max`;
- identical Skills except the declared `waitMs` literal: control SHA-256 `5c4e66238c48575d043d1f56886f69f4707923474e4b44b29620a6f581fc9d2e`, treatment SHA-256 `9542d5d9331c06e55c04203eaf3718f599aadc8f62358970c210341a4f6d5ec4`;
- fresh Controller sessions, separate target and AgentKnot worktrees, storage, homes, temporary directories, and broker ports 7431/7432.

Both Skills prohibited status polling, plan bookkeeping, source pre-reading, extra validation, resubmission, and speculative output reads. Both wrapped an MCP wait in the same 200-second outer yield so no outer `functions.wait` polling turn was introduced. Control explicitly passed 40,000 and resumed active cursors; treatment explicitly passed 180,000. There was no human intervention, Worker retry, Controller retry, broker restart, or provider error after either final session began.

## 8. Arm execution

A recorded random byte 42 with the rule `even=control-first; odd=treatment-first` selected control first.

| Arm | Controller session | Session start (UTC) | Session end (UTC) | Wait policy |
| --- | --- | --- | --- | --- |
| Control | `01a00f21-7193-7db1-b121-c779c8f22646` | 09:50:45.160 | 09:53:52.811 | explicit 40,000 ms, cursor resume |
| Treatment | `01a00f24-f018-72a0-96a3-6c7eb30c42cf` | 09:54:34.154 | 09:58:21.020 | explicit 180,000 ms |

The task reused the 0089 `coalesceRanges` fixture: implement the dependency-free inclusive-range merge in `src/ranges.js`, preserve caller arrays, validate all input, modify no other file, and pass the committed `npm test` suite. Natural Executor plus reviewer work produced 120.775 seconds from control admission to terminal and 158.886 seconds in treatment; no artificial delay was used.

## 9. Correctness

| Arm | Orchestration | Executor Job | Reviewer Job | Result | Artifact verification | Controller validation | Changed files | Disposition |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| Control | `orchestration_6f602b5c-2a3b-41fc-a201-b63cdadde6f4` | `job_32fb7549-6ddd-4efd-a0a2-7b9e8fd67cc4` | `job_65ba1079-dc08-410c-a113-14178a44cf12` | succeeded / accept | valid, SHA `3743241e…9dea` | `npm test` passed | 1 | accepted in disposable target |
| Treatment | `orchestration_c3975aa2-f47c-40e4-8884-fa06aaf075a5` | `job_92bbad61-cda0-4bba-82bd-3412c7b5ad3b` | `job_5fd8d57e-784d-452b-bcf5-6d0c78795b1b` | succeeded / accept | valid, SHA `0889e499…e37` | `npm test` passed | 1 | accepted in disposable target |

Both Jobs and both reviewers succeeded on their first attempt with no findings. Both changed only `src/ranges.js`; `git diff --check` and an independent maintainer rerun of the same four-case committed test file passed. The implementations and artifacts are not byte-identical, but their behavior and accepted file scope are equivalent. Nothing was applied to the AgentKnot canonical checkout.

## 10. Wait-call and progress results

| Arm | Wait calls | Active returns | Terminal returns | Total blocked seconds | Progress updates |
| --- | ---: | ---: | ---: | ---: | ---: |
| Control | 3 | 2 | 1 | 106.829 | 20 |
| Treatment | 1 | 0 | 1 | 153.303 | 31 |

Control waits were 40.003 seconds (`cursor=0`, active `nextSequence=8`), 40.002 seconds (`cursor=8`, active `nextSequence=8`), and 26.824 seconds (`cursor=8`, terminal `nextSequence=10`). Treatment's one 153.303-second wait returned terminal `nextSequence=10`.

Control progress notifications totaled 3,006 transport bytes; treatment totaled 4,681. Each arm reported connected durable progress. There were zero disconnected/reconnect notifications, transport errors, automatic cancellations, or explicit aborts. Cancellation was not deliberately triggered during the pair; unchanged public MCP tests continue to prove prompt abort of both snapshot and follow requests without cancelling admitted work.

The two control active responses were 784 UTF-8 JSON bytes each in `structuredContent` and 784 each as text, 3,136 combined bytes across both compatibility representations. Treatment emitted no active response. The terminal handoffs were 3,931 bytes per representation in control and 4,119 in treatment; their full wait wrappers were 3,981 and 4,169 bytes per representation respectively. Neither triggered `handoffTruncation`, and both made zero `agentknot_job_output` calls.

## 11. Controller usage

Source: exact Codex session `event_msg.token_count` statistics. Reasoning is a reported subset of output and is not added to total.

| Arm | Input | Cached input | Non-cached input | Output | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Control | 264,464 | 232,448 | 32,016 | 2,871 | 267,335 |
| Treatment | 158,758 | 140,288 | 18,470 | 2,695 | 161,453 |

The observed treatment session had 105,706 fewer input tokens, including 92,160 fewer cached and 13,546 fewer non-cached input tokens. It also had eight model turns instead of twelve. This pair establishes an observed association with fewer active waits, not a universal or fully isolated token effect: natural model execution duration, completion content, artifact bytes, and post-handoff model behavior varied.

### Final-pair per-turn usage

| Arm / turn | UTC | Tool request / response | Input | Cached | Non-cached | Output | Reasoning | Cumulative input | Cumulative total |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| C1 | 09:50:55.000 | Tool discovery / complete | 14,688 | 11,008 | 3,680 | 181 | 85 | 14,688 | 14,869 |
| C2 | 09:50:59.304 | Skill read / complete | 17,198 | 14,080 | 3,118 | 152 | 63 | 31,886 | 32,219 |
| C3 | 09:51:03.888 | Broker status + policy / available | 17,993 | 16,128 | 1,865 | 86 | 20 | 49,879 | 50,298 |
| C4 | 09:51:14.735 | Orchestration start / admitted | 18,579 | 17,152 | 1,427 | 531 | 40 | 68,458 | 69,408 |
| C5 | 09:52:00.275 | Wait 1 / active | 19,595 | 11,008 | 8,587 | 228 | 65 | 88,053 | 89,231 |
| C6 | 09:52:44.262 | Wait 2 / active | 20,429 | 19,200 | 1,229 | 117 | 10 | 108,482 | 109,777 |
| C7 | 09:53:15.483 | Wait 3 / terminal | 21,152 | 20,224 | 928 | 175 | 18 | 129,634 | 131,104 |
| C8 | 09:53:21.481 | Artifact preview / valid | 23,951 | 20,224 | 3,727 | 226 | 65 | 153,585 | 155,281 |
| C9 | 09:53:27.973 | Apply-tool discovery / complete | 25,341 | 23,296 | 2,045 | 210 | 157 | 178,926 | 180,832 |
| C10 | 09:53:45.083 | Artifact apply / applied | 27,880 | 24,320 | 3,560 | 788 | 273 | 206,806 | 209,500 |
| C11 | 09:53:48.337 | Final validation / passed | 28,692 | 27,392 | 1,300 | 78 | 11 | 235,498 | 238,270 |
| C12 | 09:53:52.799 | Final response / accepted | 28,966 | 28,416 | 550 | 99 | 44 | 264,464 | 267,335 |
| T1 | 09:54:48.811 | Skill read / complete | 14,695 | 11,008 | 3,687 | 326 | 174 | 14,695 | 15,021 |
| T2 | 09:54:51.771 | Tool discovery / complete | 15,664 | 14,080 | 1,584 | 82 | 36 | 30,359 | 30,767 |
| T3 | 09:54:55.046 | Broker status + policy / available | 18,075 | 15,104 | 2,971 | 106 | 40 | 48,434 | 48,948 |
| T4 | 09:55:07.487 | Orchestration start / admitted | 18,675 | 17,152 | 1,523 | 494 | 48 | 67,109 | 68,117 |
| T5 | 09:57:46.311 | Wait 1 / terminal | 19,658 | 18,176 | 1,482 | 214 | 46 | 86,767 | 87,989 |
| T6 | 09:57:53.030 | Artifact preview / valid | 22,611 | 19,200 | 3,411 | 252 | 70 | 109,378 | 110,852 |
| T7 | 09:58:15.496 | Artifact apply + final validation / passed | 24,034 | 22,272 | 1,762 | 1,116 | 516 | 133,412 | 136,002 |
| T8 | 09:58:21.010 | Final response / accepted | 25,346 | 23,296 | 2,050 | 105 | 51 | 158,758 | 161,453 |

## 12. Downstream usage

Exact persisted evidence from `agentknot usage --json` covered two of two attempts in each arm, with complete coverage, no unavailable attempt, and no retry.

| Arm | Input | Output | Cache read | Cache write | Total | Provider-reported cost | Attempts | Retries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Control | 10,614 | 9,243 | 25,862 | 6,481 | 52,200 | 0.009062125 | 2 | 0 |
| Treatment | 17,096 | 13,850 | 43,112 | 4,718 | 78,776 | 0.013260998 | 2 | 0 |

The downstream difference is model-run variance and helps explain the treatment's longer natural orchestration. It is not evidence that long wait changes Worker or reviewer consumption; wait policy does not enter either downstream prompt.

## 13. Timing

| Arm | Start-to-terminal | Terminal-to-acceptance | End-to-end |
| --- | ---: | ---: | ---: |
| Control | 120.775 s | 37.322 s | 187.651 s |
| Treatment | 158.886 s | 34.704 s | 226.866 s |

Start-to-terminal measures the Orchestration admission request to the terminal wait response. Terminal-to-acceptance measures terminal MCP completion to the final Controller response. End-to-end measures Codex `session_meta` to the last session event. Treatment was slower end-to-end because its natural downstream work was about 38 seconds longer; this pair does not establish a latency improvement.

## 14. Validity

The final pair is valid under the predeclared conditions: identical target base/tree, top-level prompt, assessment, acceptance criteria, AgentKnot experimental implementation, Controller model/effort/timeout, Worker and reviewer routes, and Skill instructions except the explicit wait value; isolated storage and worktrees; randomized order; no one-sided status polling, outer polling, plan calls, timeout, tool-count limit, retry, provider error, broker restart, or human correction; both tasks completed and passed the same independent validation; treatment was not truncated by its client; exact evidence sources were retained.

The independently produced source and artifact bytes differ, and downstream model usage/duration differ. Behavioral equivalence is established by the same acceptance criteria and tests, not byte identity. These differences limit token and elapsed-time causality but do not invalidate the direct observations that 180 seconds was transport-compatible and reduced active wait returns from two to zero in this pair.

## 15. Findings

- One explicit 180-second wait was compatible with Codex 0.147.0 when its MCP server timeout was symmetrically configured to 240 seconds.
- The treatment held one request for 153.303 seconds, received 31 progress updates, and returned terminal without active cursor, retry, reconnect, resubmission, or output read.
- Control required three wait calls and two active returns for a 120.775-second orchestration; treatment required one wait for a 158.886-second orchestration.
- Controller model turns fell from twelve to eight. Exact session statistics observed lower cached and non-cached input in treatment, but the full token delta is not causally attributable to wait alone.
- The long wait exercised the same production follow loop, durable cursor, progress, summary-first handoff, artifact review, and acceptance path. Only the experimental schema maximum differed from canonical code.

## 16. Non-findings

This pilot does not prove a general reduction in total tokens, cost, or latency; that progress notifications renew client deadlines; that progress is absent from every Controller's model context; that Claude or any Codex configuration other than the tested one accepts long waits; that 180 seconds is optimal; that the default should change; that a disconnect would recover during a 180-second request; or that users can always tolerate a longer outstanding tool call. It did not deliberately cancel or disconnect the treatment; those semantics are supported by unchanged code and regression tests, not newly demonstrated under a 153-second request.

It also does not isolate every token difference from natural Worker/reviewer and Controller sampling variance. MCP bytes are not tokens, and no character-to-token estimate is used.

## 17. Decision

**B. allow-opt-in-long-wait.**

The compatibility and turn-amplification hypothesis succeeded for one controlled Codex pair: an explicit longer wait eliminated two active responses and associated reattachment calls while preserving observed correctness and transport behavior. One pair, one client configuration, no deliberate cancellation/disconnect, and variable downstream duration are insufficient to change the default. Canonical production remains at a 40,000 ms default and maximum until a separately reviewed minimal candidate is proposed.

## 18. Follow-up

The next small phase should be a review-only proposal to widen only the explicit `waitMs` maximum while retaining the 40-second default, cursor resume, active result, progress notifications, and all durable semantics. It should document client timeout requirements and add focused schema/MCP coverage. Before promotion, repeat compatibility on Claude or record it as unsupported/unknown; separately exercise Controller cancellation during a long request. Do not add a new wait tool, change transport timeouts, persist Controller usage, or alter workflow behavior.

This experiment leaves two uncommitted, non-runtime files for review: this document and `scripts/wait-turn-pilot-mcp-proxy.mjs`. No production source, configuration, durable schema, Skill, route, or lifecycle file is changed.

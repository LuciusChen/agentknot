# 0089: Retain summary-first handoff after a real Controller pilot

- Type: Experiment / Architecture Decision
- Status: Accepted / Retained
- Date: 2026-08-17
- Owners: AgentKnot maintainers
- Related: [durable usage 0034](./0034-persisted-usage-observability-boundary.md), [controller-owned planning 0053](./0053-controller-owned-planning-handoff.md), [bounded waiting 0075](./0075-bounded-mcp-wait-and-resume-gate.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## 1. Question

Does the bounded summary-first terminal handoff reduce the actual serialized MCP boundary in one real delegated Controller workflow, keep raw Worker output out of the default Controller context, and still provide enough evidence for artifact acceptance without an eager output read?

This pilot does not compare delegation with direct execution and does not test a general total-token, cost, or latency claim.

## 2. Hypothesis

For one bounded implementation with a valid artifact, required completion report, independent quality review, and deterministic validation, the Controller should be able to accept or discard from summary evidence. The treatment handoff should be smaller even when its retained Worker output is not smaller, and `agentknot_job_output` should remain unused unless the summary leaves a concrete acceptance gap.

## 3. Commits and immutable inputs

The implementation was frozen before the pilot:

- Checkpoint parent / control: `91c0f34c1f10b8a9cc6445ca1089997e4f6be070`
- Summary-first checkpoint / treatment: `ebee8c978e0586130f62da8c26bfca974f641914`
- Checkpoint message: `feat: add bounded summary-first orchestration handoff`
- Target repository commit: `1189bfcdfdf4ba9898959e8ea6b94c6a5c4749a6`
- Target tree: `bf7155677197f27c4e2c6e2c80a1be55fdb7fb48`
- Final-pair Controller prompt SHA-256: `4da7b4daeac9befbcc6709fad69645f4afee8df254effef77331ac58a5826a55`
- AgentKnot config SHA-256, both arms: `0064d8f09be97eb1711d2078624336c7b3796d7c905bd691e0e39c8d4435b6cb`
- Controller Skill SHA-256, both arms: `248a4a5cbbd2c7d553aff7065f47dc64745b3a0079b5eec27565f1ab15ab504c`
- Effective Worker prompt SHA-256, both arms: `f02720c30b3116210788b43cbb6b47829c81ed76d332b6f3e759855914af6894`
- Orchestration plan hash, both arms: `5337a1d5a1becb72d306f1f7052b02f5fbbb96bdc6106ce60a8dde2075d8579f`
- Node.js: `v26.7.0`

The checkpoint was built and tested before commit: `npm run build` passed, `npm test` passed 368/368, and `git diff --check` passed. The checkpoint was not pushed.

## 4. Experimental controls

Both final arms used fresh Codex sessions, the same target path recreated at the exact target commit between arms, the same prompt, TaskAssessment, acceptance criteria, Controller Skill, Controller model `gpt-5.6-sol`, effort `xhigh`, Codex CLI `0.147.0`, approval policy `never`, and externally controlled `danger-full-access` execution mode. The Worker route was Pi / OpenCode Go / `deepseek-v4-flash` / `thinkingLevel=max`; the quality-review route was Pi / OpenCode Go / `gpt-5.6-luna` / `thinkingLevel=max`.

Control used port 7421 and its own Job, Orchestration, worktree, and temporary storage. Treatment used port 7422 and a separate set of those resources. Neither arm shared durable records. Both used four MCP wait calls, one artifact preview, no single-sided tool-count or timeout override, no broker restart, no Worker retry, no Controller retry, no manual correction, and no provider error after the final session began.

Two treatment setup probes were excluded before the final session: one was blocked by the outer sandbox before any model response or AgentKnot call; a second reached a Controller response but its mutating MCP call was cancelled locally before reaching the server. Durable inspection showed zero Jobs and zero Orchestrations. The final session used the same no-approval/no-sandbox Controller mode as the original complete pair.

## 5. Task and acceptance criteria

The target was the committed `range-coalescer-ab` fixture. Its baseline had one stub implementation and four deterministic Node tests. The task was to implement `coalesceRanges` in `src/ranges.js` without dependencies or any other file change.

Acceptance required caller-owned arrays to remain unchanged; fresh sorted output; merging overlap and direct adjacency; `TypeError` for malformed, reversed, non-safe-integer, and non-finite ranges; and `npm test` passing. The same exact TaskAssessment and top-level Orchestration prompt were supplied in both final arms.

## 6. Arm execution order

A cryptographically random byte selected the order at `2026-08-17T08:47:08.445Z`: byte 229 selected treatment first, then control.

| Arm | Controller session | Start (UTC) | End (UTC) |
| --- | --- | --- | --- |
| Treatment | `01a00ef4-4b64-7921-8db4-0a2e9bea2bde` | 2026-08-17 09:01:26.275 | 2026-08-17 09:05:32.000 |
| Control | `01a00eff-6842-7392-ae0e-f86cba609b93` | 2026-08-17 09:13:34.554 | 2026-08-17 09:17:12.577 |

## 7. Correctness results

Both Orchestrations and all four Jobs ended `succeeded` on attempt one. Both quality reviews returned `accept` with no findings. Broker-owned artifact validation and the Controller's final integrated `npm test` each passed 4/4 in both arms. Each artifact was verified against the same base commit and tree, and each changed only `src/ranges.js`. Each Controller accepted and integrated its one previewed artifact; no commit or push occurred.

| Arm | Orchestration | Executor Job | Reviewer Job | Verified artifact SHA-256 |
| --- | --- | --- | --- | --- |
| Control | `orchestration_7ebaf34e-5948-481a-8aa7-ba67b8340531` | `job_1c6377ef-26c4-4265-9aa5-bf5b6e6a926f` | `job_3a22d74c-f654-4ff4-bb4f-1816b50fbd42` | `8462a93673d3e7c78f211cf443232d4faae63edce411c5d3d8547a6b28ae64d2` |
| Treatment | `orchestration_2a9cd8a2-a2df-4227-b364-79e6dd00c83f` | `job_707d2165-93ee-40fd-8d27-b2fdc9099cc8` | `job_6741b86d-6168-4b76-9e45-f8be5c8c76b9` | `caa56c92007b4f3469d6e63088b5aa5baf6e2995182a1b0918aa024a6bc28589` |

The independently produced implementations were not byte-identical, but passed the same tests and met the same acceptance criteria. The treatment artifact was 1,415 bytes. The control artifact was 1,311 bytes; its Controller integration normalized the missing final newline, so the integrated diff hash differs from the artifact hash without changing behavior or file scope.

## 8. Handoff byte measurements

Measurements came from a transparent JSON-RPC proxy. Each value uses `Buffer.byteLength(JSON.stringify(value), "utf8")` on the terminal handoff itself. Text JSON and `structuredContent` were semantically equal. The surrounding wait wrapper added 50 bytes per representation and is excluded from the single-handoff values below.

| Boundary | Control | Treatment | Treatment delta |
| --- | ---: | ---: | ---: |
| `structuredContent` terminal handoff | 4,455 | 3,895 | -560 (-12.57%) |
| Text JSON terminal handoff | 4,455 | 3,895 | -560 (-12.57%) |
| Both MCP representations combined | 8,910 | 7,790 | -1,120 (-12.57%) |
| Treatment output-reader chunks | n/a | 0 | 0 |

Control automatically included 1,045 bytes of raw `children[0].output`. Treatment automatically included no raw output and instead reported `outputAvailable=true`, `outputBytes=1166`, `outputTruncated=false`, and its completion summary. Thus the treatment boundary was smaller even though its durable retained Worker output was 121 bytes larger. Neither arm triggered `handoffTruncation`; `originalBytes`, `omittedItems`, and `affectedChildren` are therefore not applicable for this fixture.

## 9. Output-reader use

The treatment Controller explicitly found completion outcome, changed files, checks, remaining risks, quality-review verdict, artifact identity, artifact verification, and broker validation sufficient. It made zero `agentknot_job_output` calls and retrieved zero output bytes. It did not read to the final page because no first page was needed.

After both brokers stopped, maintainer-side durable reads still found the full retained output: 1,045 bytes in control and 1,166 bytes in treatment, neither retention-truncated. Those reads were evidence collection after the Controller sessions, not Controller output-reader calls.

## 10. Controller usage

Exact usage came from each Codex session's final `event_msg.token_count.info.total_token_usage`, consistent with `turn.completed.usage`. Reasoning output is a reported subset of output and is not added again.

| Arm | Input | Cached input | Non-cached input | Cache write | Output | Reasoning output | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Control | 494,729 | 456,960 | 37,769 | 0 | 3,547 | 1,084 | 498,276 |
| Treatment | 425,355 | 380,160 | 45,195 | 0 | 4,659 | 1,804 | 430,014 |

Controller usage is available from session statistics. The observed treatment total is 68,262 tokens lower, but uncached input is higher (45,195 versus 37,769), output is higher, and Controller post-handoff behavior differs. This single pair does not attribute the total delta to the handoff or establish a general token reduction.

AgentKnot's own `usage --json` correctly continued to report upstream usage as unavailable because Controller telemetry is not persisted in AgentKnot. The external session evidence is not a new product schema.

## 11. Downstream usage

Exact persisted attempt evidence from `agentknot usage --json` covered two of two attempts in each arm, with zero unavailable attempts and zero retries.

| Arm | Input | Output | Cache read | Cache write | Total | Provider-reported cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Control | 15,984 | 8,510 | 19,657 | 3,842 | 47,993 | 0.009483332 |
| Treatment | 15,231 | 9,442 | 20,757 | 4,107 | 49,537 | 0.009957465 |

The treatment used 1,544 more reported downstream tokens and slightly more reported cost. This is normal model-run variance and is not evidence for or against the upstream serialization boundary.

## 12. Tool calls and elapsed time

Both arms made eight AgentKnot MCP calls: broker status, delegation policy, one orchestration admission, four waits on the same ID, and one artifact preview. Neither Controller read target file bodies or re-read files already read by the Worker. Each ran the final integrated validation exactly once.

After terminal handoff, control used three Controller tool-call frames: preview, apply, and `npm test`. Treatment used five frames: one combined plan-update/preview frame, apply, `npm test`, `git status --short`, and a final plan update. Counting nested semantic calls yields three versus six; treatment's extras were two plan bookkeeping calls and one status check, not output retrieval or source reads.

| Arm | Controller elapsed | Orchestration request to terminal handoff | Terminal handoff to Controller completion | Target file reads | Final validations |
| --- | ---: | ---: | ---: | ---: | ---: |
| Control | 218.023 s | 151.287 s | 34.239 s | 0 | 1 |
| Treatment | 245.725 s | 148.593 s | 54.895 s | 0 | 1 |

Tool-call counts and elapsed time describe this run; they are not token, cost, or quality proxies.

## 13. Validity assessment

The final pair is valid under the predeclared conditions: same target commit and path, byte-identical Controller prompt, exact TaskAssessment and acceptance criteria, same effective Worker prompt and plan hash, same Controller model/effort/mode, same Worker and reviewer routes, isolated storage, no asymmetric limit, both tasks complete, same independent validation passed, behaviorally equivalent results, no human correction, no unexplained provider failure, and measurements from explicit transport, session, and persisted-record sources.

An earlier complete pair is retained but excluded. Its initial Controller prompt SHA-256 was `12f0f23e6e54ffe0ec474b69851b56289383e6fcf04522674bd374f0c3edf3ca`, but the two Controllers independently paraphrased the top-level Orchestration prompt. Their effective Worker prompt hashes and plan hashes therefore differed. That pair also completed correctly, measured 4,282 versus 3,893 bytes per handoff representation, and used no reader, but it is not A/B evidence. The final prompt closed that gap by fixing the top-level prompt byte-for-byte.

## 14. Findings

- Summary-first prevented raw Worker output from automatically entering the treatment handoff.
- The real treatment handoff was 560 bytes smaller per representation and 1,120 bytes smaller across the MCP compatibility pair, despite retaining more Worker output durably.
- Completion, artifact, review, validation, error, and output metadata were sufficient for Controller acceptance; no output read was needed.
- Both arms produced behaviorally equivalent accepted results and passed the same independent and integrated tests.
- Exact Controller usage was obtainable from Codex session statistics, while AgentKnot correctly left upstream usage unavailable in its own schema.

## 15. Non-findings

This pilot does not show that AgentKnot generally reduces total tokens, cost, latency, tool calls, downstream usage, or completion risk. It does not show that all tasks can avoid output reads, that 32 KiB is universally optimal, that duplicate MCP text and structured representations should be removed, or that one observed Controller-token delta is caused by the 560-byte boundary delta. It does not compare delegation with direct execution or test multi-child worst cases, truncation degradation, reader guidance under a real information gap, different Controllers, providers, models, repositories, or task classes.

## 16. Decision

**A. retain-summary-first.**

The valid real pair meets the decision rule: summary evidence was sufficient for acceptance, raw Worker output stayed out of the default treatment handoff, the actual serialized Controller boundary was measurably smaller, all correctness gates passed, and the reader remained available without being invoked. Retain the implementation and its 32 KiB hard boundary. Do not claim universal token or cost savings from this pilot.

## 17. Files changed

- `postmortems/0089-summary-first-handoff-real-controller-pilot.md` records the immutable inputs, measurements, validity decision, findings, and non-findings.
- `postmortems/README.md` indexes this experiment.
- `scripts/handoff-pilot-mcp-proxy.mjs` is the dependency-free, non-runtime JSON-RPC measurement proxy used to record MCP boundary bytes without changing either product arm.

## 18. Follow-up

The next small phase should be a reader-needed pilot with a task whose completion report intentionally leaves one concrete acceptance fact unavailable, without changing the summary contract first. The purpose would be to test whether one bounded page closes the gap. Do not add Controller usage persistence, a result contract, memory, DAGs, a budget manager, or another workflow abstraction on the strength of this pair.

# 0069: Repeat shared-context scope trials and remove contradictory check guidance

- Type: Experiment / Incident
- Status: Accepted / Resolved
- Implementation: Prompt-precedence correction and route-neutral blocked settlement delivered
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Related: [decision 0068](./0068-bounded-shared-task-context.md), [decision 0067](./0067-route-tool-execution-budget.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Question

Does the optional bounded `TaskAssessment.context` actually narrow real worker behavior, rather than merely survive protocol validation? Repeated evidence must distinguish path/command adherence from hard enforcement and must not infer success from worker prose alone.

## Pre-correction failure

Luna/max orchestration `orchestration_91c8f4a6-b670-4cd1-945b-75f7ffca4a9a`, child `job_c2af6eee-e12a-4ad1-823a-cdd40729768d`, received six explicit paths, a 12-call limit, and a prohibition on the full test suite. Attempt one used nine normalized tool starts and kept every repository read inside the named paths, but the generic execution footer still asked it to run relevant checks. It tried `npm test -- --run ...`; the project script expanded to 259 tests. The worker honestly reported the violation as `taskOutcome: blocked`, which the generic adapter-error path treated as retryable. The controller cancelled attempt two after another eight in-scope reads. This run disproved strict scope compliance and exposed a separate retry-semantics gap.

The correction is intentionally small: insufficient/stale context now produces available evidence plus a gap report instead of scope expansion, and explicit context constraints take precedence over the generic check request. No tool sandbox, allowlist engine, task-kind branch, route/model branch, or new state was added.

## Protocol

Six independent read-only repository analyses ran through the ordinary broker after the correction in two concurrent batches. Two used Pi/OpenCode Go/Luna/max at medium complexity; four used Pi/OpenCode Go/DeepSeek V4 Flash/max through the configured low-complexity rule. They covered prompt construction, broker lifecycle, blocked-report retry analysis, dirty-workspace isolation, HTTP cursor following, and usage-report aggregation. Each assessment supplied a 533–672 byte context, exact repository-relative paths, prohibited build/test/package/inventory or broader commands, required actual-access reporting, and permitted no patch. These historical trials also carried now-retired requested tool-count caps; decision 0083 treats those counts as a confound rather than a valid scope mechanism. Evidence comes from durable normalized tool starts, exact arguments, terminal attempts, Pi session statistics, completion envelopes, and unchanged empty artifacts.

## Results

| Orchestration / child | Route | Context | Result | Tool calls | Scope and commands | Elapsed | Provider-reported tokens | Cost |
| --- | --- | ---: | --- | ---: | --- | ---: | ---: | ---: |
| `orchestration_f111204d-4639-4614-a8c9-c270e1eacc82` / `job_74ad6c17-a4bf-49fb-906e-da4ef46dd09d` | Luna/max | 592 B | succeeded, attempt 1 | 6 | 3/3 named files; exact-path `git diff` and `rg`; no forbidden command | 75.368 s | 77,585 total (`12` input, `2,898` output, `50,357` cache-read, `24,318` cache-write) | 0.00528332 |
| `orchestration_f73129dd-274c-4bf6-85ca-95f6a6d76011` / `job_92cc58dc-c389-40f1-9129-346cac37d02c` | DeepSeek Flash/max | 613 B | succeeded, attempt 1 | 3 | 3/3 named files; read only; no command | 43.437 s | 16,666 total (`10,082` input, `1,848` output, `4,736` cache-read) | 0.00097109 |
| `orchestration_e09f2351-54e3-4723-94ba-5c9f70cda880` / `job_756a49cf-3eb1-44b6-87a5-be62e4590c64` | DeepSeek Flash/max | 653 B | succeeded, attempt 1 | 5 | 4/4 named files; read only; no command | 80.190 s | 75,618 total (`41,576` input, `4,730` output, `29,312` cache-read) | 0.00361356 |
| `orchestration_c05bf64b-eb45-4681-9038-847caef832ef` / `job_783c87eb-9147-4d97-9717-dba16abd4352` | Luna/max | 672 B | succeeded, attempt 1 | 8 | 3/3 named files; read only; no command | 198.549 s | 205,352 total (`21` input, `13,424` output, `154,359` cache-read, `37,548` cache-write) | 0.01429359 |
| `orchestration_7ee5b091-96a1-4648-b67a-ca683df92443` / `job_a25aa717-d2d4-49f0-8995-8891823f610b` | DeepSeek Flash/max | 533 B | succeeded, attempt 1 | 3 | 3/3 named files; read only; no command | 71.382 s | 47,250 total (`22,695` input, `3,819` output, `20,736` cache-read) | 0.00215234 |
| `orchestration_2af6130f-869b-45be-9dca-bd6350447c1d` / `job_19bed6b1-6160-4a71-9a14-f90ac77e5b07` | DeepSeek Flash/max | 607 B | succeeded, attempt 1 | 2 | 2/2 named files; read only; no command | 55.496 s | 22,273 total (`13,083` input, `3,814` output, `5,376` cache-read) | 0.00145730 |

The six runs reported 444,744 downstream tokens in aggregate and provider-reported cost 0.027771194. These totals describe six different tasks and must not be compared as model efficiency rankings. Pi session-statistics tool-call totals equal the retained normalized start counts in every run. DeepSeek runs that overflowed the general normalized event-retention budget did so through high-volume non-tool frames; independent terminal session statistics and completion reports still agree with every retained tool start. All six artifacts were empty, integrity-valid, and tied to their unchanged admitted trees.

## Interpretation

Six different tasks across both configured models obeyed every post-correction path and command boundary and completed once. Their tool counts remain descriptive observations only. This is repeated positive evidence that compact explicit working sets can constrain ordinary worker exploration across different repository surfaces. It is not evidence that a fixed call count contributed to quality, a controlled same-task A/B, a token-savings measurement, a model ranking, or proof that future prompts cannot violate constraints.

Natural-language constraints remain advisory. Exact capability enforcement would require an explicit route-neutral tool-authority contract and adapter support; this experiment does not justify adding that implementation surface yet. Decision 0083 removes the whole-attempt tool-count circuit rather than presenting it as path or command enforcement.

## Resolution: blocked is a terminal report, not a transient adapter failure

A valid `taskOutcome: blocked` report is intrinsically non-retryable because it is the worker's terminal semantic claim about the admitted task and immutable working set. Repeating the same route cannot change those admitted inputs. Required-report parsers now reject only absent or malformed envelopes and return a valid blocked report through the existing `WorkerRunResult.completionReport` contract. The orchestrator validates that common report, settles the Job as `failed` with `retryable: false`, retains the worker report and terminal artifact evidence, and emits no `job.retrying` event.

This interpretation applies to every adapter, worker, provider, model, and route that returns the shared report. It adds no Job status, second result schema, route flag, fallback, or adapter-specific error branch. Missing or malformed reports and transient adapter, transport, process, timeout, and cancellation failures retain their existing behavior. Focused Pi parsing and replaceable mock-adapter tests prove the boundary independently; the full suite remains the release gate.

## Privacy and security review

The contexts and durable event arguments contain repository paths and commands but no credentials or raw controller transcript. Provider statistics are aggregate counters. Local retained records still follow the existing retention policy; this report contains opaque record IDs and bounded measurements only.

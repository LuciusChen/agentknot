# 0081: Keep selective workspace-file context experimental after real token wins

- Type: Experiment / Architecture Decision
- Status: Accepted / Experimental
- Date: 2026-08-12
- Owners: AgentKnot maintainers
- Related: [decision 0068](./0068-bounded-shared-task-context.md), [decision 0077](./0077-task-context-reference-manifest.md), [experiment 0080](./0080-artifact-read-review-ab.md), [ROADMAP](../docs/ROADMAP.md)

## Question and boundary

Can a worker save downstream tokens when a controller supplies several context candidates and the worker reads only the relevant one, without adding a context service, retained worker session, generic retrieval framework, adapter-specific core branch, or automatic repository scan?

The minimum product change gives only `ContextReference.kind: "workspace-file"` selective-read semantics. Its locator must be a portable repository-relative path with forward-slash non-empty segments and no absolute, drive, dot, parent, or backslash form. The reference remains unverified navigation metadata; the worker may read a task-relevant subset with its existing workspace tools and must read content before treating it as evidence. Every other reference kind remains metadata-only and must not be resolved. This adds no tool capability, file verification, sandbox claim, storage, cache, or worker-adapter API.

The shared orchestration footer also now defers to an explicit task output format. The first complete real batch exposed the former unconditional request for files/checks/risks as trailing prose or duplicated JSON after an otherwise correct strict result. That contradiction was route-neutral and independent of context selection.

## Protocol and exclusions

Each valid final route batch used three policy lookups with exact hidden oracles and five committed candidate files. Arm A embedded all five bodies. Arm B received five bounded `workspace-file` references with summaries and had to read exactly the matching candidate. Orders were A/B, B/A, A/B; Pi sessions were fresh, both configured models used `thinkingLevel=max`, and metrics came from persisted Job timestamps/events plus provider-reported session statistics.

The preregistered per-route gate required 3/3 attempt-one pairs, exact oracle parity, empty artifacts, available statistics, no decoy read, at least two B total-token wins, at least 20% aggregate reductions in both reported total tokens and input-plus-cache-read-plus-output, and no more than 20% aggregate latency increase.

Three preliminary paths were excluded rather than repaired in place: one A pilot preceded a B admission rejected by the existing 2 KiB manifest limit; the first complete DeepSeek batch reproduced the generic output-format contradiction; and revision 2 leaked the exact oracle through acceptance criteria. A partial Luna revision-2 run was stopped when the leak was noticed; one already admitted Job completed on attempt two and is also excluded. Revision 3 removed the leak before either final route batch.

## Final revision-3 evidence

All twelve final Jobs succeeded on attempt one, returned the exact hidden oracle, produced empty artifacts, and used available provider statistics. Every B Job performed exactly one `read` of the matching candidate and no other tool call; every A Job used no tool.

| Route / three pairs | Embedded A | Selective B | B relative to A |
| --- | ---: | ---: | ---: |
| DeepSeek Flash/max reported total tokens | 33,188 | 23,188 | -30.13% |
| DeepSeek input + cache-read + output | 33,188 | 23,188 | -30.13% |
| DeepSeek Job latency | 18.396 s | 23.266 s | +26.47% |
| Luna/max reported total tokens | 32,604 | 21,957 | -32.66% |
| Luna input + cache-read + output | 2,517 | 10,037 | +298.77% |
| Luna Job latency | 35.574 s | 54.452 s | +53.07% |

The total-token direction repeated in all six pairs and across both routes. Luna's embedded prompts were reported primarily as cache writes, so the narrower traffic formula moved in the opposite direction. Neither route cleared the full promotion gate because selective tool use increased latency beyond 20%; Luna also failed the traffic-token condition.

For this session, the valid raw reports remain outside the repository at `/tmp/agentknot-selective-context-ab-deepseek-flash-1786546746591.json` and `/tmp/agentknot-selective-context-ab-luna-1786546848217.json`, mode 0600, with SHA-256 values `c7cf97d6f5eda131df053c8c580af8095a67809dd66151449ba18750c85a9589` and `c7fc45aad1d80ec7526b29bc022cab24b3c5600c09d4047fcbdda4ddb53ef81d`.

## Decision

Keep `workspace-file` as an explicit experimental reference kind because repeated real evidence establishes the intended selective-read behavior and more than 30% provider-reported total-token reduction in this five-candidate workload. Do not generate these references automatically, call the result universal savings, or promote it as a latency or billing optimization. Do not generalize resolution to arbitrary locators, external memory, semantic search, or new adapter tools. Promotion requires comparable real repository tasks that retain quality while meeting the complete token and latency gate.

The one-off runner and fixture remain outside the repository and are deleted after evidence capture. Deterministic tests own the stable path validation, prompt separation, and explicit-output precedence contracts.

# 0082: Reject automatic candidate-reference promotion after a real repository probe

- Type: Experiment / Architecture Decision
- Status: Accepted / Implemented
- Date: 2026-08-12
- Owners: AgentKnot maintainers
- Related: [decision 0053](./0053-controller-owned-planning-handoff.md), [decision 0063](./0063-remove-per-prompt-controller-obligations.md), [experiment/decision 0081](./0081-selective-workspace-context-ab.md), [ROADMAP](../docs/ROADMAP.md)

## Question and stop rule

Should the common controller handoff automatically turn two or more controller-known candidate paths into `workspace-file` references, without reading or copying their bodies, so normal Codex, Claude, and custom-controller delegation uses selective context by default?

The predeclared stop rule was to run one real repository probe pair before expanding to repeated tasks and both routes. If references did not narrow actual reads and improve provider-reported tokens without quality or latency regression, the default-contract draft would be removed instead of accumulating a negative optimization.

## Real repository probe

The task used the actual AgentKnot repository and five committed TypeScript candidates. Each arm had to identify the owner of portable `workspace-file` locator validation and enumerate its rejected path forms. Both used a fresh Pi session through OpenCode Go / DeepSeek V4 Flash / `thinkingLevel=max`, the same dirty-source snapshot, one attempt, the same task and acceptance criteria, and produced an empty verified artifact plus a required completion report.

Arm A used the existing `relevantPaths` working set. The first B arm used five references with deliberately generic summaries. A corrective B arm used concise controller-known file-role summaries and explicitly prohibited workspace listing/search; it did not disclose the owner or path-validation result.

| Arm | Result quality | Tool behavior | Reported total / traffic tokens | Job latency |
| --- | --- | --- | ---: | ---: |
| A: `relevantPaths` | Correct owner/categories; extra prose around requested JSON | 3 shell searches plus 1 targeted read | 28,487 | 18.137 s |
| B1: generic references | Correct owner/categories; extra prose around requested JSON | 3 shell searches plus 1 targeted read, including an out-of-candidate directory listing | 30,069 (+5.55%) | 22.254 s (+22.70%) |
| B2: role summaries | Correct owner/categories; extra prose around requested JSON | 2 candidate reads plus 1 targeted shell lookup | 35,100 (+23.21%) | 25.334 s (+39.68%) |

The B2 summaries reduced normalized tool calls from four to three and stopped the broad listing, but did not achieve a single-candidate read or token/latency improvement. No arm obeyed the exact JSON-only presentation requirement, so the probe also does not establish strict output-format quality.

Durable evidence is in Jobs `job_a830d52b-fb3b-4421-acf9-6784ea96e4bd`, `job_87215477-3f86-4154-9992-bf4c12ce0c3e`, and `job_2194b715-c24e-44f3-a8b6-3cc7f450c6f3`. Raw exact-record copies used for the calculation remain session-local under `/tmp/agentknot-real-ab-{a,b,b2}.json`.

## Upstream controller measurements

A fresh non-interactive Codex A arm was attempted before changing the installed plugin. The local nested CLI failed before `thread.started` or any model request with `failed to initialize in-process app-server client: Read-only file system`; retrying without ephemeral mode failed at the same boundary. No `turn.completed.usage` existed, so controller token use is unavailable rather than inferred. The failure did not mutate the repository and is not AgentKnot admission evidence.

On 2026-08-13, the comparison was rerun with two fresh isolated temporary Codex homes and marketplace snapshots: old commit `e12329a` / plugin `0.1.0+codex.20260812080026` and compact commit `489d6e2` / plugin `0.1.0+codex.20260812155752`. Both used `gpt-5.6-sol`, reasoning effort `low`, the same auth, prompt, current `489d6e2` workspace clone, and shared broker. Exact values below are the official `turn.completed.usage` fields.

The real delegated pair produced correct equivalent answers through Pi / OpenCode Go / DeepSeek V4 Flash / `thinkingLevel=max`, but was not behaviorally isomorphic:

| Arm | Controller path after Skill read | Input | Cached input | Output | Reasoning output |
| --- | --- | ---: | ---: | ---: | ---: |
| Old | one terminal wait, then one targeted upstream source read; controller set `maxToolCalls: 10` | 178,923 | 155,392 | 1,347 | 295 |
| Compact | one active wait plus one terminal reattach, no upstream source read; controller omitted the child override, resolving to 64 | 181,047 (+1.19%) | 144,128 | 1,191 | 278 |

The compact arm's downstream report was also longer. Those assessment, wait, verification, cache, and result-size differences dominate the fixed payload, so this pair is valid end-to-end behavior evidence but not a causal token comparison. Durable downstream evidence is in Orchestrations `orchestration_1cf59588-970f-4435-9a29-4f70adb65b04` and `orchestration_6a384069-acc1-4b24-99e6-2c2bf7682c9d`, with Jobs `job_54ab2f40-8fb8-495f-a639-42555e513902` and `job_d91a6137-80c3-4350-981d-af5500a65646`.

A second controlled pair isolated fixed input. Each fresh session read its installed Skill once, called no AgentKnot or repository tool, returned exactly `READY`, and reported zero reasoning output:

| Arm | Input | Cached input | Uncached input | Output |
| --- | ---: | ---: | ---: | ---: |
| Old | 33,042 | 25,088 | 7,954 | 148 |
| Compact | 32,878 (-164, -0.50%) | 25,088 | 7,790 (-164, -2.06%) | 170 |

The identical cached-input value and exact 164-token input reduction establish that the compact fixed payload is smaller in one controlled real Codex pair. Output varied by 22 tokens, so input plus output fell by 142 tokens (-0.43%). This does not establish a universal billing percentage, implicit Skill-selection rate, or end-to-end orchestration saving.

## Decision

Do not automatically generate `workspace-file` references in the controller Skill, core, hook, or custom-controller contract. The draft Skill/example change was removed before commit. Keep the reference kind explicit and experimental: a controller may still author it when its own evidence justifies the candidate summaries, but ordinary workspace tools remain able to list/search and prompt guidance is not enforcement.

Do not add middleware ranking, repository scanning, semantic retrieval, a new adapter reader, retained sessions, or a controller-specific branch to rescue this one task. The result fails the existing 0081 promotion gate early, so additional model/route repetitions would spend tokens without changing the decision.

As a separate deterministic upstream fixed-input reduction, compact the behaviorally equivalent Codex/Claude Skill and identical session obligation instead of promoting candidate references. The representative Codex Skill source falls from 5,600 bytes / 704 words to 5,005 bytes / 607 words while the normalized Claude body remains equal; the lifecycle obligation falls from 1,001 characters / 127 whitespace-delimited words to 752 / 96 and its declared limit falls from 1,200 to 800. The controlled external pair confirms a 164-token input reduction for one fixed Skill-load path. Retain the compact form, but make no end-to-end, implicit-selection, billing, or universal percentage claim from that micro result.

## Verification gates

- Codex and Claude Skill bodies remain normalized-equivalent and retain strict assessment, broker activation, wait/reattach, evidence review, and no-auto-promotion semantics.
- Their `SessionStart` hooks remain identical, stateless, and limited to `startup|resume|clear|compact`, with no `UserPromptSubmit` path.
- Full deterministic tests and plugin validation must pass before the compact payload is installed.
- Fresh external exact usage now covers one controlled explicit Skill-load pair and one non-isomorphic real delegation pair. Implicit selection and repeated end-to-end efficiency remain separate promotion gates; current-session or byte-count evidence cannot substitute for them.

# 0044: Require real-worker completion and canonicalize worktree identity

- Type: Incident / Decision
- Status: Resolved / Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected versions/commits: through `19cfa2f`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decision 0015](./0015-terminal-completion-provenance-boundary.md)
- Severity: High correctness risk for delegated task evidence

## Summary

Two real delegated review Jobs were persisted as `succeeded` after their workers emitted only intermediate progress and no terminal completion envelope. Both Jobs captured valid empty Git patch artifacts, but those artifacts proved only that no repository change was captured; they did not prove that either review finished. A separate worktree-naming defect repeated the existing `job_` identity and contributed to a worker requesting a fabricated external path.

Normal Pi and OpenCode runs now require one strict terminal `WorkerCompletionReport` envelope before their adapters return success. Managed worktrees now use the existing Job ID exactly once. Custom TypeScript adapters retain the optional report contract.

## Expected invariant

A successful built-in real-worker Job must have explicit terminal worker evidence after transport settlement. Process exit, intermediate text, and artifact integrity are independent signals and must not substitute for task completion. A managed worktree path must derive from the authoritative Job ID without adding another semantic Job prefix.

## Evidence and timeline

- JDBC review Job `job_0a603443-2d0f-4c54-b52d-f75d98892d6b` ended as `succeeded` with two progress text deltas, `completionSummary.workerReported.unavailableReason: "absent"`, and a valid empty patch.
- Clutch review Job `job_3c296899-d077-4108-a9c3-a2f95b348dfb` ended as `succeeded` with three progress text deltas, the same absent completion report, and a valid empty patch.
- The JDBC worker requested an external path shaped as `job-job-job_<id>`. AgentKnot's managed path already contained the duplicated shape `job-job_<id>-attempt-...` because creation prepended `job-` to an ID that already began with `job_`.
- A direct Luna review later returned a complete report and found the JDBC savepoint issue that the false-success Job had not reported.
- Historical Job records remain unchanged as audit evidence. The corrected runtime affects new attempts only.

## Follow-up: OpenCode permission denial before final response

A later native OpenCode review, Job `job_5988e9d9-3eec-4214-a052-ad602a312597`, correctly failed with `OpenCode output is missing required completion report`. Its OpenCode session contained 29 terminal tool records and six assistant messages, all ending with `finish: "tool-calls"`; no final assistant text existed for AgentKnot to lose or strip. The last parallel tool batch included a `grep` path whose Job ID had one extra `d`. OpenCode classified that fabricated path outside the managed worktree, auto-rejected the permission request in non-interactive mode, and recorded `The user rejected permission to use this specific tool call.`

OpenCode `v1.18.15` normally [continues after `tool-calls`](https://github.com/anomalyco/opencode/blob/v1.18.15/packages/opencode/src/session/prompt.ts#L1295-L1335), and its default build agent has no configured six-step limit. The [processor stops after a denied permission](https://github.com/anomalyco/opencode/blob/v1.18.15/packages/opencode/src/session/processor.ts#L627-L681) unless `experimental.continue_loop_on_deny` is enabled; the non-interactive CLI [auto-rejects permission requests](https://github.com/anomalyco/opencode/blob/v1.18.15/packages/opencode/src/cli/cmd/run.ts#L796-L817) unless its broad auto-approval mode is used. The repository's native OpenCode worker profiles now supply the narrow loop option through `OPENCODE_CONFIG_CONTENT`: the invalid operation remains denied, but the model receives the failure on another turn and can correct the path and emit its envelope. AgentKnot's strict missing-envelope failure remains unchanged as the final correctness boundary.

Real regression Job `job_0d50f25d-ad3a-4f78-b798-2a0c44a256e5` deliberately requested `/definitely/outside-agentknot/README.md`. OpenCode auto-rejected the external read, persisted the tool error, continued to a workspace-local read, emitted a valid completion envelope, and succeeded on its first Luna/max attempt with an empty verified artifact. The source remained unchanged, and no permission was granted to the outside path.

A separate forced review orchestration exposed a second cause at the prompt boundary. Planner Job `job_19c710ae-b472-45ae-b084-5fa8d9d73753` returned a schema-valid planner assessment on both Pi/Luna/max attempts, but the planner prompt demanded exactly one JSON object with no surrounding text while the adapter's later normal-run instruction demanded the marked completion suffix. Both attempts omitted the suffix and correctly failed. Planner and advisory-review prompts now name that transport-owned suffix as the sole allowed content outside their role JSON; each role parser still receives only its strict JSON because the adapter validates and strips the suffix first.

Regression orchestration `orchestration_442c02cc-7eb1-43bd-8dd0-83258ca5c7e8` then completed the same boundary end to end: Pi/Luna/max planner Job `job_3625cccc-adc4-4f1f-8111-68a61e51e2c7` succeeded with its envelope, native OpenCode/Luna/max child Job `job_b178b848-a40e-4e99-89a2-ee849b0bf9dc` survived two external-path denials, returned a substantive review plus valid envelope, and produced a verified empty worker-delta artifact from the dirty source snapshot.

## Root cause

The shared parser correctly distinguished valid, missing, and malformed envelopes, but both built-in adapters returned a normal `WorkerRunResult` for all three outcomes. The orchestrator therefore treated protocol/process settlement as successful execution and recorded the absent report only as advisory summary evidence.

The workspace manager separately built names as `job-${jobId}-attempt-...` even though public Job IDs are already `job_...`. Artifact verification behaved as designed: it validated the empty patch's bytes, SHA-256, and base commit, but that correct check was interpreted too broadly by the consuming workflow.

## Decision rationale

- Normal Pi and OpenCode Jobs inject the completion-envelope instruction themselves, so absence or invalidity is a built-in adapter protocol failure.
- The existing retry, terminal failure, artifact capture, and cleanup paths handle that failure; no new Job state or record schema is needed.
- `doctor` and `doctor --live` remain probe surfaces and do not use the normal-run envelope.
- Custom TypeScript adapters may still omit `completionReport`; requiring it globally would break the deliberately small worker contract.
- A valid report remains a worker claim. It does not replace controller-captured artifacts, controller-owned validation, or upstream judgment.
- Worktree names use `${jobId}-attempt-...`, retaining exact ownership and avoiding duplicate identity components.

## Alternatives considered

- Treat a clean exit or Pi settlement as sufficient. Rejected because both incidents satisfied that transport condition without completing the requested work.
- Treat a verified empty patch as sufficient for review tasks. Rejected because artifact integrity says nothing about whether a textual review reached a conclusion.
- Add a capability registry or new completion state. Deferred because the two promoted built-in adapters already control prompt injection and can enforce the protocol locally without expanding public architecture.
- Require all custom adapters to implement the envelope immediately. Rejected as an incompatible widening of the adapter contract.

## Consequences

Incomplete built-in worker runs now fail visibly and may use the route's ordinary retry policy. A worker that performs useful work but violates the final-envelope protocol no longer produces a successful Job. Existing records and schemas remain readable. Worktree paths become shorter and match their Job identity, while exact cleanup behavior is unchanged.

## What went well

Persisted events, stderr, completion-summary provenance, and artifact identity made the false-success distinction reproducible. Existing retry and cleanup ownership boundaries allowed a small adapter-level correction.

## What did not go well

The earlier Stage 1 gate proved one successful envelope emission but did not include a public Job regression where a real adapter emitted progress, exited cleanly, captured an empty artifact, and omitted the envelope. Documentation also described missing reports as advisory after built-in adapters had begun injecting the protocol.

## Corrective actions and gates

- [x] Maintainers — require valid terminal envelopes in Pi and OpenCode normal runs — adapter missing/malformed/non-terminal tests.
- [x] Maintainers — prove an incomplete OpenCode Job cannot succeed even with a valid empty patch — public Job regression test.
- [x] Maintainers — use the authoritative `job_...` identity once — concurrent/retry worktree naming assertions.
- [x] Maintainers — synchronize README, CHANGELOG, PRD, SPEC, and ROADMAP — documentation review.
- [x] Maintainers — run the complete suite under an isolated runtime directory — 234 of 234 tests passed.

## Deferred work

This correction does not claim semantic correctness, independent review quality, or controller acceptance of a worker's report. Those remain separate artifact-validation, advisory-review, and upstream-integration responsibilities.

## Privacy and security review

The record includes Job IDs and generalized repository labels needed to reproduce the incident. It excludes prompts, source contents, credentials, auth paths, provider responses, and artifact bytes.

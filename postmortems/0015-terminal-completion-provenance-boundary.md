# 0015: Keep terminal completion provenance explicit

- Type: Decision
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: 0.0.x bounded completion-summary slice
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [artifact handoff decision](./0002-git-worktree-artifact-handoff.md)

## Summary

AgentKnot adds an optional top-level `JobRecord.completionSummary` to newly terminal Jobs without rewriting older v1 records. The summary separates controller-captured changed paths from worker claims: captured paths come only from the terminal attempt's `JobArtifact.changedFiles` and retain artifact attempt, SHA-256, and base-commit identity, while a strict optional worker report is nested under an explicit reported/unavailable union. Neither branch is semantic verification.

The bundled Pi adapter does not yet emit the strict worker report. Its successful Jobs therefore retain the controller summary and an explicit worker-report unavailable reason rather than inferring a report from output, normalized events, stderr, or session statistics. The full roadmap completion-summary item remains gated on Pi emission and verification.

## Context

Artifact capture now provides useful Git-derived changed-file evidence in isolated worktree mode, but controllers also need one terminal-attempt summary that is present for success, failure, and cancellation. Direct workspace mode cannot provide the same capture, and older artifacts may omit `changedFiles`. Worker runtimes may know what they attempted or which checks they ran, but those assertions have a different provenance and are not proof of source-tree state or semantic correctness.

The contract had to remain route-neutral, preserve custom adapters that return only `output`, avoid changing Pi's prompt or RPC protocol, and expose one additive JobRecord shape through TypeScript, CLI JSON, HTTP, and callbacks.

## Expected invariant

- Every newly terminal succeeded, failed, or cancelled Job has a schemaVersion 1 completion summary before its terminal event is persisted or observed.
- A captured changed-file list is tied to the terminal attempt artifact and is never described as semantically verified.
- Worker claims are accepted only through a strict schemaVersion 1 adapter result and are never synthesized from prose, tool events, stderr, or session statistics.
- Failed or cancelled Jobs without a retained normal result report worker evidence as unavailable.
- Retries summarize only the terminal attempt while earlier artifacts remain separately inspectable.
- Existing v1 records without `completionSummary` remain readable and byte-stable.

## Evidence and timeline

1. Git worktree capture established controller-owned `JobArtifact.changedFiles`, including an explicit empty array for an empty patch, while direct mode continued to provide no artifact.
2. The bounded implementation added `JobCompletionSummary`, stable changed-file and worker-report unavailable reasons, and strict runtime validation at the orchestrator/adapter boundary.
3. Deterministic tests covered direct and worktree success, captured empty and nonempty changes, absent and malformed reports, failure, cancellation, retry terminal-attempt scoping, persist-before-observer ordering, callbacks, HTTP, CLI JSON, and legacy snapshot bytes.
4. The contract was deliberately not extended into Pi RPC or model-specific code; Pi remains an honest unavailable-report producer until a later evidence gate.

## Decision rationale

The orchestrator owns terminal state, attempt numbering, artifact capture, cleanup, persistence, and event ordering, so it is the only layer that can combine terminal outcome with the terminal attempt's controller evidence. A nested union makes provenance visible to every controller and prevents a worker claim from looking like a verified artifact fact.

Keeping the report optional and adapter-owned preserves the existing WorkerAdapter boundary. Strict validation rejects malformed shapes without turning a successful worker run into a failed Job, because report availability is observability evidence rather than execution correctness. Explicit unavailable reasons make direct mode, missing artifacts, legacy path data, absent reports, malformed reports, and non-retained failure/cancellation evidence distinguishable without speculative fallbacks.

## Alternatives considered

### Infer a report from output, events, stderr, or session statistics

Rejected. These sources are transport or diagnostic evidence, not a stable worker completion schema. Inference would make provider/protocol behavior leak into the controller-neutral contract and could turn prose into a misleading claim.

### Use artifact paths as the worker report

Rejected. Git capture belongs to the controller/workspace boundary and describes repository state relative to a base. Worker-reported paths describe what the worker claims; conflating them would erase provenance and imply semantic verification.

### Make the worker report required for terminal success

Rejected. Existing custom adapters return only `output`, and the current Pi adapter has no strict report protocol. Missing optional observability must not fail otherwise successful execution.

### Add a new summary endpoint or human CLI rendering

Rejected. The full JobRecord is already the public evidence surface through TypeScript, CLI JSON, HTTP, and callbacks. An additive field preserves one payload shape and avoids a second serializer or a new polling contract; human rendering remains intentionally stable.

### Persist earlier retry reports in the terminal summary

Rejected. A terminal summary must describe the terminal attempt. Earlier artifacts remain in the existing per-attempt artifact list, and future attempt-level worker evidence can be added without changing this boundary.

## Consequences

### Positive

- Controllers receive one terminal summary regardless of worker route or transport.
- Artifact provenance remains reviewable and identity-bound to attempt, hash, and base.
- Worker claims can be added by a custom adapter without moving orchestration policy into that adapter or Pi.
- Missing capability is explicit instead of silently inferred or falsely advertised.
- Legacy records and output-only adapters remain compatible.

### Costs and risks

- A captured path list is not semantic verification, code review, or artifact acceptance.
- Direct mode and older artifacts can produce unavailable capture evidence.
- The current Pi route cannot populate worker checks, risks, or notes until it emits the strict report.
- Completion summaries, reports, prompts, patches, and events may contain sensitive repository or user content and remain subject to the existing retention gap.
- The schema does not compare child artifacts, verify worker claims, or promote patches.

## What went well

The existing persist-before-observe event invariant provided a clear insertion point: build the summary after terminal-attempt capture and before the terminal event. Existing artifact identity and schema-version compatibility rules made the additive field possible without a migration or a second public payload.

## What did not go well

The artifact changed-file field could easily be mistaken for a full completion summary or a worker assertion. The boundary needed an explicit decision record and separate unavailable branches before worker-report support could be added safely. Pi support remains intentionally incomplete rather than being filled with a protocol or prose heuristic.

## Corrective actions and gates

- [x] Add optional `JobRecord.completionSummary` with terminal outcome, attempt, captured artifact provenance, and explicit unavailable reasons.
- [x] Validate custom-adapter `WorkerCompletionReport` shapes strictly and preserve unavailable evidence without failing successful execution.
- [x] Prove terminal persistence ordering, retry scoping, failure/cancellation behavior, public JSON surfaces, and legacy byte stability with deterministic tests.
- [ ] Define and implement a Pi report emission protocol without changing the current prompt/provider/model/thinking-level route contract.
- [ ] Re-run the full completion-summary evidence gate with Pi worker reports before marking the roadmap item complete.
- [ ] Define semantic verification and any explicit promotion workflow separately from this provenance contract.

## Deferred work

AgentKnot does not yet verify worker-claimed paths, check outcomes, risks, or notes against repository state. It does not infer missing reports, compare worker claims with artifacts, merge child summaries, or automatically apply/promote artifacts. These remain separate decisions and roadmap gates.

## Privacy and security review

Completion summaries can expose repository-relative paths, worker claims, check commands, risks, and notes. No credentials or raw provider responses are copied intentionally, but worker output, event data, patches, metadata, and callback payloads can contain sensitive content under the existing trusted-local and retention limitations.

## Addenda

### 2026-08-09 — bounded Pi emission slice

The bounded Pi slice now appends a provider/model-neutral instruction only in normal `PiRpcWorkerAdapter.run` jobs. The final assistant output may end with exactly one single-line `AGENTKNOT_WORKER_COMPLETION_REPORT_V1: ` suffix containing strict schemaVersion 1 `WorkerCompletionReport` JSON; every value is explicitly a worker-reported claim. The adapter parses only that suffix at the absolute end of accumulated assistant text, never infers from prose, tool events, stderr, raw events, or session statistics, leaves a missing suffix absent, returns `completionReport: null` for a detected malformed or unsupported suffix, and removes only a valid suffix from `result.output` while preserving preceding output. The orchestrator therefore records malformed evidence without failing an otherwise successful job. Doctor and live probe do not append or parse the suffix, and route provider, model, and thinking-level resolution remains unchanged without fallback. Deterministic fixtures cover prompt injection, valid/missing/malformed/unsupported output, strict anchoring, output preservation, summary propagation, and live-probe exclusion.

### 2026-08-09 — real Luna/max evidence

Job `job_84ec1f63-860d-44ff-9843-9b277cde181b` ran through the exact promoted Pi/OpenCode Go/`gpt-5.6-luna` route with `thinkingLevel=max`, without fallback. It succeeded on attempt one, produced an empty controller-captured patch with `changedFiles: []`, emitted a valid strict report, and persisted `completionSummary.workerReported.status: reported`; this closes the roadmap emission gate. The same run reported 877,739 total Pi session tokens for a bounded read-only analysis, so report correctness does not establish worker efficiency and context/tool cost remains a separate optimization target.

### 2026-08-09 — bounded Pi record-volume slice

Before this slice, completion-report dogfood Job `job_84ec1f63-860d-44ff-9843-9b277cde181b` occupied 1,869,956 persisted bytes. Its 126 `worker.raw` events occupied 1,370,118 serialized bytes (73.3% of the record) and consisted entirely of `turn_start`, `turn_end`, `message_start`, and `message_end`; those envelopes duplicated prompt, thinking, tool-call, and tool-result content already represented elsewhere. Implementation Job `job_33e49422-cccc-4600-a909-28ce75f41b90` showed the same shape: 618,874 raw-event bytes in an 884,091-byte record (70.0%).

The normal-run-only record-volume boundary is therefore deliberately narrow: `PiRpcWorkerAdapter.run` recognizes exactly those four types as known Pi lifecycle envelopes and omits them from `worker.raw`. Every received Pi frame still increments `metadata.rawEventCount`, including known envelopes; unknown event types remain `worker.raw`. Normalized text/tool/retry events, final output, completion-report behavior, live-probe behavior, route/provider/model/thinking configuration, and global event types are unchanged.

This is a record-volume filter, not a Pi-token-saving claim or general truncation. It does not add a schema migration, plugin installation, configuration/probe change, or global event-type change. Broader retention, compaction, or record-size limits remain separate work and are not established by this slice.

---
name: agentknot-delegate
description: Delegate bounded, independently verifiable repository work through the independent AgentKnot broker. Use whenever a repository implementation, repair, test, analysis, or documentation task needs more than one direct upstream action and has objective acceptance criteria, or for explicit $agentknot-delegate requests. Construct planning and a strict TaskAssessment upstream; never make a controller plugin own the runtime.
---

# AgentKnot bounded delegation

AgentKnot is controller-neutral middleware. The upstream controller owns intent, planning, decomposition, acceptance, and artifact promotion; AgentKnot owns deterministic validation, routing, scheduling, isolation, lifecycle, and evidence. Never scan an AgentKnot checkout or create a controller-local runtime to discover how to call it.

Keep informational chat, requirements, product decisions, artifact integration, commits, pushes, merges, and deployment upstream. Delegate only bounded work with objective acceptance criteria. Parallel subtasks must have no execution-order dependency, overlapping expected writes, or shared validation boundary.

Before admission, construct one strict assessment with exactly this shape:

```json
{
  "schemaVersion": 1,
  "recommendation": "delegate",
  "complexity": "medium",
  "parallelizable": false,
  "taskKinds": ["implementation"],
  "reasoning": "bounded repository work with objective acceptance criteria",
  "context": {
    "schemaVersion": 1,
    "summary": "Only the concise architecture and current-state facts already known by the controller that this handoff needs.",
    "relevantPaths": ["src/example.ts", "test/example.test.ts"],
    "constraints": ["Do not inspect unrelated repository history or architecture documents."]
  },
  "subtasks": [
    {
      "title": "bounded child",
      "kind": "implementation",
      "prompt": "self-contained instructions, scope, and non-goals",
      "acceptanceCriteria": ["specific verifiable outcome"]
    }
  ]
}
```

For repository work, build one parent `context` only from controller-known facts and keep its complete JSON below 2 KiB. Exclude transcripts, file contents, repository inventories, speculation, provider/model data, and repeated child instructions. Use repository-relative `relevantPaths` as the initial set and name hard constraints. Constraints override generic check guidance; missing context must be reported instead of widening scope. Every child receives the same compact prefix, so never duplicate it per child. If no useful context is already known, omit it; never scan merely to manufacture context.

Use `recommendation: "do-not-delegate"` only with an empty `subtasks` array. Do not put routes, providers, models, controller transcripts, or promotion instructions in the assessment.

Prefer the common MCP boundary:

1. Call `agentknot_broker_status`. For `stopped` or `unavailable` with `launchConfigured: true`, try `agentknot_broker_start` once, then read `agentknot_delegation_policy`. Startup may clear only identity-matching crash-stale discovery; malformed or unidentified state fails. If launch is unconfigured or startup fails, report it and continue upstream without substituting a runtime, worker, provider, or model.
2. For an eligible assessment, call `agentknot_orchestration_start` with the bounded parent prompt, exact workspace, controller source, and assessment. Use `delegation: inherit`; use `force` only for an explicit skill request.
3. Admission is durable but may be queued. By default call `agentknot_orchestration_wait` with the exact `id` and last `afterSequence`, omitting `waitMs` to retain the 40-second default. Only when the client configuration is already known to support it may the caller explicitly request up to `waitMs: 180000`; never infer that choice from task complexity or duration. Keep the client tool timeout longer than the wait with a reasonable transport margin. Codex 0.147.0 was experimentally verified with `tool_timeout_sec = 240`, but this is an example rather than an AgentKnot-managed setting, evidence for every Codex version, or a guarantee for other clients; Claude 180-second compatibility remains unavailable. The longer observation bound does not guarantee lower token use, cost, or latency. A terminal result contains the handoff; an active result returns the same `id` and `nextSequence`, which must be reattached without resubmission. A client timeout or request abort may leave the durable orchestration running: reattach the same ID and cursor and do not call `agentknot_orchestration_start` again. Reserve `agentknot_orchestration_follow` for one-batch diagnostics and `agentknot_orchestration_status` for an immediate snapshot. Do not repeatedly list or dump jobs.
4. Review status, result action, child outcomes, completion evidence, artifact verification, quality review, and controller-owned artifact validation. Worker output is intentionally absent from the default handoff, whose serialized form is capped at 32 KiB; treat `handoffTruncation` as explicit evidence that optional summary items were omitted. Call `agentknot_job_output` only when the retained summary is insufficient, and follow its byte cursor without requesting more than the tool limit. Preview each valid non-empty patch once with `agentknot_artifact_preview`.
5. Never apply, stage, commit, push, merge, or deploy a downstream artifact automatically. The upstream controller decides whether to promote it and validates the integrated workspace once after applying an accepted patch.

If MCP is unavailable but the `agentknot` CLI is explicit, run `agentknot broker status --json`; for a configured stopped/unavailable broker, try `agentknot broker start --json` once. This uses only the protected launch profile, never target-repository inference. Then run `agentknot client --json` and, when available, `agentknot orchestrate --server <url> --source codex --workspace <root> --delegation <mode> --assessment-json <json> --handoff-json --progress --prompt <task>`. Otherwise report the unavailable prerequisite and continue upstream without local-runtime, worker, provider, or model fallback.

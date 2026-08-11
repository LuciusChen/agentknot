---
name: agentknot-delegate
description: Delegate bounded, independently verifiable repository work through the independent AgentKnot broker. Use whenever a repository implementation, repair, test, analysis, or documentation task needs more than one direct upstream action and has objective acceptance criteria, or for explicit $agentknot-delegate requests. Construct planning and a strict TaskAssessment upstream; never make a controller plugin own the runtime.
---

# AgentKnot bounded delegation

AgentKnot is controller-neutral middleware. The upstream controller owns intent, planning, decomposition, acceptance, and artifact promotion. AgentKnot owns deterministic validation, route selection, scheduling, isolation, lifecycle, and evidence. Never scan an AgentKnot checkout or create a local runtime to discover how to call it.

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

Use `recommendation: "do-not-delegate"` only with an empty `subtasks` array. Do not put routes, providers, models, controller transcripts, or promotion instructions in the assessment.

Use the common MCP boundary:

1. Call `agentknot_broker_status`. If it reports `stopped` or `unavailable` with `launchConfigured: true`, try `agentknot_broker_start` once, then read `agentknot_delegation_policy`. Startup may identity-safely clear a crash-stale discovery record; malformed or unidentified state still fails. If launch is unconfigured or startup fails, report the prerequisite and keep working upstream; do not substitute another runtime, worker, provider, or model.
2. For an eligible assessment, call `agentknot_orchestration_start` with the bounded parent prompt, exact repository workspace, controller source, and assessment. Use `delegation: inherit` for automatic policy and `force` only when the user explicitly requested this skill.
3. The admission result is durable but may still be queued. Call `agentknot_orchestration_follow` with the last acknowledged `afterSequence`; it waits for one committed event batch, terminal completion, or a bounded heartbeat and returns `nextSequence` for reconnect. Use non-blocking `agentknot_orchestration_status` only for an immediate snapshot. Do not repeatedly list or dump all jobs.
4. Review status, result action, child outcomes, completion evidence, artifact verification, quality review, and controller-owned artifact validation. Preview each valid non-empty patch once with `agentknot_artifact_preview`.
5. Never apply, stage, commit, push, merge, or deploy a downstream artifact automatically. The upstream controller decides whether to promote it and validates the integrated workspace once after applying an accepted patch.

If MCP is unavailable but the `agentknot` CLI is explicitly available, the transport-equivalent fallback is `agentknot client --json`, followed by `agentknot orchestrate --server <url> --source codex --workspace <root> --delegation <mode> --assessment-json <json> --handoff-json --progress --prompt <task>`. Never infer configuration from the target repository.

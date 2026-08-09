---
name: agentknot-delegate
description: Delegate bounded, independently verifiable implementation, test, analysis, repair, or documentation work through AgentKnot. Use for explicit /agentknot:agentknot-delegate requests or model-triggered delegation of eligible tasks. Keep informational chat, requirements and product decisions, artifact integration, commit, push, merge, and deployment upstream.
---

# AgentKnot bounded delegation

Use this skill only for a bounded, independently verifiable task that can be handed to AgentKnot without an upstream decision. Explicit invocation may request the workflow; model-triggered use is allowed only for eligible independent implementation, test, analysis, repair, or documentation work. Preserve the upstream controller as the decision-maker.

## Keep upstream

Do not delegate or automate:

- informational chat or explanation-only requests;
- requirements, scope, prioritization, or product decisions;
- artifact integration or promotion;
- commits, pushes, merges, or deployment.

Keep any task with unclear acceptance criteria, shared write scope, execution-order dependencies, or a needed approval upstream.

## Run the bounded delegation

Invoke this skill explicitly as `/agentknot:agentknot-delegate` with the bounded task, or allow model-triggered use only after the eligibility checks above.

1. Confirm that the task has a bounded file or component scope, acceptance criteria, and no dependency on another delegated task. Set `TASK` to the exact task text.
2. Resolve the workspace Git root and invoke the existing orchestration CLI with the Claude audit source:

   ```sh
   terminal_record="$(
     agentknot orchestrate \
       --source claude \
       --workspace "$(git rev-parse --show-toplevel)" \
       --delegation force \
       --json \
       --prompt "$TASK"
   )"
   ```

3. Consume `terminal_record` as the terminal JSON record. Parse and report its `status`, `result.action`, `error`, `children`, and `result.artifactReview`; a process exit code or worker prose alone is not a terminal record.
4. For each child `jobId`, list recorded artifacts and, when artifacts are present, verify and preview every recorded attempt:

   ```sh
   agentknot artifacts "$jobId" --json
   agentknot artifact-verify "$jobId" --json
   agentknot artifact-preview "$jobId" "$attempt" --json
   ```

   Inspect verification validity, issue codes, preview content, truncation, base evidence, and the parent artifact review. Treat missing, invalid, or incomplete evidence as upstream review input rather than acceptance.
5. Return the terminal record, artifact evidence, checks, and remaining risks to the upstream controller. Never apply a patch automatically; do not stage, commit, push, merge, deploy, or otherwise promote an artifact. Acceptance and any later repository mutation remain explicit upstream actions.

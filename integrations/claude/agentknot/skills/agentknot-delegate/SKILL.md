---
name: agentknot-delegate
description: Delegate bounded, independently verifiable implementation, test, analysis, repair, or documentation work through AgentKnot. Use whenever a repository task in those categories has objective acceptance criteria and requires more than one direct upstream read or action, including one substantive nonparallel task, or for explicit /agentknot:agentknot-delegate requests. Keep trivial one-read checks, informational chat, requirements and product decisions, artifact integration, commit, push, merge, and deployment upstream.
---

# AgentKnot bounded delegation

Use this skill for bounded, independently verifiable repository work that requires more than one direct upstream read or action and can be handed to AgentKnot without an upstream decision, including one substantive task with no useful parallel split. Keep a trivial one-read check upstream because planner, worker, and review overhead would cost more. Explicit invocation may request the workflow; model-triggered use applies to eligible independent implementation, test, analysis, repair, or documentation work. Preserve the upstream controller as the decision-maker.

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
2. In one shell call, confirm that the CLI exists and immediately run orchestration with the Claude audit source:

   ```sh
   if ! command -v agentknot >/dev/null; then
     echo "AgentKnot CLI must be installed and available on PATH." >&2
     exit 127
   fi
   agentknot orchestrate \
     --source claude \
     --workspace "$(git rev-parse --show-toplevel)" \
     --delegation force \
     --handoff-json \
     --prompt "$TASK"
   ```

   When `AGENTKNOT_SERVER_URL` is set, the CLI uses that shared AgentKnot execution owner. Do not scan the checkout for AgentKnot source, configuration, or storage in that mode, and do not launch another local runtime. If the shared server is unavailable, report the failure without falling back to a local runtime or another worker, provider, or model.

   If the preflight fails, stop before orchestration and report the prerequisite; do not substitute another command, worker, provider, or model.
3. Consume the compact terminal JSON handoff. Parse and report its `status`, `result.action`, `error`, `children`, `artifacts`, `result.artifactReview`, optional `qualityReview`, and optional controller-owned `artifactValidation`; a process exit code or worker prose alone is not a terminal record. The `artifacts` array already contains checksum, size, base, changed-file, validity, and issue evidence. Review and validation are advisory; a passed validation covers the exact recorded patch at its recorded base, not the later integrated workspace. Once this command returns a terminal status, do not poll processes, relist full records, or repeat artifact verification. Do not rerun a successful artifact-validation command before deciding on the patch.
4. Preview each valid non-empty artifact attempt once as plain patch content with `agentknot artifact-preview "$jobId" "$attempt"`. Treat unavailable, invalid, or incomplete evidence as upstream review input rather than acceptance.
5. Return the terminal handoff, any patch preview, review/validation evidence, and remaining risks to the upstream controller. Do not independently repeat the delegated repository work after successful terminal evidence. If the controller deliberately applies an accepted patch, validate that integrated workspace once because it is a different state from the disposable validation worktree. Never apply a patch automatically; do not stage, commit, push, merge, deploy, or otherwise promote an artifact. Acceptance and any later repository mutation remain explicit upstream actions.

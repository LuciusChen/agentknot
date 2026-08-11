---
name: agentknot-delegate
description: Delegate bounded, independently verifiable implementation, test, analysis, repair, or documentation work through AgentKnot. Use whenever a repository task in those categories has objective acceptance criteria and requires more than one direct upstream read or action, including one substantive nonparallel task, or for explicit /agentknot:agentknot-delegate requests. Construct the parent task and strict TaskAssessment upstream before invoking the CLI. Keep trivial one-read checks, informational chat, requirements and product decisions, artifact integration, commit, push, merge, and deployment upstream.
---

# AgentKnot bounded delegation

Use this skill for bounded, independently verifiable repository work that requires more than one direct upstream read or action and can execute without another upstream product decision, including one substantive task with no useful parallel split. Keep a trivial one-read check upstream because worker and review overhead would cost more. Explicit invocation may request the workflow; model-triggered use applies to eligible independent implementation, test, analysis, repair, or documentation work. The upstream controller owns intent, planning, decomposition, acceptance, and promotion decisions.

## Keep upstream

Do not delegate or automate:

- informational chat or explanation-only requests;
- requirements, scope, prioritization, or product decisions;
- artifact integration or promotion;
- commits, pushes, merges, or deployment.

Keep any task with unclear acceptance criteria, shared write scope, execution-order dependencies, or a needed approval upstream.

## Run the bounded delegation

Invoke this skill explicitly as `/agentknot:agentknot-delegate` with the bounded task, or allow implicit use after the eligibility checks above and the hook obligation. Do not send a raw user prompt as the task or ask AgentKnot to infer the assessment.

1. Confirm that the task has a bounded file or component scope, acceptance criteria, and no dependency on another delegated task. Construct `TASK` as the exact bounded parent task, including scope, non-goals, and acceptance criteria. Construct `ASSESSMENT` as one strict compact JSON object with exactly this schema:

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
         "title": "one bounded child task",
         "kind": "implementation",
         "prompt": "self-contained child instructions",
         "acceptanceCriteria": ["specific verifiable outcome"]
       }
     ]
   }
   ```

   Use `recommendation: "do-not-delegate"` only with an empty `subtasks` array. Use at most 20 task kinds, 20 subtasks, and 20 acceptance criteria per child, and keep every string bounded; do not add keys, routes, providers, models, or controller transcript content. Set `parallelizable` only when the proposed child tasks are independently verifiable and have no execution-order or write-scope dependency.
2. In one shell call, confirm the CLI, select one explicit execution owner, and run orchestration with the Claude audit source. The default path requires an available shared endpoint. Local configuration is allowed only when `AGENTKNOT_CONFIG` is explicitly set; never infer `agentknot.config.json` from the target repository.

   ```sh
   if ! command -v agentknot >/dev/null; then
     echo "AgentKnot CLI must be installed and available on PATH." >&2
     exit 127
   fi
   if [ "${AGENTKNOT_SERVER_URL+x}" = x ] && [ "${AGENTKNOT_CONFIG+x}" = x ]; then
     echo "AGENTKNOT_SERVER_URL and AGENTKNOT_CONFIG cannot be used together." >&2
     exit 2
   fi
   if [ "${AGENTKNOT_CONFIG+x}" = x ]; then
     if [ -z "$AGENTKNOT_CONFIG" ]; then
       echo "AGENTKNOT_CONFIG must not be empty." >&2
       exit 2
     fi
     set -- --config "$AGENTKNOT_CONFIG"
   else
     CLIENT_REPORT="$(agentknot client --json)" || exit $?
     SERVER_URL="$(printf '%s' "$CLIENT_REPORT" | node -e '
       let input = "";
       process.stdin.setEncoding("utf8");
       process.stdin.on("data", (chunk) => { input += chunk; });
       process.stdin.on("end", () => {
         try {
           const report = JSON.parse(input);
           if (report?.status !== "available" || typeof report.url !== "string" || report.url === "") {
             throw new Error(`client status is ${String(report?.status ?? "invalid")}`);
           }
           process.stdout.write(report.url);
         } catch (error) {
           process.stderr.write(`AgentKnot shared endpoint unavailable: ${error instanceof Error ? error.message : String(error)}\\n`);
           process.exitCode = 1;
         }
       });
     ')" || exit $?
     set -- --server "$SERVER_URL" --progress
   fi
   agentknot orchestrate "$@" \
      --source claude \
      --workspace "$(git rev-parse --show-toplevel)" \
      --delegation force \
      --assessment-json "$ASSESSMENT" \
      --handoff-json \
      --prompt "$TASK"
   ```

   `agentknot client --json` validates `AGENTKNOT_SERVER_URL` when it is set and otherwise uses local discovery. Only an `available` report supplies `SERVER_URL`; unconfigured, unavailable, malformed, empty, or conflicting selection is a bounded pre-admission failure. Report it and stop before orchestration. Do not scan the checkout for AgentKnot source, configuration, or storage, and do not fall back to another runtime, worker, route, provider, or model. Shared orchestration includes `--progress` so the controller sees durable phase and worker heartbeats.

   If the preflight fails, stop before orchestration and report the prerequisite; do not substitute another command, worker, provider, or model.
3. Consume the compact terminal JSON handoff. Parse and report its `status`, `result.action`, `error`, `children`, `artifacts`, `result.artifactReview`, optional `qualityReview`, and optional controller-owned `artifactValidation`; a process exit code or worker prose alone is not a terminal record. The `artifacts` array already contains checksum, size, base, changed-file, validity, and issue evidence. Review and validation are advisory; a passed validation covers the exact recorded patch at its recorded base, not the later integrated workspace. Once this command returns a terminal status, do not poll processes, relist full records, or repeat artifact verification. Do not rerun a successful artifact-validation command before deciding on the patch.
4. Preview each valid non-empty artifact attempt once as plain patch content with `agentknot artifact-preview "$jobId" "$attempt"`. Treat unavailable, invalid, or incomplete evidence as upstream review input rather than acceptance.
5. Return the terminal handoff, any patch preview, review/validation evidence, and remaining risks to the upstream controller. Do not independently repeat the delegated repository work after successful terminal evidence. If the controller deliberately applies an accepted patch, validate that integrated workspace once because it is a different state from the disposable validation worktree. Never apply a patch automatically; do not stage, commit, push, merge, deploy, or otherwise promote an artifact. Acceptance and any later repository mutation remain explicit upstream actions.

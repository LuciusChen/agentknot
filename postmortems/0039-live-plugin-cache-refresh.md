# 0039: Do not invalidate hook paths used by active controller sessions

- Type: Incident
- Status: Resolved
- Severity: Medium
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected integration: Codex plugin cache refresh from `0.1.0+codex.20260809133142` to `0.1.0+codex.20260810102659`
- Related: [decision 0027](./0027-controller-native-integration-boundary.md), [incident 0033](./0033-controller-timeout-phase-claim.md), [decision 0038](./0038-shared-local-controller-runtime.md)

## Summary

An active Codex session reported `UserPromptSubmit hook (failed): hook exited with code 1` immediately after the AgentKnot plugin was refreshed in another turn. The failure occurred before the AgentKnot hook script executed, so its bounded error context and exit-zero fallback could not run.

Codex had loaded the old versioned plugin root when the session started. `codex plugin add` installed the new cache version and removed the old version directory while the active process still referenced it through the plugin-root environment. The next hook launch therefore asked Node to open a script below a path that no longer existed.

## Evidence

- The running Codex processes predated the 10:28 plugin refresh.
- Only cache directory `0.1.0+codex.20260810102659` remained afterward; the previously installed version was absent.
- Codex emitted `hook/started` and `hook/completed` about 20 ms apart with exit code 1, while a direct invocation of the current hook with the documented plugin-root environment exited 0.
- The current Codex manual states that plugin hook commands receive `PLUGIN_ROOT` and the compatibility `CLAUDE_PLUGIN_ROOT`; the manifest variable was not an invented AgentKnot convention.
- Restoring the old cache path as a symlink to the new compatible package made an invocation through the exact old root exit 0.

## Immediate containment

The deleted cache path was recreated as a local compatibility symlink to the new installed version. No Codex process was killed and no user session was restarted. The symlink is an operational compatibility aid, not a repository or release artifact.

## Corrective rules

- Do not refresh or remove the installed Codex plugin cache while active controller sessions may still reference the current versioned root.
- Treat a plugin update as applying to a new Codex session. State this before update and verify the new session rather than hot-swapping underneath an old one.
- Development-time cache refreshes must preserve every root used by a known active session until that session exits, or defer the refresh.
- A hook exit before script entry is a controller/plugin-lifecycle failure, not an AgentKnot server, route, or model failure. Do not diagnose it from orchestration records.
- Controller tests must distinguish script-level bounded failures from launcher-level missing-path failures.

## Non-goals

This incident does not add a bundled CLI, a stable global hook dispatcher, automatic controller restart, or control over Codex's cache retention policy.

## Addenda

### 2026-08-10: reinstall still removes the active root

While deploying cachebuster `0.1.0+codex.20260810142849`, `codex plugin add agentknot@agentknot` again removed the previously installed directory `0.1.0+codex.20260810195625`. Existing compatibility links still ended at that now-missing name, and two live Codex processes remained. The missing path was detected before the next hook invocation and restored as an exact symlink to the newly validated package; resolution through the old root and the installed status message were then verified.

The operational rule is therefore stronger than “prefer preservation”: before reinstall, record every live or current installed root; immediately afterward, verify that each still resolves and recreate only the exact missing compatible names as links to the new package. Do not assume the Codex installer retains them.

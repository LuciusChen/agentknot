# 0027: Keep controller-native integrations thin and policy-neutral

- Type: Decision
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `d63c88d`
- Related: [decision 0001](./0001-vendor-neutral-control-plane.md), [decision 0004](./0004-bounded-automatic-delegation.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

Codex and Claude receive separate thin installable plugins that adapt controller-native Skill invocation to the existing `agentknot orchestrate` CLI. Explicit commands and normal description-based Skill matching are controller UX; `/goal` is one possible upstream goal surface, not a new AgentKnot protocol. Delegation, routing, lifecycle, evidence, and artifact policy remain in AgentKnot.

The initial slice deliberately adds no prompt hook, MCP server, wrapper daemon, or controller branch in `src`. It does not intercept every prompt and does not claim that informational conversation is automatically delegated.

## Context and evidence

The control plane already accepted controller-neutral `OrchestrationRequest` and `JobRequest` values, but use from Codex or Claude still depended on a user or repository prompt remembering to call the orchestration entry point. [Agent Workforce Relay](https://github.com/AgentWorkforce/relay) demonstrated a useful integration pattern: package controller-native Skills/plugins and lifecycle facilities around a shared runtime rather than teaching every project a long reminder prompt. Relay's communication network, channels, presence, hosted service, and fleet lifecycle remain outside AgentKnot.

The first implementation artifact was produced through orchestration `orchestration_60f44a2f-80ad-43b4-aa39-558d0a6ed232`, child `job_a1f935f5-3278-4829-a94d-411ab4ec6e66`, on the Pi/OpenCode Go/Luna/max route. Its patch was SHA-256 and base-commit valid. Upstream review corrected the Claude command to the required plugin namespace and reduced a nearly 200-line text-heavy test before integration.

Both final repository marketplaces installed successfully into isolated Codex and Claude configuration/cache directories without invoking a controller model. Codex and Claude native manifest validators and both Skill validators passed. Actual explicit and implicit controller-model invocation through a real AgentKnot terminal/artifact path remains required before Stage 2 promotion.

## Decision

- Keep one source-specific package per controller so audit `source` is explicit and host syntax is honest.
- Keep both Skill workflows semantically aligned and call the existing orchestration CLI rather than constructing another request schema.
- Allow implicit host Skill matching only for bounded independent implementation, test, analysis, repair, and documentation work. Preserve product/requirements decisions, informational chat, artifact integration, and repository promotion upstream.
- Use explicit `$agentknot-delegate` in Codex and `/agentknot:agentknot-delegate` in Claude. A native `/goal` may provide upstream continuity but does not replace or bypass the Skill/API boundary.
- Add hooks only if real usage proves that Skill matching cannot meet the Stage 2 entry contract. A hook must have a bounded lifecycle and must not dispatch every prompt silently.
- Add MCP only if structured tool invocation produces a demonstrated correctness, security, observability, or maintenance benefit over the existing CLI.
- Delete a controller-specific example, prompt reminder, compatibility shim, or duplicate request builder when a promoted package replaces it. No such earlier implementation existed in this slice.

## Alternatives considered

- **Put delegation reminders in `AGENTS.md` or every prompt:** rejected because it repeats policy and consumes upstream context without mechanical packaging.
- **Run a `UserPromptSubmit` hook for every prompt:** deferred because it would inspect or block ordinary conversation, create timeout/lifecycle questions, and invoke planning when no delegation is useful.
- **Add a controller-facing MCP server immediately:** deferred because the existing CLI already carries the complete request and evidence contract; another process and schema would be implementation inflation without current evidence.
- **Use one shared plugin directory for both hosts:** rejected for this slice because controller-specific explicit syntax and audit `source` would become implicit environment detection or a host branch in a shared script.
- **Copy Relay communication or fleet features:** rejected as outside the local execution-handoff thesis.

## Consequences and limits

- Installed controllers no longer need a per-task reminder to consider AgentKnot; their host can match the Skill description, while explicit invocation remains deterministic.
- Implicit Skill matching is still a controller-model judgment. It is not proof that every eligible prompt delegates, and ordinary chat is intentionally not intercepted.
- The two short Skill bodies repeat the source-specific edge workflow. A deterministic parity test bounds drift; a shared wrapper is not justified by this amount of text.
- The plugin packages assume an available `agentknot` executable and a target Git repository. Installation does not prove provider credentials, live inference, task success, or artifact acceptance.

## Corrective actions and gates

- [x] Put the complete controller-entry scope and cleanup rule in Stage 2 before implementation.
- [x] Add native Codex and Claude packages, marketplace manifests, validators, semantic-parity tests, and isolated install smoke evidence.
- [x] Keep the core unchanged and remove test-only implementation inflation during upstream artifact review.
- [ ] Run explicit and implicit real controller invocations for Codex and Claude through the same real AgentKnot terminal/artifact path before marking the controller exit gate complete.
- [ ] Add a hook or MCP boundary only after a recorded failure or measurable benefit proves the thin Skill/CLI adapter insufficient.

## Privacy and security review

Plugin Skills pass the user's task text to the local AgentKnot CLI and can cause the configured worker to receive it. They do not add a new network endpoint or credential store. Existing local record retention, worker process permissions, provider credentials, and artifact-content risks still apply. The install smoke used isolated temporary controller homes and no controller-model inference.

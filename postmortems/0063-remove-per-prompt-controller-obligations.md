# 0063: Remove per-prompt controller obligations

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Implementation: Delivered in this slice
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Related: [decision 0053](./0053-controller-owned-planning-handoff.md), [decision 0057](./0057-independent-broker-and-thin-controller-clients.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Context

The thin Codex and Claude packages retained one stateless `UserPromptSubmit` hook after runtime, workspace, discovery, and planning responsibilities had moved to the independent broker and upstream controller. The hook injected the complete `AGENTKNOT_CONTROLLER_OBLIGATION_V2` developer context on every ordinary prompt, including informational follow-ups and continued turns that already contained the same instruction.

The hook performed no process or repository work, but repeated hidden context was still observable in controller transcripts, distracted users with the phrase “not a Codex plugin runtime,” and consumed upstream input tokens every turn. The installed controller-native Skill already carries the complete handoff contract and the common MCP tools expose broker status, activation, policy, admission, and evidence.

## Decision

- Remove `UserPromptSubmit` hooks from both controller packages instead of replacing the obligation with a shorter repeated message.
- Keep the complete controller-owned planning, assessment, acceptance, and artifact-promotion contract in the identical `agentknot-delegate` Skills.
- Keep execution lifecycle behind the common `agentknot mcp` client. The Skill may explicitly activate one configured stopped broker through that boundary, but no plugin hook owns or starts a runtime.
- Codex retains implicit Skill invocation metadata and explicit `$agentknot-delegate`; Claude retains its native Skill entry. Controllers without implicit Skill selection require their native explicit invocation rather than a hidden prompt injector.
- Do not add session marker files, transcript parsing, repository heuristics, prompt classifiers, or controller-specific state to simulate once-per-session injection.

## Consequences

Ordinary prompts and resumed sessions receive no AgentKnot developer message, so the repeated token and user-interface cost is zero. The middleware boundary is clearer: controller capability discovery belongs to the controller's Skill system, and durable execution belongs to AgentKnot.

Automatic delegation still depends on the upstream controller selecting an applicable installed Skill and authoring a strict assessment. AgentKnot does not regain a semantic planner, and a controller that cannot invoke Skills implicitly must use its explicit Skill surface. This limitation is visible rather than hidden behind repeated prompt mutation.

Historical hook experiments remain evidence for the incidents they addressed but no longer describe the installed package surface.

## Verification

- Codex and Claude package roots contain no `hooks` directory.
- Both manifests still expose the same common `.mcp.json` client, and Codex still exposes its Skill directory.
- Controller Skills remain normalized-equivalent after controller source and explicit invocation are replaced.
- Codex implicit invocation metadata remains enabled.
- Plugin validation and the complete deterministic suite pass after cache refresh and reinstall.

## Alternatives rejected

- **Shorten the repeated obligation:** reduces but does not eliminate per-turn hidden context or token cost.
- **Inject once per session:** requires controller-specific durable markers or transcript inspection, recreating the session coupling removed by decision 0057.
- **Classify prompts in the hook:** moves semantic task selection toward the adapter and fails on context-dependent continuations.
- **Move planning into AgentKnot:** violates the controller-neutral middleware boundary established by decision 0053.

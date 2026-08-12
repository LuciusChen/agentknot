# 0074: Restore controller entry at session boundaries after an implicit-selection miss

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-12
- Owners: AgentKnot maintainers
- Affected versions/commits: Unreleased Codex and Claude controller packages
- Related: [decision 0053](./0053-controller-owned-planning-handoff.md), [decision 0057](./0057-independent-broker-and-thin-controller-clients.md), [decision 0063](./0063-remove-per-prompt-controller-obligations.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), and [ROADMAP](../docs/ROADMAP.md)

## Summary

A fresh Codex session had the installed `agentknot-delegate` Skill and Codex metadata permitting implicit invocation, but it performed a multi-action repository analysis directly instead of loading the Skill and authoring the AgentKnot assessment first. The observation shows that implicit Skill metadata permits selection but does not guarantee automatic invocation; it does not show a broker, policy, runtime, or artifact boundary failure.

The accepted correction adds one identical, stateless `SessionStart` hook to both controller packages for `startup`, `resume`, `clear`, and `compact`. The hook reads only bounded event JSON and emits one concise controller obligation. It performs no filesystem, Git, network, broker, policy, runtime, prompt, transcript, or session-state work. The per-prompt `UserPromptSubmit` hook remains absent.

## Context

Decision 0063 correctly removed the repeated `UserPromptSubmit` obligation because hidden context on every prompt consumed upstream input, appeared in ordinary conversation, and encouraged session coupling. It also preserved controller-owned planning, explicit Skill entry, the independent broker boundary, and the prohibition on transcript parsing, repository heuristics, session markers, and middleware planning.

After that removal, Codex's implicit-invocation metadata was the only package-level signal for automatic Skill selection. A metadata declaration can permit a controller feature without proving that a particular model turn will select it. The correction therefore restores a narrow session-entry reminder without restoring per-prompt mutation or moving semantic eligibility into AgentKnot.

## Expected invariant

The upstream controller owns intent, semantic eligibility, planning, decomposition, workspace selection, acceptance criteria, and artifact promotion. AgentKnot remains independent controller-neutral middleware that validates the strict handoff and owns deterministic admission, routing, scheduling, isolation, lifecycle, and evidence. A controller package may make that boundary visible at session entry, but it must not forward a raw prompt, inspect a transcript or repository, start or discover a broker, run policy, choose a route/model, wait for a worker, or apply an artifact.

A controller's deterministic session context is not semantic proof that a Skill was invoked or that delegation is eligible. The controller must still load the Skill when appropriate, author the strict assessment, and use the common MCP/CLI/HTTP/TypeScript boundary.

## Evidence and timeline

1. Decision 0063 removed the final per-prompt `UserPromptSubmit` obligation from both packages and recorded the deliberate no-hook conclusion for that former surface.
2. The installed Codex package retained `allow_implicit_invocation: true` for the `agentknot-delegate` Skill, which permits implicit selection but does not assert that selection will occur in every fresh session.
3. In a real fresh Codex session, the Skill was installed and available, but Codex performed multi-action repository analysis directly. No AgentKnot assessment or delegated artifact handoff was produced for that work.
4. The accepted package correction registers the same `SessionStart` matcher, `startup|resume|clear|compact`, in Codex and Claude. The command emits the same controller obligation for each supported source and emits nothing for malformed, unrelated, or unsupported input.
5. Deterministic integration coverage checks package parity, the four supported lifecycle sources, bounded event input, absence of prompt/transcript forwarding and runtime operations, and the absence of `UserPromptSubmit`, `PostToolUse`, and `SessionEnd` registrations.
6. Post-correction fresh Codex session `019ff4c8-f9f4-7d03-b69e-b8332db4cf60` received a repository-analysis prompt that did not mention AgentKnot, selected the Skill before repository inspection, authored a strict assessment, and admitted `orchestration_7b04b5ef-ca8d-499e-b95e-78b5d7cc22b1` through the existing broker. Its Pi/OpenCode Go/Luna/max child `job_57862e2e-9ef7-421b-b819-408536bf6635` completed with the required `taskOutcome: completed` report, two reported passing checks, an empty verified patch, and no source mutation. This closes the real Codex fresh-session gate for this bounded read-only shape, not a universal invocation guarantee or Claude parity claim.
7. The same run exposed two separate follow-ups without invalidating entry: the controller supplied stale `relevantPaths: ["packages"]`, which the worker reported before using the actual `integrations/` paths, and the controller issued repeated five-second follow calls while the durable child ran. Path precision remains a controller-handoff concern; detached terminal notification remains the existing ROADMAP item rather than part of this correction.

## Root cause or decision rationale

The root cause was treating a controller capability declaration as if it were an invocation guarantee. The missing behavior belonged at the controller integration's session-entry edge, not in AgentKnot's broker, policy, runtime, or worker adapter. A stateless lifecycle hook is the smallest boundary-owned correction: it provides one durable-in-context reminder after startup, resume, clear, and compact while avoiding prompt forwarding and state ownership.

The hook accepts only a bounded JSON event stream, checks the `SessionStart` event and supported source, and returns one bounded context object. It has no filesystem, Git, network, subprocess, broker, policy, prompt, transcript, or session-state dependency. The independent broker remains explicitly activated and discovered through common client tools, and planning remains upstream.

## Alternatives considered

- **Rely on implicit Skill metadata alone:** rejected by the fresh-session evidence; metadata permits selection but cannot guarantee model behavior.
- **Restore `UserPromptSubmit`:** rejected because it repeats hidden context on every prompt and recreates the cost and interface problem resolved by 0063.
- **Use session markers, transcript parsing, repository inference, or session state:** rejected because those approaches couple the package to controller/session persistence and would make the hook own context it cannot reliably validate.
- **Forward raw prompts or classify tasks in the hook:** rejected because semantic eligibility and planning belong to the upstream controller, not middleware.
- **Let the hook start the broker, run policy, or wait for a worker:** rejected because the independent broker and common MCP boundary must remain the execution owner.

## Consequences

The controller receives one identical obligation at each supported session lifecycle boundary instead of a repeated message on every user prompt. Clear and compact events receive the same boundary context as startup and resume. No prompt, transcript, repository, credential, broker, policy, runtime, or worker state is retained or forwarded by the hook.

The correction improves controller-entry visibility but does not guarantee implicit Skill invocation, delegation, model choice, completion, or artifact acceptance. Explicit Skill invocation remains the reliable fallback when a controller does not select the Skill implicitly. The controller still decides whether work is eligible and remains responsible for strict assessment authoring and explicit artifact review/promotion.

Decision 0063 remains authoritative for removing per-prompt `UserPromptSubmit` obligations and for rejecting stateful/session-coupled alternatives. This record supersedes only its relevant conclusion that the packages should contain no hook at all; it does not restore any of the removed state, planning, runtime, or raw-prompt behavior.

## What went well

- The fresh-session observation exposed a real distinction between metadata that permits implicit selection and an actual controller invocation.
- The existing Skill, MCP, assessment, broker, and artifact boundaries remain reusable without a core controller-vendor branch.
- The correction is identical across Codex and Claude and can be verified with bounded process input without provider calls or repository access.

## What did not go well

- Deterministic metadata and package parity were treated as stronger evidence than a real fresh-session controller turn.
- Removing the per-prompt obligation left no session-bound reminder for controllers that did not select the Skill implicitly.
- The old no-hook wording could be read as a prohibition on the narrow lifecycle edge required by the observed failure.

## Corrective actions and gates

- [x] Add identical stateless `SessionStart` registrations for `startup`, `resume`, `clear`, and `compact` to both controller packages.
- [x] Keep `UserPromptSubmit`, `PostToolUse`, and `SessionEnd` registrations absent; keep the hook free of filesystem, Git, network, broker, policy, runtime, prompt, transcript, and session-state work.
- [x] Keep controller-owned planning, independent broker/runtime ownership, controller neutrality, and explicit artifact review/promotion unchanged.
- [x] Run a post-correction fresh Codex repository task and verify that the controller selects the Skill, authors the strict assessment, admits through the independent broker, and leaves artifact acceptance upstream; do not use implicit metadata or SessionStart output alone as proof.
- [ ] Run Claude parity only after a real Claude plan is available; compare boundary behavior rather than assuming Codex behavior transfers.

## Deferred work

No hook may infer a workspace, inspect transcripts, forward raw prompts, classify arbitrary conversation, create session markers, start middleware, replan work, choose a route/model, or apply artifacts. Any future change to those boundaries requires a separate PRD/SPEC review and decision record.

## Privacy and security review

The hook reads only bounded event JSON supplied by the controller and emits bounded controller context. It does not read prompt text, transcript paths, files, Git state, credentials, broker records, configuration, network responses, or worker output. Event input and context remain controller-provided data rather than an authentication or security boundary; the local broker and callback limitations documented in the SPEC remain unchanged.

## Addenda

None.

# 0052: Bound repository analysis and make waiting observable

- Type: Incident / Decision
- Status: Resolved / Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected versions/commits: through `b7b58e77c5eefd5c3234bd49f75f38b73d1300bb`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [0051](./0051-evidence-producing-repository-analysis.md)

## Summary

Automatic controller entry showed one static hook status for several minutes while delegated repository analysis performed far more inspection than the upstream decision required. The remote HTTP client simultaneously fetched a growing full Job or Orchestration record every 100 ms. Worker choice changed event fidelity, but both Pi and native OpenCode exhibited the underlying scope and visibility problem.

Repository-analysis prompts now require an explicit execution workspace, references, exact scope, non-goals, at most five decision-relevant findings and 4,000 characters, concise evidence, and no inventory or source restatement. Remote waiting now uses an exact `/wait` endpoint: the middleware wakes the held request on terminal completion or returns a compact five-second heartbeat. CLI progress distinguishes connected activity from transport disconnection and reconnects only to the same durable ID.

## Expected invariant

- Delegated work should do only the evidence-producing work necessary for the upstream decision.
- Durable records remain authoritative; live progress is a bounded delivery convenience.
- Waiting, quiet execution, and transport loss must not be presented as the same state.
- Reconnection must never resubmit work or select a different route, worker, provider, or model.
- Controller-specific resume behavior remains outside controller-neutral core semantics.

## Evidence and timeline

- A prior Pi/Luna/max repository analysis spent 3 minutes 28 seconds in its worker, made 30 tool calls, and returned more than 19,000 output tokens despite a much smaller decision need.
- OpenCode/Luna/max Job `job_cdedf585-4f0b-450e-81cf-153e8647849d` ran from `14:04:32` to `14:10:34`: 68 persisted events, 59 tool events, four text events, and a 3,205-character result. The task completed, but the hook exposed only its static status while running.
- Concurrent Pi/Luna/max Job `job_28eb6e01-a7bb-4877-aba4-0465bbc953dc` ran from `14:02:05` to `14:11:56`: 510 persisted events, 497 tool events, two text events, and a 4,719-character result. Attempt one recorded `OpenAI Responses stream ended before a terminal response event`; the configured retry later succeeded. Pi emitted more detailed activity than OpenCode, but took longer and also broadened its inspection.
- `AgentKnotHttpClient.waitForJob()` and `waitForOrchestration()` looped every 100 ms and requested the complete mutable record. The controller model did not perform those requests, but its synchronous hook remained blocked behind that client behavior.
- Deterministic HTTP tests now prove remote Job and Orchestration waits use one `/wait` request for terminal completion and make zero exact full-record polling requests in that path.

## Root cause and decision rationale

Decision 0051 correctly made evidence-producing repository analysis delegatable, but eligibility was mistaken for an adequate execution boundary. Planner instructions did not require target/reference roles, non-goals, output size, or a decision-relevant delta. Workers therefore optimized for comprehensive repository understanding.

The HTTP client treated a durable record lookup as its live-notification protocol. This multiplied serialization and transfer work as event histories grew and provided no useful user-visible distinction between active work and transport failure. The controller hook compounded the problem by capturing CLI stderr until completion and advertising one vague static message.

The accepted correction stays narrow:

1. Tighten existing prompt contracts without adding a result schema or model-specific behavior.
2. Keep terminal completion authoritative in the active middleware and use compact heartbeats only for visibility.
3. Forward optional CLI progress through thin controller adapters, while retaining synchronous blocking.
4. Treat transport failures as disconnected, retry the same ID three times, and never create another execution.

## Alternatives considered

- **Only change the hook text:** rejected because it would not reduce work or distinguish real activity from connection loss.
- **Only prefer Pi over OpenCode:** rejected because both real workers over-expanded; downstream replaceability forbids a core runtime preference.
- **Continue full-record polling at a slower interval:** rejected because the payload still grows and carries output/events the waiting client does not need.
- **Add SSE or a general message bus immediately:** deferred because a fixed long-poll heartbeat and completion wakeup satisfy the observed local need with less protocol and lifecycle surface.
- **Detach every hook and resume controllers automatically:** deferred until a real controller adapter exposes a supported, idempotent resume entry. Unsupported controllers keep synchronous behavior.
- **Add a strict repository-analysis result schema:** deferred; the current problem can be corrected through prompt and deterministic composition contracts without another persisted payload.

## Consequences

- Normal remote waits issue at most one compact request per five-second heartbeat instead of ten full-record requests per second; terminal completion wakes the current request immediately.
- Users can inspect phase, route/child status, last activity, and activity age. A transport error is labeled `disconnected` before bounded same-ID retries.
- The host hook title remains static. Detailed lines are forwarded to the expandable hook execution record; no portable dynamic title or controller-resume claim is made.
- Repository-analysis reports are smaller by contract, but real A/B evidence is still required before claiming a measured token or latency reduction.
- A five-second heartbeat is delivery state, not a durable event and not proof that a model is making semantic progress.

## Corrective actions and gates

- [x] Maintainers — add workspace/reference/scope/non-goal and five-finding/4,000-character planner guidance — deterministic prompt assertions.
- [x] Maintainers — repeat the repository-analysis boundary in generated worker execution prompts — deterministic plan assertions.
- [x] Maintainers — add Job and Orchestration `/wait` endpoints with terminal wakeup, compact heartbeats, and explicit inactive conflict — HTTP contract tests.
- [x] Maintainers — replace 100 ms full-record client polling with bounded same-ID wait/reconnect — remote CLI integration tests.
- [x] Maintainers — add `--progress`, forward hook stderr, and use a more informative static status message — Codex/Claude parity tests.
- [x] Maintainers — repeat the same repository-analysis task after deployment and compare elapsed time, tool events, output characters, and downstream tokens without treating different planner route selection as a pure model A/B — Stage 2 evidence recorded below.
- [ ] Controller adapter owners — implement detached resume only after one supported controller API proves idempotent terminal-before-listener, reconnect, duplicate-notification, cancellation, and restart behavior — Stage 2/3 gate.

## Privacy and security review

This record retains only AgentKnot-generated IDs, route names, aggregate counts, timestamps, and one provider protocol error. User prompt text, repository content, credentials, worker outputs, and artifact bytes are omitted. Compact heartbeats likewise omit prompt, output, tool arguments/results, policy, metadata, and artifact content.

## Addenda

### 2026-08-10: first bounded same-task run

After deployment, orchestration `orchestration_87804a2c-dcc3-4b19-8070-d4a8a1a2a6bd` repeated the earlier repository-analysis task. The new plan explicitly named the AgentKnot execution workspace, the read-only guidelines reference, exact files, non-goals, and the five-finding/4,000-character boundary. Its one Pi/Luna/max child `job_1db38b32-6a59-447c-a153-4a59a2012488` returned four findings.

Compared with the earlier same-task Pi/Luna/max child `job_c8a6baca-7a69-4857-b0ed-27a0435bc6c3`, worker duration fell from 208 to 116 seconds (44.2%), tool calls from 30 to 16 (46.7%), reported total tokens from 547,773 to 143,658 (73.8%), and retained result characters from 9,378 to 1,502 (84.0%). Total orchestration duration fell from 220 to 167 seconds (24.1%). The new planner took 51 seconds through Pi/Luna versus 12 seconds through OpenCode/Luna in the earlier run, so planner-route and current-source differences prevent a pure end-to-end A/B claim. This is one positive boundary result, not a universal latency, token, quality, runtime, or model ranking claim.

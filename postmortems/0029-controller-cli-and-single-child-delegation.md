# 0029: Make the controller CLI prerequisite and single-child delegation explicit

- Type: Incident and decision
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `65416ba`
- Related: [decision 0004](./0004-bounded-automatic-delegation.md), [decision 0020](./0020-human-authored-active-route-selection.md), [decision 0027](./0027-controller-native-integration-boundary.md)

## Summary

Two assumptions prevented the experimental controller path from reliably reducing upstream work. Installing the Codex and Claude plugins did not install the `agentknot` executable they call, and the planner prompt treated a lack of useful parallel splitting as evidence that a bounded task should remain upstream. The CLI is now an explicit checked prerequisite, while delegation and parallelism are separate planner decisions: one eligible task may be one non-parallel child.

## Evidence

The installed controller plugins were enabled, but `command -v agentknot` initially failed. Installing the repository package under the user's local npm prefix exposed the existing package `bin` without adding a wrapper, daemon, MCP server, or controller branch.

A real Luna/max planner assessment for one bounded read-only test-gap review returned `do-not-delegate` solely because the work was not usefully splittable. The runtime and deterministic composer already supported one child with effective concurrency one. A direct low-complexity correction job, `job_28d35db4-c819-4ba6-a092-5ed380bbe3b3`, then ran through Pi/OpenCode Go/DeepSeek V4 Flash/max and produced a SHA-256/base-valid two-file patch; upstream review accepted it after the worker reported 155 passing tests.

Three fresh Codex implicit-entry probes bypassed the installed Skill and read the bounded target directly, consuming 32,384, 32,430, and 31,903 upstream input tokens. The first two used the cached original Skill; the third used a cache-busted plugin whose description already required invocation for the exact task. Description matching alone was therefore insufficient evidence for automatic entry.

The first hook-triggered probe successfully reached orchestration `orchestration_b90727f2-0274-473f-9b16-bca820ab9a1e`: Luna/max classified the task as low and non-parallel, and one child `job_0e8ba4e7-9e35-4f5e-9000-b6c399dd42e5` succeeded on DeepSeek Flash/max. The controller nevertheless consumed 255,002 input tokens because full orchestration events, prompts, policy, repeated child output, full record relisting, and redundant artifact JSON entered its context. Automatic dispatch without a compact return path amplified rather than reduced upstream use.

## Decision

- Controller Skills require the existing `agentknot` CLI on `PATH` and stop clearly when it is absent. They do not substitute another route or silently fall back.
- Planner guidance must not equate delegation with parallelism. A single bounded substantive task may be one non-parallel child. Objectively trivial direct work may remain upstream when planner/worker/review overhead costs more; an empty subtask list is otherwise reserved for work that must remain upstream or cannot be bounded.
- Controller Skill descriptions must make eligible bounded repository work an unambiguous trigger rather than optional guidance; exclusions remain explicit so ordinary conversation and upstream decisions do not dispatch.
- Each controller package may add one static `UserPromptSubmit` context hook that tells the host to invoke the Skill when its description matches. It must not read the submitted prompt, own an eligibility classifier, run AgentKnot, block the turn, or duplicate routing and product policy.
- The CLI owns one compact terminal handoff projection. It does not change persistence or replace the full record; it removes verbose and duplicated control-plane fields from controller context while retaining decision, route, child, error, output, artifact-review, and compact artifact-verification evidence.
- Controller Skills consume that projection, combine CLI preflight and orchestration in one shell call, never poll or relist full terminal records after settlement, preview only valid non-empty patch content, and do not repeat successful delegated repository work independently.
- Existing deterministic route policy remains authoritative: repository-assessed `low` children select DeepSeek Flash/max, while Luna/max remains planner and medium/high/default worker.
- Do not add a bundled CLI copy, hook, MCP server, wrapper, daemon, learned router, or second request schema for this correction.

## Corrective actions and gates

- [x] Install and verify the existing CLI through the user's local npm prefix.
- [x] Add the Skill prerequisite and parity/package-bin tests.
- [x] Correct the planner contract and add deterministic single-child active-route coverage.
- [x] Record three failed implicit Codex probes, then add the smallest non-dispatching prompt hook with controller-parity tests.
- [x] Prove a prompt-hook-triggered Codex invocation reaches a real terminal orchestration and the configured low-complexity DeepSeek Flash/max child route without a per-prompt delegation reminder.
- [x] Repeat the same trivial probe through compact handoff: input fell from 255,002 to 85,657 tokens, but remained above the roughly 32k direct path and the planner retained it upstream. Record trivial one-read work as ineligible rather than optimizing it into a worse delegation.
- [ ] Run one substantive same-task direct-versus-automatic pair and require lower upstream input use without weakening terminal or artifact evidence before claiming token savings.

## Consequences

The hook adds one short developer-context instruction to every submitted prompt after native trust approval because `UserPromptSubmit` has no category matcher. This bounded overhead is explicit and does not guarantee that a controller model will comply. The change also does not claim learned model intelligence, automatic fallback, or upstream-token savings until controller end-to-end runs provide measured evidence.

## Addenda

### 2026-08-09: Host-model selection did not reduce upstream use

The open gate above was run on one fixed five-file read-only audit. Direct Codex used 155,851 input tokens. Hook-triggered implicit Skill loading used 178,071, and replacing the Skill-loading round with a compact static workflow still used 249,154 because Codex repeated the delegated repository reads. Both automatic variants found the same specification mismatch and deterministic-test gap, but neither reduced upstream work.

Decision [0030](./0030-pre-model-controller-dispatch.md) supersedes only this record's static non-dispatching-hook boundary. The CLI prerequisite, single-child delegation rule, compact handoff, artifact restrictions, and configured Luna/DeepSeek routing decisions remain accepted.

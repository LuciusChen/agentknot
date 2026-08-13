# 0085: Recover missing completion evidence in the live worker session

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Date: 2026-08-13
- Owners: AgentKnot maintainers
- Related: [required completion 0044](./0044-required-worker-completion-and-canonical-worktree-id.md), [settled retry ownership 0084](./0084-worker-settled-retry-ownership.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Incident

A bounded roadmap audit completed its substantive work but its first Pi turn omitted the required completion envelope. Job `job_e8ee7d60-feed-43bd-9898-29e039b74621` under orchestration `orchestration_56a8c2ee-bdb9-46fb-b8b5-151c3a184965` ran attempt one for about 44 seconds, recorded `Pi output is missing required completion report`, and started the entire task again. Attempt two succeeded about 35 seconds later. Both attempts retained verified empty artifacts.

This behavior correctly prevented a false success, but it discarded live worker context and duplicated completed inspection. Only the terminal attempt retained 43,901 provider-reported tokens; attempt-one usage was unavailable, so the persisted usage report could not quantify the total waste. Decision 0084 did not apply because the missing envelope was still thrown as an ordinary adapter error rather than a settled-worker terminal condition.

## False start caught during artifact review

The delegated implementation artifact initially used Pi RPC `follow_up` and a fake fixture that started a new turn for that command. Inspection of the installed Pi RPC and agent-core implementation showed that `follow_up` only queues input; once the agent is idle it does not start a run. Pi `prompt` is the supported idle-session continuation. The controller therefore rejected that protocol assumption, changed the implementation and fixture to require a second `prompt`, and reran the repository suite. This is why downstream patches remain evidence rather than promotion authority.

The first forced real recovery then exposed a second fixture assumption: the fake second turn supplied a leading newline, while real Pi began its new assistant text directly with the marker. Concatenating turn text without a boundary produced an invalid `FIRST_TURN_WITHOUT_ENVELOPEAGENTKNOT...` suffix. The adapter now inserts one newline only when the retained first-turn output is non-empty and lacks one; the fixture deliberately emits no leading newline so the regression stays covered.

That failed live validation was orchestration `orchestration_67c8b42c-10b1-4530-9fa8-055238afd066`, Job `job_9335a760-03e8-44f6-a853-bd41ec0f8489`. It also proved the exhaustion half of the contract on a real route: one verified empty artifact, attempt one, `WorkerSettledError`, and no whole-Job replay.

## Decision

- After a normal Pi turn reaches `agent_settled` without an assistant error, the adapter parses the required completion suffix.
- If the suffix is missing, malformed, unsupported, or non-terminal, the adapter sends exactly one concise protocol-only `prompt` through the same live Pi process/session and awaits its next settlement.
- External live control is rejected while this recovery is active. The recovery prompt requests no tools or repeated task work; it is not controller planning or a repair loop.
- A valid second-turn suffix returns the original result and report on the same Job attempt. Session statistics are requested only after recovery, so an available terminal statistic covers the retained session.
- A second invalid settlement throws `WorkerSettledError`. The Job terminates at its current attempt without `job.retrying` or a new worker process.
- Assistant terminal errors bypass envelope recovery. Process, transport, malformed JSONL, timeout, and cancellation failures before the first settlement retain their existing ownership and retry behavior.
- Normalized `worker.retry.started/completed` events use route-neutral scope `completion-envelope`, attempt/max `1/1`, success, and a generic exhaustion reason. They never persist the recovery prompt or raw worker/provider text.
- Custom adapters remain optional-report compatible. No provider, model, route, controller, or task-kind branch is added.

## Verification

- A deterministic missing-first-envelope fixture succeeds after one second prompt with exactly one child PID, Job attempt one, one valid completion report, and no `job.retrying` event.
- A second-invalid-envelope fixture fails with `WorkerSettledError`, one PID, attempt one, one recovery prompt, and no whole-Job retry.
- A settled assistant-error fixture sends no recovery prompt.
- Existing exit-before-first-settlement coverage still starts a second child and succeeds on attempt two.
- Persisted recovery events contain neither the task prompt, recovery prompt, nor fixture-private output. Compact activity validates both downstream and completion-envelope scopes.
- Forced real validation `orchestration_ed1a2240-f92c-4533-8350-52a7a6e3d7bf` / `job_b4ff37ac-4125-4c03-b9e4-7c50e525f669` deliberately omitted the first envelope and then supplied it after recovery. It succeeded at Job attempt one with one verified empty artifact, no `job.retrying`, reported completion evidence, two user and two assistant messages, zero tool calls, 9,415 provider-reported session tokens, and cost 0.0003108672.
- The integrated repository suite passes 310/310 and `git diff --check` passes.

## Consequences

The change removes one known source of duplicated task execution without weakening completion evidence. It does not guarantee that a model will produce a valid envelope, enforce the recovery prompt's no-tool request, manufacture downstream capacity, or prove token savings. The forced real recovery establishes protocol behavior but has no replay baseline; a naturally occurring recovery remains useful operational evidence. The then-open per-attempt usage gap is resolved by [decision 0086](./0086-per-attempt-usage-evidence.md); historical attempts without retained statistics remain unrecoverable.

# AgentKnot postmortems and decision records

This directory preserves why the project chose a direction, what evidence changed it, what failed, and which limitations were deliberately deferred. Current truth belongs in README, PRD, SPEC, ROADMAP, code, and tests; these records preserve history so later work does not unknowingly repeat or reverse a decision.

"Postmortem" here covers three record types:

- **Incident**: an invariant was violated or users were affected.
- **Decision**: a non-obvious architectural or product tradeoff established a lasting boundary.
- **Experiment**: an approach was tried, abandoned, or kept behind a gate because evidence was insufficient.

## When a record is required

Write a postmortem when any of these occurs:

- source workspace mutation in `git-worktree` mode;
- missing, corrupt, wrongly based, wrongly hashed, or automatically applied artifacts;
- leaked managed worktrees, worker processes, child processes, timers, or credentials;
- impossible job state, stale active execution, event gaps/duplicates/reordering, or live delivery before persistence;
- retry contamination across attempts or execution from the wrong base commit;
- cancellation or timeout contradicting the documented terminal result;
- callback side effects or observer failures changing execution correctness;
- credentials entering records, events, logs, callbacks, or artifact metadata;
- controller identity changing routing or core behavior;
- an advertised capability that the implementation does not support;
- a significant architectural boundary, external integration, dependency, or default changes;
- an implementation is reverted, abandoned, or deferred after meaningful work;
- a proposal would broaden AgentKnot into collaboration, fleet, cloud, auto-merge, or another explicit non-goal.

Small local refactors and obvious bug fixes do not need a record unless they reveal a reusable failure mode.

## Record rules

- Use `NNNN-short-kebab-title.md`; numbers never change or get reused.
- Mark the type, status, date, affected versions/commits, and related documents near the top.
- Separate observed facts from interpretation and proposed follow-up.
- Include enough evidence or a minimal reproduction for another contributor to verify the conclusion.
- Name the violated or established PRD/SPEC invariant.
- Link the regression test or roadmap gate added because of the finding.
- Do not rewrite old records to match a later opinion. Add a clearly dated addendum or a new record that supersedes the old one.
- Remove secrets and unnecessarily sensitive prompt/repository content before committing a record.
- Update current docs separately; a postmortem is history, not the active specification.

## Template

```markdown
# NNNN: Short title

- Type: Incident | Decision | Experiment
- Status: Draft | Accepted | Resolved | Superseded
- Date: YYYY-MM-DD
- Owners: names or roles
- Affected versions/commits: identifiers
- Related: PRD/SPEC/ROADMAP/issues/records

## Summary

What happened or what was decided, in a few sentences.

## Context

What goal, system state, and constraints existed beforehand.

## Expected invariant

The PRD/SPEC rule or user expectation involved.

## Evidence and timeline

Observed facts, timestamps for incidents, job IDs/attempts/event sequences,
environment, isolation mode, routes, artifacts/hashes, and reproduction steps.

## Root cause or decision rationale

Why it happened or why this option best fits the constraints.

## Alternatives considered

Options considered, their advantages, and why they were rejected or deferred.

## Consequences

Positive outcomes, costs, new risks, and compatibility effects.

## What went well

Detection, containment, tests, or design properties that helped.

## What did not go well

Gaps, misleading assumptions, delayed detection, or unnecessary work.

## Corrective actions and gates

- [ ] Owner — concrete change — verification — roadmap gate

## Deferred work

Limitations intentionally left unresolved and the condition that should reopen them.

## Privacy and security review

What sensitive data was involved and how the record was redacted.

## Addenda

Dated updates without rewriting the original conclusion.
```

Incident records should also include severity, user/controller impact, immediate containment, and the exact terminal state. Decision records may replace the incident timeline with a compact evidence chronology, but must still include alternatives and consequences.

## Index

| ID | Type | Status | Title |
| --- | --- | --- | --- |
| [0001](./0001-vendor-neutral-control-plane.md) | Decision | Accepted | Separate controller, worker, and provider/model routing |
| [0002](./0002-git-worktree-artifact-handoff.md) | Decision | Accepted | Use Git worktrees and patch artifacts for handoff |
| [0003](./0003-skill-minimal-pi-workers.md) | Decision | Accepted | Keep background Pi workers skill-minimal by default |
| [0004](./0004-bounded-automatic-delegation.md) | Decision | Accepted | Put bounded automatic delegation in the control plane |
| [0005](./0005-concurrent-job-event-persistence.md) | Incident | Resolved | Serialize concurrent job event persistence |

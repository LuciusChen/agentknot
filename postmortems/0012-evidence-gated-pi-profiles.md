# 0012: Promote isolated Pi profiles only on measured dogfood benefit

- Type: Decision
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased
- Related: [decision 0003](./0003-skill-minimal-pi-workers.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

Community Pi extensions are not merely recommendations, but they are not trusted defaults either. AgentKnot will evaluate a reviewed, exactly pinned extension in an isolated explicit worker profile against the minimal Pi route on the same real development task. A profile enters actual dogfood dispatch only when repeated evidence shows a net improvement without reducing completion, artifact, or test quality.

## Context

Self-hosting should reduce the upstream controller's intervention and token burden, not just move work downstream. Ambient global or repository-local Pi packages make results irreproducible and can add unrelated instructions, executable code, storage, credentials, or orchestration behavior. Conversely, permanently refusing useful extensions would discard a practical way to improve the worker.

The minimal route now suppresses ambient extension, skill, prompt-template, and theme discovery and records sanitized Pi session statistics. This creates the control and telemetry needed for real comparison.

## Expected invariant

- Controller, worker, provider, model, and extension choice remain separate and auditable.
- The exact Luna dogfood route remains OpenCode Go, `gpt-5.6-luna`, and `thinkingLevel: "max"` during a profile comparison.
- No extension can silently install itself into AgentKnot, global Pi state, or the target repository.
- Product decisions, artifact application, commit, push, merge, and deployment remain upstream.

## Decision rationale

The default profile is minimal: ambient Pi resources are disabled and repository context remains enabled. A candidate profile may add only explicit, reviewed resources named by exact package version or immutable external path. Trials use disposable/external package state rather than `pi install` or repository-local installation.

Each A/B pair uses the same accepted real task, base commit, route, thinking level, acceptance checks, and retry budget. Primary gates are terminal completion, a valid patch artifact when changes are expected, and passing target tests. Secondary evidence includes Pi session token/context statistics, elapsed time, retries, and recorded upstream interventions. A recommendation, popularity count, single lucky run, or token reduction accompanied by worse correctness is insufficient.

Promotion creates an explicit separately named worker/profile and keeps a one-step return to the minimal route. Planner output cannot select arbitrary packages or change routes. Extensions that duplicate AgentKnot's orchestration, recursively spawn agents, persist cross-job memory by default, auto-commit, push, merge, deploy, or broaden provider/model fallback are ineligible for the dogfood profile.

## Alternatives considered

### Install a popular package globally

This is easy but contaminates every Pi session, hides the effective dependency set, and weakens reproduction and rollback. Rejected.

### Keep extensions as documentation-only recommendations

This avoids risk but cannot improve real completion rate or upstream efficiency. Rejected; reviewed candidates must be tested in actual AgentKnot work before promotion.

### Enable a candidate immediately for all dogfood jobs

This gathers experience quickly but lacks a clean control, can regress correctness, and makes failures harder to attribute. Rejected.

### Let the planner choose packages dynamically

This would mix product planning with executable supply-chain selection and make route evidence non-deterministic. Rejected.

## Consequences

Positive consequences are measurable self-hosting improvements, reproducible worker behavior, explicit rollback, and preserved Pi replaceability. Costs are duplicated A/B work, source review, exact-version maintenance, and the possibility that no candidate earns promotion. Session statistics measure the Pi worker, not the upstream controller directly, so upstream intervention and token use require separate controller-side evidence.

## Corrective actions and gates

- [x] Disable ambient Pi extensions, skills, prompt templates, and themes while retaining repository context.
- [x] Capture sanitized advisory Pi session statistics after successful normal jobs.
- [x] Review and pin candidate extensions without persistent installation — `pi-readseek@0.9.10` and `pi-lean-ctx@3.9.18`; see experiments 0013 and 0014.
- [x] Run one same-task Luna/max A/B pair for each candidate and record completion, artifact, tests, retries, elapsed time, session statistics, and upstream intervention.
- [x] Repeat the promising lean profile on an independent real workload before promotion; the smaller task regressed token use, elapsed time, tool calls, raw events, and final context despite a smaller selected artifact.
- [x] Apply the formal promotion gate: no candidate cleared repeatable net benefit, so retain the minimal route and record the result in experiment 0014.

## Deferred work

Automatic profile selection, a general extension registry, cross-model comparison, and upstream-controller token telemetry remain outside this decision. They require independent contracts and must not be inferred from Pi session statistics.

## Privacy and security review

Package source and manifests must be reviewed before execution because Pi extensions run with the worker process's host authority. Persisted statistics are allowlisted and exclude session paths, identifiers, raw responses, and provider error text. This isolation is reproducibility and capability hygiene, not an operating-system sandbox.

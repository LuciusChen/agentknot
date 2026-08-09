# AgentKnot product requirements

- Status: Living product contract
- Version: 0.1
- Last updated: 2026-08-09

## Product thesis

AgentKnot is a small, local-first, vendor-neutral execution control plane for deciding when a goal should be split and for delegating bounded coding jobs from interchangeable controllers to interchangeable agent workers and model routes.

Its job is to admit work, apply a bounded delegation policy, persist the plan and lifecycle evidence, invoke workers, and hand back results and artifacts. It does not own the worker's intelligence, the provider's model runtime, or a collaboration network.

```text
controller -> Orchestration API -> planner assessment -> deterministic policy
                         |                         |
                         +-> upstream/suggestion  +-> bounded child Job APIs
controller ---------------------------> Job API -> worker -> provider/model
                                                    |
                                                    +-> evidence/artifacts
```

## Problem

Coding-agent workflows are often coupled at several layers at once: the controller, coding harness, model provider, model, workspace mutation policy, and result transport. Replacing Codex with Claude, Pi with another worker, or OpenCode Go with xAI can then require redesigning the entire workflow.

Directly invoking a worker also leaves recurring control-plane concerns to every caller: route configuration, job state, cancellation, retries, event normalization, workspace protection, artifact capture, and audit history.

Relying on a controller prompt to remember when to delegate creates another coupling: every controller and every target repository must reproduce the same judgment, limits, and evidence rules. AgentKnot therefore needs a shared orchestration entry point whose planner is advisory and whose dispatch decision is deterministic configuration.

AgentKnot provides one narrow contract for those concerns while keeping every execution choice explicit and replaceable.

## Primary users

The initial user is a developer or small engineering team that:

- discusses or approves work in one controller, such as Codex or Claude;
- wants a different coding worker or model to execute some bounded tasks;
- needs to change controllers, workers, providers, or models without rewriting the workflow;
- wants durable evidence of what ran and a reviewable patch instead of an implicit source-tree mutation;
- prefers a local service and local credentials over a mandatory hosted control plane.

Multi-tenant platform operators and large remote agent fleets are not initial users.

## Jobs to be done

1. Submit the same coding task from a CLI, HTTP client, TypeScript program, CI job, Codex, or Claude.
2. Choose the worker, provider, and model through a route rather than controller-specific code.
3. Observe a normalized job lifecycle without understanding the worker's private protocol.
4. Cancel or retry a bounded attempt according to an explicit policy.
5. Keep the supplied Git workspace unchanged while receiving a verifiable patch artifact.
6. Inspect enough evidence to decide whether a result should be accepted, revised, or discarded.
7. Diagnose why a job failed without exposing provider credentials.
8. Submit one goal and have the same policy decide whether to keep it upstream, suggest a split, or dispatch bounded child jobs regardless of controller vendor.

## Product principles

### Controller neutrality

`source` records who submitted a job. It must not select a code path. Codex, Claude, CI, and custom callers use the same Job API.

### Explicit routing

A route resolves worker, provider, model, timeout, and retry settings before execution. Existing jobs retain that resolved snapshot even if configuration changes later.

### Records first, live signals second

The durable job record and its ordered events are the authority. Streaming, callbacks, dashboards, or notifications are delivery conveniences and must not become the only copy of state.

### Honest capabilities

AgentKnot only advertises behavior that is implemented and verified. Proposed adapters, recovery, streaming, security, or sandbox features remain marked as proposed until their acceptance gates pass.

### Evidence-bearing completion

A terminal job must carry a result or an explicit error, its resolved route and attempts, and any produced artifacts. "The agent said it finished" is not sufficient evidence for artifact promotion. A new terminal Job also carries an additive schemaVersion 1 completion summary: controller-captured changed paths are tied to the terminal artifact when available, while worker claims, checks, risks, and notes remain explicitly reported evidence rather than semantic verification.

### Safe handoff by default

In Git worktree mode, attempts run away from the caller's working tree and return patch artifacts. AgentKnot never applies, commits, merges, or pushes those patches automatically.

### Minimal core, replaceable edges

Worker-specific process and protocol behavior belongs in worker adapters. Orchestration policy belongs in the core. Features that do not strengthen the execution handoff should remain outside the core.

### Bounded automation

Automatic delegation must be explicit at the API boundary, depth-limited, concurrency-limited, isolated, and recorded before execution. It must never imply automatic artifact integration, product decisions, commits, or pushes.

## Current product scope

Version 0.0.1 currently implements:

- controller-neutral CLI, HTTP, and TypeScript entry points;
- immutable resolved route snapshots with worker, provider, and model dimensions;
- deterministic mock and Pi RPC worker adapters;
- OpenCode Go/Luna and xAI/Grok routes through Pi configuration;
- file-backed or in-memory job snapshots and ordered events;
- top-level `schemaVersion: 1` on new leaf Job and Orchestration records, with schema-less legacy-v1 file reads materialized in memory without rewriting and unsupported explicit versions rejected;
- immediate execution with cooperative timeouts, retries, and cancellation, plus bounded exact-child supervision in the bundled Pi adapter;
- reproducible Pi execution that disables ambient extension, skill, prompt-template, and theme discovery while preserving repository instructions and explicitly configured resources;
- sanitized per-job Pi session statistics for measuring message/tool counts, token use, cost, and context use without retaining session paths, identifiers, or raw responses;
- one-shot completion callbacks to trusted URLs;
- direct-workspace compatibility mode and Git worktree attempt isolation;
- per-attempt Git patch artifacts with base commit, size, and SHA-256;
- read-only artifact listing, integrity/base verification, and bounded patch preview through TypeScript, CLI, and HTTP;
- additive schemaVersion 1 terminal Job completion summaries with terminal outcome/attempt, controller-captured artifact path provenance, and explicit unavailable states; strict worker completion reports are accepted from custom adapters, while the bundled Pi adapter does not yet emit them;
- configuration validation and explicit configuration-only and opt-in live route diagnostics;
- canonical HTTP process liveness that explicitly reports storage, routes, and inference as not checked, without claiming route readiness.
- controller-neutral orchestration through CLI, HTTP, and TypeScript;
- `off`, `suggest`, and `auto` modes with per-request narrowing;
- strict planner assessments followed by deterministic task-kind policy;
- immutable effective policy, plan hash, exact child prompts, routes, parent/child provenance, and ordered orchestration events;
- bounded depth-one delegation with product defaults of `maxChildren: 2` and `maxConcurrency: 2` when those values are omitted, an explicit repository dogfood pool of six tasks with four active slots, and a configuration ceiling of six for each with concurrency never exceeding the child count;
- fail-without-resume startup reconciliation for stale jobs and orchestration records.

Route diagnostics have two explicit modes. The default `doctor` command is a fast configuration, credential, and runtime check and must say that live inference was not checked. The opt-in `doctor --live` path performs one bounded real inference through the exact selected worker, provider, model, and thinking level; its 30-second control-plane timer triggers cooperative abort, and a supported adapter must settle after abort and clean up its resources. It reports provider errors with failure status and unsupported adapters honestly, does not fall back or select another route, does not create Job or artifact records, and does not add a probe before normal jobs or orchestrations.

The current file stores provide persistent audit snapshots. Execution-owning runtimes deterministically mark stale nonterminal jobs or orchestrations failed on startup when their recorded process is absent; read-oriented CLI runtimes do not perform this recovery. The stores do not provide resumable execution, a restartable queue, journaling, multi-process coordination, PID-reuse protection, or automatic cleanup of worktrees left by a hard process crash.

Provider and model independence are currently routing properties implemented by the selected worker. AgentKnot does not yet expose an independent provider-runtime interface.

Pi extensions are optional worker-profile inputs, not portable core dependencies. A community package can enter the repository dogfood route only after source/supply-chain review and repeated same-task comparison against the minimal Pi route show no regression in terminal completion, artifact validity, or tests and a measurable improvement in upstream intervention, token use, or elapsed work. Trials must use an exact version or immutable external path without global or repository-local installation, and must preserve the selected provider, model, and thinking level. AgentKnot never silently selects an extension or model fallback.

## Non-goals

AgentKnot is not intended to become:

- an agent chat network with channels, threads, direct messages, reactions, feeds, or presence;
- a general autonomous swarm or role-playing multi-agent framework;
- a model SDK, prompt framework, memory store, or knowledge base;
- a hosted multi-tenant control plane or cloud compute fleet;
- an IDE, terminal multiplexer, or graphical agent cockpit;
- an operating-system security sandbox;
- an implicit provider optimizer that silently changes models or falls back across providers;
- a system that automatically applies patches, creates branches or pull requests, merges, commits, or pushes;
- a reimplementation of Pi, MCP, OpenCode, Codex, Claude Code, or Relay.

Remote workers, dependency graphs, scheduling, and dashboards may be evaluated later, but only after the local single-job contract is dependable and a concrete use case justifies them.

## Reference workflow

1. The controller and user agree on a bounded task and acceptance criteria.
2. The controller chooses the leaf Job API for an already bounded task or the orchestration API for policy-driven delegation. AgentKnot does not intercept arbitrary controller conversations.
3. For orchestration, AgentKnot snapshots the effective policy, asks the configured planner route for a strict read-only assessment, validates it, deterministically filters and caps it, and persists the plan before any child dispatch.
4. An upstream or suggested decision returns without starting child jobs. An automatic decision submits each selected subtask through the ordinary Job API with depth-one provenance and bounded concurrency.
5. For a leaf job, the controller submits a `JobRequest` with a workspace, route, source identity, and optional callback.
6. AgentKnot validates the request, snapshots the route, creates the job record, and records `job.queued`.
7. AgentKnot begins execution, prepares an isolated attempt when configured, and invokes the route's worker adapter.
8. The adapter translates worker activity into normalized events while AgentKnot owns state, timeout, retry, cancellation, persistence, and cleanup.
9. AgentKnot captures the terminal attempt artifact, builds the completion summary, and persists it before the terminal event is delivered.
10. The controller inspects the parent/child evidence and explicitly decides whether to promote an artifact outside AgentKnot.

The current `queued` state is an admission event immediately followed by execution; it does not imply a capacity-aware scheduler.

## Product acceptance criteria

The product remains on course when all of the following are true:

- changing `source` from Codex to Claude changes audit metadata, not execution behavior;
- changing provider or model is a route change unless a genuinely new worker runtime is required;
- configuration-only `doctor` explicitly says live inference was not checked, while `doctor --live` performs only the bounded exact selected-route probe and leaves no Job or artifact record;
- the same Job API works through CLI, HTTP, and TypeScript entry points;
- the same orchestration policy and record shape work through CLI, HTTP, and TypeScript without controller-name branches;
- every automatically dispatched child is admitted through the ordinary Job API only after its plan is persisted;
- automatic delegation is isolated, depth-one, capped, non-recursive, and cannot select configured keep-upstream task kinds;
- every emitted job event is already present in the persisted record;
- every terminal job is inspectable after the invoking call returns;
- every newly terminal succeeded, failed, or cancelled Job has a schemaVersion 1 completion summary before its terminal event is persisted or observed, and retries summarize only the terminal attempt;
- completion summaries distinguish controller-captured artifact paths from worker-reported claims, never infer reports from prose/events/stderr/session statistics, and preserve explicit unavailable reasons;
- new leaf Job and Orchestration records carry `schemaVersion: 1`, legacy file reads remain byte-stable, and unsupported explicit versions fail rather than defaulting to v1;
- Git worktree mode leaves the source workspace clean and returns artifacts without applying them;
- controllers can verify and preview recorded artifacts without source mutation, while acceptance and promotion remain explicit upstream decisions;
- retries start from the same recorded base rather than prior-attempt edits;
- credentials are not intentionally copied into configuration, records, events, logs, callbacks, or artifact metadata;
- current, proposed, experimental, and deferred capabilities are distinguishable in documentation;
- a feature that crosses a stable boundary has a spec change, tests, and an explicit roadmap gate.

## Success signals

Before broadening the product, AgentKnot should demonstrate:

- repeated real use by at least two controller types through the same API contract;
- reliable use of more than one provider/model route without controller changes;
- deterministic conformance tests for every supported worker adapter;
- no source-workspace mutations or managed-worktree leaks in the supported isolation path;
- actionable job records for success, failure, retry, timeout, and cancellation;
- an explicit human-controlled artifact inspection and promotion workflow.

These are evidence requirements, not claims that the current MVP has already met every condition.

## Risks

- Product language such as "durable", "queue", "timeout", "provider-neutral", or "isolation" can imply stronger guarantees than the implementation provides.
- Raw worker events, prompts, output, and tool results can grow without bound and can contain sensitive content even when API keys are excluded intentionally.
- Worker completion reports are claims at the adapter boundary; accepting their strict shape does not verify changed paths, check outcomes, remaining risks, or notes.
- A custom adapter may ignore cooperative cancellation unless the adapter contract and process supervision enforce termination.
- Callback delivery is currently unauthenticated, untrusted-network unsafe, non-retrying, and capable of sending the complete job record.
- A planner is a model and can produce malformed or adversarial assessments; strict validation and deterministic policy reduce but do not eliminate prompt-injection or task-classification risk.
- Process-local concurrency and PID liveness checks are not a distributed scheduler, lease, or reliable defense against PID reuse and multiple AgentKnot writers.
- Multiple execution-owning runtimes can still race whole-snapshot writes, and PID liveness observed from one namespace is not authoritative across namespaces. Read-oriented CLI commands no longer invoke that reconciliation path, resolving the immediate mutation in [incident 0010](../postmortems/0010-read-only-cli-runtime-reconciliation.md), but leases or compare-and-set storage remain absent.
- Depth one constrains AgentKnot's own parent/child engine; the unauthenticated local API cannot prevent a host-capable worker from independently submitting another top-level orchestration.
- Adding integrations before an adapter conformance contract exists can move provider-specific policy into the core.
- Copying collaboration or fleet features from adjacent projects would dilute the local execution-handoff problem AgentKnot exists to solve.

## Drift control

Every material feature proposal must answer:

1. Which primary user problem or job-to-be-done does it solve?
2. Which component owns it: controller, Job API/orchestrator, worker adapter, provider/model route, workspace manager, or external integration?
3. Does it preserve the invariants in [SPEC.md](./SPEC.md)?
4. Which stage and exit gate in [ROADMAP.md](./ROADMAP.md) admit it?
5. Is it current, proposed, experimental, or deferred?
6. What test or operational evidence will prove it works?
7. Does a rejected alternative or important tradeoff require a postmortem/decision record?

If those questions do not have concrete answers, the work should not enter implementation.

## External reference boundary

[Agent Workforce Relay](https://github.com/AgentWorkforce/relay) is a useful reference for runtime boundaries, capability honesty, durable delivery, and contract gates. Relay's communication, social collaboration, hosted, and fleet concerns are deliberately outside AgentKnot's product boundary. Integration with Relay may someday be an adapter; copying Relay into AgentKnot is not a goal.

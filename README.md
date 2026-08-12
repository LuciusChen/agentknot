# AgentKnot

AgentKnot is a vendor-neutral control plane for developers and teams that plan work in one coding agent but want policy-driven execution through interchangeable workers and model providers. It turns one repository request into an auditable plan, bounded isolated Jobs, and reviewable patch evidence without letting workers apply, commit, push, merge, or deploy their own output.

Use it when Codex, Claude, CI, or a custom controller should keep product decisions and artifact acceptance upstream while delegating implementation, tests, analysis, repair, or documentation to replaceable downstreams. Routes independently select the worker adapter, provider, model, and effort; the current repository dogfood chain is configuration, not a core dependency.

## Quick Start

Requires Node.js 22.13 or newer. Build and verify the deterministic local path first:

```bash
npm install
npm run build
npm test
node dist/src/cli.js run --route mock --source codex --workspace . \
  "Inspect this project and propose the next implementation step"
```

For a real configured repository, install the CLI once, explicitly start the independent middleware broker, and submit an orchestration from any controller session:

```bash
npm install --global --prefix "$HOME/.local" /path/to/agentknot
agentknot broker up --config /path/to/agentknot.config.json
agentknot broker status
agentknot client --json
ASSESSMENT='{"schemaVersion":1,"recommendation":"delegate","complexity":"medium","parallelizable":false,"taskKinds":["implementation"],"reasoning":"bounded implementation with objective acceptance criteria","subtasks":[{"title":"Implement the approved feature","kind":"implementation","prompt":"Implement the approved feature within its stated scope.","acceptanceCriteria":["the public contract is implemented and relevant tests pass"]}]}'
agentknot orchestrate --source codex --workspace /path/to/target-repository \
  --assessment-json "$ASSESSMENT" \
  --prompt "Implement the approved feature and verify its public contract"
```

`broker up` starts the same compiled broker as a detached application process, waits for exact readiness, and remembers only the validated absolute config path plus port in AgentKnot's protected per-user application-config directory. If a controlled execution host later reaps the detached process, any MCP-capable controller can explicitly call `agentknot_broker_start` to restore the independent broker from that launch profile in one step. Use `agentknot broker run --config ...` for an attached foreground process and `agentknot broker down` to stop the discovered instance. No shell-profile edit, systemd unit, launchd agent, Unix socket, or controller-specific daemon is installed or required. To make new Codex or Claude sessions enter this flow automatically, continue to [Codex and Claude controller integrations](#codex-and-claude-controller-integrations). Jobs and orchestration records use the configured storage paths; the repository defaults are `.agentknot/jobs/` and `.agentknot/orchestrations/`.

## How it fits

The controller is intentionally not an SDK-specific concept. Every controller submits the same `JobRequest` or `OrchestrationRequest` through the CLI, HTTP API, or TypeScript API:

```text
controller plan/assessment → AgentKnot policy → persisted plan → bounded child jobs
                         └──────→ Job API → worker adapter → provider/model
```

An optional orchestration route-selection policy can either record vendor-neutral shadow suggestions or apply explicit human-authored rules. The upstream controller assesses task complexity but cannot name a route in the assessment; configured policy remains the execution authority.

The reference and sole built-in real worker adapter uses [Pi RPC](https://pi.dev/docs/latest/rpc), a strict JSONL protocol. Provider, model, and effort remain route data, and custom TypeScript adapters can be supplied without changing Job semantics.

Use `agentknot run` for an already bounded leaf task or `agentknot orchestrate` with a controller-authored assessment when deterministic policy should decide whether and how to dispatch it.

## Capability status

The labels below are availability claims, not maturity ratings. **Current** means implemented and covered by deterministic tests. **Experimental** means evaluation-only and not a promoted default; its evidence gates are part of the status. **Proposed** and **Deferred** are not available.

| Status | Capability | Evidence or gate |
| --- | --- | --- |
| **Current** | Controller-neutral leaf jobs and bounded depth-one orchestration through CLI, HTTP, and TypeScript, with `off`, `suggest`, and `auto` delegation modes. | Implemented and covered by deterministic API, policy, lifecycle, and persistence tests; callers must invoke the Job or orchestration API rather than relying on native-chat interception. |
| **Current** | Transactional local Job/Orchestration persistence with append-only event cursors, CAS revisions, idempotent admission, fenced execution leases, durable cancellation intent, shared Job capacity, and isolated leaf/parent restart recovery. | Production `createRuntime()` imports identity-matching legacy JSON evidence without rewriting it and writes one SQLite authority per configured record directory. Record, optional idempotency identity, first lease, and FIFO capacity admission are durable; direct, child, and reviewer Jobs share the configured `maxConcurrency`. After lease expiry, git-worktree Jobs replay only from integrity-checked admitted workspace snapshots; recoverable parents reuse the admitted controller plan and deterministic child/reviewer identities without replanning or route replacement. A transitional lifetime lock still limits production to one execution-owning broker until a separate multi-executor protocol exists ([decision 0055](postmortems/0055-durable-middleware-kernel.md)). |
| **Experimental** | Thin installable Codex and Claude controller clients with explicit or implicit controller-authored handoff. | Each package exposes a controller-native Skill, launches the common `agentknot mcp` stdio client, and registers the same stateless `SessionStart` obligation for `startup`, `resume`, `clear`, and `compact`. The hook reads only bounded event JSON and emits one concise controller obligation; it performs no filesystem, Git, network, broker, policy, runtime, prompt, transcript, or session-state work, and there is no `UserPromptSubmit` hook. This deterministic session context does not guarantee Skill invocation: the controller still owns semantic eligibility, planning, and strict-assessment authoring. Deterministic tests cover package and hook parity, broker restart, and the absence of runtime ownership; one real fresh Codex task selected the Skill and completed through the existing broker, while real Claude parity remains a promotion gate ([decisions 0053](postmortems/0053-controller-owned-planning-handoff.md), [0057](postmortems/0057-independent-broker-and-thin-controller-clients.md), [0063](postmortems/0063-remove-per-prompt-controller-obligations.md), and [0074](postmortems/0074-session-start-controller-entry.md)). |
| **Current** | Independent worker/provider/model routing with built-in Mock and Pi RPC adapters. | Routing and core Job semantics are adapter-neutral. Worker and reviewer targets may name complete-route pools; pool membership remains configuration rather than a core runtime choice. |
| **Current** | Reusable route-neutral `WorkerAdapter` conformance tests for Mock and Pi RPC. | The shared unit kit covers healthy diagnostics, normalized start/text events and output, event-sink failure propagation, and pre-aborted runs. Protocol-specific lifecycle and artifact tests remain at each adapter boundary. |
| **Current** | Optional human-authored route selection and complete-route pools for eligible work. | Active/shadow rules choose configured logical targets. In production, a `least-active` pool atomically selects one complete exact route from unexpired Job leases, counts explicit member Jobs, rotates equal-load ties durably, and commits the selection with Job admission. Repository low work targets the configured `deepseek-flash` route while medium/high/default work targets `luna`; pool membership remains configuration rather than a runtime preference. Retries never switch routes; there is no learned ranking, health scoring, quota inference, or fallback ([decisions 0020](postmortems/0020-human-authored-active-route-selection.md), [0042](postmortems/0042-complete-route-pool-balancing.md), and [0061](postmortems/0061-atomic-durable-route-pool-admission.md)). |
| **Current** | Optional independent advisory review for one bounded delegated patch. | `delegation.qualityReview` names any configured single-attempt exact route or all-single-attempt pool. One separately persisted depth-one reviewer Job receives an exact single-use artifact grant instead of patch bytes in its initial prompt. Core revalidates the recorded artifact and emits content-free read evidence; the Pi adapter maps the generic reader to one explicitly loaded product tool over an attempt-owned process IPC channel. The reviewer cannot repair, apply/promote, or override the controller. Three real repeated A/B runs support retaining this narrower authority and audit trail, but did not support a token- or latency-efficiency claim ([decision/experiment 0036](postmortems/0036-bounded-advisory-quality-review.md), [decision 0078](postmortems/0078-exact-artifact-read-grant.md), and [experiment/incident 0080](postmortems/0080-artifact-read-review-ab.md)). |
| **Current** | Read-only persisted-evidence usage report through CLI and TypeScript. | `agentknot usage` and `runtime.usage()` aggregate exact available downstream adapter-reported token totals and provider cost, report cache-read and active/shadow route-rule hit rates, and keep partial or missing evidence explicit. Pi RPC normalizes exact provider evidence into this shape. Upstream controller usage, cross-boundary proportions, and shared-account remaining quota are unavailable rather than inferred ([decision 0034](postmortems/0034-persisted-usage-observability-boundary.md)). |
| **Current** | Ordered job/orchestration state and normalized events with retries, timeouts, cancellation, one-shot callbacks, and bounded exact-child Pi supervision. | Snapshot projection and event suffix commit atomically; stale revisions and stale lease fences cannot publish over current work. Catchable server shutdown rejects new admissions but remains reachable while kernel-owned work cancels and drains. Late attempt events are ignored, and the bounded Stage 1 soak verifies exact process-group cleanup. |
| **Current** | Compact route-neutral worker activity on cursor waits. | Existing durable events are projected into lifecycle state, explicit complete/partial/truncated coverage, last-observation age, and bounded sanitized active-tool names. Pi text frames are coalesced at its adapter boundary so provider chunking does not crowd out later tool evidence; client disconnect remains separate and silence is never called provider loss ([incident/decision 0072](postmortems/0072-compact-worker-activity-and-pi-frame-coalescing.md)). |
| **Current** | Bounded route-neutral live control for one active Job attempt. | Adapters explicitly advertise `steer`/`follow-up`; every request is attempt-bound and receives durable accepted, rejected, or lost evidence. Requests are never replayed after retry/restart, and late Pi RPC control responses cannot settle the main worker run. This is not controller planning, cross-Job chat, or persistent worker memory. |
| **Current** | Fixed UTF-8 budgets for prompts, metadata, worker events, result output, completion reports, errors, record projections, callbacks, and patch artifacts. | Oversized admission fails early, bounded evidence carries explicit replacement/truncation state, record projections and patch artifacts each have a 16 MiB ceiling, and callbacks above 8 MiB are not sent; retained database/legacy/artifact content is not automatically redacted and no per-record purge API exists ([decisions 0023](postmortems/0023-fixed-durable-record-budgets.md) and [0025](postmortems/0025-local-retention-and-redaction-boundary.md)). |
| **Current** | Versioned persisted Job and Orchestration records. | New records carry top-level `schemaVersion: 1`; file reads materialize missing versions as legacy v1 in memory without rewriting bytes and reject explicit unsupported versions. |
| **Current** | Additive terminal Job completion summaries and required real-worker completion reports. | Newly terminal success, failure, and cancellation records include terminal outcome/attempt, controller-captured terminal-artifact path evidence or a stable unavailable reason, and an explicit worker-reported reported/unavailable branch. Normal Pi Jobs must end with one valid strict completion envelope; missing or malformed envelopes fail the attempt even when the worker process exits cleanly and the captured patch is empty and valid. A valid `taskOutcome: blocked` report fails once without retry and remains visible in terminal evidence. Custom TypeScript adapters may still omit the optional report, while every accepted report remains an unverified worker claim ([incident/decisions 0044](postmortems/0044-required-worker-completion-and-canonical-worktree-id.md) and [0069](postmortems/0069-repeated-shared-context-scope-trials.md)). |
| **Current** | Git worktree attempt isolation, dirty-source snapshots, patch artifacts, read-only inspection, and delegated-child path-overlap review. | Supported staged, unstaged, and non-ignored untracked content is snapshotted through temporary Git state; retries see that same content while artifacts contain only worker deltas and carry its exact tree identity. Sparse-checkout omissions remain omissions rather than false deletions. Newly captured artifacts include controller-derived repository-relative `changedFiles` (including `[]`); delegated parent results group exact paths owned by multiple children as potential conflicts and mark missing evidence incomplete. A `repository-analysis` child that writes any path fails once as a read-only-contract violation while retaining its artifact as evidence. Integrity verification is not semantic completion or acceptance, and artifacts are never applied, committed, merged, or pushed automatically ([decisions 0026](postmortems/0026-child-artifact-path-overlap-review.md), [0049](postmortems/0049-dirty-workspace-snapshot-isolation.md), and [incident 0070](postmortems/0070-sparse-worktree-artifact-boundary.md)). |
| **Current** | Configuration-only `doctor`, opt-in exact-route `doctor --live`, and HTTP process liveness. | Implemented and covered by diagnostic and HTTP contract tests; live probes are point-in-time evidence and are not run as normal-job preflights. |
| **Current** | Product-owned discovery and explicit cross-platform lifecycle for one independent local broker. | `agentknot broker run` hosts the foreground kernel; `broker up|status|down` manages the same compiled entry with application process primitives, readiness polling, and exact instance/PID checks. A successful explicit `broker up` records one strict mode-0600 launch profile in the platform application-config directory; the controller-neutral MCP `broker_start` tool can explicitly restore a stopped or crash-stale broker without target-repository scanning or OS service installation. The loopback broker publishes one per-user record, clients rediscover it across restart, and stale cleanup cannot remove a newer identity. Discovery and launch preference are conveniences, not durable execution authority ([decisions 0057](postmortems/0057-independent-broker-and-thin-controller-clients.md) and [0058](postmortems/0058-controller-neutral-broker-activation.md)). |
| **Experimental** | Reviewed Pi worker profiles/extensions; none is promoted. | Evaluation only: use an exact version or immutable path without global or repository installation, then run repeated same-task Luna/max A/B trials against the minimal profile; completion, artifact verification, and target tests must not regress and session-statistics, elapsed-time, retry, or upstream-intervention evidence must show a repeatable net benefit before promotion. `pi-readseek@0.9.10` regressed its first pair. `pi-lean-ctx@3.9.18` produced two selected, passing artifacts and saved 39.0% total Pi tokens on the larger task, but on an independent smaller task it used 36.2% more tokens and took 45.7% longer; the inconsistent profile is not promoted. See [experiments 0013](postmortems/0013-pi-readseek-profile-ab.md) and [0014](postmortems/0014-pi-lean-ctx-profile-ab.md). |
| **Experimental** | Pi/OpenCode Go/DeepSeek V4 Flash at `thinkingLevel=max` for configured low-complexity dogfood work. | The route passed live probes and one isolated same-task comparison. It is now selected only by the repository's human-authored `low` rule; it is not a claimed intelligence ranking, fallback target, or replacement for Luna on medium/high work. Upstream artifact review remains required. See [experiment 0017](postmortems/0017-deepseek-flash-route-ab.md) and [decision 0020](postmortems/0020-human-authored-active-route-selection.md). |
| **Proposed** | Authenticated local automation, signed callback delivery, approval controls, and an OS-sandbox backend. | Parent/reviewer restart recovery and shared durable FIFO Job backpressure are current capabilities described above. The remaining security and automation capabilities are unavailable until their separate Stage 3 threat-model and evidence gates pass. |
| **Proposed** | An explicit artifact-promotion operation. | Not available; it may be considered only if dirty-target, base-mismatch, checksum, and explicit controller/human-approval checks are safe and tested. |
| **Deferred** | Automatic patch application, commit, merge, push, deployment, or pull-request creation. | Not available by design; artifact inspection ends with an upstream controller or human decision. |
| **Deferred** | Remote/team/fleet operation, collaboration surfaces, recursive or dependency-graph swarms, and silent provider/model fallback or optimization. | Not available; these remain conditional or deferred until an explicit PRD/SPEC change and evidence-gated roadmap stage. |

Controllers choose whether a request enters the leaf Job API or orchestration API. A controller-native Skill supplies the handoff contract, while the identical stateless `SessionStart` hook supplies one concise obligation at startup, resume, clear, and compact rather than injecting hidden context on every prompt. That obligation is a deterministic reminder, not a semantic selection guarantee; the controller uses its own task context to decide eligibility, name the exact workspace, and author the strict assessment. AgentKnot validates that untrusted handoff and applies keep-upstream, route, concurrency, depth, and artifact rules. MCP, CLI, HTTP, and TypeScript are replaceable interfaces to the same broker/kernel rather than controller-owned runtimes ([decisions 0053](postmortems/0053-controller-owned-planning-handoff.md), [0057](postmortems/0057-independent-broker-and-thin-controller-clients.md), [0063](postmortems/0063-remove-per-prompt-controller-obligations.md), and [0074](postmortems/0074-session-start-controller-entry.md)).

## Product and architecture contracts

AgentKnot keeps current behavior, future intent, execution order, and historical rationale separate so roadmap ideas do not silently become product claims:

- [Product requirements](docs/PRD.md) define the user problem, product thesis, scope, and non-goals.
- [Technical specification](docs/SPEC.md) defines current contracts, invariants, limitations, and verification requirements.
- [Roadmap](docs/ROADMAP.md) sequences work through objective exit gates rather than dates or feature wishlists.
- [Changelog](CHANGELOG.md) records release-relevant changes under an unreleased version until publication.
- [Postmortems and decision records](postmortems/README.md) preserve incidents, experiments, tradeoffs, and rejected alternatives without rewriting history.

Material changes should map to all four layers before implementation starts.

AgentKnot borrows the useful boundary ideas of harness/session/event systems such as Agent Relay, but has no Agent Relay runtime dependency and does not copy its cloud, chat, fleet, or workspace layers.

## Automatic delegation

Use the orchestration entry point after the upstream controller has bounded the goal, chosen whether to recommend delegation, and described independently verifiable subtasks:

```bash
node dist/src/cli.js orchestrate \
  --source codex \
  --workspace /path/to/target-repository \
  --assessment-json "$ASSESSMENT" \
  --prompt "Implement the approved feature and verify its public contract"
```

The `assessment` is required at the TypeScript, HTTP, and CLI boundaries. It is controller-authored but untrusted: AgentKnot strictly validates its exact schema, filters task kinds through configured keep/delegate policy, applies child/depth/concurrency caps, and selects configured logical routes. The resulting deterministic policy projection and, when it will dispatch, one immutable workspace snapshot are part of parent admission before any child starts. Every worker and reviewer Job derives from that same parent input; AgentKnot does not reclassify the goal or reread later controller-side source changes. The assessment cannot name a route, worker, provider, model, or effort.

For repository work the assessment may include one optional `context` manifest: a summary, repository-relative initial paths, hard constraints, and optional metadata-only references already known by the controller. A reference identifies an opaque locator and its source, may carry a revision, SHA-256 digest, and summary, and is always marked `unverified`; this slice records and projects the metadata but does not resolve it. The complete UTF-8 manifest is capped at 2 KiB and becomes the same prefix for every selected child before that child's own instruction. It is navigation guidance, not trusted evidence or persistent worker memory. Explicit constraints override the generic request to run checks; insufficient context is reported with available evidence instead of authorizing wider exploration. Do not include transcripts, file contents, repository inventories, credentials, or model/provider data, and omit the manifest rather than scanning the repository to construct it. Six post-correction Luna/DeepSeek trials across different repository surfaces stayed within every named path and command boundary, but this remains behavioral evidence rather than a sandbox guarantee ([experiment 0069](postmortems/0069-repeated-shared-context-scope-trials.md) and [decision 0077](postmortems/0077-task-context-reference-manifest.md)).

The repository dogfoods `mode: "auto"` with route data owned by configuration: `luna` is the default worker route, `deepseek-flash` is selected for configured low-complexity work, and `quality-review` is the advisory reviewer route. Optional route pools remain generic and can name any complete exact routes; they use least-active admission, snapshot one exact route per Job, and never become retry fallback. Product defaults are two children and two active slots; this repository uses six. The scheduler starts only useful independent tasks, refills free slots, and never treats the configured maximum as a target.

An optional `delegation.qualityReview` policy can run one fresh advisory reviewer Job after exactly one successful child produces exactly one integrity-valid, base-valid, non-empty patch within the review budget. Eligibility is selected by the parent assessment complexity; the reviewer target may be an exact route or a pool whose candidates all use one attempt. The reviewer Job durably carries only the exact source Job/artifact identity; its exact bounded size is the byte ceiling. At each attempt AgentKnot revalidates that same-workspace terminal artifact, persists a content-free `worker.artifact.read` event, and exposes one attempt-scoped read capability; completing without one served read, or suppressing a refused read, fails the reviewer Job. Pi maps that generic capability to one explicitly loaded, single-use AgentKnot tool. The tool requests bytes only when invoked over an attempt-owned Node child-process IPC channel; core records the read before responding, no artifact-content temporary file is created, and normalized tool events omit the content. The patch is absent from the initial prompt and no path or arbitrary locator becomes authority. Its strict result is persisted as `qualityReview`, but `changes-requested` completes the assigned review task without rewriting child or parent success, while `accept` does not promote the patch. The controller still owns acceptance, application, and integrated validation. Repeated real A/B evidence retains the grant for authority and auditability only; it does not show a repeatable token or latency benefit ([decision 0078](postmortems/0078-exact-artifact-read-grant.md) and [experiment/incident 0080](postmortems/0080-artifact-read-review-ab.md)).

An optional `delegation.artifactValidation` policy adds controller-owned test evidence without asking the worker or reviewer to validate its own claim. For exactly one successful child with exactly one integrity-valid, base-valid, non-empty patch no larger than 32 KiB, AgentKnot creates a second disposable worktree at the recorded base, applies only that recorded patch there, and runs exactly one configured argument vector without a shell. Validation and optional model review start concurrently after child completion. The persisted evidence records the exact arguments, pass/fail/timeout/cancellation/output-limit result, exit status, duration, bounded output, and cleanup outcome. It remains advisory: failure does not rewrite child or parent success, and neither pass nor review acceptance promotes the patch.

Historical pre-cutover dogfood used Luna/max for planning, the human-authored low-complexity DeepSeek V4 Flash/max route, and Luna/max review on a clean parser fixture whose baseline passed 3/5 tests. That run still proves the isolated validation lifecycle, but not the current controller-owned handoff path, a general completion rate, or token savings ([decisions 0037](postmortems/0037-controller-owned-artifact-validation.md) and [0053](postmortems/0053-controller-owned-planning-handoff.md)).

Per request, `--delegation never`, `--delegation suggest`, and `--delegation force` can narrow or request behavior. `force` does not bypass global `off`, the child limit, depth limit, or `keepUpstream` policy. Set global mode to `off` when a caller only wants the leaf Job API. `suggest` and `auto` require Git worktree isolation.

### Codex and Claude controller integrations

Stage 2 includes experimental installable controller clients under `integrations/`. They are optional edges, not the AgentKnot runtime: both expose the same `agentknot mcp` tools, submit the same orchestration request to the independent broker, consume the same durable evidence, and leave routing, product decisions, artifact promotion, commit, push, merge, and deployment outside the package.

Controller Skills prefer the common MCP admission/status/preview tools. The transport-equivalent `agentknot orchestrate --handoff-json` remains a fallback where MCP is unavailable. Both return a compact projection of persisted status, action, route evidence, child IDs and output, errors, parent artifact review, and artifact verification while omitting event history, policy snapshots, repeated prompts, and execution prompts.

The handoff also carries optional advisory `qualityReview` and controller-owned `artifactValidation`. Controller integrations are instructed not to rerun a successful disposable-worktree validation before deciding on the patch; if they deliberately apply it, they still validate the integrated workspace once because that is a different state.

Build and install the AgentKnot CLI once before either controller plugin. The skills check this prerequisite and stop before orchestration if it is absent; they never substitute another worker, provider, or model.

```bash
npm run build
npm install --global --prefix "$HOME/.local" /path/to/agentknot
command -v agentknot
agentknot routes
```

Ensure `$HOME/.local/bin` is on the controller process `PATH`.

For concurrent controller sessions, explicitly start the authoritative broker once:

```bash
agentknot broker up --config /path/to/agentknot.config.json
agentknot broker status
agentknot client --json
```

This does not edit a shell profile or install an operating-system service. For an attached terminal, container, or external supervisor, run `agentknot broker run --config ...`; the supervisor is an operator concern and does not change broker semantics. Keep credentials in the selected worker's own protected auth store or deliberately configure them in the chosen process host.

After it listens, the broker publishes a per-user discovery record in a stable platform application-state directory; transient controller variables such as `XDG_RUNTIME_DIR` and `XDG_CACHE_HOME` do not select the rendezvous. Later CLI and MCP clients therefore reuse the same execution owner even when shell, fresh, and resumed controller processes inherit different transient environments, without shell-profile edits. `broker up` also remembers the validated launch selection outside the target repository. The MCP client resolves discovery on each tool call, so a resumed controller process follows a broker restart without owning storage; when status is `stopped` or `unavailable` and `launchConfigured` is true, the controller may explicitly try `agentknot_broker_start` once. This operation can identity-safely remove a crash-stale record but refuses malformed or unidentified ownership. The Skill does not infer `agentknot.config.json` from the target repository. Missing/malformed launch configuration or failed startup is reported and never selects another worker, provider, or model.

Install the Codex plugin from a local checkout, then start a new Codex session:

```bash
codex plugin marketplace add /path/to/agentknot
codex plugin add agentknot@agentknot
```

Invoke the full review workflow explicitly with `$agentknot-delegate`, or let the controller consider the Skill for eligible repository work. Codex's implicit-invocation metadata permits selection but is not evidence that a fresh session actually invoked the Skill; use the explicit entry when that distinction matters.

Install the Claude Code plugin from the same checkout, then start a new Claude session:

```bash
claude plugin marketplace add /path/to/agentknot
claude plugin install agentknot@agentknot
```

Invoke it explicitly as `/agentknot:agentknot-delegate`; Claude uses the same controller-owned assessment contract. A controller's `/goal` may preserve an upstream goal, but `/goal` is not the AgentKnot protocol and does not itself bypass the plugin or orchestration API.

After installation or an MCP/Skill change, review and trust the package in the controller UI, then start a new controller process so it loads the new tools. Each package has one identical stateless `SessionStart` hook for `startup`, `resume`, `clear`, and `compact`; it reads only bounded event JSON and injects one concise controller obligation, while no `UserPromptSubmit` hook injects per-prompt context. The hook does not perform filesystem, Git, network, broker, policy, runtime, prompt, transcript, or session-state work. New and resumed sessions use the same controller-native Skill, but the obligation does not guarantee implicit Skill invocation; the upstream controller supplies the actual workspace through the common handoff.

The upstream controller owns eligibility, planning, decomposition, acceptance criteria, and promotion, then calls `agentknot_broker_status`; a stopped or unavailable configured broker gets one explicit `agentknot_broker_start` attempt before policy lookup and eligible admission. Admission is non-blocking. `agentknot_orchestration_wait` keeps one bounded MCP call attached across multiple durable event batches and returns either the terminal handoff or the same orchestration ID plus `nextSequence` for idempotent resume; it never resubmits work. `agentknot_orchestration_follow` remains the one-batch diagnostic primitive, `agentknot_orchestration_status` remains an immediate snapshot read, and `agentknot_artifact_preview` is read-only. `agentknot mcp` is a broker client and lifecycle control surface, never a runtime owner. AgentKnot owns validation, deterministic policy, routing, scheduling, isolation, recovery, completion, and artifact evidence ([decisions 0053](postmortems/0053-controller-owned-planning-handoff.md), [0057](postmortems/0057-independent-broker-and-thin-controller-clients.md), [0058](postmortems/0058-controller-neutral-broker-activation.md), [0062](postmortems/0062-durable-event-subscription.md), [0063](postmortems/0063-remove-per-prompt-controller-obligations.md), [0074](postmortems/0074-session-start-controller-entry.md), and [0075](postmortems/0075-bounded-mcp-wait-and-resume-gate.md)).

### Human-authored route selection

`delegation.dispatch.routeSelection` is optional and disabled when omitted. `mode: "shadow"` records what a rule would choose while retaining `dispatch.defaultRoute`; `mode: "active"` makes the matching configured exact route or pool target authoritative for the planned child and ordinary Job request. The global delegation mode remains a separate setting.

The repository dogfood policy is intentionally small:

```json
{
  "dispatch": {
    "defaultRoute": "luna",
    "maxChildren": 6,
    "maxDepth": 1,
    "maxConcurrency": 6,
    "routeSelection": {
      "mode": "active",
      "rules": [
        { "route": "deepseek-flash", "complexities": ["low"] }
      ]
    }
  }
}
```

There must be 1–20 ordered rules, every `route` target must name an existing configured exact route or route pool and every candidate is validated at config load, and a present `taskKinds` or `complexities` array must be non-empty and unique. Complexity values are only `low`, `medium`, and `high`; when both predicates are present they must both match, and a rule with neither predicate is an explicit catch-all, so the first matching rule wins.

For each eligible planned subtask, AgentKnot evaluates the subtask kind and parent assessment complexity. An active match persists evidence such as `{ "mode": "active", "selectedRoute": "deepseek-flash", "basis": "rule", "ruleIndex": 0 }`; with no match it persists `{ "mode": "active", "selectedRoute": "luna", "basis": "default" }`, with no `ruleIndex`. This field carries the configured route or pool target. `ruleIndex` is zero-based and appears only for a rule match. Complexity is assessed once for the parent orchestration, so all children share that complexity; there is no second per-child model judgment.

The suggestion is observable in the persisted plan and in the child `agentknotDelegation` metadata, alongside `taskKind` and `parentComplexity`, so future scorecards do not need to parse prompts; a child metadata fragment is:

```json
{
  "agentknotDelegation": {
    "role": "worker",
    "taskKind": "documentation",
    "parentComplexity": "medium",
    "routeSelection": {
      "mode": "active",
      "selectedRoute": "deepseek-flash",
      "basis": "rule",
      "ruleIndex": 0
    }
  }
}
```

`PlannedSubtask.route` and the child's `request.route` are `deepseek-flash` in this example. The selected exact route fixes worker, provider, model, `thinkingLevel`, timeout, and retry policy before execution. A failure remains on that route and never causes silent worker or model fallback. If a configured pool is selected instead, admission records the same exact member-selection evidence before execution.

Use `agentknot orchestrate` with the configured file, then inspect the orchestration record and each child Job record through CLI JSON, `GET /v1/orchestrations/:id`, or `GET /v1/jobs/:id`. `shadow` remains available for measurement without execution changes. `active` is deterministic human policy, not a performance ranking: AgentKnot does not learn model intelligence, choose from prices, or silently optimize/fallback.

## Pi + OpenCode Go provider + Luna

Install Pi using its documented package:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Provide the OpenCode Go provider API key without committing it to configuration:

```bash
export OPENCODE_API_KEY="..."
```

Alternatively, start `pi`, run `/login`, and store the key under the `opencode-go` provider in Pi's credential file. AgentKnot accepts either Pi's auth file or the configured environment variable and never copies the key into a Job record.

Route diagnostics have two deliberately different modes. `doctor` is the fast configuration, credential, and runtime check; its successful result explicitly says that live inference was not checked, so it does not prove that the provider accepted a request from the current network path. For Pi routes, it evaluates command `PATH`, required environment names, `PI_CODING_AGENT_DIR`, and the worker home from the same `process.env`-plus-worker-environment snapshot passed to `run` and `probe`, without returning credential values. The Stage 1 live check is opt-in and remains route-neutral. For this repository, selecting `luna` resolves Pi, `opencode-go`, `gpt-5.6-luna`, and `thinkingLevel: "max"`:

```bash
node dist/src/cli.js doctor --route luna --live
```

`doctor --live` performs one bounded real inference probe with the exact selected worker, provider, model, and thinking level. Its 30-second control-plane timer triggers cooperative abort, and the supported Pi adapter supervises its child process, waits for cleanup, and removes an isolated temporary diagnostic workspace before returning. The command does not fall back to another route, returns the provider error and a nonzero exit status when inference is unavailable, and reports an honest unsupported result when the selected adapter has no probe capability. It creates no Job or artifact record, and normal `run` or orchestration execution does not perform an extra probe. A successful probe is point-in-time evidence for that exact route, not a guarantee that later jobs will succeed.

Check the route, then run it against any target repository:

```bash
node dist/src/cli.js doctor --route luna

node dist/src/cli.js run \
  --route luna \
  --source codex \
  --workspace /path/to/target-repository \
  "Implement the agreed design, run relevant tests, and summarize the changes"
```

AgentKnot starts:

```text
pi --no-skills \
  --no-extensions \
  --no-prompt-templates \
  --no-themes \
  --mode rpc \
  --provider opencode-go \
  --model gpt-5.6-luna \
  --no-session
```

The adapter disables ambient extension, skill, prompt-template, and theme discovery for every background Pi run and live probe. Explicit `--extension`, `--skill`, `--prompt-template`, and `--theme` arguments remain available for reviewed worker profiles, while repository context files such as `AGENTS.md` stay enabled. A profile must not depend on global or repository-local Pi installation state: use an exact reviewed package version or immutable external path, compare it with the minimal route on the same real task, and promote it to dogfood only after repeated completion/artifact/test evidence shows a net benefit. Recommendation alone is not promotion evidence; see [decision 0012](postmortems/0012-evidence-gated-pi-profiles.md).

AgentKnot sends the prompt over stdin as JSONL and waits for Pi's `agent_settled` event, so retries and queued continuation events finish before the job is marked complete. After a successful normal run it requests `get_session_stats` and stores only sanitized counts, token totals, cost, and optional context usage under result metadata; unsupported, malformed, or timed-out statistics are advisory and do not turn successful work into failure. These statistics and other Pi activity remain evidence for diagnostics, not a completion report. For normal `run` jobs only, the adapter appends a provider/model-neutral instruction asking the final assistant message to end with one line beginning `AGENTKNOT_WORKER_COMPLETION_REPORT_V1: ` followed by the schemaVersion 1 `WorkerCompletionReport` JSON. The report contains worker-reported `changedFiles`, `checksRun`, `remainingRisks`, and `notes`; every value is a worker claim, not AgentKnot verification. `taskOutcome` describes whether the assigned worker-role task finished, not whether an inspected subject was acceptable: a completed review can request changes, while `blocked` means the review itself could not be completed. A valid suffix is strictly validated and removed together with its separating newline from `result.output`; a missing, trailing, malformed, or unsupported suffix fails the attempt instead of converting intermediate progress into success. A valid `taskOutcome: blocked` suffix reaches the shared orchestrator result boundary, fails once without retry, and remains in the terminal summary. The instruction and parser are not used by `doctor` or `doctor --live`, and no text after the marked line is accepted. The adapter decodes streaming UTF-8 independently of process chunk boundaries, reports malformed frames and missing settlement explicitly, and uses bounded `SIGTERM` → `SIGKILL` supervision for the exact Pi child on timeout or cancellation. Output draining also has a fixed grace window: if an external event sink never settles, the adapter destroys only the owned streams and stops awaiting that task so abort cleanup can finish; the external promise itself cannot be cancelled. It does not perform process-wide cleanup or claim ownership of arbitrary descendants.

Normal `PiRpcWorkerAdapter.run` executions have one bounded record-volume rule: exactly the Pi lifecycle envelopes `turn_start`, `turn_end`, `message_start`, and `message_end` are omitted from `worker.raw`; every received Pi frame still increments `metadata.rawEventCount`, including those four envelopes, and unknown event types remain `worker.raw`. Normalized text/tool/retry events, final output, completion reports, live-probe behavior, route/provider/model/thinking configuration, and global event types are unchanged. This is not a Pi-token-saving claim or general truncation and adds no schema migration, plugin installation, configuration/probe change, or global event-type change.

## Switching controller or provider

The control protocol does not change when the caller changes:

```bash
agentknot run --source codex  --route luna "..."
agentknot run --source claude --route luna "..."
```

The source is identity and audit metadata; it is not used to choose implementation code.

Provider changes are route-only:

```bash
agentknot run --source claude --route deepseek-flash "..."
```

The included `deepseek-flash` route keeps Pi and OpenCode Go but selects DeepSeek V4 Flash/max. Repository automatic delegation uses it only for the human-authored low-complexity rule; explicit callers may select it directly. Luna/max remains the conservative default, and neither route is a fallback for the other.

## HTTP automation

Start the local control plane through the explicit application lifecycle, or run the same broker in an attached terminal:

```bash
agentknot broker up --config /path/to/agentknot.config.json
# Attached alternative:
# agentknot broker run --config /path/to/agentknot.config.json --host 127.0.0.1 --port 7391
```

The broker is the single local execution owner for any number of trusted clients. Client-capable `run`, `orchestrate`, `routes`, `jobs`, `show`, `delegation`, orchestration inspection, artifact inspection, and the MCP bridge use the existing HTTP API without constructing another runtime. Explicit `--server URL` and `AGENTKNOT_SERVER_URL` remain available; local CLI execution through `--config`/`AGENTKNOT_CONFIG` is deliberate and separate from broker clients. The application lifecycle adds no second scheduler, protocol, remote fleet, shell mutation, or OS-service configuration.

Submit asynchronously:

```bash
curl -sS http://127.0.0.1:7391/v1/jobs \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "Implement the approved plan and run tests",
    "workspace": "/path/to/repository",
    "route": "luna",
    "source": "claude"
  }'
```

The response is `202 Accepted` with a job ID. Follow committed event progress or the terminal record, inspect exact state when needed, or cancel it:

```bash
curl -sS http://127.0.0.1:7391/v1/jobs/JOB_ID
curl -sS http://127.0.0.1:7391/v1/jobs/JOB_ID/events
curl -sS 'http://127.0.0.1:7391/v1/jobs/JOB_ID/events?after=SEQUENCE'
curl -sS -X POST http://127.0.0.1:7391/v1/jobs/JOB_ID/cancel
```

`GET /v1/jobs/:id/events?after=SEQUENCE` and its Orchestration equivalent are the only remote follow boundary. Active responses contain only committed events after the cursor, `nextSequence`, and a compact heartbeat; terminal responses carry `nextSequence` and the full terminal record once, without duplicating its event history. The heartbeat derives a bounded activity view from durable evidence: lifecycle state, complete/partial/truncated coverage, the last committed observation and age, and sanitized active-tool names. It repeats no prompt, worker text, stderr, raw frame, tool call ID, argument, or result. Observation age is not a worker-health claim; client disconnection and bounded same-ID reconnect are shown separately. A successful save wakes same-process readers immediately; reconnecting or replacement processes resume from the acknowledged sequence and use durable refresh when no process-local notification exists. Connections are never state authority. CLI `run` and `orchestrate`, the HTTP client, and MCP consume this contract. MCP `agentknot_orchestration_wait` folds repeated batches into one bounded request, forwards progress only when the controller supplies a standard progress token, and returns an active same-ID cursor when its deadline expires; that cursor advances only through completed follow batches, not through newer events present only in its initial exact-ID snapshot. `agentknot_orchestration_follow` exposes one batch for diagnostics. A cancelled MCP request aborts only its in-flight follow connection, not the durable orchestration ([decisions 0062](postmortems/0062-durable-event-subscription.md), [0065](postmortems/0065-retire-http-wait-aliases.md), [incident/decision 0072](postmortems/0072-compact-worker-activity-and-pi-frame-coalescing.md), and [incident/decision 0075](postmortems/0075-bounded-mcp-wait-and-resume-gate.md)).

Inspect a completed job's patch artifacts without applying them:

```bash
agentknot artifacts JOB_ID --json
agentknot artifact-verify JOB_ID --json
agentknot artifact-preview JOB_ID 1 --json
```

The equivalent HTTP endpoints are `GET /v1/jobs/:id/artifacts`, `GET /v1/jobs/:id/artifacts/verify`, and `GET /v1/jobs/:id/artifacts/:attempt/preview`. Verification recomputes the recorded size and SHA-256, compares the recorded base commit with current `HEAD`, and for new artifacts compares the exact admitted source tree with current staged/unstaged/non-ignored content. Preview returns at most 1 MiB of UTF-8 Git patch text and withholds content when file integrity fails; a base mismatch remains visible in the verification evidence so the controller can inspect but must not promote blindly. These operations use temporary Git index/object state and never apply, commit, push, or otherwise mutate the source repository.

Worktree admission does not require a clean source. AgentKnot collapses the current staged and unstaged distinction into the file tree the worker actually sees, excludes ignored files, and rejects dirty submodule contents because a superproject Git snapshot cannot represent them. The real index, working tree, and repository object database remain unchanged by snapshot capture. An automatically dispatching parent captures this state once, and all of its serial, parallel, refill, and reviewer Job admissions derive from that parent evidence. If `HEAD` or the exact source tree later drifts, public artifact verification and disposable validation refuse that base rather than guessing or silently falling back.

For a completed delegated orchestration, inspect `result.artifactReview` through `orchestration-show`, the full HTTP orchestration record, or the TypeScript result. `checked` means every child had controller-captured terminal path evidence; `incomplete` must not be read as a clean handoff. Each `conflicts` entry groups an exact repository-relative path found in multiple children. It is potential integration-conflict evidence only: same-path changes may be compatible, and disjoint paths can still be semantically coupled.

The deliberate handoff workflow is: inspect the parent and child records; verify every candidate artifact's size, SHA-256, and base; preview intact patches; review all overlap and unavailable evidence; then explicitly accept or reject the artifact or child set in the upstream controller. Acceptance does not apply anything. Any promotion is a separate explicit repository action after acceptance; AgentKnot has no promotion command and never mutates the source during orchestration, inspection, acceptance, or rejection.

Read-oriented CLI commands, including `show`, lists, artifact inspection, route and delegation inspection, and both doctor modes, open persisted records without scheduler ownership or startup recovery. A TypeScript runtime created with `reconcileOnStartup: false` has the same read-only capability boundary: its execution and recovery methods refuse calls. Local `run`, local `orchestrate`, `broker run`, and the deprecated valid `serve` alias acquire transitional scheduler locks on the canonical Job and Orchestration storage directories before recovery/admission; a second execution host exits clearly until a multi-executor recovery/configuration protocol replaces this gate. Concurrent controller sessions share one broker, while durable record identity, capacity, wait, cancellation, leaf/parent recovery, and route-pool selection do not depend on process-local Promise or activity maps.

Production record directories now contain `agentknot.sqlite`, the transactional authority for bounded record projections, append-only events, CAS revisions, scoped idempotency keys, fenced execution leases, durable cancellation intent, and FIFO Job-capacity rows. Existing per-record JSON snapshots are imported once without being rewritten or deleted. Git-worktree Jobs and dispatching parent Orchestrations retain their admitted dirty-tree patch as an exact-ID mode-0600 input artifact; the record carries only its bounded identity, size, SHA-256, commit, tree, and path evidence. Child and reviewer admissions derive from the parent evidence; recovery reclaims both leaves and parents from those immutable boundaries. The older hidden lifetime-lock database still temporarily prevents two production execution schedulers; it is no longer record, event, capacity, or recovery authority. TypeScript callers must call `await runtime.close()` after admitted work settles ([decision 0055](postmortems/0055-durable-middleware-kernel.md)).

After a CLI `run` or `orchestrate` request has been admitted, catchable `SIGINT`/`SIGTERM` cancels that exact execution, awaits worker cleanup and terminal persistence, and only then releases runtime ownership. HTTP graceful close first rejects new Job/orchestration admissions with 503 while keeping liveness and read-only access available, waits for in-flight admission decisions, cancels and drains active work, then closes the listener before releasing runtime locks. A hard kill cannot run these handlers; after the expired fence, the next owner recovers supported leaf and parent executions from admitted durable boundaries without replanning or route replacement. Arbitrary descendants or worktrees left by an uncatchable host failure still require exact operator cleanup ([incident 0024](postmortems/0024-stale-dogfood-test-processes.md), [incident/decision 0046](postmortems/0046-clutch-review-listing-and-shutdown-gaps.md), and [decision 0055](postmortems/0055-durable-middleware-kernel.md)).

Persisted Job and Orchestration records carry top-level `schemaVersion: 1`. File stores accept a missing field as legacy v1 only while reading, materialize it on the returned in-memory record, leave read-only snapshot bytes unchanged, and fail clearly for an explicit unsupported version. This slice adds no migration command or automatic on-disk rewrite.

A newly terminal JobRecord also carries an additive `completionSummary` in TypeScript values, CLI `--json`, HTTP full-record responses, and callback snapshots without a new endpoint or serializer. Its changed paths are copied only from the terminal attempt's controller-captured artifact and retain artifact attempt/SHA-256/base-commit identity; direct mode, missing artifacts, or missing artifact path data produce stable unavailable reasons. A strict custom-adapter report is placed under `workerReported` only after validation; custom adapters may omit it, but the built-in Pi normal-run boundary requires one valid envelope and fails the attempt when it is absent or malformed. AgentKnot never derives a report from prose, worker events, stderr, session statistics, or an empty verified patch. Human CLI rendering is unchanged, and every accepted report remains a claim rather than controller verification ([incident/decision 0044](postmortems/0044-required-worker-completion-and-canonical-worktree-id.md)).

### Usage report

Inspect accumulated persisted evidence without starting a worker, probing a route, or reconciling records:

```bash
agentknot usage
agentknot usage --json
```

The default view groups coverage, downstream tokens, cache efficiency, routing outcomes, advisory-review outcomes, and controller-data gaps for human review; use `--json` for the stable machine-readable report.

The same projection is available as `await runtime.usage()`. It counts every successful Job at most once from its terminal `result.metadata.sessionStats`, sums exact available input/output/cache-read/cache-write/total fields and provider-reported numeric cost, and reports coverage as complete or partial. A valid all-zero record stays valid; missing, timed-out, unsupported, malformed, unsafe, or aggregate-overflow data never becomes zero. The cache-read hit rate is calculated after aggregation as `cacheRead / (input + cacheRead)`, excluding output and cache-write tokens. Routing also reports classified persisted pool selections grouped by logical pool and exact member, so configured route distribution is visible without inferring it from provider text.

Route-selection hits come from terminal orchestration plans and their immutable policy snapshots, not the current configuration or a prompt reclassification. Active and shadow evidence remain separate; `basis: "rule"` is a hit even when a rule selects the default route, while `basis: "default"` is an explicit default selection. Missing, malformed, or policy-inconsistent evidence is unclassified and makes coverage partial.

Quality-review counts likewise come only from terminal records whose immutable policy configured a reviewer. The report groups completed, skipped, and unavailable outcomes, strict verdicts, finding severities, reviewer route names, and stable skip/failure reasons. It does not infer whether the controller later accepted, modified, or rejected the patch; that disposition remains `controller-review-disposition-not-persisted`.

AgentKnot does not currently persist exact Codex or Claude controller token usage. The report therefore returns `controller-usage-not-persisted` for `upstream` and `proportions`; it never reports upstream as zero or downstream as 100%. Codex session lifecycle events do not provide token fields, and transcript parsing is not a stable contract. A future controller adapter may supply comparable exact usage, but this slice adds no transcript parser, telemetry collector, import format, pricing table, dashboard, or HTTP endpoint.

Durable record budgets are fixed rather than configuration-dependent in Stage 1. Caller-supplied Job and Orchestration request prompts are limited to 64 KiB; controller metadata to 64 KiB of compact JSON and depth 20; each JSON-normalized event-data object to 16 KiB as a standalone value; and each Job to 512 worker events. Worker adapters normalize private transports before that boundary; Pi RPC coalesces only consecutive text deltas while preserving exact final output and non-text ordering. An oversized event payload is replaced with structured evidence; oversized tool events retain only bounded lifecycle identity and error status. The first worker event beyond the count cap becomes `job.worker.events.truncated`; later worker events are neither persisted nor delivered to the live observer. Terminal output retains at most a 1 MiB valid UTF-8 prefix and exposes `result.outputTruncation`; strict worker reports are limited to 256 KiB. File and memory Job/Orchestration stores reject new writes above 16 MiB of stored JSON; legacy larger files remain readable, but later mutation must fit. Callback JSON above 8 MiB is not sent, and AgentKnot attempts to persist an undelivered size error under the same snapshot ceiling. These record limits bound retained evidence and delivery payloads, not worker compute; patch bytes and local retention have the separate fixed boundary described in [decision 0025](postmortems/0025-local-retention-and-redaction-boundary.md), and no size control is sensitive-content redaction ([decision 0023](postmortems/0023-fixed-durable-record-budgets.md) and [incident/decision 0072](postmortems/0072-compact-worker-activity-and-pi-frame-coalescing.md)).

Set `callbackUrl` in the request to receive the terminal job snapshot by HTTP POST. The single request is skipped when its JSON body exceeds 8 MiB.

Durable leaf admission is one transaction containing the queued state, `job.queued` event, optional idempotency identity, and first fenced lease. In git-worktree mode the immutable input patch is fully materialized before that transaction may reference its hash; a pre-admission crash can leave an unreferenced exact-ID file but never a partial referenced input. An admission failure starts no worker and removes its exact unreferenced input. If a later event, artifact record, or terminal transition cannot be saved, completion rejects with `JobPersistenceError`; AgentKnot does not retry the worker, synthesize a terminal event, or deliver the callback, and the last successfully persisted projection remains authoritative. An accepted cancellation is the deliberate terminal-race exception: a simultaneous success projection is refused and becomes one cancelled result. An unrecorded output patch is removed together with its managed worktree.

Submit a goal to the policy-driven path:

```bash
curl -sS http://127.0.0.1:7391/v1/orchestrations \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "Implement the approved feature and review the test gaps",
    "workspace": "/path/to/repository",
    "source": "claude",
    "delegation": "inherit"
  }'
```

Poll `/v1/orchestrations/ORCHESTRATION_ID`, inspect its `/events`, or cancel an orchestration active in the serving process. `GET /v1/delegation` exposes the effective global policy without exposing credentials.

## Configuration

The separation between worker and provider is deliberate. Workspace isolation is an orchestrator lifecycle, not a worker or provider feature:

```json
{
  "workspaceIsolation": {
    "mode": "git-worktree",
    "directory": ".agentknot/worktrees"
  },
  "workers": {
    "pi": {
      "adapter": "pi-rpc",
      "command": "pi",
      "noSession": true
    },
    "repository-review": {
      "adapter": "pi-rpc",
      "command": "pi",
      "commandArgs": ["--no-skills", "--tools", "read,grep,find,ls"],
      "noSession": true
    }
  },
  "routes": {
    "luna": {
      "worker": "pi",
      "provider": "opencode-go",
      "model": "gpt-5.6-luna",
      "thinkingLevel": "max",
      "requiredEnv": ["OPENCODE_API_KEY"],
      "maxAttempts": 2,
      "timeoutMs": 3600000,
      "maxToolCalls": 160
    },
    "deepseek-flash": {
      "worker": "pi",
      "provider": "opencode-go",
      "model": "deepseek-v4-flash",
      "thinkingLevel": "max",
      "requiredEnv": ["OPENCODE_API_KEY"],
      "maxAttempts": 2,
      "timeoutMs": 3600000,
      "maxToolCalls": 64
    },
    "quality-review": {
      "worker": "repository-review",
      "provider": "opencode-go",
      "model": "gpt-5.6-luna",
      "thinkingLevel": "max",
      "requiredEnv": ["OPENCODE_API_KEY"],
      "maxAttempts": 1,
      "timeoutMs": 3600000,
      "maxToolCalls": 64
    }
  },
  "delegation": {
    "mode": "auto",
    "dispatch": {
      "defaultRoute": "luna",
      "maxChildren": 6,
      "maxDepth": 1,
      "maxConcurrency": 6,
      "routeSelection": {
        "mode": "active",
        "rules": [
          { "route": "deepseek-flash", "complexities": ["low"] }
        ]
      }
    },
    "policy": {
      "delegate": ["architecture-review", "repository-analysis", "test-gap-analysis", "documentation", "independent-implementation"],
      "keepUpstream": ["requirements-decision", "product-decision", "artifact-integration", "commit", "push"]
    },
    "qualityReview": {
      "route": "quality-review",
      "complexities": ["low"]
    },
    "artifactValidation": {
      "argv": ["npm", "test"],
      "timeoutMs": 300000,
      "maxOutputBytes": 65536
    }
  }
}
```

An absolute `workspaceIsolation.directory` is used exactly. A relative value is a stable configuration namespace under AgentKnot's private platform-temporary worktree root, not a path below the AgentKnot installation or config repository. This prevents an external target from inheriting an unrelated host project's `AGENTS.md`, `package.json`, or other ancestor-discovered state while preserving deterministic cleanup across broker processes ([incident/decision 0079](postmortems/0079-external-worktree-ancestor-isolation.md)).

Use `--config PATH` or `AGENTKNOT_CONFIG` for another configuration file. Route and worker names above describe only this dogfood deployment: controller identity, worker, reviewer, adapter, provider, model, and effort are not fixed in core. Optional `maxToolCalls` is a per-attempt hard stop over normalized tool executions; omission leaves the existing timeout and event-size limits unchanged. The repository values are conservative operational bounds derived from persisted dogfood evidence, not model intelligence rankings or planner decisions ([decision 0067](postmortems/0067-route-tool-execution-budget.md)). A leaf request, dispatch default/rule, or quality-review target may name a pool; top-level default and `doctor` remain exact-route surfaces. Pools contain 2–20 unique exact routes, use `least-active` with rotating equal-load ties, and never switch a selected Job during retry. Production SQLite admission derives activity from unexpired exact-route Job leases and commits the choice, Job, first lease, and cursor in one transaction; memory and legacy file stores keep local test/migration behavior. Every candidate in a quality-review pool must have `maxAttempts: 1`; omission disables review. `artifactValidation` is also optional and remains bounded/shell-free as configured. JSON configuration selects the built-in `mock` and `pi-rpc` adapters; custom TypeScript adapters remain available through direct construction.

When `workspaceIsolation.mode` is `git-worktree`, AgentKnot requires a valid `HEAD` and snapshots supported top-level staged, unstaged, and non-ignored untracked content, capped by the existing 16 MiB binary-patch budget. Before durable leaf Job admission, and before admission of a parent that will dispatch, a non-empty input patch is atomically retained under that exact execution identity with mode 0600; the record keeps its SHA-256, size, commit, tree, repository, workspace, and subdirectory. Parent children and reviewers derive their Job snapshots from that one admitted parent input, while restart recovery can verify and replay each retained boundary instead of mutable source state. Each attempt is a detached worktree at that base with the snapshot replayed only inside it; relative worktree configuration is materialized outside the host project tree so external repositories cannot inherit its ancestor-discovered instructions or package configuration. The worker receives the matching repository subdirectory. After every attempt, a binary worker-delta patch up to 16 MiB is written under storage, including tracked-file deletions, worker untracked files, and commits, and metadata records `baseTree` plus Git-derived repository-relative `changedFiles`, including `[]` for an empty delta. The exact managed worktree is then removed. A larger snapshot fails before admission; a larger worker patch fails without retry or partial artifact. These paths are controller-captured evidence, not a worker claim, completion proof, or semantic verification; the terminal summary keeps worker claims separate and includes the same optional `baseTree` identity. Patches are artifacts only and are never applied automatically. Legacy artifacts and summaries may omit `baseTree` or `changedFiles`. Ignored dependencies/build outputs remain absent and dirty submodule contents are rejected. Compatibility mode `none` passes the caller's directory directly and provides no isolation.

## API surface

```text
POST /v1/jobs
GET  /v1/jobs
GET  /v1/jobs/:id
GET  /v1/jobs/:id/events
POST /v1/jobs/:id/cancel
GET  /v1/jobs/:id/artifacts
GET  /v1/jobs/:id/artifacts/verify
GET  /v1/jobs/:id/artifacts/:attempt/preview
GET  /v1/delegation
POST /v1/orchestrations
GET  /v1/orchestrations
GET  /v1/orchestrations/:id
GET  /v1/orchestrations/:id/events
POST /v1/orchestrations/:id/cancel
GET  /v1/routes
GET  /health/live
GET  /health                    compatibility alias
```

`GET /v1/jobs`, `agentknot jobs --json`, and `AgentKnotHttpClient.listJobs()` return the same summary page capped at 1 MiB: Job identity, status, logical route name, timestamps, attempt, total count, truncation flag, and byte bound. They intentionally omit prompts, workspaces, outputs, metadata, events, and artifacts. Use `show JOB_ID` or `GET /v1/jobs/:id` for one full record.

`GET /health/live` is the canonical process-liveness endpoint. It returns `status: "live"` and explicitly marks storage, routes, and inference as `not-checked`; `GET /health` returns the identical payload for compatibility. There is intentionally no `GET /health/ready` contract. Use CLI `doctor` for configuration diagnostics and explicit `doctor --live --route NAME` when point-in-time provider inference evidence is required.

## Safety model

Automatic delegation requires `git-worktree` mode. Worker agents read and execute commands in managed detached worktrees; the supplied source workspace is not modified and resulting patches are handed off as artifacts. A configured artifact-validation command applies one bounded patch only inside another managed disposable worktree and never to the supplied source. It is trusted local command execution with the AgentKnot process's permissions and environment, not a sandbox; only the exact spawned child is supervised, so commands that intentionally leave descendants are outside the cleanup guarantee. A persisted plan never grants source-tree application or artifact promotion. In compatibility mode `none`, leaf jobs may operate directly in the supplied workspace, but `suggest` and `auto` configuration is rejected. Run workers and validation commands only against repositories and credentials appropriate for those processes.

Callback URLs are supplied by trusted local controllers and can make HTTP requests from the AgentKnot host. The body cap does not authenticate, sign, or allowlist the destination. Do not expose the MVP HTTP server to untrusted networks.

Local Job/Orchestration database records, imported legacy snapshots, admitted workspace inputs, and output patch artifacts are retained indefinitely. There is no expiry, garbage collector, cascade deletion, or per-record purge API. After stopping execution and resolving related parent/child/lease/artifact evidence, an operator may remove an entire inactive configured database or exact legacy/artifact path; deleting arbitrary live SQLite rows or files is outside the contract. Prompts, output, events, metadata, stderr evidence, callbacks, and patches can contain sensitive content; byte limits, allowlisted statistics, and credential-field minimization are not automatic redaction. See [decision 0025](postmortems/0025-local-retention-and-redaction-boundary.md).

## Roadmap

Stage 1 is complete and Stage 2 remains in progress after the native secondary CLI worker retirement. Stage 3 now has transactional durability, cross-session same-ID wait/cancel, fenced leaf/parent recovery, atomic durable route-pool selection, shared FIFO Job capacity, and attempt-bound live control. Current limits include one transitional production execution scheduler, depth one, no automatic artifact integration, no semantic verification of captured paths, and no authentication for the local HTTP service.

See [the roadmap](docs/ROADMAP.md) for scope, non-goals, and exit gates. Provider fallback, streaming, sandbox backends, OhMyPi compatibility, remote/fleet features, and automatic model/provider selection are proposals or deferred rather than current capabilities; any future ranking requires separate measured scorecards.

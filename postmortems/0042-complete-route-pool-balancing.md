# 0042: Balance heterogeneous downstreams above complete routes

- Type: Decision
- Status: Accepted
- Implementation: Delivered in this slice
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Related: [decision 0001](./0001-vendor-neutral-control-plane.md), [decision 0020](./0020-human-authored-active-route-selection.md), [decision 0041](./0041-native-opencode-worker-portability.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

Durability update: [decision 0061](./0061-atomic-durable-route-pool-admission.md) supersedes the process-local counter/cursor implementation for the production SQLite Job store. This record remains the route-pool semantic origin and historical delivery evidence.

## Context

AgentKnot now has two real downstream runtime protocols: Pi RPC and native OpenCode JSON. A provider plugin or multiple keys inside Pi would still be one worker runtime; the requested load-balancing boundary must survive replacement of Pi, OpenCode, provider, model, and credential mechanisms.

The smallest portable unit is therefore an existing complete route: worker adapter plus provider, model, optional effort, retry count, timeout, and credential requirements. Balancing individual API keys or provider clients in core would reverse decision 0001 and make a replaceable worker implementation privileged.

## Decision

- Add optional named `routePools`. Each pool contains 2–20 unique existing exact route names and currently supports only `least-active`.
- Keep top-level `defaultRoute`, planner, doctor, and quality-review routes exact. A leaf `JobRequest.route`, orchestration dispatch default, or human-authored dispatch rule may name a pool.
- Immediately before Job creation, reserve one concrete member with the lowest process-local active Job count. Explicit Jobs sent directly to a member route participate in the same activity count. Equal-load candidates use a process-local rotating member order.
- Snapshot the selected exact route into `job.route` and persist additive `routePoolSelection` evidence containing the pool, ordered candidates, strategy, active counts and cursor before selection, selected member/index, and tie-break. `request.route` retains the caller's logical pool target.
- Hold the reservation through worker settlement and release it before callback delivery. Admission, observer, persistence, cancellation, timeout, worker error, and terminal-persistence paths release exactly once.
- Retries remain on the selected immutable exact route. A failure does not switch worker, provider, model, credential, or effort. A later independent Job may select another member from then-current activity.
- The repository dogfood pool `luna-workers` contains the Pi/OpenCode Go/Luna/max route and native OpenCode/OpenCode Go/Luna/max route. Medium, high, and unmatched delegated children use this pool; the planner remains exact Pi/Luna/max, the low-complexity rule remains exact Pi/DeepSeek Flash/max, and quality review remains exact bounded Pi/Luna/max.

## Consequences

- Multiple upstream sessions that share the one local HTTP execution owner also share route activity and tie rotation. Separate processes do not coordinate pool counters; the existing single-writer rule remains the supported execution topology.
- Least-active counts admitted Jobs, not provider requests, tokens, latency, health, quotas, cost, model quality, or remote capacity. Pool membership and order are human-authored policy.
- Pools increase usable parallel downstream paths when independent work exists, but do not manufacture subtasks, raise the six-child product ceiling, add per-route capacity, or prove that a provider accepts a particular concurrency.
- No health scoring, circuit breaker, automatic failover, fallback, learned routing, model ranking, weighted scheduling, remote queue, or distributed lease is added.
- A pool can intentionally contain heterogeneous workers/providers/models, but the dogfood pool keeps provider/model/effort equal so this slice measures runtime distribution rather than quality differences.

## Verification

- The full deterministic suite passes 234 of 234 with the shared official service left running under a separate runtime directory.
- Configuration rejects route/pool name collisions, unknown or duplicate members, fewer than two members, unknown strategies, and pools in the exact-only planner boundary; dispatch defaults and rules accept valid pools.
- Deterministic concurrent Jobs prove explicit member traffic affects least-active choice and that equal-load ties rotate.
- Seeded admission failure proves the reservation returns to zero before the next selection.
- A selected two-attempt failing route invokes only that adapter twice and never calls the other pool member.
- A real `OrchestrationService` parallel two-child plan sent through one pool resolves to both exact routes and persists the logical target plus exact selection evidence on both Jobs.
- Parent records and compact controller handoff copy the child's exact route/pool evidence, and the persisted usage report groups selections by pool and exact member without inferring capacity or quality.
- One real two-Job `luna-workers` admission in a single runtime selected Pi/Luna/max for `job_7c757b67-b67a-4f2a-b41b-22a197242cb2` and native OpenCode/Luna/max for `job_0bea31f6-85bc-4d28-b555-1c372276fb2c`. Both succeeded on attempt one through their independent credential paths with checksum-valid empty artifacts and a clean source/worktree registry. Persisted usage reported exactly one selection for each member, 8,360 combined downstream tokens, and provider-reported cost `0.001499425`; no worker/model fallback occurred.

## Alternatives rejected

- **Put key rotation inside AgentKnot core:** rejected because key stores and provider clients belong to replaceable downstream runtimes.
- **One Pi plus one OpenCode special-case scheduler:** rejected because pool logic must operate on any complete routes.
- **Switch route on retry:** rejected because it silently changes execution identity and makes attempt evidence ambiguous.
- **Add health/cost/model scoring now:** rejected because current persisted evidence cannot justify an automatic ranking and the product explicitly keeps human policy authoritative.
- **Distributed counters:** rejected because the supported local topology already routes execution through one owner; a distributed scheduler would be a different roadmap stage.

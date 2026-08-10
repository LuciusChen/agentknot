# 0038: Route concurrent controllers through one local execution owner

- Type: Incident / Decision
- Status: Accepted
- Severity: High for stale pre-lock runtimes; expected refusal in current one-shot mode
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected versions/commits: stale checkout `da825cf`; shared-client work after `b54794f`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [incident 0010](./0010-read-only-cli-runtime-reconciliation.md), [decision 0022](./0022-file-runtime-single-writer-ownership.md), [decision 0030](./0030-pre-model-controller-dispatch.md)

## Summary

AgentKnot must support multiple concurrent upstream controller sessions without making each session a file-store writer. The existing local HTTP server is the correct single execution owner: it already holds storage ownership once, accepts multiple ordinary Job/Orchestration requests, and applies one shared orchestration task pool and route policy.

Controller integrations and CLI orchestration clients will therefore gain an explicit shared-server mode. When configured, clients submit, inspect, cancel, verify, and preview through the existing HTTP contracts and never open configuration storage or run startup reconciliation. They must fail clearly if the selected server is unavailable and must not silently fall back to another local writer, worker, provider, or model.

## Incident evidence

Another controller session ran checkout-relative `node dist/src/cli.js` from the obsolete `/home/lucius/agentknot` checkout at `da825cf`, while the supported repository was `/home/lucius/repos/agentknot`. The stale build predated both read-only CLI isolation and file-runtime ownership locks. A second stale CLI status/runtime construction marked active orchestration `orchestration_9a33faf0-5a1d-43b0-9636-b91a3c2b94ed` failed with `runtime_restart` while its original CLI and four Pi children continued running.

The user correctly restarted as `orchestration_320cf972-0875-45ea-a7a8-a6e7107c9d2d` and stopped issuing status commands from that checkout. The abandoned first process group `2496200` was mapped by orchestration/job IDs and terminated exactly; the restarted process group was left running. No source patch was promoted from the invalidated run.

The restarted audit later settled without intervention: one of four children succeeded and three failed explicitly when OpenCode Go returned its five-hour usage-limit `429`. A separate current-checkout review also failed all three children for the same provider limit, so neither incomplete audit was treated as implementation evidence. After both process trees exited and the stale checkout was confirmed clean, `/home/lucius/agentknot` was moved intact to recoverable archive `/home/lucius/agentknot.stale-da825cf-20260810` and replaced by a symlink to `/home/lucius/repos/agentknot`. The global executable already resolved to the canonical repository build.

Current code would refuse a second execution owner before reconciliation, so this exact corruption is not reproducible through conforming current binaries. It still does not meet the product requirement: a safe refusal is not concurrent controller support, and checkout-relative invocation makes version/config discovery unnecessarily fragile.

## Expected invariant

- Many Codex, Claude, CLI, or custom controller clients may submit concurrently to one local AgentKnot server.
- Exactly one execution-owning runtime mutates the configured file stores.
- All clients share the server's planner/child/reviewer concurrency policy and do not manufacture independent capacity.
- A client can disconnect and later inspect the durable orchestration without owning its worker process.
- Read/status clients never reconcile, lock, or mutate storage except through explicit server cancellation.
- Server selection is explicit and controller-neutral; failure never falls back to a different execution path or model.

## Decision rationale

- Reuse `agentknot serve` and the existing `/v1/orchestrations`, `/v1/jobs`, artifact, cancellation, route, and delegation endpoints. Do not add a second broker, RPC protocol, collaboration bus, or controller-specific daemon.
- Add one explicit client boundary selected by `--server URL` or `AGENTKNOT_SERVER_URL`. `--server` and `--config` are mutually exclusive because policy and storage belong to the server.
- The first controller slice covers the orchestration workflow used by Codex/Claude integrations: delegation inspection, submit/wait/cancel, orchestration list/show, artifact verification, and artifact preview. Direct HTTP remains available for other endpoints.
- When server mode is selected, the CLI does not call `createRuntime()`, read local configuration, acquire file ownership, or reconcile snapshots.
- Codex and Claude hooks use the same environment variable and CLI arguments. If it is set, they do not require a repository-local config file; if it is absent, the existing explicitly configured local workflow remains unchanged.
- Individual HTTP operations are bounded; orchestration duration remains governed by persisted route timeouts. A controller signal sends server-side cancellation and waits for terminal evidence.
- The current unauthenticated HTTP threat boundary remains local/trusted and must be documented. Remote or untrusted network exposure is not implied.

## Alternatives considered

- Allowing multiple file-backed CLI writers was rejected because whole-snapshot stores have no CAS/lease merge semantics and decision 0022 intentionally enforces one owner.
- Giving every controller a separate storage directory was rejected as the default because it fragments the shared task pool, usage evidence, artifact authority, and capacity limits.
- Retrying locally when the server is unavailable was rejected because it can duplicate work and bypass the shared concurrency limit.
- Adding Relay, Pi inter-agent messaging, a queue daemon, Unix socket protocol, or database was rejected as unnecessary for same-host concurrent controller submission.
- Making the hook probe and silently prefer a conventional port was deferred. Explicit server selection avoids surprising prompt disclosure and preserves repository-local opt-in.

## Consequences and gates

- Users start one local server and point any number of new controller sessions at it. Server lifecycle remains explicit; automatic service installation is not part of this slice.
- The server remains fail-without-resume. If it exits, current work is cancelled on catchable shutdown or reconciled failed by the next owner after an uncatchable loss.
- This is immediate bounded dispatch, not a durable restart-aware queue, admission lease, remote fleet, or multi-tenant service.
- Deterministic tests must launch at least two separate CLI client processes against one runtime and prove both complete without client storage ownership or reconciliation.
- Controller parity tests must prove server mode skips local config discovery, passes the exact source identity/workspace/prompt, preserves compact validation evidence, and adds no fallback.

## Verification

- `AgentKnotHttpClient` and CLI server mode reuse the existing HTTP endpoints for submission, terminal polling, cancellation, policy/routes, record inspection, and artifact list/verify/preview. Server mode has no `createRuntime()` path.
- Codex and Claude hooks select the exact URL with `AGENTKNOT_SERVER_URL`, never build a config path in that mode, and retain bounded failure context without fallback.
- The deterministic HTTP suite launches two separate Node CLI processes concurrently from a directory with no AgentKnot config. Codex and Claude requests complete as two distinct records in the same `OrchestrationService`.
- A canonical file-backed `agentknot serve` was then started on `127.0.0.1:7391`. Two separate real CLI processes connected concurrently, one with `--server` and one with `AGENTKNOT_SERVER_URL`; no-model `delegation: never` requests succeeded as distinct records `orchestration_4c8456ea-4d16-47cc-a8ef-5d57563e9645` and `orchestration_7c2fb71c-4ffb-41a2-802a-9619c9e8fc88` under the same execution owner.
- The implementation added no broker, queue, protocol, daemon manager, storage schema, route rule, model substitution, or worker-adapter branch.

## Privacy and security review

The server receives prompts and local workspace paths and can return full records and patch content. It has no authentication or TLS. Bind it to loopback, treat the configured URL as trusted, and do not place credentials in the URL. The stale-run evidence retains process/orchestration/job identifiers but no prompt content, API key, auth path, or patch bytes.

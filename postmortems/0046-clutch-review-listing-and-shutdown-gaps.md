# 0046: Close Clutch review, listing, and shutdown gaps

- Type: Incident / Decision
- Status: Resolved / Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Affected versions/commits: through `330e700`
- Related: [decision 0036](./0036-bounded-advisory-quality-review.md), [decision 0038](./0038-shared-local-controller-runtime.md), [decision 0044](./0044-required-worker-completion-and-canonical-worktree-id.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)
- Severity: Medium operational and review-quality risk

## Summary

Clutch dogfood confirmed three independent gaps. The configured quality reviewer received the patch but no repository inspection tools. `jobs --json` and `GET /v1/jobs` serialized every full Job, so 216 records totaling about 82 MiB exceeded the HTTP response budget. During graceful shutdown the listener closed before active work drained, leaving a deterministic interval where the process still held storage locks but accepted no connections.

The repository reviewer now receives bounded read-only repository tools. Job listing returns a byte-bounded summary page while exact lookup remains the full-record surface. Graceful shutdown rejects new admissions with 503, keeps liveness and read-only access available while admitted work cancels/drains, then closes the listener before runtime locks are released.

## Expected invariants

- A repository-aware quality review may inspect task-relevant source without gaining edit or artifact-promotion authority.
- A collection endpoint must remain bounded independently of the size of individual durable records.
- A process that owns storage locks must either remain reachable during graceful drain or have already released those locks.

## Evidence and root causes

- The dogfood reviewer worker used `--no-tools --no-context-files`; the supplied patch was bounded, but repository context required to verify surrounding contracts was unavailable.
- The file store contained 216 Job snapshots totaling 81,903,637 bytes; the largest record was 6,835,137 bytes. The server attempted to return the entire array even though its response writer was bounded near 17 MiB.
- `close()` called `server.close()` before cancelling and awaiting active Jobs/orchestrations. Runtime ownership locks were released only after `close()` returned, creating the lock-without-listener window by construction.
- Response streams also lacked a local error listener, so a disconnected large-list client could escalate a connection-local failure.

## Decisions

- `GET /v1/jobs`, `agentknot jobs --json`, the HTTP client, and the local CLI share a summary projection capped at 1 MiB. It contains identity, status, logical route name, timestamps, attempt, total, truncation, and bound metadata. `show JOB_ID` and `GET /v1/jobs/:id` remain the full-record interfaces.
- Review prompts permit only task-relevant repository inspection. The Pi dogfood profile exposes `read,grep,find,ls`; edits, patch application, repository commands, repair, recursion, conversation, promotion, and Git publication remain prohibited.
- Shutdown first closes admission, waits for in-flight admission decisions, cancels and drains active work while the listener remains live, then stops listening. New Job/orchestration POSTs receive an explicit 503 during drain.

## Alternatives considered

- Increase the HTTP response limit. Rejected because aggregate history remains unbounded and would fail again.
- Paginate full records immediately. Deferred because the compact page plus exact lookup closes the failure with a smaller v1 change; cursor semantics can be added only when required.
- Close the listener first and release locks immediately. Rejected because active work still needs the runtime and abrupt ownership release permits a competing writer.
- Give the reviewer a general shell. Rejected because source inspection does not require mutation or command execution.

## Consequences

The Job list representation is intentionally narrower; callers needing prompts, outputs, artifacts, or events must fetch a known Job ID. Graceful shutdown may remain reachable for the duration of bounded cancellation and cleanup, but no new execution is admitted. Review quality can use repository context without changing the advisory authority boundary.

## Corrective actions and gates

- [x] Maintainers — add the bounded shared Job-list projection — oversized deterministic HTTP/client/CLI coverage.
- [x] Maintainers — keep the listener live while active work drains and reject new admissions — deterministic close-order test.
- [x] Maintainers — add response-stream error containment — disconnected-response regression path.
- [x] Maintainers — replace the no-tool reviewer with read-only repository inspection — prompt and dogfood configuration tests.
- [x] Maintainers — run the complete isolated suite and record the final count before merge — final 243/243 passed after the dynamic workspace-focus follow-up.

## Privacy and security review

The incident sizes and generalized repository name are retained. Prompts, outputs, source contents, credentials, provider responses, and artifact bytes are excluded. The new list surface exposes less persisted content than before.

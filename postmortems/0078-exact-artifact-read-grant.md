# 0078: Authorize one exact artifact read without turning references into capabilities

- Type: Architecture Decision
- Status: Accepted / Implemented
- Date: 2026-08-12
- Owners: AgentKnot maintainers
- Affected versions/commits: AgentKnot 0.0.x Stage 2 contract work
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decision 0036](./0036-bounded-advisory-quality-review.md), [decision 0077](./0077-task-context-reference-manifest.md)

## Problem

`ContextManifest.references` deliberately carry unverified navigation metadata. Treating an opaque locator as read authority would conflate provenance with permission and invite arbitrary filesystem or network access. At the same time, quality review copied a verified patch into the reviewer's initial prompt, leaving no worker-neutral boundary for later selective context delivery.

## Decision

The first read use case is deliberately narrower than general context retrieval. An optional durable `JobRequest.artifactReadGrant` identifies one already recorded AgentKnot Git patch by source Job, attempt, kind, exact bounded size, SHA-256, base commit, and optional base tree. The exact size is also the byte ceiling; a second configurable budget would duplicate the identity without changing authority. The grant carries no path, content, URL, provider, model, or worker identity. Quality review is the first issuer and remains within its existing 32 KiB review ceiling.

Every Job attempt reconstructs one single-use `WorkerArtifactReader`. The reader resolves the exact source record, requires a terminal Job in the same normalized workspace, compares every granted identity field, and reruns artifact integrity and base verification. It never selects another attempt or falls back to current workspace contents. Missing, mismatched, stale, or truncated evidence fails once without retry. Before returning content, core persists `worker.artifact.read` evidence containing only identity, outcome/reason, call number, and byte count. A worker adapter that completes without one served read, suppresses a refusal, or attempts another read fails explicitly.

The core contract has no Pi branch. The Pi RPC adapter explicitly loads one product-owned extension while ambient extension discovery remains disabled. The extension registers the argument-free, single-use `agentknot_artifact_read` tool. Only when that tool executes does it send one versioned request over the attempt-owned Node child-process IPC channel. The adapter invokes the generic core reader, waits for its content-free audit event to persist, and then responds with the exact bytes; no artifact-content temporary file or environment locator exists. If Pi has a tool allowlist or denylist, the adapter adjusts only that attempt's argv so the required reader remains active; it does not mutate Pi settings or the configured worker definition. Attempt cleanup removes the content-free extension and strips tool arguments and raw result content from durable events.

Quality-review prompts now contain the goal, subtask, criteria, artifact identity, and bounded unverified worker claims, but not patch bytes. `ContextReference` locators remain metadata-only; a future source kind needs its own explicit grant issuer and evidence gate rather than automatic dereferencing.

## Boundaries and rejected alternatives

- No vector or semantic search, transcript replay, fixed worker session, external memory provider, general retrieval SPI, arbitrary file path, or network locator is added.
- No operating-system service, shell profile, global Pi extension, or persistent worker process is installed.
- Child-process IPC is an adapter protocol boundary, not an OS sandbox from the worker process, which already has the configured worker authority.
- A reviewer must receive the patch to assess it, so moving bytes from the initial prompt to a tool result does not by itself prove lower total model tokens. The capability is implemented; efficiency remains an A/B gate.
- Configurable read counts and a duplicate byte-budget field were rejected as unused flexibility. The first grant is exact and single-use; its recorded size is already an exact ceiling.

## Verification

Deterministic tests cover strict grant admission, fail-closed missing-source behavior without retry even when an adapter suppresses the exception, no eager Pi read when the tool is unused, quality-review prompt exclusion, exact grant persistence, content-free core audit evidence, explicit Pi extension injection, attempt-local tool-filter adjustment, extension cleanup, IPC delivery, and Pi event sanitization. An initial real bundle-backed run exposed the eager-consumption and bypass defect; it is not accepted as final evidence. Post-correction orchestration `orchestration_dfc0c230-c835-42c6-a150-cfd07ba25ba1` routed the bounded edit to DeepSeek V4 Flash/max and reviewer Job `job_53d33e1e-8a64-44e4-9191-c4f1877d648d` to Luna/max. The reviewer prompt contained no patch, its grant contained only the exact 155-byte identity, and durable order was Pi tool start, core `worker.artifact.read: served`, then sanitized Pi tool completion before an `accept` verdict. The final deterministic suite passes 305/305.

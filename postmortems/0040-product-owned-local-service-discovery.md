# 0040: Discover one running local service without shell-profile edits

- Type: Decision
- Status: Accepted
- Date: 2026-08-10
- Owners: AgentKnot maintainers
- Related: [decision 0038](./0038-shared-local-controller-runtime.md), [incident 0039](./0039-live-plugin-cache-refresh.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Context

Decision 0038 proved that multiple upstream sessions can safely share one HTTP execution owner, but its explicit `--server` / `AGENTKNOT_SERVER_URL` selection is too intrusive as the ordinary local experience. Adding a persistent export to `.zshrc` was immediately rejected: AgentKnot must not mutate unrelated shell startup behavior or require users to repeat endpoint setup in every controller session.

The correctness requirement remains unchanged. Many clients may exist, but exactly one runtime owns file storage and shared concurrency. Convenience must not reintroduce multiple local writers or silent model fallback.

## Decision

- A `127.0.0.1` `agentknot serve` registers its actual listening URL in one product-owned per-user runtime record only after listening succeeds. Ambiguous names, wildcard binds, other loopback spellings, and non-loopback addresses are not implicitly published.
- Before runtime construction, a publishing server acquires one kernel-held per-user discovery lock for its lifetime. This reuses the existing `flock` ownership mechanism and prevents conforming servers with different storage configurations from racing to become the implicit owner; it is not a daemon or new scheduling lock.
- The record lives below absolute `XDG_RUNTIME_DIR` when available, otherwise below an AgentKnot-owned directory in the user's home. It is not stored in a shell profile, target repository, controller transcript, or AgentKnot Job store.
- The record is schema-versioned, mode `0600`, size-bounded, strict about unknown fields, atomically replaced, and carries an unguessable registration identity. Its parent directory is mode `0700` when AgentKnot creates it; symlink records and unsafe automatic URLs are rejected.
- Graceful server shutdown first closes HTTP work and runtime ownership, then removes the record only when the current on-disk identity still belongs to that server, and finally releases the discovery lock. A hard crash releases kernel locks but may leave a stale endpoint; clients report the selected endpoint as unavailable and never fall back locally, while the next conforming server may replace the valid stale record after acquiring the lock.
- Automatic registration is restricted to loopback binding. A non-loopback or remote server remains explicit through `--server` or `AGENTKNOT_SERVER_URL` because the current HTTP API has no authentication or TLS.
- For client-capable CLI commands, selection precedence is: explicit `--config` for deliberate local maintenance; explicit `--server`; `AGENTKNOT_SERVER_URL`; registered local endpoint; existing local configuration behavior. Explicit `--server` and `--config` remain mutually exclusive.
- `serve`, local diagnostics, and local usage inspection do not redirect themselves through discovery. A small read-only client-status command exposes whether a record exists and whether the endpoint is live.
- Codex and Claude hooks first honor their existing explicit environment. Without it, they consult client status once; a registered endpoint removes repository-config discovery and is passed explicitly to the remaining CLI calls. Without a record, the existing repository-local opt-in remains unchanged.
- Neither server registration nor client discovery starts a daemon, installs an operating-system service, edits shell configuration, scans AgentKnot source, adds a broker, or creates a second protocol.

## Consequences

- Starting the one local server is sufficient for later Codex, Claude, and CLI sessions to find it; per-session exports are optional overrides rather than setup.
- Service lifecycle remains explicit in this slice. A future one-command bootstrap may configure an OS supervisor, but it requires a separate cross-platform lifecycle decision.
- A stale record produces a clear shared-server error. It is intentionally not permission to open repository storage or launch a replacement worker/model path.
- Multiple servers with different configurations can still be addressed explicitly, but only the latest successfully registered loopback server is the implicit local endpoint.

## Verification gates

- No test or implementation writes `.zshrc`, `.profile`, controller configuration, or a target repository during endpoint registration.
- Deterministic tests cover record permissions and schema, strict URL/file validation, discovery-lock contention, atomic replacement identity, exact-owner cleanup, explicit precedence, graceful unregister, stale endpoint failure without local fallback, and non-`127.0.0.1` non-registration.
- Separate CLI processes with no server option or environment discover one registered server and complete distinct requests through its single runtime.
- Codex and Claude parity fixtures prove registered mode skips repository config access and preserves exact source, workspace, prompt, handoff, and artifact behavior.

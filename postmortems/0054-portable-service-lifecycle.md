# 0054: Make controller service lifecycle portable and explicit

- Type: Incident / Decision
- Status: Resolved / Accepted
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Affected versions/commits: `246a05c` and earlier local-service integrations
- Related: [0038](./0038-shared-local-controller-runtime.md), [0040](./0040-product-owned-local-service-discovery.md), [0053](./0053-controller-owned-planning-handoff.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Incident

A resumed Chirp controller correctly loaded the delegation Skill and authored a strict assessment, but no downstream work ran. No shared endpoint was registered, so the ordinary CLI precedence fell through to `/home/lucius/repos/twitter-cli/agentknot.config.json` and failed with `ENOENT`. The controller then answered from earlier upstream reads without disclosing that the promised delegation had produced no orchestration, Job, or downstream usage.

The missing server was not only an operator mistake. The controller integration presents shared automatic delegation while service lifetime is still an undocumented foreground-process prerequisite. Treating a Linux systemd user unit as the product fix would leave macOS and Windows with different ad hoc instructions. The existing runtime ownership helper also spawns the external POSIX `flock` command, so merely adding launchd would not make the execution owner portable.

## Decision

1. Keep one foreground `agentknot serve` implementation as the only HTTP/runtime/scheduler owner.
2. Replace the external `flock` helper with a lifetime-exclusive transaction held in a small Node built-in SQLite lock database. The operating system releases the database lock on close or process death; Linux, macOS, and Windows use the same ownership implementation without a third-party daemon or native add-on.
3. Add one narrow service-host interface whose implementations only install, start, stop, query, and uninstall that same foreground process. Linux uses the user systemd manager and macOS uses a LaunchAgent. Unsupported platforms fail explicitly behind the same interface until their real host adapter passes the contract; they never pretend that a detached child is a supervised service.
4. Persist the absolute config, Node executable, CLI entry point, loopback host, and port in the native service definition. Runtime discovery remains an endpoint/liveness record, not a configuration or installation registry.
5. Keep service installation explicit and reversible. Hooks do not install services, edit shell profiles, spawn detached daemons, or choose configuration.
6. Controller Skills require either an explicitly selected local config or an available shared endpoint before orchestration. Packaged automatic delegation uses the shared endpoint; `unconfigured` stops before admission and must be reported as zero downstream work. It cannot fall through to the target repository's config.
7. One orchestration still has one authoritative workspace. Cross-repository work uses separate assessments/orchestrations and upstream synthesis rather than expanding the core request into a multi-workspace graph.

## Why this boundary

- Native service managers already solve login startup, crash restart, log ownership, manual stop, and upgrade replacement. Reimplementing those semantics in Node would be a larger and less reliable daemon manager.
- A shared service-host contract contains platform differences without branching the runtime, scheduler, controller adapters, or worker routes.
- Built-in SQLite removes the existing POSIX ownership dependency at the actual core boundary instead of hiding it behind platform setup instructions.
- Explicit installation preserves user authority over a long-running credential-bearing process. Automatic client discovery remains read-only and race-safe.

## Evidence and implementation

- `src/runtime-ownership.ts` now opens one hidden built-in SQLite database per canonical storage directory and holds `BEGIN EXCLUSIVE` until `RuntimeOwnership.close()`. Deterministic separate-process tests cover contention, canonical ordering, duplicate-path refusal, partial cleanup, repeated close, and release after normal or abrupt process exit. The external `flock` process and its readiness/termination protocol were deleted.
- `src/service-host.ts` contains one native-host contract and two adapters. It writes only AgentKnot-marked, current-user-owned mode-0600 definitions through a temporary file plus atomic rename. Linux delegates to `systemctl --user`; macOS delegates to `launchctl` in the current `gui/UID` domain. Native failures remain failures, and unsupported platforms are explicit.
- The first installed systemd-user definition started the shared server but did not provide the interactive shell `PATH`. Orchestration `orchestration_755a52ae-e28c-4fd6-911d-3a4d165de7ea` selected Pi/Luna/max and failed because `pi` was not discoverable. Capturing arbitrary ambient environment or provider secrets was rejected. Installation now persists only a validated absolute-entry `PATH`, and operators can replace it explicitly with `service install --path`.
- With the same shared execution owner, `orchestration_2853afc8-80ca-4317-997c-7ab889d31900` selected native `opencode-luna`, emitted compact progress, returned a valid completion report, and succeeded with an empty patch. After reinstalling the definition with the non-secret `PATH`, Job `job_ed5c9c7c-818e-4628-adf0-4f44dac28908` completed through Pi → OpenCode Go → gpt-5.6-luna at `thinkingLevel=max`. No provider key was embedded in the unit.
- A later concurrent dogfood pair proved the shared pool did not privilege Pi: while `luna` was active, orchestration `orchestration_a1c92d3d-4186-479a-9d7f-9515ad73bb83` persisted `activeBefore={luna:1, opencode-luna:0}` and selected `opencode-luna` automatically. The separate broad Pi audit was cancelled after retrying because its scope exceeded the useful waiting boundary; cancellation returned a terminal record rather than becoming orphan work.
- Two earlier generated service-host drafts were rejected instead of accumulated: one introduced more than 700 implementation lines and incorrect launchd stop semantics, while the second hid native manager errors and did not activate on install. The accepted implementation keeps one foreground server, one small host boundary, and no virtual filesystem, detached-child supervisor, or second scheduler.

## Rejected alternatives

### Document a systemd unit

Rejected as the product solution. It fixes one machine while leaving macOS unsupported and does not remove the core `flock` dependency.

### Spawn a detached child from every hook or CLI

Rejected. Cross-platform detachment, crash restart, logs, stop semantics, upgrades, Windows consoles, and orphan cleanup would become AgentKnot's responsibility. Hook startup would also mutate long-lived state before the controller turn.

### Run one local runtime per controller process

Rejected. It recreates file-owner contention, fragments concurrency, and loses shared active-request handles.

### Add multi-workspace orchestration

Rejected for this incident. Separate repository analyses already compose at the controller boundary and do not require another graph, scheduler, permission model, or artifact authority scheme.

## Consequences

- New and resumed controllers can share one execution owner after one explicit user-service installation; automatic adapters no longer depend on a target repository containing AgentKnot configuration.
- Linux and macOS lifecycle syntax is uniform at the CLI while native supervision, login startup, crash restart, logs, and stop semantics remain owned by the operating system.
- Windows remains unsupported by `agentknot service`; manual foreground `serve` is still available. A Windows adapter requires its own native lifecycle contract tests rather than detached-child emulation.
- Reinstalling refreshes the stored config/executable/`PATH` values and restarts the service. Worker credential stores remain separately owned and are not copied into the service definition.

## Gates

- [x] Replace external `flock` ownership with the built-in SQLite lifetime lock and cross-process contention/crash tests.
- [x] Implement one fake-host contract plus Linux systemd-user and macOS launchd render/command tests.
- [x] Add explicit service install/start/stop/restart/status/uninstall CLI behavior with safe exact-file ownership.
- [x] Make packaged Skills require an available shared endpoint and disclose all pre-admission failures.
- [x] Preserve hook parity, controller-owned planning, one runtime owner, route neutrality, and no shell-profile mutation.
- [x] Install the dogfood service through the new interface and prove both Pi and native OpenCode pool members execute through the shared owner.
- [x] Keep production growth bounded by deleting the external ownership helper, rejecting oversized drafts, and removing superseded fallback instructions.

## Deferred work

- Add a Windows native service adapter only after its install/start/stop/status/uninstall contract can be tested without detached-child emulation.
- Controller-triggered detached terminal notification remains separately gated on an idempotent native resume entry. General agent chat or peer-to-peer coordination is not part of this fix.
- If a supported operating system can delete and recreate its per-user runtime directory while keeping the supervised server process alive, the discovery lock and record need a separately designed re-registration contract. AgentKnot does not guess the default port or silently bypass missing ownership evidence.

## Privacy and security review

No credential values, prompts from other repositories, or controller transcripts are included here. The installed definition contains paths, host, port, and `PATH`, which are local operational metadata; it does not copy provider API keys or arbitrary ambient environment variables.

## Addenda

### 2026-08-11: user-runtime directory anomaly

During final verification, `systemctl --user stop agentknot.service` returned a native user-bus transport error. The exact supervised Node process and port 7391 listener remained healthy, but `/run/user/1000/agentknot/server.json` was absent, so discovery correctly reported `unconfigured` instead of guessing the live endpoint. The same user manager's `Restart=on-failure` policy started a fresh exact server after the verified inactive-work process was fault-terminated; the new process republished a mode-0600 record and a second SQLite owner was refused.

The cause of the wider missing user-bus/runtime control sockets was not established as an AgentKnot write, so this record does not claim that a periodic self-healing timer is justified. Native manager errors remain visible, and a missing record remains a pre-admission failure. The deferred gate above should reopen only with a reproducible supported-host lifecycle that can preserve single-owner safety while re-registering.

# 0003: Keep background Pi workers skill-minimal by default

- Type: Decision
- Status: Accepted
- Date: 2026-08-08
- Owners: AgentKnot maintainers
- Affected versions/commits: `a22b7ce`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Summary

The default Pi worker command includes `--no-skills`. Background workers still receive repository context such as `AGENTS.md`, but they do not automatically load all globally discovered Pi skills. Task-specific worker extensions should be added only when a demonstrated need and security review justify them.

## Context

During Pi setup, startup output showed a large collection of unrelated globally available skills. AgentKnot's first Pi use case is bounded coding execution. Loading mail, calendar, document, approval, and other external-system capabilities into every background coding job increases prompt noise and execution authority without helping the task.

Pi itself was sufficient for the initial worker path: RPC mode, model/provider selection, repository instructions, file editing, shell execution, and lifecycle events. OhMyPi or broad plugin packages were not required to prove the architecture.

## Expected invariant

- Worker capabilities are minimal and explicit.
- Repository-owned instructions remain available to the worker.
- External tools, credentials, or services are not added speculatively.
- AgentKnot does not make Pi extensions part of its portable core contract.

## Evidence chronology

1. Pi was installed and authenticated with the OpenCode Go provider.
2. The initial Node 23.1 runtime produced a `zlib.createZstdDecompress` compatibility failure in Pi's HTTP dependency stack.
3. Pi startup showed many unrelated discovered skills.
4. AgentKnot configured the Pi worker with `commandArgs: ["--no-skills"]`.
5. Route diagnostics and real Pi/Luna jobs later succeeded with the active Homebrew Node 26.7.0 runtime and Pi's external credential file.
6. A later Pi/Luna architecture review ran through AgentKnot with no task-specific plugin and changed no files.

## Decision rationale

The background worker should have the narrowest capability set that completes its coding contract. Project context belongs in versioned repository files such as `AGENTS.md`; global skills are ambient executable integrations with their own instructions, credentials, and failure modes.

Disabling automatic skill discovery improves reproducibility and makes the worker path less dependent on one machine's personal setup. It also avoids confusing controller extensions with worker requirements.

## Alternatives considered

### Load all installed Pi skills

This is convenient interactively but grants unrelated external-system context and capability to every job. It was rejected as the default.

### Adopt OhMyPi immediately

OhMyPi may provide useful opinionated configuration, but it introduces another distribution and convention layer before a missing capability has been demonstrated. Compatibility can be evaluated later through an adapter or explicit profile.

### Disable repository instructions as well

This would remove relevant project constraints and reduce worker quality. `--no-skills` is intended to disable discovered skills, not `AGENTS.md` or task instructions.

### Build AgentKnot-specific skills first

Controller skills can make submission convenient, but the CLI/HTTP/TypeScript contract is the automation foundation. Skills should call that contract instead of becoming the only integration.

## Consequences

### Positive

- Real Pi jobs depend on fewer ambient machine-specific resources.
- Global external integrations are not exposed accidentally.
- Repository instructions become the auditable worker guidance.
- Pi remains replaceable by another adapter.

### Costs and risks

- A task that genuinely needs a specialized tool requires an explicit worker profile or extension.
- Personal Pi sessions and AgentKnot background jobs may behave differently.
- `--no-skills` alone is not a security sandbox and does not restrict shell, filesystem, network, or inherited credentials.
- Pi CLI semantics can change and require a compatibility check.

## What went well

The real-worker path was tested early, revealing both the Node runtime incompatibility and unwanted ambient skill discovery. Route diagnostics can use Pi's auth file without copying the key into AgentKnot configuration.

## What did not go well

The first Pi launch used Node 23.1, which lacked the zstd API expected by the installed dependency stack. Pi's effective Node compatibility was not checked before launch. The initial project instruction file was also too small to replace useful coding discipline after global skills were disabled.

## Corrective actions and gates

- [x] Keep AgentKnot's own Node baseline explicit and run the current Pi installation on the verified Node 26.7.0 runtime.
- [ ] Make `doctor` detect Pi/runtime incompatibility instead of assuming AgentKnot's Node baseline is sufficient — Stage 1.
- [x] Add `--no-skills` to the default Pi worker command.
- [x] Expand repository-owned `AGENTS.md` with architecture, lifecycle, security, and test rules.
- [x] Add a documented explicit profile mechanism before enabling task-specific Pi extensions — see decision 0012.
- [ ] Add Pi CLI compatibility checks to adapter conformance — Stage 2.
- [ ] Pin and review any third-party extension before it becomes a supported profile.

## Deferred work

OhMyPi compatibility and task-specific Pi plugins remain deferred until a concrete job cannot be served by the skill-minimal worker. Any future extension must preserve controller and worker portability.

## Addenda

### 2026-08-09: Broaden ambient isolation and admit evidence-gated profiles

The Pi adapter now disables ambient extensions, skills, prompt templates, and themes for both normal runs and live probes while deliberately retaining repository context files. Explicit resource arguments still work, so isolation does not prohibit a reviewed task profile. Successful normal jobs also capture sanitized advisory Pi session statistics. The explicit profile mechanism and promotion gate are defined by [decision 0012](./0012-evidence-gated-pi-profiles.md); no third-party profile was promoted by this implementation alone.

## Privacy and security review

No credential values, auth-file contents, prompts, or job output are included. Disabling skills reduces ambient capability but does not create host isolation.

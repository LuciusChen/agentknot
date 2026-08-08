# AgentKnot contributor instructions

## Project intent and boundaries

- Keep controller, worker, and provider as separate dimensions. Codex, Claude, CI, and custom callers must use the same Job API.
- Do not add a controller-vendor branch when the behavior belongs in the controller-neutral Job API, routing, lifecycle, or event model.
- Keep worker adapters narrow: translate between AgentKnot types/events and one worker protocol. Do not move orchestration policy into Pi, OpenCode, Grok, or another adapter.
- Keep provider/model selection in routes. A provider change should not require controller or core-orchestrator changes.
- Keep workspace preparation, retry isolation, artifact capture, cancellation, and cleanup in the orchestrator-owned lifecycle.
- Patch artifacts are handoff data. Never apply them to the caller's repository automatically; promotion must remain an explicit controller action.
- Worktree isolation protects repository state, not the host operating system. Do not describe it as a security sandbox.

## Change and diagnosis discipline

- Before a material product or architecture change, read `docs/PRD.md`, `docs/SPEC.md`, the active stage in `docs/ROADMAP.md`, and relevant records under `postmortems/`.
- Map proposed work to a PRD problem, a roadmap exit gate, one owning boundary, and deterministic verification. If it cannot name a current-stage gate, keep it out of implementation unless the task explicitly changes the roadmap.
- Inspect the relevant code, tests, configuration, and documentation before changing behavior. Answer questions from local evidence before asking the user.
- Find and name the root cause before patching timing, retries, caching, parsing, or control flow. Fix the layer that owns the problem.
- Keep experiments to the smallest slice that proves the direction. Do not expand scope before the slice demonstrates value.
- Prefer direct, boring code over speculative abstractions. Three clear lines are better than a one-use wrapper or premature framework.
- Add a module only for a stable responsibility, external boundary, or resource lifecycle. Do not create vague `common`, `utils`, or `helpers` dumping grounds.
- Move whole responsibilities together: state, validation, operations, cleanup, and formatting that enforce one invariant should have one owner.
- Do not stack compatibility shims, silent fallbacks, duplicate lookups, or swallowed errors around a wrong-layer design.
- Use only public dependency APIs. Do not reach into another package's private or internal modules.
- Add a dependency or Pi extension only for a current, demonstrated need. Prefer project-owned code when the requirement is small and security-sensitive.

## TypeScript and module discipline

- Keep TypeScript strict. Do not weaken compiler options to make a change pass.
- Treat JSON, configuration, environment variables, HTTP input, RPC events, and provider responses as `unknown` until runtime validation narrows them.
- A type assertion is not validation. Keep unavoidable assertions local and justified by nearby evidence; avoid double assertions and unjustified non-null assertions.
- Use discriminated unions for modes, states, adapters, events, and artifacts instead of parallel booleans that permit impossible combinations.
- Annotate exported functions and public boundaries; let TypeScript infer obvious local types.
- Use `import type` and `export type` for type-only dependencies.
- Prefer plain data and functions for transformations. Use classes when they own mutable state, protect invariants, or manage resources.
- Keep constructors cheap and synchronous. Put I/O and asynchronous setup in explicit methods or factories.
- Use ECMAScript modules consistently. Do not introduce CommonJS except at an explicit compatibility boundary.
- Keep Node.js and TypeScript baselines explicit. Verify when an API was introduced before relying on it, and update metadata and README together if a baseline changes.

## Async, error, and lifecycle discipline

- Await or return every promise. A deliberately detached promise must be obvious and have a boundary-level error handler.
- Use `AbortSignal` and timeouts for work that a controller can cancel. Cancellation or timeout must not be reported as success even if a worker returns normally afterward.
- Clean up child processes, timers, listeners, worktrees, and temporary files in `finally` paths that run on success, failure, retry, timeout, and cancellation.
- Catch errors only to add actionable domain context, perform bounded cleanup/recovery, or convert them at a process/HTTP/worker boundary. Never swallow an internal failure and return a plausible default.
- Preserve the original error with `cause` when wrapping it. Error messages should identify the failed boundary without exposing credentials.
- Keep retry attempts independent and deterministic. Every isolated retry starts from the recorded base commit, not from a previous attempt's partial edits.
- Cleanup operations must target exact paths generated and owned by AgentKnot. Never use broad recursive deletion, unresolved globs, or repository-wide cleanup that can touch unrelated worktrees.

## Protocol and security discipline

- Pi RPC is strict LF-delimited JSONL. Decode streaming UTF-8 chunks explicitly; do not parse it with Node's `readline` API or assume chunk boundaries equal message boundaries.
- Normalize worker-specific events at the adapter boundary. Core job events must not expose a provider-specific transport shape as their contract.
- Keep secrets in environment variables or external credential stores. Never place API keys, tokens, auth-file values, or authorization headers in configuration fixtures, Job records, events, logs, tests, or patch artifacts.
- Do not read or print credential values during diagnostics. Checking whether a provider entry exists is sufficient.
- Treat callback URLs and external repositories as trusted-input features until explicit authentication, allowlists, and network policies exist. Do not imply otherwise in documentation.
- Third-party Pi packages and extensions execute with the Pi process's permissions. Review and pin them before use; do not install broad global packages as a shortcut.

## Testing discipline

- Add a deterministic test for every new adapter, runtime validator, public state transition, retry rule, cancellation path, or resource-cleanup invariant.
- For a bug fix, first make an existing test fail for the right reason or add a focused reproducer, then implement the fix.
- Test the real public or dispatch path for routing, HTTP, RPC, callbacks, hooks, and lifecycle bugs. Helper-only tests are not enough when the failure occurs in integration.
- Assert outcomes that distinguish correct behavior from a hard-coded result. Include meaningful boundary inputs rather than one happy-path fixture.
- For worktree behavior, prove the source repository remains clean, attempts use distinct paths, patches contain tracked/untracked/binary changes, patches apply to the base, and managed paths are removed.
- Cover success, failure, retry, timeout/cancellation, and concurrency when changing shared lifecycle code.
- Keep tests proportional. Documentation-only wording changes do not need product tests unless the text defines an executable contract.
- Run `npm test` after code or configuration changes. Before committing, also run `git diff --check` and read the complete diff.

## Documentation and repository discipline

- Update README in the same change when defaults, configuration, commands, runtime requirements, integrations, or user-visible workflows change.
- Keep document roles separate: PRD defines why and scope, SPEC defines stable behavior, ROADMAP defines sequence and gates, and postmortems preserve historical evidence and rationale.
- Update PRD, SPEC, ROADMAP, and README together when a change alters their respective truth. Do not use a future roadmap item as evidence that a capability exists now.
- Add a postmortem/decision record for significant boundary decisions, incidents, abandoned approaches, external integrations, misleading capability claims, or deliberately deferred limitations. Supersede historical records with addenda or new records instead of rewriting their original conclusion.
- Code and tests are the source of truth. Do not document commands, compatibility, security properties, or model/provider behavior that has not been verified.
- Describe capabilities through concrete user outcomes before internal implementation details.
- Keep generated output and runtime state out of commits: `node_modules/`, `dist/`, `.agentknot/`, logs, credentials, and local environment files stay untracked.
- Do not commit, tag, publish, apply artifacts, or push unless the task explicitly requests that action.
- Do not reformat unrelated files or rewrap unchanged documentation paragraphs as part of a focused change.

## Worker handoff

- Follow the task's requested scope and preserve unrelated user changes.
- In an isolated worktree, remember that ignored dependencies and build outputs are absent. Install or generate only what the task actually needs.
- At completion, report the design or root cause, files changed, tests actually run, and remaining limitations. Never claim a test or external integration passed without evidence.

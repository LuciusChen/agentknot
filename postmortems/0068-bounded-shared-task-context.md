# 0068: Bound shared task context without worker-session coupling

- Type: Incident / Architecture Decision
- Status: Resolved / Accepted
- Implementation: Delivered in this slice
- Date: 2026-08-11
- Owners: AgentKnot maintainers
- Related: [decision 0053](./0053-controller-owned-planning-handoff.md), [incident 0052](./0052-bounded-analysis-and-observable-waiting.md), [decision 0067](./0067-route-tool-execution-budget.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md)

## Context

The strict controller-owned handoff removed hidden prompt interception, but each child still received only the broad parent goal and its subtask. Real workers repeatedly rebuilt context by reading architecture and history outside their acceptance scope. One narrow broker-lifecycle task used 58 distinct tool calls and 29 reads, including broad product documents and postmortems. A dead-code/documentation audit used 74 distinct calls. During this investigation, orchestration `orchestration_db0b8a16-88af-4acf-9c70-909580763deb` left the repository, searched user cache/configuration paths, and started the full test suite; it was cancelled after 48 distinct calls. These outcomes do not prove that every read was useless, but they prove that prompt scope alone did not supply an efficient initial working set.

Giving one controller session a fixed Pi session appeared to avoid repeated discovery. Inspection of the installed Pi runtime showed otherwise: a fork copies a session branch and the model context is rebuilt and sent again. No safe cross-process shared-append lock was evidenced, and concurrent child Jobs must not mutate one conversation. A retained worker session would therefore add lifecycle, concurrency, growth, and adapter coupling without making prompt input free.

## Decision

- Add optional schemaVersion 1 `TaskAssessment.context` with exactly `summary`, `relevantPaths`, and `constraints`.
- Cap the summary at 1,000 characters, each array at 20 unique entries of at most 500 characters, and the complete compact UTF-8 JSON at 2 KiB. Paths must be repository-relative and may not traverse parents.
- The controller constructs the context only from facts already present in its conversation. It must not read a transcript, scan the repository, or copy file bodies merely to manufacture context; omission remains valid.
- Validate and defensively copy the context at the common orchestration boundary, persist it with the admitted request, and include it in the deterministic plan hash.
- Project the same context text before each selected child's task-specific delta. Treat it as unverified navigation guidance: begin with the named working set, verify only acceptance-relevant facts, and report missing or stale guidance before expanding.
- Keep correctness independent of Pi sessions/forks and provider prompt caching. The identical prefix is cache-friendly when a provider supports caching, but cache behavior is not part of the contract.
- Add no context store, memory service, controller-session binding, transcript capture, vector index, repository scanner, model/provider branch, or middleware planner.

## Consequences

Every stateless model invocation still has to receive the small shared prefix. At the hard maximum this adds roughly 2 KiB per child before transport framing, not an unbounded history; the repository maximum of six children therefore bounds the repeated text to about 12 KiB. Identical placement lets provider caching reuse it where available, but no token, latency, completion-rate, or cache-hit improvement is claimed until a repeated same-task comparison measures it.

The controller need not reproduce worker repository reading. It supplies only known navigation facts and task boundaries. Workers retain authority to report that the guidance is stale or incomplete, so a mistaken controller context does not become verified evidence.

## Verification

- Strict validation covers unknown keys, absolute paths, duplicate paths, defensive copies, summary bounds, and the whole-object UTF-8 byte limit.
- The context changes the plan hash, survives TypeScript/CLI/HTTP/MCP admission, persists with the request, and appears in child Job prompts.
- A two-child deterministic test proves the text before the child-specific `Subtask` section is byte-identical.
- Existing assessments that omit `context` remain valid.
- Controller integration parity tests keep the Codex and Claude Skills normalized and route-neutral.

## Alternatives rejected

- **Send the full controller transcript or repository documentation:** repeats a large, stale payload and leaks unrelated context into every worker.
- **Create a context service, vector store, or repository index:** adds a second state authority and substantial implementation surface before the bounded handoff is measured.
- **Bind each upstream session to one mutable Pi session:** couples the core to one adapter, serializes or races concurrent children, and still sends accumulated model context.
- **Fork a Pi session for every child:** copies conversation state but does not eliminate model input or session-file lifecycle.
- **Rely only on semantic scope and route tool budgets:** prevents some runaway execution but does not give workers an efficient initial working set.

## Privacy and security review

The context is persisted wherever the assessment is persisted and is later sent to each selected worker. It must contain no credentials, raw transcript, file bodies, or unrelated personal data. The 2 KiB limit bounds size, not sensitivity or redaction; callers remain responsible for the supplied text.

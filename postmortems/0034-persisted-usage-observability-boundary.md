# 0034: Report exact persisted usage without inventing controller telemetry

- Type: Decision
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Affected versions/commits: unreleased after `3afb539`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [decision 0030](./0030-pre-model-controller-dispatch.md), [experiment 0032](./0032-pre-model-multi-child-evidence.md)

## Summary

AgentKnot now reports exact available downstream Pi token/cost totals, cache-read hit rate, and persisted route-selection rule/default hit rates through one read-only runtime/CLI projection. It does not report upstream controller tokens or upstream/downstream proportions as numbers because the current persisted contract contains no comparable exact controller usage. Missing upstream data is represented as `controller-usage-not-persisted`, never as zero.

## Context and invariant

Measured Codex experiments showed that pre-model dispatch can substantially reduce upstream input, while Pi session statistics showed the work shifted downstream. Users need an ordinary report rather than manual postmortem arithmetic, including whether low-complexity routing actually hit the DeepSeek rule. The product invariant is that observability must distinguish exact, partial, and unavailable evidence; controller identity, historical experiment numbers, current configuration, or missing fields cannot stand in for measured usage.

## Evidence

- Successful normal Pi Jobs already persist an allowlisted `result.metadata.sessionStats` projection with input, output, cache-read, cache-write, total tokens, provider-reported cost, and explicit timeout/unsupported/invalid states. Failed/cancelled Jobs, live probes, legacy Jobs, and some non-Pi Jobs do not supply this evidence.
- Terminal Orchestration plans already persist active/shadow route-selection evidence with `basis: "rule" | "default"`, route, and optional rule index alongside the immutable effective policy snapshot.
- `JobRequest.source` and `OrchestrationRequest.source` are opaque identities, not usage. Neither terminal record has a controller token field.
- Official Codex hook input for `Stop` and `SessionEnd` contains session/turn identity, transcript location, model, and terminal message/reason fields but no token usage. The same documentation says transcript format is not a stable hook interface. Stable Codex usage exists on other boundaries such as `codex exec --json`, app-server token events, and OpenTelemetry, but the current thin pre-model plugin owns none of those streams and cannot correlate them into AgentKnot records without a new contract.
- The first real repository report after implementation found exact downstream statistics for 109 of 123 successful Jobs, classified 49 of 74 planned-subtask route selections, and left the missing portions explicit. These cumulative local values are validation evidence, not a benchmark or release promise.

## Decision rationale

One read-only fold at the runtime boundary is the smallest implementation that turns already-retained evidence into a useful report. It counts each successful terminal Job once, sums valid safe numeric fields before calculating the cache-read hit rate, separates active from shadow route evidence, and validates each classification against the record's own immutable policy snapshot. This keeps aggregation outside Pi, presentation outside persisted schemas, and routing unchanged.

Cache-read hit rate is defined as `sum(cacheRead) / (sum(input) + sum(cacheRead))`. Output and cache-write tokens are excluded because they are not cache-read opportunities. Route-rule hit rate is `rule / (rule + default)` within active or shadow mode. These are named formulas, not provider intelligence rankings or cost optimization scores.

## Alternatives considered

- Parsing Codex transcripts was rejected because the format is explicitly unstable and would introduce a controller-specific inference path.
- Treating absent upstream data as zero was rejected because it would fabricate a downstream 100% share.
- Reading account quota summaries was rejected because account-wide activity is not correlated to one AgentKnot record scope or necessarily measured in comparable units.
- Adding a telemetry database, background collector, JSONL import path, provider pricing table, dashboard, or HTTP endpoint was deferred as unnecessary implementation expansion for the demonstrated need.
- Recomputing historical route decisions from current configuration was rejected because it would rewrite evidence after policy changes.

## Consequences and gates

- `agentknot usage` and `runtime.usage()` are read-only and can be used while another conforming runtime owns execution storage.
- Exact subset totals remain visible under partial coverage; valid zero statistics remain different from unavailable data; unsafe aggregate arithmetic becomes unavailable rather than rounded.
- Provider-reported cost has no implied currency conversion or cross-provider comparability.
- Upstream/downstream proportions require a future versioned controller-usage contract with exact correlation and comparable token units. Until then they remain structurally unavailable.
- This report does not determine model intelligence, change route selection, add fallback, or prove subscription quota consumption.

## Verification

Deterministic tests cover weighted multi-Job aggregation, partial unavailable reasons, valid all-zero statistics, active/shadow rule/default grouping, policy-inconsistent route evidence, explicit unavailable upstream/proportion output, and the public read-only CLI path. The complete suite must pass before promotion.

## Privacy and security review

The report reads only already-retained numeric usage, route names, rule indices, and record counts. It does not expose prompts, output, transcript content, credentials, session paths, session identifiers, or raw provider responses, and it performs no network request.

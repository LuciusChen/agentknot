# 0011: Name HTTP process liveness without implying route readiness

- Type: Decision
- Status: Accepted
- Date: 2026-08-09
- Owners: AgentKnot maintainers
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [README](../README.md), [incident 0008](./0008-route-diagnostics-false-ready.md)

## Context

The original `GET /health` response proved only that the HTTP process could answer a request, but its generic name and `{ "ok": true }` payload could be mistaken for storage, route, credential, worker, provider, or model readiness. Incident 0008 already demonstrated that configuration readiness and real Luna inference are different claims.

## Decision

`GET /health/live` is the canonical HTTP process-liveness endpoint. `GET /health` remains an identical compatibility alias. Both return one explicit payload:

```json
{
  "ok": true,
  "service": "agentknot",
  "status": "live",
  "checks": {
    "storage": "not-checked",
    "routes": "not-checked",
    "inference": "not-checked"
  }
}
```

Health handling must not call runtime methods, touch stores, inspect credentials, probe a worker/provider/model, or create Job or Orchestration records. `GET /health/ready` remains absent. Configuration diagnostics stay in CLI `doctor`, while real point-in-time route evidence requires the explicit CLI `doctor --live --route NAME` operation.

## Consequences

- Load balancers and supervisors have an unambiguous, cheap liveness endpoint.
- Existing `/health` clients remain compatible while receiving a more explicit additive payload.
- HTTP liveness cannot be cited as route readiness or provider availability evidence.
- Adding HTTP readiness later requires a separate evidence-backed contract, including cost, timeout, authorization, caching, and provider-error semantics.

## Alternatives considered

### Keep only the generic `/health` endpoint

Rejected because naming and payload ambiguity would remain.

### Make liveness call configuration doctor or live inference

Rejected because liveness must remain cheap and side-effect-free. Credentials, provider reachability, rate limits, latency, and regional availability are separate failure domains.

### Add `/health/ready` immediately

Deferred. AgentKnot has no accepted HTTP readiness contract, and silently mapping readiness to either configuration checks or paid inference would repeat the ambiguity this decision removes.

## Verification

A guarded-runtime HTTP contract test proves `/health/live` and `/health` return byte-identical expected payloads without accessing the runtime, while `/health/ready` returns the existing 404 response. The complete suite passes 79/79.

## Privacy and security review

The liveness response contains no configuration, route names, filesystem paths, process identifiers, credential metadata, provider errors, prompts, records, or model output. The endpoint remains unauthenticated and suitable only for the same trusted local network boundary as the rest of the MVP server.

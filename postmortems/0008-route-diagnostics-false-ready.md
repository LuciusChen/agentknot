# 0008: Separate configuration readiness from live Luna inference

- Type: Incident
- Status: Resolved
- Severity: Medium
- Date: 2026-08-08
- Owners: AgentKnot maintainers
- Affected versions/commits: AgentKnot 0.0.1 through `da825cf`
- Related: [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), [ROADMAP](../docs/ROADMAP.md), [README](../README.md), [CHANGELOG](../CHANGELOG.md)

## Summary

An HK egress check made the Luna route's configuration-only `doctor` command report ready, while a real Luna inference returned HTTP 403. After egress was switched to Japan, the same Luna/max probe succeeded. The incident exposed that local configuration, credential, and runtime readiness could be mistaken for live provider reachability; the corrective contract keeps the default check fast and explicit and adds an opt-in bounded live probe.

## Context

The repository's `doctor` command was intended to check the local worker command, configured route, and available credential source without starting a job. The Luna route resolves through Pi and OpenCode Go to `gpt-5.6-luna` with `thinkingLevel: "max"`. Provider access can still depend on the network egress used for the request, so a route can pass local checks while an inference request is rejected.

## Expected invariant

A successful configuration-only doctor result must not be represented or interpreted as proof that live inference succeeded. Route diagnostics must distinguish configuration, credential, and runtime checks from a real provider request, preserve the exact resolved worker/provider/model/thinking level, and report unsupported or failed live checks honestly without silently changing routes.

## Severity and impact

- Severity: Diagnostic correctness / false readiness.
- The HK result could lead a controller or operator to believe that Luna inference had been validated when the provider path actually returned 403; the incident did not establish that every job from HK would fail or that Japan will always succeed.
- No credential value, source mutation, automatic artifact promotion, or security-sandbox guarantee is inferred from this incident.

## Immediate containment

The same Luna/max probe was repeated after switching egress from HK to Japan, and it succeeded. No fallback route was introduced, so the comparison kept the worker, provider, model, and thinking level constant while changing the observed network path.

## Evidence and timeline

1. With public egress `150.241.204.120`, identified as HK, `doctor` for the configured `luna` route reported the route ready.
2. Leaf job `job_c4d7587a-a695-42bf-a134-515209db672e` used Pi/OpenCode Go/`gpt-5.6-luna`; its event evidence recorded `thinking_level_changed: max`, and both configured attempts returned provider HTTP 403 with `This model is not available in your region`.
3. The local sing-box selector was changed from `Auto` (which selected an HK node) to `日本 01`; public egress became `103.175.98.91`, identified as Tokyo, Japan.
4. Leaf job `job_7ed7761a-e478-4858-91fa-7662b0baadf6` then used the same Luna/max route and succeeded with the requested fixed response `AGENTKNOT_LUNA_OK`.
5. The record retains route, job, error, and public-egress evidence but no credential values or provider-auth contents.

## Root cause

The root cause of the false-ready result was a diagnostic scope gap: the configuration-only check verified local command and credential/runtime prerequisites but did not send an inference request through the provider. The provider's 403 response was therefore outside the check's evidence boundary, and the word “ready” was easy to overread as live readiness. The HK/Japan difference identifies the egress-sensitive provider response observed here; it does not justify claims about provider policy beyond this probe.

## Alternatives considered

### Make every doctor invocation perform live inference

Rejected. It would remove the fast configuration-only check, add an unintended provider request to routine diagnostics, and make a local prerequisite command depend on inference availability.

### Preflight every normal job with a live probe

Rejected. Normal execution must not make an extra provider request, incur duplicate latency or cost, or create a second result whose relationship to the actual job is ambiguous.

### Fall back to another route or provider after the 403

Rejected. Route selection must remain explicit and the failure must remain visible; hidden fallback would make the executed provider/model evidence ambiguous and is outside this Stage 1 slice.

### Add an opt-in exact-route live probe

Accepted. `doctor --live --route NAME` performs one bounded real inference through the exact selected worker/provider/model/thinking level, uses a 30-second control-plane abort timer, returns provider errors with failure status, and reports adapters without probe support as unsupported. The incident reproduction and promotion check select `luna`; the core does not contain a Luna-specific branch.

## Consequences

- The default doctor command remains fast and explicitly says that live inference was not checked.
- The live diagnostic is limited to one probe of the selected route, does not select a fallback route, and does not use Job, event, worktree, or artifact persistence.
- A timeout or cancellation must abort the probe; a supported adapter must settle and clean up before return, and the Pi adapter removes its temporary diagnostic workspace. A provider error must remain visible to the caller and produce a nonzero CLI result.
- Normal jobs and orchestrations do not perform a diagnostic probe before execution.
- A successful probe is point-in-time evidence for one exact route and egress path; it does not cover future credential expiry, rate limits, changing provider policy, every worker operation, or the full job lifecycle.

## What went well

The route and thinking level were explicit enough to repeat the same Luna/max probe after changing only the observed egress path. The failure was found before route fallback or automatic artifact promotion was introduced, so the evidence remained attributable to the intended route.

## What did not go well

The configuration-only result was easy to read as provider readiness even though it had not exercised the provider. The missing distinction delayed recognition that the HK egress path could reject the same Luna request that succeeded from Japan.

## Corrective actions and gates

- [x] Keep `doctor` as a configuration, credential, and runtime check and make its output explicitly say that live inference was not checked — Stage 1 route-diagnostics contract.
- [x] Add opt-in, route-neutral `doctor --live --route NAME` behavior using the exact resolved worker/provider/model/thinking level and a 30-second control-plane abort timer — Stage 1 route-diagnostics contract.
- [x] Preserve provider errors and nonzero CLI status, return honest unsupported status for adapters without probe support, avoid fallback, and keep probes out of Job/artifact persistence and normal job execution — Stage 1 route-diagnostics contract.
- [x] Verify successful, failed, unsupported, timeout/cancellation, cleanup, CLI exit, route neutrality, temporary-workspace removal, and Pi thinking-level propagation deterministically — Stage 1 exit gate.

## Deferred work

This record does not establish real-provider evidence for every configured route, continuous provider monitoring, network allowlists, authentication policy, retries, fallback, or a guarantee that a successful probe predicts a later coding job. Such work requires a separate contract and roadmap gate.

## Privacy and security review

The incident involved route outcomes and egress locations, not credential values. Provider errors should be surfaced without copying API keys or auth-file contents into diagnostics, Job records, events, logs, or artifacts. Worktree isolation and the live probe do not constitute an operating-system security sandbox.

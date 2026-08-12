# 0070: Preserve sparse-checkout artifact semantics and enforce read-only analysis

- Type: Incident / Decision
- Status: Resolved / Accepted
- Date: 2026-08-12
- Severity: High correctness risk; contained before artifact application
- Owners: AgentKnot maintainers
- Affected versions/commits: through `f7f73dc`
- Related: [decision 0002](./0002-git-worktree-artifact-handoff.md), [decision 0006](./0006-read-only-artifact-inspection.md), [decision 0051](./0051-evidence-producing-repository-analysis.md), [incident 0060](./0060-artifact-capture-omitted-deletions.md), [PRD](../docs/PRD.md), [SPEC](../docs/SPEC.md), and [ROADMAP](../docs/ROADMAP.md)

## Summary and impact

A read-only Relay repository review ran against a sparse checkout and produced a 15,197,480-byte patch artifact containing many apparent deletions for tracked paths outside the sparse cone. The worker had not deleted those paths. The orchestration was cancelled and the artifact was never applied, so no source repository was modified.

The incident exposed two independent boundary gaps. Artifact capture reconstructed a temporary index from the admitted tree but discarded the managed sparse worktree's `skip-worktree` state, so Git interpreted intentionally unmaterialized paths as worker deletions. Separately, the existing `repository-analysis` contract was documented as read-only but successful settlement did not reject a worker that actually wrote files.

## Expected invariant

In `git-worktree` mode, a patch artifact contains only the worker delta relative to the admitted workspace. Sparse-checkout omissions are repository state, not deletions. A delegated `repository-analysis` is read-only regardless of route, worker, provider, model, or completion claim. Artifact checksum/base verification proves the retained bytes and identity; it does not prove completeness, task completion, or semantic compliance.

## Evidence

- The affected Relay checkout was clean at commit `ee056b3401361b12386a0656d781384b6dad6c24` and used cone-mode sparse checkout.
- Reconstructing the artifact-capture path with a fresh temporary index produced 1,320 false changed paths in a clean managed worktree.
- Copying the managed worktree's NUL-delimited `S` entries from `git ls-files -v -z` into that private index with `git update-index --skip-worktree -z --stdin` reduced the same clean diff to zero paths.
- Before the production change, the focused suite failed both new gates: a sparse no-op produced a non-empty artifact and a mutating `repository-analysis` settled as success.
- After the change, all 59 focused orchestration/workspace-isolation tests passed. A compiled real-workspace capture against the original Relay sparse checkout returned `size: 0` and `changedFiles: []` without materializing omitted paths or fetching repository content.

## Root cause

Admission snapshotting and output capture use private temporary indexes so AgentKnot does not mutate the source index. The capture index correctly reconstructed the admitted file tree, but Git's sparse-checkout `skip-worktree` bits are index-local state and were absent from that new index. A worktree diff against the full reconstructed index therefore treated every missing out-of-cone file as deleted.

The second gap was an enforcement omission. `repository-analysis` already had a bounded read-only prompt and policy meaning, but terminal settlement validated only adapter/process completion and artifact capture. A structurally valid patch remained valid evidence even when its existence contradicted the task-kind contract.

## Decision and resolution

1. When sparse checkout is enabled, artifact capture reads the managed worktree's NUL-delimited index flags and copies only `skip-worktree` paths into the private capture index. Source and managed indexes remain unchanged.
2. AgentKnot does not expand the sparse checkout, fetch missing objects, reject sparse repositories, or add another isolation path.
3. After artifact capture, a depth-one worker Job whose admitted task kind is exactly `repository-analysis` fails with non-retryable `WorkerReadOnlyTaskViolationError` when the terminal-attempt artifact reports any changed path.
4. The violating artifact remains retained and independently integrity-verifiable so the upstream controller can inspect what occurred. Verification does not become a semantic validator.

## Alternatives considered

- Reject every sparse checkout. Rejected because sparse repositories are valid Git workspaces and the omission state can be preserved exactly.
- Force a full checkout before execution. Rejected because it changes user repository shape, can require network access in partial clones, and increases time and disk use.
- Infer omissions from sparse pattern files. Rejected because Git's actual index flags are the authoritative materialization state and avoid duplicating sparse-pattern semantics.
- Make `artifact-verify` reject read-only-task patches. Rejected because integrity and semantic task compliance are separate boundaries; changing verification would make retained bytes appear corrupt.
- Trust the worker completion report's empty `changedFiles`. Rejected because it is an unverified claim and the controller-captured artifact is authoritative path evidence.

## Consequences

Sparse no-op and in-cone edits now produce correct worker deltas without broadening the checkout. Capture performs one additional read-only index query only when sparse checkout is enabled, then updates only the private temporary index. Read-only analysis violations consume no retry and remain diagnosable through their artifact. No public schema, controller branch, provider/model rule, worker-adapter branch, scheduler, or promotion behavior is added.

## Corrective actions and gates

- [x] Maintainers — preserve managed `skip-worktree` state in the private artifact index — sparse no-op and in-cone-edit regression.
- [x] Maintainers — enforce the route-neutral read-only task-kind contract after controller capture — real orchestration regression proving one failed attempt and retained path evidence.
- [x] Maintainers — rerun the fix against the exact affected sparse checkout — empty artifact and no changed paths.
- [x] Maintainers — run the complete deterministic suite and Stage 1 soak before publication — 260/260 and 61/61 passed.

## Privacy and security review

This record retains only repository name, public commit identity, aggregate artifact size, changed-path count, and test outcomes. It includes no artifact content, prompt text, credentials, environment values, API keys, provider response bodies, or local account paths beyond the project documentation convention.

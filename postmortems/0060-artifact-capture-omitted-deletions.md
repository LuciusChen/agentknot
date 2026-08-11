# 0060: Preserve tracked-file deletions in worker patch artifacts

- Type: Incident
- Status: Resolved
- Date: 2026-08-11
- Severity: High correctness risk; contained before promotion
- Owners: AgentKnot maintainers
- Affected versions/commits: through `dcbce20`
- Related: [decision 0002](./0002-git-worktree-artifact-handoff.md), [decision 0006](./0006-read-only-artifact-inspection.md), [decision 0059](./0059-retire-native-opencode-worker.md), [SPEC](../docs/SPEC.md)

## Summary and impact

A delegated removal Job deleted three tracked files in its isolated worktree and passed its reduced 242-test suite, but the resulting verified patch artifact omitted all three deletions. The completion report claimed the deletion while the artifact contained only modified and added files. Upstream preview and `git apply --stat` caught the mismatch before promotion, so no incomplete commit was published.

Artifact checksum, size, base commit, and base tree verification all passed because they proved the retained patch bytes were intact and based correctly; they could not prove that the capture step had included every worker delta.

## Expected invariant

In `git-worktree` mode, the artifact must represent every worker change relative to the admitted workspace snapshot, including modified, added, binary, and deleted tracked paths. Controller-derived `changedFiles` must describe the same delta. A successful completion report is a worker claim and cannot replace controller-captured patch evidence.

## Evidence

- Orchestration `orchestration_8c7e1bdc-9c39-4fa2-a4de-42f78a5bc2ab`, Job `job_be422cad-415d-4644-ac82-512db1362830`, attempt 1, completed through Pi and emitted a strict completion envelope.
- The worker reported deleting `src/adapters/opencode-json.ts`, `test/opencode-json.test.ts`, and `test/fixtures/fake-opencode-json.mjs`; its isolated full suite passed 242/242, down from the controller baseline of 257/257.
- Artifact SHA-256 `201b0fae3d37bc48dd0c0d88a4e1b210d8a4d5d79fd4aa0c9867222316d382f4` was size-, checksum-, commit-, and tree-valid, but neither its `changedFiles` nor its diff headers named the three paths.
- `git ls-files` at the recorded base confirmed all three paths were tracked. `git apply --stat` showed only 12 modified/added files and no deletions.

## Root cause

Patch capture reconstructs the admitted snapshot in a private temporary index, then uses intent-to-add so untracked worker files appear in a worktree diff. The command used `git add --intent-to-add -- .`. For already tracked files removed from the worktree, that operation staged the removals in the temporary index. The following non-cached `git diff` compared the worktree to that index and therefore could not see those deletions.

The artifact verifier correctly verified the artifact it was given; the defect was earlier, in delta capture. Completion-envelope enforcement also behaved correctly but remained an independent worker-claim boundary.

## Resolution

- Patch capture now adds `--ignore-removal` to the intent-to-add operation. Untracked additions remain visible without moving tracked removals into the temporary index.
- The worktree artifact regression now modifies a tracked file, deletes another tracked file, adds text and binary files, verifies all paths in `changedFiles`, checks for a deletion header, and confirms the resulting patch applies.
- The three omitted deletions were supplied upstream only after the artifact mismatch was explicitly reviewed.

## Alternatives considered

- Combine cached and non-cached diffs. Rejected because it complicates ordering and risks mixing the reconstructed admitted snapshot with the worker delta.
- Trust the completion report's `changedFiles`. Rejected because it is an unverified worker claim and may be incomplete or incorrect.
- Mark checksum-valid artifacts semantically complete. Rejected because integrity and completeness are different properties.

## Corrective actions and gates

- [x] Maintainers — preserve tracked removals during intent-to-add discovery — focused worktree regression.
- [x] Maintainers — retain controller review of artifact path evidence before promotion — this incident was contained at that boundary.
- [x] Maintainers — run the complete deterministic suite after integration — 242/242 passed.

## Privacy and security review

The evidence contains repository-relative paths and local Job/orchestration identifiers but no prompts, source contents, credentials, environment values, or provider response bodies.

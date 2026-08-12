import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { AgentKnotConfig } from '../src/config.js';
import { JobPersistenceError, Orchestrator } from '../src/orchestrator.js';
import { MemoryJobStore } from '../src/store.js';
import {
  MAX_ARTIFACT_BYTES,
  WorkspaceIsolationManager,
  WorkspaceSnapshotSizeLimitError,
} from '../src/workspace-isolation.js';
import type {
  JobStore,
  ResolvedRoute,
  WorkerAdapter,
  WorkerEventSink,
  WorkerHealth,
  WorkerRunInput,
  WorkerRunResult,
} from '../src/types.js';

const execFileAsync = promisify(execFile);

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: directory, encoding: 'utf8' });
  return String(result.stdout);
}

async function repository(): Promise<{ root: string; worktreeDirectory: string; storage: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentknot-source-'));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'agentknot-test@example.invalid');
  await git(root, 'config', 'user.name', 'AgentKnot test');
  await writeFile(path.join(root, 'README.md'), 'base\n');
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested', 'nested.txt'), 'nested\n');
  await writeFile(path.join(root, 'nested', 'removed.txt'), 'remove me\n');
  await git(root, 'add', '--', '.');
  await git(root, 'commit', '-qm', 'base');
  return {
    root,
    worktreeDirectory: await mkdtemp(path.join(os.tmpdir(), 'agentknot-managed-')),
    storage: await mkdtemp(path.join(os.tmpdir(), 'agentknot-artifacts-')),
  };
}

function config(storage: string, worktreeDirectory: string, maxAttempts = 1): AgentKnotConfig {
  return {
    version: 1,
    defaultRoute: 'test',
    storage: { directory: storage },
    workspaceIsolation: { mode: 'git-worktree', directory: worktreeDirectory },
    workers: { test: { adapter: 'mock' } },
    routes: {
      test: { worker: 'test', provider: 'test', model: 'test', maxAttempts, timeoutMs: 2_000 },
    },
  };
}

abstract class TestAdapter implements WorkerAdapter {
  readonly name = 'test';
  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'test' };
  }
  abstract run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult>;
}

async function status(root: string): Promise<string> {
  return git(root, 'status', '--porcelain=v1', '--untracked-files=all');
}

async function managedEntries(directory: string): Promise<string[]> {
  return readdir(directory);
}

test('worktree jobs leave the source unchanged and capture tracked/untracked/binary patches', async () => {
  const paths = await repository();
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      assert.notEqual(input.workspace, paths.root);
      await writeFile(path.join(input.workspace, 'nested.txt'), 'changed\n');
      await rm(path.join(input.workspace, 'removed.txt'));
      await writeFile(path.join(input.workspace, 'worker-created.txt'), 'created\n');
      await writeFile(path.join(input.workspace, 'worker.bin'), Buffer.from([0, 1, 2, 255]));
      return { output: 'ok' };
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([['test', adapter]]),
  });

  const job = await orchestrator.run({ prompt: 'edit', workspace: path.join(paths.root, 'nested') });
  assert.equal(job.status, 'succeeded');
  assert.equal(await status(paths.root), '');
  await assert.rejects(readFile(path.join(paths.root, 'nested', 'worker-created.txt')));
  assert.equal(job.artifacts?.length, 1);
  assert.deepEqual(job.artifacts?.[0]?.changedFiles, [
    'nested/nested.txt',
    'nested/removed.txt',
    'nested/worker-created.txt',
    'nested/worker.bin',
  ]);
  const artifactPath = job.artifacts?.[0]?.path ?? '';
  const patch = await readFile(artifactPath);
  assert.match(patch.toString('utf8'), /deleted file mode.*removed\.txt/s);
  assert.match(patch.toString('utf8'), /worker-created\.txt/);
  assert.match(patch.toString('utf8'), /GIT binary patch/);
  await git(paths.root, 'apply', '--check', artifactPath);
  assert.equal(job.events.filter((event) => event.type === 'job.artifact').length, 1);
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('sparse-checkout jobs ignore unmaterialized tracked files and capture only worker deltas', async () => {
  const paths = await repository();
  await mkdir(path.join(paths.root, 'outside'));
  await writeFile(path.join(paths.root, 'outside', 'omitted.txt'), 'omitted from sparse checkout\n');
  await git(paths.root, 'add', '--', 'outside/omitted.txt');
  await git(paths.root, 'commit', '-qm', 'add sparse fixture');
  await git(paths.root, 'sparse-checkout', 'init', '--cone');
  await git(paths.root, 'sparse-checkout', 'set', 'nested');
  await assert.rejects(readFile(path.join(paths.root, 'outside', 'omitted.txt')));

  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      if (input.prompt === 'edit sparse path') {
        await writeFile(path.join(input.workspace, 'nested', 'nested.txt'), 'worker sparse change\n');
      }
      return { output: 'ok' };
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([['test', adapter]]),
  });

  const unchanged = await orchestrator.run({ prompt: 'inspect sparse checkout', workspace: paths.root });
  assert.equal(unchanged.status, 'succeeded');
  assert.equal(unchanged.artifacts?.[0]?.size, 0);
  assert.deepEqual(unchanged.artifacts?.[0]?.changedFiles, []);

  const changed = await orchestrator.run({ prompt: 'edit sparse path', workspace: paths.root });
  assert.equal(changed.status, 'succeeded');
  assert.deepEqual(changed.artifacts?.[0]?.changedFiles, ['nested/nested.txt']);
  const patch = await readFile(changed.artifacts?.[0]?.path ?? '', 'utf8');
  assert.match(patch, /worker sparse change/);
  assert.doesNotMatch(patch, /outside\/omitted\.txt/);
  assert.equal((await orchestrator.verifyArtifacts(changed.id))?.valid, true);
  assert.equal(await status(paths.root), '');
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('changed-file evidence preserves newline-containing repository-relative names', async () => {
  const paths = await repository();
  const filename = 'worker-line\nbreak.txt';
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      await writeFile(path.join(input.workspace, filename), 'newline filename\n');
      return { output: 'ok' };
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([['test', adapter]]),
  });

  const job = await orchestrator.run({ prompt: 'unusual filename', workspace: paths.root });
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(job.artifacts?.[0]?.changedFiles, [filename]);
  assert.equal(await status(paths.root), '');
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('artifact inspection reports integrity and base evidence without mutating the source', async () => {
  const paths = await repository();
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      await writeFile(path.join(input.workspace, 'inspect-me.txt'), 'inspectable\n');
      return { output: 'ok' };
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([['test', adapter]]),
  });

  const job = await orchestrator.run({ prompt: 'inspect', workspace: paths.root });
  const artifact = job.artifacts?.[0];
  assert.ok(artifact);
  assert.deepEqual(artifact.changedFiles, ['inspect-me.txt']);
  const originalPatch = await readFile(artifact.path);
  const sourceHead = (await git(paths.root, 'rev-parse', 'HEAD')).trim();
  const sourceStatus = await status(paths.root);

  const listed = await orchestrator.listArtifacts(job.id);
  const verified = await orchestrator.verifyArtifacts(job.id);
  const preview = await orchestrator.previewArtifact(job.id, 1);
  assert.deepEqual(listed?.artifacts, [artifact]);
  assert.equal(verified?.valid, true);
  assert.equal(verified?.artifacts[0]?.file.exists, true);
  assert.equal(verified?.artifacts[0]?.file.sizeMatches, true);
  assert.equal(verified?.artifacts[0]?.file.sha256Matches, true);
  assert.equal(verified?.artifacts[0]?.source.headMatchesBase, true);
  assert.deepEqual(verified?.artifacts[0]?.issues, []);
  assert.match(preview?.content ?? '', /inspect-me\.txt/);
  assert.equal(preview?.format, 'git-patch');
  assert.equal(preview?.encoding, 'utf-8');
  assert.equal(preview?.truncated, false);
  assert.equal(preview?.verification.valid, true);
  assert.equal((await git(paths.root, 'rev-parse', 'HEAD')).trim(), sourceHead);
  assert.equal(await status(paths.root), sourceStatus);
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);

  await writeFile(artifact.path, Buffer.concat([originalPatch, Buffer.from('\n# tampered\n')]));
  const tampered = await orchestrator.verifyArtifacts(job.id);
  const withheld = await orchestrator.previewArtifact(job.id, 1);
  assert.equal(tampered?.valid, false);
  assert.deepEqual(tampered?.artifacts[0]?.issues, [
    'artifact-size-mismatch',
    'artifact-sha256-mismatch',
  ]);
  assert.equal(withheld?.content, null);
  assert.equal(withheld?.verification.file.sha256Matches, false);

  await writeFile(artifact.path, originalPatch);
  await writeFile(path.join(paths.root, 'source-change.txt'), 'source\n');
  await git(paths.root, 'add', '--', 'source-change.txt');
  await git(paths.root, 'commit', '-qm', 'source changed after artifact');
  const changedHead = (await git(paths.root, 'rev-parse', 'HEAD')).trim();
  const changedStatus = await status(paths.root);
  const mismatched = await orchestrator.verifyArtifacts(job.id);
  const diagnosticPreview = await orchestrator.previewArtifact(job.id, 1);
  assert.equal(mismatched?.valid, false);
  assert.deepEqual(mismatched?.artifacts[0]?.issues, ['base-commit-mismatch']);
  assert.match(diagnosticPreview?.content ?? '', /inspect-me\.txt/);
  assert.equal(diagnosticPreview?.verification.valid, false);
  assert.equal((await git(paths.root, 'rev-parse', 'HEAD')).trim(), changedHead);
  assert.equal(await status(paths.root), changedStatus);
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('artifact validation applies the recorded patch only in a disposable worktree', async () => {
  const paths = await repository();
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      await writeFile(path.join(input.workspace, 'validated.txt'), 'validated\n');
      return { output: 'patch ready' };
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([['test', adapter]]),
  });
  const job = await orchestrator.run({
    prompt: 'produce validation artifact',
    workspace: path.join(paths.root, 'nested'),
  });
  const sourceHead = (await git(paths.root, 'rev-parse', 'HEAD')).trim();

  const result = await orchestrator.validateArtifact(
    job.id,
    1,
    {
      argv: [
        process.execPath,
        '-e',
        "const fs=require('node:fs'); if(fs.readFileSync('validated.txt','utf8')!=='validated\\n') process.exit(9); console.log('validation passed')",
      ],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    },
    new AbortController().signal
  );

  assert.equal(result?.status, 'completed');
  if (result?.status !== 'completed') assert.fail('validation should complete');
  assert.equal(result.command.outcome, 'passed');
  assert.equal(result.command.stdout, 'validation passed\n');
  assert.equal(result.cleanup, 'cleaned');
  assert.equal((await git(paths.root, 'rev-parse', 'HEAD')).trim(), sourceHead);
  assert.equal(await status(paths.root), '');
  await assert.rejects(readFile(path.join(paths.root, 'nested', 'validated.txt')));
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('artifact validation recreates an unchanged dirty snapshot before applying the worker delta', async () => {
  const paths = await repository();
  await writeFile(path.join(paths.root, 'nested', 'nested.txt'), 'dirty baseline\n');
  await writeFile(path.join(paths.root, 'source-untracked.txt'), 'source baseline\n');
  const sourceStatus = await status(paths.root);
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      assert.equal(
        await readFile(path.join(input.workspace, 'nested', 'nested.txt'), 'utf8'),
        'dirty baseline\n'
      );
      await writeFile(path.join(input.workspace, 'candidate.txt'), 'candidate\n');
      return { output: 'patch ready' };
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([['test', adapter]]),
  });
  const job = await orchestrator.run({ prompt: 'validate from dirty baseline', workspace: paths.root });

  const result = await orchestrator.validateArtifact(
    job.id,
    1,
    {
      argv: [
        process.execPath,
        '-e',
        "const fs=require('node:fs'); for(const [p,v] of [['nested/nested.txt','dirty baseline\\n'],['source-untracked.txt','source baseline\\n'],['candidate.txt','candidate\\n']]) if(fs.readFileSync(p,'utf8')!==v) process.exit(9)",
      ],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    },
    new AbortController().signal
  );

  assert.equal(result?.status, 'completed');
  if (result?.status !== 'completed') assert.fail('validation should complete');
  assert.equal(result.command.outcome, 'passed');
  assert.equal(await status(paths.root), sourceStatus);
  await assert.rejects(readFile(path.join(paths.root, 'candidate.txt')));
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('artifact validation rejects source drift before command execution', async () => {
  const paths = await repository();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([
      [
        'test',
        new (class extends TestAdapter {
          async run(input: WorkerRunInput): Promise<WorkerRunResult> {
            await writeFile(path.join(input.workspace, 'candidate.txt'), 'candidate\n');
            return { output: 'patch ready' };
          }
        })(),
      ],
    ]),
  });
  const job = await orchestrator.run({ prompt: 'produce artifact', workspace: paths.root });
  await writeFile(path.join(paths.root, 'dirty.txt'), 'dirty\n');

  const result = await orchestrator.validateArtifact(
    job.id,
    1,
    {
      argv: [process.execPath, '-e', 'process.exit(99)'],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    },
    new AbortController().signal
  );

  assert.equal(result?.status, 'unavailable');
  if (result?.status !== 'unavailable') assert.fail('validation should be unavailable');
  assert.equal(result.reason, 'source-drift');
  assert.equal(result.cleanup, 'not-started');
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('artifact inspection reports missing managed files without exposing preview content', async () => {
  const paths = await repository();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([
      [
        'test',
        new (class extends TestAdapter {
          async run(_input: WorkerRunInput): Promise<WorkerRunResult> {
            return { output: 'no changes' };
          }
        })(),
      ],
    ]),
  });
  const job = await orchestrator.run({ prompt: 'missing artifact', workspace: paths.root });
  const artifact = job.artifacts?.[0];
  assert.ok(artifact);
  assert.deepEqual(artifact.changedFiles, []);
  await rm(artifact.path);

  const verification = await orchestrator.verifyArtifacts(job.id);
  const preview = await orchestrator.previewArtifact(job.id, 1);
  assert.equal(verification?.valid, false);
  assert.deepEqual(verification?.artifacts[0]?.issues, ['artifact-file-missing']);
  assert.equal(preview?.content, null);
  assert.equal(preview?.verification.file.exists, false);

  await symlink(path.join(paths.root, 'README.md'), artifact.path);
  const linked = await orchestrator.verifyArtifacts(job.id);
  const linkedPreview = await orchestrator.previewArtifact(job.id, 1);
  assert.deepEqual(linked?.artifacts[0]?.issues, ['artifact-file-unreadable']);
  assert.equal(linkedPreview?.content, null);
});

test('artifact inspection refuses managed files above the retained artifact limit', async () => {
  const paths = await repository();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([
      [
        'test',
        new (class extends TestAdapter {
          async run(input: WorkerRunInput): Promise<WorkerRunResult> {
            await writeFile(path.join(input.workspace, 'bounded.txt'), 'bounded\n');
            return { output: 'ok' };
          }
        })(),
      ],
    ]),
  });
  const job = await orchestrator.run({ prompt: 'bounded inspection', workspace: paths.root });
  const artifact = job.artifacts?.[0];
  assert.ok(artifact);
  await writeFile(artifact.path, Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x78));

  const verification = await orchestrator.verifyArtifacts(job.id);
  const preview = await orchestrator.previewArtifact(job.id, 1);
  assert.equal(verification?.valid, false);
  assert.equal(verification?.artifacts[0]?.file.exists, true);
  assert.equal(verification?.artifacts[0]?.file.actualSize, MAX_ARTIFACT_BYTES + 1);
  assert.equal(verification?.artifacts[0]?.file.actualSha256, null);
  assert.deepEqual(verification?.artifacts[0]?.issues, [
    'artifact-size-limit-exceeded',
    'artifact-size-mismatch',
  ]);
  assert.equal(preview?.content, null);
  assert.equal(preview?.verification.file.actualSha256, null);
  assert.equal(await status(paths.root), '');
});

test('patches include tracked files committed after the job base commit', async () => {
  const paths = await repository();
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      await writeFile(path.join(input.workspace, 'worker-committed.txt'), 'committed\n');
      await git(input.workspace, 'add', '--', 'worker-committed.txt');
      await git(input.workspace, 'commit', '-qm', 'worker commit');
      return { output: 'committed' };
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([['test', adapter]]),
  });

  const job = await orchestrator.run({ prompt: 'commit', workspace: paths.root });
  assert.equal(job.status, 'succeeded');
  assert.equal(await status(paths.root), '');
  assert.deepEqual(job.artifacts?.[0]?.changedFiles, ['worker-committed.txt']);
  const patch = await readFile(job.artifacts?.[0]?.path ?? '');
  assert.match(patch.toString(), /worker-committed\.txt/);
  assert.match(patch.toString(), /committed/);
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('git-worktree mode snapshots dirty source state without changing the source', async () => {
  const paths = await repository();
  await writeFile(path.join(paths.root, '.gitignore'), 'ignored.txt\n');
  await git(paths.root, 'add', '--', '.gitignore');
  await git(paths.root, 'commit', '-qm', 'ignore fixture');
  await writeFile(path.join(paths.root, 'README.md'), 'staged source\n');
  await git(paths.root, 'add', '--', 'README.md');
  await writeFile(path.join(paths.root, 'nested', 'nested.txt'), 'unstaged source\n');
  await writeFile(path.join(paths.root, 'source-untracked.txt'), 'untracked source\n');
  await writeFile(path.join(paths.root, 'ignored.txt'), 'ignored source\n');
  const statusBefore = await status(paths.root);
  const stagedBefore = await git(paths.root, 'diff', '--cached', '--binary');
  const unstagedBefore = await git(paths.root, 'diff', '--binary');
  const objectsBefore = await git(paths.root, 'count-objects', '-v');

  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      assert.equal(await readFile(path.join(input.workspace, 'README.md'), 'utf8'), 'staged source\n');
      assert.equal(
        await readFile(path.join(input.workspace, 'nested', 'nested.txt'), 'utf8'),
        'unstaged source\n'
      );
      assert.equal(
        await readFile(path.join(input.workspace, 'source-untracked.txt'), 'utf8'),
        'untracked source\n'
      );
      await assert.rejects(readFile(path.join(input.workspace, 'ignored.txt')));
      await writeFile(path.join(input.workspace, 'nested', 'nested.txt'), 'worker change\n');
      await writeFile(path.join(input.workspace, 'worker-only.txt'), 'worker only\n');
      return { output: 'snapshot used' };
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([['test', adapter]]),
  });

  const job = await orchestrator.run({ prompt: 'use dirty snapshot', workspace: paths.root });
  assert.equal(job.status, 'succeeded');
  const artifact = job.artifacts?.[0];
  assert.ok(artifact);
  assert.match(artifact.baseTree ?? '', /^[0-9a-f]{40,64}$/);
  assert.deepEqual(artifact.changedFiles, ['nested/nested.txt', 'worker-only.txt']);
  const patch = await readFile(artifact.path, 'utf8');
  assert.match(patch, /worker-only\.txt/);
  assert.doesNotMatch(patch, /source-untracked\.txt/);
  assert.doesNotMatch(patch, /README\.md/);
  assert.doesNotMatch(patch, /ignored\.txt/);
  await git(paths.root, 'apply', '--check', artifact.path);

  assert.equal(await status(paths.root), statusBefore);
  assert.equal(await git(paths.root, 'diff', '--cached', '--binary'), stagedBefore);
  assert.equal(await git(paths.root, 'diff', '--binary'), unstagedBefore);
  await assert.rejects(readFile(path.join(paths.root, 'worker-only.txt')));
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);

  const verified = await orchestrator.verifyArtifacts(job.id);
  assert.equal(verified?.valid, true);
  assert.equal(verified?.artifacts[0]?.source.treeMatchesBase, true);
  assert.equal(await git(paths.root, 'count-objects', '-v'), objectsBefore);
  await writeFile(path.join(paths.root, 'source-untracked.txt'), 'source drift\n');
  const drifted = await orchestrator.verifyArtifacts(job.id);
  assert.equal(drifted?.valid, false);
  assert.deepEqual(drifted?.artifacts[0]?.issues, ['base-tree-mismatch']);
});

test('admitted workspace snapshots restore exact dirty input and reject changed bytes', async () => {
  const paths = await repository();
  await writeFile(path.join(paths.root, 'README.md'), 'admitted dirty content\n');
  await writeFile(path.join(paths.root, 'admitted-untracked.txt'), 'admitted untracked\n');
  const manager = new WorkspaceIsolationManager(
    config(paths.storage, paths.worktreeDirectory),
    paths.root
  );
  const jobId = 'job_snapshot_restore';
  const inspection = await manager.inspect(paths.root);
  const snapshot = await manager.persistAdmissionSnapshot(inspection, jobId);
  assert.ok(snapshot.size > 0);
  assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);

  await writeFile(path.join(paths.root, 'README.md'), 'later source state\n');
  await rm(path.join(paths.root, 'admitted-untracked.txt'));
  const restored = await manager.restoreAdmissionSnapshot(jobId, paths.root, snapshot);
  const isolated = await manager.create(restored, jobId, 1);
  try {
    assert.equal(
      await readFile(path.join(isolated.path, 'README.md'), 'utf8'),
      'admitted dirty content\n'
    );
    assert.equal(
      await readFile(path.join(isolated.path, 'admitted-untracked.txt'), 'utf8'),
      'admitted untracked\n'
    );
  } finally {
    await manager.cleanup(isolated);
  }

  const snapshotPath = path.join(
    paths.storage,
    'artifacts',
    jobId,
    'admitted-workspace.patch'
  );
  await writeFile(snapshotPath, 'changed snapshot bytes');
  await assert.rejects(
    manager.restoreAdmissionSnapshot(jobId, paths.root, snapshot),
    /failed integrity verification/
  );
  await manager.discardAdmissionSnapshot(jobId);
});

test('workspace inspection does not refresh the caller index', async () => {
  const paths = await repository();
  const indexPath = path.resolve(paths.root, (await git(paths.root, 'rev-parse', '--git-path', 'index')).trim());
  const before = await readFile(indexPath);
  const future = new Date(Date.now() + 60_000);
  await utimes(path.join(paths.root, 'README.md'), future, future);

  const manager = new WorkspaceIsolationManager(
    config(paths.storage, paths.worktreeDirectory),
    paths.root
  );
  await manager.inspect(paths.root);

  assert.deepEqual(await readFile(indexPath), before);
  assert.equal(await status(paths.root), '');
});

test('oversized dirty snapshots fail before Job admission', async () => {
  const paths = await repository();
  await writeFile(path.join(paths.root, 'oversized-source.txt'), 'x'.repeat(MAX_ARTIFACT_BYTES));
  const store = new MemoryJobStore();
  let runs = 0;
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store,
    adapters: new Map([
      [
        'test',
        new (class extends TestAdapter {
          async run(): Promise<WorkerRunResult> {
            runs += 1;
            return { output: 'unexpected' };
          }
        })(),
      ],
    ]),
  });

  await assert.rejects(
    orchestrator.start({ prompt: 'reject oversized snapshot', workspace: paths.root }),
    (error) => {
      assert.ok(error instanceof WorkspaceSnapshotSizeLimitError);
      assert.match(error.message, /maximum is 16777216 bytes/);
      return true;
    }
  );
  assert.equal(runs, 0);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('git-worktree mode rejects dirty submodule content that Git cannot snapshot', async () => {
  const paths = await repository();
  const child = await repository();
  await git(
    paths.root,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    '--',
    child.root,
    'vendor/child'
  );
  await git(paths.root, 'commit', '-qam', 'add submodule');
  await writeFile(path.join(paths.root, 'vendor', 'child', 'README.md'), 'dirty submodule\n');
  const store = new MemoryJobStore();
  let runs = 0;
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store,
    adapters: new Map([
      [
        'test',
        new (class extends TestAdapter {
          async run(): Promise<WorkerRunResult> {
            runs += 1;
            return { output: 'unexpected' };
          }
        })(),
      ],
    ]),
  });

  await assert.rejects(
    orchestrator.start({ prompt: 'cannot snapshot nested dirt', workspace: paths.root }),
    /dirty submodule content/
  );
  assert.equal(runs, 0);
  assert.deepEqual(await store.list(), []);
});

test('each retry starts from the same admitted source snapshot', async () => {
  const paths = await repository();
  await writeFile(path.join(paths.root, 'README.md'), 'dirty retry baseline\n');
  const sourceStatus = await status(paths.root);
  const seen: string[] = [];
  let calls = 0;
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      calls += 1;
      seen.push(input.workspace);
      assert.equal(await readFile(path.join(input.workspace, 'README.md'), 'utf8'), 'dirty retry baseline\n');
      await writeFile(path.join(input.workspace, `attempt-${calls}.txt`), 'change\n');
      if (calls === 1) throw new Error('retry me');
      assert.equal(await readFile(path.join(input.workspace, 'attempt-1.txt')).catch(() => undefined), undefined);
      return { output: 'retried' };
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory, 2),
    store: new MemoryJobStore(),
    adapters: new Map([['test', adapter]]),
  });

  const job = await orchestrator.run({ prompt: 'retry', workspace: paths.root });
  assert.equal(job.status, 'succeeded');
  assert.notEqual(seen[0], seen[1]);
  assert.equal(job.artifacts?.length, 2);
  assert.deepEqual(job.artifacts?.[0]?.changedFiles, ['attempt-1.txt']);
  assert.deepEqual(job.artifacts?.[1]?.changedFiles, ['attempt-2.txt']);
  const firstPatch = await readFile(job.artifacts?.[0]?.path ?? '');
  const secondPatch = await readFile(job.artifacts?.[1]?.path ?? '');
  assert.match(firstPatch.toString(), /attempt-1\.txt/);
  assert.doesNotMatch(secondPatch.toString(), /attempt-1\.txt/);
  assert.match(secondPatch.toString(), /attempt-2\.txt/);
  assert.equal(await status(paths.root), sourceStatus);
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('artifact persistence failure is not retried and removes unrecorded patch evidence', async () => {
  const paths = await repository();
  const delegate = new MemoryJobStore();
  let runs = 0;
  let failed = false;
  const store: JobStore = {
    create: (job) => delegate.create(job),
    save: async (job) => {
      if (job.events.at(-1)?.type === 'job.artifact' && !failed) {
        failed = true;
        throw new Error('artifact persistence unavailable');
      }
      await delegate.save(job);
    },
    get: (id) => delegate.get(id),
    list: () => delegate.list(),
  };
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      runs += 1;
      await writeFile(path.join(input.workspace, 'unrecorded.txt'), 'change\n');
      return { output: 'worker succeeded' };
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory, 2),
    store,
    adapters: new Map([['test', adapter]]),
  });
  const started = await orchestrator.start({ prompt: 'artifact failure', workspace: paths.root });

  await assert.rejects(started.completion, (error) => {
    assert.ok(error instanceof JobPersistenceError);
    assert.equal(error.phase, 'artifact');
    assert.equal(error.eventType, 'job.artifact');
    return true;
  });
  const persisted = await delegate.get(started.job.id);
  assert.equal(runs, 1);
  assert.equal(persisted?.status, 'running');
  assert.equal(persisted?.artifacts, undefined);
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
  assert.deepEqual(await readdir(path.join(paths.storage, 'artifacts')), []);
  assert.equal(await status(paths.root), '');
});

test('oversized patch artifacts fail without retry, retained bytes, or worktree leakage', async () => {
  const paths = await repository();
  let runs = 0;
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      runs += 1;
      await writeFile(path.join(input.workspace, 'oversized.txt'), 'x'.repeat(MAX_ARTIFACT_BYTES));
      return { output: 'worker completed' };
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory, 2),
    store: new MemoryJobStore(),
    adapters: new Map([['test', adapter]]),
  });

  const job = await orchestrator.run({ prompt: 'oversized artifact', workspace: paths.root });

  assert.equal(job.status, 'failed');
  assert.equal(job.error?.name, 'ArtifactSizeLimitError');
  assert.match(job.error?.message ?? '', /maximum is 16777216 bytes/);
  assert.equal(runs, 1);
  assert.equal(job.artifacts, undefined);
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
  assert.deepEqual(
    await readdir(path.join(paths.storage, 'artifacts')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }),
    []
  );
  assert.equal(await status(paths.root), '');
});

test('concurrent jobs receive distinct managed worktrees', async () => {
  const paths = await repository();
  const seen: string[] = [];
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      seen.push(input.workspace);
      assert.match(
        path.basename(input.workspace),
        new RegExp(`^${input.jobId}-attempt-${input.attempt}-[0-9a-f-]+$`)
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      await writeFile(path.join(input.workspace, 'concurrent.txt'), input.jobId);
      return { output: input.jobId };
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([['test', adapter]]),
  });

  const [left, right] = await Promise.all([
    orchestrator.run({ prompt: 'one', workspace: paths.root }),
    orchestrator.run({ prompt: 'two', workspace: paths.root }),
  ]);
  assert.equal(left.status, 'succeeded');
  assert.equal(right.status, 'succeeded');
  assert.equal(new Set(seen).size, 2);
  assert.equal(await status(paths.root), '');
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('cleanup preserves unrelated stale worktree registrations', async () => {
  const paths = await repository();
  const unrelated = await mkdtemp(path.join(os.tmpdir(), 'agentknot-unrelated-'));
  await git(paths.root, 'worktree', 'add', '--detach', unrelated, 'HEAD');
  await rm(unrelated, { recursive: true, force: true });

  try {
    const adapter = new (class extends TestAdapter {
      async run(_input: WorkerRunInput): Promise<WorkerRunResult> {
        return { output: 'ok' };
      }
    })();
    const orchestrator = new Orchestrator({
      config: config(paths.storage, paths.worktreeDirectory),
      store: new MemoryJobStore(),
      adapters: new Map([['test', adapter]]),
    });

    const job = await orchestrator.run({ prompt: 'preserve', workspace: paths.root });
    assert.equal(job.status, 'succeeded');
    assert.ok((await git(paths.root, 'worktree', 'list', '--porcelain')).includes(path.basename(unrelated)));
  } finally {
    await git(paths.root, 'worktree', 'remove', '--force', unrelated).catch(() => undefined);
  }
});

test('failure and cancellation capture patches and clean their worktrees', async () => {
  const paths = await repository();
  const failing = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      await writeFile(path.join(input.workspace, 'failed.txt'), 'failed\n');
      throw new Error('expected failure');
    }
  })();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store: new MemoryJobStore(),
    adapters: new Map([['test', failing]]),
  });
  const failed = await orchestrator.run({ prompt: 'fail', workspace: paths.root });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.artifacts?.length, 1);
  assert.match((await readFile(failed.artifacts?.[0]?.path ?? '')).toString(), /failed\.txt/);
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);

  let cancellationRunStarted!: () => void;
  const cancellationRun = new Promise<void>((resolve) => {
    cancellationRunStarted = resolve;
  });
  const cancelling = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      cancellationRunStarted();
      await writeFile(path.join(input.workspace, 'cancelled.txt'), 'cancelled\n');
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) {
          resolve();
          return;
        }
        input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { output: 'must not succeed after cancellation' };
    }
  })();
  const cancelledOrchestrator = new Orchestrator({
    config: config(paths.storage, path.join(paths.worktreeDirectory, 'cancel')),
    store: new MemoryJobStore(),
    adapters: new Map([['test', cancelling]]),
  });
  const started = await cancelledOrchestrator.start({ prompt: 'cancel', workspace: paths.root });
  await cancellationRun;
  await started.cancel();
  const cancelled = await started.completion;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.artifacts?.length, 1);
  assert.match((await readFile(cancelled.artifacts?.[0]?.path ?? '')).toString(), /cancelled\.txt/);
  assert.deepEqual(await managedEntries(path.join(paths.worktreeDirectory, 'cancel')), []);
  assert.equal(await status(paths.root), '');
});

test('timeout captures its patch and leaves no worktree or source residue', async () => {
  const paths = await repository();
  const timingOut = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      await writeFile(path.join(input.workspace, 'timed-out.txt'), 'timed out\n');
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) resolve();
        else input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { output: 'must not succeed after timeout' };
    }
  })();
  const timeoutConfig = config(paths.storage, paths.worktreeDirectory);
  timeoutConfig.routes.test!.timeoutMs = 20;
  const orchestrator = new Orchestrator({
    config: timeoutConfig,
    store: new MemoryJobStore(),
    adapters: new Map([['test', timingOut]]),
  });

  const job = await orchestrator.run({ prompt: 'timeout', workspace: paths.root });
  const verification = await orchestrator.verifyArtifacts(job.id);
  assert.equal(job.status, 'failed');
  assert.match(job.error?.message ?? '', /timed out/);
  assert.deepEqual(job.artifacts?.[0]?.changedFiles, ['timed-out.txt']);
  assert.equal(verification?.valid, true);
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
  assert.equal(await status(paths.root), '');
});

test('patch rename failure removes its exact temporary artifact', async () => {
  const paths = await repository();
  const manager = new WorkspaceIsolationManager(config(paths.storage, paths.worktreeDirectory));
  const jobId = 'job_patch_rename_failure';
  const isolated = await manager.create(await manager.inspect(paths.root), jobId, 1);
  const artifactDirectory = path.join(paths.storage, 'artifacts', jobId);
  const conflictingTarget = path.join(artifactDirectory, 'attempt-1.patch');
  try {
    await writeFile(path.join(isolated.path, 'change.txt'), 'change\n');
    await mkdir(conflictingTarget, { recursive: true });

    await assert.rejects(manager.capturePatch(isolated, jobId, 1));

    assert.deepEqual(await readdir(artifactDirectory), ['attempt-1.patch']);
    assert.equal((await readdir(artifactDirectory)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    await manager.cleanup(isolated);
    await Promise.all(
      [paths.root, paths.worktreeDirectory, paths.storage].map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    );
  }
});

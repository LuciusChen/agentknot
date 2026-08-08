import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { AgentKnotConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryJobStore } from '../src/store.js';
import type {
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

test('worktree jobs leave the source unchanged and capture binary/untracked patches', async () => {
  const paths = await repository();
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      assert.notEqual(input.workspace, paths.root);
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
  const artifactPath = job.artifacts?.[0]?.path ?? '';
  const patch = await readFile(artifactPath);
  assert.match(patch.toString('utf8'), /worker-created\.txt/);
  assert.match(patch.toString('utf8'), /GIT binary patch/);
  await git(paths.root, 'apply', '--check', artifactPath);
  assert.equal(job.events.filter((event) => event.type === 'job.artifact').length, 1);
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
  const patch = await readFile(job.artifacts?.[0]?.path ?? '');
  assert.match(patch.toString(), /worker-committed\.txt/);
  assert.match(patch.toString(), /committed/);
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('git-worktree mode rejects a dirty source before starting a job', async () => {
  const paths = await repository();
  await writeFile(path.join(paths.root, 'README.md'), 'dirty\n');
  let runs = 0;
  const adapter = new (class extends TestAdapter {
    async run(_input: WorkerRunInput): Promise<WorkerRunResult> {
      runs += 1;
      return { output: 'unexpected' };
    }
  })();
  const store = new MemoryJobStore();
  const orchestrator = new Orchestrator({
    config: config(paths.storage, paths.worktreeDirectory),
    store,
    adapters: new Map([['test', adapter]]),
  });

  await assert.rejects(
    orchestrator.start({ prompt: 'reject', workspace: paths.root }),
    /Workspace repository is not clean/
  );
  assert.equal(runs, 0);
  assert.deepEqual(await store.list(), []);
});

test('each retry starts from the same clean base commit', async () => {
  const paths = await repository();
  const seen: string[] = [];
  let calls = 0;
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      calls += 1;
      seen.push(input.workspace);
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
  const firstPatch = await readFile(job.artifacts?.[0]?.path ?? '');
  const secondPatch = await readFile(job.artifacts?.[1]?.path ?? '');
  assert.match(firstPatch.toString(), /attempt-1\.txt/);
  assert.doesNotMatch(secondPatch.toString(), /attempt-1\.txt/);
  assert.match(secondPatch.toString(), /attempt-2\.txt/);
  assert.equal(await status(paths.root), '');
  assert.deepEqual(await managedEntries(paths.worktreeDirectory), []);
});

test('concurrent jobs receive distinct managed worktrees', async () => {
  const paths = await repository();
  const seen: string[] = [];
  const adapter = new (class extends TestAdapter {
    async run(input: WorkerRunInput): Promise<WorkerRunResult> {
      seen.push(input.workspace);
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
  started.cancel();
  const cancelled = await started.completion;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.artifacts?.length, 1);
  assert.match((await readFile(cancelled.artifacts?.[0]?.path ?? '')).toString(), /cancelled\.txt/);
  assert.deepEqual(await managedEntries(path.join(paths.worktreeDirectory, 'cancel')), []);
  assert.equal(await status(paths.root), '');
});

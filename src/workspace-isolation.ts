import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AgentKnotConfig, WorkspaceIsolationConfig } from './config.js';
import type { JobArtifact } from './types.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 128 * 1024 * 1024;
const MANAGED_WORKTREE_NAME = /^job-job_[A-Za-z0-9_-]+-attempt-[1-9][0-9]*-[0-9a-f-]+$/;

export interface WorkspaceInspection {
  sourceWorkspace: string;
  repository: string;
  relativeSubdirectory: string;
  baseCommit: string;
}

export interface IsolatedWorkspace {
  path: string;
  repository: string;
  managedPath: string;
  baseCommit: string;
}

interface GitOutput {
  stdout: Buffer | string;
  stderr: Buffer | string;
}

function outputText(value: Buffer | string): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

async function git(args: string[], cwd: string, binary = false): Promise<GitOutput> {
  try {
    return (await execFileAsync('git', args, {
      cwd,
      encoding: binary ? 'buffer' : 'utf8',
      maxBuffer: MAX_GIT_OUTPUT,
    })) as unknown as GitOutput;
  } catch (error) {
    const details = error as { stderr?: Buffer | string; message?: string };
    const stderr = details.stderr === undefined ? '' : outputText(details.stderr).trim();
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`, { cause: error });
  }
}

function resolvedIsolation(config: AgentKnotConfig): WorkspaceIsolationConfig {
  return config.workspaceIsolation ?? { mode: 'none' };
}

export class WorkspaceIsolationManager {
  readonly #config: WorkspaceIsolationConfig;
  readonly #baseDirectory: string;
  readonly #artifactDirectory: string;

  constructor(config: AgentKnotConfig, baseDirectory = process.cwd()) {
    this.#config = resolvedIsolation(config);
    this.#baseDirectory = path.resolve(baseDirectory);
    this.#artifactDirectory = path.resolve(this.#baseDirectory, config.storage.directory, 'artifacts');
  }

  #managedRoot(): string {
    return path.resolve(this.#baseDirectory, this.#config.directory ?? '.agentknot/worktrees');
  }

  get mode(): WorkspaceIsolationConfig['mode'] {
    return this.#config.mode;
  }

  async inspect(workspace: string): Promise<WorkspaceInspection> {
    if (this.#config.mode === 'none') {
      throw new Error('Git workspace inspection is unavailable in compatibility mode');
    }
    const repository = path.resolve(
      outputText((await git(['rev-parse', '--show-toplevel'], workspace)).stdout).trim()
    );
    const prefix = outputText((await git(['rev-parse', '--show-prefix'], workspace)).stdout).trim();
    const baseCommit = outputText((await git(['rev-parse', '--verify', 'HEAD^{commit}'], repository)).stdout).trim();
    const status = outputText(
      (await git(['status', '--porcelain=v1', '--untracked-files=all'], repository)).stdout
    );
    if (status !== '') {
      throw new Error(`Workspace repository is not clean: ${repository}`);
    }
    if (baseCommit === '') throw new Error(`Workspace repository has no HEAD: ${repository}`);

    const relativeSubdirectory = prefix === '' ? '' : prefix.replace(/\/$/, '').split('/').join(path.sep);
    const sourceWorkspace = path.resolve(workspace);
    return { sourceWorkspace, repository, relativeSubdirectory, baseCommit };
  }

  async create(
    inspection: WorkspaceInspection,
    jobId: string,
    attempt: number
  ): Promise<IsolatedWorkspace> {
    if (this.#config.mode === 'none') {
      throw new Error('Git worktree creation is unavailable in compatibility mode');
    }
    const root = this.#managedRoot();
    await mkdir(root, { recursive: true });
    const managedPath = path.join(root, `job-${jobId}-attempt-${attempt}-${randomUUID()}`);
    try {
      await git(['worktree', 'add', '--detach', managedPath, inspection.baseCommit], inspection.repository);
    } catch (error) {
      // A failed add can leave a partially-created directory or worktree record.
      // Remove only the exact values generated above, never unrelated worktrees.
      await this.cleanup({
        path: managedPath,
        repository: inspection.repository,
        managedPath,
        baseCommit: inspection.baseCommit,
      }).catch(() => undefined);
      throw error;
    }
    const isolatedPath = path.resolve(managedPath, inspection.relativeSubdirectory);
    const isolatedStat = await stat(isolatedPath).catch(() => undefined);
    if (!isolatedStat?.isDirectory()) {
      await this.cleanup({ path: isolatedPath, repository: inspection.repository, managedPath, baseCommit: inspection.baseCommit });
      throw new Error(`Git worktree does not contain requested subdirectory: ${inspection.relativeSubdirectory || '.'}`);
    }
    return {
      path: isolatedPath,
      repository: inspection.repository,
      managedPath,
      baseCommit: inspection.baseCommit,
    };
  }

  async capturePatch(
    isolated: IsolatedWorkspace,
    jobId: string,
    attempt: number
  ): Promise<JobArtifact> {
    // Intent-to-add makes otherwise untracked, non-ignored files visible to git diff.
    // This changes only the managed worktree's index and is discarded with the worktree.
    await git(['add', '--intent-to-add', '--', '.'], isolated.managedPath);
    // Compare with the job's source snapshot, not the worker's current HEAD. A worker
    // may commit or otherwise move HEAD, but the artifact must include all job changes.
    const patch = (await git(
      ['diff', '--binary', '--no-ext-diff', isolated.baseCommit, '--'],
      isolated.managedPath,
      true
    )).stdout;
    const bytes = Buffer.isBuffer(patch) ? patch : Buffer.from(patch);
    const directory = path.resolve(this.#artifactDirectory, jobId);
    await mkdir(directory, { recursive: true });
    const artifactPath = path.join(directory, `attempt-${attempt}.patch`);
    await writeFile(artifactPath, bytes, { mode: 0o600 });
    return {
      kind: 'git-patch',
      attempt,
      path: artifactPath,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      baseCommit: isolated.baseCommit,
    };
  }

  async cleanup(isolated: IsolatedWorkspace): Promise<void> {
    const root = this.#managedRoot();
    const managedPath = path.resolve(isolated.managedPath);
    if (path.dirname(managedPath) !== root || !MANAGED_WORKTREE_NAME.test(path.basename(managedPath))) {
      throw new Error(`Refusing to remove unmanaged worktree path: ${isolated.managedPath}`);
    }
    let removeError: unknown;
    try {
      await git(['worktree', 'remove', '--force', managedPath], isolated.repository);
    } catch (error) {
      removeError = error;
    } finally {
      // This is the exact generated worktree path, never the repository or its parent.
      // `worktree remove` above also removes that path's registration; do not run
      // repository-wide `worktree prune`, which could mutate unrelated worktrees.
      await rm(managedPath, { recursive: true, force: true });
    }
    if (removeError !== undefined) throw removeError;
  }
}

export function workspaceIsolationMode(config: AgentKnotConfig): WorkspaceIsolationConfig['mode'] {
  return resolvedIsolation(config).mode;
}

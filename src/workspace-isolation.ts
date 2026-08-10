import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rmdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  MAX_ARTIFACT_VALIDATION_PATCH_BYTES,
  runArtifactValidationCommand,
  type ArtifactValidationExecution,
} from './artifact-validation.js';
import type {
  AgentKnotConfig,
  ArtifactValidationConfig,
  WorkspaceIsolationConfig,
} from './config.js';
import type {
  JobArtifact,
  JobArtifactVerification,
  JobArtifactVerificationIssue,
} from './types.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 128 * 1024 * 1024;
export const MAX_ARTIFACT_PREVIEW_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MANAGED_WORKTREE_NAME = /^job_[A-Za-z0-9_-]+-attempt-[1-9][0-9]*-[0-9a-f-]+$/;

export class ArtifactSizeLimitError extends Error {
  readonly name = 'ArtifactSizeLimitError';

  constructor(
    readonly actualBytes: number,
    readonly maxBytes = MAX_ARTIFACT_BYTES
  ) {
    super(`Git patch artifact is ${actualBytes} bytes; maximum is ${maxBytes} bytes`);
  }
}

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

interface InspectedArtifact {
  verification: JobArtifactVerification;
  bytes: Buffer | null;
}

function outputText(value: Buffer | string): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

function nulDelimitedPaths(value: Buffer | string): string[] {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const paths: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    paths.push(bytes.subarray(start, index).toString('utf8'));
    start = index + 1;
  }
  if (start !== bytes.length) throw new Error('Git changed-file output was not NUL terminated');
  return paths;
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

async function gitWithInput(args: string[], cwd: string, input: Buffer): Promise<GitOutput> {
  return new Promise<GitOutput>((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, encoding: 'buffer', maxBuffer: MAX_GIT_OUTPUT },
      (error, stdout, stderr) => {
        if (error) {
          const details = outputText(stderr).trim();
          reject(
            new Error(`git ${args.join(' ')} failed${details ? `: ${details}` : ''}`, {
              cause: error,
            })
          );
          return;
        }
        resolve({ stdout, stderr });
      }
    );
    if (child.stdin === null) {
      child.kill();
      reject(new Error(`git ${args.join(' ')} failed: stdin is unavailable`));
      return;
    }
    child.stdin.on('error', () => {
      // The callback reports the authoritative Git outcome, including an early exit.
    });
    child.stdin.end(input);
  });
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
    const repository = await this.#repository(workspace);
    const prefix = outputText((await git(['rev-parse', '--show-prefix'], workspace)).stdout).trim();
    const baseCommit = await this.#currentHead(repository);
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

  async verifyArtifacts(
    jobId: string,
    workspace: string,
    artifacts: JobArtifact[]
  ): Promise<JobArtifactVerification[]> {
    const source = await this.#sourceHead(workspace);
    return Promise.all(
      artifacts.map(async (artifact) => (await this.#inspectArtifact(jobId, artifact, source)).verification)
    );
  }

  async previewArtifact(
    jobId: string,
    workspace: string,
    artifact: JobArtifact
  ): Promise<{
    content: string | null;
    truncated: boolean;
    maxBytes: number;
    verification: JobArtifactVerification;
  }> {
    const source = await this.#sourceHead(workspace);
    const inspected = await this.#inspectArtifact(jobId, artifact, source);
    const trustedBytes =
      inspected.bytes !== null &&
      inspected.verification.file.sizeMatches &&
      inspected.verification.file.sha256Matches
        ? inspected.bytes
        : null;
    return {
      content:
        trustedBytes === null
          ? null
          : trustedBytes.subarray(0, MAX_ARTIFACT_PREVIEW_BYTES).toString('utf8'),
      truncated: trustedBytes !== null && trustedBytes.byteLength > MAX_ARTIFACT_PREVIEW_BYTES,
      maxBytes: MAX_ARTIFACT_PREVIEW_BYTES,
      verification: inspected.verification,
    };
  }

  async validateArtifact(
    jobId: string,
    workspace: string,
    artifact: JobArtifact,
    config: ArtifactValidationConfig,
    signal: AbortSignal
  ): Promise<ArtifactValidationExecution> {
    if (artifact.size < 1 || artifact.size > MAX_ARTIFACT_VALIDATION_PATCH_BYTES) {
      return {
        status: 'unavailable',
        reason: 'artifact-invalid',
        cleanup: 'not-started',
      };
    }
    let inspection: WorkspaceInspection;
    try {
      inspection = await this.inspect(workspace);
    } catch (error) {
      return {
        status: 'unavailable',
        reason:
          error instanceof Error && error.message.startsWith('Workspace repository is not clean:')
            ? 'source-dirty'
            : 'validation-start-failed',
        cleanup: 'not-started',
        error,
      };
    }

    const inspected = await this.#inspectArtifact(jobId, artifact, {
      repositoryAvailable: true,
      actualHead: inspection.baseCommit,
    });
    if (!inspected.verification.valid || inspected.bytes === null) {
      return {
        status: 'unavailable',
        reason: 'artifact-invalid',
        cleanup: 'not-started',
      };
    }
    if (signal.aborted) {
      return {
        status: 'unavailable',
        reason: 'parent-cancelled',
        cleanup: 'not-started',
      };
    }

    let isolated: IsolatedWorkspace;
    try {
      isolated = await this.create(inspection, jobId, artifact.attempt);
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'validation-start-failed',
        cleanup: 'not-confirmed',
        error,
      };
    }

    let outcome: ArtifactValidationExecution | undefined;
    try {
      try {
        await gitWithInput(['apply', '--check', '--binary', '-'], isolated.managedPath, inspected.bytes);
        await gitWithInput(['apply', '--binary', '-'], isolated.managedPath, inspected.bytes);
      } catch (error) {
        outcome = {
          status: 'unavailable',
          reason: 'patch-apply-failed',
          cleanup: 'cleaned',
          error,
        };
      }

      if (outcome === undefined) {
        const command = await runArtifactValidationCommand(config, isolated.path, signal);
        outcome =
          command.outcome === 'cancelled'
            ? {
                status: 'unavailable',
                reason: 'parent-cancelled',
                cleanup: 'cleaned',
                command,
              }
            : { status: 'completed', command, cleanup: 'cleaned' };
      }
    } catch (error) {
      outcome = {
        status: 'unavailable',
        reason: 'validation-start-failed',
        cleanup: 'cleaned',
        error,
      };
    } finally {
      try {
        await this.cleanup(isolated);
      } catch (error) {
        outcome = {
          status: 'unavailable',
          reason: 'cleanup-failed',
          cleanup: 'failed',
          ...(outcome?.command === undefined ? {} : { command: outcome.command }),
          error,
        };
      }
    }
    return outcome as ArtifactValidationExecution;
  }

  async #inspectArtifact(
    jobId: string,
    artifact: JobArtifact,
    source: { repositoryAvailable: boolean; actualHead: string | null }
  ): Promise<InspectedArtifact> {
    const issues: JobArtifactVerificationIssue[] = [];
    const expectedPath = path.resolve(
      this.#artifactDirectory,
      jobId,
      `attempt-${artifact.attempt}.patch`
    );
    const managedPathMatches = path.resolve(artifact.path) === expectedPath;
    if (!managedPathMatches) issues.push('artifact-path-mismatch');
    if (artifact.kind !== 'git-patch') issues.push('artifact-kind-unsupported');

    let bytes: Buffer | null = null;
    let actualSize: number | null = null;
    let exists = false;
    if (managedPathMatches && artifact.kind === 'git-patch') {
      try {
        exists = true;
        const artifactStat = await lstat(expectedPath);
        if (!artifactStat.isFile()) {
          issues.push('artifact-file-unreadable');
        } else if (artifactStat.size > MAX_ARTIFACT_BYTES) {
          actualSize = artifactStat.size;
          issues.push('artifact-size-limit-exceeded');
        } else {
          bytes = await readFile(expectedPath);
          actualSize = bytes.byteLength;
        }
      } catch (error) {
        exists = (error as NodeJS.ErrnoException).code !== 'ENOENT';
        const code = (error as NodeJS.ErrnoException).code;
        issues.push(code === 'ENOENT' ? 'artifact-file-missing' : 'artifact-file-unreadable');
      }
    }

    const actualSha256 = bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
    const sizeMatches = actualSize !== null && actualSize === artifact.size;
    const sha256Matches = actualSha256 !== null && actualSha256 === artifact.sha256;
    if (actualSize !== null && !sizeMatches) issues.push('artifact-size-mismatch');
    if (bytes !== null && !sha256Matches) issues.push('artifact-sha256-mismatch');
    if (!source.repositoryAvailable) issues.push('source-repository-unavailable');
    const headMatchesBase = source.actualHead !== null && source.actualHead === artifact.baseCommit;
    if (source.repositoryAvailable && !headMatchesBase) issues.push('base-commit-mismatch');

    const verification: JobArtifactVerification = {
      artifact: structuredClone(artifact),
      file: {
        exists,
        expectedSize: artifact.size,
        actualSize,
        sizeMatches,
        expectedSha256: artifact.sha256,
        actualSha256,
        sha256Matches,
      },
      source: {
        repositoryAvailable: source.repositoryAvailable,
        expectedBaseCommit: artifact.baseCommit,
        actualHead: source.actualHead,
        headMatchesBase,
      },
      issues,
      valid: issues.length === 0,
    };
    return { verification, bytes };
  }

  async #sourceHead(
    workspace: string
  ): Promise<{ repositoryAvailable: boolean; actualHead: string | null }> {
    try {
      const repository = await this.#repository(workspace);
      const actualHead = await this.#currentHead(repository);
      return { repositoryAvailable: actualHead !== '', actualHead: actualHead || null };
    } catch {
      return { repositoryAvailable: false, actualHead: null };
    }
  }

  async #repository(workspace: string): Promise<string> {
    return path.resolve(outputText((await git(['rev-parse', '--show-toplevel'], workspace)).stdout).trim());
  }

  async #currentHead(repository: string): Promise<string> {
    return outputText((await git(['rev-parse', '--verify', 'HEAD^{commit}'], repository)).stdout).trim();
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
    const managedPath = path.join(root, `${jobId}-attempt-${attempt}-${randomUUID()}`);
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
    // Run Git from the worktree root so these are repository-relative paths. `-z` keeps
    // newlines and other unusual filename characters out of any line-oriented representation.
    const changedFiles = nulDelimitedPaths(
      (
        await git(
          ['diff', '--name-only', '-z', '--no-ext-diff', isolated.baseCommit, '--'],
          isolated.managedPath,
          true
        )
      ).stdout
    );
    const patch = (await git(
      ['diff', '--binary', '--no-ext-diff', isolated.baseCommit, '--'],
      isolated.managedPath,
      true
    )).stdout;
    const bytes = Buffer.isBuffer(patch) ? patch : Buffer.from(patch);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new ArtifactSizeLimitError(bytes.byteLength);
    }
    const directory = path.resolve(this.#artifactDirectory, jobId);
    await mkdir(directory, { recursive: true });
    const artifactPath = path.join(directory, `attempt-${attempt}.patch`);
    const temporaryPath = `${artifactPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, bytes, { mode: 0o600 });
      await rename(temporaryPath, artifactPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      await rmdir(directory).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== 'ENOENT' && cleanupError.code !== 'ENOTEMPTY') throw cleanupError;
      });
      throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return {
      kind: 'git-patch',
      attempt,
      path: artifactPath,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      baseCommit: isolated.baseCommit,
      changedFiles,
    };
  }

  async discardPatch(jobId: string, artifact: JobArtifact): Promise<void> {
    if (!/^job_[A-Za-z0-9_-]+$/.test(jobId)) throw new Error(`Invalid artifact job id: ${jobId}`);
    const directory = path.resolve(this.#artifactDirectory, jobId);
    const expectedPath = path.join(directory, `attempt-${artifact.attempt}.patch`);
    if (artifact.kind !== 'git-patch' || path.resolve(artifact.path) !== expectedPath) {
      throw new Error(`Refusing to remove unmanaged artifact path: ${artifact.path}`);
    }
    await rm(expectedPath, { force: true });
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    });
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

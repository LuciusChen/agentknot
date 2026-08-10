import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type { ArtifactValidationConfig } from './config.js';
import type { ArtifactValidationCommandEvidence } from './orchestration-types.js';

const CHILD_SIGTERM_GRACE_MS = 100;

export const MAX_ARTIFACT_VALIDATION_PATCH_BYTES = 32 * 1024;

export type ArtifactValidationExecution =
  | {
      status: 'completed';
      command: ArtifactValidationCommandEvidence;
      cleanup: 'cleaned';
    }
  | {
      status: 'unavailable';
      reason:
        | 'artifact-invalid'
        | 'source-dirty'
        | 'patch-apply-failed'
        | 'validation-start-failed'
        | 'cleanup-failed'
        | 'parent-cancelled';
      cleanup: 'not-started' | 'cleaned' | 'failed' | 'not-confirmed';
      command?: ArtifactValidationCommandEvidence;
      error?: unknown;
    };

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Artifact validation cancelled');
}

function decodeCompleteUtf8(bytes: Buffer): string {
  const decoder = new StringDecoder('utf8');
  return decoder.write(bytes);
}

export async function runArtifactValidationCommand(
  config: ArtifactValidationConfig,
  cwd: string,
  signal: AbortSignal,
  now: () => number = () => Date.now()
): Promise<ArtifactValidationCommandEvidence> {
  const startedAt = now();
  if (signal.aborted) {
    const cancellationBytes = Buffer.from(abortReason(signal).message);
    const retainedCancellation = cancellationBytes.subarray(0, config.maxOutputBytes);
    return {
      argv: [...config.argv],
      outcome: 'cancelled',
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: '',
      stderr: decodeCompleteUtf8(retainedCancellation),
      outputTruncated: cancellationBytes.byteLength > config.maxOutputBytes,
      maxOutputBytes: config.maxOutputBytes,
    };
  }

  const child = spawn(config.argv[0]!, config.argv.slice(1), {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let retainedBytes = 0;
  let outputLimited = false;
  let timedOut = false;
  let cancelled = false;
  let spawnError: Error | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    killTimer ??= setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // The exact owned child may have exited between the state check and kill.
      }
    }, CHILD_SIGTERM_GRACE_MS);
  };

  const retain = (target: Buffer[], chunk: Buffer) => {
    const remaining = config.maxOutputBytes - retainedBytes;
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      target.push(kept);
      retainedBytes += kept.byteLength;
    }
    if (chunk.byteLength > remaining) {
      outputLimited = true;
      terminate();
    }
  };
  child.stdout.on('data', (chunk: Buffer) => retain(stdout, chunk));
  child.stderr.on('data', (chunk: Buffer) => retain(stderr, chunk));

  const onAbort = () => {
    cancelled = true;
    terminate();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, config.timeoutMs);

  const closed = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });

  clearTimeout(timeout);
  if (killTimer !== undefined) clearTimeout(killTimer);
  signal.removeEventListener('abort', onAbort);

  const stderrText = decodeCompleteUtf8(Buffer.concat(stderr));
  const spawnErrorSuffix =
    spawnError === undefined
      ? undefined
      : Buffer.from(`${stderrText === '' ? '' : '\n'}${spawnError.message}`);
  const spawnErrorRemaining = config.maxOutputBytes - retainedBytes;
  const retainedSpawnError =
    spawnErrorSuffix === undefined
      ? Buffer.alloc(0)
      : spawnErrorSuffix.subarray(0, Math.max(0, spawnErrorRemaining));
  const spawnErrorTruncated =
    spawnErrorSuffix !== undefined && spawnErrorSuffix.byteLength > spawnErrorRemaining;
  const outcome = cancelled
    ? 'cancelled'
    : outputLimited
      ? 'output-limit'
      : timedOut
        ? 'timed-out'
        : spawnError !== undefined || closed.code !== 0
          ? 'failed'
          : 'passed';
  return {
    argv: [...config.argv],
    outcome,
    exitCode: closed.code,
    signal: closed.signal,
    durationMs: Math.max(0, now() - startedAt),
    stdout: decodeCompleteUtf8(Buffer.concat(stdout)),
    stderr: `${stderrText}${decodeCompleteUtf8(retainedSpawnError)}`,
    outputTruncated: outputLimited || spawnErrorTruncated,
    maxOutputBytes: config.maxOutputBytes,
  };
}

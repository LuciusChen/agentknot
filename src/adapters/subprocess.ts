import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type EffectiveEnvironment = NodeJS.ProcessEnv;

export class StrictJsonlDecoder {
  readonly #decoder = new StringDecoder('utf8');
  #buffer = '';

  push(chunk: Buffer): string[] {
    this.#buffer += this.#decoder.write(chunk);
    return this.#takeLines();
  }

  end(): string[] {
    this.#buffer += this.#decoder.end();
    const lines = this.#takeLines();
    if (this.#buffer !== '') {
      lines.push(this.#buffer.endsWith('\r') ? this.#buffer.slice(0, -1) : this.#buffer);
      this.#buffer = '';
    }
    return lines;
  }

  #takeLines(): string[] {
    const lines: string[] = [];
    let index: number;
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      let line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line !== '') lines.push(line);
    }
    return lines;
  }
}

export function effectiveEnvironment(
  configuredEnvironment?: Record<string, string>
): EffectiveEnvironment {
  return { ...process.env, ...configuredEnvironment };
}

function commandCandidates(command: string, environment: EffectiveEnvironment): string[] {
  if (command.includes(path.sep)) return [path.resolve(command)];
  const searchPath = environment.PATH ?? '';
  return searchPath
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, command));
}

export async function findCommand(
  command: string,
  environment: EffectiveEnvironment
): Promise<string | undefined> {
  for (const candidate of commandCandidates(command, environment)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

export function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

export function childExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (childExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      child.off('error', done);
      child.off('exit', done);
      resolve();
    };
    child.once('error', done);
    child.once('exit', done);
  });
}

export function waitForPromiseOrTimeout(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve(false);
    }, timeoutMs);
    void promise.then(
      () => {
        if (timedOut) return;
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        if (timedOut) return;
        clearTimeout(timer);
        resolve(true);
      }
    );
  });
}

const CHILD_SIGTERM_GRACE_MS = 100;
const CHILD_SIGKILL_WAIT_MS = 1_000;
const CHILD_OUTPUT_DRAIN_GRACE_MS = 1_000;

export async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<void>
): Promise<void> {
  if (childExited(child)) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // The owned child may have exited between the state check and kill.
  }
  if (await waitForPromiseOrTimeout(exit, CHILD_SIGTERM_GRACE_MS)) return;
  if (!childExited(child)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The owned child may have exited between the state check and kill.
    }
  }
  await waitForPromiseOrTimeout(exit, CHILD_SIGKILL_WAIT_MS);
}

export async function awaitChildOutput(
  child: ChildProcessWithoutNullStreams,
  stdoutTask: Promise<void>,
  stderrTask: Promise<void>
): Promise<void> {
  const output = Promise.allSettled([stdoutTask, stderrTask]);
  if (!(await waitForPromiseOrTimeout(output, CHILD_OUTPUT_DRAIN_GRACE_MS))) {
    child.stdout.destroy();
    child.stderr.destroy();
    return;
  }
  await output;
}

export const CHILD_OUTPUT_DRAIN_WAIT_MS = CHILD_OUTPUT_DRAIN_GRACE_MS;

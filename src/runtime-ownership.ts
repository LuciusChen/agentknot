import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';

const READY = 'AGENTKNOT_RUNTIME_OWNER_READY';
const HOLDER = `process.stdout.write(${JSON.stringify(`${READY}\n`)});process.stdin.resume()`;
const ACQUIRE_TIMEOUT_MS = 5_000;
const RELEASE_TIMEOUT_MS = 1_000;

export class RuntimeOwnershipError extends Error {
  readonly name = 'RuntimeOwnershipError';
}

interface HeldDirectory {
  child: ChildProcess;
  directory: string;
  lost: Error | undefined;
  closing: boolean;
}

export class RuntimeOwnership {
  #closed = false;
  readonly #handles: HeldDirectory[];

  constructor(readonly directories: string[], handles: HeldDirectory[]) {
    this.#handles = handles;
  }

  assertHeld(): void {
    if (this.#closed) throw new RuntimeOwnershipError('Runtime storage ownership has been released');
    const lost = this.#handles.find((handle) => handle.lost !== undefined);
    if (lost?.lost) throw lost.lost;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await Promise.all(this.#handles.map((handle) => releaseDirectory(handle)));
    this.#closed = true;
  }
}

async function acquireDirectory(directory: string): Promise<HeldDirectory> {
  const child = spawn(
    'flock',
    ['--exclusive', '--nonblock', directory, process.execPath, '-e', HOLDER],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const handle: HeldDirectory = { child, directory, lost: undefined, closing: false };
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
  });

  await new Promise<void>((resolve, reject) => {
    let output = '';
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stdout?.off('data', onData);
    };
    const fail = (message: string, cause?: unknown): void => {
      cleanup();
      child.stdin?.end();
      reject(new RuntimeOwnershipError(message, cause === undefined ? undefined : { cause }));
    };
    const onError = (error: Error): void => {
      fail(`Cannot acquire runtime ownership for ${directory}: ${error.message}`, error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const details = stderr.trim();
      fail(
        code === 1 && details === ''
          ? `Another execution-owning AgentKnot runtime already owns storage directory: ${directory}`
          : `Runtime ownership helper exited before acquiring ${directory} (${code ?? signal})${details ? `: ${details}` : ''}`
      );
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (!output.includes(`${READY}\n`)) return;
      cleanup();
      resolve();
    };
    const timeout = setTimeout(() => {
      child.stdin?.end();
      child.kill('SIGTERM');
      fail(`Timed out acquiring runtime ownership for ${directory}`);
    }, ACQUIRE_TIMEOUT_MS);
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout?.on('data', onData);
  });

  child.stdout?.resume();
  child.stderr?.resume();
  const onOwnershipExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (!handle.closing) {
      handle.lost = new RuntimeOwnershipError(
        `Runtime storage ownership was lost for ${directory} (${code ?? signal})`
      );
    }
  };
  child.once('exit', onOwnershipExit);
  if (child.exitCode !== null || child.signalCode !== null) {
    child.off('exit', onOwnershipExit);
    onOwnershipExit(child.exitCode, child.signalCode);
  }
  return handle;
}

async function releaseDirectory(handle: HeldDirectory): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  handle.closing = true;
  const exited = new Promise<void>((resolve) => handle.child.once('exit', () => resolve()));
  handle.child.stdin?.end();
  if (await settleWithin(exited, RELEASE_TIMEOUT_MS)) return;
  handle.child.kill('SIGTERM');
  if (!(await settleWithin(exited, RELEASE_TIMEOUT_MS))) {
    throw new RuntimeOwnershipError(`Runtime ownership helper did not exit for ${handle.directory}`);
  }
}

async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return outcome;
}

export async function acquireRuntimeOwnership(
  storageDirectories: string[]
): Promise<RuntimeOwnership> {
  const directories = [
    ...new Set(
      await Promise.all(
        storageDirectories.map(async (directory) => {
          await mkdir(directory, { recursive: true });
          return realpath(directory);
        })
      )
    ),
  ].sort();
  if (directories.length !== storageDirectories.length) {
    throw new RuntimeOwnershipError(
      `Job and orchestration storage directories must resolve to distinct locations: ${directories[0]}`
    );
  }
  const handles: HeldDirectory[] = [];
  try {
    for (const directory of directories) handles.push(await acquireDirectory(directory));
    return new RuntimeOwnership(directories, handles);
  } catch (error) {
    await Promise.all(handles.map((handle) => releaseDirectory(handle)));
    throw error;
  }
}

import { DatabaseSync } from 'node:sqlite';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const LOCK_DATABASE_FILENAME = '.agentknot-runtime-lock.sqlite';
const SQLITE_ACQUIRE_TIMEOUT_MS = 0;
const MAX_ERROR_MESSAGE_BYTES = 512;

export class RuntimeOwnershipError extends Error {
  readonly name = 'RuntimeOwnershipError';
}

interface HeldDirectory {
  readonly database: DatabaseSync;
  readonly directory: string;
  closed: boolean;
}

function boundedText(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= MAX_ERROR_MESSAGE_BYTES) return value;
  const suffix = '…';
  const prefixLimit = MAX_ERROR_MESSAGE_BYTES - Buffer.byteLength(suffix);
  let prefix = bytes.subarray(0, prefixLimit).toString('utf8');
  while (Buffer.byteLength(prefix) > prefixLimit) prefix = prefix.slice(0, -1);
  return `${prefix}${suffix}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return boundedText(error.message || error.name);
  }
  return boundedText(String(error));
}

function isContention(error: unknown): boolean {
  const message = errorText(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  return (
    code === 'SQLITE_BUSY' ||
    code === 'ERR_SQLITE_BUSY' ||
    /\b(?:database|table|schema)(?: [a-z]+)* is (?:locked|busy)\b/i.test(message)
  );
}

function wrapAcquisitionError(directory: string, error: unknown): RuntimeOwnershipError {
  if (isContention(error)) {
    return new RuntimeOwnershipError(
      boundedText(
        `Another execution-owning AgentKnot runtime already owns storage directory: ${directory}`
      ),
      { cause: error }
    );
  }
  return new RuntimeOwnershipError(
    boundedText(`Cannot acquire runtime ownership for ${directory}: ${errorText(error)}`),
    { cause: error }
  );
}

function closeDirectory(handle: HeldDirectory): void {
  if (handle.closed) return;
  handle.closed = true;
  try {
    handle.database.close();
  } catch (error) {
    throw new RuntimeOwnershipError(
      boundedText(`Cannot release runtime ownership for ${handle.directory}: ${errorText(error)}`),
      { cause: error }
    );
  }
}

async function closeDirectories(handles: HeldDirectory[]): Promise<unknown[]> {
  const outcomes = await Promise.allSettled(
    handles.map(async (handle) => {
      closeDirectory(handle);
    })
  );
  return outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []));
}

export class RuntimeOwnership {
  #closed = false;
  #closePromise: Promise<void> | undefined;
  readonly #handles: HeldDirectory[];

  constructor(readonly directories: string[], handles: HeldDirectory[]) {
    this.#handles = handles;
  }

  assertHeld(): void {
    if (this.#closed) throw new RuntimeOwnershipError('Runtime storage ownership has been released');
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#closePromise !== undefined) return this.#closePromise;

    const closePromise = (async (): Promise<void> => {
      const failures = await closeDirectories(this.#handles);
      this.#closed = true;
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Failed to release runtime storage ownership');
      }
    })();
    this.#closePromise = closePromise;
    return closePromise;
  }
}

function acquireDirectory(directory: string): HeldDirectory {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path.join(directory, LOCK_DATABASE_FILENAME), {
      timeout: SQLITE_ACQUIRE_TIMEOUT_MS,
    });
    database.exec('PRAGMA journal_mode=MEMORY');
    database.exec('BEGIN EXCLUSIVE');
    return { database, directory, closed: false };
  } catch (error) {
    let cleanupError: unknown;
    if (database !== undefined) {
      try {
        database.close();
      } catch (closeError) {
        cleanupError = closeError;
      }
    }
    const acquisitionError = wrapAcquisitionError(directory, error);
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [acquisitionError, cleanupError],
        boundedText(`Runtime ownership acquisition cleanup failed for ${directory}`)
      );
    }
    throw acquisitionError;
  }
}

async function resolveDirectories(storageDirectories: string[]): Promise<string[]> {
  try {
    const resolved = await Promise.all(
      storageDirectories.map(async (directory) => {
        await mkdir(directory, { recursive: true });
        return realpath(directory);
      })
    );
    return [...new Set(resolved)].sort();
  } catch (error) {
    throw new RuntimeOwnershipError(
      boundedText(`Cannot prepare runtime ownership directories: ${errorText(error)}`),
      { cause: error }
    );
  }
}

export async function acquireRuntimeOwnership(
  storageDirectories: string[]
): Promise<RuntimeOwnership> {
  const directories = await resolveDirectories(storageDirectories);
  if (directories.length !== storageDirectories.length) {
    throw new RuntimeOwnershipError(
      boundedText(
        `Job and orchestration storage directories must resolve to distinct locations: ${directories[0] ?? ''}`
      )
    );
  }

  const handles: HeldDirectory[] = [];
  try {
    for (const directory of directories) handles.push(acquireDirectory(directory));
    return new RuntimeOwnership(directories, handles);
  } catch (error) {
    const cleanupFailures = await closeDirectories(handles);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Runtime ownership acquisition cleanup failed'
      );
    }
    throw error;
  }
}

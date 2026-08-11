import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireRuntimeOwnership, type RuntimeOwnership } from './runtime-ownership.js';

export const LOCAL_DISCOVERY_SCHEMA_VERSION = 1 as const;
export const MAX_LOCAL_DISCOVERY_RECORD_BYTES = 4 * 1024;
export const LOCAL_DISCOVERY_RECORD_FILE = 'server.json';

const DISCOVERY_DIRECTORY_MODE = 0o700;
const DISCOVERY_RECORD_MODE = 0o600;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCAL_URL_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

export interface LocalDiscoveryEnvironment {
  readonly XDG_RUNTIME_DIR?: string | undefined;
  readonly XDG_CACHE_HOME?: string | undefined;
  readonly XDG_CONFIG_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  readonly USERPROFILE?: string | undefined;
  readonly APPDATA?: string | undefined;
}

export interface LocalDiscoveryPathOptions {
  readonly environment?: LocalDiscoveryEnvironment;
}

export interface LocalDiscoveryRegistrationOptions extends LocalDiscoveryPathOptions {
  readonly now?: () => Date;
}

export interface LocalDiscoveryPaths {
  readonly directory: string;
  readonly recordPath: string;
}

export interface LocalDiscoveryRecord {
  readonly schemaVersion: typeof LOCAL_DISCOVERY_SCHEMA_VERSION;
  readonly url: string;
  readonly instanceId: string;
  readonly startedAt: string;
}

export class LocalDiscoveryValidationError extends Error {
  readonly name = 'LocalDiscoveryValidationError';
}

export interface LocalDiscoveryRegistration {
  readonly paths: LocalDiscoveryPaths;
  readonly instanceId: string;
  readonly startedAt: string;
  publish(port: number): Promise<LocalDiscoveryRecord>;
  read(): Promise<LocalDiscoveryRecord | undefined>;
  cleanup(): Promise<boolean>;
  close(): Promise<void>;
}

function invalidRecord(message: string): never {
  throw new LocalDiscoveryValidationError(`Invalid local discovery record: ${message}`);
}

function invalidDirectory(message: string): never {
  throw new LocalDiscoveryValidationError(`Invalid local discovery directory: ${message}`);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isOwnedByCurrentUser(stats: Stats): boolean {
  const uid = process.getuid?.();
  return uid === undefined || stats.uid === uid;
}

function hasMode(stats: Stats, expected: number): boolean {
  return (stats.mode & 0o7777) === expected;
}

function assertOwnedDirectoryStats(stats: Stats, directory: string): void {
  if (stats.isSymbolicLink()) invalidDirectory(`${directory} must not be a symlink`);
  if (!stats.isDirectory()) invalidDirectory(`${directory} must be a directory`);
  if (!isOwnedByCurrentUser(stats)) invalidDirectory(`${directory} is not owned by the current user`);
  if (!hasMode(stats, DISCOVERY_DIRECTORY_MODE)) {
    invalidDirectory(`${directory} must have mode 0700`);
  }
}

async function isValidRuntimeDirectory(directory: string): Promise<boolean> {
  if (!path.isAbsolute(directory)) return false;
  let stats: Stats;
  try {
    stats = await lstat(directory);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  if (!isOwnedByCurrentUser(stats)) return false;
  return hasMode(stats, DISCOVERY_DIRECTORY_MODE);
}

function environmentFor(options: LocalDiscoveryPathOptions): LocalDiscoveryEnvironment {
  return options.environment ?? process.env;
}

function homeFor(environment: LocalDiscoveryEnvironment): string {
  const configured = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(os.homedir());
}

function pathsFor(directory: string): LocalDiscoveryPaths {
  const absoluteDirectory = path.resolve(directory);
  return {
    directory: absoluteDirectory,
    recordPath: path.join(absoluteDirectory, LOCAL_DISCOVERY_RECORD_FILE),
  };
}

export async function resolveLocalDiscoveryPaths(
  options: LocalDiscoveryPathOptions = {}
): Promise<LocalDiscoveryPaths> {
  const environment = environmentFor(options);
  const configuredRuntimeDirectory = environment.XDG_RUNTIME_DIR;
  if (
    configuredRuntimeDirectory !== undefined &&
    path.isAbsolute(configuredRuntimeDirectory) &&
    (await isValidRuntimeDirectory(path.resolve(configuredRuntimeDirectory)))
  ) {
    return pathsFor(path.join(configuredRuntimeDirectory, 'agentknot'));
  }

  const configuredCacheHome = environment.XDG_CACHE_HOME;
  const cacheHome =
    configuredCacheHome !== undefined && path.isAbsolute(configuredCacheHome)
      ? path.resolve(configuredCacheHome)
      : path.join(homeFor(environment), '.cache');
  return pathsFor(path.join(cacheHome, 'agentknot'));
}

async function ensureOwnedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: DISCOVERY_DIRECTORY_MODE });
  let stats = await lstat(directory);
  if (stats.isSymbolicLink()) invalidDirectory(`${directory} must not be a symlink`);
  if (!stats.isDirectory()) invalidDirectory(`${directory} must be a directory`);
  if (!isOwnedByCurrentUser(stats)) invalidDirectory(`${directory} is not owned by the current user`);

  await chmod(directory, DISCOVERY_DIRECTORY_MODE);
  stats = await lstat(directory);
  assertOwnedDirectoryStats(stats, directory);
}

function isValidLocalUrl(value: string): boolean {
  const match = LOCAL_URL_PATTERN.exec(value);
  if (match === null) return false;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535;
}

function localUrl(port: number): string {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new LocalDiscoveryValidationError(
      `Local discovery port must be a nonzero integer from 1 through 65535; received ${String(port)}`
    );
  }
  return `http://127.0.0.1:${port}`;
}

function isValidStartedAt(value: string): boolean {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

export function validateLocalDiscoveryRecord(value: unknown): LocalDiscoveryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidRecord('record must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidRecord('record must be a plain object');
  }

  const record = value as Record<string, unknown>;
  const expectedFields = ['schemaVersion', 'url', 'instanceId', 'startedAt'];
  const fields = Object.keys(record);
  const missing = expectedFields.filter((field) => !Object.hasOwn(record, field));
  const unknown = fields.filter((field) => !expectedFields.includes(field));
  if (missing.length > 0) invalidRecord(`missing field ${missing.join(', ')}`);
  if (unknown.length > 0) invalidRecord(`unknown field ${unknown.join(', ')}`);
  if (fields.length !== expectedFields.length) invalidRecord('record fields must be unique and exact');

  if (record.schemaVersion !== LOCAL_DISCOVERY_SCHEMA_VERSION) {
    invalidRecord('schemaVersion must be exactly 1');
  }
  if (typeof record.url !== 'string' || !isValidLocalUrl(record.url)) {
    invalidRecord('url must be exactly http://127.0.0.1:<nonzero-port>');
  }
  if (typeof record.instanceId !== 'string' || !UUID_V4_PATTERN.test(record.instanceId)) {
    invalidRecord('instanceId must be an unguessable UUIDv4');
  }
  if (typeof record.startedAt !== 'string' || !isValidStartedAt(record.startedAt)) {
    invalidRecord('startedAt must be a canonical ISO-8601 timestamp');
  }

  const normalized: LocalDiscoveryRecord = {
    schemaVersion: LOCAL_DISCOVERY_SCHEMA_VERSION,
    url: record.url,
    instanceId: record.instanceId,
    startedAt: record.startedAt,
  };
  const serialized = `${JSON.stringify(normalized)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_LOCAL_DISCOVERY_RECORD_BYTES) {
    invalidRecord(`record exceeds ${MAX_LOCAL_DISCOVERY_RECORD_BYTES} bytes`);
  }
  return normalized;
}

async function readRecordAtPath(recordPath: string): Promise<LocalDiscoveryRecord | undefined> {
  let stats: Stats;
  try {
    stats = await lstat(recordPath);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }

  if (stats.isSymbolicLink()) invalidRecord(`${recordPath} must not be a symlink`);
  if (!stats.isFile()) invalidRecord(`${recordPath} must be a regular file`);
  if (!isOwnedByCurrentUser(stats)) invalidRecord(`${recordPath} is not owned by the current user`);
  if (!hasMode(stats, DISCOVERY_RECORD_MODE)) {
    invalidRecord(`${recordPath} must have mode 0600`);
  }
  if (stats.size > MAX_LOCAL_DISCOVERY_RECORD_BYTES) {
    invalidRecord(`record exceeds ${MAX_LOCAL_DISCOVERY_RECORD_BYTES} bytes`);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(recordPath);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (bytes.byteLength > MAX_LOCAL_DISCOVERY_RECORD_BYTES) {
    invalidRecord(`record exceeds ${MAX_LOCAL_DISCOVERY_RECORD_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new LocalDiscoveryValidationError('Invalid local discovery record: malformed JSON', {
      cause: error,
    });
  }
  return validateLocalDiscoveryRecord(parsed);
}

export async function readLocalDiscovery(
  options: LocalDiscoveryPathOptions = {}
): Promise<LocalDiscoveryRecord | undefined> {
  const paths = await resolveLocalDiscoveryPaths(options);
  let stats: Stats;
  try {
    stats = await lstat(paths.directory);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  assertOwnedDirectoryStats(stats, paths.directory);
  return readRecordAtPath(paths.recordPath);
}

export async function removeLocalDiscoveryIfIdentity(
  instanceId: string,
  options: LocalDiscoveryPathOptions = {}
): Promise<boolean> {
  const paths = await resolveLocalDiscoveryPaths(options);
  let directoryStats: Stats;
  try {
    directoryStats = await lstat(paths.directory);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  assertOwnedDirectoryStats(directoryStats, paths.directory);
  const directory = await realpath(paths.directory);
  const ownership = await acquireRuntimeOwnership([directory]);
  try {
    const current = await readRecordAtPath(path.join(directory, LOCAL_DISCOVERY_RECORD_FILE));
    if (current === undefined || current.instanceId !== instanceId) return false;
    try {
      await unlink(path.join(directory, LOCAL_DISCOVERY_RECORD_FILE));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  } finally {
    await ownership.close();
  }
}

function serializeRecord(record: LocalDiscoveryRecord): string {
  const normalized = validateLocalDiscoveryRecord(record);
  const serialized = `${JSON.stringify(normalized)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_LOCAL_DISCOVERY_RECORD_BYTES) {
    invalidRecord(`record exceeds ${MAX_LOCAL_DISCOVERY_RECORD_BYTES} bytes`);
  }
  return serialized;
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function atomicallyWriteRecord(recordPath: string, record: LocalDiscoveryRecord, directory: string): Promise<void> {
  const serialized = serializeRecord(record);
  const temporaryPath = path.join(
    directory,
    `.${LOCAL_DISCOVERY_RECORD_FILE}.${record.instanceId}.${randomUUID()}.tmp`
  );
  let renamed = false;
  let failure: unknown;
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: DISCOVERY_RECORD_MODE });
    await chmod(temporaryPath, DISCOVERY_RECORD_MODE);
    const stats = await lstat(temporaryPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      invalidRecord(`${temporaryPath} must be a regular file`);
    }
    if (!isOwnedByCurrentUser(stats) || !hasMode(stats, DISCOVERY_RECORD_MODE)) {
      invalidRecord(`${temporaryPath} must be an owned mode-0600 file`);
    }
    await rename(temporaryPath, recordPath);
    renamed = true;
  } catch (error) {
    failure = error;
  }

  if (!renamed) {
    try {
      await removeIfPresent(temporaryPath);
    } catch (cleanupError) {
      if (failure !== undefined) {
        throw new AggregateError([failure, cleanupError], 'Local discovery record cleanup failed');
      }
      throw cleanupError;
    }
  }
  if (failure !== undefined) throw failure;
}

async function assertPublishTarget(recordPath: string): Promise<void> {
  await readRecordAtPath(recordPath);
}

class LocalDiscoveryRegistrationImpl implements LocalDiscoveryRegistration {
  #closed = false;
  #published = false;
  readonly #ownership: RuntimeOwnership;

  constructor(
    readonly paths: LocalDiscoveryPaths,
    readonly instanceId: string,
    readonly startedAt: string,
    ownership: RuntimeOwnership
  ) {
    this.#ownership = ownership;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Local discovery registration has been closed');
  }

  async publish(port: number): Promise<LocalDiscoveryRecord> {
    this.#assertOpen();
    this.#ownership.assertHeld();
    const record: LocalDiscoveryRecord = {
      schemaVersion: LOCAL_DISCOVERY_SCHEMA_VERSION,
      url: localUrl(port),
      instanceId: this.instanceId,
      startedAt: this.startedAt,
    };
    await ensureOwnedDirectory(this.paths.directory);
    await assertPublishTarget(this.paths.recordPath);
    await atomicallyWriteRecord(this.paths.recordPath, record, this.paths.directory);
    this.#published = true;
    return record;
  }

  async read(): Promise<LocalDiscoveryRecord | undefined> {
    return readRecordAtPath(this.paths.recordPath);
  }

  async cleanup(): Promise<boolean> {
    this.#assertOpen();
    if (!this.#published) return false;
    this.#ownership.assertHeld();
    const current = await readRecordAtPath(this.paths.recordPath);
    if (current === undefined || current.instanceId !== this.instanceId) return false;
    try {
      await unlink(this.paths.recordPath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    let cleanupError: unknown;
    try {
      await this.cleanup();
    } catch (error) {
      cleanupError = error;
    }

    let releaseError: unknown;
    try {
      await this.#ownership.close();
    } catch (error) {
      releaseError = error;
    } finally {
      this.#closed = true;
    }

    if (cleanupError !== undefined && releaseError !== undefined) {
      throw new AggregateError([cleanupError, releaseError], 'Local discovery close failed');
    }
    if (cleanupError !== undefined) throw cleanupError;
    if (releaseError !== undefined) throw releaseError;
  }
}

export async function createLocalDiscoveryRegistration(
  options: LocalDiscoveryRegistrationOptions = {}
): Promise<LocalDiscoveryRegistration> {
  const selectedPaths = await resolveLocalDiscoveryPaths(options);
  await ensureOwnedDirectory(selectedPaths.directory);
  const directory = await realpath(selectedPaths.directory);
  const ownership = await acquireRuntimeOwnership([directory]);
  try {
    const now = options.now?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
      throw new Error('Local discovery registration clock returned an invalid date');
    }
    return new LocalDiscoveryRegistrationImpl(
      pathsFor(directory),
      randomUUID(),
      now.toISOString(),
      ownership
    );
  } catch (error) {
    await ownership.close();
    throw error;
  }
}

import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BROKER_LAUNCH_PROFILE_SCHEMA_VERSION = 1 as const;
export const MAX_BROKER_LAUNCH_PROFILE_BYTES = 4 * 1024;

const PROFILE_DIRECTORY_MODE = 0o700;
const PROFILE_FILE_MODE = 0o600;
const PROFILE_FILE_NAME = 'broker-launch.json';

export interface BrokerProfileEnvironment {
  readonly XDG_CONFIG_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  readonly USERPROFILE?: string | undefined;
  readonly APPDATA?: string | undefined;
}

export interface BrokerProfileOptions {
  readonly environment?: BrokerProfileEnvironment;
  readonly platform?: NodeJS.Platform;
}

export interface BrokerLaunchProfile {
  readonly schemaVersion: typeof BROKER_LAUNCH_PROFILE_SCHEMA_VERSION;
  readonly configPath: string;
  readonly port: number;
}

export class BrokerProfileValidationError extends Error {
  readonly name = 'BrokerProfileValidationError';
}

function invalid(message: string): never {
  throw new BrokerProfileValidationError(`Invalid broker launch profile: ${message}`);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function homeFor(environment: BrokerProfileEnvironment): string {
  const configured = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(os.homedir());
}

export function resolveBrokerLaunchProfilePath(options: BrokerProfileOptions = {}): string {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const xdg = environment.XDG_CONFIG_HOME;
  if (xdg !== undefined && path.isAbsolute(xdg)) {
    return path.join(path.resolve(xdg), 'agentknot', PROFILE_FILE_NAME);
  }
  if (platform === 'win32') {
    const appData = environment.APPDATA;
    const base = appData !== undefined && path.isAbsolute(appData)
      ? path.resolve(appData)
      : path.join(homeFor(environment), 'AppData', 'Roaming');
    return path.join(base, 'AgentKnot', PROFILE_FILE_NAME);
  }
  if (platform === 'darwin') {
    return path.join(homeFor(environment), 'Library', 'Application Support', 'AgentKnot', PROFILE_FILE_NAME);
  }
  return path.join(homeFor(environment), '.config', 'agentknot', PROFILE_FILE_NAME);
}

function isOwnedByCurrentUser(stats: Stats): boolean {
  const uid = process.getuid?.();
  return uid === undefined || stats.uid === uid;
}

function assertSecureFile(stats: Stats, filePath: string, platform: NodeJS.Platform): void {
  if (stats.isSymbolicLink() || !stats.isFile()) invalid(`${filePath} must be a regular file`);
  if (!isOwnedByCurrentUser(stats)) invalid(`${filePath} is not owned by the current user`);
  if (platform !== 'win32' && (stats.mode & 0o7777) !== PROFILE_FILE_MODE) {
    invalid(`${filePath} must have mode 0600`);
  }
}

export function validateBrokerLaunchProfile(value: unknown): BrokerLaunchProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('profile must be an object');
  }
  const profile = value as Record<string, unknown>;
  const fields = Object.keys(profile);
  const expected = ['schemaVersion', 'configPath', 'port'];
  if (expected.some((field) => !Object.hasOwn(profile, field)) || fields.some((field) => !expected.includes(field))) {
    invalid('profile fields must be exactly schemaVersion, configPath, and port');
  }
  if (profile.schemaVersion !== BROKER_LAUNCH_PROFILE_SCHEMA_VERSION) {
    invalid('schemaVersion must be exactly 1');
  }
  if (typeof profile.configPath !== 'string' || !path.isAbsolute(profile.configPath)) {
    invalid('configPath must be an absolute path');
  }
  if (!Number.isSafeInteger(profile.port) || (profile.port as number) < 0 || (profile.port as number) > 65_535) {
    invalid('port must be an integer from 0 through 65535');
  }
  return {
    schemaVersion: BROKER_LAUNCH_PROFILE_SCHEMA_VERSION,
    configPath: path.resolve(profile.configPath),
    port: profile.port as number,
  };
}

export async function readBrokerLaunchProfile(
  options: BrokerProfileOptions = {}
): Promise<BrokerLaunchProfile | undefined> {
  const filePath = resolveBrokerLaunchProfilePath(options);
  let stats: Stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  assertSecureFile(stats, filePath, options.platform ?? process.platform);
  if (stats.size > MAX_BROKER_LAUNCH_PROFILE_BYTES) invalid('profile exceeds 4096 bytes');
  const raw = await readFile(filePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BROKER_LAUNCH_PROFILE_BYTES) {
    invalid('profile exceeds 4096 bytes');
  }
  try {
    return validateBrokerLaunchProfile(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof BrokerProfileValidationError) throw error;
    invalid('profile must contain valid JSON');
  }
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export async function writeBrokerLaunchProfile(
  profile: Omit<BrokerLaunchProfile, 'schemaVersion'>,
  options: BrokerProfileOptions = {}
): Promise<BrokerLaunchProfile> {
  const normalized = validateBrokerLaunchProfile({
    schemaVersion: BROKER_LAUNCH_PROFILE_SCHEMA_VERSION,
    ...profile,
  });
  const filePath = resolveBrokerLaunchProfilePath(options);
  const directory = path.dirname(filePath);
  const platform = options.platform ?? process.platform;
  await mkdir(directory, { recursive: true, mode: PROFILE_DIRECTORY_MODE });
  let directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    invalid(`${directory} must be a directory`);
  }
  if (!isOwnedByCurrentUser(directoryStats)) invalid(`${directory} is not owned by the current user`);
  if (platform !== 'win32') {
    await chmod(directory, PROFILE_DIRECTORY_MODE);
    directoryStats = await lstat(directory);
    if ((directoryStats.mode & 0o7777) !== PROFILE_DIRECTORY_MODE) {
      invalid(`${directory} must have mode 0700`);
    }
  }

  const serialized = `${JSON.stringify(normalized)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BROKER_LAUNCH_PROFILE_BYTES) {
    invalid('profile exceeds 4096 bytes');
  }
  const temporaryPath = path.join(directory, `.${PROFILE_FILE_NAME}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: PROFILE_FILE_MODE });
    if (platform !== 'win32') await chmod(temporaryPath, PROFILE_FILE_MODE);
    assertSecureFile(await lstat(temporaryPath), temporaryPath, platform);
    await rename(temporaryPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) await removeIfPresent(temporaryPath);
  }
  return normalized;
}

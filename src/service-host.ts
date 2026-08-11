import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SERVICE_OWNERSHIP_MARKER = 'AGENTKNOT_SERVICE_HOST_V1';
export const SYSTEMD_UNIT_NAME = 'agentknot.service';
export const LAUNCHD_LABEL = 'dev.agentknot.service';

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export interface ServiceHostContext {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly environment?: Readonly<{ XDG_CONFIG_HOME?: string | undefined }>;
  readonly uid?: number;
}

export interface ServiceDefinition {
  readonly nodeExecutable: string;
  readonly cliEntryPath: string;
  readonly configPath: string;
  readonly executionPath: string;
  readonly host: string;
  readonly port: number;
}

export interface ServicePaths {
  readonly directory: string;
  readonly definitionPath: string;
  readonly identifier: string;
}

export interface ServiceStatus {
  readonly state: 'not-installed' | 'stopped' | 'running';
  readonly definitionPath: string;
}

export interface ServiceCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ServiceCommandExecutor = (
  command: string,
  args: readonly string[]
) => Promise<ServiceCommandResult>;

export class UnsupportedServicePlatformError extends Error {
  readonly name = 'UnsupportedServicePlatformError';
}

export class ServiceDefinitionError extends Error {
  readonly name = 'ServiceDefinitionError';
}

export class ServiceManagerCommandError extends Error {
  readonly name = 'ServiceManagerCommandError';

  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly result: ServiceCommandResult
  ) {
    super(
      `${command} ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || 'no output'}`
    );
  }
}

function defaultContext(): ServiceHostContext {
  return {
    platform: process.platform,
    homeDirectory: os.homedir(),
    environment: process.env,
    ...(process.getuid === undefined ? {} : { uid: process.getuid() }),
  };
}

function nativeExecutor(command: string, args: readonly string[]): Promise<ServiceCommandResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { encoding: 'utf8', shell: false }, (error, stdout, stderr) => {
      resolve({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : 127,
        stdout: String(stdout),
        stderr: `${String(stderr)}${error !== null && typeof error.code !== 'number' ? `${stderr ? '\n' : ''}${error.message}` : ''}`,
      });
    });
  });
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isCurrentUser(stats: Stats): boolean {
  const uid = process.getuid?.();
  return uid === undefined || stats.uid === uid;
}

function hasMode(stats: Stats, expected: number): boolean {
  return (stats.mode & 0o7777) === expected;
}

function assertSafeText(value: string, label: string): void {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ServiceDefinitionError(`${label} must be non-empty and contain no control characters`);
  }
}

function assertAbsolute(value: string, label: string): void {
  assertSafeText(value, label);
  if (!path.isAbsolute(value)) throw new ServiceDefinitionError(`${label} must be absolute`);
}

function assertExecutionPath(value: string): void {
  assertSafeText(value, 'execution PATH');
  if (value.split(path.delimiter).some((directory) => !path.isAbsolute(directory))) {
    throw new ServiceDefinitionError('execution PATH entries must be absolute directories');
  }
}

function validateServiceDefinition(definition: ServiceDefinition): ServiceDefinition {
  assertAbsolute(definition.nodeExecutable, 'node executable');
  assertAbsolute(definition.cliEntryPath, 'CLI entry path');
  assertAbsolute(definition.configPath, 'config path');
  assertExecutionPath(definition.executionPath);
  assertSafeText(definition.host, 'host');
  if (!Number.isSafeInteger(definition.port) || definition.port < 1 || definition.port > 65_535) {
    throw new ServiceDefinitionError('port must be a nonzero integer from 1 through 65535');
  }
  return { ...definition };
}

function supportedPlatform(platform: NodeJS.Platform): 'linux' | 'darwin' {
  if (platform === 'linux' || platform === 'darwin') return platform;
  throw new UnsupportedServicePlatformError(
    `Service management is unsupported on platform ${platform}; supported platforms are linux and darwin`
  );
}

function systemdArgument(value: string, escapeDollar = true): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%');
  return `"${escapeDollar ? escaped.replaceAll('$', () => '$$') : escaped}"`;
}

function xmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function serveArguments(definition: ServiceDefinition): string[] {
  return [
    definition.nodeExecutable,
    definition.cliEntryPath,
    'serve',
    '--config',
    definition.configPath,
    '--host',
    definition.host,
    '--port',
    String(definition.port),
  ];
}

export function renderSystemdUnit(definition: ServiceDefinition): string {
  const normalized = validateServiceDefinition(definition);
  return [
    `# ${SERVICE_OWNERSHIP_MARKER}`,
    '[Unit]',
    'Description=AgentKnot local orchestration service',
    '',
    '[Service]',
    `Environment=${systemdArgument(`PATH=${normalized.executionPath}`, false)}`,
    `ExecStart=${serveArguments(normalized).map((value) => systemdArgument(value)).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function renderLaunchAgent(definition: ServiceDefinition): string {
  const normalized = validateServiceDefinition(definition);
  const argumentsXml = serveArguments(normalized)
    .map((value) => `      <string>${xmlText(value)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- ${SERVICE_OWNERSHIP_MARKER} -->`,
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '  <dict>',
    '    <key>Label</key>',
    `    <string>${LAUNCHD_LABEL}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    argumentsXml,
    '    </array>',
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    '      <key>PATH</key>',
    `      <string>${xmlText(normalized.executionPath)}</string>`,
    '    </dict>',
    '    <key>RunAtLoad</key>',
    '    <true/>',
    '    <key>KeepAlive</key>',
    '    <true/>',
    '  </dict>',
    '</plist>',
    '',
  ].join('\n');
}

async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory() || !isCurrentUser(stats)) {
    throw new ServiceDefinitionError(`${directory} must be a current-user-owned directory, not a symlink`);
  }
}

async function inspectDefinition(definitionPath: string): Promise<'missing' | 'owned'> {
  let stats: Stats;
  try {
    stats = await lstat(definitionPath);
  } catch (error) {
    if (isNotFound(error)) return 'missing';
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile() || !isCurrentUser(stats) || !hasMode(stats, FILE_MODE)) {
    throw new ServiceDefinitionError(
      `${definitionPath} must be a current-user-owned mode-0600 regular file, not a symlink`
    );
  }
  const content = await readFile(definitionPath, 'utf8');
  if (
    !content.startsWith(`# ${SERVICE_OWNERSHIP_MARKER}\n`) &&
    !content.includes(`<!-- ${SERVICE_OWNERSHIP_MARKER} -->`)
  ) {
    throw new ServiceDefinitionError(
      `Refusing to modify unowned service definition: ${definitionPath}`
    );
  }
  return 'owned';
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function atomicWriteDefinition(definitionPath: string, content: string): Promise<void> {
  await inspectDefinition(definitionPath);
  const temporaryPath = `${definitionPath}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  let failure: unknown;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: FILE_MODE });
    await chmod(temporaryPath, FILE_MODE);
    const stats = await lstat(temporaryPath);
    if (stats.isSymbolicLink() || !stats.isFile() || !isCurrentUser(stats) || !hasMode(stats, FILE_MODE)) {
      throw new ServiceDefinitionError(`${temporaryPath} is not a safe service definition`);
    }
    await inspectDefinition(definitionPath);
    await rename(temporaryPath, definitionPath);
    renamed = true;
  } catch (error) {
    failure = error;
  }
  if (!renamed) {
    try {
      await removeIfPresent(temporaryPath);
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], 'Service definition cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
}

function launchdDomain(uid: number | undefined): string {
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new ServiceDefinitionError('macOS service management requires the numeric current-user id');
  }
  return `gui/${uid}`;
}

function launchdMissing(result: ServiceCommandResult): boolean {
  return (
    result.exitCode === 113 ||
    /could not find (?:specified )?service|service not found/iu.test(`${result.stdout}\n${result.stderr}`)
  );
}

export class ServiceHost {
  readonly #context: ServiceHostContext;
  readonly #execute: ServiceCommandExecutor;

  constructor(
    context: ServiceHostContext = defaultContext(),
    execute: ServiceCommandExecutor = nativeExecutor
  ) {
    if (!path.isAbsolute(context.homeDirectory)) {
      throw new ServiceDefinitionError('home directory must be absolute');
    }
    this.#context = context;
    this.#execute = execute;
    supportedPlatform(context.platform);
  }

  get paths(): ServicePaths {
    if (this.#context.platform === 'linux') {
      const configured = this.#context.environment?.XDG_CONFIG_HOME;
      const configHome = configured !== undefined && path.isAbsolute(configured)
        ? path.resolve(configured)
        : path.join(this.#context.homeDirectory, '.config');
      const directory = path.join(configHome, 'systemd', 'user');
      return {
        directory,
        definitionPath: path.join(directory, SYSTEMD_UNIT_NAME),
        identifier: SYSTEMD_UNIT_NAME,
      };
    }
    const directory = path.join(this.#context.homeDirectory, 'Library', 'LaunchAgents');
    return {
      directory,
      definitionPath: path.join(directory, `${LAUNCHD_LABEL}.plist`),
      identifier: LAUNCHD_LABEL,
    };
  }

  async #run(command: string, args: readonly string[]): Promise<ServiceCommandResult> {
    const result = await this.#execute(command, args);
    if (result.exitCode !== 0) throw new ServiceManagerCommandError(command, args, result);
    return result;
  }

  async #isActive(): Promise<boolean> {
    const paths = this.paths;
    if (this.#context.platform === 'linux') {
      const result = await this.#execute('systemctl', ['--user', 'is-active', paths.identifier]);
      if (result.exitCode === 0) return true;
      if (result.exitCode === 3 || result.exitCode === 4) return false;
      throw new ServiceManagerCommandError('systemctl', ['--user', 'is-active', paths.identifier], result);
    }
    const target = `${launchdDomain(this.#context.uid)}/${paths.identifier}`;
    const result = await this.#execute('launchctl', ['print', target]);
    if (result.exitCode === 0) return true;
    if (launchdMissing(result)) return false;
    throw new ServiceManagerCommandError('launchctl', ['print', target], result);
  }

  async install(definition: ServiceDefinition): Promise<ServicePaths> {
    const normalized = validateServiceDefinition(definition);
    const paths = this.paths;
    await ensureDirectory(paths.directory);
    const existing = await inspectDefinition(paths.definitionPath);
    if (this.#context.platform === 'darwin' && existing === 'owned' && (await this.#isActive())) {
      await this.#run('launchctl', ['bootout', `${launchdDomain(this.#context.uid)}/${paths.identifier}`]);
    }
    await atomicWriteDefinition(
      paths.definitionPath,
      this.#context.platform === 'linux'
        ? renderSystemdUnit(normalized)
        : renderLaunchAgent(normalized)
    );
    if (this.#context.platform === 'linux') {
      await this.#run('systemctl', ['--user', 'daemon-reload']);
      await this.#run('systemctl', ['--user', 'enable', paths.identifier]);
      await this.#run('systemctl', ['--user', 'restart', paths.identifier]);
    } else {
      await this.#run('launchctl', [
        'bootstrap',
        launchdDomain(this.#context.uid),
        paths.definitionPath,
      ]);
    }
    return paths;
  }

  async start(): Promise<void> {
    const paths = await this.#requireInstalled();
    if (this.#context.platform === 'linux') {
      await this.#run('systemctl', ['--user', 'start', paths.identifier]);
    } else if (!(await this.#isActive())) {
      await this.#run('launchctl', ['bootstrap', launchdDomain(this.#context.uid), paths.definitionPath]);
    }
  }

  async stop(): Promise<void> {
    const paths = await this.#requireInstalled();
    if (this.#context.platform === 'linux') {
      await this.#run('systemctl', ['--user', 'stop', paths.identifier]);
    } else if (await this.#isActive()) {
      await this.#run('launchctl', ['bootout', `${launchdDomain(this.#context.uid)}/${paths.identifier}`]);
    }
  }

  async restart(): Promise<void> {
    const paths = await this.#requireInstalled();
    if (this.#context.platform === 'linux') {
      await this.#run('systemctl', ['--user', 'restart', paths.identifier]);
      return;
    }
    if (await this.#isActive()) {
      await this.#run('launchctl', ['bootout', `${launchdDomain(this.#context.uid)}/${paths.identifier}`]);
    }
    await this.#run('launchctl', ['bootstrap', launchdDomain(this.#context.uid), paths.definitionPath]);
  }

  async status(): Promise<ServiceStatus> {
    const definitionPath = this.paths.definitionPath;
    if ((await inspectDefinition(definitionPath)) === 'missing') {
      return { state: 'not-installed', definitionPath };
    }
    const active = await this.#isActive();
    return { state: active ? 'running' : 'stopped', definitionPath };
  }

  async uninstall(): Promise<void> {
    const paths = this.paths;
    if ((await inspectDefinition(paths.definitionPath)) === 'missing') return;
    if (this.#context.platform === 'linux') {
      await this.#run('systemctl', ['--user', 'disable', '--now', paths.identifier]);
      await unlink(paths.definitionPath);
      await this.#run('systemctl', ['--user', 'daemon-reload']);
      return;
    }
    if (await this.#isActive()) {
      await this.#run('launchctl', ['bootout', `${launchdDomain(this.#context.uid)}/${paths.identifier}`]);
    }
    await unlink(paths.definitionPath);
  }

  async #requireInstalled(): Promise<ServicePaths> {
    const paths = this.paths;
    if ((await inspectDefinition(paths.definitionPath)) === 'missing') {
      throw new ServiceDefinitionError(`Service definition is not installed: ${paths.definitionPath}`);
    }
    return paths;
  }
}

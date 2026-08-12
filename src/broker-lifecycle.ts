import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readBrokerLaunchProfile, writeBrokerLaunchProfile } from './broker-profile.js';
import { loadConfig } from './config.js';
import { AgentKnotHttpClient } from './http-client.js';
import {
  readLocalDiscovery,
  removeLocalDiscoveryIfIdentity,
  type LocalDiscoveryPathOptions,
  type LocalDiscoveryRecord,
} from './local-discovery.js';
import { limitTextSuffix, MAX_STARTUP_DIAGNOSTIC_BYTES } from './record-limits.js';

const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
export const STARTUP_REPORT_PATH_ENV = 'AGENTKNOT_STARTUP_REPORT_PATH';
const STARTUP_CHILD_SIGTERM_GRACE_MS = 100;
const STARTUP_CHILD_SIGKILL_WAIT_MS = 1_000;
const POLL_INTERVAL_MS = 100;

export type BrokerStatus =
  | { readonly state: 'stopped' }
  | {
      readonly state: 'running';
      readonly url: string;
      readonly instanceId: string;
      readonly pid: number;
      readonly startedAt: string;
    }
  | {
      readonly state: 'unavailable';
      readonly url?: string;
      readonly instanceId?: string;
      readonly error: string;
    };

export type ProfiledBrokerStatus = BrokerStatus & { readonly launchConfigured: boolean };

export interface BrokerLifecycleOptions extends LocalDiscoveryPathOptions {
  readonly cliEntryPath: string;
  readonly configPath?: string;
  readonly port?: number;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly spawnProcess?: typeof spawn;
  readonly rememberConfig?: boolean;
}

export type ProfiledBrokerLifecycleOptions = Omit<
  BrokerLifecycleOptions,
  'configPath' | 'port' | 'rememberConfig'
>;

export interface BrokerStartResult {
  readonly action: 'started' | 'already-running';
  readonly broker: Extract<BrokerStatus, { state: 'running' }>;
}

export interface BrokerStopResult {
  readonly action: 'stopped' | 'already-stopped' | 'stale-record-removed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validTimeout(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return selected;
}

function validPort(value: number | undefined): number {
  const selected = value ?? 7_391;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > 65_535) {
    throw new Error('Broker port must be an integer from 0 through 65535');
  }
  return selected;
}

async function probeRecord(record: LocalDiscoveryRecord): Promise<BrokerStatus> {
  try {
    const identity = await new AgentKnotHttpClient(record.url).brokerIdentity();
    if (identity.instanceId !== record.instanceId || identity.startedAt !== record.startedAt) {
      return {
        state: 'unavailable',
        url: record.url,
        instanceId: record.instanceId,
        error: 'Discovery record does not match the broker responding at its URL',
      };
    }
    return {
      state: 'running',
      url: record.url,
      instanceId: identity.instanceId,
      pid: identity.pid,
      startedAt: identity.startedAt,
    };
  } catch (error) {
    return {
      state: 'unavailable',
      url: record.url,
      instanceId: record.instanceId,
      error: errorMessage(error),
    };
  }
}

export async function readBrokerStatus(
  options: LocalDiscoveryPathOptions = {}
): Promise<BrokerStatus> {
  let record: LocalDiscoveryRecord | undefined;
  try {
    record = await readLocalDiscovery(options);
  } catch (error) {
    return { state: 'unavailable', error: errorMessage(error) };
  }
  return record === undefined ? { state: 'stopped' } : probeRecord(record);
}

/** Reads live discovery and the product-owned launch profile without starting a broker. */
export async function readProfiledBrokerStatus(
  options: LocalDiscoveryPathOptions = {}
): Promise<ProfiledBrokerStatus> {
  const [status, profile] = await Promise.all([
    readBrokerStatus(options),
    readBrokerLaunchProfile(options),
  ]);
  return { ...status, launchConfigured: profile !== undefined };
}

async function removeStaleRecord(
  status: Extract<BrokerStatus, { state: 'unavailable' }>,
  options: LocalDiscoveryPathOptions
): Promise<boolean> {
  if (status.instanceId === undefined) return false;
  return removeLocalDiscoveryIfIdentity(status.instanceId, options);
}

interface StartupReportState {
  readonly directory: string;
  readonly path: string;
}

async function createStartupReportState(): Promise<StartupReportState> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-startup-'));
  await chmod(directory, 0o700);
  return { directory, path: path.join(directory, 'failure') };
}

async function readStartupReport(state: StartupReportState): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(state.path, 'r');
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(MAX_STARTUP_DIAGNOSTIC_BYTES);
    const { bytesRead } = await file.read(
      buffer,
      0,
      buffer.byteLength,
      Math.max(0, size - buffer.byteLength)
    );
    return limitTextSuffix(
      buffer.subarray(0, bytesRead).toString('utf8'),
      MAX_STARTUP_DIAGNOSTIC_BYTES
    ).trim();
  } catch {
    return '';
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function addStartupReport(failure: Error, state: StartupReportState): Promise<Error> {
  const detail = await readStartupReport(state);
  return detail === ''
    ? failure
    : new Error(`${failure.message}; startup report: ${detail}`, { cause: failure });
}

function detachedChild(
  options: BrokerLifecycleOptions,
  configPath: string,
  port: number,
  startupReportPath: string
): ChildProcess {
  const launch = options.spawnProcess ?? spawn;
  const child = launch(
    process.execPath,
    [
      options.cliEntryPath,
      'broker',
      'run',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--config',
      configPath,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...options.environment,
        [STARTUP_REPORT_PATH_ENV]: startupReportPath,
      },
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    }
  );
  child.unref();
  return child;
}

function stopPid(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const onError = (): void => {
      // A spawn/kill error does not prove that the exact child has exited. Keep waiting for
      // its exit event or the bounded deadline before escalating or reporting cleanup failure.
    };
    timer = setTimeout(() => finish(childExited(child)), timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
    if (childExited(child)) finish(true);
  });
}

async function terminateStartupChild(child: ChildProcess): Promise<void> {
  if (childExited(child)) return;

  let terminationError: unknown;
  try {
    child.kill('SIGTERM');
  } catch (error) {
    terminationError = error;
  }
  if (await waitForChildExit(child, STARTUP_CHILD_SIGTERM_GRACE_MS)) return;

  if (!childExited(child)) {
    try {
      child.kill('SIGKILL');
    } catch (error) {
      terminationError ??= error;
    }
  }
  if (await waitForChildExit(child, STARTUP_CHILD_SIGKILL_WAIT_MS)) return;

  const detail = terminationError === undefined ? '' : `: ${errorMessage(terminationError)}`;
  throw new Error(
    `AgentKnot broker startup child ${String(child.pid)} did not exit after cleanup${detail}`
  );
}

export async function startBroker(
  options: BrokerLifecycleOptions
): Promise<BrokerStartResult> {
  const startTimeoutMs = validTimeout(
    options.startTimeoutMs,
    DEFAULT_START_TIMEOUT_MS,
    'Broker start timeout'
  );
  const port = validPort(options.port);
  const before = await readBrokerStatus(options);
  if (before.state === 'running') return { action: 'already-running', broker: before };
  if (before.state === 'unavailable') {
    try {
      const removed = await removeStaleRecord(before, options);
      if (!removed) {
        const current = await readBrokerStatus(options);
        if (current.state === 'running') {
          return { action: 'already-running', broker: current };
        }
        if (current.state !== 'stopped') {
          throw new Error(
            `AgentKnot broker is unavailable and cannot be identified safely: ${current.error}`
          );
        }
      }
    } catch (error) {
      throw new Error(
        `Existing AgentKnot broker ownership is unavailable and cannot be replaced safely: ${errorMessage(error)}`,
        { cause: error }
      );
    }
  }

  const loaded = await loadConfig(
    options.configPath ?? process.env.AGENTKNOT_CONFIG ?? 'agentknot.config.json'
  );
  if (options.rememberConfig === true) {
    await writeBrokerLaunchProfile(
      { configPath: loaded.path, port },
      options.environment === undefined ? {} : { environment: options.environment }
    );
  }
  const startupReport = await createStartupReportState();
  let child: ChildProcess | undefined;
  let childError: Error | undefined;
  let childCleanupAttempted = false;
  const onChildError = (error: Error): void => {
    childError = error;
  };

  try {
    child = detachedChild(options, loaded.path, port, startupReport.path);
    child.once('error', onChildError);
    if (child.pid === undefined) {
      if (childError !== undefined) {
        throw new Error(`AgentKnot broker process failed to start: ${childError.message}`, {
          cause: childError,
        });
      }
      throw new Error('AgentKnot broker process did not receive a PID');
    }

    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (childError !== undefined) {
        throw new Error(`AgentKnot broker process failed to start: ${childError.message}`, {
          cause: childError,
        });
      }
      const status = await readBrokerStatus(options);
      if (status.state === 'running') {
        if (status.pid !== child.pid) {
          childCleanupAttempted = true;
          await terminateStartupChild(child);
        }
        return {
          action: status.pid === child.pid ? 'started' : 'already-running',
          broker: status,
        };
      }
      if (childExited(child)) {
        throw new Error(
          `AgentKnot broker exited before becoming ready (${String(child.exitCode ?? child.signalCode)})`
        );
      }
      await delay(POLL_INTERVAL_MS);
    }

    throw new Error(`AgentKnot broker did not become ready within ${startTimeoutMs}ms`);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (child?.pid !== undefined && !childExited(child) && !childCleanupAttempted) {
      childCleanupAttempted = true;
      try {
        await terminateStartupChild(child);
      } catch (cleanupError) {
        throw new AggregateError(
          [await addStartupReport(failure, startupReport), cleanupError],
          'AgentKnot broker startup cleanup failed'
        );
      }
    }
    throw await addStartupReport(failure, startupReport);
  } finally {
    child?.off('error', onChildError);
    await rm(startupReport.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Starts the exact broker selected by the protected product launch profile. */
export async function startProfiledBroker(
  options: ProfiledBrokerLifecycleOptions
): Promise<BrokerStartResult> {
  const profile = await readBrokerLaunchProfile(
    options.environment === undefined ? {} : { environment: options.environment }
  );
  if (profile === undefined) {
    throw new Error(
      'AgentKnot broker launch is not configured; run `agentknot broker up --config <path>` once'
    );
  }
  return startBroker({
    ...options,
    configPath: profile.configPath,
    port: profile.port,
  });
}

export async function stopBroker(
  options: Pick<BrokerLifecycleOptions, 'environment' | 'stopTimeoutMs'> = {}
): Promise<BrokerStopResult> {
  const stopTimeoutMs = validTimeout(
    options.stopTimeoutMs,
    DEFAULT_STOP_TIMEOUT_MS,
    'Broker stop timeout'
  );
  const before = await readBrokerStatus(options);
  if (before.state === 'stopped') return { action: 'already-stopped' };
  if (before.state === 'unavailable') {
    if (await removeStaleRecord(before, options)) return { action: 'stale-record-removed' };
    throw new Error(`AgentKnot broker is unavailable and cannot be identified safely: ${before.error}`);
  }

  stopPid(before.pid);
  const deadline = Date.now() + stopTimeoutMs;
  while (Date.now() < deadline) {
    const status = await readBrokerStatus(options);
    if (status.state === 'stopped') return { action: 'stopped' };
    if (status.state === 'running' && status.instanceId !== before.instanceId) {
      return { action: 'stopped' };
    }
    if (status.state === 'unavailable' && status.instanceId === before.instanceId) {
      try {
        await removeStaleRecord(status, options);
        return { action: 'stopped' };
      } catch {
        // The broker may still be releasing its ownership; keep waiting.
      }
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`AgentKnot broker ${before.instanceId} did not stop within ${stopTimeoutMs}ms`);
}

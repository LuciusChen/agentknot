import { spawn, type ChildProcess } from 'node:child_process';

import { writeBrokerLaunchProfile } from './broker-profile.js';
import { loadConfig } from './config.js';
import { AgentKnotHttpClient } from './http-client.js';
import {
  readLocalDiscovery,
  removeLocalDiscoveryIfIdentity,
  type LocalDiscoveryPathOptions,
  type LocalDiscoveryRecord,
} from './local-discovery.js';

const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
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

export interface BrokerLifecycleOptions extends LocalDiscoveryPathOptions {
  readonly cliEntryPath: string;
  readonly configPath?: string;
  readonly port?: number;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly spawnProcess?: typeof spawn;
  readonly rememberConfig?: boolean;
}

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

async function removeStaleRecord(
  status: Extract<BrokerStatus, { state: 'unavailable' }>,
  options: LocalDiscoveryPathOptions
): Promise<boolean> {
  if (status.instanceId === undefined) return false;
  return removeLocalDiscoveryIfIdentity(status.instanceId, options);
}

function detachedChild(
  options: BrokerLifecycleOptions,
  configPath: string,
  port: number
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
      env: process.env,
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
  const child = detachedChild(options, loaded.path, port);
  if (child.pid === undefined) throw new Error('AgentKnot broker process did not receive a PID');

  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    const status = await readBrokerStatus(options);
    if (status.state === 'running') {
      return {
        action: status.pid === child.pid ? 'started' : 'already-running',
        broker: status,
      };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `AgentKnot broker exited before becoming ready (${String(child.exitCode ?? child.signalCode)})`
      );
    }
    await delay(POLL_INTERVAL_MS);
  }

  stopPid(child.pid);
  throw new Error(`AgentKnot broker did not become ready within ${startTimeoutMs}ms`);
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

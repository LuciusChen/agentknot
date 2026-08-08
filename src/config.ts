import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { THINKING_LEVELS, type ResolvedRoute, type ThinkingLevel } from './types.js';

export interface MockWorkerConfig {
  adapter: 'mock';
  responsePrefix?: string;
  delayMs?: number;
}

export interface PiRpcWorkerConfig {
  adapter: 'pi-rpc';
  command?: string;
  commandArgs?: string[];
  noSession?: boolean;
  environment?: Record<string, string>;
}

export type WorkerConfig = MockWorkerConfig | PiRpcWorkerConfig;

export interface RouteConfig {
  worker: string;
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  requiredEnv?: string[];
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface AgentKnotConfig {
  version: 1;
  defaultRoute: string;
  storage: {
    directory: string;
  };
  workers: Record<string, WorkerConfig>;
  routes: Record<string, RouteConfig>;
}

export interface LoadedConfig {
  config: AgentKnotConfig;
  path: string;
  baseDirectory: string;
  storageDirectory: string;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function parseWorker(name: string, value: unknown): WorkerConfig {
  assertRecord(value, `workers.${name}`);
  if (value.adapter === 'mock') {
    if (value.responsePrefix !== undefined && typeof value.responsePrefix !== 'string') {
      throw new Error(`workers.${name}.responsePrefix must be a string`);
    }
    if (value.delayMs !== undefined && (!Number.isInteger(value.delayMs) || Number(value.delayMs) < 0)) {
      throw new Error(`workers.${name}.delayMs must be a non-negative integer`);
    }
    return {
      adapter: 'mock',
      ...(value.responsePrefix === undefined ? {} : { responsePrefix: value.responsePrefix }),
      ...(value.delayMs === undefined ? {} : { delayMs: Number(value.delayMs) }),
    };
  }
  if (value.adapter === 'pi-rpc') {
    if (value.command !== undefined) assertNonEmptyString(value.command, `workers.${name}.command`);
    if (value.commandArgs !== undefined) {
      if (!Array.isArray(value.commandArgs) || !value.commandArgs.every((item) => typeof item === 'string')) {
        throw new Error(`workers.${name}.commandArgs must be an array of strings`);
      }
    }
    if (value.environment !== undefined) {
      assertRecord(value.environment, `workers.${name}.environment`);
      if (!Object.values(value.environment).every((item) => typeof item === 'string')) {
        throw new Error(`workers.${name}.environment values must be strings`);
      }
    }
    if (value.noSession !== undefined && typeof value.noSession !== 'boolean') {
      throw new Error(`workers.${name}.noSession must be a boolean`);
    }
    return {
      adapter: 'pi-rpc',
      ...(value.command === undefined ? {} : { command: value.command }),
      ...(value.commandArgs === undefined ? {} : { commandArgs: [...value.commandArgs] as string[] }),
      ...(value.noSession === undefined ? {} : { noSession: value.noSession }),
      ...(value.environment === undefined
        ? {}
        : { environment: { ...(value.environment as Record<string, string>) } }),
    };
  }
  throw new Error(`workers.${name}.adapter must be "mock" or "pi-rpc"`);
}

function parseRoute(name: string, value: unknown, workers: Record<string, WorkerConfig>): RouteConfig {
  assertRecord(value, `routes.${name}`);
  assertNonEmptyString(value.worker, `routes.${name}.worker`);
  assertNonEmptyString(value.provider, `routes.${name}.provider`);
  assertNonEmptyString(value.model, `routes.${name}.model`);
  if (!(value.worker in workers)) throw new Error(`routes.${name}.worker references unknown worker "${value.worker}"`);
  if (value.thinkingLevel !== undefined && !THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel)) {
    throw new Error(`routes.${name}.thinkingLevel is invalid`);
  }
  if (value.requiredEnv !== undefined) {
    if (!Array.isArray(value.requiredEnv) || !value.requiredEnv.every((item) => typeof item === 'string')) {
      throw new Error(`routes.${name}.requiredEnv must be an array of strings`);
    }
  }
  if (value.maxAttempts !== undefined && (!Number.isInteger(value.maxAttempts) || Number(value.maxAttempts) < 1)) {
    throw new Error(`routes.${name}.maxAttempts must be a positive integer`);
  }
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1)) {
    throw new Error(`routes.${name}.timeoutMs must be a positive integer`);
  }
  return {
    worker: value.worker,
    provider: value.provider,
    model: value.model,
    ...(value.thinkingLevel === undefined ? {} : { thinkingLevel: value.thinkingLevel as ThinkingLevel }),
    ...(value.requiredEnv === undefined ? {} : { requiredEnv: [...value.requiredEnv] as string[] }),
    ...(value.maxAttempts === undefined ? {} : { maxAttempts: Number(value.maxAttempts) }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: Number(value.timeoutMs) }),
  };
}

export function parseConfig(value: unknown): AgentKnotConfig {
  assertRecord(value, 'config');
  if (value.version !== 1) throw new Error('config.version must be 1');
  assertNonEmptyString(value.defaultRoute, 'config.defaultRoute');
  assertRecord(value.storage, 'config.storage');
  assertNonEmptyString(value.storage.directory, 'config.storage.directory');
  assertRecord(value.workers, 'config.workers');
  assertRecord(value.routes, 'config.routes');

  const workers = Object.fromEntries(
    Object.entries(value.workers).map(([name, worker]) => [name, parseWorker(name, worker)])
  );
  if (Object.keys(workers).length === 0) throw new Error('config.workers must not be empty');
  const routes = Object.fromEntries(
    Object.entries(value.routes).map(([name, route]) => [name, parseRoute(name, route, workers)])
  );
  if (!(value.defaultRoute in routes)) {
    throw new Error(`config.defaultRoute references unknown route "${value.defaultRoute}"`);
  }
  return {
    version: 1,
    defaultRoute: value.defaultRoute,
    storage: { directory: value.storage.directory },
    workers,
    routes,
  };
}

export async function loadConfig(configPath = 'agentknot.config.json'): Promise<LoadedConfig> {
  const absolutePath = path.resolve(configPath);
  const raw = await readFile(absolutePath, 'utf8');
  const config = parseConfig(JSON.parse(raw) as unknown);
  const baseDirectory = path.dirname(absolutePath);
  return {
    config,
    path: absolutePath,
    baseDirectory,
    storageDirectory: path.resolve(baseDirectory, config.storage.directory),
  };
}

export function resolveRoute(config: AgentKnotConfig, name?: string): ResolvedRoute {
  const routeName = name ?? config.defaultRoute;
  const route = config.routes[routeName];
  if (!route) throw new Error(`Unknown route "${routeName}"`);
  return {
    name: routeName,
    worker: route.worker,
    provider: route.provider,
    model: route.model,
    ...(route.thinkingLevel === undefined ? {} : { thinkingLevel: route.thinkingLevel }),
    requiredEnv: [...(route.requiredEnv ?? [])],
    maxAttempts: route.maxAttempts ?? 1,
    timeoutMs: route.timeoutMs ?? 30 * 60_000,
  };
}

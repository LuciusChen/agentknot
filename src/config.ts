import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  THINKING_LEVELS,
  WORKSPACE_ISOLATION_MODES,
  type ResolvedRoute,
  type ThinkingLevel,
  type WorkspaceIsolationMode,
} from './types.js';

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

export interface OpenCodeJsonWorkerConfig {
  adapter: 'opencode-json';
  command?: string;
  commandArgs?: string[];
  environment?: Record<string, string>;
  unsetEnvironment?: string[];
}

export type WorkerConfig = MockWorkerConfig | PiRpcWorkerConfig | OpenCodeJsonWorkerConfig;

export interface WorkspaceIsolationConfig {
  mode: WorkspaceIsolationMode;
  directory?: string;
}

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
    orchestrationDirectory?: string;
  };
  /** Omitted means the legacy direct-workspace compatibility mode. */
  workspaceIsolation?: WorkspaceIsolationConfig;
  workers: Record<string, WorkerConfig>;
  routes: Record<string, RouteConfig>;
  delegation?: DelegationConfig;
}

export const DELEGATION_MODES = ['off', 'suggest', 'auto'] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];

export const ROUTE_SELECTION_MODES = ['shadow', 'active'] as const;
export type RouteSelectionMode = (typeof ROUTE_SELECTION_MODES)[number];

export const ROUTE_SELECTION_COMPLEXITIES = ['low', 'medium', 'high'] as const;
export type RouteSelectionComplexity = (typeof ROUTE_SELECTION_COMPLEXITIES)[number];

export interface RouteSelectionRule {
  route: string;
  taskKinds?: string[];
  complexities?: RouteSelectionComplexity[];
}

export interface ShadowRouteSelectionConfig {
  mode: 'shadow';
  rules: RouteSelectionRule[];
}

export interface ActiveRouteSelectionConfig {
  mode: 'active';
  rules: RouteSelectionRule[];
}

export type RouteSelectionConfig = ShadowRouteSelectionConfig | ActiveRouteSelectionConfig;

export interface QualityReviewConfig {
  /** Human-selected advisory reviewer route. The referenced route must use exactly one attempt. */
  route: string;
  /** Only parent assessments with one of these complexities are eligible. */
  complexities: RouteSelectionComplexity[];
}

export interface ArtifactValidationConfig {
  argv: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export const DELEGATION_FALLBACKS = ['upstream', 'fail'] as const;
export type DelegationFallback = (typeof DELEGATION_FALLBACKS)[number];

export interface DelegationConfig {
  mode: DelegationMode;
  planner: {
    strategy: 'hybrid';
    route: string;
  };
  dispatch: {
    defaultRoute: string;
    maxChildren: number;
    /** Automatic recursive delegation is intentionally unsupported in v1. */
    maxDepth: 1;
    maxConcurrency: number;
    /** Omitted means no route-selection evidence or execution override is produced. */
    routeSelection?: RouteSelectionConfig;
  };
  policy: {
    delegate: string[];
    keepUpstream: string[];
  };
  /** Omission disables the advisory post-artifact quality review. */
  qualityReview?: QualityReviewConfig;
  /** Omission leaves artifact validation policy unset. */
  artifactValidation?: ArtifactValidationConfig;
  fallback: DelegationFallback;
}

export interface LoadedConfig {
  config: AgentKnotConfig;
  path: string;
  baseDirectory: string;
  storageDirectory: string;
  orchestrationStorageDirectory: string;
}

const DEFAULT_DELEGATE_TASK_KINDS = [
  'architecture-review',
  'test-gap-analysis',
  'documentation',
  'independent-implementation',
];

const DEFAULT_KEEP_UPSTREAM_TASK_KINDS = [
  'requirements-decision',
  'product-decision',
  'artifact-integration',
  'commit',
  'push',
];

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

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}`);
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  assertKnownKeys(value, keys, label);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing required fields: ${missing.join(', ')}`);
  }
}

function parseStringArray(value: unknown, label: string, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

function parseBoundedInteger(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
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
  if (value.adapter === 'opencode-json') {
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
    if (value.unsetEnvironment !== undefined) {
      if (
        !Array.isArray(value.unsetEnvironment) ||
        !value.unsetEnvironment.every((item) => typeof item === 'string' && item.trim() !== '')
      ) {
        throw new Error(`workers.${name}.unsetEnvironment must be an array of non-empty strings`);
      }
    }
    return {
      adapter: 'opencode-json',
      ...(value.command === undefined ? {} : { command: value.command }),
      ...(value.commandArgs === undefined ? {} : { commandArgs: [...value.commandArgs] as string[] }),
      ...(value.environment === undefined
        ? {}
        : { environment: { ...(value.environment as Record<string, string>) } }),
      ...(value.unsetEnvironment === undefined
        ? {}
        : { unsetEnvironment: [...new Set(value.unsetEnvironment as string[])] }),
    };
  }
  throw new Error(`workers.${name}.adapter must be "mock", "pi-rpc", or "opencode-json"`);
}

function parseWorkspaceIsolation(value: unknown): WorkspaceIsolationConfig {
  if (value === undefined) return { mode: 'none' };
  assertRecord(value, 'config.workspaceIsolation');
  if (!WORKSPACE_ISOLATION_MODES.includes(value.mode as WorkspaceIsolationMode)) {
    throw new Error('config.workspaceIsolation.mode must be "none" or "git-worktree"');
  }
  if (value.directory !== undefined) {
    assertNonEmptyString(value.directory, 'config.workspaceIsolation.directory');
  }
  return {
    mode: value.mode as WorkspaceIsolationMode,
    ...(value.directory === undefined ? {} : { directory: value.directory }),
  };
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

function parseRouteSelectionStringArray(
  value: unknown,
  label: string,
  allowed?: readonly string[]
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const values = [...value];
  if (!values.every((item): item is string => typeof item === 'string' && item.trim() !== '')) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must contain unique values`);
  }
  if (allowed && values.some((item) => !allowed.includes(item))) {
    throw new Error(`${label} contains an invalid value`);
  }
  return values;
}

function parseRouteSelection(
  value: unknown,
  routes: Record<string, RouteConfig>
): RouteSelectionConfig {
  assertRecord(value, 'config.delegation.dispatch.routeSelection');
  assertKnownKeys(value, ['mode', 'rules'], 'config.delegation.dispatch.routeSelection');
  if (!ROUTE_SELECTION_MODES.includes(value.mode as RouteSelectionMode)) {
    throw new Error('config.delegation.dispatch.routeSelection.mode must be "shadow" or "active"');
  }
  if (!Array.isArray(value.rules) || value.rules.length < 1 || value.rules.length > 20) {
    throw new Error('config.delegation.dispatch.routeSelection.rules must contain 1-20 entries');
  }

  const rules: RouteSelectionRule[] = Array.from(value.rules, (item, index) => {
    const label = `config.delegation.dispatch.routeSelection.rules[${index}]`;
    assertRecord(item, label);
    assertKnownKeys(item, ['route', 'taskKinds', 'complexities'], label);
    assertNonEmptyString(item.route, `${label}.route`);
    if (!Object.hasOwn(routes, item.route)) {
      throw new Error(`${label}.route references unknown route "${item.route}"`);
    }
    const taskKinds =
      item.taskKinds === undefined
        ? undefined
        : parseRouteSelectionStringArray(item.taskKinds, `${label}.taskKinds`);
    const complexities =
      item.complexities === undefined
        ? undefined
        : (parseRouteSelectionStringArray(
            item.complexities,
            `${label}.complexities`,
            ROUTE_SELECTION_COMPLEXITIES
          ) as RouteSelectionComplexity[]);
    return {
      route: item.route,
      ...(taskKinds === undefined ? {} : { taskKinds }),
      ...(complexities === undefined ? {} : { complexities }),
    };
  });

  return value.mode === 'active' ? { mode: 'active', rules } : { mode: 'shadow', rules };
}

function parseArtifactValidation(value: unknown): ArtifactValidationConfig {
  const label = 'config.delegation.artifactValidation';
  assertRecord(value, label);
  assertExactKeys(value, ['argv', 'timeoutMs', 'maxOutputBytes'], label);
  if (
    !Array.isArray(value.argv) ||
    value.argv.length < 1 ||
    value.argv.length > 32 ||
    !Array.from(value.argv).every((item) => typeof item === 'string' && item.trim() !== '')
  ) {
    throw new Error(`${label}.argv must be an array of 1-32 non-empty strings`);
  }
  if (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 300_000) {
    throw new Error(`${label}.timeoutMs must be an integer between 1 and 300000`);
  }
  if (
    !Number.isInteger(value.maxOutputBytes) ||
    Number(value.maxOutputBytes) < 1 ||
    Number(value.maxOutputBytes) > 65_536
  ) {
    throw new Error(`${label}.maxOutputBytes must be an integer between 1 and 65536`);
  }
  return {
    argv: [...value.argv] as string[],
    timeoutMs: Number(value.timeoutMs),
    maxOutputBytes: Number(value.maxOutputBytes),
  };
}

function parseQualityReview(
  value: unknown,
  routes: Record<string, RouteConfig>
): QualityReviewConfig {
  assertRecord(value, 'config.delegation.qualityReview');
  assertKnownKeys(value, ['route', 'complexities'], 'config.delegation.qualityReview');
  assertNonEmptyString(value.route, 'config.delegation.qualityReview.route');
  if (!Object.hasOwn(routes, value.route)) {
    throw new Error(
      `config.delegation.qualityReview.route references unknown route "${value.route}"`
    );
  }
  if ((routes[value.route]?.maxAttempts ?? 1) !== 1) {
    throw new Error('config.delegation.qualityReview.route must reference a route with maxAttempts 1');
  }
  return {
    route: value.route,
    complexities: parseRouteSelectionStringArray(
      value.complexities,
      'config.delegation.qualityReview.complexities',
      ROUTE_SELECTION_COMPLEXITIES
    ) as RouteSelectionComplexity[],
  };
}

function parseDelegation(
  value: unknown,
  routes: Record<string, RouteConfig>,
  defaultRoute: string
): DelegationConfig | undefined {
  if (value === undefined) return undefined;
  assertRecord(value, 'config.delegation');
  if (!DELEGATION_MODES.includes(value.mode as DelegationMode)) {
    throw new Error('config.delegation.mode must be "off", "suggest", or "auto"');
  }

  if (value.planner !== undefined) assertRecord(value.planner, 'config.delegation.planner');
  const planner = (value.planner ?? {}) as Record<string, unknown>;
  if (planner.strategy !== undefined && planner.strategy !== 'hybrid') {
    throw new Error('config.delegation.planner.strategy must be "hybrid"');
  }
  if (planner.route !== undefined) assertNonEmptyString(planner.route, 'config.delegation.planner.route');
  const plannerRoute = (planner.route as string | undefined) ?? defaultRoute;
  if (!(plannerRoute in routes)) {
    throw new Error(`config.delegation.planner.route references unknown route "${plannerRoute}"`);
  }

  if (value.dispatch !== undefined) assertRecord(value.dispatch, 'config.delegation.dispatch');
  const dispatch = (value.dispatch ?? {}) as Record<string, unknown>;
  if (dispatch.defaultRoute !== undefined) {
    assertNonEmptyString(dispatch.defaultRoute, 'config.delegation.dispatch.defaultRoute');
  }
  const defaultDispatchRoute = (dispatch.defaultRoute as string | undefined) ?? defaultRoute;
  if (!(defaultDispatchRoute in routes)) {
    throw new Error(
      `config.delegation.dispatch.defaultRoute references unknown route "${defaultDispatchRoute}"`
    );
  }
  const maxChildren = parseBoundedInteger(
    dispatch.maxChildren,
    'config.delegation.dispatch.maxChildren',
    2,
    1,
    6
  );
  if (dispatch.maxDepth !== undefined && dispatch.maxDepth !== 1) {
    throw new Error('config.delegation.dispatch.maxDepth must be 1 in delegation v1');
  }
  const maxConcurrency = parseBoundedInteger(
    dispatch.maxConcurrency,
    'config.delegation.dispatch.maxConcurrency',
    Math.min(2, maxChildren),
    1,
    6
  );
  if (maxConcurrency > maxChildren) {
    throw new Error('config.delegation.dispatch.maxConcurrency must not exceed maxChildren');
  }
  const routeSelection =
    dispatch.routeSelection === undefined
      ? undefined
      : parseRouteSelection(dispatch.routeSelection, routes);

  const qualityReview =
    value.qualityReview === undefined
      ? undefined
      : parseQualityReview(value.qualityReview, routes);
  const artifactValidation =
    value.artifactValidation === undefined
      ? undefined
      : parseArtifactValidation(value.artifactValidation);

  if (value.policy !== undefined) assertRecord(value.policy, 'config.delegation.policy');
  const policy = (value.policy ?? {}) as Record<string, unknown>;

  if (value.fallback !== undefined && !DELEGATION_FALLBACKS.includes(value.fallback as DelegationFallback)) {
    throw new Error('config.delegation.fallback must be "upstream" or "fail"');
  }

  return {
    mode: value.mode as DelegationMode,
    planner: { strategy: 'hybrid', route: plannerRoute },
    dispatch: {
      defaultRoute: defaultDispatchRoute,
      maxChildren,
      maxDepth: 1,
      maxConcurrency,
      ...(routeSelection === undefined ? {} : { routeSelection }),
    },
    policy: {
      delegate: parseStringArray(
        policy.delegate,
        'config.delegation.policy.delegate',
        DEFAULT_DELEGATE_TASK_KINDS
      ),
      keepUpstream: parseStringArray(
        policy.keepUpstream,
        'config.delegation.policy.keepUpstream',
        DEFAULT_KEEP_UPSTREAM_TASK_KINDS
      ),
    },
    ...(qualityReview === undefined ? {} : { qualityReview }),
    ...(artifactValidation === undefined ? {} : { artifactValidation }),
    fallback: (value.fallback as DelegationFallback | undefined) ?? 'upstream',
  };
}

export function resolveDelegationConfig(config: AgentKnotConfig): DelegationConfig {
  return (
    config.delegation ?? {
      mode: 'off',
      planner: { strategy: 'hybrid', route: config.defaultRoute },
      dispatch: {
        defaultRoute: config.defaultRoute,
        maxChildren: 2,
        maxDepth: 1,
        maxConcurrency: 2,
      },
      policy: {
        delegate: [...DEFAULT_DELEGATE_TASK_KINDS],
        keepUpstream: [...DEFAULT_KEEP_UPSTREAM_TASK_KINDS],
      },
      fallback: 'upstream',
    }
  );
}

export function parseConfig(value: unknown): AgentKnotConfig {
  assertRecord(value, 'config');
  if (value.version !== 1) throw new Error('config.version must be 1');
  assertNonEmptyString(value.defaultRoute, 'config.defaultRoute');
  assertRecord(value.storage, 'config.storage');
  assertNonEmptyString(value.storage.directory, 'config.storage.directory');
  if (value.storage.orchestrationDirectory !== undefined) {
    assertNonEmptyString(value.storage.orchestrationDirectory, 'config.storage.orchestrationDirectory');
  }
  const workspaceIsolation = parseWorkspaceIsolation(value.workspaceIsolation);
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
  const delegation = parseDelegation(value.delegation, routes, value.defaultRoute);
  if (delegation && delegation.mode !== 'off' && workspaceIsolation.mode !== 'git-worktree') {
    throw new Error('config.delegation mode "suggest" or "auto" requires workspaceIsolation.mode "git-worktree"');
  }
  return {
    version: 1,
    defaultRoute: value.defaultRoute,
    storage: {
      directory: value.storage.directory,
      ...(value.storage.orchestrationDirectory === undefined
        ? {}
        : { orchestrationDirectory: value.storage.orchestrationDirectory as string }),
    },
    workspaceIsolation,
    workers,
    routes,
    ...(delegation === undefined ? {} : { delegation }),
  };
}

export async function loadConfig(configPath = 'agentknot.config.json'): Promise<LoadedConfig> {
  const absolutePath = path.resolve(configPath);
  const raw = await readFile(absolutePath, 'utf8');
  const config = parseConfig(JSON.parse(raw) as unknown);
  const baseDirectory = path.dirname(absolutePath);
  const defaultOrchestrationDirectory = path.join(path.dirname(config.storage.directory), 'orchestrations');
  return {
    config,
    path: absolutePath,
    baseDirectory,
    storageDirectory: path.resolve(baseDirectory, config.storage.directory),
    orchestrationStorageDirectory: path.resolve(
      baseDirectory,
      config.storage.orchestrationDirectory ?? defaultOrchestrationDirectory
    ),
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

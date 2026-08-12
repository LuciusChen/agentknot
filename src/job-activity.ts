import { isTerminalStatus } from './execution-status.js';
import type { JobEvent, JobEventType, JobRecord } from './types.js';

export const JOB_ACTIVITY_STATES = [
  'queued',
  'capacity-waiting',
  'starting',
  'running',
  'tools-running',
  'retrying',
  'terminal',
] as const;

export type JobActivityState = (typeof JOB_ACTIVITY_STATES)[number];

export const JOB_ACTIVITY_COVERAGE = ['complete', 'partial', 'truncated'] as const;

export type JobActivityCoverage = (typeof JOB_ACTIVITY_COVERAGE)[number];

export interface JobActivityObservation {
  sequence: number;
  at: string;
  type: JobEventType;
  toolName?: string;
  retryAttempt?: number;
  retryScope?: 'downstream';
  retryMaxAttempts?: number;
}

export interface JobActivityProjection {
  schemaVersion: 1;
  state: JobActivityState;
  coverage: JobActivityCoverage;
  lastObserved?: JobActivityObservation;
  activeTools?: {
    count: number;
    names: string[];
    namesTruncated: boolean;
  };
}

const MAX_VISIBLE_TOOL_NAMES = 4;
const MAX_TOOL_NAME_CHARACTERS = 80;

function toolName(event: JobEvent): string | undefined {
  const value = event.data?.toolName;
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized === '') return undefined;
  return normalized.slice(0, MAX_TOOL_NAME_CHARACTERS);
}

function toolCallId(event: JobEvent): string | undefined {
  const value = event.data?.toolCallId;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function activityObservation(event: JobEvent): JobActivityObservation {
  const name = toolName(event);
  const attempt = event.type === 'worker.retry.started' || event.type === 'worker.retry.completed'
    ? event.data?.attempt
    : undefined;
  const retryScope = event.type === 'worker.retry.started' || event.type === 'worker.retry.completed'
    ? event.data?.scope
    : undefined;
  const retryMaxAttempts = event.type === 'worker.retry.started'
    ? event.data?.maxAttempts
    : undefined;
  return {
    sequence: event.sequence,
    at: event.at,
    type: event.type,
    ...(name === undefined ? {} : { toolName: name }),
    ...(!Number.isSafeInteger(attempt) || (attempt as number) < 0
      ? {}
      : { retryAttempt: attempt as number }),
    ...(retryScope === 'downstream' ? { retryScope } : {}),
    ...(!Number.isSafeInteger(retryMaxAttempts) || (retryMaxAttempts as number) < 1
      ? {}
      : { retryMaxAttempts: retryMaxAttempts as number }),
  };
}

/**
 * Derive one bounded, non-authoritative activity snapshot from durable Job evidence.
 * It never copies worker text, stderr, raw frames, tool arguments, or tool results.
 */
export function projectJobActivity(job: JobRecord): JobActivityProjection {
  let coverage: JobActivityCoverage = 'complete';
  let workerStarted = false;
  let retrying = false;
  let capacityWaiting = false;
  const activeTools = new Map<string, string>();

  for (const event of job.events) {
    if (event.type === 'job.capacity.waiting') {
      capacityWaiting = true;
      continue;
    }
    if (event.type === 'job.started') {
      capacityWaiting = false;
      continue;
    }
    if (event.type === 'job.worker.events.truncated') {
      coverage = 'truncated';
      activeTools.clear();
      retrying = false;
      continue;
    }
    if (
      event.type === 'job.retrying' ||
      event.type === 'job.attempt.lost' ||
      event.type === 'job.recovery.started'
    ) {
      activeTools.clear();
      retrying = false;
      workerStarted = false;
      capacityWaiting = false;
      continue;
    }
    if (event.type === 'worker.started') {
      activeTools.clear();
      retrying = false;
      workerStarted = true;
      capacityWaiting = false;
      if (coverage === 'partial') coverage = 'complete';
      continue;
    }
    if (coverage === 'truncated') continue;
    if (event.type === 'worker.retry.started') {
      retrying = true;
      continue;
    }
    if (event.type === 'worker.retry.completed') {
      retrying = false;
      continue;
    }
    if (
      event.type !== 'worker.tool.started' &&
      event.type !== 'worker.tool.updated' &&
      event.type !== 'worker.tool.completed'
    ) {
      continue;
    }

    const id = toolCallId(event);
    const name = toolName(event);
    if (id === undefined || name === undefined) {
      coverage = 'partial';
      activeTools.clear();
      continue;
    }
    if (event.type === 'worker.tool.started') activeTools.set(id, name);
    else if (event.type === 'worker.tool.completed') activeTools.delete(id);
  }

  const lastEvent = job.events.at(-1);
  let state: JobActivityState;
  if (isTerminalStatus(job.status)) state = 'terminal';
  else if (capacityWaiting) state = 'capacity-waiting';
  else if (job.status === 'queued') state = 'queued';
  else if (!workerStarted) state = 'starting';
  else if (coverage === 'complete' && retrying) state = 'retrying';
  else if (coverage === 'complete' && activeTools.size > 0) state = 'tools-running';
  else state = 'running';

  const names = [...activeTools.values()].slice(0, MAX_VISIBLE_TOOL_NAMES);
  return {
    schemaVersion: 1,
    state,
    coverage,
    ...(lastEvent === undefined ? {} : { lastObserved: activityObservation(lastEvent) }),
    ...(state !== 'tools-running'
      ? {}
      : {
          activeTools: {
            count: activeTools.size,
            names,
            namesTruncated: activeTools.size > names.length,
          },
        }),
  };
}

export function isJobActivityProjection(value: unknown): value is JobActivityProjection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const activity = value as Record<string, unknown>;
  if (
    activity.schemaVersion !== 1 ||
    !JOB_ACTIVITY_STATES.includes(activity.state as JobActivityState) ||
    !JOB_ACTIVITY_COVERAGE.includes(activity.coverage as JobActivityCoverage)
  ) {
    return false;
  }
  if (activity.lastObserved !== undefined) {
    const last = activity.lastObserved;
    if (typeof last !== 'object' || last === null || Array.isArray(last)) return false;
    const observation = last as Record<string, unknown>;
    if (
      !Number.isSafeInteger(observation.sequence) ||
      (observation.sequence as number) < 1 ||
      typeof observation.at !== 'string' ||
      typeof observation.type !== 'string' ||
      (observation.toolName !== undefined && typeof observation.toolName !== 'string') ||
      (observation.retryAttempt !== undefined &&
        (!Number.isSafeInteger(observation.retryAttempt) || (observation.retryAttempt as number) < 0)) ||
      (observation.retryScope !== undefined && observation.retryScope !== 'downstream') ||
      (observation.retryMaxAttempts !== undefined &&
        (!Number.isSafeInteger(observation.retryMaxAttempts) ||
          (observation.retryMaxAttempts as number) < 1))
    ) {
      return false;
    }
  }
  if (activity.activeTools !== undefined) {
    const active = activity.activeTools;
    if (typeof active !== 'object' || active === null || Array.isArray(active)) return false;
    const tools = active as Record<string, unknown>;
    if (
      !Number.isSafeInteger(tools.count) ||
      (tools.count as number) < 1 ||
      !Array.isArray(tools.names) ||
      !(tools.names as unknown[]).every((name) => typeof name === 'string') ||
      typeof tools.namesTruncated !== 'boolean'
    ) {
      return false;
    }
  }
  return true;
}

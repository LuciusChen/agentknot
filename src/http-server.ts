import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { DelegationConfig } from './config.js';
import { isTerminalStatus } from './execution-status.js';
import { projectJobActivity } from './job-activity.js';
import { validateTaskAssessment } from './delegation-policy.js';
import { assertJsonMetadata } from './metadata.js';
import { buildJobList } from './job-list.js';
import { JobControlPersistenceError } from './orchestrator.js';
import { validateWorkerControlRequest } from './worker-control.js';
import {
  isOrchestrationDelegationOverride,
  type OrchestrationEvent,
  type OrchestrationRecord,
  type OrchestrationRequest,
  type StartOrchestrationResult,
} from './orchestration-types.js';
import { validateMaxToolCalls } from './types.js';
import type {
  JobArtifactList,
  JobArtifactPreview,
  JobArtifactVerificationReport,
  JobEvent,
  JobRequest,
  StartJobResult,
  WorkerControlCapabilities,
  WorkerControlReceipt,
  WorkerControlRequest,
} from './types.js';
import type { JobRecord } from './types.js';

const MAX_BODY_BYTES = 1024 * 1024;
const WAIT_HEARTBEAT_MS = 5_000;
const LIVE_HEALTH_RESPONSE = {
  ok: true,
  service: 'agentknot',
  status: 'live',
  checks: {
    storage: 'not-checked',
    routes: 'not-checked',
    inference: 'not-checked',
  },
} as const;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const data = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  response.end(data);
}

function compactJobProgress(job: JobRecord): object {
  const lastEvent = job.events.at(-1);
  return {
    schemaVersion: 1,
    kind: 'job',
    id: job.id,
    status: job.status,
    updatedAt: job.updatedAt,
    route: job.route.name,
    attempt: job.attempt,
    activity: projectJobActivity(job),
    ...(lastEvent === undefined
      ? {}
      : {
          lastActivity: {
            sequence: lastEvent.sequence,
            at: lastEvent.at,
            type: lastEvent.type,
          },
        }),
  };
}

async function compactOrchestrationProgress(
  runtime: AgentKnotHttpRuntime,
  orchestration: OrchestrationRecord
): Promise<object> {
  const children = await Promise.all(
    orchestration.children.map(async (child) => {
      const job = await runtime.get(child.jobId);
      const lastEvent = job?.events.at(-1);
      return {
        subtaskId: child.subtaskId,
        jobId: child.jobId,
        status: job?.status ?? child.status,
        ...(child.route === undefined ? {} : { route: child.route.name }),
        ...(job === undefined ? {} : { activity: projectJobActivity(job) }),
        ...(lastEvent === undefined
          ? {}
          : {
              lastActivity: {
                sequence: lastEvent.sequence,
                at: lastEvent.at,
                type: lastEvent.type,
              },
            }),
      };
    })
  );
  const lastEvent = orchestration.events.at(-1);
  return {
    schemaVersion: 1,
    kind: 'orchestration',
    id: orchestration.id,
    status: orchestration.status,
    phase: orchestration.status,
    updatedAt: orchestration.updatedAt,
    ...(lastEvent === undefined
      ? {}
      : {
          lastActivity: {
            sequence: lastEvent.sequence,
            at: lastEvent.at,
            type: lastEvent.type,
          },
        }),
    children,
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as unknown);
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
}

function eventCursor(request: IncomingMessage): number | undefined {
  const raw = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('after');
  if (raw === null) return undefined;
  const sequence = Number(raw);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('after must be a non-negative integer event sequence');
  }
  return sequence;
}

function nextEventSequence(events: ReadonlyArray<{ sequence: number }>, after: number): number {
  return events.reduce((sequence, event) => Math.max(sequence, event.sequence), after);
}

async function observeWhileConnected<T>(
  request: IncomingMessage,
  response: ServerResponse,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const disconnect = () => {
    if (!response.writableEnded) controller.abort(new Error('HTTP observer disconnected'));
  };
  request.once('aborted', disconnect);
  response.once('close', disconnect);
  try {
    return await operation(controller.signal);
  } finally {
    request.off('aborted', disconnect);
    response.off('close', disconnect);
  }
}

function asJobRequest(value: unknown): JobRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Request body must be an object');
  }
  const body = value as Record<string, unknown>;
  if (typeof body.prompt !== 'string') throw new Error('prompt must be a string');
  if (typeof body.workspace !== 'string') throw new Error('workspace must be a string');
  if (body.route !== undefined && typeof body.route !== 'string') throw new Error('route must be a string');
  if (body.source !== undefined && typeof body.source !== 'string') throw new Error('source must be a string');
  if (body.callbackUrl !== undefined && typeof body.callbackUrl !== 'string') {
    throw new Error('callbackUrl must be a string');
  }
  const maxToolCalls = validateMaxToolCalls(body.maxToolCalls);
  if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== 'string') {
    throw new Error('idempotencyKey must be a string');
  }
  const metadata = body.metadata;
  if (metadata !== undefined) assertJsonMetadata(metadata);
  return {
    prompt: body.prompt,
    workspace: body.workspace,
    ...(body.route === undefined ? {} : { route: body.route as string }),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    ...(body.source === undefined ? {} : { source: body.source as string }),
    ...(body.callbackUrl === undefined ? {} : { callbackUrl: body.callbackUrl as string }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(body.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: body.idempotencyKey as string }),
  };
}

function asOrchestrationRequest(value: unknown): OrchestrationRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Request body must be an object');
  }
  const body = value as Record<string, unknown>;
  if (typeof body.prompt !== 'string') throw new Error('prompt must be a string');
  if (typeof body.workspace !== 'string') throw new Error('workspace must be a string');
  if (body.assessment === undefined) throw new Error('assessment is required');
  const assessment = validateTaskAssessment(body.assessment);
  if (body.source !== undefined && typeof body.source !== 'string') throw new Error('source must be a string');
  if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== 'string') {
    throw new Error('idempotencyKey must be a string');
  }
  if (
    body.delegation !== undefined &&
    !isOrchestrationDelegationOverride(body.delegation)
  ) {
    throw new Error('delegation must be "inherit", "never", "suggest", or "force"');
  }
  const metadata = body.metadata;
  if (metadata !== undefined) assertJsonMetadata(metadata);
  return {
    prompt: body.prompt,
    workspace: body.workspace,
    assessment,
    ...(body.source === undefined ? {} : { source: body.source as string }),
    ...(body.delegation === undefined
      ? {}
      : {
          delegation: body.delegation as Exclude<
            OrchestrationRequest['delegation'],
            undefined
          >,
        }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(body.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: body.idempotencyKey as string }),
  };
}

export interface AgentKnotHttpRuntime {
  routes(): Array<{ name: string; worker: string; provider: string; model: string }>;
  get(id: string): Promise<JobRecord | undefined>;
  list(): Promise<JobRecord[]>;
  listArtifacts(id: string): Promise<JobArtifactList | undefined>;
  verifyArtifacts(id: string): Promise<JobArtifactVerificationReport | undefined>;
  previewArtifact(id: string, attempt: number): Promise<JobArtifactPreview | undefined>;
  start(request: JobRequest): Promise<StartJobResult>;
  waitForJob?(id: string, timeoutMs?: number, signal?: AbortSignal): Promise<JobRecord | undefined>;
  jobEventsAfter?(id: string, sequence: number): Promise<JobEvent[]>;
  /** Direct Orchestrator compatibility; AgentKnotRuntime uses waitForJob/jobEventsAfter. */
  wait?(id: string, timeoutMs?: number, signal?: AbortSignal): Promise<JobRecord | undefined>;
  eventsAfter?(id: string, sequence: number): Promise<JobEvent[]>;
  cancelJob?(id: string, source?: string): Promise<boolean>;
  workerControlCapabilities?(id: string): Promise<WorkerControlCapabilities | undefined>;
  controlJob?(id: string, request: WorkerControlRequest): Promise<WorkerControlReceipt | undefined>;
  delegationPolicy?(): DelegationConfig;
  getOrchestration?(id: string): Promise<OrchestrationRecord | undefined>;
  listOrchestrations?(): Promise<OrchestrationRecord[]>;
  startOrchestration?(request: OrchestrationRequest): Promise<StartOrchestrationResult>;
  waitForOrchestration?(
    id: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<OrchestrationRecord | undefined>;
  orchestrationEventsAfter?(id: string, sequence: number): Promise<OrchestrationEvent[]>;
  cancelOrchestration?(id: string, source?: string): Promise<boolean>;
  shutdown?(): Promise<void>;
}

export interface AgentKnotHttpServer {
  server: Server;
  listen(port: number, host?: string): Promise<{ host: string; port: number }>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentKnotBrokerIdentity {
  readonly schemaVersion: 1;
  readonly service: 'agentknot-broker';
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
}

export interface AgentKnotHttpServerOptions {
  readonly brokerIdentity?: AgentKnotBrokerIdentity;
}

export function createAgentKnotHttpServer(
  runtime: AgentKnotHttpRuntime,
  options: AgentKnotHttpServerOptions = {}
): AgentKnotHttpServer {
  let closing = false;
  let admissionsInFlight = 0;
  let admissionsDrained: (() => void) | undefined;
  let drainPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let admittedWork = false;

  const beginAdmission = (response: ServerResponse): (() => void) | undefined => {
    if (closing) {
      sendJson(response, 503, { error: 'AgentKnot server is shutting down' });
      return undefined;
    }
    admissionsInFlight += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      admissionsInFlight -= 1;
      if (admissionsInFlight === 0) {
        const resolve = admissionsDrained;
        admissionsDrained = undefined;
        resolve?.();
      }
    };
  };

  const waitForAdmissions = (): Promise<void> =>
    admissionsInFlight === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          admissionsDrained = resolve;
        });

  const drain = (): Promise<void> => {
    drainPromise ??= (async () => {
      closing = true;
      await waitForAdmissions();
      if (admittedWork) await runtime.shutdown?.();
    })();
    return drainPromise;
  };

  const server = createServer(async (request, response) => {
    response.once('error', () => undefined);
    try {
      const method = request.method ?? 'GET';
      const pathname = requestPath(request);

      if (method === 'GET' && (pathname === '/health/live' || pathname === '/health')) {
        sendJson(response, 200, LIVE_HEALTH_RESPONSE);
        return;
      }
      if (method === 'GET' && pathname === '/v1/broker') {
        if (options.brokerIdentity === undefined) {
          sendJson(response, 404, { error: 'Broker identity is not available on this server' });
          return;
        }
        sendJson(response, 200, options.brokerIdentity);
        return;
      }
      if (method === 'GET' && pathname === '/v1/routes') {
        sendJson(response, 200, { routes: runtime.routes() });
        return;
      }
      if (method === 'GET' && pathname === '/v1/jobs') {
        sendJson(response, 200, buildJobList(await runtime.list()));
        return;
      }
      if (method === 'POST' && pathname === '/v1/jobs') {
        const finishAdmission = beginAdmission(response);
        if (finishAdmission === undefined) return;
        try {
          const started = await runtime.start(asJobRequest(await readJson(request)));
          admittedWork = true;
          sendJson(response, 202, { job: started.job });
        } finally {
          finishAdmission();
        }
        return;
      }

      const artifactMatch =
        /^\/v1\/jobs\/([a-zA-Z0-9_-]+)\/artifacts(?:\/(verify|([1-9][0-9]*)\/preview))?$/.exec(pathname);
      if (artifactMatch) {
        const id = artifactMatch[1];
        const action = artifactMatch[2];
        if (!id) throw new Error('Missing job id');
        if (method !== 'GET') {
          sendJson(response, 405, { error: 'Method not allowed' });
          return;
        }
        if (action === undefined) {
          const artifacts = await runtime.listArtifacts(id);
          if (!artifacts) {
            sendJson(response, 404, { error: 'Job not found' });
            return;
          }
          sendJson(response, 200, artifacts);
          return;
        }
        if (action === 'verify') {
          const verification = await runtime.verifyArtifacts(id);
          if (!verification) {
            sendJson(response, 404, { error: 'Job not found' });
            return;
          }
          sendJson(response, 200, verification);
          return;
        }
        const attempt = Number(artifactMatch[3]);
        const preview = await runtime.previewArtifact(id, attempt);
        if (!preview) {
          sendJson(response, 404, { error: 'Artifact not found' });
          return;
        }
        sendJson(response, 200, preview);
        return;
      }

      if (method === 'GET' && pathname === '/v1/delegation') {
        if (!runtime.delegationPolicy) {
          sendJson(response, 501, { error: 'Orchestration is not available on this runtime' });
          return;
        }
        sendJson(response, 200, { delegation: runtime.delegationPolicy() });
        return;
      }
      if (method === 'GET' && pathname === '/v1/orchestrations') {
        if (!runtime.listOrchestrations) {
          sendJson(response, 501, { error: 'Orchestration is not available on this runtime' });
          return;
        }
        sendJson(response, 200, { orchestrations: await runtime.listOrchestrations() });
        return;
      }
      if (method === 'POST' && pathname === '/v1/orchestrations') {
        const finishAdmission = beginAdmission(response);
        if (finishAdmission === undefined) return;
        try {
          if (!runtime.startOrchestration) {
            sendJson(response, 501, { error: 'Orchestration is not available on this runtime' });
            return;
          }
          const started = await runtime.startOrchestration(asOrchestrationRequest(await readJson(request)));
          admittedWork = true;
          sendJson(response, 202, { orchestration: started.orchestration });
        } finally {
          finishAdmission();
        }
        return;
      }

      const match = /^\/v1\/jobs\/([a-zA-Z0-9_-]+)(?:\/(events|cancel|control))?$/.exec(pathname);
      if (match) {
        const id = match[1];
        const action = match[2];
        if (!id) throw new Error('Missing job id');
        if (method === 'GET' && action === undefined) {
          const job = await runtime.get(id);
          if (!job) {
            sendJson(response, 404, { error: 'Job not found' });
            return;
          }
          sendJson(response, 200, { job });
          return;
        }
        if (method === 'GET' && action === 'events') {
          let job = await runtime.get(id);
          if (!job) {
            sendJson(response, 404, { error: 'Job not found' });
            return;
          }
          const after = eventCursor(request);
          if (after === undefined) {
            sendJson(response, 200, { events: job.events });
            return;
          }
          const jobEventsAfter = runtime.jobEventsAfter ?? runtime.eventsAfter;
          let events = jobEventsAfter
            ? await jobEventsAfter.call(runtime, id, after)
            : job.events.filter((event) => event.sequence > after);
          if (events.length === 0 && !isTerminalStatus(job.status)) {
            const waitForJob = runtime.waitForJob ?? runtime.wait;
            if (!waitForJob) {
              sendJson(response, 501, { error: 'Durable Job wait is not available on this runtime' });
              return;
            }
            job = await observeWhileConnected(request, response, (signal) =>
              waitForJob.call(runtime, id, WAIT_HEARTBEAT_MS, signal)
            );
            if (!job) {
              sendJson(response, 404, { error: 'Job not found' });
              return;
            }
            events = jobEventsAfter
              ? await jobEventsAfter.call(runtime, id, after)
              : job.events.filter((event) => event.sequence > after);
          }
          const nextSequence = isTerminalStatus(job.status)
            ? nextEventSequence(job.events, after)
            : nextEventSequence(events, after);
          sendJson(response, isTerminalStatus(job.status) ? 200 : 202, isTerminalStatus(job.status)
            ? { nextSequence, job }
            : { events, nextSequence, wait: compactJobProgress(job) });
          return;
        }
        if (method === 'POST' && action === 'cancel') {
          if (!runtime.cancelJob) {
            sendJson(response, 501, { error: 'Durable job cancellation is not available on this runtime' });
            return;
          }
          if (!(await runtime.cancelJob(id, 'http-controller'))) {
            sendJson(response, 409, { error: 'Job is not cancellable' });
            return;
          }
          sendJson(response, 202, { accepted: true, jobId: id });
          return;
        }
        if (action === 'control') {
          if (!runtime.workerControlCapabilities || !runtime.controlJob) {
            sendJson(response, 501, { error: 'Live worker control is not available on this runtime' });
            return;
          }
          if (method === 'GET') {
            const capabilities = await runtime.workerControlCapabilities(id);
            if (capabilities === undefined) {
              sendJson(response, 404, { error: 'Job not found' });
              return;
            }
            sendJson(response, 200, { capabilities });
            return;
          }
          if (method === 'POST') {
            const receipt = await runtime.controlJob(
              id,
              validateWorkerControlRequest(await readJson(request))
            );
            if (receipt === undefined) {
              sendJson(response, 404, { error: 'Job not found' });
              return;
            }
            sendJson(response, receipt.status === 'accepted' ? 202 : 200, { receipt });
            return;
          }
          sendJson(response, 405, { error: 'Method not allowed' });
          return;
        }
      }

      const orchestrationMatch =
        /^\/v1\/orchestrations\/([a-zA-Z0-9_-]+)(?:\/(events|cancel))?$/.exec(pathname);
      if (orchestrationMatch) {
        const id = orchestrationMatch[1];
        const action = orchestrationMatch[2];
        if (!id) throw new Error('Missing orchestration id');
        if (!runtime.getOrchestration) {
          sendJson(response, 501, { error: 'Orchestration is not available on this runtime' });
          return;
        }
        if (method === 'GET' && action === undefined) {
          const orchestration = await runtime.getOrchestration(id);
          if (!orchestration) {
            sendJson(response, 404, { error: 'Orchestration not found' });
            return;
          }
          sendJson(response, 200, { orchestration });
          return;
        }
        if (method === 'GET' && action === 'events') {
          let orchestration = await runtime.getOrchestration(id);
          if (!orchestration) {
            sendJson(response, 404, { error: 'Orchestration not found' });
            return;
          }
          const after = eventCursor(request);
          if (after === undefined) {
            sendJson(response, 200, { events: orchestration.events });
            return;
          }
          let events = runtime.orchestrationEventsAfter
            ? await runtime.orchestrationEventsAfter(id, after)
            : orchestration.events.filter((event) => event.sequence > after);
          if (events.length === 0 && !isTerminalStatus(orchestration.status)) {
            if (!runtime.waitForOrchestration) {
              sendJson(response, 501, {
                error: 'Durable Orchestration wait is not available on this runtime',
              });
              return;
            }
            orchestration = await observeWhileConnected(request, response, (signal) =>
              runtime.waitForOrchestration!(id, WAIT_HEARTBEAT_MS, signal)
            );
            if (!orchestration) {
              sendJson(response, 404, { error: 'Orchestration not found' });
              return;
            }
            events = runtime.orchestrationEventsAfter
              ? await runtime.orchestrationEventsAfter(id, after)
              : orchestration.events.filter((event) => event.sequence > after);
          }
          const nextSequence = isTerminalStatus(orchestration.status)
            ? nextEventSequence(orchestration.events, after)
            : nextEventSequence(events, after);
          sendJson(response, isTerminalStatus(orchestration.status) ? 200 : 202, isTerminalStatus(orchestration.status)
            ? { nextSequence, orchestration }
            : {
                events,
                nextSequence,
                wait: await compactOrchestrationProgress(runtime, orchestration),
              });
          return;
        }
        if (method === 'POST' && action === 'cancel') {
          if (!runtime.cancelOrchestration) {
            sendJson(response, 501, {
              error: 'Durable orchestration cancellation is not available on this runtime',
            });
            return;
          }
          if (!(await runtime.cancelOrchestration(id, 'http-controller'))) {
            sendJson(response, 409, { error: 'Orchestration is not cancellable' });
            return;
          }
          sendJson(response, 202, { accepted: true, orchestrationId: id });
          return;
        }
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      if (error instanceof JobControlPersistenceError) {
        sendJson(response, 503, { error: error.message, delivery: error.delivery });
        return;
      }
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return {
    server,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Could not resolve listening address'));
            return;
          }
          resolve({ host, port: address.port });
        });
      });
    },
    drain,
    close() {
      closePromise ??= (async () => {
        const errors: unknown[] = [];
        try {
          await drain();
        } catch (error: unknown) {
          errors.push(error);
        }
        if (server.listening) {
          try {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          } catch (error: unknown) {
            errors.push(error);
          }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'AgentKnot HTTP close failed');
      })();
      return closePromise;
    },
  };
}

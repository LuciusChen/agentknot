import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { DelegationConfig } from './config.js';
import { assertJsonMetadata } from './metadata.js';
import { buildJobList } from './job-list.js';
import type {
  OrchestrationRecord,
  OrchestrationRequest,
  StartOrchestrationResult,
} from './orchestration-types.js';
import type {
  JobArtifactList,
  JobArtifactPreview,
  JobArtifactVerificationReport,
  JobRequest,
  StartJobResult,
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

function terminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

async function completionOrHeartbeat<T>(completion: Promise<T>): Promise<T | undefined> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, WAIT_HEARTBEAT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  const metadata = body.metadata;
  if (metadata !== undefined) assertJsonMetadata(metadata);
  return {
    prompt: body.prompt,
    workspace: body.workspace,
    ...(body.route === undefined ? {} : { route: body.route as string }),
    ...(body.source === undefined ? {} : { source: body.source as string }),
    ...(body.callbackUrl === undefined ? {} : { callbackUrl: body.callbackUrl as string }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function asOrchestrationRequest(value: unknown): OrchestrationRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Request body must be an object');
  }
  const body = value as Record<string, unknown>;
  if (typeof body.prompt !== 'string') throw new Error('prompt must be a string');
  if (typeof body.workspace !== 'string') throw new Error('workspace must be a string');
  if (body.source !== undefined && typeof body.source !== 'string') throw new Error('source must be a string');
  if (
    body.delegation !== undefined &&
    !['inherit', 'never', 'suggest', 'force'].includes(String(body.delegation))
  ) {
    throw new Error('delegation must be "inherit", "never", "suggest", or "force"');
  }
  const metadata = body.metadata;
  if (metadata !== undefined) assertJsonMetadata(metadata);
  return {
    prompt: body.prompt,
    workspace: body.workspace,
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
  delegationPolicy?(): DelegationConfig;
  getOrchestration?(id: string): Promise<OrchestrationRecord | undefined>;
  listOrchestrations?(): Promise<OrchestrationRecord[]>;
  startOrchestration?(request: OrchestrationRequest): Promise<StartOrchestrationResult>;
}

export interface AgentKnotHttpServer {
  server: Server;
  listen(port: number, host?: string): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createAgentKnotHttpServer(runtime: AgentKnotHttpRuntime): AgentKnotHttpServer {
  const activeJobs = new Map<string, StartJobResult>();
  const activeOrchestrations = new Map<string, StartOrchestrationResult>();
  let closing = false;
  let admissionsInFlight = 0;
  let admissionsDrained: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;

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
      if (admissionsInFlight === 0) admissionsDrained?.();
    };
  };

  const waitForAdmissions = (): Promise<void> =>
    admissionsInFlight === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          admissionsDrained = resolve;
        });

  const server = createServer(async (request, response) => {
    response.once('error', () => undefined);
    try {
      const method = request.method ?? 'GET';
      const pathname = requestPath(request);

      if (method === 'GET' && (pathname === '/health/live' || pathname === '/health')) {
        sendJson(response, 200, LIVE_HEALTH_RESPONSE);
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
          activeJobs.set(started.job.id, started);
          void started.completion.then(
            () => activeJobs.delete(started.job.id),
            () => activeJobs.delete(started.job.id)
          );
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
          activeOrchestrations.set(started.orchestration.id, started);
          void started.completion.then(
            () => activeOrchestrations.delete(started.orchestration.id),
            () => activeOrchestrations.delete(started.orchestration.id)
          );
          sendJson(response, 202, { orchestration: started.orchestration });
        } finally {
          finishAdmission();
        }
        return;
      }

      const match = /^\/v1\/jobs\/([a-zA-Z0-9_-]+)(?:\/(events|cancel|wait))?$/.exec(pathname);
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
          const job = await runtime.get(id);
          if (!job) {
            sendJson(response, 404, { error: 'Job not found' });
            return;
          }
          sendJson(response, 200, { events: job.events });
          return;
        }
        if (method === 'GET' && action === 'wait') {
          const job = await runtime.get(id);
          if (!job) {
            sendJson(response, 404, { error: 'Job not found' });
            return;
          }
          if (terminal(job.status)) {
            sendJson(response, 200, { job });
            return;
          }
          const active = activeJobs.get(id);
          if (!active) {
            sendJson(response, 409, { error: 'Job is not active on this server' });
            return;
          }
          const completed = await completionOrHeartbeat(active.completion);
          if (completed !== undefined) {
            sendJson(response, 200, { job: completed });
            return;
          }
          const current = await runtime.get(id);
          if (!current) {
            sendJson(response, 404, { error: 'Job not found' });
            return;
          }
          sendJson(response, terminal(current.status) ? 200 : 202, terminal(current.status)
            ? { job: current }
            : { wait: compactJobProgress(current) });
          return;
        }
        if (method === 'POST' && action === 'cancel') {
          const active = activeJobs.get(id);
          if (!active) {
            sendJson(response, 409, { error: 'Job is not active on this server' });
            return;
          }
          active.cancel();
          sendJson(response, 202, { accepted: true, jobId: id });
          return;
        }
      }

      const orchestrationMatch =
        /^\/v1\/orchestrations\/([a-zA-Z0-9_-]+)(?:\/(events|cancel|wait))?$/.exec(pathname);
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
          const orchestration = await runtime.getOrchestration(id);
          if (!orchestration) {
            sendJson(response, 404, { error: 'Orchestration not found' });
            return;
          }
          sendJson(response, 200, { events: orchestration.events });
          return;
        }
        if (method === 'GET' && action === 'wait') {
          const orchestration = await runtime.getOrchestration(id);
          if (!orchestration) {
            sendJson(response, 404, { error: 'Orchestration not found' });
            return;
          }
          if (terminal(orchestration.status)) {
            sendJson(response, 200, { orchestration });
            return;
          }
          const active = activeOrchestrations.get(id);
          if (!active) {
            sendJson(response, 409, { error: 'Orchestration is not active on this server' });
            return;
          }
          const completed = await completionOrHeartbeat(active.completion);
          if (completed !== undefined) {
            sendJson(response, 200, { orchestration: completed });
            return;
          }
          const current = await runtime.getOrchestration(id);
          if (!current) {
            sendJson(response, 404, { error: 'Orchestration not found' });
            return;
          }
          sendJson(response, terminal(current.status) ? 200 : 202, terminal(current.status)
            ? { orchestration: current }
            : { wait: await compactOrchestrationProgress(runtime, current) });
          return;
        }
        if (method === 'POST' && action === 'cancel') {
          const active = activeOrchestrations.get(id);
          if (!active) {
            sendJson(response, 409, { error: 'Orchestration is not active on this server' });
            return;
          }
          await active.cancel();
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
    close() {
      closePromise ??= (async () => {
        closing = true;
        await waitForAdmissions();
        const active = [
          ...[...activeOrchestrations.values()].map((item) => item.completion),
          ...[...activeJobs.values()].map((item) => item.completion),
        ];
        await Promise.allSettled([
          ...[...activeOrchestrations.values()].map((item) => item.cancel()),
          ...[...activeJobs.values()].map(async (item) => item.cancel()),
        ]);
        await Promise.allSettled(active);
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      })();
      return closePromise;
    },
  };
}

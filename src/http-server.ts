import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Orchestrator } from './orchestrator.js';
import type { JobRequest, StartJobResult } from './types.js';

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const data = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  response.end(data);
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
  if (body.metadata !== undefined && (typeof body.metadata !== 'object' || body.metadata === null)) {
    throw new Error('metadata must be an object');
  }
  return {
    prompt: body.prompt,
    workspace: body.workspace,
    ...(body.route === undefined ? {} : { route: body.route as string }),
    ...(body.source === undefined ? {} : { source: body.source as string }),
    ...(body.callbackUrl === undefined ? {} : { callbackUrl: body.callbackUrl as string }),
    ...(body.metadata === undefined ? {} : { metadata: body.metadata as Record<string, unknown> }),
  };
}

export interface AgentKnotHttpServer {
  server: Server;
  listen(port: number, host?: string): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createAgentKnotHttpServer(orchestrator: Orchestrator): AgentKnotHttpServer {
  const activeJobs = new Map<string, StartJobResult>();
  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? 'GET';
      const pathname = requestPath(request);

      if (method === 'GET' && pathname === '/health') {
        sendJson(response, 200, { ok: true, service: 'agentknot' });
        return;
      }
      if (method === 'GET' && pathname === '/v1/routes') {
        sendJson(response, 200, { routes: orchestrator.routes() });
        return;
      }
      if (method === 'GET' && pathname === '/v1/jobs') {
        sendJson(response, 200, { jobs: await orchestrator.list() });
        return;
      }
      if (method === 'POST' && pathname === '/v1/jobs') {
        const started = await orchestrator.start(asJobRequest(await readJson(request)));
        activeJobs.set(started.job.id, started);
        void started.completion.finally(() => activeJobs.delete(started.job.id));
        sendJson(response, 202, { job: started.job });
        return;
      }

      const match = /^\/v1\/jobs\/([a-zA-Z0-9_-]+)(?:\/(events|cancel))?$/.exec(pathname);
      if (match) {
        const id = match[1];
        const action = match[2];
        if (!id) throw new Error('Missing job id');
        if (method === 'GET' && action === undefined) {
          const job = await orchestrator.get(id);
          if (!job) {
            sendJson(response, 404, { error: 'Job not found' });
            return;
          }
          sendJson(response, 200, { job });
          return;
        }
        if (method === 'GET' && action === 'events') {
          const job = await orchestrator.get(id);
          if (!job) {
            sendJson(response, 404, { error: 'Job not found' });
            return;
          }
          sendJson(response, 200, { events: job.events });
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

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
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
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

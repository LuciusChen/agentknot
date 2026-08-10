import type { DelegationConfig } from './config.js';
import type { JobList } from './job-list.js';
import type { OrchestrationRecord, OrchestrationRequest } from './orchestration-types.js';
import type {
  JobArtifactList,
  JobArtifactPreview,
  JobArtifactVerificationReport,
  JobRecord,
  JobRequest,
} from './types.js';

const HTTP_OPERATION_TIMEOUT_MS = 10_000;
const MAX_HTTP_RESPONSE_BYTES = 17 * 1024 * 1024;
const WAIT_RETRY_DELAY_MS = 1_000;
const WAIT_RECONNECT_ATTEMPTS = 3;

interface WaitActivity {
  readonly sequence: number;
  readonly at: string;
  readonly type: string;
}

interface WaitChildProgress {
  readonly subtaskId: string;
  readonly jobId: string;
  readonly status: string;
  readonly route?: string;
  readonly lastActivity?: WaitActivity;
}

export type AgentKnotWaitProgress =
  | {
      readonly schemaVersion: 1;
      readonly kind: 'job';
      readonly id: string;
      readonly status: string;
      readonly updatedAt: string;
      readonly route: string;
      readonly attempt?: number;
      readonly lastActivity?: WaitActivity;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: 'orchestration';
      readonly id: string;
      readonly status: string;
      readonly phase: string;
      readonly updatedAt: string;
      readonly lastActivity?: WaitActivity;
      readonly children: readonly WaitChildProgress[];
    };

export type AgentKnotWaitUpdate =
  | { readonly connectivity: 'connected'; readonly progress: AgentKnotWaitProgress }
  | {
      readonly connectivity: 'disconnected';
      readonly id: string;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly message: string;
    };

export interface AgentKnotHealthResponse {
  readonly ok: true;
  readonly service: 'agentknot';
  readonly status: 'live';
  readonly checks: {
    readonly storage: 'not-checked';
    readonly routes: 'not-checked';
    readonly inference: 'not-checked';
  };
}

export class AgentKnotHttpClientError extends Error {
  readonly name = 'AgentKnotHttpClientError';

  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentKnotHttpClientError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const error = (value as Record<string, unknown>).error;
  return typeof error === 'string' ? error.slice(0, 1_000) : undefined;
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_HTTP_RESPONSE_BYTES) {
    throw new AgentKnotHttpClientError(
      `AgentKnot server response exceeds ${MAX_HTTP_RESPONSE_BYTES} bytes`
    );
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = Buffer.from(next.value);
    bytes += chunk.byteLength;
    if (bytes > MAX_HTTP_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AgentKnotHttpClientError(
        `AgentKnot server response exceeds ${MAX_HTTP_RESPONSE_BYTES} bytes`
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function terminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitProgress(value: unknown, kind: AgentKnotWaitProgress['kind'], id: string): AgentKnotWaitProgress {
  const progress = asObject(value, `${kind} wait response.wait`);
  if (
    progress.schemaVersion !== 1 ||
    progress.kind !== kind ||
    progress.id !== id ||
    typeof progress.status !== 'string' ||
    typeof progress.updatedAt !== 'string'
  ) {
    throw new AgentKnotHttpClientError(`${kind} wait response.wait is invalid`);
  }
  if (kind === 'job') {
    if (typeof progress.route !== 'string') {
      throw new AgentKnotHttpClientError('job wait response.wait.route must be a string');
    }
  } else if (typeof progress.phase !== 'string' || !Array.isArray(progress.children)) {
    throw new AgentKnotHttpClientError('orchestration wait response.wait progress is invalid');
  }
  return progress as unknown as AgentKnotWaitProgress;
}

function retryableTransportError(error: unknown): error is AgentKnotHttpClientError {
  return error instanceof AgentKnotHttpClientError &&
    error.status === undefined &&
    error.message.startsWith('AgentKnot server request failed:');
}

export class AgentKnotHttpClient {
  readonly #baseUrl: URL;

  constructor(serverUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(serverUrl);
    } catch {
      throw new AgentKnotHttpClientError(`Invalid AgentKnot server URL: ${serverUrl}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AgentKnotHttpClientError('AgentKnot server URL must use http or https');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new AgentKnotHttpClientError('AgentKnot server URL must not contain credentials');
    }
    this.#baseUrl = parsed;
  }

  async #request(pathname: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(pathname, this.#baseUrl), {
        ...init,
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        signal: AbortSignal.timeout(HTTP_OPERATION_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AgentKnotHttpClientError(
        `AgentKnot server request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const text = await boundedResponseText(response);
    let body: unknown;
    try {
      body = text === '' ? {} : (JSON.parse(text) as unknown);
    } catch {
      throw new AgentKnotHttpClientError(
        `AgentKnot server returned invalid JSON with HTTP ${response.status}`,
        response.status
      );
    }
    if (!response.ok) {
      throw new AgentKnotHttpClientError(
        `AgentKnot server returned HTTP ${response.status}: ${errorMessage(body) ?? response.statusText}`,
        response.status
      );
    }
    return body;
  }

  async health(): Promise<AgentKnotHealthResponse> {
    const body = asObject(await this.#request('/health/live'), 'health response');
    if (body.ok !== true) throw new AgentKnotHttpClientError('health response.ok must be true');
    if (body.service !== 'agentknot') {
      throw new AgentKnotHttpClientError('health response.service must be agentknot');
    }
    if (body.status !== 'live') {
      throw new AgentKnotHttpClientError('health response.status must be live');
    }
    const checks = asObject(body.checks, 'health response.checks');
    if (
      checks.storage !== 'not-checked' ||
      checks.routes !== 'not-checked' ||
      checks.inference !== 'not-checked'
    ) {
      throw new AgentKnotHttpClientError('health response.checks must report all checks as not-checked');
    }
    return {
      ok: true,
      service: 'agentknot',
      status: 'live',
      checks: {
        storage: 'not-checked',
        routes: 'not-checked',
        inference: 'not-checked',
      },
    };
  }

  async routes(): Promise<Array<{ name: string; worker: string; provider: string; model: string }>> {
    const body = asObject(await this.#request('/v1/routes'), 'routes response');
    if (!Array.isArray(body.routes)) {
      throw new AgentKnotHttpClientError('routes response.routes must be an array');
    }
    return body.routes as Array<{ name: string; worker: string; provider: string; model: string }>;
  }

  async delegationPolicy(): Promise<DelegationConfig> {
    const body = asObject(await this.#request('/v1/delegation'), 'delegation response');
    return asObject(body.delegation, 'delegation response.delegation') as unknown as DelegationConfig;
  }

  async startOrchestration(request: OrchestrationRequest): Promise<OrchestrationRecord> {
    const body = asObject(
      await this.#request('/v1/orchestrations', {
        method: 'POST',
        body: JSON.stringify(request),
      }),
      'orchestration admission response'
    );
    return asObject(
      body.orchestration,
      'orchestration admission response.orchestration'
    ) as unknown as OrchestrationRecord;
  }

  async getOrchestration(id: string): Promise<OrchestrationRecord | undefined> {
    try {
      const body = asObject(
        await this.#request(`/v1/orchestrations/${encodeURIComponent(id)}`),
        'orchestration response'
      );
      return asObject(body.orchestration, 'orchestration response.orchestration') as unknown as OrchestrationRecord;
    } catch (error) {
      if (error instanceof AgentKnotHttpClientError && error.status === 404) return undefined;
      throw error;
    }
  }

  async listOrchestrations(): Promise<OrchestrationRecord[]> {
    const body = asObject(await this.#request('/v1/orchestrations'), 'orchestration list response');
    if (!Array.isArray(body.orchestrations)) {
      throw new AgentKnotHttpClientError('orchestration list response.orchestrations must be an array');
    }
    return body.orchestrations as OrchestrationRecord[];
  }

  async waitForOrchestration(
    initial: OrchestrationRecord,
    onUpdate?: (update: AgentKnotWaitUpdate) => void
  ): Promise<OrchestrationRecord> {
    if (terminal(initial.status)) return initial;
    let reconnectAttempts = 0;
    while (true) {
      try {
        const body = asObject(
          await this.#request(`/v1/orchestrations/${encodeURIComponent(initial.id)}/wait`),
          'orchestration wait response'
        );
        reconnectAttempts = 0;
        if (body.orchestration !== undefined) {
          return asObject(
            body.orchestration,
            'orchestration wait response.orchestration'
          ) as unknown as OrchestrationRecord;
        }
        onUpdate?.({
          connectivity: 'connected',
          progress: waitProgress(body.wait, 'orchestration', initial.id),
        });
      } catch (error) {
        if (!retryableTransportError(error)) throw error;
        reconnectAttempts += 1;
        onUpdate?.({
          connectivity: 'disconnected',
          id: initial.id,
          attempt: reconnectAttempts,
          maxAttempts: WAIT_RECONNECT_ATTEMPTS,
          message: error.message,
        });
        if (reconnectAttempts >= WAIT_RECONNECT_ATTEMPTS) throw error;
        await delay(WAIT_RETRY_DELAY_MS);
      }
    }
  }

  async cancelOrchestration(id: string): Promise<void> {
    await this.#request(`/v1/orchestrations/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: '{}',
    });
  }

  async startJob(request: JobRequest): Promise<JobRecord> {
    const body = asObject(
      await this.#request('/v1/jobs', { method: 'POST', body: JSON.stringify(request) }),
      'job admission response'
    );
    return asObject(body.job, 'job admission response.job') as unknown as JobRecord;
  }

  async getJob(id: string): Promise<JobRecord | undefined> {
    try {
      const body = asObject(await this.#request(`/v1/jobs/${encodeURIComponent(id)}`), 'job response');
      return asObject(body.job, 'job response.job') as unknown as JobRecord;
    } catch (error) {
      if (error instanceof AgentKnotHttpClientError && error.status === 404) return undefined;
      throw error;
    }
  }

  async listJobs(): Promise<JobList> {
    const body = asObject(await this.#request('/v1/jobs'), 'job list response');
    if (!Array.isArray(body.jobs)) throw new AgentKnotHttpClientError('job list response.jobs must be an array');
    if (
      body.schemaVersion !== 1 ||
      !Number.isSafeInteger(body.total) ||
      (body.total as number) < 0 ||
      typeof body.truncated !== 'boolean' ||
      !Number.isSafeInteger(body.maxBytes) ||
      (body.maxBytes as number) <= 0
    ) {
      throw new AgentKnotHttpClientError('job list response metadata is invalid');
    }
    return body as unknown as JobList;
  }

  async waitForJob(
    initial: JobRecord,
    onUpdate?: (update: AgentKnotWaitUpdate) => void
  ): Promise<JobRecord> {
    if (terminal(initial.status)) return initial;
    let reconnectAttempts = 0;
    while (true) {
      try {
        const body = asObject(
          await this.#request(`/v1/jobs/${encodeURIComponent(initial.id)}/wait`),
          'job wait response'
        );
        reconnectAttempts = 0;
        if (body.job !== undefined) {
          return asObject(body.job, 'job wait response.job') as unknown as JobRecord;
        }
        onUpdate?.({
          connectivity: 'connected',
          progress: waitProgress(body.wait, 'job', initial.id),
        });
      } catch (error) {
        if (!retryableTransportError(error)) throw error;
        reconnectAttempts += 1;
        onUpdate?.({
          connectivity: 'disconnected',
          id: initial.id,
          attempt: reconnectAttempts,
          maxAttempts: WAIT_RECONNECT_ATTEMPTS,
          message: error.message,
        });
        if (reconnectAttempts >= WAIT_RECONNECT_ATTEMPTS) throw error;
        await delay(WAIT_RETRY_DELAY_MS);
      }
    }
  }

  async cancelJob(id: string): Promise<void> {
    await this.#request(`/v1/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: '{}',
    });
  }

  async listArtifacts(id: string): Promise<JobArtifactList | undefined> {
    try {
      return (await this.#request(`/v1/jobs/${encodeURIComponent(id)}/artifacts`)) as JobArtifactList;
    } catch (error) {
      if (error instanceof AgentKnotHttpClientError && error.status === 404) return undefined;
      throw error;
    }
  }

  async verifyArtifacts(id: string): Promise<JobArtifactVerificationReport | undefined> {
    try {
      return (await this.#request(
        `/v1/jobs/${encodeURIComponent(id)}/artifacts/verify`
      )) as JobArtifactVerificationReport;
    } catch (error) {
      if (error instanceof AgentKnotHttpClientError && error.status === 404) return undefined;
      throw error;
    }
  }

  async previewArtifact(id: string, attempt: number): Promise<JobArtifactPreview | undefined> {
    try {
      return (await this.#request(
        `/v1/jobs/${encodeURIComponent(id)}/artifacts/${attempt}/preview`
      )) as JobArtifactPreview;
    } catch (error) {
      if (error instanceof AgentKnotHttpClientError && error.status === 404) return undefined;
      throw error;
    }
  }
}

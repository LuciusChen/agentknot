import type { DelegationConfig } from './config.js';
import { isTerminalStatus } from './execution-status.js';
import {
  isJobActivityProjection,
  type JobActivityProjection,
} from './job-activity.js';
import type { AgentKnotBrokerIdentity } from './http-server.js';
import type { JobList } from './job-list.js';
import type {
  OrchestrationEvent,
  OrchestrationRecord,
  OrchestrationRequest,
} from './orchestration-types.js';
import type {
  JobArtifactList,
  JobArtifactPreview,
  JobArtifactVerificationReport,
  JobEvent,
  JobRecord,
  JobRequest,
  WorkerControlCapabilities,
  WorkerControlReceipt,
  WorkerControlRequest,
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
  readonly activity?: JobActivityProjection;
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
      readonly activity?: JobActivityProjection;
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
  | {
      readonly connectivity: 'connected';
      readonly nextSequence: number;
      readonly progress?: AgentKnotWaitProgress;
    }
  | {
      readonly connectivity: 'disconnected';
      readonly id: string;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly message: string;
    };

export interface AgentKnotEventBatch<Event, Record> {
  readonly events: Event[];
  readonly nextSequence: number;
  readonly record?: Record;
  readonly progress?: AgentKnotWaitProgress;
}

interface WaitableRecord<Event extends { sequence: number }> {
  readonly id: string;
  readonly status: string;
  readonly events: readonly Event[];
}

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

function recordWithId<Record extends { readonly id: string }>(
  value: unknown,
  label: string,
  expectedId: string
): Record {
  const record = asObject(value, label);
  if (record.id !== expectedId) {
    throw new AgentKnotHttpClientError(`${label}.id does not match requested ID ${expectedId}`);
  }
  return record as unknown as Record;
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

function latestSequence(events: ReadonlyArray<{ sequence: number }>, initial = 0): number {
  return events.reduce((cursor, event) => Math.max(cursor, event.sequence), initial);
}

function sequencedEvents<Event extends { sequence: number }>(
  value: unknown,
  label: string
): Event[] {
  if (!Array.isArray(value)) throw new AgentKnotHttpClientError(`${label} must be an array`);
  for (const event of value) {
    if (
      typeof event !== 'object' ||
      event === null ||
      Array.isArray(event) ||
      !Number.isSafeInteger((event as { sequence?: unknown }).sequence) ||
      ((event as { sequence: number }).sequence < 1)
    ) {
      throw new AgentKnotHttpClientError(`${label} contains an invalid event`);
    }
  }
  return value as Event[];
}

function responseSequence(value: unknown, derived: number, label: string): number {
  if (value === undefined) return derived;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || value !== derived) {
    throw new AgentKnotHttpClientError(`${label} does not match its durable event suffix`);
  }
  return value as number;
}

function clientAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('AgentKnot observation aborted');
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(clientAbortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(clientAbortError(signal as AbortSignal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
    if (progress.activity !== undefined && !isJobActivityProjection(progress.activity)) {
      throw new AgentKnotHttpClientError('job wait response.wait.activity is invalid');
    }
  } else if (typeof progress.phase !== 'string' || !Array.isArray(progress.children)) {
    throw new AgentKnotHttpClientError('orchestration wait response.wait progress is invalid');
  } else {
    for (const child of progress.children) {
      if (typeof child !== 'object' || child === null || Array.isArray(child)) {
        throw new AgentKnotHttpClientError('orchestration wait response.wait child is invalid');
      }
      const activity = (child as Record<string, unknown>).activity;
      if (activity !== undefined && !isJobActivityProjection(activity)) {
        throw new AgentKnotHttpClientError('orchestration wait response.wait child activity is invalid');
      }
    }
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

  async #request(
    pathname: string,
    init: RequestInit = {},
    timeoutMs = HTTP_OPERATION_TIMEOUT_MS
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(pathname, this.#baseUrl), {
        ...init,
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        signal:
          init.signal == null
            ? AbortSignal.timeout(timeoutMs)
            : AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]),
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

  async #waitForRecord<
    Event extends { sequence: number },
    Record extends WaitableRecord<Event>,
  >(
    initial: Record,
    follow: (
      id: string,
      afterSequence: number,
      signal?: AbortSignal
    ) => Promise<AgentKnotEventBatch<Event, Record>>,
    onUpdate?: (update: AgentKnotWaitUpdate) => void,
    signal?: AbortSignal
  ): Promise<Record> {
    if (isTerminalStatus(initial.status)) return initial;
    let reconnectAttempts = 0;
    let cursor = latestSequence(initial.events);
    while (true) {
      try {
        const batch = await follow(initial.id, cursor, signal);
        reconnectAttempts = 0;
        cursor = batch.nextSequence;
        if (batch.record !== undefined) return batch.record;
        onUpdate?.({
          connectivity: 'connected',
          nextSequence: cursor,
          ...(batch.progress === undefined ? {} : { progress: batch.progress }),
        });
      } catch (error) {
        if (signal?.aborted) throw clientAbortError(signal);
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
        await delay(WAIT_RETRY_DELAY_MS, signal);
      }
    }
  }

  async #followRecord<
    Event extends { sequence: number },
    Record extends WaitableRecord<Event>,
  >(
    kind: 'job' | 'orchestration',
    id: string,
    afterSequence: number,
    signal?: AbortSignal
  ): Promise<AgentKnotEventBatch<Event, Record>> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new AgentKnotHttpClientError(
        `${kind} event cursor must be a non-negative integer`
      );
    }
    const label = `${kind} wait response`;
    const body = asObject(
      await this.#request(
        `/v1/${kind === 'job' ? 'jobs' : 'orchestrations'}/${encodeURIComponent(id)}/events?after=${afterSequence}`,
        signal === undefined ? {} : { signal }
      ),
      label
    );
    const value = body[kind];
    const record =
      value === undefined
        ? undefined
        : recordWithId<Record>(value, `${label}.${kind}`, id);
    const events =
      body.events === undefined
        ? record?.events.filter((event) => event.sequence > afterSequence) ?? []
        : sequencedEvents<Event>(body.events, `${label}.events`);
    return {
      events: [...events],
      nextSequence: responseSequence(
        body.nextSequence,
        latestSequence(events, afterSequence),
        `${label}.nextSequence`
      ),
      ...(record === undefined ? {} : { record }),
      ...(body.wait === undefined ? {} : { progress: waitProgress(body.wait, kind, id) }),
    };
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

  async brokerIdentity(timeoutMs = 1_000): Promise<AgentKnotBrokerIdentity> {
    const body = asObject(await this.#request('/v1/broker', {}, timeoutMs), 'broker identity response');
    if (
      body.schemaVersion !== 1 ||
      body.service !== 'agentknot-broker' ||
      typeof body.instanceId !== 'string' ||
      !Number.isSafeInteger(body.pid) ||
      (body.pid as number) <= 0 ||
      typeof body.startedAt !== 'string'
    ) {
      throw new AgentKnotHttpClientError('broker identity response is invalid');
    }
    return body as unknown as AgentKnotBrokerIdentity;
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

  async getOrchestration(
    id: string,
    signal?: AbortSignal
  ): Promise<OrchestrationRecord | undefined> {
    try {
      const body = asObject(
        await this.#request(
          `/v1/orchestrations/${encodeURIComponent(id)}`,
          signal === undefined ? {} : { signal }
        ),
        'orchestration response'
      );
      return recordWithId<OrchestrationRecord>(
        body.orchestration,
        'orchestration response.orchestration',
        id
      );
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
    onUpdate?: (update: AgentKnotWaitUpdate) => void,
    signal?: AbortSignal
  ): Promise<OrchestrationRecord> {
    return this.#waitForRecord(
      initial,
      (id, afterSequence, currentSignal) =>
        this.followOrchestration(id, afterSequence, currentSignal),
      onUpdate,
      signal
    );
  }

  async followOrchestration(
    id: string,
    afterSequence: number,
    signal?: AbortSignal
  ): Promise<AgentKnotEventBatch<OrchestrationEvent, OrchestrationRecord>> {
    return this.#followRecord('orchestration', id, afterSequence, signal);
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
      return recordWithId<JobRecord>(body.job, 'job response.job', id);
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
    onUpdate?: (update: AgentKnotWaitUpdate) => void,
    signal?: AbortSignal
  ): Promise<JobRecord> {
    return this.#waitForRecord(
      initial,
      (id, afterSequence, currentSignal) => this.followJob(id, afterSequence, currentSignal),
      onUpdate,
      signal
    );
  }

  async followJob(
    id: string,
    afterSequence: number,
    signal?: AbortSignal
  ): Promise<AgentKnotEventBatch<JobEvent, JobRecord>> {
    return this.#followRecord('job', id, afterSequence, signal);
  }

  async cancelJob(id: string): Promise<void> {
    await this.#request(`/v1/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: '{}',
    });
  }

  async workerControlCapabilities(id: string): Promise<WorkerControlCapabilities | undefined> {
    try {
      const body = asObject(
        await this.#request(`/v1/jobs/${encodeURIComponent(id)}/control`),
        'worker control capabilities response'
      );
      return this.#workerControlCapabilities(
        body.capabilities,
        'worker control capabilities response.capabilities',
        id
      );
    } catch (error) {
      if (error instanceof AgentKnotHttpClientError && error.status === 404) return undefined;
      throw error;
    }
  }

  async controlJob(
    id: string,
    request: WorkerControlRequest
  ): Promise<WorkerControlReceipt | undefined> {
    try {
      const body = asObject(
        await this.#request(`/v1/jobs/${encodeURIComponent(id)}/control`, {
          method: 'POST',
          body: JSON.stringify(request),
        }),
        'worker control response'
      );
      return this.#workerControlReceipt(
        body.receipt,
        'worker control response.receipt',
        id,
        request
      );
    } catch (error) {
      if (error instanceof AgentKnotHttpClientError && error.status === 404) return undefined;
      throw error;
    }
  }

  #workerControlCapabilities(
    value: unknown,
    label: string,
    expectedJobId: string
  ): WorkerControlCapabilities {
    const capabilities = asObject(value, label);
    if (
      capabilities.schemaVersion !== 1 ||
      capabilities.jobId !== expectedJobId ||
      !Number.isSafeInteger(capabilities.attempt) ||
      (capabilities.attempt as number) < 0 ||
      (capabilities.state !== 'active' && capabilities.state !== 'inactive') ||
      typeof capabilities.ready !== 'boolean' ||
      !Array.isArray(capabilities.kinds) ||
      !(capabilities.kinds as unknown[]).every((kind) => kind === 'steer' || kind === 'follow-up')
    ) {
      throw new AgentKnotHttpClientError(`${label} is invalid`);
    }
    return capabilities as unknown as WorkerControlCapabilities;
  }

  #workerControlReceipt(
    value: unknown,
    label: string,
    expectedJobId: string,
    request: WorkerControlRequest
  ): WorkerControlReceipt {
    const receipt = asObject(value, label);
    if (
      receipt.schemaVersion !== 1 ||
      typeof receipt.jobId !== 'string' ||
      receipt.jobId !== expectedJobId ||
      typeof receipt.controlId !== 'string' ||
      receipt.controlId !== request.controlId ||
      !Number.isSafeInteger(receipt.attempt) ||
      (receipt.attempt as number) < 1 ||
      receipt.attempt !== request.attempt ||
      (receipt.kind !== 'steer' && receipt.kind !== 'follow-up') ||
      receipt.kind !== request.kind ||
      !['accepted', 'unsupported', 'stale-attempt', 'adapter-rejected', 'lost'].includes(
        receipt.status as string
      ) ||
      typeof receipt.durable !== 'boolean' ||
      typeof receipt.requestedAt !== 'string' ||
      typeof receipt.settledAt !== 'string' ||
      (receipt.reason !== undefined && typeof receipt.reason !== 'string')
    ) {
      throw new AgentKnotHttpClientError(`${label} is invalid`);
    }
    return receipt as unknown as WorkerControlReceipt;
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

import type {
  WorkerControlAdapterRequest,
  WorkerControlAdapterResult,
  WorkerControlHandler,
  WorkerControlPort,
  WorkerControlKind,
  WorkerControlRequest,
} from './types.js';
import { WORKER_CONTROL_KINDS } from './types.js';
import { assertTextLimit, MAX_WORKER_CONTROL_MESSAGE_BYTES } from './record-limits.js';

const CONTROL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/u;

export function validateWorkerControlRequest(value: unknown): WorkerControlRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Worker control request must be a JSON object');
  }
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (
    keys.some((key) => !['schemaVersion', 'controlId', 'attempt', 'kind', 'message'].includes(key)) ||
    request.schemaVersion !== 1 ||
    typeof request.controlId !== 'string' ||
    !CONTROL_ID_PATTERN.test(request.controlId) ||
    !Number.isSafeInteger(request.attempt) ||
    (request.attempt as number) < 1 ||
    !WORKER_CONTROL_KINDS.includes(request.kind as WorkerControlKind) ||
    typeof request.message !== 'string' ||
    request.message.trim() === ''
  ) {
    throw new Error('Worker control request is invalid');
  }
  assertTextLimit('Worker control message', request.message, MAX_WORKER_CONTROL_MESSAGE_BYTES);
  return {
    schemaVersion: 1,
    controlId: request.controlId,
    attempt: request.attempt as number,
    kind: request.kind as WorkerControlKind,
    message: request.message,
  };
}

export function normalizeWorkerControlKinds(value: readonly WorkerControlKind[]): WorkerControlKind[] {
  const kinds = [...value];
  if (
    kinds.some((kind) => !WORKER_CONTROL_KINDS.includes(kind)) ||
    new Set(kinds).size !== kinds.length
  ) {
    throw new Error('Worker adapter returned invalid control capabilities');
  }
  return kinds;
}

export interface WorkerControlDeliveryResult {
  delivered: boolean;
  uncertain: boolean;
  result: WorkerControlAdapterResult;
}

/** One control binding owned by one worker attempt. */
export class AttemptWorkerControlChannel implements WorkerControlPort {
  #handler: WorkerControlHandler | undefined;
  #closed = false;

  constructor(readonly handlerTimeoutMs = 8_000) {
    if (!Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs < 1) {
      throw new Error('Worker control handler timeout must be a positive integer');
    }
  }

  get ready(): boolean {
    return !this.#closed && this.#handler !== undefined;
  }

  bind(handler: WorkerControlHandler): () => void {
    if (this.#closed) throw new Error('Worker control channel is closed');
    if (this.#handler !== undefined) throw new Error('Worker control channel is already bound');
    this.#handler = handler;
    let bound = true;
    return () => {
      if (!bound) return;
      bound = false;
      if (this.#handler === handler) this.#handler = undefined;
    };
  }

  async deliver(request: WorkerControlAdapterRequest): Promise<WorkerControlDeliveryResult> {
    const handler = this.#handler;
    if (this.#closed || handler === undefined) {
      return {
        delivered: false,
        uncertain: false,
        result: { accepted: false, reason: 'worker-control-not-ready' },
      };
    }

    const handled = Promise.resolve()
      .then(() => handler(request))
      .then<WorkerControlDeliveryResult, WorkerControlDeliveryResult>(
        (result) => ({ delivered: true, uncertain: false, result }),
        () => ({
          delivered: true,
          uncertain: true,
          result: { accepted: false, reason: 'worker-control-handler-failed' },
        })
      );
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<WorkerControlDeliveryResult>((resolve) => {
      timeout = setTimeout(() => resolve({
        delivered: true,
        uncertain: true,
        result: { accepted: false, reason: 'worker-control-handler-timeout' },
      }), this.handlerTimeoutMs);
    });
    const result = await Promise.race([handled, timedOut]);
    if (timeout !== undefined) clearTimeout(timeout);
    return result;
  }

  close(): void {
    this.#closed = true;
    this.#handler = undefined;
  }
}

export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_METADATA_BYTES = 64 * 1024;
export const MAX_METADATA_DEPTH = 20;
export const MAX_WORKER_EVENTS = 512;
export const MAX_EVENT_DATA_BYTES = 16 * 1024;
export const MAX_WORKER_CONTROL_MESSAGE_BYTES = 8 * 1024;
export const MAX_RESULT_OUTPUT_BYTES = 1024 * 1024;
export const MAX_WORKER_COMPLETION_REPORT_BYTES = 256 * 1024;
export const MAX_ERROR_NAME_BYTES = 256;
export const MAX_ERROR_MESSAGE_BYTES = 16 * 1024;
export const MAX_WORKER_STDERR_BYTES = 4 * 1024;
export const MAX_STARTUP_DIAGNOSTIC_BYTES = 4 * 1024;
export const MAX_JOB_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_ORCHESTRATION_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_WORK_ORDER_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_CANDIDATE_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_REVIEW_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_CALLBACK_BODY_BYTES = 8 * 1024 * 1024;

export interface TextTruncation {
  originalBytes: number;
  maxBytes: number;
}

export class RecordSizeLimitError extends Error {
  readonly name = 'RecordSizeLimitError';

  constructor(
    readonly recordKind: 'Job' | 'Orchestration' | 'WorkOrder' | 'Candidate' | 'Review',
    readonly actualBytes: number,
    readonly maxBytes: number
  ) {
    super(`${recordKind} record is ${actualBytes} bytes; maximum is ${maxBytes} bytes`);
  }
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertByteBudget(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
}

export function assertTextLimit(label: string, value: string, maxBytes: number): void {
  assertByteBudget(maxBytes);
  const actualBytes = utf8Bytes(value);
  if (actualBytes > maxBytes) {
    throw new Error(`${label} is ${actualBytes} bytes; maximum is ${maxBytes} bytes`);
  }
}

export function limitText(
  value: string,
  maxBytes: number
): { value: string; truncation?: TextTruncation } {
  assertByteBudget(maxBytes);
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maxBytes) return { value };

  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return {
    value: encoded.subarray(0, end).toString('utf8'),
    truncation: { originalBytes: encoded.byteLength, maxBytes },
  };
}

export function limitTextSuffix(value: string, maxBytes: number): string {
  assertByteBudget(maxBytes);
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maxBytes) return value;

  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString('utf8');
}

export function limitErrorDetails(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const boundedName = limitText(name, MAX_ERROR_NAME_BYTES).value;
  const messageBytes = utf8Bytes(message);
  if (messageBytes <= MAX_ERROR_MESSAGE_BYTES) return { name: boundedName, message };

  const notice = `\n[AgentKnot truncated error message from ${messageBytes} bytes]`;
  const prefix = limitText(message, MAX_ERROR_MESSAGE_BYTES - utf8Bytes(notice)).value;
  return { name: boundedName, message: `${prefix}${notice}` };
}

export function limitEventData(data: Record<string, unknown>): Record<string, unknown>;
export function limitEventData(data: undefined): undefined;
export function limitEventData(
  data: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  return limitObjectData(data, 'event.data', MAX_EVENT_DATA_BYTES);
}

export function limitObjectData(
  data: Record<string, unknown>,
  field: string,
  maxBytes: number
): Record<string, unknown> {
  assertByteBudget(maxBytes);
  try {
    const serialized = JSON.stringify(data, null, 2);
    const normalized: unknown = JSON.parse(serialized);
    if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
      throw new Error('serialized value is not an object');
    }
    const actualBytes = utf8Bytes(serialized);
    if (actualBytes <= maxBytes) return normalized as Record<string, unknown>;
    return {
      agentknotRecordLimit: {
        field,
        action: 'replaced',
        originalBytes: actualBytes,
        maxBytes,
      },
    };
  } catch {
    return {
      agentknotRecordLimit: {
        field,
        action: 'replaced',
        reason: 'not-json-serializable',
        maxBytes,
      },
    };
  }
}

export function serializeBoundedRecord(
  kind: 'Job' | 'Orchestration' | 'WorkOrder' | 'Candidate' | 'Review',
  value: unknown
): string {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const actualBytes = utf8Bytes(serialized);
  const maxBytes =
    kind === 'Job'
      ? MAX_JOB_RECORD_BYTES
      : kind === 'Orchestration'
        ? MAX_ORCHESTRATION_RECORD_BYTES
        : kind === 'WorkOrder'
          ? MAX_WORK_ORDER_RECORD_BYTES
          : kind === 'Candidate'
            ? MAX_CANDIDATE_RECORD_BYTES
            : MAX_REVIEW_RECORD_BYTES;
  if (actualBytes > maxBytes) throw new RecordSizeLimitError(kind, actualBytes, maxBytes);
  return serialized;
}

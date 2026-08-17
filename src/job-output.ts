import {
  DEFAULT_OUTPUT_CHUNK_BYTES,
  MAX_OUTPUT_CHUNK_BYTES,
  MIN_OUTPUT_CHUNK_BYTES,
} from './record-limits.js';
import type { JobOutputReadOptions, JobOutputReadResult, JobRecord } from './types.js';

function unavailable(
  jobId: string,
  subtaskId: string | undefined,
  reason: Extract<JobOutputReadResult, { status: 'unavailable' }>['reason']
): JobOutputReadResult {
  return {
    schemaVersion: 1,
    status: 'unavailable',
    jobId,
    ...(subtaskId === undefined ? {} : { subtaskId }),
    reason,
  };
}

function delegatedSubtaskId(job: JobRecord): string | undefined {
  const delegation = job.request.metadata?.agentknotDelegation;
  if (typeof delegation !== 'object' || delegation === null || Array.isArray(delegation)) {
    return undefined;
  }
  const value = (delegation as Record<string, unknown>).subtaskId;
  return typeof value === 'string' ? value : undefined;
}

function readLimit(options: JobOutputReadOptions): number {
  const maxBytes = options.maxBytes ?? DEFAULT_OUTPUT_CHUNK_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < MIN_OUTPUT_CHUNK_BYTES ||
    maxBytes > MAX_OUTPUT_CHUNK_BYTES
  ) {
    throw new RangeError(
      `maxBytes must be an integer between ${MIN_OUTPUT_CHUNK_BYTES} and ${MAX_OUTPUT_CHUNK_BYTES}`
    );
  }
  return maxBytes;
}

function readCursor(options: JobOutputReadOptions): number {
  const cursor = options.cursor ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RangeError('cursor must be a non-negative safe integer');
  }
  return cursor;
}

/**
 * Read one bounded UTF-8 chunk from the output already retained in a durable Job record.
 * This is O(total retained output bytes) because the current record store keeps output as JSON text.
 */
export function readJobOutputRecord(
  jobId: string,
  job: JobRecord | undefined,
  options: JobOutputReadOptions = {}
): JobOutputReadResult {
  const cursor = readCursor(options);
  const maxBytes = readLimit(options);
  const subtaskId = options.subtaskId;
  if (subtaskId !== undefined && (subtaskId.length < 1 || subtaskId.length > 256)) {
    throw new RangeError('subtaskId must contain 1 to 256 characters');
  }
  if (job === undefined) return unavailable(jobId, subtaskId, 'job-not-found');
  if (subtaskId !== undefined && delegatedSubtaskId(job) !== subtaskId) {
    return unavailable(jobId, subtaskId, 'subtask-not-found');
  }
  if (job.result === undefined) return unavailable(jobId, subtaskId, 'output-unavailable');

  const encoded = Buffer.from(job.result.output, 'utf8');
  if (cursor > encoded.byteLength) {
    throw new RangeError(`cursor ${cursor} exceeds retained output size ${encoded.byteLength}`);
  }
  if (cursor < encoded.byteLength && (encoded[cursor]! & 0xc0) === 0x80) {
    throw new RangeError('cursor must identify a UTF-8 code point boundary');
  }

  let end = Math.min(encoded.byteLength, cursor + maxBytes);
  while (end > cursor && end < encoded.byteLength && (encoded[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  const hasMore = end < encoded.byteLength;
  return {
    schemaVersion: 1,
    status: 'available',
    jobId,
    ...(subtaskId === undefined ? {} : { subtaskId }),
    chunk: encoded.subarray(cursor, end).toString('utf8'),
    cursor,
    ...(hasMore ? { nextCursor: end } : {}),
    hasMore,
    totalBytes: encoded.byteLength,
    ...(job.result.outputTruncation === undefined
      ? {}
      : { outputTruncation: structuredClone(job.result.outputTruncation) }),
  };
}

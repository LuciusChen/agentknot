import type {
  WorkerUsageEvidence,
  WorkerUsageUnavailableReason,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnavailableReason(value: unknown): value is WorkerUsageUnavailableReason {
  return value === 'missing' ||
    value === 'timeout' ||
    value === 'unsupported' ||
    value === 'invalid' ||
    value === 'worker-failure';
}

/** Validate and copy the fixed persisted/adapter usage projection. */
export function normalizeWorkerUsageEvidence(value: unknown): WorkerUsageEvidence {
  if (value === undefined) return { unavailableReason: 'missing' };
  if (!isRecord(value)) return { unavailableReason: 'invalid' };
  if (Object.hasOwn(value, 'unavailableReason')) {
    return isUnavailableReason(value.unavailableReason)
      ? { unavailableReason: value.unavailableReason }
      : { unavailableReason: 'invalid' };
  }
  const tokens = value.tokens;
  if (
    !isRecord(tokens) ||
    !Number.isSafeInteger(tokens.input) || Number(tokens.input) < 0 ||
    !Number.isSafeInteger(tokens.output) || Number(tokens.output) < 0 ||
    !Number.isSafeInteger(tokens.cacheRead) || Number(tokens.cacheRead) < 0 ||
    !Number.isSafeInteger(tokens.cacheWrite) || Number(tokens.cacheWrite) < 0 ||
    !Number.isSafeInteger(tokens.total) || Number(tokens.total) < 0 ||
    typeof value.cost !== 'number' || !Number.isFinite(value.cost) || value.cost < 0
  ) {
    return { unavailableReason: 'invalid' };
  }
  return {
    tokens: {
      input: tokens.input as number,
      output: tokens.output as number,
      cacheRead: tokens.cacheRead as number,
      cacheWrite: tokens.cacheWrite as number,
      total: tokens.total as number,
    },
    cost: value.cost,
  };
}

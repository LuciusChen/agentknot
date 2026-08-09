import { MAX_METADATA_BYTES, MAX_METADATA_DEPTH, assertTextLimit } from './record-limits.js';

function invalidMetadata(path: string): Error {
  return new Error(`metadata must be a JSON-compatible object${path === 'metadata' ? '' : ` (invalid value at ${path})`}`);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
  depth: number
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw invalidMetadata(path);
  }
  if (typeof value !== 'object') throw invalidMetadata(path);
  if (ancestors.has(value)) throw invalidMetadata(path);
  if (depth > MAX_METADATA_DEPTH) {
    throw new Error(`metadata nesting depth exceeds maximum ${MAX_METADATA_DEPTH}`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw invalidMetadata(`${path}[${index}]`);
        validateValue(value[index], `${path}[${index}]`, ancestors, depth + 1);
      }
      return;
    }

    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw invalidMetadata(path);
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw invalidMetadata(`${path}.${key}`);
      }
      validateValue(descriptor.value, `${path}.${key}`, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function assertJsonMetadata(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidMetadata('metadata');
  }
  validateValue(value, 'metadata', new WeakSet<object>(), 1);
  assertTextLimit('metadata', JSON.stringify(value), MAX_METADATA_BYTES);
}

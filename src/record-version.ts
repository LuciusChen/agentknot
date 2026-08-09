export const PERSISTED_RECORD_SCHEMA_VERSION = 1 as const;

type VersionedRecord = {
  schemaVersion: typeof PERSISTED_RECORD_SCHEMA_VERSION;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatVersion(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (typeof value === 'object') return Array.isArray(value) ? '<array>' : '<object>';
  return String(value);
}

export function materializePersistedRecord<T>(
  kind: 'Job' | 'Orchestration',
  value: unknown
): T & VersionedRecord {
  if (!isRecord(value)) {
    throw new Error(`Invalid persisted ${kind} record: expected an object`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'schemaVersion')) {
    return { ...value, schemaVersion: PERSISTED_RECORD_SCHEMA_VERSION } as T & VersionedRecord;
  }
  if (value.schemaVersion !== PERSISTED_RECORD_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported ${kind} schemaVersion ${formatVersion(value.schemaVersion)}; supported schemaVersion is ${PERSISTED_RECORD_SCHEMA_VERSION}`
    );
  }
  return value as T & VersionedRecord;
}

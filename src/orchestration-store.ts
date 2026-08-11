import RecordStoreBackend from './store.js';
import {
  SqliteDurableRecordStore,
  SqliteDurableStoreAdapter,
  IdempotencyConflictError,
  type IdempotentCreateResult,
  type OpenDurableStoreOptions,
} from './durable-record-store.js';
import type { OrchestrationRecord, OrchestrationStore } from './orchestration-types.js';

export class MemoryOrchestrationStore
  extends RecordStoreBackend<OrchestrationRecord>
  implements OrchestrationStore
{
  readonly #idempotency = new Map<string, { requestHash: string; recordId: string }>();

  constructor() {
    super('Orchestration');
  }

  async createIdempotent(
    scope: string,
    key: string,
    requestHash: string,
    record: OrchestrationRecord
  ): Promise<IdempotentCreateResult<OrchestrationRecord>> {
    const identity = `${scope}\u0000${key}`;
    const existing = this.#idempotency.get(identity);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) throw new IdempotencyConflictError('Idempotency key conflict');
      const persisted = await this.get(existing.recordId);
      if (persisted === undefined) {
        throw new Error(`Idempotency key references missing Orchestration ${existing.recordId}`);
      }
      return { created: false, record: persisted };
    }
    this.#idempotency.set(identity, { requestHash, recordId: record.id });
    try {
      await this.create(record);
      return { created: true, record: structuredClone(record) };
    } catch (error) {
      this.#idempotency.delete(identity);
      throw error;
    }
  }
}

export class FileOrchestrationStore
  extends RecordStoreBackend<OrchestrationRecord>
  implements OrchestrationStore
{
  constructor(readonly directory: string) {
    super('Orchestration', directory);
  }
}

/** Transactional Stage 3 store; `open` imports existing JSON snapshots without deleting them. */
export class SqliteOrchestrationStore
  extends SqliteDurableStoreAdapter<OrchestrationRecord>
  implements OrchestrationStore
{
  static async open(
    directory: string,
    options: OpenDurableStoreOptions & { importLegacy?: boolean } = {}
  ): Promise<SqliteOrchestrationStore> {
    const backend = await SqliteDurableRecordStore.open<OrchestrationRecord>(
      'Orchestration',
      directory,
      options
    );
    try {
      if (options.importLegacy !== false && options.readOnly !== true) {
        await backend.importLegacySnapshots();
      }
      return new SqliteOrchestrationStore(backend);
    } catch (error) {
      await backend.close();
      throw error;
    }
  }
}

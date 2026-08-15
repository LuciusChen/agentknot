import {
  SqliteDurableRecordStore,
  type OpenDurableStoreOptions,
} from './durable-record-store.js';
import {
  dispositionIdForCandidate,
  type DispositionEvent,
  type DispositionRecord,
  type DispositionStore,
} from './disposition.js';

/**
 * Transactional immutable Disposition store. DispositionService validates Candidate and Review
 * references; this store owns only atomic snapshot/event creation and durable read cursors.
 */
export class SqliteDispositionStore implements DispositionStore {
  readonly #backend: SqliteDurableRecordStore<DispositionRecord>;

  private constructor(backend: SqliteDurableRecordStore<DispositionRecord>) {
    this.#backend = backend;
  }

  static async open(
    directory: string,
    options: OpenDurableStoreOptions = {}
  ): Promise<SqliteDispositionStore> {
    return new SqliteDispositionStore(
      await SqliteDurableRecordStore.open<DispositionRecord>('Disposition', directory, options)
    );
  }

  get directory(): string {
    return this.#backend.directory;
  }

  async create(record: DispositionRecord): Promise<void> {
    const expectedId = dispositionIdForCandidate(record.candidateId);
    if (record.id !== expectedId) {
      throw new Error(
        `Disposition id ${record.id} must equal the Candidate-derived identity ${expectedId}`
      );
    }
    await this.#backend.create(record);
  }

  /** Naming alias for the domain operation; persistence still uses the existing atomic create. */
  record(record: DispositionRecord): Promise<void> {
    return this.create(record);
  }

  get(id: string): Promise<DispositionRecord | undefined> {
    return this.#backend.get(id);
  }

  getForCandidate(candidateId: string): Promise<DispositionRecord | undefined> {
    return this.#backend.get(dispositionIdForCandidate(candidateId));
  }

  list(): Promise<DispositionRecord[]> {
    return this.#backend.list();
  }

  eventsAfter(id: string, sequence: number): Promise<DispositionEvent[]> {
    return this.#backend.eventsAfter(id, sequence) as Promise<DispositionEvent[]>;
  }

  close(): Promise<void> {
    return this.#backend.close();
  }
}

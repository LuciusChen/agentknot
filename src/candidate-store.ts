import {
  SqliteDurableRecordStore,
  type OpenDurableStoreOptions,
} from './durable-record-store.js';
import type { CandidateEvent, CandidateRecord, CandidateStore } from './candidate.js';

/**
 * Transactional immutable Candidate store. Candidate creation is validated by CandidateService;
 * this store owns only the atomic snapshot/event write and read cursors.
 */
export class SqliteCandidateStore implements CandidateStore {
  readonly #backend: SqliteDurableRecordStore<CandidateRecord>;

  private constructor(backend: SqliteDurableRecordStore<CandidateRecord>) {
    this.#backend = backend;
  }

  static async open(
    directory: string,
    options: OpenDurableStoreOptions = {}
  ): Promise<SqliteCandidateStore> {
    return new SqliteCandidateStore(
      await SqliteDurableRecordStore.open<CandidateRecord>('Candidate', directory, options)
    );
  }

  get directory(): string {
    return this.#backend.directory;
  }

  create(record: CandidateRecord): Promise<void> {
    return this.#backend.create(record);
  }

  get(id: string): Promise<CandidateRecord | undefined> {
    return this.#backend.get(id);
  }

  list(): Promise<CandidateRecord[]> {
    return this.#backend.list();
  }

  eventsAfter(id: string, sequence: number): Promise<CandidateEvent[]> {
    return this.#backend.eventsAfter(id, sequence) as Promise<CandidateEvent[]>;
  }

  close(): Promise<void> {
    return this.#backend.close();
  }
}

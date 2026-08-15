import {
  SqliteDurableRecordStore,
  type OpenDurableStoreOptions,
} from './durable-record-store.js';
import type { ReviewEvent, ReviewRecord, ReviewStore } from './review.js';

/**
 * Transactional immutable Review store. Review creation validates Candidate existence through
 * ReviewService; this store owns only the atomic snapshot/event write and read cursors.
 */
export class SqliteReviewStore implements ReviewStore {
  readonly #backend: SqliteDurableRecordStore<ReviewRecord>;

  private constructor(backend: SqliteDurableRecordStore<ReviewRecord>) {
    this.#backend = backend;
  }

  static async open(
    directory: string,
    options: OpenDurableStoreOptions = {}
  ): Promise<SqliteReviewStore> {
    return new SqliteReviewStore(
      await SqliteDurableRecordStore.open<ReviewRecord>('Review', directory, options)
    );
  }

  get directory(): string {
    return this.#backend.directory;
  }

  create(record: ReviewRecord): Promise<void> {
    return this.#backend.create(record);
  }

  get(id: string): Promise<ReviewRecord | undefined> {
    return this.#backend.get(id);
  }

  list(): Promise<ReviewRecord[]> {
    return this.#backend.list();
  }

  eventsAfter(id: string, sequence: number): Promise<ReviewEvent[]> {
    return this.#backend.eventsAfter(id, sequence) as Promise<ReviewEvent[]>;
  }

  close(): Promise<void> {
    return this.#backend.close();
  }
}

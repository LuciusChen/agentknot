import {
  RecordBindingConflictError,
  SqliteDurableRecordStore,
  type OpenDurableStoreOptions,
} from './durable-record-store.js';
import {
  WorkOrderBindingConflictError,
  type WorkOrderRecord,
  type WorkOrderStore,
} from './work-order.js';

/**
 * Transactional WorkOrder store. Composition intentionally exposes creation and reads only:
 * WorkOrder commands cannot be changed through the execution store's generic save operation.
 */
export class SqliteWorkOrderStore implements WorkOrderStore {
  readonly #backend: SqliteDurableRecordStore<WorkOrderRecord>;

  private constructor(backend: SqliteDurableRecordStore<WorkOrderRecord>) {
    this.#backend = backend;
  }

  static async open(
    directory: string,
    options: OpenDurableStoreOptions = {}
  ): Promise<SqliteWorkOrderStore> {
    return new SqliteWorkOrderStore(
      await SqliteDurableRecordStore.open<WorkOrderRecord>('WorkOrder', directory, options)
    );
  }

  get directory(): string {
    return this.#backend.directory;
  }

  create(record: WorkOrderRecord): Promise<void> {
    return this.#backend.create(record);
  }

  get(id: string): Promise<WorkOrderRecord | undefined> {
    return this.#backend.get(id);
  }

  list(): Promise<WorkOrderRecord[]> {
    return this.#backend.list();
  }

  eventsAfter(id: string, sequence: number): Promise<WorkOrderRecord['events']> {
    return this.#backend.eventsAfter(id, sequence) as Promise<WorkOrderRecord['events']>;
  }

  async bindExecutorJob(
    workOrderId: string,
    expectedWorkOrderRevision: number,
    executorJobId: string,
    at: string
  ): Promise<WorkOrderRecord> {
    try {
      return await this.#backend.bindWorkOrderExecutorJob(
        workOrderId,
        expectedWorkOrderRevision,
        executorJobId,
        at
      );
    } catch (error) {
      if (error instanceof RecordBindingConflictError) {
        throw new WorkOrderBindingConflictError(error.message, { cause: error });
      }
      throw error;
    }
  }

  close(): Promise<void> {
    return this.#backend.close();
  }
}

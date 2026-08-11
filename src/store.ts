import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { serializeBoundedRecord } from './record-limits.js';
import { materializePersistedRecord } from './record-version.js';
import {
  SqliteDurableRecordStore,
  SqliteDurableStoreAdapter,
  IdempotencyConflictError,
  type IdempotentCreateResult,
  type OpenDurableStoreOptions,
} from './durable-record-store.js';
import type { JobRecord, JobStore } from './types.js';

interface StoredRecord {
  id: string;
  schemaVersion: 1;
  createdAt: string;
}

/** @internal Shared persistence engine behind the four public record-store wrappers. */
export default class RecordStoreBackend<T extends StoredRecord> {
  readonly #kind: 'Job' | 'Orchestration';
  readonly #directory: string | undefined;
  readonly #records?: Map<string, T>;

  constructor(kind: 'Job' | 'Orchestration', directory?: string) {
    this.#kind = kind;
    this.#directory = directory;
    if (this.#directory === undefined) this.#records = new Map();
  }

  async create(record: T): Promise<void> {
    if (this.#records) {
      if (this.#records.has(record.id)) throw new Error(`${this.#kind} ${record.id} already exists`);
      serializeBoundedRecord(this.#kind, record);
      this.#records.set(record.id, structuredClone(record));
      return;
    }

    await mkdir(this.#directory!, { recursive: true });
    if (await this.get(record.id)) throw new Error(`${this.#kind} ${record.id} already exists`);
    await this.#write(record);
  }

  async save(record: T): Promise<void> {
    if (this.#records) {
      if (!this.#records.has(record.id)) throw new Error(`${this.#kind} ${record.id} does not exist`);
      serializeBoundedRecord(this.#kind, record);
      this.#records.set(record.id, structuredClone(record));
      return;
    }

    await mkdir(this.#directory!, { recursive: true });
    await this.#write(record);
  }

  async get(id: string): Promise<T | undefined> {
    if (this.#records) {
      const record = this.#records.get(id);
      return record ? structuredClone(record) : undefined;
    }

    try {
      const raw: unknown = JSON.parse(await readFile(this.#path(id), 'utf8'));
      return materializePersistedRecord<T>(this.#kind, raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(): Promise<T[]> {
    if (this.#records) {
      return [...this.#records.values()]
        .map((record) => structuredClone(record))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }

    try {
      const names = (await readdir(this.#directory!)).filter((name) => name.endsWith('.json'));
      const records = (await Promise.all(
        names.map((name) => this.get(name.slice(0, -5)))
      )) as Array<T | undefined>;
      return records
        .filter((record): record is T => record !== undefined)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  #path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid ${this.#kind.toLowerCase()} id`);
    return path.join(this.#directory!, `${id}.json`);
  }

  async #write(record: T): Promise<void> {
    const versioned = materializePersistedRecord<T>(this.#kind, record);
    const target = this.#path(versioned.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serializeBoundedRecord(this.#kind, versioned), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export class MemoryJobStore extends RecordStoreBackend<JobRecord> implements JobStore {
  readonly #idempotency = new Map<string, { requestHash: string; recordId: string }>();

  constructor() {
    super('Job');
  }

  async createIdempotent(
    scope: string,
    key: string,
    requestHash: string,
    job: JobRecord
  ): Promise<IdempotentCreateResult<JobRecord>> {
    const identity = `${scope}\u0000${key}`;
    const existing = this.#idempotency.get(identity);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) throw new IdempotencyConflictError('Idempotency key conflict');
      const record = await this.get(existing.recordId);
      if (record === undefined) throw new Error(`Idempotency key references missing Job ${existing.recordId}`);
      return { created: false, record };
    }
    this.#idempotency.set(identity, { requestHash, recordId: job.id });
    try {
      await this.create(job);
      return { created: true, record: structuredClone(job) };
    } catch (error) {
      this.#idempotency.delete(identity);
      throw error;
    }
  }
}

export class FileJobStore extends RecordStoreBackend<JobRecord> implements JobStore {
  constructor(readonly directory: string) {
    super('Job', directory);
  }
}

/** Transactional Stage 3 store; `open` imports existing JSON snapshots without deleting them. */
export class SqliteJobStore
  extends SqliteDurableStoreAdapter<JobRecord>
  implements JobStore
{
  static async open(
    directory: string,
    options: OpenDurableStoreOptions & { importLegacy?: boolean } = {}
  ): Promise<SqliteJobStore> {
    const backend = await SqliteDurableRecordStore.open<JobRecord>('Job', directory, options);
    try {
      if (options.importLegacy !== false && options.readOnly !== true) {
        await backend.importLegacySnapshots();
      }
      return new SqliteJobStore(backend);
    } catch (error) {
      await backend.close();
      throw error;
    }
  }
}

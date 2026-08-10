import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { serializeBoundedRecord } from './record-limits.js';
import { materializePersistedRecord } from './record-version.js';
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
  constructor() {
    super('Job');
  }
}

export class FileJobStore extends RecordStoreBackend<JobRecord> implements JobStore {
  constructor(readonly directory: string) {
    super('Job', directory);
  }
}

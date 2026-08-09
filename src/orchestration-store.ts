import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { materializePersistedRecord } from './record-version.js';
import type { OrchestrationRecord, OrchestrationStore } from './orchestration-types.js';

function cloneRecord(record: OrchestrationRecord): OrchestrationRecord {
  return structuredClone(record);
}

export class MemoryOrchestrationStore implements OrchestrationStore {
  readonly #records = new Map<string, OrchestrationRecord>();

  async create(record: OrchestrationRecord): Promise<void> {
    if (this.#records.has(record.id)) throw new Error(`Orchestration ${record.id} already exists`);
    this.#records.set(record.id, cloneRecord(record));
  }

  async save(record: OrchestrationRecord): Promise<void> {
    if (!this.#records.has(record.id)) throw new Error(`Orchestration ${record.id} does not exist`);
    this.#records.set(record.id, cloneRecord(record));
  }

  async get(id: string): Promise<OrchestrationRecord | undefined> {
    const record = this.#records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  async list(): Promise<OrchestrationRecord[]> {
    return [...this.#records.values()]
      .map(cloneRecord)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

export class FileOrchestrationStore implements OrchestrationStore {
  constructor(readonly directory: string) {}

  async create(record: OrchestrationRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const existing = await this.get(record.id);
    if (existing) throw new Error(`Orchestration ${record.id} already exists`);
    await this.#write(record);
  }

  async save(record: OrchestrationRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.#write(record);
  }

  async get(id: string): Promise<OrchestrationRecord | undefined> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.#path(id), 'utf8'));
      return materializePersistedRecord<OrchestrationRecord>('Orchestration', raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(): Promise<OrchestrationRecord[]> {
    try {
      const names = (await readdir(this.directory)).filter((name) => name.endsWith('.json'));
      const records = await Promise.all(names.map((name) => this.get(name.slice(0, -5))));
      return records
        .filter((record): record is OrchestrationRecord => record !== undefined)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  #path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid orchestration id');
    return path.join(this.directory, `${id}.json`);
  }

  async #write(record: OrchestrationRecord): Promise<void> {
    const versioned = materializePersistedRecord<OrchestrationRecord>('Orchestration', record);
    const target = this.#path(versioned.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(versioned, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }
}

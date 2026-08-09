import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { materializePersistedRecord } from './record-version.js';
import { serializeBoundedRecord } from './record-limits.js';
import type { JobRecord, JobStore } from './types.js';

function cloneJob(job: JobRecord): JobRecord {
  return structuredClone(job);
}

export class MemoryJobStore implements JobStore {
  readonly #jobs = new Map<string, JobRecord>();

  async create(job: JobRecord): Promise<void> {
    if (this.#jobs.has(job.id)) throw new Error(`Job ${job.id} already exists`);
    serializeBoundedRecord('Job', job);
    this.#jobs.set(job.id, cloneJob(job));
  }

  async save(job: JobRecord): Promise<void> {
    if (!this.#jobs.has(job.id)) throw new Error(`Job ${job.id} does not exist`);
    serializeBoundedRecord('Job', job);
    this.#jobs.set(job.id, cloneJob(job));
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const job = this.#jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  async list(): Promise<JobRecord[]> {
    return [...this.#jobs.values()]
      .map(cloneJob)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

export class FileJobStore implements JobStore {
  constructor(readonly directory: string) {}

  async create(job: JobRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const existing = await this.get(job.id);
    if (existing) throw new Error(`Job ${job.id} already exists`);
    await this.#write(job);
  }

  async save(job: JobRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.#write(job);
  }

  async get(id: string): Promise<JobRecord | undefined> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.#path(id), 'utf8'));
      return materializePersistedRecord<JobRecord>('Job', raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(): Promise<JobRecord[]> {
    try {
      const names = (await readdir(this.directory)).filter((name) => name.endsWith('.json'));
      const jobs = await Promise.all(names.map((name) => this.get(name.slice(0, -5))));
      return jobs
        .filter((job): job is JobRecord => job !== undefined)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  #path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid job id');
    return path.join(this.directory, `${id}.json`);
  }

  async #write(job: JobRecord): Promise<void> {
    const versioned = materializePersistedRecord<JobRecord>('Job', job);
    const target = this.#path(versioned.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serializeBoundedRecord('Job', versioned), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

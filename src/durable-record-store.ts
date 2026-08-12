import { chmod, mkdir, open as openFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { serializeBoundedRecord } from './record-limits.js';
import { materializePersistedRecord } from './record-version.js';

const DATABASE_FILENAME = 'agentknot.sqlite';
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const REVISION = Symbol('agentknot.persisted-revision');

type RecordKind = 'Job' | 'Orchestration';

interface StoredEvent {
  sequence: number;
  at: string;
  type: string;
}

export interface DurableStoredRecord {
  id: string;
  schemaVersion: 1;
  status: string;
  createdAt: string;
  updatedAt: string;
  events: StoredEvent[];
}

interface LeaseRow {
  record_id: string;
  owner_id: string;
  fence: number;
  acquired_at_ms: number;
  heartbeat_at_ms: number;
  expires_at_ms: number;
}

type RevisionedRecord = DurableStoredRecord & { [REVISION]?: number };

export interface ExecutionLease {
  recordId: string;
  ownerId: string;
  fence: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface CancellationRequest {
  recordId: string;
  requestedAt: string;
  source: string;
}

export interface ClaimLeaseOptions {
  ownerId: string;
  ttlMs: number;
  now?: Date;
}

export interface OpenDurableStoreOptions {
  readOnly?: boolean;
}

export interface DurableAdmissionOptions {
  ownerId: string;
  ttlMs: number;
  capacityLimit?: number;
  now?: Date;
  idempotency?: {
    scope: string;
    key: string;
    requestHash: string;
  };
}

export interface DurableRoutePoolChoice {
  activeBefore: Record<string, number>;
  cursorBefore: number;
  selectedRoute: string;
  selectedMemberIndex: number;
}

export interface DurableRoutePoolAdmissionOptions<T> extends DurableAdmissionOptions {
  /** Stable identity for one ordered logical pool definition. */
  cursorKey: string;
  candidates: readonly string[];
  createRecord: (choice: DurableRoutePoolChoice) => T;
}

export type DurableAdmissionResult<T> =
  | { created: true; record: T; lease: ExecutionLease }
  | { created: false; record: T };

export type CapacityAcquireStatus = 'acquired' | 'waiting';

export type IdempotentCreateResult<T> =
  | { created: true; record: T }
  | { created: false; record: T };

export class StaleRecordRevisionError extends Error {
  readonly name = 'StaleRecordRevisionError';
}

export class IdempotencyConflictError extends Error {
  readonly name = 'IdempotencyConflictError';
}

export class ExecutionLeaseLostError extends Error {
  readonly name = 'ExecutionLeaseLostError';
}

export class CancellationRequestedError extends Error {
  readonly name = 'CancellationRequestedError';

  constructor(readonly request: CancellationRequest) {
    super(
      `Cancellation of ${request.recordId} was requested by ${request.source} at ${request.requestedAt}`
    );
  }
}

function assertIdentifier(label: string, value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new Error(`${label} must contain 1 to 256 characters`);
  }
}

function assertTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) {
    throw new Error('Lease ttlMs must be an integer between 1 and 86400000');
  }
}

function assertCapacityLimit(capacityLimit: number): void {
  if (!Number.isSafeInteger(capacityLimit) || capacityLimit < 1) {
    throw new Error('Capacity limit must be a positive safe integer');
  }
}

function isoTime(value: number): string {
  return new Date(value).toISOString();
}

function attachRevision<T extends DurableStoredRecord>(record: T, revision: number): T {
  Object.defineProperty(record, REVISION, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: revision,
  });
  return record;
}

function revisionOf(record: RevisionedRecord): number | undefined {
  return record[REVISION];
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the operation failure. SQLite will also roll back on close.
    }
    throw error;
  }
}

function changes(result: ReturnType<StatementSync['run']>): number {
  return Number(result.changes);
}

/**
 * Transactional local record store used by the durable orchestration kernel.
 *
 * A materialized snapshot and its append-only event suffix are committed in one SQLite
 * transaction. The snapshot is a bounded projection; the sequenced event table is the resumable
 * delivery source. CAS revisions prevent two runtimes from silently overwriting each other.
 */
export class SqliteDurableRecordStore<T extends DurableStoredRecord> {
  readonly #kind: RecordKind;
  readonly #directory: string;
  readonly #database: DatabaseSync;
  readonly #selectRecord: StatementSync;
  readonly #selectEvents: StatementSync;
  readonly #insertRecord: StatementSync;
  readonly #updateRecord: StatementSync;
  readonly #insertEvent: StatementSync;
  readonly #selectIdempotency: StatementSync;
  readonly #insertIdempotency: StatementSync;
  readonly #selectLease: StatementSync;
  readonly #insertLease: StatementSync;
  readonly #claimExpiredLease: StatementSync;
  readonly #renewLease: StatementSync;
  readonly #releaseLease: StatementSync;
  readonly #requestCancellation: StatementSync;
  readonly #selectCancellation: StatementSync;
  #closed = false;

  private constructor(
    kind: RecordKind,
    directory: string,
    database: DatabaseSync,
    readOnly: boolean
  ) {
    this.#kind = kind;
    this.#directory = directory;
    this.#database = database;
    this.#database.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${DEFAULT_BUSY_TIMEOUT_MS};`);
    if (readOnly) {
      this.#database.exec('PRAGMA query_only=ON;');
    } else {
      this.#database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
        record_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS records_created_at ON records(created_at DESC, id);
      CREATE TABLE IF NOT EXISTS events (
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (record_id, sequence)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS execution_leases (
        record_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        fence INTEGER NOT NULL CHECK (fence > 0),
        acquired_at_ms INTEGER NOT NULL,
        heartbeat_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cancellation_requests (
        record_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
        requested_at TEXT NOT NULL,
        source TEXT NOT NULL
      ) STRICT;
      `);
      if (kind === 'Job') {
        this.#database.exec(`
          CREATE TABLE IF NOT EXISTS route_pool_cursors (
            pool_key TEXT PRIMARY KEY,
            next_index INTEGER NOT NULL CHECK (next_index >= 0)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS execution_capacity (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            record_id TEXT NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE,
            owner_id TEXT NOT NULL,
            fence INTEGER NOT NULL CHECK (fence > 0),
            acquired_at_ms INTEGER
          ) STRICT;
          CREATE INDEX IF NOT EXISTS execution_capacity_waiting
            ON execution_capacity(acquired_at_ms, sequence);
        `);
      }
    }
    this.#selectRecord = database.prepare(
      'SELECT record_json, revision, event_sequence FROM records WHERE id = ?'
    );
    this.#selectEvents = database.prepare(
      'SELECT event_json FROM events WHERE record_id = ? AND sequence > ? ORDER BY sequence'
    );
    this.#insertRecord = database.prepare(
      'INSERT INTO records (id, created_at, updated_at, revision, event_sequence, record_json) VALUES (?, ?, ?, 1, ?, ?)'
    );
    this.#updateRecord = database.prepare(
      'UPDATE records SET updated_at = ?, revision = revision + 1, event_sequence = ?, record_json = ? WHERE id = ? AND revision = ?'
    );
    this.#insertEvent = database.prepare(
      'INSERT INTO events (record_id, sequence, at, type, event_json) VALUES (?, ?, ?, ?, ?)'
    );
    this.#selectIdempotency = database.prepare(
      'SELECT request_hash, record_id FROM idempotency_keys WHERE scope = ? AND key = ?'
    );
    this.#insertIdempotency = database.prepare(
      'INSERT INTO idempotency_keys (scope, key, request_hash, record_id, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    this.#selectLease = database.prepare(
      'SELECT record_id, owner_id, fence, acquired_at_ms, heartbeat_at_ms, expires_at_ms FROM execution_leases WHERE record_id = ?'
    );
    this.#insertLease = database.prepare(
      'INSERT INTO execution_leases (record_id, owner_id, fence, acquired_at_ms, heartbeat_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this.#claimExpiredLease = database.prepare(
      'UPDATE execution_leases SET owner_id = ?, fence = fence + 1, acquired_at_ms = ?, heartbeat_at_ms = ?, expires_at_ms = ? WHERE record_id = ? AND expires_at_ms <= ?'
    );
    this.#renewLease = database.prepare(
      'UPDATE execution_leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE record_id = ? AND owner_id = ? AND fence = ? AND expires_at_ms > ?'
    );
    this.#releaseLease = database.prepare(
      "UPDATE execution_leases SET owner_id = '', acquired_at_ms = 0, heartbeat_at_ms = 0, expires_at_ms = 0 WHERE record_id = ? AND owner_id = ? AND fence = ?"
    );
    this.#requestCancellation = database.prepare(
      'INSERT INTO cancellation_requests (record_id, requested_at, source) VALUES (?, ?, ?) ON CONFLICT(record_id) DO NOTHING'
    );
    this.#selectCancellation = database.prepare(
      'SELECT record_id, requested_at, source FROM cancellation_requests WHERE record_id = ?'
    );
  }

  static async open<T extends DurableStoredRecord>(
    kind: RecordKind,
    directory: string,
    options: OpenDurableStoreOptions = {}
  ): Promise<SqliteDurableRecordStore<T>> {
    const readOnly = options.readOnly === true;
    if (!readOnly) await mkdir(directory, { recursive: true, mode: 0o700 });
    const databasePath = path.join(directory, DATABASE_FILENAME);
    if (!readOnly) {
      const file = await openFile(databasePath, 'a', 0o600);
      await file.close();
      await chmod(databasePath, 0o600);
    }
    const database = new DatabaseSync(databasePath, {
      timeout: DEFAULT_BUSY_TIMEOUT_MS,
      readOnly,
    });
    try {
      return new SqliteDurableRecordStore<T>(kind, directory, database, readOnly);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  get directory(): string {
    return this.#directory;
  }

  async create(record: T): Promise<void> {
    this.#assertOpen();
    const normalized = this.#materialize(record);
    transaction(this.#database, () => this.#insertNew(normalized));
    attachRevision(record, 1);
  }

  /** Atomically admits one record and its first fenced execution lease. */
  async admit(record: T, options: DurableAdmissionOptions): Promise<DurableAdmissionResult<T>> {
    this.#assertOpen();
    assertIdentifier('Lease ownerId', options.ownerId);
    assertTtl(options.ttlMs);
    if (options.capacityLimit !== undefined) {
      if (this.#kind !== 'Job') throw new Error('Capacity admission is available only for Jobs');
      assertCapacityLimit(options.capacityLimit);
    }
    if (options.idempotency !== undefined) {
      assertIdentifier('Idempotency scope', options.idempotency.scope);
      assertIdentifier('Idempotency key', options.idempotency.key);
      if (!/^[a-f0-9]{64}$/i.test(options.idempotency.requestHash)) {
        throw new Error('Idempotency requestHash must be a 64-character hexadecimal digest');
      }
    }
    const normalized = this.#materialize(record);
    const outcome = transaction(this.#database, () => {
      if (options.idempotency !== undefined) {
        const existing = this.#selectIdempotency.get(
          options.idempotency.scope,
          options.idempotency.key
        ) as { request_hash: string; record_id: string } | undefined;
        if (existing !== undefined) {
          if (existing.request_hash !== options.idempotency.requestHash) {
            throw new IdempotencyConflictError(
              `Idempotency key conflict for scope "${options.idempotency.scope}" and key "${options.idempotency.key}"`
            );
          }
          return { created: false as const, recordId: existing.record_id };
        }
      }

      this.#insertNew(normalized);
      if (options.idempotency !== undefined) {
        this.#insertIdempotency.run(
          options.idempotency.scope,
          options.idempotency.key,
          options.idempotency.requestHash,
          normalized.id,
          normalized.createdAt
        );
      }
      const lease = this.#claimLeaseInTransaction(normalized.id, options);
      if (lease === undefined) {
        throw new Error(`${this.#kind} ${normalized.id} could not acquire its admission lease`);
      }
      if (options.capacityLimit !== undefined) {
        this.#tryAcquireCapacityInTransaction(
          lease,
          options.capacityLimit,
          options.now ?? new Date()
        );
      }
      return { created: true as const, recordId: normalized.id, lease };
    });
    if (outcome.created) {
      attachRevision(record, 1);
      return {
        created: true,
        record: attachRevision(structuredClone(record), 1),
        lease: outcome.lease,
      };
    }
    const existing = await this.get(outcome.recordId);
    if (existing === undefined) {
      throw new Error(`Idempotency key references missing ${this.#kind.toLowerCase()} ${outcome.recordId}`);
    }
    return { created: false, record: existing };
  }

  /**
   * Atomically selects one least-active exact route and admits the resulting Job with its first
   * execution lease. The generic durable store exposes this only for Job records so routing stays
   * above worker/provider implementations while selection and admission share one transaction.
   */
  async admitRoutePool(
    options: DurableRoutePoolAdmissionOptions<T>
  ): Promise<DurableAdmissionResult<T>> {
    this.#assertOpen();
    if (this.#kind !== 'Job') throw new Error('Route-pool admission is available only for Jobs');
    assertIdentifier('Route-pool cursorKey', options.cursorKey);
    assertIdentifier('Lease ownerId', options.ownerId);
    assertTtl(options.ttlMs);
    if (options.capacityLimit !== undefined) assertCapacityLimit(options.capacityLimit);
    if (
      options.candidates.length < 2 ||
      options.candidates.length > 20 ||
      new Set(options.candidates).size !== options.candidates.length
    ) {
      throw new Error('Route-pool candidates must contain 2 to 20 unique exact route names');
    }
    for (const candidate of options.candidates) {
      assertIdentifier('Route-pool candidate', candidate);
    }
    if (options.idempotency !== undefined) {
      assertIdentifier('Idempotency scope', options.idempotency.scope);
      assertIdentifier('Idempotency key', options.idempotency.key);
      if (!/^[a-f0-9]{64}$/i.test(options.idempotency.requestHash)) {
        throw new Error('Idempotency requestHash must be a 64-character hexadecimal digest');
      }
    }

    const outcome = transaction(this.#database, () => {
      if (options.idempotency !== undefined) {
        const existing = this.#selectIdempotency.get(
          options.idempotency.scope,
          options.idempotency.key
        ) as { request_hash: string; record_id: string } | undefined;
        if (existing !== undefined) {
          if (existing.request_hash !== options.idempotency.requestHash) {
            throw new IdempotencyConflictError(
              `Idempotency key conflict for scope "${options.idempotency.scope}" and key "${options.idempotency.key}"`
            );
          }
          return { created: false as const, recordId: existing.record_id };
        }
      }

      const nowMs = (options.now ?? new Date()).getTime();
      const activeBefore = Object.fromEntries(
        options.candidates.map((candidate) => [candidate, 0])
      );
      const placeholders = options.candidates.map(() => '?').join(', ');
      const rows = this.#database
        .prepare(
          `SELECT json_extract(records.record_json, '$.route.name') AS route_name, COUNT(*) AS active_count
           FROM execution_leases
           JOIN records ON records.id = execution_leases.record_id
           WHERE execution_leases.expires_at_ms > ?
             AND json_extract(records.record_json, '$.route.name') IN (${placeholders})
           GROUP BY route_name`
        )
        .all(nowMs, ...options.candidates) as Array<{ route_name: string; active_count: number }>;
      for (const row of rows) {
        if (Object.hasOwn(activeBefore, row.route_name)) {
          activeBefore[row.route_name] = Number(row.active_count);
        }
      }

      const cursorRow = this.#database
        .prepare('SELECT next_index FROM route_pool_cursors WHERE pool_key = ?')
        .get(options.cursorKey) as { next_index: number } | undefined;
      const cursorBefore = (cursorRow?.next_index ?? 0) % options.candidates.length;
      const minimum = Math.min(...Object.values(activeBefore));
      let selectedMemberIndex = -1;
      for (let offset = 0; offset < options.candidates.length; offset += 1) {
        const index = (cursorBefore + offset) % options.candidates.length;
        if (activeBefore[options.candidates[index]!] === minimum) {
          selectedMemberIndex = index;
          break;
        }
      }
      if (selectedMemberIndex < 0) throw new Error('Route pool has no selectable member');
      const selectedRoute = options.candidates[selectedMemberIndex]!;
      const record = options.createRecord({
        activeBefore,
        cursorBefore,
        selectedRoute,
        selectedMemberIndex,
      });
      const normalized = this.#materialize(record);
      const routeName = (normalized as DurableStoredRecord & { route?: { name?: unknown } }).route
        ?.name;
      if (routeName !== selectedRoute) {
        throw new Error('Route-pool record route does not match the atomically selected member');
      }

      this.#insertNew(normalized);
      if (options.idempotency !== undefined) {
        this.#insertIdempotency.run(
          options.idempotency.scope,
          options.idempotency.key,
          options.idempotency.requestHash,
          normalized.id,
          normalized.createdAt
        );
      }
      const lease = this.#claimLeaseInTransaction(normalized.id, options);
      if (lease === undefined) {
        throw new Error(`${this.#kind} ${normalized.id} could not acquire its admission lease`);
      }
      if (options.capacityLimit !== undefined) {
        this.#tryAcquireCapacityInTransaction(
          lease,
          options.capacityLimit,
          options.now ?? new Date()
        );
      }
      this.#database
        .prepare(
          `INSERT INTO route_pool_cursors (pool_key, next_index) VALUES (?, ?)
           ON CONFLICT(pool_key) DO UPDATE SET next_index = excluded.next_index`
        )
        .run(options.cursorKey, (selectedMemberIndex + 1) % options.candidates.length);
      return { created: true as const, record, lease };
    });

    if (outcome.created) {
      attachRevision(outcome.record, 1);
      return { created: true, record: outcome.record, lease: outcome.lease };
    }
    const existing = await this.get(outcome.recordId);
    if (existing === undefined) {
      throw new Error(`Idempotency key references missing ${this.#kind.toLowerCase()} ${outcome.recordId}`);
    }
    return { created: false, record: existing };
  }

  async findIdempotent(scope: string, key: string): Promise<T | undefined> {
    this.#assertOpen();
    assertIdentifier('Idempotency scope', scope);
    assertIdentifier('Idempotency key', key);
    const existing = this.#selectIdempotency.get(scope, key) as
      | { request_hash: string; record_id: string }
      | undefined;
    if (existing === undefined) return undefined;
    const record = await this.get(existing.record_id);
    if (record === undefined) {
      throw new Error(
        `Idempotency key references missing ${this.#kind.toLowerCase()} ${existing.record_id}`
      );
    }
    return record;
  }

  async save(record: T, lease?: ExecutionLease, now = new Date()): Promise<void> {
    this.#assertOpen();
    const expectedRevision = revisionOf(record);
    if (expectedRevision === undefined) {
      throw new StaleRecordRevisionError(
        `${this.#kind} ${record.id} has no persisted revision; reload it before saving`
      );
    }
    const normalized = this.#materialize(record);
    transaction(this.#database, () => {
      const current = this.#row(normalized.id);
      if (current === undefined) throw new Error(`${this.#kind} ${normalized.id} does not exist`);
      if (current.revision !== expectedRevision) {
        throw new StaleRecordRevisionError(
          `${this.#kind} ${normalized.id} revision ${expectedRevision} is stale; current revision is ${current.revision}`
        );
      }
      if (lease !== undefined) {
        const currentLease = this.#leaseRow(normalized.id);
        if (
          currentLease === undefined ||
          currentLease.owner_id !== lease.ownerId ||
          currentLease.fence !== lease.fence ||
          currentLease.expires_at_ms <= now.getTime()
        ) {
          throw new ExecutionLeaseLostError(
            `${this.#kind} ${normalized.id} execution lease ${lease.fence} is no longer current`
          );
        }
      }
      const cancellation = this.#cancellation(normalized.id);
      if (normalized.status === 'succeeded' && cancellation !== undefined) {
        throw new CancellationRequestedError(cancellation);
      }
      const previous = this.#parse(
        current.record_json,
        current.revision,
        current.event_sequence
      );
      this.#assertAppendOnly(previous.events, normalized.events, normalized.id);
      for (const event of normalized.events.slice(previous.events.length)) {
        this.#insertEvent.run(
          normalized.id,
          event.sequence,
          event.at,
          event.type,
          JSON.stringify(event)
        );
      }
      const result = this.#updateRecord.run(
        normalized.updatedAt,
        normalized.events.length,
        serializeBoundedRecord(this.#kind, normalized),
        normalized.id,
        expectedRevision
      );
      if (changes(result) !== 1) {
        throw new StaleRecordRevisionError(`${this.#kind} ${normalized.id} changed while saving`);
      }
    });
    attachRevision(record, expectedRevision + 1);
  }

  async get(id: string): Promise<T | undefined> {
    this.#assertOpen();
    const row = this.#row(id);
    return row === undefined
      ? undefined
      : this.#parse(row.record_json, row.revision, row.event_sequence);
  }

  async list(): Promise<T[]> {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        'SELECT record_json, revision, event_sequence FROM records ORDER BY created_at DESC, id'
      )
      .all() as Array<{ record_json: string; revision: number; event_sequence: number }>;
    return rows.map((row) =>
      this.#parse(row.record_json, row.revision, row.event_sequence)
    );
  }

  /** Imports legacy per-record JSON snapshots without rewriting or deleting the source files. */
  async importLegacySnapshots(): Promise<number> {
    this.#assertOpen();
    const names = (await readdir(this.#directory)).filter((name) => name.endsWith('.json')).sort();
    let imported = 0;
    for (const name of names) {
      const id = name.slice(0, -5);
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue;
      if (await this.get(id)) continue;
      const raw: unknown = JSON.parse(await readFile(path.join(this.#directory, name), 'utf8'));
      const record = materializePersistedRecord<T>(this.#kind, raw);
      if (record.id !== id) {
        throw new Error(
          `Legacy ${this.#kind.toLowerCase()} filename identity ${id} does not match record id ${record.id}`
        );
      }
      try {
        await this.create(record);
        imported += 1;
      } catch (error) {
        // A concurrent importer may have admitted the same immutable legacy identity first.
        if (!(await this.get(id))) throw error;
      }
    }
    return imported;
  }

  async eventsAfter(id: string, sequence: number): Promise<StoredEvent[]> {
    this.#assertOpen();
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('Event cursor sequence must be a non-negative integer');
    }
    return (this.#selectEvents.all(id, sequence) as Array<{ event_json: string }>).map(
      (row) => JSON.parse(row.event_json) as StoredEvent
    );
  }

  async claimLease(recordId: string, options: ClaimLeaseOptions): Promise<ExecutionLease | undefined> {
    this.#assertOpen();
    assertIdentifier('Lease ownerId', options.ownerId);
    assertTtl(options.ttlMs);
    return transaction(this.#database, () => {
      if (this.#row(recordId) === undefined) {
        throw new Error(`${this.#kind} ${recordId} does not exist`);
      }
      return this.#claimLeaseInTransaction(recordId, options);
    });
  }

  async renewLease(lease: ExecutionLease, ttlMs: number, now = new Date()): Promise<boolean> {
    this.#assertOpen();
    assertTtl(ttlMs);
    const nowMs = now.getTime();
    return (
      changes(
        this.#renewLease.run(
          nowMs,
          nowMs + ttlMs,
          lease.recordId,
          lease.ownerId,
          lease.fence,
          nowMs
        )
      ) === 1
    );
  }

  async releaseLease(lease: ExecutionLease): Promise<boolean> {
    this.#assertOpen();
    return changes(this.#releaseLease.run(lease.recordId, lease.ownerId, lease.fence)) === 1;
  }

  async tryAcquireCapacity(
    lease: ExecutionLease,
    capacityLimit: number,
    now = new Date()
  ): Promise<CapacityAcquireStatus> {
    this.#assertOpen();
    if (this.#kind !== 'Job') throw new Error('Capacity admission is available only for Jobs');
    assertCapacityLimit(capacityLimit);
    return transaction(this.#database, () =>
      this.#tryAcquireCapacityInTransaction(lease, capacityLimit, now)
    );
  }

  async releaseCapacity(lease: ExecutionLease): Promise<boolean> {
    this.#assertOpen();
    if (this.#kind !== 'Job') throw new Error('Capacity admission is available only for Jobs');
    return (
      changes(
        this.#database
          .prepare(
            'DELETE FROM execution_capacity WHERE record_id = ? AND owner_id = ? AND fence = ?'
          )
          .run(lease.recordId, lease.ownerId, lease.fence)
      ) === 1
    );
  }

  async getLease(recordId: string): Promise<ExecutionLease | undefined> {
    this.#assertOpen();
    return this.#lease(recordId);
  }

  async requestCancellation(
    recordId: string,
    source: string,
    now = new Date()
  ): Promise<CancellationRequest | undefined> {
    this.#assertOpen();
    assertIdentifier('Cancellation source', source);
    const requestedAt = now.toISOString();
    const accepted = transaction(this.#database, () => {
      const row = this.#row(recordId);
      if (row === undefined) {
        throw new Error(`${this.#kind} ${recordId} does not exist`);
      }
      const status = (JSON.parse(row.record_json) as { status?: unknown }).status;
      if (status === 'succeeded' || status === 'failed' || status === 'cancelled') return false;
      this.#requestCancellation.run(recordId, requestedAt, source);
      return true;
    });
    return accepted ? this.getCancellation(recordId) : undefined;
  }

  async getCancellation(recordId: string): Promise<CancellationRequest | undefined> {
    this.#assertOpen();
    return this.#cancellation(recordId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`${this.#kind} durable store is closed`);
  }

  #materialize(record: T): T {
    const materialized = materializePersistedRecord<T>(this.#kind, record);
    this.#assertEvents(materialized);
    serializeBoundedRecord(this.#kind, materialized);
    return materialized;
  }

  #assertEvents(record: T): void {
    if (!Array.isArray(record.events)) throw new Error(`${this.#kind} events must be an array`);
    for (let index = 0; index < record.events.length; index += 1) {
      const event = record.events[index]!;
      if (event.sequence !== index + 1 || typeof event.at !== 'string' || typeof event.type !== 'string') {
        throw new Error(`${this.#kind} ${record.id} has an invalid event at sequence ${index + 1}`);
      }
    }
  }

  #assertAppendOnly(previous: StoredEvent[], next: StoredEvent[], id: string): void {
    if (next.length < previous.length) {
      throw new Error(`${this.#kind} ${id} cannot remove persisted events`);
    }
    for (let index = 0; index < previous.length; index += 1) {
      if (JSON.stringify(previous[index]) !== JSON.stringify(next[index])) {
        throw new Error(`${this.#kind} ${id} cannot rewrite persisted event ${index + 1}`);
      }
    }
  }

  #insertNew(record: T): void {
    const serialized = serializeBoundedRecord(this.#kind, record);
    this.#insertRecord.run(
      record.id,
      record.createdAt,
      record.updatedAt,
      record.events.length,
      serialized
    );
    for (const event of record.events) {
      this.#insertEvent.run(record.id, event.sequence, event.at, event.type, JSON.stringify(event));
    }
  }

  #row(id: string):
    | { record_json: string; revision: number; event_sequence: number }
    | undefined {
    return this.#selectRecord.get(id) as
      | { record_json: string; revision: number; event_sequence: number }
      | undefined;
  }

  #parse(serialized: string, revision: number, eventSequence: number): T {
    const raw: unknown = JSON.parse(serialized);
    const record = materializePersistedRecord<T>(this.#kind, raw);
    this.#assertEvents(record);
    if (record.events.length !== eventSequence) {
      throw new Error(
        `${this.#kind} ${record.id} projection event sequence ${eventSequence} does not match its ${record.events.length} events`
      );
    }
    return attachRevision(record, revision);
  }

  #leaseRow(recordId: string): LeaseRow | undefined {
    return this.#selectLease.get(recordId) as LeaseRow | undefined;
  }

  #lease(recordId: string): ExecutionLease | undefined {
    const row = this.#leaseRow(recordId);
    return row === undefined || row.owner_id === ''
      ? undefined
      : {
          recordId: row.record_id,
          ownerId: row.owner_id,
          fence: row.fence,
          acquiredAt: isoTime(row.acquired_at_ms),
          heartbeatAt: isoTime(row.heartbeat_at_ms),
          expiresAt: isoTime(row.expires_at_ms),
        };
  }

  #claimLeaseInTransaction(
    recordId: string,
    options: ClaimLeaseOptions
  ): ExecutionLease | undefined {
    const nowMs = (options.now ?? new Date()).getTime();
    const expiresAtMs = nowMs + options.ttlMs;
    const existing = this.#leaseRow(recordId);
    if (existing === undefined) {
      this.#insertLease.run(recordId, options.ownerId, 1, nowMs, nowMs, expiresAtMs);
      const inserted = this.#lease(recordId);
      if (inserted === undefined) {
        throw new Error(`${this.#kind} ${recordId} lease insert was not observable`);
      }
      return inserted;
    }
    if (existing.owner_id === options.ownerId && existing.expires_at_ms > nowMs) {
      const renewed = this.#renewLease.run(
        nowMs,
        expiresAtMs,
        recordId,
        options.ownerId,
        existing.fence,
        nowMs
      );
      return changes(renewed) === 1 ? this.#lease(recordId) : undefined;
    }
    if (existing.expires_at_ms > nowMs) return undefined;
    const claimed = this.#claimExpiredLease.run(
      options.ownerId,
      nowMs,
      nowMs,
      expiresAtMs,
      recordId,
      nowMs
    );
    if (changes(claimed) !== 1) return undefined;
    const lease = this.#lease(recordId);
    if (lease === undefined) {
      throw new Error(`${this.#kind} ${recordId} reclaimed lease was not observable`);
    }
    if (this.#kind === 'Job') {
      this.#database
        .prepare(
          `UPDATE execution_capacity
           SET owner_id = ?, fence = ?
           WHERE record_id = ? AND owner_id = ? AND fence = ?`
        )
        .run(lease.ownerId, lease.fence, recordId, existing.owner_id, existing.fence);
    }
    return lease;
  }

  #tryAcquireCapacityInTransaction(
    lease: ExecutionLease,
    capacityLimit: number,
    now: Date
  ): CapacityAcquireStatus {
    const nowMs = now.getTime();
    const currentLease = this.#leaseRow(lease.recordId);
    if (
      currentLease === undefined ||
      currentLease.owner_id !== lease.ownerId ||
      currentLease.fence !== lease.fence ||
      currentLease.expires_at_ms <= nowMs
    ) {
      throw new ExecutionLeaseLostError(
        `${this.#kind} ${lease.recordId} execution lease ${lease.fence} is no longer current`
      );
    }

    this.#database
      .prepare(
        `INSERT INTO execution_capacity (record_id, owner_id, fence, acquired_at_ms)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(record_id) DO UPDATE SET
           owner_id = excluded.owner_id,
           fence = excluded.fence`
      )
      .run(lease.recordId, lease.ownerId, lease.fence);
    this.#database
      .prepare(
        `DELETE FROM execution_capacity
         WHERE NOT EXISTS (
           SELECT 1 FROM execution_leases
           WHERE execution_leases.record_id = execution_capacity.record_id
             AND execution_leases.owner_id = execution_capacity.owner_id
             AND execution_leases.fence = execution_capacity.fence
             AND execution_leases.expires_at_ms > ?
         )`
      )
      .run(nowMs);

    const current = this.#database
      .prepare('SELECT acquired_at_ms FROM execution_capacity WHERE record_id = ?')
      .get(lease.recordId) as { acquired_at_ms: number | null } | undefined;
    if (current?.acquired_at_ms !== null && current?.acquired_at_ms !== undefined) {
      return 'acquired';
    }
    const active = this.#database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM execution_capacity
         JOIN execution_leases ON execution_leases.record_id = execution_capacity.record_id
         WHERE execution_capacity.acquired_at_ms IS NOT NULL
           AND execution_leases.owner_id = execution_capacity.owner_id
           AND execution_leases.fence = execution_capacity.fence
           AND execution_leases.expires_at_ms > ?`
      )
      .get(nowMs) as { count: number };
    const next = this.#database
      .prepare(
        `SELECT execution_capacity.record_id
         FROM execution_capacity
         JOIN execution_leases ON execution_leases.record_id = execution_capacity.record_id
         WHERE execution_capacity.acquired_at_ms IS NULL
           AND execution_leases.owner_id = execution_capacity.owner_id
           AND execution_leases.fence = execution_capacity.fence
           AND execution_leases.expires_at_ms > ?
         ORDER BY execution_capacity.sequence
         LIMIT 1`
      )
      .get(nowMs) as { record_id: string } | undefined;
    if (Number(active.count) >= capacityLimit || next?.record_id !== lease.recordId) {
      return 'waiting';
    }
    const acquired = this.#database
      .prepare(
        `UPDATE execution_capacity
         SET acquired_at_ms = ?
         WHERE record_id = ? AND owner_id = ? AND fence = ? AND acquired_at_ms IS NULL`
      )
      .run(nowMs, lease.recordId, lease.ownerId, lease.fence);
    if (changes(acquired) !== 1) {
      throw new ExecutionLeaseLostError(
        `${this.#kind} ${lease.recordId} capacity fence ${lease.fence} is no longer current`
      );
    }
    return 'acquired';
  }

  #cancellation(recordId: string): CancellationRequest | undefined {
    const row = this.#selectCancellation.get(recordId) as
      | { record_id: string; requested_at: string; source: string }
      | undefined;
    return row === undefined
      ? undefined
      : { recordId: row.record_id, requestedAt: row.requested_at, source: row.source };
  }
}

/** Thin typed facade shared by the public Job and Orchestration SQLite stores. */
export class SqliteDurableStoreAdapter<T extends DurableStoredRecord> {
  constructor(readonly backend: SqliteDurableRecordStore<T>) {}

  get directory(): string {
    return this.backend.directory;
  }

  create(record: T): Promise<void> {
    return this.backend.create(record);
  }

  admit(record: T, options: DurableAdmissionOptions): Promise<DurableAdmissionResult<T>> {
    return this.backend.admit(record, options);
  }

  save(record: T, lease?: ExecutionLease, now?: Date): Promise<void> {
    return this.backend.save(record, lease, now);
  }

  get(id: string): Promise<T | undefined> {
    return this.backend.get(id);
  }

  list(): Promise<T[]> {
    return this.backend.list();
  }

  findIdempotent(scope: string, key: string): Promise<T | undefined> {
    return this.backend.findIdempotent(scope, key);
  }

  eventsAfter(id: string, sequence: number): Promise<T['events']> {
    return this.backend.eventsAfter(id, sequence) as Promise<T['events']>;
  }

  claimLease(recordId: string, options: ClaimLeaseOptions): Promise<ExecutionLease | undefined> {
    return this.backend.claimLease(recordId, options);
  }

  renewLease(lease: ExecutionLease, ttlMs: number, now?: Date): Promise<boolean> {
    return this.backend.renewLease(lease, ttlMs, now);
  }

  releaseLease(lease: ExecutionLease): Promise<boolean> {
    return this.backend.releaseLease(lease);
  }

  tryAcquireCapacity(
    lease: ExecutionLease,
    capacityLimit: number,
    now?: Date
  ): Promise<CapacityAcquireStatus> {
    return this.backend.tryAcquireCapacity(lease, capacityLimit, now);
  }

  releaseCapacity(lease: ExecutionLease): Promise<boolean> {
    return this.backend.releaseCapacity(lease);
  }

  getLease(recordId: string): Promise<ExecutionLease | undefined> {
    return this.backend.getLease(recordId);
  }

  requestCancellation(
    recordId: string,
    source: string,
    now?: Date
  ): Promise<CancellationRequest | undefined> {
    return this.backend.requestCancellation(recordId, source, now);
  }

  getCancellation(recordId: string): Promise<CancellationRequest | undefined> {
    return this.backend.getCancellation(recordId);
  }

  close(): Promise<void> {
    return this.backend.close();
  }
}

export function durableStorePath(directory: string): string {
  return path.join(directory, DATABASE_FILENAME);
}

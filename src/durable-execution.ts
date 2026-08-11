import type {
  CancellationRequest,
  DurableAdmissionOptions,
  DurableAdmissionResult,
  DurableStoredRecord,
  ExecutionLease,
} from './durable-record-store.js';

interface RecordStore<T> {
  save(record: T): Promise<void>;
}

interface DurableExecutionStore<T> extends RecordStore<T> {
  admit(record: T, options: DurableAdmissionOptions): Promise<DurableAdmissionResult<T>>;
  save(record: T, lease?: ExecutionLease, now?: Date): Promise<void>;
  claimLease(
    recordId: string,
    options: { ownerId: string; ttlMs: number; now?: Date }
  ): Promise<ExecutionLease | undefined>;
  getLease(recordId: string): Promise<ExecutionLease | undefined>;
  renewLease(lease: ExecutionLease, ttlMs: number, now?: Date): Promise<boolean>;
  releaseLease(lease: ExecutionLease): Promise<boolean>;
  requestCancellation(
    recordId: string,
    source: string,
    now?: Date
  ): Promise<CancellationRequest | undefined>;
  getCancellation(recordId: string): Promise<CancellationRequest | undefined>;
}

export interface DurableExecutionOptions {
  leaseTtlMs?: number;
  leaseHeartbeatMs?: number;
  now: () => Date;
}

function durableStore<T>(store: RecordStore<T>): DurableExecutionStore<T> | undefined {
  return 'admit' in store &&
    'claimLease' in store &&
    'getCancellation' in store &&
    'getLease' in store &&
    'renewLease' in store &&
    'releaseLease' in store &&
    'requestCancellation' in store
    ? (store as DurableExecutionStore<T>)
    : undefined;
}

/** Owns the shared fenced-lease and durable-cancellation lifecycle for one kernel record kind. */
export class DurableExecutionCoordinator<T extends DurableStoredRecord> {
  readonly #store: RecordStore<T>;
  readonly #durable: DurableExecutionStore<T> | undefined;
  readonly #leases = new Map<string, ExecutionLease>();
  readonly #leaseTtlMs: number;
  readonly #leaseHeartbeatMs: number;
  readonly #now: () => Date;

  constructor(store: RecordStore<T>, options: DurableExecutionOptions) {
    this.#store = store;
    this.#durable = durableStore(store);
    this.#leaseTtlMs = options.leaseTtlMs ?? 15_000;
    this.#leaseHeartbeatMs = options.leaseHeartbeatMs ?? 2_000;
    this.#now = options.now;
    if (
      !Number.isSafeInteger(this.#leaseTtlMs) ||
      !Number.isSafeInteger(this.#leaseHeartbeatMs) ||
      this.#leaseHeartbeatMs < 1 ||
      this.#leaseTtlMs <= this.#leaseHeartbeatMs * 2
    ) {
      throw new Error('leaseTtlMs must be more than twice a positive integer leaseHeartbeatMs');
    }
  }

  get enabled(): boolean {
    return this.#durable !== undefined;
  }

  async admit(
    record: T,
    options: Omit<DurableAdmissionOptions, 'ttlMs' | 'now'>
  ): Promise<DurableAdmissionResult<T> | undefined> {
    const result = await this.#durable?.admit(record, {
      ...options,
      ttlMs: this.#leaseTtlMs,
      now: this.#now(),
    });
    if (result?.created) this.#leases.set(record.id, result.lease);
    return result;
  }

  save(record: T): Promise<void> {
    return this.#durable === undefined
      ? this.#store.save(record)
      : this.#durable.save(record, this.#leases.get(record.id), this.#now());
  }

  /** Claims one existing record only after its prior fence is absent or expired. */
  async claim(recordId: string, ownerId: string): Promise<ExecutionLease | undefined> {
    if (this.#durable === undefined) return undefined;
    const lease = await this.#durable.claimLease(recordId, {
      ownerId,
      ttlMs: this.#leaseTtlMs,
      now: this.#now(),
    });
    if (lease !== undefined) this.#leases.set(recordId, lease);
    return lease;
  }

  getLease(recordId: string): Promise<ExecutionLease | undefined> {
    return this.#durable === undefined
      ? Promise.resolve(undefined)
      : this.#durable.getLease(recordId);
  }

  getCancellation(recordId: string): Promise<CancellationRequest | undefined> {
    return this.#durable === undefined
      ? Promise.resolve(undefined)
      : this.#durable.getCancellation(recordId);
  }

  requestCancellation(
    recordId: string,
    source: string,
    now = this.#now()
  ): Promise<CancellationRequest | undefined> {
    return this.#durable === undefined
      ? Promise.resolve(undefined)
      : this.#durable.requestCancellation(recordId, source, now);
  }

  monitor(
    recordId: string,
    controller: AbortController,
    onCancellation?: (request: CancellationRequest) => Promise<void>
  ): () => Promise<void> {
    const durable = this.#durable;
    if (durable === undefined) return async () => undefined;
    let stopped = false;
    let inFlight = Promise.resolve();
    const tick = () => {
      inFlight = inFlight
        .then(async () => {
          if (stopped) return;
          const lease = this.#leases.get(recordId);
          if (lease === undefined) return;
          const cancellation = await durable.getCancellation(recordId);
          if (cancellation !== undefined) {
            if (onCancellation === undefined) {
              controller.abort(new Error('Execution cancelled by durable controller request'));
            } else {
              await onCancellation(cancellation);
            }
          }
          if (!(await durable.renewLease(lease, this.#leaseTtlMs, this.#now()))) {
            controller.abort(new Error(`Execution lease ${lease.fence} was lost`));
          }
        })
        .catch((error: unknown) => controller.abort(error));
    };
    const timer = setInterval(tick, this.#leaseHeartbeatMs);
    return async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    };
  }

  async release(recordId: string): Promise<void> {
    const lease = this.#leases.get(recordId);
    try {
      if (lease !== undefined) await this.#durable?.releaseLease(lease);
    } finally {
      this.#leases.delete(recordId);
    }
  }
}

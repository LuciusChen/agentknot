import type {
  CapacityAcquireStatus,
  CancellationRequest,
  DurableAdmissionOptions,
  DurableAdmissionResult,
  DurableRoutePoolAdmissionOptions,
  DurableStoredRecord,
  ExecutionLease,
} from './durable-record-store.js';
import { Semaphore } from './semaphore.js';

interface RecordStore<T> {
  save(record: T): Promise<void>;
}

interface DurableExecutionStore<T> extends RecordStore<T> {
  admit(record: T, options: DurableAdmissionOptions): Promise<DurableAdmissionResult<T>>;
  admitRoutePool?(
    options: DurableRoutePoolAdmissionOptions<T>
  ): Promise<DurableAdmissionResult<T>>;
  save(record: T, lease?: ExecutionLease, now?: Date): Promise<void>;
  claimLease(
    recordId: string,
    options: { ownerId: string; ttlMs: number; now?: Date }
  ): Promise<ExecutionLease | undefined>;
  getLease(recordId: string): Promise<ExecutionLease | undefined>;
  renewLease(lease: ExecutionLease, ttlMs: number, now?: Date): Promise<boolean>;
  releaseLease(lease: ExecutionLease): Promise<boolean>;
  tryAcquireCapacity?(
    lease: ExecutionLease,
    capacityLimit: number,
    now?: Date
  ): Promise<CapacityAcquireStatus>;
  releaseCapacity?(lease: ExecutionLease): Promise<boolean>;
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
  capacityLimit?: number;
  capacityPollMs?: number;
  now: () => Date;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled')
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  readonly #capacityLimit: number | undefined;
  readonly #capacityPollMs: number;
  readonly #durableCapacity: boolean;
  readonly #localCapacity: Semaphore | undefined;
  readonly #localCapacityReleases = new Map<string, () => void>();
  readonly #leaseTtlMs: number;
  readonly #leaseHeartbeatMs: number;
  readonly #now: () => Date;

  constructor(store: RecordStore<T>, options: DurableExecutionOptions) {
    this.#store = store;
    this.#durable = durableStore(store);
    this.#leaseTtlMs = options.leaseTtlMs ?? 15_000;
    this.#leaseHeartbeatMs = options.leaseHeartbeatMs ?? 2_000;
    this.#capacityLimit = options.capacityLimit;
    this.#capacityPollMs = options.capacityPollMs ?? 100;
    this.#now = options.now;
    if (
      !Number.isSafeInteger(this.#leaseTtlMs) ||
      !Number.isSafeInteger(this.#leaseHeartbeatMs) ||
      this.#leaseHeartbeatMs < 1 ||
      this.#leaseTtlMs <= this.#leaseHeartbeatMs * 2
    ) {
      throw new Error('leaseTtlMs must be more than twice a positive integer leaseHeartbeatMs');
    }
    if (
      this.#capacityLimit !== undefined &&
      (!Number.isSafeInteger(this.#capacityLimit) || this.#capacityLimit < 1)
    ) {
      throw new Error('capacityLimit must be a positive safe integer');
    }
    if (
      !Number.isSafeInteger(this.#capacityPollMs) ||
      this.#capacityPollMs < 1 ||
      this.#capacityPollMs > 60_000
    ) {
      throw new Error('capacityPollMs must be an integer between 1 and 60000');
    }
    this.#durableCapacity =
      this.#capacityLimit !== undefined &&
      this.#durable?.tryAcquireCapacity !== undefined &&
      this.#durable.releaseCapacity !== undefined;
    this.#localCapacity =
      this.#capacityLimit === undefined || this.#durableCapacity
        ? undefined
        : new Semaphore(this.#capacityLimit);
  }

  get enabled(): boolean {
    return this.#durable !== undefined;
  }

  get routePoolAdmissionEnabled(): boolean {
    return this.#durable?.admitRoutePool !== undefined;
  }

  async admit(
    record: T,
    options: Omit<DurableAdmissionOptions, 'ttlMs' | 'capacityLimit' | 'now'>
  ): Promise<DurableAdmissionResult<T> | undefined> {
    const result = await this.#durable?.admit(record, {
      ...options,
      ttlMs: this.#leaseTtlMs,
      ...(this.#durableCapacity ? { capacityLimit: this.#capacityLimit! } : {}),
      now: this.#now(),
    });
    if (result?.created) this.#leases.set(record.id, result.lease);
    return result;
  }

  async admitRoutePool(
    options: Omit<DurableRoutePoolAdmissionOptions<T>, 'ttlMs' | 'capacityLimit' | 'now'>
  ): Promise<DurableAdmissionResult<T> | undefined> {
    const result = await this.#durable?.admitRoutePool?.({
      ...options,
      ttlMs: this.#leaseTtlMs,
      ...(this.#durableCapacity ? { capacityLimit: this.#capacityLimit! } : {}),
      now: this.#now(),
    });
    if (result?.created) this.#leases.set(result.record.id, result.lease);
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

  async waitForCapacity(
    recordId: string,
    signal: AbortSignal,
    onWaiting?: () => Promise<void>
  ): Promise<void> {
    if (this.#capacityLimit === undefined) return;
    if (!this.#durableCapacity) {
      const localCapacity = this.#localCapacity;
      if (localCapacity === undefined) return;
      const release = await localCapacity.acquire(signal, onWaiting);
      this.#localCapacityReleases.set(recordId, release);
      return;
    }
    const lease = this.#leases.get(recordId);
    if (lease === undefined) throw new Error(`Execution lease for ${recordId} is unavailable`);
    let reportedWaiting = false;
    while (true) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled');
      }
      const status = await this.#durable!.tryAcquireCapacity!(
        lease,
        this.#capacityLimit,
        this.#now()
      );
      if (status === 'acquired') return;
      if (!reportedWaiting) {
        reportedWaiting = true;
        await onWaiting?.();
      }
      await abortableDelay(this.#capacityPollMs, signal);
    }
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
    const localRelease = this.#localCapacityReleases.get(recordId);
    let capacityError: unknown;
    try {
      try {
        localRelease?.();
        if (lease !== undefined && this.#durableCapacity) {
          await this.#durable?.releaseCapacity?.(lease);
        }
      } catch (error) {
        capacityError = error;
      }
      if (lease !== undefined) await this.#durable?.releaseLease(lease);
      if (capacityError !== undefined) throw capacityError;
    } finally {
      this.#localCapacityReleases.delete(recordId);
      this.#leases.delete(recordId);
    }
  }
}

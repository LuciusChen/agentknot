interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
  ready: boolean;
  settled: boolean;
}

/** Small abort-aware process-local semaphore used only where no durable capacity store owns slots. */
export class Semaphore {
  #available: number;
  readonly #waiters: SemaphoreWaiter[] = [];

  constructor(capacity: number) {
    this.#available = capacity;
  }

  async acquire(signal: AbortSignal, onWaiting?: () => Promise<void>): Promise<() => void> {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled');
    if (this.#available > 0) {
      this.#available -= 1;
      return this.#releaseHandle();
    }
    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve,
        reject,
        signal,
        ready: false,
        settled: false,
        onAbort: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = this.#waiters.indexOf(waiter);
          if (index !== -1) this.#waiters.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled'));
          this.#drain();
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
      void Promise.resolve()
        .then(() => onWaiting?.())
        .then(
          () => {
            if (waiter.settled) return;
            waiter.ready = true;
            this.#drain();
          },
          (error: unknown) => {
            if (waiter.settled) return;
            waiter.settled = true;
            signal.removeEventListener('abort', waiter.onAbort);
            const index = this.#waiters.indexOf(waiter);
            if (index !== -1) this.#waiters.splice(index, 1);
            reject(error);
            this.#drain();
          }
        );
    });
  }

  #drain(): void {
    while (this.#available > 0) {
      const waiter = this.#waiters[0];
      if (waiter === undefined || !waiter.ready) return;
      this.#waiters.shift();
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.#available -= 1;
      waiter.resolve(this.#releaseHandle());
    }
  }

  #releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#available += 1;
      this.#drain();
    };
  }
}

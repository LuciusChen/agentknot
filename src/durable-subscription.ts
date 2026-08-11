export interface SequencedEvent {
  sequence: number;
}

export interface EventBackedRecord<Event extends SequencedEvent> {
  id: string;
  events: Event[];
}

export interface DurableEventSource<
  Event extends SequencedEvent,
  Record extends EventBackedRecord<Event>,
> {
  get(id: string): Promise<Record | undefined>;
  eventsAfter?(id: string, sequence: number): Promise<Event[]>;
}

export interface DurableSubscriptionOptions {
  signal?: AbortSignal;
  /** Compatibility fallback for changes committed by another process. */
  refreshIntervalMs?: number;
}

interface RecordSignal {
  version: number;
  observers: number;
  waiters: Set<() => void>;
}

const DEFAULT_REFRESH_INTERVAL_MS = 100;

function validateSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('Event cursor sequence must be a non-negative integer');
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Durable subscription aborted');
}

/**
 * Generic persisted-event subscription kernel.
 *
 * Records and their events remain authoritative. Notifications are deliberately
 * process-local hints: a timeout always re-reads the source so a replacement
 * runtime or an independent writer cannot cause a permanent missed wakeup.
 */
export class DurableEventSubscription<
  Event extends SequencedEvent,
  Record extends EventBackedRecord<Event>,
> {
  readonly #signals = new Map<string, RecordSignal>();

  constructor(
    readonly source: DurableEventSource<Event, Record>,
    readonly isTerminal: (record: Record) => boolean
  ) {}

  /** Call only after the corresponding record/event commit has succeeded. */
  notifyPersisted(id: string): void {
    const state = this.#signals.get(id);
    if (state === undefined) return;
    state.version += 1;
    for (const wake of [...state.waiters]) wake();
  }

  async eventsAfter(id: string, sequence: number): Promise<Event[]> {
    validateSequence(sequence);
    const events = this.source.eventsAfter
      ? await this.source.eventsAfter(id, sequence)
      : (await this.source.get(id))?.events.filter((event) => event.sequence > sequence) ?? [];
    return events.map((event) => structuredClone(event));
  }

  async *subscribe(
    id: string,
    afterSequence = 0,
    options: DurableSubscriptionOptions = {}
  ): AsyncIterable<Event> {
    validateSequence(afterSequence);
    const retained = this.#retain(id);
    let cursor = afterSequence;
    try {
      while (true) {
        if (options.signal?.aborted) throw abortError(options.signal);
        const observedVersion = retained.version;
        const events = await this.eventsAfter(id, cursor);
        for (const event of events) {
          if (event.sequence <= cursor) continue;
          cursor = event.sequence;
          yield event;
        }

        const record = await this.source.get(id);
        if (record === undefined) return;
        const lastSequence = record.events.at(-1)?.sequence ?? 0;
        if (this.isTerminal(record) && lastSequence <= cursor) return;
        if (lastSequence > cursor) continue;

        await this.#waitForChange(id, observedVersion, options);
      }
    } finally {
      this.#release(id, retained);
    }
  }

  /** Indefinite terminal wait for transport adapters that provide their own cancellation. */
  async awaitTerminal(
    id: string,
    options: DurableSubscriptionOptions = {}
  ): Promise<Record | undefined> {
    const retained = this.#retain(id);
    try {
      while (true) {
        if (options.signal?.aborted) throw abortError(options.signal);
        const observedVersion = retained.version;
        const record = await this.source.get(id);
        if (record === undefined || this.isTerminal(record)) return record;
        await this.#waitForChange(id, observedVersion, options);
      }
    } finally {
      this.#release(id, retained);
    }
  }

  /** Bounded compatibility wait. A timeout returns the latest durable snapshot. */
  async wait(
    id: string,
    timeoutMs: number,
    options: DurableSubscriptionOptions = {}
  ): Promise<Record | undefined> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
      throw new Error('Durable wait timeout must be an integer between 0 and 60000');
    }
    const deadline = Date.now() + timeoutMs;
    const retained = this.#retain(id);
    try {
      while (true) {
        if (options.signal?.aborted) throw abortError(options.signal);
        const observedVersion = retained.version;
        const record = await this.source.get(id);
        if (record === undefined || this.isTerminal(record) || Date.now() >= deadline) return record;
        await this.#waitForChange(id, observedVersion, {
          ...options,
          refreshIntervalMs: Math.min(
            options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
            Math.max(1, deadline - Date.now())
          ),
        });
      }
    } finally {
      this.#release(id, retained);
    }
  }

  #state(id: string): RecordSignal {
    let state = this.#signals.get(id);
    if (state === undefined) {
      state = { version: 0, observers: 0, waiters: new Set() };
      this.#signals.set(id, state);
    }
    return state;
  }

  #retain(id: string): RecordSignal {
    const state = this.#state(id);
    state.observers += 1;
    return state;
  }

  #release(id: string, state: RecordSignal): void {
    state.observers -= 1;
    if (state.observers === 0 && state.waiters.size === 0 && this.#signals.get(id) === state) {
      this.#signals.delete(id);
    }
  }

  #waitForChange(
    id: string,
    observedVersion: number,
    options: DurableSubscriptionOptions
  ): Promise<void> {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const state = this.#state(id);
    if (state.version !== observedVersion) return Promise.resolve();
    const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 1 || refreshIntervalMs > 60_000) {
      return Promise.reject(new Error('Subscription refresh interval must be an integer between 1 and 60000'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.waiters.delete(wake);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const wake = () => finish();
      const onAbort = () => finish(abortError(signal as AbortSignal));
      const timer = setTimeout(wake, refreshIntervalMs);
      state.waiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
      // Close the read/register race without trusting the notification as state.
      if (state.version !== observedVersion) wake();
    });
  }
}

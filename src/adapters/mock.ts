import type {
  ResolvedRoute,
  WorkerAdapter,
  WorkerEventSink,
  WorkerHealth,
  WorkerRunInput,
  WorkerRunResult,
} from '../types.js';
import type { MockWorkerConfig } from '../config.js';

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      },
      { once: true }
    );
  });
}

export class MockWorkerAdapter implements WorkerAdapter {
  readonly name: string;

  constructor(
    name: string,
    readonly config: MockWorkerConfig
  ) {
    this.name = name;
  }

  async doctor(_route: ResolvedRoute): Promise<WorkerHealth> {
    return { ok: true, message: 'Mock worker is ready' };
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    await emit('worker.started', { adapter: 'mock', attempt: input.attempt });
    await wait(this.config.delayMs ?? 0, input.signal);
    const output = `${this.config.responsePrefix ?? 'Mock completed'}: ${input.prompt}`;
    await emit('worker.text.delta', { delta: output });
    return { output, metadata: { deterministic: true } };
  }
}

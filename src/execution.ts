import type { JobExecution } from './types.js';

export function isExecutorProcessAlive(execution: JobExecution | undefined): boolean {
  if (!execution || !Number.isSafeInteger(execution.pid) || execution.pid <= 0) return false;
  try {
    process.kill(execution.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

import { validateWorkerCompletionReport } from './completion-summary.js';
import type { WorkerCompletionReport } from './types.js';

export const WORKER_COMPLETION_REPORT_MARKER = 'AGENTKNOT_WORKER_COMPLETION_REPORT_V1';

export const WORKER_COMPLETION_REPORT_INSTRUCTION = [
  'End your final assistant message with exactly one single-line marked JSON envelope.',
  `The line must begin "${WORKER_COMPLETION_REPORT_MARKER}: " and contain schemaVersion 1 WorkerCompletionReport JSON with changedFiles as a string array, checksRun entries with command, outcome (passed, failed, or unknown), and optional notes, remainingRisks as a string array, and notes as a string array.`,
  'Do not add any text after that line. All values are worker-reported claims, not AgentKnot verification.',
].join(' ');

interface ParsedWorkerCompletionOutput {
  output: string;
  completionReport?: WorkerCompletionReport | null;
}

const WORKER_COMPLETION_REPORT_SUFFIX = new RegExp(
  `(^|\\r?\\n)${WORKER_COMPLETION_REPORT_MARKER}: ([^\\r\\n]*)(?![\\s\\S])`
);

export function parseWorkerCompletionOutput(output: string): ParsedWorkerCompletionOutput {
  const match = WORKER_COMPLETION_REPORT_SUFFIX.exec(output);
  if (!match) return { output };

  const separator = match[1] ?? '';
  const payload = match[2] ?? '';
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { output, completionReport: null };
  }

  const report = validateWorkerCompletionReport(value);
  if (!report) return { output, completionReport: null };

  return {
    output: output.slice(0, (match.index ?? 0) + separator.length),
    completionReport: report,
  };
}

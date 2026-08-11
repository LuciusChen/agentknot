import { validateWorkerCompletionReport } from './completion-summary.js';
import type { WorkerCompletionReport } from './types.js';

export const WORKER_COMPLETION_REPORT_MARKER = 'AGENTKNOT_WORKER_COMPLETION_REPORT_V1';

export const WORKER_COMPLETION_REPORT_INSTRUCTION = [
  'End your final assistant message with exactly one single-line marked JSON envelope.',
  `The line must begin "${WORKER_COMPLETION_REPORT_MARKER}: " and contain schemaVersion 1 WorkerCompletionReport JSON with taskOutcome (completed or blocked), changedFiles as a string array, checksRun entries with command, outcome (passed, failed, or unknown), and optional notes, remainingRisks as a string array, and notes as a string array. Use taskOutcome blocked whenever the requested task was not completed, even if inspection or checks succeeded.`,
  'Do not add any text after that line. All values are worker-reported claims, not AgentKnot verification.',
].join(' ');

interface ParsedWorkerCompletionOutput {
  output: string;
  completionReport?: WorkerCompletionReport | null;
}

interface RequiredWorkerCompletionOutput {
  output: string;
  completionReport: WorkerCompletionReport;
}

const WORKER_COMPLETION_REPORT_SUFFIX = new RegExp(
  `(^|\\r?\\n)${WORKER_COMPLETION_REPORT_MARKER}: ([^\\r\\n]*)(?![\\s\\S])`
);

export function parseWorkerCompletionOutput(output: string): ParsedWorkerCompletionOutput {
  const match = WORKER_COMPLETION_REPORT_SUFFIX.exec(output);
  if (!match) return { output };

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
    output: output.slice(0, match.index ?? 0),
    completionReport: report,
  };
}

export function parseRequiredWorkerCompletionOutput(
  output: string,
  adapter: string
): RequiredWorkerCompletionOutput {
  const parsed = parseWorkerCompletionOutput(output);
  if (parsed.completionReport === undefined) {
    throw new Error(`${adapter} output is missing required completion report`);
  }
  if (parsed.completionReport === null) {
    throw new Error(`${adapter} output contains a malformed required completion report`);
  }
  if (parsed.completionReport.taskOutcome === 'blocked') {
    const note = parsed.completionReport.notes[0];
    throw new Error(`${adapter} reported task blocked${note ? `: ${note}` : ''}`);
  }
  return { output: parsed.output, completionReport: parsed.completionReport };
}

#!/usr/bin/env node

import { open } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  readProfiledBrokerStatus,
  startBroker,
  startProfiledBroker,
  stopBroker,
  type BrokerStatus,
  STARTUP_REPORT_PATH_ENV,
} from './broker-lifecycle.js';
import {
  CandidateService,
  type CandidateArtifact,
  type CandidateRecord,
} from './candidate.js';
import { SqliteCandidateStore } from './candidate-store.js';
import { loadConfig } from './config.js';
import { validateTaskAssessment } from './delegation-policy.js';
import { AgentKnotHttpClient, type AgentKnotWaitUpdate } from './http-client.js';
import { createAgentKnotHttpServer } from './http-server.js';
import type { JobActivityProjection } from './job-activity.js';
import { buildJobList } from './job-list.js';
import { assertJsonMetadata } from './metadata.js';
import { limitText, limitTextSuffix, MAX_STARTUP_DIAGNOSTIC_BYTES } from './record-limits.js';
import {
  createLocalDiscoveryRegistration,
  readLocalDiscovery,
  type LocalDiscoveryRegistration,
} from './local-discovery.js';
import { serveAgentKnotMcp } from './mcp-server.js';
import {
  isOrchestrationDelegationOverride,
  type OrchestrationRecord,
  type OrchestrationRequest,
  type TaskAssessment,
} from './orchestration-types.js';
import { buildOrchestrationHandoff } from './orchestration-handoff.js';
import { createRuntime, type AgentKnotRuntime } from './runtime.js';
import {
  REVIEW_FINDING_SEVERITIES,
  ReviewService,
  type ReviewFinding,
  type ReviewRecord,
} from './review.js';
import { SqliteReviewStore } from './review-store.js';
import type {
  JobArtifactVerificationReport,
  JobEvent,
  JobRecord,
  JobRequest,
} from './types.js';
import type { RouteSelectionModeUsage, UsageRate, UsageReport } from './usage-report.js';
import { SqliteWorkOrderStore } from './work-order-store.js';
import { WorkOrderService, type WorkOrderCommand, type WorkOrderRecord } from './work-order.js';

const MAX_ASSESSMENT_JSON_BYTES = 64 * 1024;
const MAX_REQUEST_FILE_BYTES = 256 * 1024;
const ORCHESTRATION_REQUEST_KEYS = [
  'prompt',
  'workspace',
  'assessment',
  'source',
  'metadata',
  'delegation',
  'idempotencyKey',
] as const;

async function writeStartupFailureReport(error: unknown): Promise<void> {
  const reportPath = process.env[STARTUP_REPORT_PATH_ENV];
  if (reportPath === undefined) return;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(reportPath, 'wx', 0o600);
    const message = error instanceof Error ? error.message : String(error);
    await file.writeFile(limitTextSuffix(message, MAX_STARTUP_DIAGNOSTIC_BYTES));
  } catch {
    // Startup diagnostics are best-effort and must not replace the terminal lifecycle error.
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeOptions(args: string[], name: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = takeOption(args, name);
    if (value === undefined) return values;
    values.push(value);
  }
}

function parseReviewFindingJson(value: string, index: number): ReviewFinding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`--finding-json[${index}] must be valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--finding-json[${index}] must be an object`);
  }
  const finding = parsed as Record<string, unknown>;
  const keys = Object.keys(finding);
  if (
    keys.length !== 3 ||
    !Object.hasOwn(finding, 'severity') ||
    !Object.hasOwn(finding, 'message') ||
    !Object.hasOwn(finding, 'evidence')
  ) {
    throw new Error(
      `--finding-json[${index}] must contain only severity, message, and evidence`
    );
  }
  if (!REVIEW_FINDING_SEVERITIES.includes(finding.severity as ReviewFinding['severity'])) {
    throw new Error(`--finding-json[${index}].severity must be low, medium, or high`);
  }
  if (typeof finding.message !== 'string' || typeof finding.evidence !== 'string') {
    throw new Error(`--finding-json[${index}] message and evidence must be strings`);
  }
  return {
    severity: finding.severity as ReviewFinding['severity'],
    message: finding.message,
    evidence: finding.evidence,
  };
}

function parseAssessmentJson(value: string): TaskAssessment {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_ASSESSMENT_JSON_BYTES) {
    throw new Error(`--assessment-json exceeds ${MAX_ASSESSMENT_JSON_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('--assessment-json must be valid JSON');
  }

  try {
    return validateTaskAssessment(parsed);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--assessment-json is invalid: ${message}`, { cause: error });
  }
}

function parseRequestFileJson(value: string): OrchestrationRequest {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_REQUEST_FILE_BYTES) {
    throw new Error(`--request-file exceeds ${MAX_REQUEST_FILE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('--request-file must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--request-file must contain an OrchestrationRequest object');
  }
  const request = parsed as Record<string, unknown>;
  const allowed = new Set<string>(ORCHESTRATION_REQUEST_KEYS);
  const unknown = Object.keys(request).filter((key) => !allowed.has(key));
  const missing = ['prompt', 'workspace', 'assessment'].filter(
    (key) => !Object.hasOwn(request, key)
  );
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      '--request-file contains invalid fields' +
        `${unknown.length > 0 ? `; unknown: ${unknown.join(', ')}` : ''}` +
        `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`
    );
  }
  if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
    throw new Error('--request-file prompt must be a non-empty string');
  }
  if (typeof request.workspace !== 'string' || request.workspace.trim() === '') {
    throw new Error('--request-file workspace must be a non-empty string');
  }
  let assessment: TaskAssessment;
  try {
    assessment = validateTaskAssessment(request.assessment);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--request-file assessment is invalid: ${message}`, { cause: error });
  }
  if (request.source !== undefined && typeof request.source !== 'string') {
    throw new Error('--request-file source must be a string');
  }
  if (request.metadata !== undefined) assertJsonMetadata(request.metadata);
  if (
    request.delegation !== undefined &&
    !isOrchestrationDelegationOverride(request.delegation)
  ) {
    throw new Error('--request-file delegation must be inherit, never, suggest, or force');
  }
  if (
    request.idempotencyKey !== undefined &&
    (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.trim() === '')
  ) {
    throw new Error('--request-file idempotencyKey must be a non-empty string');
  }
  return {
    prompt: request.prompt,
    workspace: request.workspace,
    assessment,
    ...(request.source === undefined ? {} : { source: request.source }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    ...(request.delegation === undefined
      ? {}
      : { delegation: request.delegation as NonNullable<OrchestrationRequest['delegation']> }),
    ...(request.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: request.idempotencyKey }),
  };
}

async function readRequestFile(filePath: string): Promise<OrchestrationRequest> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(filePath, 'r');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--request-file could not be opened: ${message}`, { cause: error });
  }
  let value: string;
  try {
    const stats = await file.stat();
    if (stats.size > MAX_REQUEST_FILE_BYTES) {
      throw new Error(`--request-file exceeds ${MAX_REQUEST_FILE_BYTES} bytes`);
    }
    value = await file.readFile({ encoding: 'utf8' });
  } finally {
    await file.close();
  }
  return parseRequestFileJson(value);
}

function help(): string {
  return `AgentKnot — vendor-neutral coding-agent orchestration

Usage:
  agentknot task [objective...] [--route NAME] [--workspace PATH] [--acceptance TEXT] [--constraint TEXT] [--json]
  agentknot task-show WORK_ORDER_ID [--json]
  agentknot task-candidate WORK_ORDER_ID [--json]
  agentknot task-review WORK_ORDER_ID --reviewer NAME --summary TEXT [--finding-json JSON] [--candidate CANDIDATE_ID] [--json]
  agentknot task-reviews WORK_ORDER_ID [--json]
  agentknot run [prompt...] [--route NAME] [--workspace PATH] [--source NAME] [--idempotency-key KEY]
  agentknot orchestrate [prompt...] --assessment-json JSON [--workspace PATH] [--source NAME] [--delegation MODE] [--idempotency-key KEY]
  agentknot orchestrate --request-file PATH [--json] [--handoff-json] [--progress]
  agentknot broker run [--host HOST] [--port PORT]
  agentknot broker up [--port PORT] [--json]
  agentknot broker start [--json]
  agentknot broker down [--json]
  agentknot broker status [--json]
  agentknot serve [--host HOST] [--port PORT]   Deprecated alias for broker run
  agentknot mcp
  agentknot doctor [--route NAME] [--live]
  agentknot routes [--json]
  agentknot jobs [--json]
  agentknot usage [--json]
  agentknot show JOB_ID
  agentknot artifacts JOB_ID [--json]
  agentknot artifact-verify JOB_ID [--json]
  agentknot artifact-preview JOB_ID ATTEMPT [--json]
  agentknot delegation [--json]
  agentknot client [--json]
  agentknot orchestrations [--json]
  agentknot orchestration-show ORCHESTRATION_ID

Global options:
  --config PATH       Configuration file (default: agentknot.config.json)
  --server URL        Shared AgentKnot server (or AGENTKNOT_SERVER_URL)

Task options:
  --prompt TEXT       Objective instead of positional text
  --route NAME        Worker/provider/model route
  --workspace PATH    Worker working directory (default: current directory)
  --source NAME       Controller identity (default: cli)
  --acceptance TEXT   Acceptance criterion; may be repeated
  --constraint TEXT   Execution constraint; may be repeated
  --base-revision REV Opaque source revision recorded in the immutable WorkOrder command
  --json              Print the complete evidence available to the selected task command as JSON

Task Candidate:
  task-candidate explicitly records or reloads immutable Candidate evidence for the successful
  bound Job's verified terminal-attempt artifact. It does not review, accept, or apply the result.

Task Review:
  --reviewer NAME     Identity of the reviewer whose evidence is being recorded
  --summary TEXT      Review summary; it is evidence, not a verdict or disposition
  --finding-json JSON One {severity,message,evidence} finding; may be repeated
  --candidate ID      Select one Candidate only when the WorkOrder has more than one
  task-review records supplied review evidence; it does not launch a Reviewer Job or decide.
  task-reviews reloads all Reviews currently linked through the WorkOrder's Candidates.

Run options:
  --prompt TEXT       Prompt instead of positional text
  --route NAME        Worker/provider/model route
  --workspace PATH    Worker working directory (default: current directory)
  --source NAME       Controller identity, e.g. codex or claude
  --callback URL      POST the terminal Job record to this URL
  --json              Print only the final Job record as JSON
  --events            Stream every event as JSONL
  --progress          Print compact remote wait progress to stderr

Orchestrate options:
  --prompt TEXT       Goal instead of positional text
  --assessment-json JSON
                      Controller-authored TaskAssessment object (required unless --request-file is used)
  --request-file PATH Complete OrchestrationRequest JSON; cannot combine with request construction flags
  --workspace PATH    Target repository (default: current directory)
  --source NAME       Controller identity, e.g. codex, claude, or ci
  --delegation MODE   inherit, never, suggest, or force (default: inherit)
  --suggest           Alias for --delegation suggest
  --json              Print the terminal orchestration record as JSON
  --handoff-json      Print compact terminal/controller handoff JSON
  --progress          Print compact remote wait progress to stderr

Doctor options:
  --route NAME        Exact configured route to diagnose
  --live              Perform one real inference probe; no fallback
`;
}

function formatRate(value: UsageRate): string {
  return value.status === 'available'
    ? `${(value.value * 100).toFixed(2)}%`
    : `unavailable (${value.reason})`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatShare(numerator: number, denominator: number): string {
  return denominator === 0 ? 'n/a' : `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function reportRow(label: string, value: string, indent = 2): string {
  return `${' '.repeat(indent)}${label}${' '.repeat(Math.max(2, 27 - indent - label.length))}${value}`;
}

function formatRouteMode(mode: 'Active' | 'Shadow', value: RouteSelectionModeUsage): string[] {
  const total = value.classifiedSelections;
  const lines = [
    reportRow(`${mode} rule hits`, `${formatCount(value.ruleHits)} / ${formatCount(total)} (${formatRate(value.ruleHitRate)})`),
  ];
  for (const selection of value.selections.filter((item) => item.basis === 'rule')) {
    lines.push(
      reportRow(`rule[${selection.ruleIndex}] → ${selection.route}`, formatCount(selection.count), 4)
    );
  }
  lines.push(
    reportRow(
      `${mode} defaults`,
      `${formatCount(value.defaultSelections)} / ${formatCount(total)} (${formatShare(value.defaultSelections, total)})`
    )
  );
  for (const selection of value.selections.filter((item) => item.basis === 'default')) {
    lines.push(reportRow(`default → ${selection.route}`, formatCount(selection.count), 4));
  }
  return lines;
}

function formatUsageReport(report: UsageReport): string {
  const lines = [
    'AgentKnot usage report',
    '',
    'Coverage',
    reportRow(
      'Successful jobs',
      `${formatCount(report.scope.successfulJobs)} / ${formatCount(report.scope.totalJobs)} (${formatShare(report.scope.successfulJobs, report.scope.totalJobs)})`
    ),
    reportRow(
      'Downstream attempts',
      `${formatCount(report.scope.statsAvailableAttempts)} / ${formatCount(report.scope.observedAttempts)} (${formatShare(report.scope.statsAvailableAttempts, report.scope.observedAttempts)})`
    ),
    reportRow('Terminal orchestrations', formatCount(report.scope.terminalOrchestrations)),
    reportRow('Planned subtasks', formatCount(report.scope.plannedSubtasks)),
    '',
    'Downstream tokens',
  ];
  if (report.downstream.status === 'available') {
    lines.push(
      reportRow('Coverage', report.downstream.coverage),
      reportRow('Total', formatCount(report.downstream.tokens.total)),
      reportRow('Input', formatCount(report.downstream.tokens.input)),
      reportRow('Output', formatCount(report.downstream.tokens.output)),
      reportRow('Cache read', formatCount(report.downstream.tokens.cacheRead)),
      reportRow('Cache write', formatCount(report.downstream.tokens.cacheWrite)),
      reportRow('Cache-read hit rate', formatRate(report.downstream.cacheReadHitRate)),
      reportRow(
        'Provider-reported cost',
        `${report.downstream.providerReportedCost.toLocaleString('en-US', { maximumFractionDigits: 6 })} (unit unspecified)`
      )
    );
  } else {
    lines.push(reportRow('Status', `unavailable (${report.downstream.reason})`));
  }
  if (report.downstream.unavailable.length > 0) {
    lines.push(
      reportRow(
        'Missing stats',
        `${formatCount(report.scope.statsUnavailableAttempts)} (${report.downstream.unavailable.map((item) => `${item.reason}: ${formatCount(item.count)}`).join(', ')})`
      )
    );
  }
  lines.push('', 'Routing');
  const selectionCoverage = `${formatCount(report.routeSelection.classifiedSelections)} / ${formatCount(report.scope.plannedSubtasks)} (${formatShare(report.routeSelection.classifiedSelections, report.scope.plannedSubtasks)})`;
  lines.push(reportRow('Classified selections', selectionCoverage));
  if (report.routeSelection.status === 'available') {
    lines.push(reportRow('Coverage', report.routeSelection.coverage));
  } else {
    lines.push(reportRow('Status', `unavailable (${report.routeSelection.reason})`));
  }
  if (report.routeSelection.active.classifiedSelections > 0) {
    lines.push(...formatRouteMode('Active', report.routeSelection.active));
  }
  if (report.routeSelection.shadow.classifiedSelections > 0) {
    lines.push(...formatRouteMode('Shadow', report.routeSelection.shadow));
  }
  if (report.routePools.status === 'available') {
    lines.push(
      reportRow(
        'Pool selections',
        `${formatCount(report.routePools.classifiedJobs)} / ${formatCount(report.routePools.observedJobs)} (${report.routePools.coverage})`
      )
    );
    for (const selection of report.routePools.selections) {
      lines.push(
        reportRow(`${selection.pool} → ${selection.route}`, formatCount(selection.count), 4)
      );
    }
  } else {
    lines.push(reportRow('Pool selections', 'none'));
  }
  lines.push(
    reportRow('Unclassified', formatCount(report.routeSelection.unavailableSelections)),
    '',
    'Advisory quality review',
    reportRow('Configured terminal runs', formatCount(report.qualityReview.configuredOrchestrations)),
    reportRow(
      'Classified reviews',
      `${formatCount(report.qualityReview.classifiedReviews)} / ${formatCount(report.qualityReview.configuredOrchestrations)} (${formatShare(report.qualityReview.classifiedReviews, report.qualityReview.configuredOrchestrations)})`
    )
  );
  if (report.qualityReview.status === 'available') {
    lines.push(reportRow('Coverage', report.qualityReview.coverage));
  } else {
    lines.push(reportRow('Status', `unavailable (${report.qualityReview.reason})`));
  }
  lines.push(
    reportRow(
      'Outcomes',
      `completed: ${formatCount(report.qualityReview.outcomes.completed)}, skipped: ${formatCount(report.qualityReview.outcomes.skipped)}, unavailable: ${formatCount(report.qualityReview.outcomes.unavailable)}`
    ),
    reportRow(
      'Verdicts',
      `accept: ${formatCount(report.qualityReview.verdicts.accept)}, changes: ${formatCount(report.qualityReview.verdicts.changesRequested)}, uncertain: ${formatCount(report.qualityReview.verdicts.uncertain)}`
    ),
    reportRow(
      'Findings',
      `high: ${formatCount(report.qualityReview.findingSeverities.high)}, medium: ${formatCount(report.qualityReview.findingSeverities.medium)}, low: ${formatCount(report.qualityReview.findingSeverities.low)}`
    )
  );
  for (const route of report.qualityReview.reviewerRoutes) {
    lines.push(reportRow(`reviewer → ${route.route}`, formatCount(route.count), 4));
  }
  for (const reason of report.qualityReview.reasons) {
    lines.push(reportRow(`${reason.status}: ${reason.reason}`, formatCount(reason.count), 4));
  }
  lines.push(
    reportRow('Controller disposition', 'unavailable (not persisted)'),
    '',
    'Controller usage',
    reportRow('Upstream tokens', 'unavailable (not persisted)'),
    reportRow('Upstream / downstream', 'unavailable (not persisted)')
  );
  return `${lines.join('\n')}\n`;
}

function printEvent(event: JobEvent, json: boolean, events: boolean): void {
  if (events) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (json) return;
  if (event.type === 'worker.text.delta') {
    const delta = event.data?.delta;
    if (typeof delta === 'string') process.stdout.write(delta);
  } else if (event.type.startsWith('job.')) {
    process.stderr.write(`[${event.type}] ${event.jobId}\n`);
  }
}

function workOrderRevision(record: WorkOrderRecord): number {
  const revision = record.events.at(-1)?.sequence;
  if (revision === undefined) throw new Error(`WorkOrder ${record.id} has no public revision`);
  return revision;
}

function workOrderExecutorPrompt(command: WorkOrderCommand): string {
  return [
    'Execute the following AgentKnot WorkOrder command.',
    '',
    'Objective:',
    command.objective,
    '',
    'Acceptance criteria:',
    ...(command.acceptanceCriteria.length === 0
      ? ['- none specified']
      : command.acceptanceCriteria.map((criterion) => `- ${criterion}`)),
    '',
    'Constraints:',
    ...(command.constraints.length === 0
      ? ['- none specified']
      : command.constraints.map((constraint) => `- ${constraint}`)),
  ].join('\n');
}

const MAX_TASK_PRESENTATION_BYTES = 240;
const TASK_TRUNCATION_MARKER = '… [truncated]';

function taskHumanText(value: string, maxBytes = MAX_TASK_PRESENTATION_BYTES): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized === '') return 'not available';

  const limited = limitText(normalized, maxBytes);
  if (limited.truncation === undefined) return limited.value;

  const markerBytes = Buffer.byteLength(TASK_TRUNCATION_MARKER, 'utf8');
  const prefix = limitText(normalized, maxBytes - markerBytes).value;
  return `${prefix}${TASK_TRUNCATION_MARKER}`;
}

function taskExecutionStatus(job: JobRecord | undefined): string {
  if (job === undefined) return 'No Executor Job is bound yet.';
  switch (job.status) {
    case 'succeeded':
      return 'Execution completed successfully. This is technical completion, not acceptance.';
    case 'failed': {
      const detail = job.error?.message;
      return detail === undefined
        ? 'Execution failed.'
        : `Execution failed: ${taskHumanText(detail)}`;
    }
    case 'cancelled':
      return 'Execution was cancelled.';
    case 'queued':
      return 'Execution is queued.';
    case 'running':
      return 'Execution is running.';
  }
}

function taskOutputSummary(job: JobRecord): string {
  const output = job.result?.output.trim();
  if (!output) return job.error?.message === undefined ? 'No result is available.' : taskHumanText(job.error.message);
  return taskHumanText(output);
}

function taskChangedFiles(job: JobRecord): string[] | undefined {
  const captured = job.completionSummary?.changedFiles;
  if (captured?.status === 'captured') return captured.paths;
  const paths = (job.artifacts ?? []).flatMap((artifact) => artifact.changedFiles ?? []);
  return paths.length === 0 ? undefined : [...new Set(paths)].sort();
}

function taskWorkerCheckLines(job: JobRecord | undefined): string[] {
  if (job === undefined) return ['  No execution evidence is available yet.'];
  const workerReported = job.completionSummary?.workerReported;
  if (workerReported?.status !== 'reported') return ['  Worker-reported checks: not available'];
  const counts = { passed: 0, failed: 0, unknown: 0 };
  for (const check of workerReported.report.checksRun) counts[check.outcome] += 1;
  return [
    `  Worker-reported checks: ${counts.passed} passed, ${counts.failed} failed, ${counts.unknown} unknown`,
    ...workerReported.report.checksRun.map(
      (check) => `    - ${taskHumanText(check.command)}: ${check.outcome}`
    ),
  ];
}

function taskArtifactValidation(
  job: JobRecord | undefined,
  verification: JobArtifactVerificationReport | undefined
): string {
  if (job === undefined) return 'not available';
  if (job.status === 'queued' || job.status === 'running') return 'pending';
  if ((job.artifacts ?? []).length === 0) return 'not applicable';
  if (verification === undefined) return 'unavailable';
  return verification.valid ? 'passed' : 'failed';
}

function taskNextAction(
  job: JobRecord | undefined,
  verification: JobArtifactVerificationReport | undefined,
  candidate?: CandidateRecord
): string {
  if (job === undefined) return 'Bind an admitted Executor Job before checking this task again.';
  if (job.status === 'queued' || job.status === 'running') {
    return 'Wait for execution to finish, then check this task again.';
  }
  if (job.status === 'failed') {
    return 'Inspect the failure and issue a new task if another attempt is appropriate.';
  }
  if (job.status === 'cancelled') {
    return 'Issue a new task if the requested work is still needed.';
  }
  if (verification !== undefined && !verification.valid) {
    return 'Inspect the artifact-integrity failure before reviewing any reported changes.';
  }
  if (candidate !== undefined) {
    return 'Review the Candidate before recording a disposition; AgentKnot has not reviewed or accepted it.';
  }
  return 'Review the result and decide whether to accept or apply it; AgentKnot has done neither.';
}

function formatTaskHuman(
  workOrder: WorkOrderRecord,
  job: JobRecord | undefined,
  verification: JobArtifactVerificationReport | undefined,
  candidate?: CandidateRecord
): string {
  const changedFiles = job === undefined ? undefined : taskChangedFiles(job);
  const lines = [
    'Task',
    `  Objective: ${taskHumanText(workOrder.command.objective)}`,
    '  Expected outcome:',
    ...(workOrder.command.acceptanceCriteria.length === 0
      ? ['    - not specified']
      : workOrder.command.acceptanceCriteria.map(
          (criterion) => `    - ${taskHumanText(criterion)}`
        )),
    '  Constraints:',
    ...(workOrder.command.constraints.length === 0
      ? ['    - none specified']
      : workOrder.command.constraints.map(
          (constraint) => `    - ${taskHumanText(constraint)}`
        )),
    '',
    'Status',
    `  ${taskExecutionStatus(job)}`,
    '',
    'Summary',
    `  ${job === undefined ? 'No execution result is available yet.' : taskOutputSummary(job)}`,
    '',
    'Changes',
    ...(changedFiles === undefined
      ? ['  unavailable']
      : changedFiles.length === 0
        ? ['  none']
        : changedFiles.map((file) => `  - ${taskHumanText(file)}`)),
    ...(candidate === undefined
      ? []
      : [
          '',
          'Candidate',
          '  Recorded as immutable evidence for this task result; it has not been reviewed or accepted.',
        ]),
    '',
    'Tests',
    ...taskWorkerCheckLines(job),
    `  Artifact integrity: ${taskArtifactValidation(job, verification)}`,
    '',
    'Next action',
    `  ${taskNextAction(job, verification, candidate)}`,
  ];
  return lines.join('\n');
}

function formatTaskJson(
  workOrder: WorkOrderRecord,
  job: JobRecord | undefined,
  verification: JobArtifactVerificationReport | undefined,
  candidate?: CandidateRecord
): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      workOrder,
      ...(job === undefined ? {} : { job }),
      ...(candidate === undefined ? {} : { candidate }),
      ...(verification === undefined ? {} : { artifactVerification: verification }),
    },
    null,
    2
  );
}

function printTaskReport(
  workOrder: WorkOrderRecord,
  job: JobRecord | undefined,
  verification: JobArtifactVerificationReport | undefined,
  json: boolean,
  candidate?: CandidateRecord
): void {
  process.stdout.write(
    `${json ? formatTaskJson(workOrder, job, verification, candidate) : formatTaskHuman(workOrder, job, verification, candidate)}\n`
  );
}

function taskCandidateArtifact(job: JobRecord): CandidateArtifact {
  const attempt = job.completionSummary?.attempt ?? job.result?.attempt ?? job.attempt;
  const artifact = (job.artifacts ?? []).find(
    (candidate) => candidate.kind === 'git-patch' && candidate.attempt === attempt
  );
  if (artifact === undefined) {
    throw new Error('Task execution has no recorded terminal-attempt Git patch artifact');
  }
  return {
    path: artifact.path,
    sha256: artifact.sha256,
    baseCommit: artifact.baseCommit,
  };
}

function sameCandidateArtifact(left: CandidateArtifact, right: CandidateArtifact): boolean {
  return (
    left.path === right.path &&
    left.sha256 === right.sha256 &&
    left.baseCommit === right.baseCommit
  );
}

function taskCandidateArtifactIsVerified(
  artifact: CandidateArtifact,
  verification: JobArtifactVerificationReport | undefined
): boolean {
  return (
    verification?.artifacts.some(
      (entry) =>
        entry.valid &&
        entry.artifact.path === artifact.path &&
        entry.artifact.sha256 === artifact.sha256 &&
        entry.artifact.baseCommit === artifact.baseCommit
    ) ?? false
  );
}

async function candidatesForWorkOrder(
  store: SqliteCandidateStore,
  workOrder: WorkOrderRecord
): Promise<CandidateRecord[]> {
  return (await store.list()).filter(
    (candidate) =>
      candidate.workOrderId === workOrder.id &&
      candidate.executorJobId === workOrder.executorJobId
  );
}

function selectTaskReviewCandidate(
  candidates: CandidateRecord[],
  requestedCandidateId: string | undefined
): CandidateRecord {
  if (requestedCandidateId !== undefined) {
    const selected = candidates.find((candidate) => candidate.id === requestedCandidateId);
    if (selected === undefined) {
      throw new Error('The selected Candidate does not belong to this WorkOrder');
    }
    return selected;
  }
  if (candidates.length === 0) {
    throw new Error('Task has no Candidate; record one before creating a Review');
  }
  if (candidates.length > 1) {
    throw new Error(
      'Task has multiple Candidates; select one explicitly with --candidate CANDIDATE_ID'
    );
  }
  return candidates[0]!;
}

function taskReviewFindingLines(finding: ReviewFinding, indent: string): string[] {
  return [
    `${indent}- ${finding.severity}: ${taskHumanText(finding.message)}`,
    `${indent}  Evidence: ${taskHumanText(finding.evidence)}`,
  ];
}

function formatTaskReviewHuman(workOrder: WorkOrderRecord, review: ReviewRecord): string {
  return [
    'Task',
    `  Objective: ${taskHumanText(workOrder.command.objective)}`,
    '',
    'Review',
    `  Reviewer: ${taskHumanText(review.reviewer)}`,
    `  Summary: ${taskHumanText(review.summary)}`,
    '',
    'Findings',
    ...(review.findings.length === 0
      ? ['  none']
      : review.findings.flatMap((finding) => taskReviewFindingLines(finding, '  '))),
    '',
    'Current status',
    '  Review evidence is recorded. It is not a verdict, acceptance, or disposition.',
    '',
    'Next action',
    '  Consider all relevant Reviews, then explicitly record a disposition when ready.',
  ].join('\n');
}

function formatTaskReviewsHuman(
  workOrder: WorkOrderRecord,
  candidates: CandidateRecord[],
  reviews: ReviewRecord[]
): string {
  const lines = [
    'Task',
    `  Objective: ${taskHumanText(workOrder.command.objective)}`,
    '',
    'Current status',
    candidates.length === 0
      ? '  No Candidate has been recorded for this task.'
      : `  ${candidates.length} Candidate${candidates.length === 1 ? '' : 's'} and ${reviews.length} Review${reviews.length === 1 ? '' : 's'} are recorded.`,
    '',
    'Reviews',
  ];
  if (reviews.length === 0) {
    lines.push('  none');
  } else {
    reviews.forEach((review, index) => {
      if (index > 0) lines.push('');
      lines.push(
        `  Review ${index + 1}`,
        `    Reviewer: ${taskHumanText(review.reviewer)}`,
        `    Summary: ${taskHumanText(review.summary)}`,
        ...(review.findings.length === 0
          ? ['    Findings: none']
          : [
              '    Findings:',
              ...review.findings.flatMap((finding) =>
                taskReviewFindingLines(finding, '      ')
              ),
            ])
      );
    });
  }
  lines.push(
    '',
    'Next action',
    candidates.length === 0
      ? '  Record a Candidate before creating Review evidence.'
      : reviews.length === 0
        ? '  Record an independent Review for the Candidate.'
        : '  Consider all relevant Reviews; no disposition has been inferred or recorded here.'
  );
  return lines.join('\n');
}

function formatTaskReviewJson(
  workOrder: WorkOrderRecord,
  candidate: CandidateRecord,
  review: ReviewRecord
): string {
  return JSON.stringify({ schemaVersion: 1, workOrder, candidate, review }, null, 2);
}

function formatTaskReviewsJson(
  workOrder: WorkOrderRecord,
  candidates: CandidateRecord[],
  reviews: ReviewRecord[]
): string {
  return JSON.stringify({ schemaVersion: 1, workOrder, candidates, reviews }, null, 2);
}

async function openTaskWorkOrders(configPath: string | undefined): Promise<{
  store: SqliteWorkOrderStore;
  service: WorkOrderService;
}> {
  const loaded = await loadConfig(
    configPath ?? process.env.AGENTKNOT_CONFIG ?? 'agentknot.config.json'
  );
  const workOrderStorageDirectory = path.resolve(
    loaded.baseDirectory,
    path.join(path.dirname(loaded.config.storage.directory), 'work-orders')
  );
  if (
    workOrderStorageDirectory === path.resolve(loaded.storageDirectory) ||
    workOrderStorageDirectory ===
      path.resolve(loaded.orchestrationStorageDirectory)
  ) {
    throw new Error('WorkOrder storage directory must be distinct from execution storage');
  }
  const store = await SqliteWorkOrderStore.open(workOrderStorageDirectory);
  return { store, service: new WorkOrderService({ store }) };
}

async function openTaskCandidates(configPath: string | undefined): Promise<SqliteCandidateStore> {
  const loaded = await loadConfig(
    configPath ?? process.env.AGENTKNOT_CONFIG ?? 'agentknot.config.json'
  );
  const candidateStorageDirectory = path.resolve(
    loaded.baseDirectory,
    path.join(path.dirname(loaded.config.storage.directory), 'candidates')
  );
  if (
    candidateStorageDirectory === path.resolve(loaded.storageDirectory) ||
    candidateStorageDirectory === path.resolve(loaded.orchestrationStorageDirectory)
  ) {
    throw new Error('Candidate storage directory must be distinct from execution storage');
  }
  return SqliteCandidateStore.open(candidateStorageDirectory);
}

async function openTaskReviews(configPath: string | undefined): Promise<SqliteReviewStore> {
  const loaded = await loadConfig(
    configPath ?? process.env.AGENTKNOT_CONFIG ?? 'agentknot.config.json'
  );
  const reviewStorageDirectory = path.resolve(
    loaded.baseDirectory,
    path.join(path.dirname(loaded.config.storage.directory), 'reviews')
  );
  if (
    reviewStorageDirectory === path.resolve(loaded.storageDirectory) ||
    reviewStorageDirectory === path.resolve(loaded.orchestrationStorageDirectory)
  ) {
    throw new Error('Review storage directory must be distinct from execution storage');
  }
  return SqliteReviewStore.open(reviewStorageDirectory);
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function safeProgressLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80) || 'unknown';
}

function activityLabel(activity: JobActivityProjection): string {
  let label: string = activity.state;
  if (activity.state === 'retrying' && activity.lastObserved?.retryScope !== undefined) {
    const scope = activity.lastObserved.retryScope;
    const attempt = activity.lastObserved.retryAttempt;
    const maximum = activity.lastObserved.retryMaxAttempts;
    label = `retrying:${scope}${attempt === undefined ? '' : `:${attempt}${maximum === undefined ? '' : `/${maximum}`}`}`;
  }
  if (activity.state === 'tools-running' && activity.activeTools !== undefined) {
    const visible = activity.activeTools.names.slice(0, 2).map(safeProgressLabel);
    const hidden = activity.activeTools.count - visible.length;
    label = `tools:${visible.join('+') || 'unknown'}${hidden > 0 ? `+${hidden}` : ''}`;
  }
  return activity.coverage === 'complete' ? label : `${label}/${activity.coverage}`;
}

function observedActivityLabel(activity: JobActivityProjection, now: number): string {
  const observed = activity.lastObserved;
  if (observed === undefined) return 'last=none';
  const tool = observed.toolName === undefined ? '' : `:${safeProgressLabel(observed.toolName)}`;
  return `last=${safeProgressLabel(observed.type)}${tool} age=${formatElapsed(now - Date.parse(observed.at))}`;
}

function createWaitProgressReporter(enabled: boolean): (update: AgentKnotWaitUpdate) => void {
  let previousFingerprint = '';
  let previousPrintedAt = 0;
  return (update) => {
    if (!enabled) return;
    const now = Date.now();
    if (update.connectivity === 'disconnected') {
      process.stderr.write(
        `[agentknot] disconnected id=${update.id} reconnect=${update.attempt}/${update.maxAttempts}\n`
      );
      previousFingerprint = '';
      previousPrintedAt = now;
      return;
    }
    const progress = update.progress;
    if (progress === undefined) return;
    const projectedActivities = progress.kind === 'job'
      ? [progress.activity]
      : progress.children.map((child) => child.activity);
    const latestProjected = projectedActivities
      .filter((activity): activity is JobActivityProjection => activity !== undefined)
      .sort((left, right) =>
        Date.parse(right.lastObserved?.at ?? '') - Date.parse(left.lastObserved?.at ?? ''))[0];
    const activities = progress.kind === 'job'
      ? [progress.lastActivity]
      : [progress.lastActivity, ...progress.children.map((child) => child.lastActivity)];
    const lastActivity = activities
      .filter((activity): activity is NonNullable<typeof activity> => activity !== undefined)
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
    const phase = progress.kind === 'job' ? progress.status : progress.phase;
    const children = progress.kind === 'orchestration'
      ? ` children=${progress.children.map((child) => {
          const projected = child.activity === undefined ? '' : `[${activityLabel(child.activity)}]`;
          return `${child.status}:${child.route ?? 'unknown'}${projected}`;
        }).join(',') || 'none'}`
      : ` route=${progress.route}${progress.activity === undefined ? '' : ` activity=${activityLabel(progress.activity)}`}`;
    const activity = latestProjected === undefined
      ? lastActivity === undefined
        ? ' last=none'
        : ` last=${safeProgressLabel(lastActivity.type)} age=${formatElapsed(now - Date.parse(lastActivity.at))}`
      : ` ${observedActivityLabel(latestProjected, now)}`;
    const fingerprint = `${progress.kind}|${phase}|${children}|${latestProjected?.lastObserved?.sequence ?? lastActivity?.sequence ?? 0}`;
    if (fingerprint === previousFingerprint && now - previousPrintedAt < 15_000) return;
    process.stderr.write(`[agentknot] connected id=${progress.id} phase=${phase}${children}${activity}\n`);
    previousFingerprint = fingerprint;
    previousPrintedAt = now;
  };
}


function cancelOnTermination(cancel: () => void | Promise<void>, exitCode = 1): () => void {
  let requested = false;
  const onSignal = () => {
    if (requested) return;
    requested = true;
    process.exitCode = exitCode;
    void Promise.resolve(cancel()).catch((error: unknown) => {
      process.stderr.write(
        `agentknot: termination cancellation failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

type CliTransport =
  | { readonly kind: 'local'; readonly configPath: string | undefined }
  | { readonly kind: 'remote'; readonly client: AgentKnotHttpClient };

type ClientStatusReport =
  | { readonly status: 'unconfigured' }
  | { readonly status: 'available'; readonly url: string }
  | { readonly status: 'unavailable'; readonly url?: string; readonly error: string };

function isClientCapableCommand(command: string): boolean {
  return new Set([
    'task',
    'task-show',
    'task-candidate',
    'run',
    'orchestrate',
    'routes',
    'jobs',
    'show',
    'delegation',
    'orchestrations',
    'orchestration-show',
    'artifacts',
    'artifact-verify',
    'artifact-preview',
  ]).has(command);
}

async function resolveClientTransport(
  configPath: string | undefined,
  explicitServerUrl: string | undefined,
  environmentServerUrl: string | undefined
): Promise<CliTransport> {
  if (configPath !== undefined) return { kind: 'local', configPath };
  if (explicitServerUrl !== undefined) {
    return { kind: 'remote', client: new AgentKnotHttpClient(explicitServerUrl) };
  }
  if (environmentServerUrl !== undefined) {
    return { kind: 'remote', client: new AgentKnotHttpClient(environmentServerUrl) };
  }
  if (process.env.AGENTKNOT_CONFIG !== undefined) {
    return { kind: 'local', configPath: undefined };
  }
  const record = await readLocalDiscovery();
  return record === undefined
    ? { kind: 'local', configPath: undefined }
    : { kind: 'remote', client: new AgentKnotHttpClient(record.url) };
}

async function readClientStatus(
  configPath: string | undefined,
  explicitServerUrl: string | undefined,
  environmentServerUrl: string | undefined
): Promise<ClientStatusReport> {
  let endpoint = configPath === undefined ? explicitServerUrl ?? environmentServerUrl : undefined;
  if (endpoint === undefined && configPath === undefined && process.env.AGENTKNOT_CONFIG === undefined) {
    try {
      endpoint = (await readLocalDiscovery())?.url;
    } catch (error: unknown) {
      return {
        status: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (endpoint === undefined) return { status: 'unconfigured' };

  try {
    await new AgentKnotHttpClient(endpoint).health();
    return { status: 'available', url: endpoint };
  } catch (error: unknown) {
    return {
      status: 'unavailable',
      url: endpoint,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printClientStatus(report: ClientStatusReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (report.status === 'unconfigured') {
    process.stdout.write('AgentKnot client: unconfigured\n');
  } else if (report.status === 'available') {
    process.stdout.write(`AgentKnot client: available (${report.url})\n`);
  } else {
    process.stdout.write(
      `AgentKnot client: unavailable${report.url === undefined ? '' : ` (${report.url})`}: ${report.error}\n`
    );
  }
}

async function closeServeResources(
  http: ReturnType<typeof createAgentKnotHttpServer> | undefined,
  runtime: AgentKnotRuntime | undefined,
  discovery: LocalDiscoveryRegistration | undefined
): Promise<void> {
  const errors: unknown[] = [];
  if (http?.server.listening) {
    try {
      await http.close();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (runtime !== undefined) {
    try {
      await runtime.close();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (discovery !== undefined) {
    try {
      await discovery.close();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'AgentKnot serve cleanup failed');
}

function formatBrokerStatus(
  status: BrokerStatus,
  launchConfigured: boolean,
  json: boolean
): string {
  if (json) return `${JSON.stringify({ ...status, launchConfigured }, null, 2)}\n`;
  const profile = launchConfigured ? 'launch configured' : 'launch unconfigured';
  if (status.state === 'running') {
    return `AgentKnot broker: running (${status.url}, pid ${status.pid}; ${profile})\n`;
  }
  if (status.state === 'stopped') return `AgentKnot broker: stopped (${profile})\n`;
  return `AgentKnot broker: unavailable${status.url === undefined ? '' : ` (${status.url})`}: ${status.error} (${profile})\n`;
}

async function runBrokerForeground(
  args: string[],
  configPath: string | undefined,
  explicitServerUrl: string | undefined,
  environmentServerUrl: string | undefined
): Promise<void> {
  if (explicitServerUrl !== undefined || environmentServerUrl !== undefined) {
    throw new Error('broker run cannot be used with --server');
  }
  const host = takeOption(args, '--host') ?? '127.0.0.1';
  const portValue = takeOption(args, '--port') ?? '7391';
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535');
  if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);

  const discovery = host === '127.0.0.1' ? await createLocalDiscoveryRegistration() : undefined;
  let runtime: AgentKnotRuntime | undefined;
  let http: ReturnType<typeof createAgentKnotHttpServer> | undefined;
  try {
    runtime = await createRuntime({
      ...(configPath === undefined ? {} : { configPath }),
      reconcileOnStartup: true,
    });
    http = createAgentKnotHttpServer(runtime, {
      ...(discovery === undefined
        ? {}
        : {
            brokerIdentity: {
              schemaVersion: 1,
              service: 'agentknot-broker',
              instanceId: discovery.instanceId,
              pid: process.pid,
              startedAt: discovery.startedAt,
            } as const,
          }),
    });
    const address = await http.listen(port, host);
    if (discovery !== undefined) await discovery.publish(address.port);
    cancelOnTermination(() => closeServeResources(http, runtime, discovery), 0);
    process.stdout.write(`AgentKnot listening on http://${address.host}:${address.port}\n`);
  } catch (error: unknown) {
    try {
      await closeServeResources(http, runtime, discovery);
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], 'AgentKnot broker startup cleanup failed');
    }
    throw error;
  }
}

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(help());
    return;
  }

  const configPath = takeOption(args, '--config');
  const explicitServerUrl = takeOption(args, '--server');
  const environmentServerUrl = process.env.AGENTKNOT_SERVER_URL;
  if (configPath !== undefined && explicitServerUrl !== undefined) {
    throw new Error('--config and --server cannot be used together');
  }
  const transport = isClientCapableCommand(command)
    ? await resolveClientTransport(configPath, explicitServerUrl, environmentServerUrl)
    : undefined;
  const remote = transport?.kind === 'remote' ? transport.client : undefined;

  if (command === 'task') {
    const route = takeOption(args, '--route');
    const workspace = takeOption(args, '--workspace') ?? process.cwd();
    const source = takeOption(args, '--source') ?? 'cli';
    const promptOption = takeOption(args, '--prompt');
    const baseRevision = takeOption(args, '--base-revision');
    const acceptanceCriteria = takeOptions(args, '--acceptance');
    const constraints = takeOptions(args, '--constraint');
    const json = takeFlag(args, '--json');
    if (args.some((value) => value.startsWith('--'))) {
      throw new Error(`Unknown option: ${args.join(' ')}`);
    }
    const objective = promptOption ?? args.join(' ');
    const commandInput: WorkOrderCommand = {
      objective,
      workspace,
      acceptanceCriteria:
        acceptanceCriteria.length === 0
          ? [`Complete the requested objective: ${objective}`]
          : acceptanceCriteria,
      constraints,
      ...(baseRevision === undefined ? {} : { baseRevision }),
    };
    const workOrders = await openTaskWorkOrders(configPath);
    let runtime: AgentKnotRuntime | undefined;
    try {
      const issued = await workOrders.service.issue(commandInput);
      const request: JobRequest = {
        prompt: workOrderExecutorPrompt(issued.command),
        workspace: issued.command.workspace,
        source,
        ...(route === undefined ? {} : { route }),
      };
      if (remote !== undefined) {
        const initial = await remote.startJob(request);
        const bound = await workOrders.service.bindExecutorJob(
          issued.id,
          workOrderRevision(issued),
          initial.id
        );
        if (!json) process.stdout.write('Task started. Waiting for execution to finish...\n\n');
        const stopCancellation = cancelOnTermination(() => remote.cancelJob(initial.id));
        const job = await remote.waitForJob(initial).finally(stopCancellation);
        const verification = await remote.verifyArtifacts(job.id);
        printTaskReport(bound, job, verification, json);
        if (job.status !== 'succeeded') process.exitCode = 1;
        return;
      }

      runtime = await createRuntime({
        ...(configPath === undefined ? {} : { configPath }),
        reconcileOnStartup: true,
      });
      const started = await runtime.start(request);
      const bound = await workOrders.service.bindExecutorJob(
        issued.id,
        workOrderRevision(issued),
        started.job.id
      );
      if (!json) process.stdout.write('Task started. Waiting for execution to finish...\n\n');
      const stopCancellation = cancelOnTermination(started.cancel);
      const job = await started.completion.finally(stopCancellation);
      const verification = await runtime.verifyArtifacts(job.id);
      printTaskReport(bound, job, verification, json);
      if (job.status !== 'succeeded') process.exitCode = 1;
      return;
    } finally {
      await runtime?.close();
      await workOrders.store.close();
    }
  }

  if (command === 'task-show') {
    const json = takeFlag(args, '--json');
    const workOrderId = args.shift();
    if (!workOrderId || args.length > 0) {
      throw new Error('task-show requires exactly one WORK_ORDER_ID');
    }
    const workOrders = await openTaskWorkOrders(configPath);
    let runtime: AgentKnotRuntime | undefined;
    try {
      const workOrder = await workOrders.service.get(workOrderId);
      if (workOrder === undefined) {
        process.stderr.write('Task not found.\n');
        process.exitCode = 1;
        return;
      }
      if (workOrder.executorJobId === undefined) {
        printTaskReport(workOrder, undefined, undefined, json);
        return;
      }
      const job =
        remote !== undefined
          ? await remote.getJob(workOrder.executorJobId)
          : await (runtime = await createRuntime({
              ...(configPath === undefined ? {} : { configPath }),
              reconcileOnStartup: false,
            })).get(workOrder.executorJobId);
      if (job === undefined) {
        process.stderr.write('Task execution record is unavailable.\n');
        process.exitCode = 1;
        return;
      }
      const verification =
        remote !== undefined
          ? await remote.verifyArtifacts(job.id)
          : await runtime!.verifyArtifacts(job.id);
      printTaskReport(workOrder, job, verification, json);
      if (job.status === 'failed' || job.status === 'cancelled') process.exitCode = 1;
      return;
    } finally {
      await runtime?.close();
      await workOrders.store.close();
    }
  }

  if (command === 'task-candidate') {
    const json = takeFlag(args, '--json');
    const workOrderId = args.shift();
    if (!workOrderId || args.length > 0) {
      throw new Error('task-candidate requires exactly one WORK_ORDER_ID');
    }
    const workOrders = await openTaskWorkOrders(configPath);
    let candidates: SqliteCandidateStore | undefined;
    let runtime: AgentKnotRuntime | undefined;
    try {
      candidates = await openTaskCandidates(configPath);
      const workOrder = await workOrders.service.get(workOrderId);
      if (workOrder === undefined) {
        process.stderr.write('Task not found.\n');
        process.exitCode = 1;
        return;
      }
      if (workOrder.executorJobId === undefined) {
        throw new Error('Task has no bound Executor Job');
      }
      const jobs =
        remote !== undefined
          ? { get: (id: string) => remote.getJob(id) }
          : {
              get: (id: string) => {
                if (runtime === undefined) throw new Error('Task runtime is unavailable');
                return runtime.get(id);
              },
            };
      if (remote === undefined) {
        runtime = await createRuntime({
          ...(configPath === undefined ? {} : { configPath }),
          reconcileOnStartup: false,
        });
      }
      const job = await jobs.get(workOrder.executorJobId);
      if (job === undefined) {
        throw new Error('Task execution record is unavailable');
      }
      if (job.status !== 'succeeded') {
        throw new Error('Task execution must succeed before recording or reading its Candidate');
      }
      const verification =
        remote !== undefined
          ? await remote.verifyArtifacts(job.id)
          : await runtime!.verifyArtifacts(job.id);
      const artifact = taskCandidateArtifact(job);
      const service = new CandidateService({
        store: candidates,
        workOrders: workOrders.store,
        jobs,
      });
      let candidate = (await service.list()).find(
        (record) =>
          record.workOrderId === workOrder.id &&
          record.executorJobId === job.id &&
          sameCandidateArtifact(record.artifact, artifact)
      );
      if (candidate === undefined) {
        if (!taskCandidateArtifactIsVerified(artifact, verification)) {
          throw new Error(
            'Task terminal artifact must pass exact integrity verification before recording a Candidate'
          );
        }
        candidate = await service.create({
          workOrderId: workOrder.id,
          executorJobId: job.id,
          artifact,
        });
      }
      printTaskReport(workOrder, job, verification, json, candidate);
      if (verification === undefined || !verification.valid) process.exitCode = 1;
      return;
    } finally {
      await Promise.all([
        runtime?.close(),
        candidates?.close(),
        workOrders.store.close(),
      ]);
    }
  }

  if (command === 'task-review') {
    const reviewer = takeOption(args, '--reviewer');
    const summary = takeOption(args, '--summary');
    const selectedCandidateId = takeOption(args, '--candidate');
    const findingJson = takeOptions(args, '--finding-json');
    const json = takeFlag(args, '--json');
    const workOrderId = args.shift();
    if (!workOrderId || args.length > 0) {
      throw new Error('task-review requires exactly one WORK_ORDER_ID');
    }
    if (reviewer === undefined) throw new Error('task-review requires --reviewer NAME');
    if (summary === undefined) throw new Error('task-review requires --summary TEXT');
    const findings = findingJson.map((value, index) => parseReviewFindingJson(value, index));
    const workOrders = await openTaskWorkOrders(configPath);
    let candidates: SqliteCandidateStore | undefined;
    let reviews: SqliteReviewStore | undefined;
    try {
      candidates = await openTaskCandidates(configPath);
      reviews = await openTaskReviews(configPath);
      const workOrder = await workOrders.service.get(workOrderId);
      if (workOrder === undefined) {
        process.stderr.write('Task not found.\n');
        process.exitCode = 1;
        return;
      }
      const candidate = selectTaskReviewCandidate(
        await candidatesForWorkOrder(candidates, workOrder),
        selectedCandidateId
      );
      const review = await new ReviewService({ store: reviews, candidates }).create({
        candidateId: candidate.id,
        reviewer,
        summary,
        findings,
      });
      process.stdout.write(
        `${json ? formatTaskReviewJson(workOrder, candidate, review) : formatTaskReviewHuman(workOrder, review)}\n`
      );
      return;
    } finally {
      await Promise.all([
        reviews?.close(),
        candidates?.close(),
        workOrders.store.close(),
      ]);
    }
  }

  if (command === 'task-reviews') {
    const json = takeFlag(args, '--json');
    const workOrderId = args.shift();
    if (!workOrderId || args.length > 0) {
      throw new Error('task-reviews requires exactly one WORK_ORDER_ID');
    }
    const workOrders = await openTaskWorkOrders(configPath);
    let candidates: SqliteCandidateStore | undefined;
    let reviews: SqliteReviewStore | undefined;
    try {
      candidates = await openTaskCandidates(configPath);
      reviews = await openTaskReviews(configPath);
      const workOrder = await workOrders.service.get(workOrderId);
      if (workOrder === undefined) {
        process.stderr.write('Task not found.\n');
        process.exitCode = 1;
        return;
      }
      const taskCandidates = await candidatesForWorkOrder(candidates, workOrder);
      const candidateIds = new Set(taskCandidates.map((candidate) => candidate.id));
      const taskReviews = (await reviews.list()).filter((review) =>
        candidateIds.has(review.candidateId)
      );
      process.stdout.write(
        `${json ? formatTaskReviewsJson(workOrder, taskCandidates, taskReviews) : formatTaskReviewsHuman(workOrder, taskCandidates, taskReviews)}\n`
      );
      return;
    } finally {
      await Promise.all([
        reviews?.close(),
        candidates?.close(),
        workOrders.store.close(),
      ]);
    }
  }

  if (command === 'run') {
    const route = takeOption(args, '--route');
    const workspace = takeOption(args, '--workspace') ?? process.cwd();
    const source = takeOption(args, '--source') ?? 'cli';
    const callbackUrl = takeOption(args, '--callback');
    const idempotencyKey = takeOption(args, '--idempotency-key');
    const promptOption = takeOption(args, '--prompt');
    const json = takeFlag(args, '--json');
    const events = takeFlag(args, '--events');
    const progress = takeFlag(args, '--progress');
    if (args.some((value) => value.startsWith('--'))) throw new Error(`Unknown option: ${args.join(' ')}`);
    const prompt = promptOption ?? args.join(' ');
    const request: JobRequest = {
      prompt,
      workspace,
      source,
      ...(route === undefined ? {} : { route }),
      ...(callbackUrl === undefined ? {} : { callbackUrl }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };
    if (remote !== undefined) {
      if (events) throw new Error('--events is not available with a selected server; inspect persisted events');
      const initial = await remote.startJob(request);
      if (progress) process.stderr.write(`[agentknot] connected id=${initial.id} phase=${initial.status}\n`);
      const stopCancellation = cancelOnTermination(() => remote.cancelJob(initial.id));
      const job = await remote.waitForJob(initial, createWaitProgressReporter(progress)).finally(stopCancellation);
      if (!json) process.stdout.write(`\n${job.id}\t${job.status}\n`);
      else process.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
      if (job.status !== 'succeeded') process.exitCode = 1;
      return;
    }
    const runtime = await createRuntime({
      ...(configPath === undefined ? {} : { configPath }),
      onEvent: (event) => printEvent(event, json, events),
      reconcileOnStartup: true,
    });
    const started = await runtime
      .start(request)
      .catch(async (error: unknown) => {
        await runtime.close();
        throw error;
      });
    const stopCancellation = cancelOnTermination(started.cancel);
    const job = await started.completion.finally(async () => {
      stopCancellation();
      await runtime.close();
    });
    if (!json && !events) process.stdout.write('\n');
    if (json) process.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
    if (events) process.stdout.write(`${JSON.stringify({ type: 'job.snapshot', job })}\n`);
    if (job.status !== 'succeeded') process.exitCode = 1;
    return;
  }

  if (command === 'orchestrate') {
    const workspaceOption = takeOption(args, '--workspace');
    const sourceOption = takeOption(args, '--source');
    const promptOption = takeOption(args, '--prompt');
    const assessmentJson = takeOption(args, '--assessment-json');
    const requestFile = takeOption(args, '--request-file');
    const delegationOption = takeOption(args, '--delegation');
    const idempotencyKey = takeOption(args, '--idempotency-key');
    const suggest = takeFlag(args, '--suggest');
    const json = takeFlag(args, '--json');
    const handoffJson = takeFlag(args, '--handoff-json');
    const progress = takeFlag(args, '--progress');
    if (json && handoffJson) throw new Error('--json and --handoff-json cannot be used together');
    if (suggest && delegationOption !== undefined) {
      throw new Error('--suggest and --delegation cannot be used together');
    }
    const delegation = suggest ? 'suggest' : delegationOption;
    if (delegation !== undefined && !isOrchestrationDelegationOverride(delegation)) {
      throw new Error('--delegation must be inherit, never, suggest, or force');
    }
    let request: OrchestrationRequest;
    if (requestFile !== undefined) {
      const constructionFlags = [
        workspaceOption === undefined ? undefined : '--workspace',
        sourceOption === undefined ? undefined : '--source',
        promptOption === undefined ? undefined : '--prompt',
        assessmentJson === undefined ? undefined : '--assessment-json',
        delegationOption === undefined ? undefined : '--delegation',
        idempotencyKey === undefined ? undefined : '--idempotency-key',
        suggest ? '--suggest' : undefined,
      ].filter((value): value is string => value !== undefined);
      if (constructionFlags.length > 0) {
        throw new Error(
          `--request-file cannot be combined with request construction flags: ${constructionFlags.join(', ')}`
        );
      }
      if (args.some((value) => value.startsWith('--'))) {
        throw new Error(`Unknown option: ${args.join(' ')}`);
      }
      if (args.length > 0) {
        throw new Error('--request-file cannot be combined with positional prompts');
      }
      request = await readRequestFile(requestFile);
    } else {
      if (args.some((value) => value.startsWith('--'))) {
        throw new Error(`Unknown option: ${args.join(' ')}`);
      }
      if (assessmentJson === undefined) throw new Error('orchestrate requires --assessment-json');
      request = {
        prompt: promptOption ?? args.join(' '),
        workspace: workspaceOption ?? process.cwd(),
        source: sourceOption ?? 'cli',
        assessment: parseAssessmentJson(assessmentJson),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(delegation === undefined
          ? {}
          : { delegation }),
      };
    }
    if (remote !== undefined) {
      const initial = await remote.startOrchestration(request);
      if (progress) process.stderr.write(`[agentknot] connected id=${initial.id} phase=${initial.status}\n`);
      const stopCancellation = cancelOnTermination(() => remote.cancelOrchestration(initial.id));
      const orchestration = await remote
        .waitForOrchestration(initial, createWaitProgressReporter(progress))
        .finally(stopCancellation);
      const handoff = handoffJson
        ? await buildOrchestrationHandoff(remote, orchestration)
        : undefined;
      if (handoffJson) {
        process.stdout.write(`${JSON.stringify(handoff, null, 2)}\n`);
      } else if (json) {
        process.stdout.write(`${JSON.stringify(orchestration, null, 2)}\n`);
      } else {
        process.stdout.write(
          `\n${orchestration.id}\t${orchestration.status}\t${orchestration.result?.action ?? 'none'}\n`
        );
        for (const child of orchestration.children) {
          process.stdout.write(`${child.jobId}\t${child.status}\t${child.subtaskId}\n`);
        }
      }
      if (orchestration.status !== 'succeeded') process.exitCode = 1;
      return;
    }
    const runtime = await createRuntime({
      ...(configPath === undefined ? {} : { configPath }),
      onEvent: (event) => printEvent(event, json || handoffJson, false),
      reconcileOnStartup: true,
    });
    const started = await runtime.startOrchestration(request)
      .catch(async (error: unknown) => {
        await runtime.close();
        throw error;
      });
    const stopCancellation = cancelOnTermination(started.cancel);
    let orchestration!: OrchestrationRecord;
    let handoff: object | undefined;
    try {
      orchestration = await started.completion;
      if (handoffJson) handoff = await buildOrchestrationHandoff(runtime, orchestration);
    } finally {
      stopCancellation();
      await runtime.close();
    }
    if (handoffJson) {
      process.stdout.write(`${JSON.stringify(handoff, null, 2)}\n`);
    } else if (json) {
      process.stdout.write(`${JSON.stringify(orchestration, null, 2)}\n`);
    } else {
      process.stdout.write(
        `\n${orchestration.id}\t${orchestration.status}\t${orchestration.result?.action ?? 'none'}\n`
      );
      for (const child of orchestration.children) {
        process.stdout.write(`${child.jobId}\t${child.status}\t${child.subtaskId}\n`);
      }
    }
    if (orchestration.status !== 'succeeded') process.exitCode = 1;
    return;
  }

  if (command === 'serve') {
    await runBrokerForeground(args, configPath, explicitServerUrl, environmentServerUrl);
    return;
  }

  if (command === 'mcp') {
    if (configPath !== undefined || explicitServerUrl !== undefined) {
      throw new Error('mcp discovers the broker and does not accept --config or --server');
    }
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const handle = serveAgentKnotMcp();
    cancelOnTermination(() => handle.close(), 0);
    return;
  }

  if (command === 'broker') {
    if (explicitServerUrl !== undefined || environmentServerUrl !== undefined) {
      throw new Error('broker lifecycle commands cannot be used with --server');
    }
    const operation = args.shift();
    if (operation === 'run') {
      await runBrokerForeground(args, configPath, explicitServerUrl, environmentServerUrl);
      return;
    }
    const json = takeFlag(args, '--json');
    if (operation === 'up') {
      const portValue = takeOption(args, '--port') ?? '7391';
      const port = Number(portValue);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('--port must be 0-65535');
      }
      if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
      const result = await startBroker({
        cliEntryPath: fileURLToPath(import.meta.url),
        ...(configPath === undefined ? {} : { configPath }),
        port,
        rememberConfig: true,
      });
      process.stdout.write(
        json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `AgentKnot broker: ${result.action} (${result.broker.url}, pid ${result.broker.pid})\n`
      );
      return;
    }
    if (operation === 'start') {
      if (configPath !== undefined) throw new Error('broker start does not accept --config');
      if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
      const result = await startProfiledBroker({
        cliEntryPath: fileURLToPath(import.meta.url),
      });
      process.stdout.write(
        json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `AgentKnot broker: ${result.action} (${result.broker.url}, pid ${result.broker.pid})\n`
      );
      return;
    }
    if (operation === 'down') {
      if (configPath !== undefined) throw new Error('broker down does not accept --config');
      if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
      const result = await stopBroker();
      process.stdout.write(
        json ? `${JSON.stringify(result, null, 2)}\n` : `AgentKnot broker: ${result.action}\n`
      );
      return;
    }
    if (operation === 'status') {
      if (configPath !== undefined) throw new Error('broker status does not accept --config');
      if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
      const status = await readProfiledBrokerStatus();
      process.stdout.write(formatBrokerStatus(status, status.launchConfigured, json));
      if (status.state === 'unavailable') process.exitCode = 1;
      return;
    }
    throw new Error('broker requires run, up, start, down, or status');
  }

  if (command === 'client') {
    const json = takeFlag(args, '--json');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const report = await readClientStatus(configPath, explicitServerUrl, environmentServerUrl);
    printClientStatus(report, json);
    if (report.status === 'unavailable') process.exitCode = 1;
    return;
  }

  if (
    (command === 'doctor' || command === 'usage') &&
    (explicitServerUrl !== undefined || environmentServerUrl !== undefined)
  ) {
    throw new Error(`${command} is not available with --server`);
  }

  const runtime =
    remote === undefined
      ? await createRuntime({
          ...(configPath === undefined ? {} : { configPath }),
          reconcileOnStartup: false,
        })
      : undefined;

  if (command === 'doctor') {
    const route = takeOption(args, '--route');
    const live = takeFlag(args, '--live');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const result = await runtime!.doctor(route, { live });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'routes') {
    const json = takeFlag(args, '--json');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const routes = remote === undefined ? runtime!.routes() : await remote.routes();
    if (json) process.stdout.write(`${JSON.stringify(routes, null, 2)}\n`);
    else for (const route of routes) process.stdout.write(`${route.name}\t${route.worker}\t${route.provider}/${route.model}\n`);
    return;
  }

  if (command === 'jobs') {
    const json = takeFlag(args, '--json');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const page = remote === undefined ? buildJobList(await runtime!.list()) : await remote.listJobs();
    if (json) process.stdout.write(`${JSON.stringify(page)}\n`);
    else {
      for (const job of page.jobs) {
        process.stdout.write(`${job.id}\t${job.status}\t${job.route}\t${job.createdAt}\n`);
      }
      if (page.truncated) {
        process.stderr.write(`Showing ${page.jobs.length} of ${page.total} Jobs; inspect a known ID with agentknot show JOB_ID.\n`);
      }
    }
    return;
  }

  if (command === 'usage') {
    const json = takeFlag(args, '--json');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const report = await runtime!.usage();
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatUsageReport(report));
    return;
  }

  if (command === 'artifacts') {
    const id = args.shift();
    const json = takeFlag(args, '--json');
    if (!id || args.length > 0) throw new Error('artifacts requires exactly one JOB_ID');
    const artifacts =
      remote === undefined ? await runtime!.listArtifacts(id) : await remote.listArtifacts(id);
    if (!artifacts) {
      process.stderr.write(`Job not found: ${id}\n`);
      process.exitCode = 1;
      return;
    }
    if (json) process.stdout.write(`${JSON.stringify(artifacts, null, 2)}\n`);
    else {
      for (const artifact of artifacts.artifacts) {
        process.stdout.write(
          `${artifact.attempt}\t${artifact.kind}\t${artifact.size}\t${artifact.sha256}\t${artifact.baseCommit}\n`
        );
      }
    }
    return;
  }

  if (command === 'artifact-verify') {
    const id = args.shift();
    const json = takeFlag(args, '--json');
    if (!id || args.length > 0) throw new Error('artifact-verify requires exactly one JOB_ID');
    const verification =
      remote === undefined ? await runtime!.verifyArtifacts(id) : await remote.verifyArtifacts(id);
    if (!verification) {
      process.stderr.write(`Job not found: ${id}\n`);
      process.exitCode = 1;
      return;
    }
    if (json) process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
    else {
      for (const result of verification.artifacts) {
        process.stdout.write(
          `${result.artifact.attempt}\t${result.valid ? 'valid' : 'invalid'}\tsha256=${result.file.sha256Matches}\tbaseCommit=${result.source.headMatchesBase}\tissues=${result.issues.join(',') || 'none'}\n`
        );
      }
    }
    if (!verification.valid) process.exitCode = 1;
    return;
  }

  if (command === 'artifact-preview') {
    const id = args.shift();
    const attemptValue = args.shift();
    const json = takeFlag(args, '--json');
    if (!id || !attemptValue || args.length > 0) {
      throw new Error('artifact-preview requires JOB_ID and ATTEMPT');
    }
    const attempt = Number(attemptValue);
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('ATTEMPT must be a positive integer');
    const preview =
      remote === undefined
        ? await runtime!.previewArtifact(id, attempt)
        : await remote.previewArtifact(id, attempt);
    if (!preview) {
      process.stderr.write(`Artifact not found: ${id} attempt ${attempt}\n`);
      process.exitCode = 1;
      return;
    }
    if (json) process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    else if (preview.content !== null) process.stdout.write(preview.content);
    else process.stderr.write(`Artifact preview withheld: ${preview.verification.issues.join(', ')}\n`);
    if (!preview.verification.valid) process.exitCode = 1;
    return;
  }

  if (command === 'delegation') {
    const json = takeFlag(args, '--json');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const policy =
      remote === undefined ? runtime!.delegationPolicy() : await remote.delegationPolicy();
    if (json) process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
    else {
      process.stdout.write(
        `${policy.mode}\tworker-default=${policy.dispatch.defaultRoute}\treviewer=${policy.qualityReview?.route ?? 'off'}\troute-selection=${policy.dispatch.routeSelection?.mode ?? 'off'}\tchildren<=${policy.dispatch.maxChildren}\tconcurrency<=${policy.dispatch.maxConcurrency}\n`
      );
    }
    return;
  }

  if (command === 'orchestrations') {
    const json = takeFlag(args, '--json');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const orchestrations =
      remote === undefined
        ? await runtime!.listOrchestrations()
        : await remote.listOrchestrations();
    if (json) process.stdout.write(`${JSON.stringify(orchestrations, null, 2)}\n`);
    else {
      for (const orchestration of orchestrations) {
        process.stdout.write(
          `${orchestration.id}\t${orchestration.status}\t${orchestration.result?.action ?? 'none'}\t${orchestration.createdAt}\n`
        );
      }
    }
    return;
  }

  if (command === 'orchestration-show') {
    const id = args.shift();
    if (!id || args.length > 0) {
      throw new Error('orchestration-show requires exactly one ORCHESTRATION_ID');
    }
    const orchestration =
      remote === undefined
        ? await runtime!.getOrchestration(id)
        : await remote.getOrchestration(id);
    if (!orchestration) {
      process.stderr.write(`Orchestration not found: ${id}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(orchestration, null, 2)}\n`);
    return;
  }

  if (command === 'show') {
    const id = args.shift();
    if (!id || args.length > 0) throw new Error('show requires exactly one JOB_ID');
    const job = remote === undefined ? await runtime!.get(id) : await remote.getJob(id);
    if (!job) {
      process.stderr.write(`Job not found: ${id}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command "${command}"\n\n${help()}`);
}

void main(process.argv.slice(2)).catch(async (error: unknown) => {
  await writeStartupFailureReport(error);
  process.stderr.write(`agentknot: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

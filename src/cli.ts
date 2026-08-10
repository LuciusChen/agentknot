#!/usr/bin/env node

import process from 'node:process';

import { AgentKnotHttpClient } from './http-client.js';
import { createAgentKnotHttpServer } from './http-server.js';
import {
  createLocalDiscoveryRegistration,
  readLocalDiscovery,
  type LocalDiscoveryRegistration,
} from './local-discovery.js';
import type { OrchestrationRecord } from './orchestration-types.js';
import { limitTextSuffix } from './record-limits.js';
import { createRuntime, type AgentKnotRuntime } from './runtime.js';
import type { JobEvent, JobRequest } from './types.js';
import type { RouteSelectionModeUsage, UsageRate, UsageReport } from './usage-report.js';

const MAX_HANDOFF_VALIDATION_STREAM_BYTES = 2 * 1024;

function compactArtifactValidation(
  value: OrchestrationRecord['artifactValidation']
): OrchestrationRecord['artifactValidation'] | object {
  if (value === undefined || !('command' in value) || value.command === undefined) return value;
  const command = value.command;
  return {
    ...value,
    command: {
      argv: command.argv,
      outcome: command.outcome,
      exitCode: command.exitCode,
      signal: command.signal,
      durationMs: command.durationMs,
      stdoutTail: limitTextSuffix(command.stdout, MAX_HANDOFF_VALIDATION_STREAM_BYTES),
      stderrTail: limitTextSuffix(command.stderr, MAX_HANDOFF_VALIDATION_STREAM_BYTES),
      outputTruncated: command.outputTruncated,
      maxOutputBytes: command.maxOutputBytes,
    },
  };
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

function help(): string {
  return `AgentKnot — vendor-neutral coding-agent orchestration

Usage:
  agentknot run [prompt...] [--route NAME] [--workspace PATH] [--source NAME]
  agentknot orchestrate [prompt...] [--workspace PATH] [--source NAME] [--delegation MODE]
  agentknot serve [--host HOST] [--port PORT]
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

Run options:
  --prompt TEXT       Prompt instead of positional text
  --route NAME        Worker/provider/model route
  --workspace PATH    Worker working directory (default: current directory)
  --source NAME       Controller identity, e.g. codex or claude
  --callback URL      POST the terminal Job record to this URL
  --json              Print only the final Job record as JSON
  --events            Stream every event as JSONL

Orchestrate options:
  --prompt TEXT       Goal instead of positional text
  --workspace PATH    Target repository (default: current directory)
  --source NAME       Controller identity, e.g. codex, claude, or ci
  --delegation MODE   inherit, never, suggest, or force (default: inherit)
  --suggest           Alias for --delegation suggest
  --json              Print the terminal orchestration record as JSON
  --handoff-json      Print compact terminal/controller handoff JSON

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
      'Downstream stats',
      `${formatCount(report.scope.statsAvailableJobs)} / ${formatCount(report.scope.successfulJobs)} (${formatShare(report.scope.statsAvailableJobs, report.scope.successfulJobs)})`
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
        `${formatCount(report.scope.statsUnavailableJobs)} (${report.downstream.unavailable.map((item) => `${item.reason}: ${formatCount(item.count)}`).join(', ')})`
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

async function orchestrationHandoff(
  runtime: Pick<AgentKnotRuntime, 'verifyArtifacts'>,
  record: OrchestrationRecord
): Promise<object> {
  const artifacts = await Promise.all(
    record.children.map(async (child) => {
      const verification = await runtime.verifyArtifacts(child.jobId);
      if (verification === undefined) return { jobId: child.jobId, status: 'unavailable' };
      return {
        jobId: child.jobId,
        status: 'verified',
        valid: verification.valid,
        attempts: verification.artifacts.map((attempt) => ({
          attempt: attempt.artifact.attempt,
          size: attempt.artifact.size,
          sha256: attempt.artifact.sha256,
          baseCommit: attempt.artifact.baseCommit,
          changedFiles: attempt.artifact.changedFiles,
          valid: attempt.valid,
          issues: attempt.issues,
          file: {
            exists: attempt.file.exists,
            actualSize: attempt.file.actualSize,
            sizeMatches: attempt.file.sizeMatches,
            actualSha256: attempt.file.actualSha256,
            sha256Matches: attempt.file.sha256Matches,
          },
          source: {
            repositoryAvailable: attempt.source.repositoryAvailable,
            actualHead: attempt.source.actualHead,
            headMatchesBase: attempt.source.headMatchesBase,
          },
        })),
      };
    })
  );
  const artifactValidation = compactArtifactValidation(record.artifactValidation);
  return {
    schemaVersion: record.schemaVersion,
    id: record.id,
    status: record.status,
    request: {
      source: record.request.source,
      delegation: record.request.delegation,
    },
    plannerJobId: record.plannerJobId,
    plan:
      record.plan === undefined
        ? undefined
        : {
            policyVersion: record.plan.policyVersion,
            planHash: record.plan.planHash,
            mode: record.plan.mode,
            decision: record.plan.decision,
            willDispatch: record.plan.willDispatch,
            reasoning: record.plan.reasoning,
            assessment: {
              recommendation: record.plan.assessment.recommendation,
              complexity: record.plan.assessment.complexity,
              parallelizable: record.plan.assessment.parallelizable,
              taskKinds: record.plan.assessment.taskKinds,
            },
            subtasks: record.plan.subtasks.map((subtask) => ({
              id: subtask.id,
              title: subtask.title,
              kind: subtask.kind,
              route: subtask.route,
              routeSelection: subtask.routeSelection,
            })),
            plannerError: record.plan.plannerError,
          },
    children: record.children.map((child) => ({
      subtaskId: child.subtaskId,
      jobId: child.jobId,
      status: child.status,
      route: child.route,
      routePoolSelection: child.routePoolSelection,
      output: child.output,
      error: child.error,
    })),
    qualityReview: record.qualityReview,
    artifactValidation,
    artifacts,
    result:
      record.result === undefined
        ? undefined
        : {
            action: record.result.action,
            artifactReview: record.result.artifactReview,
          },
    error: record.error,
  };
}

function cancelOnTermination(cancel: () => void | Promise<void>): () => void {
  let requested = false;
  const onSignal = () => {
    if (requested) return;
    requested = true;
    process.exitCode = 1;
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

  if (command === 'run') {
    const route = takeOption(args, '--route');
    const workspace = takeOption(args, '--workspace') ?? process.cwd();
    const source = takeOption(args, '--source') ?? 'cli';
    const callbackUrl = takeOption(args, '--callback');
    const promptOption = takeOption(args, '--prompt');
    const json = takeFlag(args, '--json');
    const events = takeFlag(args, '--events');
    if (args.some((value) => value.startsWith('--'))) throw new Error(`Unknown option: ${args.join(' ')}`);
    const prompt = promptOption ?? args.join(' ');
    const request: JobRequest = {
      prompt,
      workspace,
      source,
      ...(route === undefined ? {} : { route }),
      ...(callbackUrl === undefined ? {} : { callbackUrl }),
    };
    if (remote !== undefined) {
      if (events) throw new Error('--events is not available with a selected server; inspect persisted events');
      const initial = await remote.startJob(request);
      const stopCancellation = cancelOnTermination(() => remote.cancelJob(initial.id));
      const job = await remote.waitForJob(initial).finally(stopCancellation);
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
    const workspace = takeOption(args, '--workspace') ?? process.cwd();
    const source = takeOption(args, '--source') ?? 'cli';
    const promptOption = takeOption(args, '--prompt');
    const delegationOption = takeOption(args, '--delegation');
    const suggest = takeFlag(args, '--suggest');
    const json = takeFlag(args, '--json');
    const handoffJson = takeFlag(args, '--handoff-json');
    if (json && handoffJson) throw new Error('--json and --handoff-json cannot be used together');
    if (suggest && delegationOption !== undefined) {
      throw new Error('--suggest and --delegation cannot be used together');
    }
    const delegation = suggest ? 'suggest' : delegationOption;
    if (delegation !== undefined && !['inherit', 'never', 'suggest', 'force'].includes(delegation)) {
      throw new Error('--delegation must be inherit, never, suggest, or force');
    }
    if (args.some((value) => value.startsWith('--'))) throw new Error(`Unknown option: ${args.join(' ')}`);
    const prompt = promptOption ?? args.join(' ');
    const request = {
      prompt,
      workspace,
      source,
      ...(delegation === undefined
        ? {}
        : { delegation: delegation as 'inherit' | 'never' | 'suggest' | 'force' }),
    };
    if (remote !== undefined) {
      const initial = await remote.startOrchestration(request);
      const stopCancellation = cancelOnTermination(() => remote.cancelOrchestration(initial.id));
      const orchestration = await remote.waitForOrchestration(initial).finally(stopCancellation);
      const handoff = handoffJson
        ? await orchestrationHandoff(remote, orchestration)
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
      if (handoffJson) handoff = await orchestrationHandoff(runtime, orchestration);
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
    if (explicitServerUrl !== undefined || environmentServerUrl !== undefined) {
      throw new Error('serve cannot be used with --server');
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
      http = createAgentKnotHttpServer(runtime);
      const address = await http.listen(port, host);
      if (discovery !== undefined) await discovery.publish(address.port);
      cancelOnTermination(() => closeServeResources(http, runtime, discovery));
      process.stdout.write(`AgentKnot listening on http://${address.host}:${address.port}\n`);
    } catch (error: unknown) {
      try {
        await closeServeResources(http, runtime, discovery);
      } catch (cleanupError: unknown) {
        throw new AggregateError([error, cleanupError], 'AgentKnot serve startup cleanup failed');
      }
      throw error;
    }
    return;
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
    const jobs = remote === undefined ? await runtime!.list() : await remote.listJobs();
    if (json) process.stdout.write(`${JSON.stringify(jobs, null, 2)}\n`);
    else for (const job of jobs) process.stdout.write(`${job.id}\t${job.status}\t${job.route.name}\t${job.createdAt}\n`);
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
        `${policy.mode}\tplanner=${policy.planner.route}\tworker-default=${policy.dispatch.defaultRoute}\treviewer=${policy.qualityReview?.route ?? 'off'}\troute-selection=${policy.dispatch.routeSelection?.mode ?? 'off'}\tchildren<=${policy.dispatch.maxChildren}\tconcurrency<=${policy.dispatch.maxConcurrency}\n`
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

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`agentknot: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

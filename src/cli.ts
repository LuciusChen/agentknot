#!/usr/bin/env node

import process from 'node:process';

import { createAgentKnotHttpServer } from './http-server.js';
import type { OrchestrationRecord } from './orchestration-types.js';
import { createRuntime, type AgentKnotRuntime } from './runtime.js';
import type { JobEvent } from './types.js';
import type { RouteSelectionModeUsage, UsageRate, UsageReport } from './usage-report.js';

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
  agentknot orchestrations [--json]
  agentknot orchestration-show ORCHESTRATION_ID

Global options:
  --config PATH       Configuration file (default: agentknot.config.json)

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
    ? `${(value.value * 100).toFixed(2)}% (${value.formula})`
    : `unavailable reason=${value.reason} (${value.formula})`;
}

function formatRouteMode(mode: string, value: RouteSelectionModeUsage): string {
  const selections = value.selections
    .map((selection) =>
      selection.basis === 'rule'
        ? `rule[${selection.ruleIndex}]=${selection.route}:${selection.count}`
        : `default=${selection.route}:${selection.count}`
    )
    .join(',');
  return `route-${mode} classified=${value.classifiedSelections} rule-hits=${value.ruleHits} defaults=${value.defaultSelections} hit-rate=${formatRate(value.ruleHitRate)}${selections === '' ? '' : ` selections=${selections}`}`;
}

function formatUsageReport(report: UsageReport): string {
  const lines = [
    `scope jobs=${report.scope.totalJobs} successful=${report.scope.successfulJobs} stats=${report.scope.statsAvailableJobs} stats-unavailable=${report.scope.statsUnavailableJobs} orchestrations=${report.scope.terminalOrchestrations} subtasks=${report.scope.plannedSubtasks}`,
  ];
  if (report.downstream.status === 'available') {
    lines.push(
      `downstream status=available coverage=${report.downstream.coverage}`,
      `tokens input=${report.downstream.tokens.input} output=${report.downstream.tokens.output} cache-read=${report.downstream.tokens.cacheRead} cache-write=${report.downstream.tokens.cacheWrite} total=${report.downstream.tokens.total}`,
      `provider-reported-cost=${report.downstream.providerReportedCost}`,
      `cache-read-hit-rate=${formatRate(report.downstream.cacheReadHitRate)}`
    );
  } else {
    lines.push(`downstream status=unavailable reason=${report.downstream.reason}`);
  }
  if (report.downstream.unavailable.length > 0) {
    lines.push(
      `stats-unavailable-reasons=${report.downstream.unavailable.map((item) => `${item.reason}:${item.count}`).join(',')}`
    );
  }
  lines.push(
    report.routeSelection.status === 'available'
      ? `route-selection status=available coverage=${report.routeSelection.coverage} classified=${report.routeSelection.classifiedSelections} unavailable=${report.routeSelection.unavailableSelections}`
      : `route-selection status=unavailable reason=${report.routeSelection.reason} unavailable=${report.routeSelection.unavailableSelections}`
  );
  if (report.routeSelection.active.classifiedSelections > 0) {
    lines.push(formatRouteMode('active', report.routeSelection.active));
  }
  if (report.routeSelection.shadow.classifiedSelections > 0) {
    lines.push(formatRouteMode('shadow', report.routeSelection.shadow));
  }
  lines.push(
    `upstream=unavailable reason=${report.upstream.reason}`,
    `proportions=unavailable reason=${report.proportions.reason}`
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
      output: child.output,
      error: child.error,
    })),
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

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(help());
    return;
  }

  const configPath = takeOption(args, '--config');

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
    const runtime = await createRuntime({
      ...(configPath === undefined ? {} : { configPath }),
      onEvent: (event) => printEvent(event, json, events),
      reconcileOnStartup: true,
    });
    const started = await runtime
      .start({
        prompt,
        workspace,
        source,
        ...(route === undefined ? {} : { route }),
        ...(callbackUrl === undefined ? {} : { callbackUrl }),
      })
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
    const runtime = await createRuntime({
      ...(configPath === undefined ? {} : { configPath }),
      onEvent: (event) => printEvent(event, json || handoffJson, false),
      reconcileOnStartup: true,
    });
    const started = await runtime
      .startOrchestration({
        prompt,
        workspace,
        source,
        ...(delegation === undefined
          ? {}
          : { delegation: delegation as 'inherit' | 'never' | 'suggest' | 'force' }),
      })
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
    const host = takeOption(args, '--host') ?? '127.0.0.1';
    const portValue = takeOption(args, '--port') ?? '7391';
    const port = Number(portValue);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const runtime = await createRuntime({
      ...(configPath === undefined ? {} : { configPath }),
      reconcileOnStartup: true,
    });
    const http = createAgentKnotHttpServer(runtime);
    const address = await http.listen(port, host).catch(async (error: unknown) => {
      await runtime.close();
      throw error;
    });
    cancelOnTermination(async () => {
      try {
        await http.close();
      } finally {
        await runtime.close();
      }
    });
    process.stdout.write(`AgentKnot listening on http://${address.host}:${address.port}\n`);
    return;
  }

  const runtime = await createRuntime({
    ...(configPath === undefined ? {} : { configPath }),
    reconcileOnStartup: false,
  });

  if (command === 'doctor') {
    const route = takeOption(args, '--route');
    const live = takeFlag(args, '--live');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const result = await runtime.doctor(route, { live });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'routes') {
    const json = takeFlag(args, '--json');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const routes = runtime.routes();
    if (json) process.stdout.write(`${JSON.stringify(routes, null, 2)}\n`);
    else for (const route of routes) process.stdout.write(`${route.name}\t${route.worker}\t${route.provider}/${route.model}\n`);
    return;
  }

  if (command === 'jobs') {
    const json = takeFlag(args, '--json');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const jobs = await runtime.list();
    if (json) process.stdout.write(`${JSON.stringify(jobs, null, 2)}\n`);
    else for (const job of jobs) process.stdout.write(`${job.id}\t${job.status}\t${job.route.name}\t${job.createdAt}\n`);
    return;
  }

  if (command === 'usage') {
    const json = takeFlag(args, '--json');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const report = await runtime.usage();
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatUsageReport(report));
    return;
  }

  if (command === 'artifacts') {
    const id = args.shift();
    const json = takeFlag(args, '--json');
    if (!id || args.length > 0) throw new Error('artifacts requires exactly one JOB_ID');
    const artifacts = await runtime.listArtifacts(id);
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
    const verification = await runtime.verifyArtifacts(id);
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
    const preview = await runtime.previewArtifact(id, attempt);
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
    const policy = runtime.delegationPolicy();
    if (json) process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
    else {
      process.stdout.write(
        `${policy.mode}\tplanner=${policy.planner.route}\tworker-default=${policy.dispatch.defaultRoute}\troute-selection=${policy.dispatch.routeSelection?.mode ?? 'off'}\tchildren<=${policy.dispatch.maxChildren}\tconcurrency<=${policy.dispatch.maxConcurrency}\n`
      );
    }
    return;
  }

  if (command === 'orchestrations') {
    const json = takeFlag(args, '--json');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const orchestrations = await runtime.listOrchestrations();
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
    const orchestration = await runtime.getOrchestration(id);
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
    const job = await runtime.get(id);
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

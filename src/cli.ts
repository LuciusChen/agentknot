#!/usr/bin/env node

import process from 'node:process';

import { createAgentKnotHttpServer } from './http-server.js';
import { createRuntime } from './runtime.js';
import type { JobEvent } from './types.js';

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

Doctor options:
  --route NAME        Exact configured route to diagnose
  --live              Perform one real inference probe; no fallback
`;
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
    });
    const job = await runtime.run({
      prompt,
      workspace,
      source,
      ...(route === undefined ? {} : { route }),
      ...(callbackUrl === undefined ? {} : { callbackUrl }),
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
      onEvent: (event) => printEvent(event, json, false),
    });
    const orchestration = await runtime.orchestrate({
      prompt,
      workspace,
      source,
      ...(delegation === undefined
        ? {}
        : { delegation: delegation as 'inherit' | 'never' | 'suggest' | 'force' }),
    });
    if (json) {
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

  const runtime = await createRuntime(configPath === undefined ? {} : { configPath });

  if (command === 'serve') {
    const host = takeOption(args, '--host') ?? '127.0.0.1';
    const portValue = takeOption(args, '--port') ?? '7391';
    const port = Number(portValue);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535');
    if (args.length > 0) throw new Error(`Unknown option: ${args.join(' ')}`);
    const http = createAgentKnotHttpServer(runtime);
    const address = await http.listen(port, host);
    process.stdout.write(`AgentKnot listening on http://${address.host}:${address.port}\n`);
    return;
  }

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
        `${policy.mode}\tplanner=${policy.planner.route}\tworker=${policy.dispatch.defaultRoute}\tchildren<=${policy.dispatch.maxChildren}\tconcurrency<=${policy.dispatch.maxConcurrency}\n`
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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { OpenCodeJsonWorkerConfig } from '../config.js';
import { MAX_WORKER_STDERR_BYTES, limitTextSuffix } from '../record-limits.js';
import type {
  ResolvedRoute,
  WorkerAdapter,
  WorkerEventSink,
  WorkerHealth,
  WorkerProbeInput,
  WorkerProbeResult,
  WorkerRunInput,
  WorkerRunResult,
} from '../types.js';
import {
  parseRequiredWorkerCompletionOutput,
  WORKER_COMPLETION_REPORT_INSTRUCTION,
} from '../worker-completion-report.js';
import {
  awaitChildOutput,
  effectiveEnvironment,
  findCommand,
  StrictJsonlDecoder,
  terminateChild,
  waitForExit,
  waitForSpawn,
  type EffectiveEnvironment,
} from './subprocess.js';

interface OpenCodeEvent extends Record<string, unknown> {
  type: string;
  part?: Record<string, unknown>;
  error?: unknown;
}

interface SessionStats {
  toolCalls: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

type AuthStatus = {
  path: string;
  credential: boolean;
  secure: boolean;
};

const LIVE_PROBE_PROMPT =
  'This is a bounded AgentKnot live inference probe. Reply with exactly "AgentKnot live inference probe succeeded." and do not use tools or modify files.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCredentialValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some((item) => hasCredentialValue(item));
  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([key]) => key !== 'type' && key !== 'env')
      .some(([, item]) => hasCredentialValue(item));
  }
  return false;
}

function effectiveHomeDirectory(environment: EffectiveEnvironment): string {
  if (process.platform === 'win32') return environment.USERPROFILE || os.homedir();
  return environment.HOME || os.homedir();
}

function openCodeAuthPath(environment: EffectiveEnvironment): string {
  const dataDirectory =
    environment.XDG_DATA_HOME || path.join(effectiveHomeDirectory(environment), '.local', 'share');
  return path.join(dataDirectory, 'opencode', 'auth.json');
}

async function openCodeAuthStatus(
  provider: string,
  environment: EffectiveEnvironment
): Promise<AuthStatus> {
  const authPath = openCodeAuthPath(environment);
  try {
    const [contents, file] = await Promise.all([readFile(authPath, 'utf8'), stat(authPath)]);
    const value: unknown = JSON.parse(contents);
    const credential = isRecord(value) && provider in value && hasCredentialValue(value[provider]);
    const secure = process.platform === 'win32' || (file.mode & 0o077) === 0;
    return { path: authPath, credential, secure };
  } catch {
    return { path: authPath, credential: false, secure: false };
  }
}

function parseEvent(line: string, lineNumber: number): OpenCodeEvent {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || typeof value.type !== 'string') {
      throw new Error('expected an object with a string type');
    }
    return value as OpenCodeEvent;
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new Error(`OpenCode emitted malformed JSONL at line ${lineNumber}: ${cause.message}`, {
      cause,
    });
  }
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function addSafe(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error('OpenCode session statistics overflowed');
  return value;
}

function addStepStats(current: SessionStats, part: Record<string, unknown>): SessionStats {
  const tokens = part.tokens;
  if (!isRecord(tokens) || !isRecord(tokens.cache)) {
    throw new Error('OpenCode step_finish contained invalid token statistics');
  }
  const input = tokens.input;
  const output = tokens.output;
  const total = tokens.total;
  const cacheRead = tokens.cache.read;
  const cacheWrite = tokens.cache.write;
  const cost = part.cost;
  if (
    !nonNegativeInteger(input) ||
    !nonNegativeInteger(output) ||
    !nonNegativeInteger(total) ||
    !nonNegativeInteger(cacheRead) ||
    !nonNegativeInteger(cacheWrite) ||
    !nonNegativeNumber(cost)
  ) {
    throw new Error('OpenCode step_finish contained invalid token statistics');
  }
  return {
    toolCalls: current.toolCalls,
    tokens: {
      input: addSafe(current.tokens.input, input),
      output: addSafe(current.tokens.output, output),
      cacheRead: addSafe(current.tokens.cacheRead, cacheRead),
      cacheWrite: addSafe(current.tokens.cacheWrite, cacheWrite),
      total: addSafe(current.tokens.total, total),
    },
    cost: current.cost + cost,
  };
}

function formatWorkerError(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') {
    return limitTextSuffix(value, MAX_WORKER_STDERR_BYTES);
  }
  if (isRecord(value)) {
    if (typeof value.message === 'string' && value.message.trim() !== '') {
      return limitTextSuffix(value.message, MAX_WORKER_STDERR_BYTES);
    }
    if (isRecord(value.data) && typeof value.data.message === 'string' && value.data.message.trim() !== '') {
      return limitTextSuffix(value.data.message, MAX_WORKER_STDERR_BYTES);
    }
  }
  try {
    return `OpenCode reported an error: ${JSON.stringify(value)}`;
  } catch {
    return 'OpenCode reported an error';
  }
}

function argsFor(
  config: OpenCodeJsonWorkerConfig,
  route: ResolvedRoute,
  workspace: string,
  prompt: string
): string[] {
  return [
    ...(config.commandArgs ?? []),
    'run',
    '--pure',
    '--format',
    'json',
    '--model',
    `${route.provider}/${route.model}`,
    ...(route.thinkingLevel ? ['--variant', route.thinkingLevel] : []),
    '--dir',
    workspace,
    prompt,
  ];
}

function workerEnvironment(config: OpenCodeJsonWorkerConfig): EffectiveEnvironment {
  const environment = effectiveEnvironment(config.environment);
  for (const name of config.unsetEnvironment ?? []) delete environment[name];
  return environment;
}

type ExitResult = { code: number | null; signal: NodeJS.Signals | null };

function childExitResult(child: ChildProcessWithoutNullStreams): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
}

export class OpenCodeJsonWorkerAdapter implements WorkerAdapter {
  readonly name: string;

  constructor(
    name: string,
    readonly config: OpenCodeJsonWorkerConfig
  ) {
    this.name = name;
  }

  async doctor(route: ResolvedRoute): Promise<WorkerHealth> {
    const environment = workerEnvironment(this.config);
    const command = this.config.command ?? 'opencode';
    const resolvedCommand = await findCommand(command, environment);
    const auth = await openCodeAuthStatus(route.provider, environment);
    const missingEnvironment = route.requiredEnv.filter((name) => !environment[name]?.trim());
    const environmentCredential = route.requiredEnv.length > 0 && missingEnvironment.length === 0;
    const authFileCredential = auth.credential && auth.secure;
    if (!resolvedCommand || missingEnvironment.length > 0 || (!authFileCredential && !environmentCredential)) {
      const problems = [
        resolvedCommand ? undefined : `Command "${command}" was not found`,
        missingEnvironment.length > 0
          ? `Missing environment: ${missingEnvironment.join(', ')}`
          : undefined,
        auth.credential && !auth.secure ? `OpenCode auth file is not private: ${auth.path}` : undefined,
        !authFileCredential && !environmentCredential && !(auth.credential && !auth.secure)
          ? `No OpenCode credential found for provider "${route.provider}"`
          : undefined,
      ].filter((item): item is string => item !== undefined);
      return {
        ok: false,
        message: problems.join('; '),
        details: {
          command,
          resolvedCommand,
          missingEnvironment,
          authFileCredential,
          authFileSecure: auth.secure,
        },
      };
    }
    return {
      ok: true,
      message: `OpenCode JSON is ready for ${route.provider}/${route.model}`,
      details: {
        command: resolvedCommand,
        credentialSource: authFileCredential ? 'opencode-auth-file' : 'environment',
      },
    };
  }

  async probe(input: WorkerProbeInput): Promise<WorkerProbeResult> {
    if (input.signal.aborted) throw input.signal.reason;
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-opencode-live-probe-'));
    try {
      const result = await this.#execute(
        input.route,
        workspace,
        LIVE_PROBE_PROMPT,
        input.signal,
        () => undefined
      );
      return { output: result.output, metadata: result.metadata };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    if (input.signal.aborted) throw input.signal.reason;
    const prompt = `${input.prompt}\n\n${WORKER_COMPLETION_REPORT_INSTRUCTION}`;
    const result = await this.#execute(input.route, input.workspace, prompt, input.signal, emit, input.attempt);
    const parsed = parseRequiredWorkerCompletionOutput(result.output, 'OpenCode');
    return {
      output: parsed.output,
      completionReport: parsed.completionReport,
      metadata: result.metadata,
    };
  }

  async #execute(
    route: ResolvedRoute,
    workspace: string,
    prompt: string,
    signal: AbortSignal,
    emit: WorkerEventSink,
    attempt = 1
  ): Promise<{ output: string; metadata: Record<string, unknown> }> {
    if (signal.aborted) throw signal.reason;
    const health = await this.doctor(route);
    if (!health.ok) throw new Error(health.message);

    const command = this.config.command ?? 'opencode';
    const environment = workerEnvironment(this.config);
    const child = spawn(command, argsFor(this.config, route, workspace, prompt), {
      cwd: workspace,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exit = waitForExit(child);
    const exitResult = childExitResult(child);
    let output = '';
    let stderr = '';
    let rawEventCount = 0;
    let stepFinished = false;
    let started = false;
    let sessionStats: SessionStats = {
      toolCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    };

    const handleEvent = async (event: OpenCodeEvent): Promise<void> => {
      rawEventCount += 1;
      switch (event.type) {
        case 'step_start':
          if (!started) {
            started = true;
            await emit('worker.started', { adapter: 'opencode-json', attempt });
          }
          break;
        case 'text': {
          const text = event.part?.text;
          if (typeof text !== 'string') throw new Error('OpenCode text event did not contain part.text');
          output += text;
          await emit('worker.text.delta', { delta: text });
          break;
        }
        case 'tool_use':
          sessionStats = { ...sessionStats, toolCalls: addSafe(sessionStats.toolCalls, 1) };
          await emit('worker.tool.completed', {
            toolCallId: event.part?.callID,
            toolName: event.part?.tool,
            result: event.part?.state,
          });
          break;
        case 'step_finish':
          if (!event.part) throw new Error('OpenCode step_finish did not contain part');
          sessionStats = addStepStats(sessionStats, event.part);
          stepFinished = true;
          break;
        case 'error':
          throw new Error(formatWorkerError(event.error));
        case 'reasoning':
          break;
        default:
          await emit('worker.raw', { event });
      }
    };

    const stdoutTask = (async () => {
      const decoder = new StrictJsonlDecoder();
      let lineNumber = 0;
      for await (const chunk of child.stdout) {
        for (const line of decoder.push(Buffer.from(chunk))) {
          lineNumber += 1;
          await handleEvent(parseEvent(line, lineNumber));
        }
      }
      for (const line of decoder.end()) {
        lineNumber += 1;
        await handleEvent(parseEvent(line, lineNumber));
      }
    })();
    const stderrTask = (async () => {
      const decoder = new StringDecoder('utf8');
      const record = async (text: string): Promise<void> => {
        if (text === '') return;
        stderr = limitTextSuffix(`${stderr}${text}`, MAX_WORKER_STDERR_BYTES);
        await emit('worker.stderr', { text });
      };
      for await (const chunk of child.stderr) await record(decoder.write(Buffer.from(chunk)));
      await record(decoder.end());
    })();
    void stdoutTask.catch(() => undefined);
    void stderrTask.catch(() => undefined);

    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => rejectAbort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();

    try {
      await waitForSpawn(child);
      child.stdin.end();
      const result = await Promise.race([
        exitResult,
        stdoutTask.then<never>(() => new Promise<never>(() => undefined)),
        stderrTask.then<never>(() => new Promise<never>(() => undefined)),
        aborted,
      ]);
      await stdoutTask;
      await stderrTask;
      if (signal.aborted) throw signal.reason;
      if (result.code !== 0) {
        throw new Error(
          `OpenCode exited before successful settlement (code=${String(result.code)}, signal=${String(result.signal)})${
            stderr.trim() === '' ? '' : `: ${stderr.trim()}`
          }`
        );
      }
      if (!stepFinished) throw new Error('OpenCode exited without a step_finish event');
      return {
        output,
        metadata: {
          command,
          rawEventCount,
          stderr: stderr.trim() || undefined,
          ambientDiscoveryDisabled: true,
          sessionStats,
        },
      };
    } finally {
      signal.removeEventListener('abort', abort);
      await terminateChild(child, exit);
      await awaitChildOutput(child, stdoutTask, stderrTask);
    }
  }
}

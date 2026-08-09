import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { validateWorkerCompletionReport } from '../completion-summary.js';
import type { PiRpcWorkerConfig } from '../config.js';
import type {
  ResolvedRoute,
  WorkerAdapter,
  WorkerCompletionReport,
  WorkerEventSink,
  WorkerHealth,
  WorkerProbeInput,
  WorkerProbeResult,
  WorkerRunInput,
  WorkerRunResult,
} from '../types.js';

interface PiRpcEvent {
  id?: string;
  type?: string;
  success?: boolean;
  command?: string;
  error?: string;
  data?: unknown;
  message?: unknown;
  messages?: unknown[];
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
    toolCall?: { id?: string; name?: string; arguments?: unknown };
  };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  attempt?: number;
  delayMs?: number;
}

class StrictJsonlDecoder {
  readonly #decoder = new StringDecoder('utf8');
  #buffer = '';

  push(chunk: Buffer): string[] {
    this.#buffer += this.#decoder.write(chunk);
    return this.#takeLines();
  }

  end(): string[] {
    this.#buffer += this.#decoder.end();
    const lines = this.#takeLines();
    if (this.#buffer !== '') {
      lines.push(this.#buffer.endsWith('\r') ? this.#buffer.slice(0, -1) : this.#buffer);
      this.#buffer = '';
    }
    return lines;
  }

  #takeLines(): string[] {
    const lines: string[] = [];
    let index: number;
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      let line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line !== '') lines.push(line);
    }
    return lines;
  }
}

type EffectiveEnvironment = NodeJS.ProcessEnv;

function effectiveEnvironment(configuredEnvironment?: Record<string, string>): EffectiveEnvironment {
  return { ...process.env, ...configuredEnvironment };
}

function commandCandidates(command: string, environment: EffectiveEnvironment): string[] {
  // A relative command containing a path separator is still resolved from AgentKnot's process
  // directory. Relative PATH entries have the same limitation. Configuration-only doctor has
  // no worker workspace, so it cannot evaluate either form against the eventual run workspace
  // without changing the existing boundary.
  if (command.includes(path.sep)) return [path.resolve(command)];
  const searchPath = environment.PATH ?? '';
  return searchPath.split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, command));
}

async function findCommand(command: string, environment: EffectiveEnvironment): Promise<string | undefined> {
  for (const candidate of commandCandidates(command, environment)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

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
  // Pi resolves its default agent directory with os.homedir() inside the child. Mirror the
  // environment-sensitive part of that lookup without mutating this process's environment.
  if (process.platform === 'win32') return environment.USERPROFILE || os.homedir();
  return environment.HOME || os.homedir();
}

function piAgentDirectory(environment: EffectiveEnvironment): string {
  const homeDirectory = effectiveHomeDirectory(environment);
  const configuredDirectory = environment.PI_CODING_AGENT_DIR;
  if (!configuredDirectory) return path.join(homeDirectory, '.pi', 'agent');
  if (configuredDirectory === '~') return homeDirectory;
  if (
    configuredDirectory.startsWith('~/') ||
    (process.platform === 'win32' && configuredDirectory.startsWith('~\\'))
  ) {
    return path.join(homeDirectory, configuredDirectory.slice(2));
  }
  // A relative configured directory remains relative to AgentKnot's process directory during
  // doctor because the configuration-only boundary has no eventual worker workspace.
  return configuredDirectory;
}

async function hasPiAuth(provider: string, environment: EffectiveEnvironment): Promise<boolean> {
  const agentDirectory = piAgentDirectory(environment);
  try {
    const value: unknown = JSON.parse(await readFile(path.join(agentDirectory, 'auth.json'), 'utf8'));
    if (!isRecord(value) || !(provider in value)) return false;
    return hasCredentialValue(value[provider]);
  } catch {
    return false;
  }
}

const CHILD_SIGTERM_GRACE_MS = 100;
const CHILD_SIGKILL_WAIT_MS = 1_000;
const CHILD_OUTPUT_DRAIN_GRACE_MS = 1_000;
const SESSION_STATS_WAIT_MS = 1_000;
const SESSION_STATS_REQUEST_ID = 'agentknot-session-stats';
const AMBIENT_DISCOVERY_DISABLE_FLAGS = [
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
] as const;

type SessionStatsUnavailableReason = 'timeout' | 'unsupported' | 'invalid';

type SanitizedSessionStats = {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
};

type SessionStatsMetadata = SanitizedSessionStats | { unavailableReason: SessionStatsUnavailableReason };

function rpcLine(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

function withAmbientDiscoveryDisabled(configuredArgs: readonly string[] | undefined): string[] {
  const disabledFlags = new Set<string>(AMBIENT_DISCOVERY_DISABLE_FLAGS);
  const seen = new Set<string>();
  const args: string[] = [];
  for (const arg of configuredArgs ?? []) {
    if (disabledFlags.has(arg)) {
      if (seen.has(arg)) continue;
      seen.add(arg);
    }
    args.push(arg);
  }
  for (const flag of AMBIENT_DISCOVERY_DISABLE_FLAGS) {
    if (!seen.has(flag)) args.push(flag);
  }
  return args;
}

function isPiRpcEvent(value: unknown): value is PiRpcEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeFiniteNumber(value) && Number.isInteger(value);
}

function sanitizeSessionStats(value: unknown): SanitizedSessionStats | undefined {
  if (!isRecord(value)) return undefined;
  const userMessages = value.userMessages;
  const assistantMessages = value.assistantMessages;
  const toolCalls = value.toolCalls;
  const toolResults = value.toolResults;
  const totalMessages = value.totalMessages;
  if (
    !isNonNegativeInteger(userMessages) ||
    !isNonNegativeInteger(assistantMessages) ||
    !isNonNegativeInteger(toolCalls) ||
    !isNonNegativeInteger(toolResults) ||
    !isNonNegativeInteger(totalMessages)
  ) {
    return undefined;
  }

  const tokens = value.tokens;
  if (!isRecord(tokens)) return undefined;
  const input = tokens.input;
  const output = tokens.output;
  const cacheRead = tokens.cacheRead;
  const cacheWrite = tokens.cacheWrite;
  const total = tokens.total;
  if (
    !isNonNegativeInteger(input) ||
    !isNonNegativeInteger(output) ||
    !isNonNegativeInteger(cacheRead) ||
    !isNonNegativeInteger(cacheWrite) ||
    !isNonNegativeInteger(total)
  ) {
    return undefined;
  }

  const cost = value.cost;
  if (!isNonNegativeFiniteNumber(cost)) return undefined;

  let contextUsage: SanitizedSessionStats['contextUsage'];
  if (value.contextUsage !== undefined) {
    if (!isRecord(value.contextUsage)) return undefined;
    const contextTokens = value.contextUsage.tokens;
    const contextWindow = value.contextUsage.contextWindow;
    const contextPercent = value.contextUsage.percent;
    if (
      !(contextTokens === null || isNonNegativeInteger(contextTokens)) ||
      !isNonNegativeInteger(contextWindow) ||
      !(contextPercent === null || isNonNegativeFiniteNumber(contextPercent))
    ) {
      return undefined;
    }
    contextUsage = {
      tokens: contextTokens,
      contextWindow,
      percent: contextPercent,
    };
  }

  return {
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages,
    tokens: { input, output, cacheRead, cacheWrite, total },
    cost,
    ...(contextUsage === undefined ? {} : { contextUsage }),
  };
}

function parseRpcLine(line: string, lineNumber: number): PiRpcEvent {
  try {
    const value: unknown = JSON.parse(line);
    if (!isPiRpcEvent(value)) throw new Error('expected a JSON object');
    return value;
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Pi RPC emitted malformed JSONL at line ${lineNumber}: ${cause.message}`, { cause });
  }
}

function extractAssistantError(messages: unknown[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const candidate = message as Record<string, unknown>;
    if (candidate.role === 'assistant' && candidate.stopReason === 'error') {
      return typeof candidate.errorMessage === 'string' ? candidate.errorMessage : 'Pi assistant stopped with an error';
    }
  }
  return undefined;
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function childExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (childExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      child.off('error', done);
      child.off('exit', done);
      resolve();
    };
    child.once('error', done);
    child.once('exit', done);
  });
}

function waitForPromiseOrTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve(false);
    }, timeoutMs);
    void promise.then(
      () => {
        if (timedOut) return;
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        if (timedOut) return;
        clearTimeout(timer);
        resolve(true);
      }
    );
  });
}

function waitForRpcResponse(
  response: Promise<PiRpcEvent | undefined>,
  timeoutMs: number
): Promise<{ response?: PiRpcEvent; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    void response.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value === undefined ? { timedOut: false } : { response: value, timedOut: false });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false });
      }
    );
  });
}

async function requestSessionStats(
  child: ChildProcessWithoutNullStreams,
  response: Promise<PiRpcEvent | undefined>,
  requestId: string
): Promise<SessionStatsMetadata> {
  if (childExited(child)) return { unavailableReason: 'unsupported' };
  try {
    child.stdin.write(rpcLine({ id: requestId, type: 'get_session_stats' }));
  } catch {
    return { unavailableReason: 'unsupported' };
  }

  const result = await waitForRpcResponse(response, SESSION_STATS_WAIT_MS);
  if (result.timedOut) return { unavailableReason: 'timeout' };
  const event = result.response;
  if (!event || event.type !== 'response' || event.id !== requestId || event.command !== 'get_session_stats') {
    return { unavailableReason: 'unsupported' };
  }
  if (event.success !== true) return { unavailableReason: 'unsupported' };
  const stats = sanitizeSessionStats(event.data);
  return stats ?? { unavailableReason: 'invalid' };
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<void>
): Promise<void> {
  if (childExited(child)) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // The owned child may have exited between the state check and kill.
  }
  if (await waitForPromiseOrTimeout(exit, CHILD_SIGTERM_GRACE_MS)) return;
  if (!childExited(child)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The owned child may have exited between the state check and kill.
    }
  }
  await waitForPromiseOrTimeout(exit, CHILD_SIGKILL_WAIT_MS);
}

async function awaitChildOutput(
  child: ChildProcessWithoutNullStreams,
  stdoutTask: Promise<void>,
  stderrTask: Promise<void>
): Promise<void> {
  const output = Promise.allSettled([stdoutTask, stderrTask]);
  if (!(await waitForPromiseOrTimeout(output, CHILD_OUTPUT_DRAIN_GRACE_MS))) {
    // Only the exact streams owned by this child are closed. The child itself has already
    // received the bounded SIGTERM/SIGKILL sequence above; this releases inherited pipe ends
    // without attempting broad process cleanup.
    child.stdout.destroy();
    child.stderr.destroy();
  }
  await output;
}

function childExitError(
  label: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  agentEnded: boolean,
  stderr: string
): Error {
  const state = agentEnded
    ? 'received agent_end without agent_settled before exit'
    : 'exited before agent_settled';
  return new Error(
    `${label} ${state} (code=${String(code)}, signal=${String(signal)})${
      stderr.trim() === '' ? '' : `: ${stderr.trim()}`
    }`
  );
}

const LIVE_PROBE_PROMPT =
  'This is a bounded AgentKnot live inference probe. Reply with exactly "AgentKnot live inference probe succeeded." and do not use tools or modify files.';

/** The only machine suffix recognized by normal Pi runs. */
export const PI_WORKER_COMPLETION_REPORT_MARKER = 'AGENTKNOT_WORKER_COMPLETION_REPORT_V1';

/**
 * This instruction is intentionally route-neutral and is appended only by `run`, never by the
 * configuration doctor or live probe paths.
 */
export const PI_WORKER_COMPLETION_REPORT_INSTRUCTION = [
  'End your final assistant message with exactly one single-line marked JSON envelope.',
  `The line must begin "${PI_WORKER_COMPLETION_REPORT_MARKER}: " and contain schemaVersion 1 WorkerCompletionReport JSON with changedFiles as a string array, checksRun entries with command, outcome (passed, failed, or unknown), and optional notes, remainingRisks as a string array, and notes as a string array.`,
  'Do not add any text after that line. All values are worker-reported claims, not AgentKnot verification.',
].join(' ');

interface ParsedWorkerCompletionOutput {
  output: string;
  completionReport?: WorkerCompletionReport | null;
}

const WORKER_COMPLETION_REPORT_SUFFIX = new RegExp(
  `(^|\\r?\\n)${PI_WORKER_COMPLETION_REPORT_MARKER}: ([^\\r\\n]*)(?![\\s\\S])`
);

function parseWorkerCompletionOutput(output: string): ParsedWorkerCompletionOutput {
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

export class PiRpcWorkerAdapter implements WorkerAdapter {
  readonly name: string;

  constructor(
    name: string,
    readonly config: PiRpcWorkerConfig
  ) {
    this.name = name;
  }

  async doctor(route: ResolvedRoute): Promise<WorkerHealth> {
    return this.#doctor(route, effectiveEnvironment(this.config.environment));
  }

  async #doctor(route: ResolvedRoute, environment: EffectiveEnvironment): Promise<WorkerHealth> {
    const command = this.config.command ?? 'pi';
    const resolvedCommand = await findCommand(command, environment);
    const authFileCredential = await hasPiAuth(route.provider, environment);
    const missingEnvironment = authFileCredential
      ? []
      : route.requiredEnv.filter((name) => !environment[name]?.trim());
    if (!resolvedCommand || missingEnvironment.length > 0) {
      return {
        ok: false,
        message: [
          resolvedCommand ? undefined : `Command "${command}" was not found`,
          missingEnvironment.length > 0
            ? `Missing environment: ${missingEnvironment.join(', ')}`
            : undefined,
        ]
          .filter(Boolean)
          .join('; '),
        details: { command, resolvedCommand, missingEnvironment, authFileCredential },
      };
    }
    return {
      ok: true,
      message: `Pi RPC is ready for ${route.provider}/${route.model}`,
      details: {
        command: resolvedCommand,
        credentialSource: authFileCredential ? 'pi-auth-file' : route.requiredEnv.length > 0 ? 'environment' : 'pi',
      },
    };
  }

  async probe(input: WorkerProbeInput): Promise<WorkerProbeResult> {
    if (input.signal.aborted) {
      throw input.signal.reason instanceof Error ? input.signal.reason : new Error('Aborted');
    }
    const environment = effectiveEnvironment(this.config.environment);
    const health = await this.#doctor(input.route, environment);
    if (!health.ok) throw new Error(health.message);

    const command = this.config.command ?? 'pi';
    const probeWorkspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-live-probe-'));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        command,
        [
          ...withAmbientDiscoveryDisabled(this.config.commandArgs),
          '--mode',
          'rpc',
          '--provider',
          input.route.provider,
          '--model',
          input.route.model,
          '--name',
          'agentknot-live-probe',
          ...(this.config.noSession === false ? [] : ['--no-session']),
        ],
        {
          cwd: probeWorkspace,
          env: environment,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
    } catch (error) {
      await rm(probeWorkspace, { recursive: true, force: true });
      throw error;
    }

    let output = '';
    let rawEventCount = 0;
    let assistantError: string | undefined;
    let agentEnded = false;
    let stderr = '';
    let protocolSettled = false;
    let resolveSettled!: () => void;
    let rejectSettled!: (error: Error) => void;
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = () => {
        if (protocolSettled) return;
        protocolSettled = true;
        resolve();
      };
      rejectSettled = (error: Error) => {
        if (protocolSettled) return;
        protocolSettled = true;
        reject(error);
      };
    });
    // Abort can happen before the child has spawned, so the settled promise may reject before
    // the startup path reaches its await. Keep that rejection observed while preserving it for
    // the normal await path.
    void settled.catch(() => undefined);
    const exit = waitForExit(child);
    const abort = () => {
      rejectSettled(input.signal.reason instanceof Error ? input.signal.reason : new Error('Aborted'));
    };
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    child.stdin.on('error', (error) => {
      if (!protocolSettled) rejectSettled(error);
    });

    const handleEvent = (event: PiRpcEvent): void => {
      rawEventCount += 1;
      switch (event.type) {
        case 'message_update': {
          const delta = event.assistantMessageEvent;
          if (delta?.type === 'text_delta' && typeof delta.delta === 'string') output += delta.delta;
          break;
        }
        case 'agent_end':
          agentEnded = true;
          assistantError = extractAssistantError(event.messages) ?? assistantError;
          break;
        case 'agent_settled':
          if (assistantError) rejectSettled(new Error(assistantError));
          else resolveSettled();
          break;
        case 'response':
          if (event.success === false) {
            rejectSettled(new Error(event.error ?? `Pi RPC command ${event.command ?? 'unknown'} failed`));
          }
          break;
        default:
          break;
      }
    };

    const stdoutTask = (async () => {
      const decoder = new StrictJsonlDecoder();
      let lineNumber = 0;
      for await (const chunk of child.stdout) {
        for (const line of decoder.push(Buffer.from(chunk))) {
          lineNumber += 1;
          handleEvent(parseRpcLine(line, lineNumber));
        }
      }
      for (const line of decoder.end()) {
        lineNumber += 1;
        handleEvent(parseRpcLine(line, lineNumber));
      }
    })().catch((error: unknown) => {
      rejectSettled(error instanceof Error ? error : new Error(String(error)));
    });

    const stderrTask = (async () => {
      for await (const chunk of child.stderr) {
        stderr = `${stderr}${Buffer.from(chunk).toString('utf8')}`.slice(-16_384);
      }
    })().catch((error: unknown) => {
      rejectSettled(error instanceof Error ? error : new Error(String(error)));
    });

    child.once('error', (error) => {
      rejectSettled(error);
    });
    child.once('exit', (code, signal) => {
      const output = Promise.allSettled([stdoutTask, stderrTask]);
      void waitForPromiseOrTimeout(output, CHILD_OUTPUT_DRAIN_GRACE_MS)
        .then(() => {
          if (!protocolSettled) {
            rejectSettled(childExitError('Pi RPC live probe', code, signal, agentEnded, stderr));
          }
        })
        .catch((error: unknown) => {
          rejectSettled(error instanceof Error ? error : new Error(String(error)));
        });
    });

    try {
      await waitForSpawn(child);
      if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error('Aborted');
      child.stdin.write(rpcLine({ id: 'retry', type: 'set_auto_retry', enabled: false }));
      if (input.route.thinkingLevel) {
        child.stdin.write(
          rpcLine({ id: 'thinking', type: 'set_thinking_level', level: input.route.thinkingLevel })
        );
      }
      child.stdin.write(rpcLine({ id: 'probe', type: 'prompt', message: LIVE_PROBE_PROMPT }));
      await settled;
      if (input.signal.aborted) {
        throw input.signal.reason instanceof Error ? input.signal.reason : new Error('Aborted');
      }
      return {
        output,
        metadata: {
          command,
          rawEventCount,
          stderr: stderr.trim() || undefined,
          ambientDiscoveryDisabled: true,
        },
      };
    } finally {
      input.signal.removeEventListener('abort', abort);
      try {
        child.stdin.end();
      } finally {
        try {
          await terminateChild(child, exit);
          await awaitChildOutput(child, stdoutTask, stderrTask);
        } finally {
          await rm(probeWorkspace, { recursive: true, force: true });
        }
      }
    }
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    const environment = effectiveEnvironment(this.config.environment);
    const health = await this.#doctor(input.route, environment);
    if (!health.ok) throw new Error(health.message);

    const command = this.config.command ?? 'pi';
    const args = [
      ...withAmbientDiscoveryDisabled(this.config.commandArgs),
      '--mode',
      'rpc',
      '--provider',
      input.route.provider,
      '--model',
      input.route.model,
      '--name',
      `agentknot-${input.jobId}`,
      ...(this.config.noSession === false ? [] : ['--no-session']),
    ];
    const child = spawn(command, args, {
      cwd: input.workspace,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exit = waitForExit(child);

    let completed = false;
    let output = '';
    let rawEventCount = 0;
    let assistantError: string | undefined;
    let agentEnded = false;
    let stderr = '';
    let statsRequestId: string | undefined;
    let statsResponseResolved = false;
    let resolveStatsResponse!: (event: PiRpcEvent | undefined) => void;
    const statsResponse = new Promise<PiRpcEvent | undefined>((resolve) => {
      resolveStatsResponse = (event) => {
        if (statsResponseResolved) return;
        statsResponseResolved = true;
        resolve(event);
      };
    });
    let resolveSettled!: () => void;
    let rejectSettled!: (error: Error) => void;
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    // Abort or spawn failure can reject before the startup path reaches its await. Keep that
    // rejection observed while preserving it for the normal await path.
    void settled.catch(() => undefined);

    const abort = () => {
      if (!completed) rejectSettled(input.signal.reason instanceof Error ? input.signal.reason : new Error('Aborted'));
    };
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();

    const handleEvent = async (event: PiRpcEvent): Promise<void> => {
      rawEventCount += 1;
      if (event.type === 'response' && statsRequestId !== undefined && event.id === statsRequestId) {
        resolveStatsResponse(event);
        return;
      }
      switch (event.type) {
        case 'agent_start':
          await emit('worker.started', { adapter: 'pi-rpc', attempt: input.attempt });
          break;
        case 'turn_start':
        case 'turn_end':
        case 'message_start':
        case 'message_end':
          break;
        case 'message_update': {
          const delta = event.assistantMessageEvent;
          if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
            output += delta.delta;
            await emit('worker.text.delta', { delta: delta.delta });
          } else if (delta?.type === 'toolcall_end') {
            await emit('worker.tool.started', {
              toolCallId: delta.toolCall?.id,
              toolName: delta.toolCall?.name,
              arguments: delta.toolCall?.arguments,
            });
          }
          break;
        }
        case 'tool_execution_start':
          await emit('worker.tool.started', {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            arguments: event.args,
          });
          break;
        case 'tool_execution_update':
          await emit('worker.tool.updated', {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            update: event.result,
          });
          break;
        case 'tool_execution_end':
          await emit('worker.tool.completed', {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
          });
          break;
        case 'auto_retry_start':
          await emit('worker.retry.started', { attempt: event.attempt, delayMs: event.delayMs });
          break;
        case 'auto_retry_end':
          await emit('worker.retry.completed', { attempt: event.attempt, success: event.success });
          break;
        case 'agent_end':
          agentEnded = true;
          assistantError = extractAssistantError(event.messages) ?? assistantError;
          break;
        case 'agent_settled':
          completed = true;
          resolveSettled();
          break;
        case 'response':
          if (event.success === false) {
            completed = true;
            rejectSettled(new Error(event.error ?? `Pi RPC command ${event.command ?? 'unknown'} failed`));
          }
          break;
        default:
          await emit('worker.raw', { event: event as Record<string, unknown> });
      }
    };

    const stdoutTask = (async () => {
      const decoder = new StrictJsonlDecoder();
      let lineNumber = 0;
      for await (const chunk of child.stdout) {
        for (const line of decoder.push(Buffer.from(chunk))) {
          lineNumber += 1;
          await handleEvent(parseRpcLine(line, lineNumber));
        }
      }
      for (const line of decoder.end()) {
        lineNumber += 1;
        await handleEvent(parseRpcLine(line, lineNumber));
      }
    })().catch((error: unknown) => {
      if (!completed) rejectSettled(error instanceof Error ? error : new Error(String(error)));
    });

    const stderrTask = (async () => {
      for await (const chunk of child.stderr) {
        const text = Buffer.from(chunk).toString('utf8');
        stderr = `${stderr}${text}`.slice(-16_384);
        await emit('worker.stderr', { text });
      }
    })().catch((error: unknown) => {
      if (!completed) rejectSettled(error instanceof Error ? error : new Error(String(error)));
    });

    child.stdin.on('error', (error) => {
      if (!completed) rejectSettled(error);
    });
    child.once('error', (error) => {
      resolveStatsResponse(undefined);
      if (!completed) rejectSettled(error);
    });
    child.once('exit', (code, signal) => {
      resolveStatsResponse(undefined);
      const output = Promise.allSettled([stdoutTask, stderrTask]);
      void waitForPromiseOrTimeout(output, CHILD_OUTPUT_DRAIN_GRACE_MS)
        .then(() => {
          if (!completed) rejectSettled(childExitError('Pi RPC', code, signal, agentEnded, stderr));
        })
        .catch((error: unknown) => {
          if (!completed) rejectSettled(error instanceof Error ? error : new Error(String(error)));
        });
    });

    try {
      await waitForSpawn(child);
      if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error('Aborted');
      child.stdin.write(rpcLine({ id: 'retry', type: 'set_auto_retry', enabled: true }));
      if (input.route.thinkingLevel) {
        child.stdin.write(
          rpcLine({ id: 'thinking', type: 'set_thinking_level', level: input.route.thinkingLevel })
        );
      }
      const prompt = `${input.prompt}\n\n${PI_WORKER_COMPLETION_REPORT_INSTRUCTION}`;
      child.stdin.write(rpcLine({ id: 'prompt', type: 'prompt', message: prompt }));
      await settled;
      if (assistantError) throw new Error(assistantError);
      if (input.signal.aborted) {
        throw input.signal.reason instanceof Error ? input.signal.reason : new Error('Aborted');
      }
      const parsedOutput = parseWorkerCompletionOutput(output);
      statsRequestId = SESSION_STATS_REQUEST_ID;
      const sessionStats = await requestSessionStats(child, statsResponse, statsRequestId);
      return {
        output: parsedOutput.output,
        ...(parsedOutput.completionReport === undefined
          ? {}
          : { completionReport: parsedOutput.completionReport }),
        metadata: {
          command,
          rawEventCount,
          stderr: stderr.trim() || undefined,
          ambientDiscoveryDisabled: true,
          sessionStats,
        },
      };
    } finally {
      completed = true;
      input.signal.removeEventListener('abort', abort);
      try {
        child.stdin.end();
      } finally {
        await terminateChild(child, exit);
        await awaitChildOutput(child, stdoutTask, stderrTask);
      }
    }
  }
}

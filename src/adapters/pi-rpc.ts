import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type { PiRpcWorkerConfig } from '../config.js';
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

interface PiRpcEvent {
  type?: string;
  success?: boolean;
  command?: string;
  error?: string;
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

function commandCandidates(command: string): string[] {
  if (command.includes(path.sep)) return [path.resolve(command)];
  const searchPath = process.env.PATH ?? '';
  return searchPath.split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, command));
}

async function findCommand(command: string): Promise<string | undefined> {
  for (const candidate of commandCandidates(command)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

async function hasPiAuth(provider: string): Promise<boolean> {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
  try {
    const value = JSON.parse(await readFile(path.join(agentDirectory, 'auth.json'), 'utf8')) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) && provider in value;
  } catch {
    return false;
  }
}

function rpcLine(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
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

function waitForExitOrTimeout(exit: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void exit.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<void>
): Promise<void> {
  if (childExited(child)) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // The child may have exited between the state check and kill.
  }
  if (await waitForExitOrTimeout(exit, 100)) return;
  if (!childExited(child)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The child may have exited between the state check and kill.
    }
  }
  await waitForExitOrTimeout(exit, 1_000);
}

const LIVE_PROBE_PROMPT =
  'This is a bounded AgentKnot live inference probe. Reply with exactly "AgentKnot live inference probe succeeded." and do not use tools or modify files.';

export class PiRpcWorkerAdapter implements WorkerAdapter {
  readonly name: string;

  constructor(
    name: string,
    readonly config: PiRpcWorkerConfig
  ) {
    this.name = name;
  }

  async doctor(route: ResolvedRoute): Promise<WorkerHealth> {
    const command = this.config.command ?? 'pi';
    const resolvedCommand = await findCommand(command);
    const authFileCredential = await hasPiAuth(route.provider);
    const missingEnvironment = authFileCredential
      ? []
      : route.requiredEnv.filter((name) => !process.env[name]);
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
    const health = await this.doctor(input.route);
    if (!health.ok) throw new Error(health.message);

    const command = this.config.command ?? 'pi';
    const probeWorkspace = await mkdtemp(path.join(os.tmpdir(), 'agentknot-live-probe-'));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        command,
        [
          ...(this.config.commandArgs ?? []),
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
          env: { ...process.env, ...this.config.environment },
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
      if (!childExited(child)) child.kill('SIGTERM');
    };
    input.signal.addEventListener('abort', abort, { once: true });
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
      for await (const chunk of child.stdout) {
        for (const line of decoder.push(Buffer.from(chunk))) handleEvent(JSON.parse(line) as PiRpcEvent);
      }
      for (const line of decoder.end()) handleEvent(JSON.parse(line) as PiRpcEvent);
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
      if (!protocolSettled) {
        rejectSettled(
          new Error(
            `Pi RPC live probe exited before agent_settled (code=${String(code)}, signal=${String(signal)})${
              stderr.trim() === '' ? '' : `: ${stderr.trim()}`
            }`
          )
        );
      }
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
        metadata: { command, rawEventCount, stderr: stderr.trim() || undefined },
      };
    } finally {
      input.signal.removeEventListener('abort', abort);
      try {
        child.stdin.end();
      } finally {
        try {
          await terminateChild(child, exit);
          await Promise.allSettled([stdoutTask, stderrTask]);
        } finally {
          await rm(probeWorkspace, { recursive: true, force: true });
        }
      }
    }
  }

  async run(input: WorkerRunInput, emit: WorkerEventSink): Promise<WorkerRunResult> {
    const health = await this.doctor(input.route);
    if (!health.ok) throw new Error(health.message);

    const command = this.config.command ?? 'pi';
    const args = [
      ...(this.config.commandArgs ?? []),
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
      env: { ...process.env, ...this.config.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let completed = false;
    let output = '';
    let rawEventCount = 0;
    let assistantError: string | undefined;
    let stderr = '';
    let resolveSettled!: () => void;
    let rejectSettled!: (error: Error) => void;
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });

    const abort = () => {
      if (!completed) rejectSettled(input.signal.reason instanceof Error ? input.signal.reason : new Error('Aborted'));
      child.kill('SIGTERM');
    };
    input.signal.addEventListener('abort', abort, { once: true });

    const handleEvent = async (event: PiRpcEvent): Promise<void> => {
      rawEventCount += 1;
      switch (event.type) {
        case 'agent_start':
          await emit('worker.started', { adapter: 'pi-rpc', attempt: input.attempt });
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
      for await (const chunk of child.stdout) {
        for (const line of decoder.push(Buffer.from(chunk))) {
          await handleEvent(JSON.parse(line) as PiRpcEvent);
        }
      }
      for (const line of decoder.end()) await handleEvent(JSON.parse(line) as PiRpcEvent);
    })().catch((error: unknown) => {
      if (!completed) rejectSettled(error instanceof Error ? error : new Error(String(error)));
    });

    const stderrTask = (async () => {
      for await (const chunk of child.stderr) {
        const text = Buffer.from(chunk).toString('utf8');
        stderr = `${stderr}${text}`.slice(-16_384);
        await emit('worker.stderr', { text });
      }
    })();

    child.once('exit', (code, signal) => {
      if (!completed) {
        rejectSettled(
          new Error(
            `Pi RPC exited before agent_settled (code=${String(code)}, signal=${String(signal)})${
              stderr.trim() === '' ? '' : `: ${stderr.trim()}`
            }`
          )
        );
      }
    });

    try {
      await waitForSpawn(child);
      child.stdin.write(rpcLine({ id: 'retry', type: 'set_auto_retry', enabled: true }));
      if (input.route.thinkingLevel) {
        child.stdin.write(
          rpcLine({ id: 'thinking', type: 'set_thinking_level', level: input.route.thinkingLevel })
        );
      }
      child.stdin.write(rpcLine({ id: 'prompt', type: 'prompt', message: input.prompt }));
      await settled;
      if (assistantError) throw new Error(assistantError);
      return {
        output,
        metadata: { command, rawEventCount, stderr: stderr.trim() || undefined },
      };
    } finally {
      completed = true;
      input.signal.removeEventListener('abort', abort);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.allSettled([stdoutTask, stderrTask]);
    }
  }
}

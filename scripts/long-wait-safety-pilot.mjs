#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';

const COMPLETION_MARKER = 'AGENTKNOT_WORKER_COMPLETION_REPORT_V1';

function now() {
  return new Date().toISOString();
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function options(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('options file must contain an object');
  }
  return parsed;
}

function writeResult(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function workerLog(value) {
  const path = process.env.AGENTKNOT_SYNTHETIC_WORKER_LOG;
  if (path === undefined) return;
  appendFileSync(path, `${JSON.stringify({ at: now(), pid: process.pid, ...value })}\n`, {
    mode: 0o600,
  });
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function runWorker() {
  const durationMs = Number(process.env.AGENTKNOT_SYNTHETIC_DURATION_MS ?? 120_000);
  const progressMs = Number(process.env.AGENTKNOT_SYNTHETIC_PROGRESS_MS ?? 5_000);
  if (!Number.isSafeInteger(durationMs) || durationMs < 1_000) {
    throw new Error('AGENTKNOT_SYNTHETIC_DURATION_MS must be an integer of at least 1000');
  }
  if (!Number.isSafeInteger(progressMs) || progressMs < 100) {
    throw new Error('AGENTKNOT_SYNTHETIC_PROGRESS_MS must be an integer of at least 100');
  }

  let buffer = '';
  let progressTimer;
  let settlementTimer;
  let gateTimer;
  let promptStarted = false;
  let settled = false;
  let tick = 0;

  const stopTimers = () => {
    if (progressTimer !== undefined) clearInterval(progressTimer);
    if (settlementTimer !== undefined) clearTimeout(settlementTimer);
    if (gateTimer !== undefined) clearInterval(gateTimer);
  };
  const stop = (signal) => {
    stopTimers();
    workerLog({ event: 'worker-stopped', signal, settled });
    process.exit(0);
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  const handle = (command) => {
    if (command.type === 'get_session_stats') {
      send({
        id: command.id,
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: tick,
          toolResults: tick,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
          contextUsage: { tokens: 0, contextWindow: 1, percent: 0 },
        },
      });
      return;
    }
    if (command.type !== 'prompt') {
      send({ id: command.id, type: 'response', command: command.type, success: true });
      return;
    }
    if (promptStarted) throw new Error('synthetic worker accepts one prompt');
    promptStarted = true;
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    const startWork = () => {
      if (gateTimer !== undefined) clearInterval(gateTimer);
      send({ type: 'agent_start' });
      send({
        type: 'tool_execution_start',
        toolCallId: 'synthetic-progress',
        toolName: 'synthetic_progress',
        args: { intervalMs: progressMs, durationMs },
      });
      workerLog({ event: 'worker-started', durationMs, progressMs });

      progressTimer = setInterval(() => {
        tick += 1;
        const update = { tick, elapsedMs: tick * progressMs };
        send({
          type: 'tool_execution_update',
          toolCallId: 'synthetic-progress',
          toolName: 'synthetic_progress',
          result: update,
        });
        workerLog({ event: 'worker-progress', ...update });
      }, progressMs);

      settlementTimer = setTimeout(() => {
        stopTimers();
        send({
          type: 'tool_execution_end',
          toolCallId: 'synthetic-progress',
          toolName: 'synthetic_progress',
          result: { ticks: tick, durationMs },
          isError: false,
        });
        const report = {
          schemaVersion: 1,
          taskOutcome: 'completed',
          changedFiles: [],
          checksRun: [{ command: 'synthetic transport completion', outcome: 'passed' }],
          remainingRisks: [],
          notes: ['Synthetic long-wait transport fixture completed without repository changes.'],
        };
        const output = `Synthetic transport task completed.\n${COMPLETION_MARKER}: ${JSON.stringify(report)}`;
        send({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: output },
        });
        send({ type: 'agent_end', messages: [], willRetry: false });
        send({ type: 'agent_settled' });
        settled = true;
        workerLog({ event: 'worker-settled', ticks: tick, durationMs });
      }, durationMs);
    };

    const gatePath = process.env.AGENTKNOT_SYNTHETIC_GATE_FILE;
    if (gatePath === undefined) {
      startWork();
      return;
    }
    const awaitingSince = Date.now();
    workerLog({ event: 'worker-awaiting-gate', gatePath });
    gateTimer = setInterval(() => {
      if (!existsSync(gatePath)) return;
      if (statSync(gatePath).mtimeMs < awaitingSince) return;
      workerLog({ event: 'worker-gate-released', gatePath });
      startWork();
    }, 100);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).replace(/\r$/u, '');
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      try {
        handle(JSON.parse(line));
      } catch (error) {
        workerLog({ event: 'worker-error', message: error instanceof Error ? error.message : String(error) });
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exitCode = 1;
      }
    }
  });
}

class StdioMcpClient {
  #child;
  #pending = new Map();
  #buffer = '';
  #nextId = 1;
  notifications = [];

  constructor(cliPath, serverUrl) {
    this.#child = spawn(process.execPath, [cliPath, 'mcp'], {
      env: { ...process.env, AGENTKNOT_SERVER_URL: serverUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk) => this.#accept(chunk));
    let stderr = '';
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    this.#child.once('exit', (code, signal) => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error(`MCP process exited (${String(code ?? signal)}): ${stderr}`));
      }
      this.#pending.clear();
    });
  }

  #accept(chunk) {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line === '') continue;
      const message = JSON.parse(line);
      if (typeof message.id !== 'number') {
        this.notifications.push({ at: now(), bytes: byteLength(message), message });
        continue;
      }
      const pending = this.#pending.get(message.id);
      if (pending === undefined) continue;
      this.#pending.delete(message.id);
      pending.resolve(message);
    }
  }

  beginRequest(method, params) {
    const id = this.#nextId++;
    const requestedAt = now();
    const response = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return {
      id,
      requestedAt,
      result: response.then((message) => {
        if (message.error !== undefined) throw new Error(message.error.message ?? 'MCP request failed');
        return { completedAt: now(), result: message.result };
      }),
    };
  }

  request(method, params) {
    return this.beginRequest(method, params).result;
  }

  notify(method, params) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agentknot-long-wait-pilot', version: '1' },
    });
    this.notify('notifications/initialized');
  }

  beginTool(name, args, progressToken) {
    return this.beginRequest('tools/call', {
      name,
      arguments: args,
      ...(progressToken === undefined ? {} : { _meta: { progressToken } }),
    });
  }

  async tool(name, args, progressToken) {
    const request = this.beginTool(name, args, progressToken);
    const response = await request.result;
    return { requestedAt: request.requestedAt, ...response, value: toolJson(response.result) };
  }

  async close() {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    const exited = once(this.#child, 'exit');
    this.#child.stdin.end();
    await exited;
  }
}

function toolJson(result) {
  if (result?.isError === true) throw new Error(JSON.stringify(result));
  const block = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === 'text')
    : undefined;
  if (typeof block?.text !== 'string') throw new Error('MCP tool response has no text JSON');
  return JSON.parse(block.text);
}

function orchestrationRequest(workspace, source) {
  return {
    prompt: 'Run the synthetic bounded transport task exactly once.',
    workspace,
    source,
    delegation: 'inherit',
    assessment: {
      schemaVersion: 1,
      recommendation: 'delegate',
      complexity: 'low',
      parallelizable: false,
      taskKinds: ['independent-implementation'],
      reasoning: 'One deterministic synthetic transport task with no repository modification.',
      context: {
        schemaVersion: 1,
        summary: 'A synthetic Worker emits periodic progress and eventually settles.',
        relevantPaths: ['package.json'],
        constraints: [
          'Do not modify repository files.',
          'Do not use external services.',
          'Run exactly one synthetic Worker attempt.',
        ],
      },
      subtasks: [
        {
          title: 'Synthetic transport wait',
          kind: 'independent-implementation',
          prompt: 'Emit periodic progress and complete without modifying files.',
          acceptanceCriteria: [
            'Progress is emitted periodically.',
            'No repository file is modified.',
            'The Worker reaches terminal success unless explicitly cancelled.',
          ],
        },
      ],
    },
  };
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return { status: response.status, body };
}

async function durableEvidence(serverUrl, orchestrationId) {
  const orchestrationResponse = await fetchJson(
    `${serverUrl}/v1/orchestrations/${encodeURIComponent(orchestrationId)}`
  );
  const orchestration = orchestrationResponse.body.orchestration;
  const child = orchestration?.children?.[0];
  const job = child?.jobId === undefined
    ? undefined
    : (await fetchJson(`${serverUrl}/v1/jobs/${encodeURIComponent(child.jobId)}`)).body.job;
  return { orchestration, job };
}

function readWorkerEntries(path, startedAt, completedAt) {
  if (!existsSync(path)) return [];
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt) + 1_000;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => Date.parse(entry.at) >= start && Date.parse(entry.at) <= end);
}

function eventAt(record, type) {
  return record?.events?.find((event) => event.type === type)?.at;
}

async function runCancelCase(path) {
  const input = options(path);
  const client = new StdioMcpClient(input.cliPath, input.serverUrl);
  await client.initialize();
  const admitted = await client.tool(
    'agentknot_orchestration_start',
    orchestrationRequest(input.workspace, input.source)
  );
  const orchestrationId = admitted.value.id;
  const waits = [];
  let cancellationRequestedAt;
  let cancellationDeliveredAt;
  let cancellation;
  let waitValue;
  let waitCompletedAt;

  const requestCancellation = async () => {
    cancellationRequestedAt = now();
    const response = await client.tool('agentknot_orchestration_cancel', { id: orchestrationId });
    cancellationDeliveredAt = response.completedAt;
    return response.value;
  };

  try {
    if (input.cancelAfterActive === true) {
      const first = client.beginTool(
        'agentknot_orchestration_wait',
        { id: orchestrationId, afterSequence: 0, waitMs: input.waitMs },
        `progress-${input.source}-1`
      );
      const firstResponse = await first.result;
      const firstValue = toolJson(firstResponse.result);
      waits.push({ requestedAt: first.requestedAt, completedAt: firstResponse.completedAt, value: firstValue });
      if (firstValue.state !== 'active') throw new Error('control wait did not return active');
      cancellation = await requestCancellation();
      const second = client.beginTool(
        'agentknot_orchestration_wait',
        {
          id: orchestrationId,
          afterSequence: firstValue.nextSequence,
          waitMs: input.waitMs,
        },
        `progress-${input.source}-2`
      );
      const secondResponse = await second.result;
      waitValue = toolJson(secondResponse.result);
      waitCompletedAt = secondResponse.completedAt;
      waits.push({ requestedAt: second.requestedAt, completedAt: secondResponse.completedAt, value: waitValue });
    } else {
      const wait = client.beginTool(
        'agentknot_orchestration_wait',
        { id: orchestrationId, afterSequence: 0, waitMs: input.waitMs },
        `progress-${input.source}`
      );
      let timer;
      const cancellationPromise = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          void requestCancellation().then(resolve, reject);
        }, input.cancelAtMs);
      });
      const response = await wait.result;
      waitValue = toolJson(response.result);
      waitCompletedAt = response.completedAt;
      waits.push({ requestedAt: wait.requestedAt, completedAt: response.completedAt, value: waitValue });
      cancellation = await cancellationPromise;
      clearTimeout(timer);
    }

    const durable = await durableEvidence(input.serverUrl, orchestrationId);
    const workerEntries = readWorkerEntries(
      input.workerLog,
      admitted.completedAt,
      waitCompletedAt
    );
    const stopped = workerEntries.find((entry) => entry.event === 'worker-stopped');
    const workerPid = workerEntries.find((entry) => entry.event === 'worker-started')?.pid;
    let workerAlive = false;
    if (Number.isSafeInteger(workerPid)) {
      try {
        process.kill(workerPid, 0);
        workerAlive = true;
      } catch {
        workerAlive = false;
      }
    }
    const progress = client.notifications.filter(
      (entry) => entry.message?.method === 'notifications/progress'
    );
    const result = {
      schemaVersion: 1,
      source: input.source,
      orchestrationId,
      waitMs: input.waitMs,
      cancelAtMs: input.cancelAfterActive === true
        ? Date.parse(cancellationRequestedAt) - Date.parse(waits[0].requestedAt)
        : input.cancelAtMs,
      admission: { requestedAt: admitted.requestedAt, completedAt: admitted.completedAt },
      waits,
      cancellation: { requestedAt: cancellationRequestedAt, deliveredAt: cancellationDeliveredAt, response: cancellation },
      progress: {
        count: progress.length,
        totalBytes: progress.reduce((sum, entry) => sum + entry.bytes, 0),
      },
      worker: { entries: workerEntries, stoppedAt: stopped?.at, pid: workerPid, aliveAfterTerminal: workerAlive },
      durable,
      timingMs: {
        cancelToWaitResponse: Date.parse(waitCompletedAt) - Date.parse(cancellationRequestedAt),
        cancelToWorkerStop: stopped === undefined
          ? undefined
          : Date.parse(stopped.at) - Date.parse(cancellationRequestedAt),
        cancelToOrchestrationRequestEvent: eventAt(durable.orchestration, 'orchestration.cancel.requested') === undefined
          ? undefined
          : Date.parse(eventAt(durable.orchestration, 'orchestration.cancel.requested')) - Date.parse(cancellationRequestedAt),
        cancelToOrchestrationTerminalEvent: eventAt(durable.orchestration, 'orchestration.cancelled') === undefined
          ? undefined
          : Date.parse(eventAt(durable.orchestration, 'orchestration.cancelled')) - Date.parse(cancellationRequestedAt),
        cancelToJobTerminalEvent: eventAt(durable.job, 'job.cancelled') === undefined
          ? undefined
          : Date.parse(eventAt(durable.job, 'job.cancelled')) - Date.parse(cancellationRequestedAt),
      },
      executionCounts: {
        workerStarts: workerEntries.filter((entry) => entry.event === 'worker-started').length,
        jobStartedEvents: durable.job?.events?.filter((event) => event.type === 'job.started').length ?? 0,
        children: durable.orchestration?.children?.length ?? 0,
      },
    };
    writeResult(input.resultPath, result);
  } finally {
    await client.close();
  }
}

async function admit(path) {
  const input = options(path);
  const client = new StdioMcpClient(input.cliPath, input.serverUrl);
  try {
    await client.initialize();
    const admitted = await client.tool(
      'agentknot_orchestration_start',
      orchestrationRequest(input.workspace, input.source)
    );
    writeResult(input.resultPath, {
      schemaVersion: 1,
      source: input.source,
      requestedAt: admitted.requestedAt,
      completedAt: admitted.completedAt,
      orchestrationId: admitted.value.id,
      status: admitted.value.status,
    });
  } finally {
    await client.close();
  }
}

async function collect(path) {
  const input = options(path);
  const durable = await durableEvidence(input.serverUrl, input.orchestrationId);
  writeResult(input.resultPath, { schemaVersion: 1, collectedAt: now(), ...durable });
}

async function cancelOnWait(path) {
  const input = options(path);
  const startedAt = now();
  let offset = 0;
  let waitRequest;
  while (Date.now() - Date.parse(startedAt) <= input.detectDeadlineMs) {
    if (existsSync(input.transportLog)) {
      const content = readFileSync(input.transportLog, 'utf8');
      const complete = content.lastIndexOf('\n');
      if (complete >= offset) {
        const chunk = content.slice(offset, complete + 1);
        offset = complete + 1;
        for (const line of chunk.split('\n').filter(Boolean)) {
          const entry = JSON.parse(line);
          const params = entry.message?.params;
          if (
            entry.direction === 'controller-to-server' &&
            entry.message?.method === 'tools/call' &&
            params?.name === 'agentknot_orchestration_wait' &&
            params.arguments?.id === input.orchestrationId
          ) {
            waitRequest = { at: entry.at, bytes: entry.bytes };
            break;
          }
        }
      }
    }
    if (waitRequest !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (waitRequest === undefined) throw new Error('wait request was not observed before deadline');
  if (input.gatePath !== undefined) {
    writeFileSync(input.gatePath, `${JSON.stringify({ releasedAt: now(), orchestrationId: input.orchestrationId })}\n`, { mode: 0o600 });
  }
  await new Promise((resolve) => setTimeout(resolve, input.cancelAfterMs));
  const requestedAt = now();
  const response = await fetchJson(
    `${input.serverUrl}/v1/orchestrations/${encodeURIComponent(input.orchestrationId)}/cancel`,
    { method: 'POST', body: '{}' }
  );
  writeResult(input.resultPath, {
    schemaVersion: 1,
    orchestrationId: input.orchestrationId,
    waitRequest,
    cancelAfterMs: input.cancelAfterMs,
    cancellation: { requestedAt, deliveredAt: now(), httpStatus: response.status, body: response.body },
  });
}

async function releaseOnWait(path) {
  const input = options(path);
  const startedAt = now();
  let offset = 0;
  let waitRequest;
  while (Date.now() - Date.parse(startedAt) <= input.detectDeadlineMs) {
    if (existsSync(input.transportLog)) {
      const content = readFileSync(input.transportLog, 'utf8');
      const complete = content.lastIndexOf('\n');
      if (complete >= offset) {
        const chunk = content.slice(offset, complete + 1);
        offset = complete + 1;
        for (const line of chunk.split('\n').filter(Boolean)) {
          const entry = JSON.parse(line);
          const params = entry.message?.params;
          if (
            entry.direction === 'controller-to-server' &&
            entry.message?.method === 'tools/call' &&
            params?.name === 'agentknot_orchestration_wait' &&
            params.arguments?.id === input.orchestrationId
          ) {
            waitRequest = { at: entry.at, bytes: entry.bytes };
            break;
          }
        }
      }
    }
    if (waitRequest !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (waitRequest === undefined) throw new Error('wait request was not observed before deadline');
  const releasedAt = now();
  writeFileSync(input.gatePath, `${JSON.stringify({ releasedAt, orchestrationId: input.orchestrationId })}\n`, { mode: 0o600 });
  writeResult(input.resultPath, {
    schemaVersion: 1,
    orchestrationId: input.orchestrationId,
    waitRequest,
    gate: { releasedAt: now(), path: input.gatePath },
  });
}

const [mode, path, extra] = process.argv.slice(2);
if (mode === 'worker') {
  runWorker();
} else if (mode === 'cancel-case' && path !== undefined && extra === undefined) {
  await runCancelCase(path);
} else if (mode === 'admit' && path !== undefined && extra === undefined) {
  await admit(path);
} else if (mode === 'collect' && path !== undefined && extra === undefined) {
  await collect(path);
} else if (mode === 'cancel-on-wait' && path !== undefined && extra === undefined) {
  await cancelOnWait(path);
} else if (mode === 'release-on-wait' && path !== undefined && extra === undefined) {
  await releaseOnWait(path);
} else {
  process.stderr.write(
    'Usage: long-wait-safety-pilot.mjs worker | cancel-case OPTIONS | admit OPTIONS | collect OPTIONS | cancel-on-wait OPTIONS | release-on-wait OPTIONS\n'
  );
  process.exitCode = 2;
}

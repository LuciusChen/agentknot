#!/usr/bin/env node

import { appendFileSync, chmodSync, closeSync, openSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

function usage() {
  process.stderr.write(
    'Usage:\n' +
      '  wait-turn-pilot-mcp-proxy.mjs LOG COMMAND [ARG...]\n' +
      '  wait-turn-pilot-mcp-proxy.mjs --analyze LOG\n' +
      '  wait-turn-pilot-mcp-proxy.mjs --analyze-codex SESSION_JSONL\n'
  );
  process.exitCode = 2;
}

function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

function bytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function parsedTextResult(result) {
  if (!Array.isArray(result?.content)) return undefined;
  const block = result.content.find((item) => asObject(item)?.type === 'text');
  const text = asObject(block)?.text;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function resultState(value) {
  const root = asObject(value);
  if (root === undefined) return undefined;
  if (root.state === 'active' || root.state === 'terminal') return root.state;
  return undefined;
}

function transportAnalysis(logPath) {
  const all = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const starts = all.flatMap((entry, index) =>
    entry.direction === 'controller-to-server' && asObject(entry.message)?.method === 'initialize'
      ? [index]
      : []
  );
  const entries = all.slice(starts.at(-1) ?? 0);
  const pending = new Map();
  const calls = [];
  const progress = [];

  for (const entry of entries) {
    const message = asObject(entry.message);
    if (message === undefined) continue;
    if (entry.direction === 'controller-to-server' && message.method === 'tools/call') {
      const params = asObject(message.params);
      if (typeof params?.name !== 'string') continue;
      const call = {
        id: String(message.id),
        name: params.name,
        arguments: asObject(params.arguments) ?? {},
        requestedAt: entry.at,
        requestBytes: entry.bytes,
      };
      pending.set(call.id, call);
      calls.push(call);
      continue;
    }
    if (entry.direction === 'server-to-controller' && message.method === 'notifications/progress') {
      const params = asObject(message.params) ?? {};
      progress.push({
        at: entry.at,
        bytes: entry.bytes,
        progress: params.progress,
        message: params.message,
      });
      continue;
    }
    if (entry.direction !== 'server-to-controller' || message.id === undefined) continue;
    const call = pending.get(String(message.id));
    if (call === undefined) continue;
    call.completedAt = entry.at;
    call.blockedMs = Date.parse(entry.at) - Date.parse(call.requestedAt);
    call.responseBytes = entry.bytes;
    if (message.error !== undefined) {
      call.responseState = 'error';
      continue;
    }
    const result = asObject(message.result);
    const structured = asObject(result?.structuredContent);
    const textValue = parsedTextResult(result);
    call.responseState = resultState(structured) ?? resultState(textValue) ?? 'completed';
    call.structuredContentBytes = structured === undefined ? undefined : bytes(structured);
    const textBlock = Array.isArray(result?.content)
      ? result.content.find((item) => asObject(item)?.type === 'text')
      : undefined;
    const text = asObject(textBlock)?.text;
    call.textContentBytes = typeof text === 'string' ? bytes(text) : undefined;
    const response = structured ?? asObject(textValue);
    if (response !== undefined) {
      call.nextSequence = response.nextSequence;
      const terminal = asObject(response.terminal);
      if (terminal !== undefined) {
        call.terminalStructuredBytes = bytes(terminal);
        call.handoffTruncation = terminal.handoffTruncation ?? null;
      }
    }
  }

  const waitCalls = calls.filter((call) => call.name === 'agentknot_orchestration_wait');
  const outputReads = calls.filter((call) => call.name === 'agentknot_job_output');
  process.stdout.write(`${JSON.stringify({
    transportSessions: starts.length,
    firstMessageAt: entries.at(0)?.at,
    lastMessageAt: entries.at(-1)?.at,
    calls,
    waits: {
      count: waitCalls.length,
      active: waitCalls.filter((call) => call.responseState === 'active').length,
      terminal: waitCalls.filter((call) => call.responseState === 'terminal').length,
      error: waitCalls.filter((call) => call.responseState === 'error').length,
      totalBlockedMs: waitCalls.reduce((total, call) => total + (call.blockedMs ?? 0), 0),
    },
    progress: {
      count: progress.length,
      totalBytes: progress.reduce((total, item) => total + item.bytes, 0),
      updates: progress,
    },
    outputReader: {
      calls: outputReads.length,
      totalResponseBytes: outputReads.reduce((total, call) => total + (call.responseBytes ?? 0), 0),
    },
  }, null, 2)}\n`);
}

function conciseRequests(payload) {
  if (payload.type === 'mcp_tool_call_end') {
    return [payload.invocation?.tool ?? 'mcp'];
  }
  if (payload.type !== 'custom_tool_call' && payload.type !== 'function_call') return [];
  const input = String(payload.input ?? payload.arguments ?? '');
  const nested = [...input.matchAll(/mcp__agentknot__([a-zA-Z0-9_]+)/gu)].map(
    (match) => match[1]
  );
  if (nested.length > 0) return nested;
  if (payload.name === 'wait') return [`functions.wait ${input}`];
  const labels = [];
  if (/update_plan/u.test(input)) labels.push('plan bookkeeping');
  if (/apply_patch/u.test(input)) labels.push('artifact apply');
  if (/git status/u.test(input)) labels.push('git status');
  if (/npm test/u.test(input)) labels.push('final validation');
  if (/ALL_TOOLS/u.test(input)) labels.push('tool discovery');
  if (/SKILL\.md/u.test(input)) labels.push('skill read');
  return labels.length > 0 ? labels : [payload.name ?? payload.type];
}

function codexAnalysis(sessionPath) {
  const entries = readFileSync(sessionPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  let turn = 0;
  let actions = [];
  const rows = [];
  for (const entry of entries) {
    const payload = asObject(entry.payload);
    if (entry.type === 'response_item') {
      actions.push(...conciseRequests(payload ?? {}));
      continue;
    }
    if (entry.type !== 'event_msg' || payload?.type !== 'token_count') continue;
    turn += 1;
    const info = asObject(payload.info);
    const last = asObject(info?.last_token_usage) ?? {};
    const total = asObject(info?.total_token_usage) ?? {};
    rows.push({
      turn,
      timestamp: entry.timestamp,
      actions: [...new Set(actions)],
      usage: {
        input: last.input_tokens,
        cachedInput: last.cached_input_tokens,
        nonCachedInput:
          typeof last.input_tokens === 'number' && typeof last.cached_input_tokens === 'number'
            ? last.input_tokens - last.cached_input_tokens
            : undefined,
        output: last.output_tokens,
        reasoning: last.reasoning_output_tokens,
        total: last.total_tokens,
      },
      cumulative: {
        input: total.input_tokens,
        cachedInput: total.cached_input_tokens,
        output: total.output_tokens,
        reasoning: total.reasoning_output_tokens,
        total: total.total_tokens,
      },
    });
    actions = [];
  }
  process.stdout.write(`${JSON.stringify({ rows }, null, 2)}\n`);
}

function proxy(logPath, command, args) {
  const descriptor = openSync(logPath, 'a', 0o600);
  chmodSync(logPath, 0o600);
  const child = spawn(command, args, { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  let controllerPending = Buffer.alloc(0);
  let serverPending = Buffer.alloc(0);

  const recordLines = (direction, chunk, pending) => {
    let value = Buffer.concat([pending, chunk]);
    while (true) {
      const newline = value.indexOf(0x0a);
      if (newline < 0) return value;
      const line = value.subarray(0, newline);
      value = value.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      let message;
      try {
        message = JSON.parse(line.toString('utf8'));
      } catch {
        message = { unparsed: true };
      }
      appendFileSync(descriptor, `${JSON.stringify({
        at: new Date().toISOString(),
        direction,
        bytes: line.byteLength,
        message,
      })}\n`);
    }
  };

  process.stdin.on('data', (chunk) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    controllerPending = recordLines('controller-to-server', value, controllerPending);
    child.stdin.write(value);
  });
  process.stdin.on('end', () => child.stdin.end());
  child.stdout.on('data', (chunk) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    serverPending = recordLines('server-to-controller', value, serverPending);
    process.stdout.write(value);
  });

  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  child.once('error', (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  });
  child.once('close', (code, signal) => {
    closeSync(descriptor);
    if (signal !== null) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

const [first, second, ...rest] = process.argv.slice(2);
if (first === '--analyze') {
  if (second === undefined || rest.length !== 0) usage();
  else transportAnalysis(second);
} else if (first === '--analyze-codex') {
  if (second === undefined || rest.length !== 0) usage();
  else codexAnalysis(second);
} else if (first === undefined || second === undefined) {
  usage();
} else {
  proxy(first, second, rest);
}

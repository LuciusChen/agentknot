#!/usr/bin/env node

import { appendFileSync, chmodSync, closeSync, openSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

function usage() {
  process.stderr.write(
    'Usage:\n' +
      '  handoff-pilot-mcp-proxy.mjs LOG COMMAND [ARG...]\n' +
      '  handoff-pilot-mcp-proxy.mjs --analyze LOG\n'
  );
  process.exitCode = 2;
}

function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function terminalHandoff(value) {
  const root = asObject(value);
  if (root === undefined) return undefined;
  const nested = asObject(root.terminal);
  if (nested !== undefined) return nested;
  if (
    typeof root.status === 'string' &&
    Array.isArray(root.children) &&
    ['succeeded', 'failed', 'cancelled'].includes(root.status)
  ) {
    return root;
  }
  return undefined;
}

function analyze(logPath) {
  const allEntries = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const sessionStarts = allEntries.flatMap((entry, index) =>
    entry.direction === 'controller-to-server' && asObject(entry.message)?.method === 'initialize'
      ? [index]
      : []
  );
  const entries = allEntries.slice(sessionStarts.at(-1) ?? 0);
  const pending = new Map();
  const calls = [];
  const terminalResponses = [];
  const outputReads = [];

  for (const entry of entries) {
    const message = asObject(entry.message);
    if (message === undefined) continue;
    if (entry.direction === 'controller-to-server' && message.method === 'tools/call') {
      const params = asObject(message.params);
      if (params === undefined || typeof params.name !== 'string') continue;
      const call = {
        id: String(message.id),
        name: params.name,
        arguments: asObject(params.arguments) ?? {},
        requestedAt: entry.at,
      };
      pending.set(call.id, call);
      calls.push(call);
      continue;
    }
    if (entry.direction !== 'server-to-controller' || message.id === undefined) continue;
    const call = pending.get(String(message.id));
    if (call === undefined) continue;
    call.completedAt = entry.at;
    const result = asObject(message.result);
    if (result === undefined) continue;
    const structured = asObject(result.structuredContent);
    const textBlock = Array.isArray(result.content)
      ? result.content.find((item) => asObject(item)?.type === 'text')
      : undefined;
    const text = asObject(textBlock)?.text;
    let textValue;
    if (typeof text === 'string') {
      try {
        textValue = JSON.parse(text);
      } catch {
        textValue = undefined;
      }
    }

    const structuredHandoff = terminalHandoff(structured);
    const textHandoff = terminalHandoff(textValue);
    if (structuredHandoff !== undefined && textHandoff !== undefined) {
      terminalResponses.push({
        tool: call.name,
        structuredHandoff,
        textHandoff,
        structuredBytes: utf8Bytes(JSON.stringify(structuredHandoff)),
        textBytes: utf8Bytes(JSON.stringify(textHandoff)),
        responseStructuredBytes: utf8Bytes(JSON.stringify(structured)),
        responseTextBytes: utf8Bytes(text),
      });
    }

    if (call.name === 'agentknot_job_output' && structured !== undefined) {
      outputReads.push({
        ...call.arguments,
        status: structured.status,
        returnedBytes:
          typeof structured.chunk === 'string' ? utf8Bytes(structured.chunk) : 0,
        hasMore: structured.hasMore,
        nextCursor: structured.nextCursor,
        totalBytes: structured.totalBytes,
      });
    }
  }

  const terminal = terminalResponses.at(-1);
  const children = Array.isArray(terminal?.structuredHandoff.children)
    ? terminal.structuredHandoff.children
    : [];
  const handoffTruncation = asObject(terminal?.structuredHandoff.handoffTruncation);
  const result = {
    transportSessions: sessionStarts.length,
    firstMessageAt: entries.at(0)?.at,
    lastMessageAt: entries.at(-1)?.at,
    toolCalls: calls.map(({ id, name, arguments: args, requestedAt, completedAt }) => ({
      id,
      name,
      arguments: args,
      requestedAt,
      completedAt,
    })),
    terminal:
      terminal === undefined
        ? null
        : {
            tool: terminal.tool,
            structuredContentBytes: terminal.structuredBytes,
            textJsonBytes: terminal.textBytes,
            combinedRepresentationBytes: terminal.structuredBytes + terminal.textBytes,
            enclosingStructuredContentBytes: terminal.responseStructuredBytes,
            enclosingTextJsonBytes: terminal.responseTextBytes,
            representationsEquivalent:
              JSON.stringify(terminal.structuredHandoff) === JSON.stringify(terminal.textHandoff),
            childCount: children.length,
            childOutputPresent: children.some((child) => asObject(child)?.output !== undefined),
            children: children.map((child) => {
              const value = asObject(child) ?? {};
              return {
                subtaskId: value.subtaskId,
                status: value.status,
                outputPresent: typeof value.output === 'string',
                outputBytes:
                  typeof value.output === 'string' ? utf8Bytes(value.output) : value.outputBytes,
                outputAvailable: value.outputAvailable,
                outputTruncated: value.outputTruncated,
                completionPresent: asObject(value.completion) !== undefined,
              };
            }),
            handoffTruncation:
              handoffTruncation === undefined
                ? null
                : {
                    applied: handoffTruncation.applied,
                    maxBytes: handoffTruncation.maxBytes,
                    originalBytes: handoffTruncation.originalBytes,
                    omittedItems: handoffTruncation.omittedItems,
                    affectedChildren: handoffTruncation.affectedChildren,
                  },
          },
    outputReads,
    totalOutputReadBytes: outputReads.reduce((total, read) => total + read.returnedBytes, 0),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
      appendFileSync(
        descriptor,
        `${JSON.stringify({
          at: new Date().toISOString(),
          direction,
          bytes: line.byteLength,
          message,
        })}\n`
      );
    }
  };

  process.stdin.on('data', (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    controllerPending = recordLines('controller-to-server', bytes, controllerPending);
    child.stdin.write(bytes);
  });
  process.stdin.on('end', () => child.stdin.end());
  child.stdout.on('data', (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    serverPending = recordLines('server-to-controller', bytes, serverPending);
    process.stdout.write(bytes);
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
  else analyze(second);
} else if (first === undefined || second === undefined) {
  usage();
} else {
  proxy(first, second, rest);
}

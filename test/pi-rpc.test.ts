import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PiRpcWorkerAdapter } from '../src/adapters/pi-rpc.js';
import type { JobEventType, ResolvedRoute } from '../src/types.js';

const route: ResolvedRoute = {
  name: 'fake-pi',
  worker: 'pi',
  provider: 'opencode-go',
  model: 'gpt-5.6-luna',
  thinkingLevel: 'high',
  requiredEnv: [],
  maxAttempts: 1,
  timeoutMs: 10_000,
};

test('PiRpcWorkerAdapter speaks JSONL RPC and normalizes Pi events', async () => {
  const fixture = path.resolve('test/fixtures/fake-pi.mjs');
  const adapter = new PiRpcWorkerAdapter('pi', {
    adapter: 'pi-rpc',
    command: process.execPath,
    commandArgs: [fixture],
    noSession: true,
  });
  const controller = new AbortController();
  const events: JobEventType[] = [];

  const result = await adapter.run(
    {
      jobId: 'job_test',
      prompt: 'do work',
      workspace: process.cwd(),
      route,
      attempt: 1,
      signal: controller.signal,
    },
    (type) => {
      events.push(type);
    }
  );

  assert.equal(result.output, 'fake result');
  assert.ok(events.includes('worker.started'));
  assert.ok(events.includes('worker.tool.started'));
  assert.ok(events.includes('worker.tool.completed'));
  assert.equal(events.filter((event) => event === 'worker.text.delta').length, 2);
});

test('PiRpcWorkerAdapter propagates the resolved thinking level to a live probe', async () => {
  const fixture = path.resolve('test/fixtures/fake-pi-diagnostics.mjs');
  const adapter = new PiRpcWorkerAdapter('pi', {
    adapter: 'pi-rpc',
    command: process.execPath,
    commandArgs: [fixture],
    noSession: true,
  });

  const result = await adapter.probe({
    route: { ...route, name: 'luna', thinkingLevel: 'max' },
    signal: new AbortController().signal,
  });

  assert.match(result.output, /thinking=max/);
  assert.match(result.output, /retry=false/);
});

test('PiRpcWorkerAdapter preserves provider errors from a live probe', async () => {
  const fixture = path.resolve('test/fixtures/fake-pi-diagnostics.mjs');
  const adapter = new PiRpcWorkerAdapter('pi', {
    adapter: 'pi-rpc',
    command: process.execPath,
    commandArgs: [fixture],
    noSession: true,
    environment: { FAKE_PI_ERROR: 'provider returned 403' },
  });

  await assert.rejects(
    adapter.probe({ route, signal: new AbortController().signal }),
    /provider returned 403/
  );
});

test('PiRpcWorkerAdapter isolates a live probe in a temporary workspace and removes it', async () => {
  const fixture = path.resolve('test/fixtures/fake-pi-diagnostics.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-pi-probe-cwd-'));
  const cwdFile = path.join(directory, 'child.cwd');
  try {
    const adapter = new PiRpcWorkerAdapter('pi', {
      adapter: 'pi-rpc',
      command: process.execPath,
      commandArgs: [fixture],
      noSession: true,
      environment: { FAKE_PI_CWD_FILE: cwdFile },
    });

    await adapter.probe({ route, signal: new AbortController().signal });
    const probeWorkspace = await readFile(cwdFile, 'utf8');
    assert.notEqual(probeWorkspace, process.cwd());
    await assert.rejects(stat(probeWorkspace), (error: unknown) => {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PiRpcWorkerAdapter terminates a live probe child on abort', async () => {
  const fixture = path.resolve('test/fixtures/fake-pi-diagnostics.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-pi-probe-'));
  const pidFile = path.join(directory, 'child.pid');
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    const adapter = new PiRpcWorkerAdapter('pi', {
      adapter: 'pi-rpc',
      command: process.execPath,
      commandArgs: [fixture],
      noSession: true,
      environment: { FAKE_PI_HANG: '1', FAKE_PI_PID_FILE: pidFile },
    });
    pending = adapter.probe({ route, signal: controller.signal });

    let pid: number | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        pid = Number(await readFile(pidFile, 'utf8'));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    assert.ok(pid && Number.isInteger(pid));
    controller.abort(new Error('diagnostic cancelled'));
    await assert.rejects(pending, /diagnostic cancelled/);
    assert.throws(() => process.kill(pid as number, 0), (error: unknown) => {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    });
  } finally {
    controller.abort(new Error('test cleanup'));
    await pending?.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

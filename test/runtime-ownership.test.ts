import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';

import {
  acquireRuntimeOwnership,
  RuntimeOwnershipError,
} from '../src/runtime-ownership.js';

const runtimeOwnershipModule = pathToFileURL(
  fileURLToPath(new URL('../src/runtime-ownership.js', import.meta.url))
).href;

function childScript(hold: boolean): string {
  return `
import { acquireRuntimeOwnership } from ${JSON.stringify(runtimeOwnershipModule)};
const directories = JSON.parse(process.argv[1]);
const ownership = await acquireRuntimeOwnership(directories);
process.stdout.write('ready\\n');
${
  hold
    ? `
process.stdin.resume();
await new Promise((resolve, reject) => {
  process.stdin.once('end', resolve);
  process.stdin.once('error', reject);
});
await ownership.close();
`
    : ''
}
`;
}

function startChild(directories: string[], hold: boolean): ChildProcess {
  return spawn(
    process.execPath,
    ['--input-type=module', '-e', childScript(hold), JSON.stringify(directories)],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

async function waitForReady(child: ChildProcess): Promise<void> {
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.stdin?.end();
      reject(new Error(`ownership child did not become ready: ${output}`));
    }, 5_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (!output.includes('ready\n')) return;
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      resolve();
    };
    const onExit = (code: number | null): void => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      reject(new Error(`ownership child exited before becoming ready (${code}): ${output}`));
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await once(child, 'exit');
}

async function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = waitForExit(child);
  child.stdin?.end();
  await exited;
}

async function createDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'agentknot-runtime-ownership-'));
}

test('same-process contention ends at close and close is idempotent', async () => {
  const root = await createDirectory();
  const storage = path.join(root, 'storage');
  try {
    const first = await acquireRuntimeOwnership([storage]);
    await assert.rejects(
      acquireRuntimeOwnership([storage]),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeOwnershipError);
        assert.match(error.message, /Another execution-owning AgentKnot runtime already owns storage directory/);
        assert.ok(error.message.length < 1_024);
        return true;
      }
    );

    await Promise.all([first.close(), first.close(), first.close()]);
    await first.close();
    assert.throws(() => first.assertHeld(), /Runtime storage ownership has been released/);

    const second = await acquireRuntimeOwnership([storage]);
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('separate-process contention releases after a graceful child close', async () => {
  const root = await createDirectory();
  const storage = path.join(root, 'storage');
  const child = startChild([storage], true);
  try {
    await waitForReady(child);
    await assert.rejects(
      acquireRuntimeOwnership([storage]),
      /Another execution-owning AgentKnot runtime already owns storage directory/
    );
    await closeChild(child);

    const ownership = await acquireRuntimeOwnership([storage]);
    await ownership.close();
  } finally {
    await closeChild(child);
    await rm(root, { recursive: true, force: true });
  }
});

test('a child process that exits without close releases its ownership', async () => {
  const root = await createDirectory();
  const storage = path.join(root, 'storage');
  const child = startChild([storage], false);
  try {
    await waitForReady(child);
    await waitForExit(child);

    const ownership = await acquireRuntimeOwnership([storage]);
    await ownership.close();
  } finally {
    await closeChild(child);
    await rm(root, { recursive: true, force: true });
  }
});

test('resolved paths are sorted, duplicate paths are rejected, and the private lock is not a record', async () => {
  const root = await createDirectory();
  const firstPath = path.join(root, 'a-storage');
  const secondPath = path.join(root, 'z-storage');
  try {
    const ownership = await acquireRuntimeOwnership([secondPath, firstPath]);
    assert.deepEqual(ownership.directories, [firstPath, secondPath]);
    assert.deepEqual((await readdir(firstPath)).filter((name) => name.endsWith('.json')), []);
    assert.deepEqual((await readdir(secondPath)).filter((name) => name.endsWith('.json')), []);
    await ownership.close();

    await assert.rejects(
      acquireRuntimeOwnership([firstPath, firstPath]),
      /must resolve to distinct locations/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('partial acquisition cleanup releases earlier directories after later contention', async () => {
  const root = await createDirectory();
  const earlier = path.join(root, 'a-earlier');
  const later = path.join(root, 'z-contended');
  const blocker = await acquireRuntimeOwnership([later]);
  try {
    await assert.rejects(
      acquireRuntimeOwnership([later, earlier]),
      /Another execution-owning AgentKnot runtime already owns storage directory/
    );

    const earlierOwnership = await acquireRuntimeOwnership([earlier]);
    await earlierOwnership.close();
  } finally {
    await blocker.close();
    await rm(root, { recursive: true, force: true });
  }
});

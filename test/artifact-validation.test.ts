import assert from 'node:assert/strict';
import test from 'node:test';

import { runArtifactValidationCommand } from '../src/artifact-validation.js';

test('artifact validation runs one argv command without a shell and captures bounded evidence', async () => {
  const times = [10, 25];
  const result = await runArtifactValidationCommand(
    {
      argv: [
        process.execPath,
        '-e',
        "process.stdout.write('validated'); process.stderr.write('notice')",
      ],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    },
    process.cwd(),
    new AbortController().signal,
    () => times.shift() ?? 25
  );

  assert.deepEqual(result, {
    argv: [
      process.execPath,
      '-e',
      "process.stdout.write('validated'); process.stderr.write('notice')",
    ],
    outcome: 'passed',
    exitCode: 0,
    signal: null,
    durationMs: 15,
    stdout: 'validated',
    stderr: 'notice',
    outputTruncated: false,
    maxOutputBytes: 1_024,
  });
});

test('artifact validation keeps a nonzero command result distinct from timeout', async () => {
  const result = await runArtifactValidationCommand(
    {
      argv: [process.execPath, '-e', "process.stderr.write('nope'); process.exit(7)"],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    },
    process.cwd(),
    new AbortController().signal
  );

  assert.equal(result.outcome, 'failed');
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, 'nope');
  assert.equal(result.outputTruncated, false);
});

test('artifact validation bounds process start errors within the same evidence limit', async () => {
  const result = await runArtifactValidationCommand(
    {
      argv: ['/definitely/missing/agentknot-validation-command'],
      timeoutMs: 1_000,
      maxOutputBytes: 16,
    },
    process.cwd(),
    new AbortController().signal
  );

  assert.equal(result.outcome, 'failed');
  assert.notEqual(result.exitCode, 0);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 16, true);
  assert.equal(result.outputTruncated, true);
});

test('artifact validation terminates one timed-out child', async () => {
  const result = await runArtifactValidationCommand(
    {
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1_000)'],
      timeoutMs: 20,
      maxOutputBytes: 1_024,
    },
    process.cwd(),
    new AbortController().signal
  );

  assert.equal(result.outcome, 'timed-out');
  assert.notEqual(result.signal, null);
});

test('artifact validation stops at its shared stdout and stderr byte limit', async () => {
  const result = await runArtifactValidationCommand(
    {
      argv: [process.execPath, '-e', "process.stdout.write('123456789'); process.stderr.write('abcdef')"],
      timeoutMs: 1_000,
      maxOutputBytes: 10,
    },
    process.cwd(),
    new AbortController().signal
  );

  assert.equal(result.outcome, 'output-limit');
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 10, true);
  assert.equal(result.outputTruncated, true);
});

test('artifact validation cancellation cannot become a passing result', async () => {
  const controller = new AbortController();
  const pending = runArtifactValidationCommand(
    {
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1_000)'],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    },
    process.cwd(),
    controller.signal
  );
  setTimeout(() => controller.abort(new Error('cancelled by test')), 20);

  const result = await pending;
  assert.equal(result.outcome, 'cancelled');
  assert.notEqual(result.signal, null);
});

test('artifact validation bounds cancellation evidence before process start', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled-before-start'.repeat(10)));

  const result = await runArtifactValidationCommand(
    {
      argv: [process.execPath, '-e', "process.stdout.write('should not run')"],
      timeoutMs: 1_000,
      maxOutputBytes: 17,
    },
    process.cwd(),
    controller.signal
  );

  assert.equal(result.outcome, 'cancelled');
  assert.equal(Buffer.byteLength(result.stderr) <= 17, true);
  assert.equal(result.outputTruncated, true);
});

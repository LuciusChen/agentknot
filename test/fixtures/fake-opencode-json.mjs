#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const mode = process.env.FAKE_OPENCODE_MODE ?? 'success';

if (process.env.FAKE_OPENCODE_ARGV_FILE) {
  await writeFile(process.env.FAKE_OPENCODE_ARGV_FILE, JSON.stringify(args));
}
if (process.env.FAKE_OPENCODE_PID_FILE) {
  await writeFile(process.env.FAKE_OPENCODE_PID_FILE, String(process.pid));
}
if (process.env.FAKE_OPENCODE_WRITE_FILE) {
  await writeFile(process.env.FAKE_OPENCODE_WRITE_FILE, 'created by fake OpenCode\n');
}

if (mode === 'block') {
  process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 1_000);
} else if (mode === 'malformed') {
  process.stdout.write('{not json}\n');
} else if (mode === 'exit-nonzero') {
  process.stderr.write('fake opencode failed');
  process.exitCode = 17;
} else {
  const prompt = args.at(-1) ?? '';
  const live = prompt.includes('bounded AgentKnot live inference probe');
  let output = live
    ? 'AgentKnot live inference probe succeeded.'
    : 'OpenCode conformance output';
  if (!live && process.env.FAKE_OPENCODE_COMPLETION === 'valid') {
    output +=
      `\nAGENTKNOT_WORKER_COMPLETION_REPORT_V1: {"schemaVersion":1,"taskOutcome":"${process.env.FAKE_OPENCODE_TASK_OUTCOME ?? 'completed'}","changedFiles":["result.txt"],"checksRun":[{"command":"npm test","outcome":"passed"}],"remainingRisks":[],"notes":["fixture"]}`;
  }
  if (!live && process.env.FAKE_OPENCODE_COMPLETION === 'malformed') {
    output += '\nAGENTKNOT_WORKER_COMPLETION_REPORT_V1: {bad';
  }

  const events = [
    { type: 'step_start', part: { type: 'step-start' } },
    { type: 'text', part: { type: 'text', text: output } },
    ...(mode === 'error-event'
      ? [{ type: 'error', error: { data: { message: 'fake OpenCode provider error' } } }]
      : []),
    ...(mode === 'no-finish'
      ? []
      : [
          {
            type: 'step_finish',
            part: {
              type: 'step-finish',
              reason: 'stop',
              tokens:
                process.env.FAKE_OPENCODE_STATS === 'invalid'
                  ? { total: 19, input: null, output: 5, cache: {} }
                  : {
                      total: 19,
                      input: 3,
                      output: 5,
                      reasoning: 7,
                      cache: { read: 2, write: 9 },
                    },
              cost: 0.125,
            },
          },
        ]),
  ];
  const jsonl = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  if (mode === 'chunked') {
    const bytes = Buffer.from(jsonl);
    for (let offset = 0; offset < bytes.length; offset += 3) {
      process.stdout.write(bytes.subarray(offset, offset + 3));
    }
  } else {
    process.stdout.write(jsonl);
  }
}

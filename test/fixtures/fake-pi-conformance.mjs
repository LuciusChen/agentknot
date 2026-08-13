import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

let mode = process.env.FAKE_PI_MODE ?? 'split';

if (mode === 'exit-once-then-split') {
  const marker = process.env.FAKE_PI_ATTEMPT_MARKER;
  if (!marker) throw new Error('FAKE_PI_ATTEMPT_MARKER is required for exit-once-then-split');
  if (existsSync(marker)) mode = 'split';
  else {
    writeFileSync(marker, 'first attempt\n');
    mode = 'exit-before-settled';
  }
}

if (process.env.FAKE_PI_PID_FILE) writeFileSync(process.env.FAKE_PI_PID_FILE, String(process.pid));
if (process.env.FAKE_PI_PID_LOG) appendFileSync(process.env.FAKE_PI_PID_LOG, `${process.pid}\n`);

if (mode === 'ignore-sigterm') {
  process.on('SIGTERM', () => {
    if (process.env.FAKE_PI_SIGTERM_FILE) writeFileSync(process.env.FAKE_PI_SIGTERM_FILE, 'ignored\n');
  });
  setInterval(() => {}, 1_000);
}
if (mode === 'malformed') setInterval(() => {}, 1_000);

function sendFrame(value, splitAt, done) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (splitAt === undefined || splitAt <= 0 || splitAt >= bytes.length) {
    process.stdout.write(bytes, done);
    return;
  }
  process.stdout.write(bytes.subarray(0, splitAt), () => {
    setTimeout(() => process.stdout.write(bytes.subarray(splitAt), done), 20);
  });
}

function sendFrames(frames, split, done, index = 0) {
  const frame = frames[index];
  if (frame === undefined) {
    done();
    return;
  }
  sendFrame(frame, split ? Math.floor(Buffer.byteLength(`${JSON.stringify(frame)}\n`, 'utf8') / 2) : undefined, () => {
    sendFrames(frames, split, done, index + 1);
  });
}

function sendSplitUtf8Frames(done) {
  const text =
    'before🙂after\nAGENTKNOT_WORKER_COMPLETION_REPORT_V1: {"schemaVersion":1,"taskOutcome":"completed","changedFiles":[],"checksRun":[],"remainingRisks":[],"notes":[]}';
  const frames = [
    { id: 'prompt', type: 'response', command: 'prompt', success: true },
    { type: 'agent_start' },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled' },
  ];
  const encoded = Buffer.from(`${JSON.stringify(frames[2])}\n`, 'utf8');
  const emojiStart = encoded.indexOf(Buffer.from('🙂', 'utf8'));
  sendFrame(frames[0], Math.floor(Buffer.byteLength(`${JSON.stringify(frames[0])}\n`, 'utf8') / 2), () => {
    sendFrame(frames[1], Math.floor(Buffer.byteLength(`${JSON.stringify(frames[1])}\n`, 'utf8') / 2), () => {
      sendFrame(frames[2], emojiStart + 1, () => {
        sendFrame(frames[3], Math.floor(Buffer.byteLength(`${JSON.stringify(frames[3])}\n`, 'utf8') / 2), () => {
          sendFrame(frames[4], Math.floor(Buffer.byteLength(`${JSON.stringify(frames[4])}\n`, 'utf8') / 2), done);
        });
      });
    });
  });
}

function sendSplitUtf8Stderr(done) {
  const encoded = Buffer.from(`discard-${'x'.repeat(4_096)}-before🙂after`, 'utf8');
  const emojiStart = encoded.indexOf(Buffer.from('🙂', 'utf8'));
  process.stderr.write(encoded.subarray(0, emojiStart + 1), () => {
    setTimeout(() => process.stderr.write(encoded.subarray(emojiStart + 1), done), 20);
  });
}

const completionEnvelope = `AGENTKNOT_WORKER_COMPLETION_REPORT_V1: ${JSON.stringify({
  schemaVersion: 1,
  taskOutcome: 'completed',
  changedFiles: [],
  checksRun: [],
  remainingRisks: [],
  notes: [],
})}`;

function sendTurn(command, text, messages = []) {
  const frames = [
    { id: command.id, type: 'response', command: command.type, success: true },
    { type: 'agent_start' },
    ...(text === '' ? [] : [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }]),
    { type: 'agent_end', messages, willRetry: false },
    { type: 'agent_settled' },
  ];
  sendFrames(frames, true, () => {});
}

function handle(command) {
  if (process.env.FAKE_PI_COMMAND_LOG) {
    appendFileSync(process.env.FAKE_PI_COMMAND_LOG, `${JSON.stringify({
      type: command.type,
      id: command.id,
      message: typeof command.message === 'string' ? command.message.replace(/\r?\n/g, '\\n') : command.message,
    })}\n`);
  }
  if (command.id === 'prompt' && process.env.FAKE_PI_PROMPT_FILE) {
    writeFileSync(process.env.FAKE_PI_PROMPT_FILE, command.message);
  }
  if (command.type === 'get_session_stats' && process.env.FAKE_PI_STATS_MODE === 'success') {
    sendFrame({
      id: command.id,
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: {
        userMessages: 2,
        assistantMessages: 3,
        toolCalls: 4,
        toolResults: 5,
        totalMessages: 6,
        tokens: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, total: 50 },
        cost: 0.42,
        contextUsage: { tokens: 321, contextWindow: 1000, percent: 32.1 },
      },
    });
    return;
  }
  if (command.type !== 'prompt' && command.type !== 'follow_up') return;

  switch (mode) {
    case 'split':
      sendSplitUtf8Frames(() => {});
      break;
    case 'completion-recovery-success':
      if (command.id === 'prompt') sendTurn(command, 'first turn without its envelope');
      else sendTurn(command, completionEnvelope);
      break;
    case 'completion-recovery-failure':
      sendTurn(
        command,
        command.id === 'prompt' ? 'first turn without its envelope' : 'second turn still without its envelope'
      );
      break;
    case 'settled-assistant-error':
      if (command.id === 'prompt') {
        sendTurn(command, 'assistant error output', [
          { role: 'assistant', stopReason: 'error', errorMessage: 'fixture assistant terminal error' },
        ]);
      } else {
        sendTurn(command, `\n${completionEnvelope}`);
      }
      break;
    case 'malformed':
      process.stdout.write(`${JSON.stringify({ type: 'agent_start' })}\n{"type":\n`);
      break;
    case 'exit-before-settled':
      sendFrames([{ type: 'agent_start' }], true, () => {
        setTimeout(() => {
          process.stderr.write('premature fixture exit\n');
          process.exit(17);
        }, 50);
      });
      break;
    case 'agent-end-without-settled':
      sendFrames([{ type: 'agent_start' }, { type: 'agent_end', messages: [], willRetry: false }], true, () => {
        setTimeout(() => {
          process.stderr.write('missing settlement fixture\n');
          process.exit(23);
        }, 50);
      });
      break;
    case 'settled-downstream-error':
      sendFrames([
        { id: 'prompt', type: 'response', command: 'prompt', success: true },
        { type: 'agent_start' },
        {
          type: 'auto_retry_start',
          attempt: 3,
          maxAttempts: 3,
          delayMs: 8000,
          errorMessage: 'private downstream detail',
        },
        {
          type: 'auto_retry_end',
          success: false,
          attempt: 3,
          finalError: 'private downstream detail',
        },
        {
          type: 'agent_end',
          messages: [
            { role: 'assistant', stopReason: 'error', errorMessage: 'temporary downstream failure' },
          ],
          willRetry: false,
        },
        { type: 'agent_settled' },
      ], true, () => {});
      break;
    case 'stderr-split-exit':
      sendFrames([{ type: 'agent_start' }], true, () => {
        sendSplitUtf8Stderr(() => process.exit(29));
      });
      break;
    case 'ignore-sigterm':
      break;
    default:
      throw new Error(`Unknown fake Pi mode: ${mode}`);
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    if (line !== '') handle(JSON.parse(line));
  }
});

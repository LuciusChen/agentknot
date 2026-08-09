import { writeFileSync } from 'node:fs';

if (process.env.FAKE_PI_PATH_FILE) {
  writeFileSync(process.env.FAKE_PI_PATH_FILE, process.env.PATH ?? '');
}
if (process.env.FAKE_PI_ARGV_FILE) {
  writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
}
if (process.env.FAKE_PI_CWD_FILE) {
  writeFileSync(process.env.FAKE_PI_CWD_FILE, process.cwd());
}
if (process.env.FAKE_PI_PID_FILE) {
  writeFileSync(process.env.FAKE_PI_PID_FILE, String(process.pid));
}

let buffer = '';

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handle(command) {
  if (command.type === 'get_session_stats') {
    if (process.env.FAKE_PI_STATS_REQUEST_FILE) {
      writeFileSync(process.env.FAKE_PI_STATS_REQUEST_FILE, JSON.stringify(command));
    }
    const mode = process.env.FAKE_PI_STATS_MODE ?? 'success';
    if (mode === 'timeout') return;
    if (mode === 'unsupported') {
      send({
        id: command.id,
        type: 'response',
        command: 'get_session_stats',
        success: false,
        error: 'stats unsupported secret-token /private/stats-error-path',
      });
      return;
    }
    if (mode === 'invalid') {
      send({
        id: command.id,
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          sessionFile: '/private/session.json',
          sessionId: 'secret-session-id',
          userMessages: 'not-a-count',
          rawResponse: 'secret-raw-stats',
          credential: 'secret-token',
        },
      });
      return;
    }
    if (mode !== 'success') throw new Error(`Unknown stats mode: ${mode}`);
    send({
      id: command.id,
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: {
        sessionFile: '/private/session.json',
        sessionId: 'secret-session-id',
        userMessages: 2,
        assistantMessages: 3,
        toolCalls: 4,
        toolResults: 5,
        totalMessages: 6,
        tokens: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, total: 50 },
        cost: 0.42,
        contextUsage: { tokens: 321, contextWindow: 1000, percent: 32.1 },
        path: '/private/raw-stats-path',
        credential: 'secret-token',
        rawResponse: { secret: 'secret-raw-stats' },
      },
    });
    return;
  }

  if (command.type !== 'prompt') {
    send({ id: command.id, type: 'response', command: command.type, success: true });
    return;
  }

  send({ id: command.id, type: 'response', command: 'prompt', success: true });
  send({ type: 'agent_start' });
  send({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'fake ' },
  });
  send({
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'read',
    args: { path: 'README.md' },
  });
  send({
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    toolName: 'read',
    result: { ok: true },
    isError: false,
  });
  send({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'result' },
  });
  send({ type: 'agent_end', messages: [], willRetry: false });
  send({ type: 'agent_settled' });
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    if (line !== '') handle(JSON.parse(line));
  }
});

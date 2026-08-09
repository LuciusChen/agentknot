import { writeFileSync } from 'node:fs';

let buffer = '';
let thinkingLevel;
let autoRetry;

if (process.env.FAKE_PI_ARGV_FILE) {
  writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
}
if (process.env.FAKE_PI_PID_FILE) writeFileSync(process.env.FAKE_PI_PID_FILE, String(process.pid));
if (process.env.FAKE_PI_CWD_FILE) writeFileSync(process.env.FAKE_PI_CWD_FILE, process.cwd());

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handle(command) {
  if (command.type === 'get_session_stats') {
    if (process.env.FAKE_PI_STATS_REQUEST_FILE) {
      writeFileSync(process.env.FAKE_PI_STATS_REQUEST_FILE, JSON.stringify(command));
    }
    send({ id: command.id, type: 'response', command: command.type, success: true });
    return;
  }
  if (command.type === 'set_auto_retry') {
    autoRetry = command.enabled;
    send({ id: command.id, type: 'response', command: command.type, success: true });
    return;
  }
  if (command.type === 'set_thinking_level') {
    thinkingLevel = command.level;
    send({ id: command.id, type: 'response', command: command.type, success: true });
    return;
  }
  if (command.type !== 'prompt') {
    send({ id: command.id, type: 'response', command: command.type, success: true });
    return;
  }

  if (process.env.FAKE_PI_PROMPT_FILE) writeFileSync(process.env.FAKE_PI_PROMPT_FILE, command.message);
  if (process.env.FAKE_PI_HANG === '1') return;

  send({ id: command.id, type: 'response', command: 'prompt', success: true });
  send({ type: 'agent_start' });
  if (process.env.FAKE_PI_ERROR) {
    send({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: process.env.FAKE_PI_ERROR,
        },
      ],
      willRetry: false,
    });
  } else {
    send({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: `AgentKnot live inference probe succeeded. thinking=${thinkingLevel ?? 'default'} retry=${String(autoRetry)}`,
      },
    });
    send({ type: 'agent_end', messages: [], willRetry: false });
  }
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

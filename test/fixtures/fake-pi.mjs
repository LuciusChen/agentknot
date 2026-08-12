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
const WORKER_COMPLETION_REPORT_MARKER = 'AGENTKNOT_WORKER_COMPLETION_REPORT_V1';
const ARTIFACT_READ_PROTOCOL = 'agentknot-artifact-read-v1';

let buffer = '';
const controls = [];

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendTextDeltas(text) {
  const requestedSize = Number(process.env.FAKE_PI_TEXT_DELTA_SIZE ?? text.length);
  const size = Number.isSafeInteger(requestedSize) && requestedSize > 0 ? requestedSize : text.length;
  for (let offset = 0; offset < text.length; offset += size) {
    send({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: text.slice(offset, offset + size),
      },
    });
  }
}

function completionOutput(message) {
  let humanOutput;
  if (
    process.env.FAKE_PI_PLANNER_OUTPUT !== undefined &&
    message.startsWith("You are AgentKnot's read-only task classifier.")
  ) {
    humanOutput = process.env.FAKE_PI_PLANNER_OUTPUT;
  } else if (
    process.env.FAKE_PI_REVIEW_OUTPUT !== undefined &&
    message.startsWith("You are AgentKnot's independent advisory quality reviewer")
  ) {
    humanOutput = process.env.FAKE_PI_REVIEW_OUTPUT;
  } else {
    humanOutput = process.env.FAKE_PI_COMPLETION_OUTPUT ?? process.env.FAKE_PI_HUMAN_OUTPUT ?? 'fake result';
  }
  const validReport = {
    schemaVersion: 1,
    taskOutcome: process.env.FAKE_PI_COMPLETION_MODE === 'blocked' ? 'blocked' : 'completed',
    changedFiles: ['worker-claimed.ts'],
    checksRun: [
      { command: 'npm test', outcome: 'passed' },
      { command: 'npm run lint', outcome: 'unknown', notes: 'No lint script.' },
    ],
    remainingRisks: ['Worker-reported risk.'],
    notes: ['Worker-reported note.'],
  };
  const envelope = `${WORKER_COMPLETION_REPORT_MARKER}: ${JSON.stringify(validReport)}`;
  switch (process.env.FAKE_PI_COMPLETION_MODE ?? 'valid') {
    case 'valid':
      return `${humanOutput}\n${envelope}`;
    case 'blocked':
      return `${humanOutput}\n${envelope}`;
    case 'malformed':
      return `${humanOutput}\n${WORKER_COMPLETION_REPORT_MARKER}: {"schemaVersion":1,"changedFiles":"not-an-array"}`;
    case 'unsupported':
      return `${humanOutput}\n${WORKER_COMPLETION_REPORT_MARKER}: ${JSON.stringify({ ...validReport, schemaVersion: 2 })}`;
    case 'trailing':
      return `${humanOutput}\n${envelope}\ntrailing prose`;
    case 'prose':
      return `${humanOutput}; AGENTKNOT_WORKER_COMPLETION_REPORT_V1 is mentioned in ordinary prose.`;
    case 'missing':
      return humanOutput;
    default:
      throw new Error(`Unknown completion mode: ${process.env.FAKE_PI_COMPLETION_MODE}`);
  }
}

function requestArtifact() {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error('Fixture artifact IPC is unavailable'));
      return;
    }
    const requestId = 'fixture-artifact-read-1';
    const onMessage = (message) => {
      if (
        message?.protocol !== ARTIFACT_READ_PROTOCOL ||
        message?.requestId !== requestId
      ) return;
      process.off('message', onMessage);
      resolve(message);
    };
    process.on('message', onMessage);
    process.send(
      { protocol: ARTIFACT_READ_PROTOCOL, schemaVersion: 1, action: 'read', requestId },
      (error) => {
        if (error === null) return;
        process.off('message', onMessage);
        reject(error);
      }
    );
  });
}

async function handle(command) {
  if (command.type === 'steer' || command.type === 'follow_up') {
    controls.push(command);
    if (process.env.FAKE_PI_CONTROL_FILE) {
      writeFileSync(process.env.FAKE_PI_CONTROL_FILE, JSON.stringify(controls));
    }
    const accepted = process.env.FAKE_PI_CONTROL_MODE !== 'reject';
    const response = {
      id: command.id,
      type: 'response',
      command: command.type,
      success: accepted,
      ...(accepted ? {} : { error: 'fixture control rejection' }),
    };
    const delay = Number(process.env.FAKE_PI_CONTROL_RESPONSE_DELAY_MS ?? 0);
    if (Number.isFinite(delay) && delay > 0) setTimeout(() => send(response), delay);
    else send(response);
    return;
  }

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
    if (mode !== 'success' && mode !== 'zero') throw new Error(`Unknown stats mode: ${mode}`);
    const zero = mode === 'zero';
    send({
      id: command.id,
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: {
        sessionFile: '/private/session.json',
        sessionId: 'secret-session-id',
        userMessages: zero ? 0 : 2,
        assistantMessages: zero ? 0 : 3,
        toolCalls: zero ? 0 : 4,
        toolResults: zero ? 0 : 5,
        totalMessages: zero ? 0 : 6,
        tokens: {
          input: zero ? 0 : 11,
          output: zero ? 0 : 12,
          cacheRead: zero ? 0 : 13,
          cacheWrite: zero ? 0 : 14,
          total: zero ? 0 : 50,
        },
        cost: zero ? 0 : 0.42,
        contextUsage: {
          tokens: zero ? 0 : 321,
          contextWindow: zero ? 0 : 1000,
          percent: zero ? 0 : 32.1,
        },
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

  if (process.env.FAKE_PI_PROMPT_FILE) {
    writeFileSync(process.env.FAKE_PI_PROMPT_FILE, command.message);
  }
  if (
    process.env.FAKE_PI_WRITE_REVIEWED_FILE === 'true' &&
    command.message.startsWith('You are executing one bounded subtask selected by AgentKnot.')
  ) {
    writeFileSync('reviewed.txt', 'reviewed fixture\n');
  }
  const output = completionOutput(command.message);
  const splitAt = Math.min(5, output.length);

  send({ id: command.id, type: 'response', command: 'prompt', success: true });
  const emitLifecycleFixture = process.env.FAKE_PI_LIFECYCLE_EVENTS === 'true';
  if (emitLifecycleFixture) send({ type: 'turn_start', turnId: 'fixture-turn' });
  send({ type: 'agent_start' });
  if (emitLifecycleFixture) send({ type: 'message_start', messageId: 'fixture-message' });
  sendTextDeltas(output.slice(0, splitAt));
  const artifactToolMode = process.env.FAKE_PI_ARTIFACT_TOOL;
  if (
    artifactToolMode === 'true' ||
    (
      artifactToolMode === 'review' &&
      command.message.startsWith("You are AgentKnot's independent advisory quality reviewer")
    )
  ) {
    send({
      type: 'tool_execution_start',
      toolCallId: 'artifact-tool-1',
      toolName: 'agentknot_artifact_read',
      args: { injectedPath: '/must/not/persist', injectedContent: 'must/not/persist' },
    });
    const artifact = await requestArtifact();
    if (process.env.FAKE_PI_ARTIFACT_CAPTURE_FILE) {
      writeFileSync(process.env.FAKE_PI_ARTIFACT_CAPTURE_FILE, JSON.stringify(artifact));
    }
    send({
      type: 'tool_execution_end',
      toolCallId: 'artifact-tool-1',
      toolName: 'agentknot_artifact_read',
      result: {
        content: [{ type: 'text', text: artifact.content }],
        details: {
          status: 'served',
          sourceJobId: artifact.sourceJobId,
          attempt: artifact.attempt,
          sha256: artifact.sha256,
          bytes: artifact.size,
        },
      },
      isError: false,
    });
  }
  if (process.env.FAKE_PI_TOOLCALL_END === 'true') {
    send({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        toolCall: { id: 'tool-1', name: 'read', arguments: { path: 'README.md' } },
      },
    });
  }
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
  sendTextDeltas(output.slice(splitAt));
  const settle = () => {
    if (emitLifecycleFixture) send({ type: 'message_end', messageId: 'fixture-message' });
    send({ type: 'agent_end', messages: [], willRetry: false });
    if (emitLifecycleFixture) {
      send({ type: 'turn_end', turnId: 'fixture-turn' });
      send({
        type: process.env.FAKE_PI_UNKNOWN_EVENT_TYPE ?? 'fixture_unknown_event',
        marker: 'fixture-unknown-event',
      });
    }
    send({ type: 'agent_settled' });
  };
  const settleDelay = Number(process.env.FAKE_PI_SETTLE_DELAY_MS ?? 0);
  if (Number.isFinite(settleDelay) && settleDelay > 0) setTimeout(settle, settleDelay);
  else settle();
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    if (line !== '') void handle(JSON.parse(line)).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
  }
});

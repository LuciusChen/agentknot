import process from 'node:process';

const MAX_INPUT_BYTES = 64 * 1024;
const supportedSources = new Set(['startup', 'resume', 'clear', 'compact']);

async function readEvent() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_INPUT_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(chunks.join(''));
  } catch {
    return undefined;
  }
}

const event = await readEvent();
if (event?.hook_event_name === 'SessionStart' && supportedSources.has(event.source)) {
  const additionalContext =
    'AGENTKNOT_CONTROLLER_ENTRY_V1\n' +
    'AgentKnot is independent controller-neutral middleware. Before repository tool use, the controller must decide whether work needs more than one direct action and has objective acceptance criteria; if so, it must load and follow agentknot-delegate. The controller retains intent, planning, decomposition, acceptance, and artifact promotion; AgentKnot owns deterministic admission, routing, scheduling, isolation, lifecycle, and evidence. Keep chat, decisions, artifact integration, commit, push, merge, and deployment upstream. Author the strict assessment before admission; never admit a raw prompt. If the Skill or common client is unavailable, report it and continue upstream without worker, provider, or model fallback.';
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    })}\n`
  );
}

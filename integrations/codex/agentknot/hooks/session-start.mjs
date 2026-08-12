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
    'AgentKnot is available as independent controller-neutral middleware. For each user turn, before repository tool use, decide upstream whether the requested implementation, repair, test, analysis, or documentation work needs more than one direct action and has objective acceptance criteria. When it does, you must load and follow the installed agentknot-delegate Skill before doing that bounded work directly. The controller retains intent, planning, decomposition, acceptance, and artifact promotion; AgentKnot retains deterministic admission, routing, scheduling, isolation, lifecycle, and evidence. Keep informational chat, requirements and product decisions, artifact integration, commits, pushes, merges, and deployment upstream. Never send a raw prompt to AgentKnot before the controller authors its strict assessment. If the Skill or common client is unavailable, report that limitation and continue upstream without substituting another worker, provider, or model.';
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    })}\n`
  );
}

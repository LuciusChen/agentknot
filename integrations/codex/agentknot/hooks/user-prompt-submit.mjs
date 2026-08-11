import process from 'node:process';

const explicitMarker = process.argv[3];
const MAX_INPUT_BYTES = 1024 * 1024;

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

function emitObligation() {
  const additionalContext =
    'AGENTKNOT_CONTROLLER_OBLIGATION_V2\n' +
    'AgentKnot is independent controller-neutral middleware, not a Codex plugin runtime. For nontrivial repository implementation, repair, test, analysis, or documentation work, keep intent, planning, decomposition, acceptance, and artifact promotion upstream; construct one strict controller-authored TaskAssessment, then use the common AgentKnot MCP tools to read policy, admit eligible bounded work, and inspect durable evidence. Do not scan an AgentKnot checkout, start a runtime, select a model locally, or run shell discovery from this hook. If broker status is stopped or unavailable and launchConfigured is true, explicitly try agentknot_broker_start once; if startup or the tools remain unavailable, continue upstream and report that limitation. Never silently switch workers, providers, or models.';
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    })}\n`
  );
}

const event = await readEvent();
if (
  event?.hook_event_name === 'UserPromptSubmit' &&
  typeof event.prompt === 'string' &&
  (explicitMarker === undefined || !event.prompt.includes(explicitMarker))
) {
  emitObligation();
}

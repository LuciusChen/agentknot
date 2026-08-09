import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const source = process.argv[2];
if (source !== 'codex' && source !== 'claude') throw new Error('Expected codex or claude source');

const explicit = source === 'codex' ? '$agentknot-delegate' : '/agentknot:agentknot-delegate';
const MAX_CHILD_OUTPUT_CHARS = 24_000;
const MAX_PREVIEW_CHARS = 32_000;
const MAX_CONTEXT_CHARS = 60_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function truncate(value, maximum) {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n[truncated by controller hook]`;
}

async function input() {
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return JSON.parse(value);
}

function context(additionalContext) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: truncate(additionalContext, MAX_CONTEXT_CHARS),
      },
    })}\n`
  );
}

async function run(args, cwd) {
  return execFileAsync('agentknot', args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER_BYTES,
  });
}

try {
  const event = await input();
  if (event.hook_event_name !== 'UserPromptSubmit' || typeof event.prompt !== 'string') process.exit(0);
  if (event.prompt.includes(explicit)) process.exit(0);

  const cwd = typeof event.cwd === 'string' && event.cwd !== '' ? event.cwd : process.cwd();
  let rootOutput;
  try {
    ({ stdout: rootOutput } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
    }));
  } catch {
    process.exit(0);
  }
  const workspace = rootOutput.trim();
  const configPath =
    process.env.AGENTKNOT_CONFIG === undefined
      ? path.join(workspace, 'agentknot.config.json')
      : path.resolve(cwd, process.env.AGENTKNOT_CONFIG);
  if (process.env.AGENTKNOT_CONFIG === undefined) {
    try {
      await access(configPath);
    } catch {
      process.exit(0);
    }
  }

  const { stdout: policyOutput } = await run(['delegation', '--json', '--config', configPath], workspace);
  const policy = JSON.parse(policyOutput);
  if (policy.mode !== 'auto') process.exit(0);

  const { stdout: handoffOutput } = await run(
    [
      'orchestrate',
      '--source',
      source,
      '--workspace',
      workspace,
      '--delegation',
      'inherit',
      '--handoff-json',
      '--prompt',
      event.prompt,
      '--config',
      configPath,
    ],
    workspace
  );
  const handoff = JSON.parse(handoffOutput);

  if (handoff.plan?.willDispatch !== true) {
    context(
      `AgentKnot automatic entry evaluated this prompt and kept it upstream: ${handoff.plan?.reasoning ?? 'no delegatable subtask'}. Continue normally and do not invoke AgentKnot again for this prompt.`
    );
    process.exit(0);
  }

  const children = Array.isArray(handoff.children) ? handoff.children : [];
  const perChildOutputLimit = Math.max(1, Math.floor(MAX_CHILD_OUTPUT_CHARS / Math.max(1, children.length)));
  const compactHandoff = {
    ...handoff,
    children: children.map((child) => ({
      ...child,
      ...(typeof child.output === 'string'
        ? { output: truncate(child.output, perChildOutputLimit) }
        : {}),
    })),
  };
  const previewTargets = Array.isArray(handoff.artifacts)
    ? handoff.artifacts.flatMap((report) =>
        report?.status === 'verified' && Array.isArray(report.attempts)
          ? report.attempts
              .filter((attempt) => attempt?.valid === true && Number(attempt.size) > 0)
              .map((attempt) => ({ jobId: report.jobId, attempt: attempt.attempt }))
          : []
      )
    : [];
  const perPreviewLimit = Math.max(1, Math.floor(MAX_PREVIEW_CHARS / Math.max(1, previewTargets.length)));
  const previews = [];
  for (const target of previewTargets) {
    try {
      const { stdout } = await run(
        ['artifact-preview', target.jobId, String(target.attempt), '--json', '--config', configPath],
        workspace
      );
      const preview = JSON.parse(stdout);
      previews.push({
        jobId: target.jobId,
        attempt: target.attempt,
        truncated: preview.truncated === true || String(preview.content ?? '').length > perPreviewLimit,
        content: truncate(String(preview.content ?? ''), perPreviewLimit),
      });
    } catch (error) {
      previews.push({
        jobId: target.jobId,
        attempt: target.attempt,
        unavailable: truncate(error instanceof Error ? error.message : String(error), 1_000),
      });
    }
  }

  context(
    `AGENTKNOT_AUTOMATIC_HANDOFF_V1\nAgentKnot already completed the delegated repository work before this controller-model turn. Do not repeat its repository exploration, analysis, implementation, or successful checks. Use the bounded evidence below. For a read-only task, report the result directly and disclose any stated gap. For a patch, review only the supplied integrity-valid preview, decide whether to apply it, and validate the integrated workspace once; never apply, commit, push, merge, or deploy merely because the worker produced it.\n${JSON.stringify({ handoff: compactHandoff, previews })}`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  context(
    `AgentKnot automatic entry was unavailable before dispatch: ${truncate(message, 1_000)}. Continue upstream without silently substituting another worker, provider, or model.`
  );
}

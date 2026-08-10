import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
const MAX_SESSION_RECORD_BYTES = 4 * 1024;
const SESSION_DIRECTORY_MODE = 0o700;
const SESSION_RECORD_MODE = 0o600;
const EXPLICIT_PATH_PATTERN = /(?:^|[\s"'`([{<（【《])((?:~\/|\/)[^\s"'`\])}>）】》,，。；;:：！？!?]+)/gu;

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

function isNotFound(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT';
}

function sessionKey(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '' || Buffer.byteLength(sessionId, 'utf8') > 4_096) {
    return undefined;
  }
  return createHash('sha256').update(source).update('\0').update(sessionId).digest('hex');
}

function sessionDirectory() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && path.isAbsolute(runtime)) {
    return path.join(path.resolve(runtime), 'agentknot', 'controller-sessions');
  }
  const cache = process.env.XDG_CACHE_HOME;
  const cacheHome = cache !== undefined && path.isAbsolute(cache)
    ? path.resolve(cache)
    : path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'agentknot', 'controller-sessions');
}

function sessionRecordPath(sessionId) {
  const key = sessionKey(sessionId);
  return key === undefined ? undefined : path.join(sessionDirectory(), `${key}.json`);
}

async function writeSessionWorkspace(sessionId, workspace) {
  const recordPath = sessionRecordPath(sessionId);
  if (recordPath === undefined) return;
  const directory = path.dirname(recordPath);
  await mkdir(directory, { recursive: true, mode: SESSION_DIRECTORY_MODE });
  await chmod(directory, SESSION_DIRECTORY_MODE);
  const record = `${JSON.stringify({ schemaVersion: 1, source, workspace })}\n`;
  if (Buffer.byteLength(record, 'utf8') > MAX_SESSION_RECORD_BYTES) return;
  const temporaryPath = path.join(directory, `.${path.basename(recordPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, record, { encoding: 'utf8', flag: 'wx', mode: SESSION_RECORD_MODE });
    await rename(temporaryPath, recordPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

async function readSessionWorkspace(sessionId) {
  const recordPath = sessionRecordPath(sessionId);
  if (recordPath === undefined) return undefined;
  let recordStats;
  try {
    recordStats = await lstat(recordPath);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (
    recordStats.isSymbolicLink() ||
    !recordStats.isFile() ||
    (recordStats.mode & 0o7777) !== SESSION_RECORD_MODE ||
    recordStats.size > MAX_SESSION_RECORD_BYTES
  ) {
    return undefined;
  }
  let record;
  try {
    record = JSON.parse(await readFile(recordPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (
    typeof record !== 'object' ||
    record === null ||
    Array.isArray(record) ||
    record.schemaVersion !== 1 ||
    record.source !== source ||
    typeof record.workspace !== 'string' ||
    !path.isAbsolute(record.workspace)
  ) {
    return undefined;
  }
  return record.workspace;
}

async function clearSessionWorkspace(sessionId) {
  const recordPath = sessionRecordPath(sessionId);
  if (recordPath === undefined) return;
  await unlink(recordPath).catch((error) => {
    if (!isNotFound(error)) throw error;
  });
}

async function gitRoot(candidate) {
  let candidateStats;
  try {
    candidateStats = await stat(candidate);
  } catch {
    return undefined;
  }
  const cwd = candidateStats.isDirectory() ? candidate : path.dirname(candidate);
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
    });
    const root = stdout.trim();
    return root === '' ? undefined : path.resolve(root);
  } catch {
    return undefined;
  }
}

function explicitPaths(prompt) {
  const candidates = [];
  for (const match of prompt.matchAll(EXPLICIT_PATH_PATTERN)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const trimmed = raw.replace(/[.,;:!?，。；：！？]+$/u, '');
    const expanded = trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
    if (path.isAbsolute(expanded)) candidates.push(path.resolve(expanded));
    if (candidates.length >= 16) break;
  }
  return candidates;
}

async function resolveWorkspace(event, cwd) {
  const cwdRoot = await gitRoot(cwd);
  if (cwdRoot !== undefined) {
    await writeSessionWorkspace(event.session_id, cwdRoot);
    return cwdRoot;
  }

  const promptRoots = new Set();
  for (const candidate of explicitPaths(event.prompt)) {
    const root = await gitRoot(candidate);
    if (root !== undefined) promptRoots.add(root);
  }
  if (promptRoots.size > 1) return undefined;
  if (promptRoots.size === 1) {
    const [workspace] = promptRoots;
    await writeSessionWorkspace(event.session_id, workspace);
    return workspace;
  }

  const bound = await readSessionWorkspace(event.session_id);
  if (bound === undefined) return undefined;
  const boundRoot = await gitRoot(bound);
  if (boundRoot === bound) return bound;
  await clearSessionWorkspace(event.session_id);
  return undefined;
}

function commandFailureStdout(error) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'stdout' in error &&
    typeof error.stdout === 'string'
  ) {
    return error.stdout;
  }
  throw error;
}

async function discoverServerUrl(cwd) {
  let output;
  try {
    ({ stdout: output } = await run(['client', '--json'], cwd));
  } catch (error) {
    output = commandFailureStdout(error);
  }

  let report;
  try {
    report = JSON.parse(output);
  } catch (error) {
    throw new Error('AgentKnot client returned malformed JSON', { cause: error });
  }
  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    throw new Error('AgentKnot client returned a malformed status report');
  }
  if (report.status === 'unconfigured') return undefined;
  if (report.status === 'available') {
    if (typeof report.url !== 'string' || report.url.trim() === '') {
      throw new Error('AgentKnot client returned an available status without a URL');
    }
    return report.url;
  }
  if (report.status === 'unavailable') {
    const reason = typeof report.error === 'string' && report.error !== '' ? `: ${report.error}` : '';
    throw new Error(`AgentKnot client reported unavailable${reason}`);
  }
  throw new Error('AgentKnot client returned an unknown status');
}

try {
  const event = await input();
  if (event.hook_event_name === 'SessionEnd') {
    await clearSessionWorkspace(event.session_id).catch(() => undefined);
    process.exit(0);
  }
  if (event.hook_event_name !== 'UserPromptSubmit' || typeof event.prompt !== 'string') process.exit(0);
  if (event.prompt.includes(explicit)) process.exit(0);

  const cwd = typeof event.cwd === 'string' && event.cwd !== '' ? event.cwd : process.cwd();
  const workspace = await resolveWorkspace(event, cwd);
  if (workspace === undefined) process.exit(0);
  let serverUrl = process.env.AGENTKNOT_SERVER_URL;
  if (serverUrl !== undefined && serverUrl.trim() === '') {
    throw new Error('AGENTKNOT_SERVER_URL must not be empty');
  }
  if (serverUrl !== undefined && process.env.AGENTKNOT_CONFIG !== undefined) {
    throw new Error('AGENTKNOT_SERVER_URL and AGENTKNOT_CONFIG cannot be used together');
  }
  let configPath;
  if (serverUrl === undefined) {
    if (process.env.AGENTKNOT_CONFIG !== undefined) {
      configPath = path.resolve(cwd, process.env.AGENTKNOT_CONFIG);
    } else {
      serverUrl = await discoverServerUrl(workspace);
      if (serverUrl === undefined) {
        configPath = path.join(workspace, 'agentknot.config.json');
        try {
          await access(configPath);
        } catch {
          process.exit(0);
        }
      }
    }
  }
  const connectionArgs = serverUrl === undefined ? ['--config', configPath] : ['--server', serverUrl];

  const { stdout: policyOutput } = await run(['delegation', '--json', ...connectionArgs], workspace);
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
      ...connectionArgs,
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
        ['artifact-preview', target.jobId, String(target.attempt), '--json', ...connectionArgs],
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
    `AGENTKNOT_AUTOMATIC_HANDOFF_V1\nAgentKnot already completed the delegated repository work before this controller-model turn. Do not repeat its repository exploration, analysis, implementation, or successful checks. Use the bounded evidence below, including optional qualityReview and controller-owned artifactValidation. Both are advisory; a passed artifactValidation covers the exact recorded patch at its recorded base, not the post-application workspace. For a read-only task, report the result directly and disclose any stated gap. For a patch, review only the supplied integrity-valid preview, decide whether to apply it, and validate the integrated workspace once after application; never apply, commit, push, merge, or deploy merely because the worker produced it.\n${JSON.stringify({ handoff: compactHandoff, previews })}`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  context(
    `AgentKnot automatic entry failed to return a usable handoff: ${truncate(message, 1_000)}. Continue upstream without silently substituting another worker, provider, or model.`
  );
}

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const source = process.argv[2];
const explicit = process.argv[3];
if (typeof source !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(source)) {
  throw new Error('Expected a bounded controller source namespace');
}
if (explicit !== undefined && (explicit === '' || Buffer.byteLength(explicit, 'utf8') > 256)) {
  throw new Error('Expected a bounded explicit invocation marker');
}
// Sessions created by the previous packaged adapters retain their two-argument
// hook command when resumed. Keep only their bounded invocation markers here;
// new adapters pass their own marker as the third argument.
const explicitInvocations = explicit === undefined
  ? ['$agentknot-delegate', '/agentknot:agentknot-delegate']
  : [explicit];
const MAX_CHILD_OUTPUT_CHARS = 24_000;
const MAX_PREVIEW_CHARS = 32_000;
const MAX_CONTEXT_CHARS = 60_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_RECORD_BYTES = 4 * 1024;
const SESSION_DIRECTORY_MODE = 0o700;
const SESSION_RECORD_MODE = 0o600;
const EXPLICIT_PATH_PATTERN = /(?:^|[\s"'`([{<（【《])((?:~\/|\/)[^\s"'`\])}>）】》,，。；;:：！？!?]+)/gu;
const TOOL_WORKSPACE_KEYS = new Set(['cwd', 'workdir', 'workspace']);

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

async function writeSessionWorkspace(sessionId, workspace, repositoryIdentity) {
  const recordPath = sessionRecordPath(sessionId);
  if (recordPath === undefined) return;
  const directory = path.dirname(recordPath);
  await mkdir(directory, { recursive: true, mode: SESSION_DIRECTORY_MODE });
  await chmod(directory, SESSION_DIRECTORY_MODE);
  const record = `${JSON.stringify({ schemaVersion: 1, source, workspace, repositoryIdentity })}\n`;
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
    !path.isAbsolute(record.workspace) ||
    (record.repositoryIdentity !== undefined &&
      (typeof record.repositoryIdentity !== 'string' || record.repositoryIdentity === ''))
  ) {
    return undefined;
  }
  return { workspace: record.workspace, repositoryIdentity: record.repositoryIdentity };
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

async function repositoryIdentity(root) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
    });
    const raw = stdout.trim();
    if (raw === '') return undefined;
    const commonDirectory = await realpath(path.isAbsolute(raw) ? raw : path.resolve(root, raw));
    const commonStats = await stat(commonDirectory);
    if (!commonStats.isDirectory()) return undefined;
    return createHash('sha256')
      .update(commonDirectory)
      .update('\0')
      .update(String(commonStats.dev))
      .update('\0')
      .update(String(commonStats.ino))
      .digest('hex');
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

function exactToolPaths(value) {
  const candidates = [];
  let visited = 0;
  const visit = (current, depth) => {
    if (
      depth > 8 ||
      visited >= 128 ||
      candidates.length >= 16 ||
      current === null ||
      typeof current !== 'object'
    ) return;
    visited += 1;
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      if (TOOL_WORKSPACE_KEYS.has(key) && typeof item === 'string') {
        let candidate;
        if (item.startsWith('file://')) {
          try {
            candidate = fileURLToPath(item);
          } catch {
            continue;
          }
        } else if (item.startsWith('~/')) {
          candidate = path.join(os.homedir(), item.slice(2));
        } else if (path.isAbsolute(item)) {
          candidate = item;
        }
        if (candidate !== undefined) candidates.push(path.resolve(candidate));
        if (candidates.length >= 16) return;
      } else {
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
  return candidates;
}

async function captureToolWorkspace(event) {
  const roots = new Set();
  for (const candidate of exactToolPaths(event.tool_input)) {
    const root = await gitRoot(candidate);
    if (root !== undefined) roots.add(root);
  }
  if (roots.size !== 1) return;
  const [workspace] = roots;
  const identity = await repositoryIdentity(workspace);
  if (identity !== undefined) await writeSessionWorkspace(event.session_id, workspace, identity);
}

async function resolveWorkspace(event, cwd) {
  const cwdRoot = await gitRoot(cwd);
  if (cwdRoot !== undefined) {
    const identity = await repositoryIdentity(cwdRoot);
    if (identity !== undefined) await writeSessionWorkspace(event.session_id, cwdRoot, identity);
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
    const identity = await repositoryIdentity(workspace);
    if (identity !== undefined) await writeSessionWorkspace(event.session_id, workspace, identity);
    return workspace;
  }

  const bound = await readSessionWorkspace(event.session_id);
  if (bound === undefined) return undefined;
  const boundRoot = await gitRoot(bound.workspace);
  const identity = boundRoot === undefined ? undefined : await repositoryIdentity(boundRoot);
  if (
    boundRoot === bound.workspace &&
    identity !== undefined &&
    (bound.repositoryIdentity === undefined || bound.repositoryIdentity === identity)
  ) {
    if (bound.repositoryIdentity === undefined) {
      await writeSessionWorkspace(event.session_id, bound.workspace, identity);
    }
    return bound.workspace;
  }
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
    // Keep the verified binding so a resumed controller session can recover its repository.
    // Every later use revalidates the Git root and common-directory identity.
    process.exit(0);
  }
  if (event.hook_event_name === 'PostToolUse') {
    await captureToolWorkspace(event);
    process.exit(0);
  }
  if (event.hook_event_name !== 'UserPromptSubmit' || typeof event.prompt !== 'string') process.exit(0);
  if (explicitInvocations.some((marker) => event.prompt.includes(marker))) process.exit(0);

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

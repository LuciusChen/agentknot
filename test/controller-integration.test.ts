import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const execFileAsync = promisify(execFile);

const integrations = [
  {
    controller: 'codex',
    manifest: 'integrations/codex/agentknot/.codex-plugin/plugin.json',
    marketplace: '.agents/plugins/marketplace.json',
    marketplaceSource: './integrations/codex/agentknot',
    skill: 'integrations/codex/agentknot/skills/agentknot-delegate/SKILL.md',
    agentMetadata: 'integrations/codex/agentknot/skills/agentknot-delegate/agents/openai.yaml',
    hook: 'integrations/codex/agentknot/hooks/hooks.json',
    hookScript: 'integrations/codex/agentknot/hooks/user-prompt-submit.mjs',
    explicitInvocation: '$agentknot-delegate',
  },
  {
    controller: 'claude',
    manifest: 'integrations/claude/agentknot/.claude-plugin/plugin.json',
    marketplace: '.claude-plugin/marketplace.json',
    marketplaceSource: './integrations/claude/agentknot',
    skill: 'integrations/claude/agentknot/skills/agentknot-delegate/SKILL.md',
    agentMetadata: undefined,
    hook: 'integrations/claude/agentknot/hooks/hooks.json',
    hookScript: 'integrations/claude/agentknot/hooks/user-prompt-submit.mjs',
    explicitInvocation: '/agentknot:agentknot-delegate',
  },
] as const;

function parseSkill(source: string): { metadata: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error('skill must contain YAML frontmatter');
  }
  const frontmatter = match[1];
  const metadata = Object.fromEntries(
    frontmatter.split('\n').map((line) => {
      const separator = line.indexOf(':');
      assert.ok(separator > 0, 'frontmatter entries must contain a key and value');
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    })
  );
  return { metadata, body: match[2] };
}

function requireString(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function normalizeControllerDifferences(value: string): string {
  return value
    .replaceAll('$agentknot-delegate', '<explicit-invocation>')
    .replaceAll('/agentknot:agentknot-delegate', '<explicit-invocation>')
    .replace(/--source (?:codex|claude)/g, '--source <controller>')
    .replace(/(?:Codex|Claude) audit source/g, '<controller> audit source');
}

async function runHook(
  hookPath: string,
  controller: string,
  environment: NodeJS.ProcessEnv,
  payload: object,
  explicitInvocation: string | null = integrations.find((integration) => integration.controller === controller)?.explicitInvocation ??
    '/agentknot:delegate'
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [hookPath, controller, ...(explicitInvocation === null ? [] : [explicitInvocation])],
      {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Hook exited ${String(code)}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function writeFakeAgentKnot(directory: string): Promise<string> {
  const executable = path.join(directory, 'agentknot');
  const callsFile = path.join(directory, 'calls.jsonl');
  await writeFile(
    executable,
    `#!${process.execPath}\n` +
      `import { appendFileSync } from 'node:fs';\n` +
      `const args = process.argv.slice(2);\n` +
      `appendFileSync(process.env.FAKE_AGENTKNOT_CALLS, JSON.stringify(args) + '\\n');\n` +
      `if (args[0] === 'client') {\n` +
      `  process.stdout.write(process.env.FAKE_AGENTKNOT_CLIENT ?? '{"status":"unconfigured"}');\n` +
      `  if (process.env.FAKE_AGENTKNOT_CLIENT_EXIT === '1') process.exitCode = 1;\n` +
      `} else if (args[0] === 'delegation') process.stdout.write('{"mode":"auto"}');\n` +
      `else if (args[0] === 'orchestrate') {\n` +
      `  process.stdout.write(process.env.FAKE_AGENTKNOT_HANDOFF);\n` +
      `  if (process.env.FAKE_AGENTKNOT_HANDOFF_EXIT === '1') process.exitCode = 1;\n` +
      `}\n` +
      `else if (args[0] === 'artifact-preview') process.stdout.write(process.env.FAKE_AGENTKNOT_PREVIEW);\n` +
      `else process.exitCode = 1;\n`
  );
  await chmod(executable, 0o755);
  return callsFile;
}

test('Codex and Claude plugins expose the same bounded AgentKnot delegation contract', async () => {
  const packageManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')
  ) as Record<string, unknown>;
  assert.deepEqual(packageManifest.bin, { agentknot: './dist/src/cli.js' });

  const skills: Array<{ description: string; body: string; hook: unknown; hookScript: string }> = [];

  for (const integration of integrations) {
    const marketplace = JSON.parse(
      await readFile(path.join(repositoryRoot, integration.marketplace), 'utf8')
    ) as Record<string, unknown>;
    assert.equal(marketplace.name, 'agentknot');
    assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length === 1);
    const marketplacePlugin = marketplace.plugins[0];
    assert.ok(typeof marketplacePlugin === 'object' && marketplacePlugin !== null);
    const marketplaceSource = (marketplacePlugin as Record<string, unknown>).source;
    assert.equal(
      typeof marketplaceSource === 'string'
        ? marketplaceSource
        : (marketplaceSource as Record<string, unknown>).path,
      integration.marketplaceSource
    );

    const manifest = JSON.parse(
      await readFile(path.join(repositoryRoot, integration.manifest), 'utf8')
    ) as Record<string, unknown>;
    assert.equal(manifest.name, 'agentknot');
    assert.match(String(manifest.version), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    assert.equal(typeof manifest.description, 'string');
    assert.equal('hooks' in manifest, false);
    assert.equal('mcpServers' in manifest, false);
    if (integration.controller === 'codex') assert.equal(manifest.skills, './skills/');
    else assert.equal('skills' in manifest, false, 'Claude uses documented skill auto-discovery');

    const { metadata, body } = parseSkill(
      await readFile(path.join(repositoryRoot, integration.skill), 'utf8')
    );
    assert.equal(metadata.name, 'agentknot-delegate');
    const description = requireString(metadata.description, `${integration.controller} skill description`);
    assert.match(description, /explicit/);
    assert.match(description, /Use whenever a repository task/);
    assert.match(description, /requires more than one direct upstream read or action/);
    assert.match(description, /including one substantive nonparallel task/);
    assert.match(body, new RegExp(integration.explicitInvocation.replace('$', '\\$')));
    assert.match(body, /requires more than one direct upstream read or action/);
    assert.match(body, /including one substantive task with no useful parallel split/);
    assert.match(body, /trivial one-read check upstream/);
    assert.match(body, new RegExp(`--source ${integration.controller}`));
    assert.match(body, /command -v agentknot/);
    assert.match(body, /AGENTKNOT_SERVER_URL/);
    assert.match(body, /shared AgentKnot execution owner/);
    assert.match(body, /do not launch another local runtime/);
    assert.match(body, /In one shell call/);
    assert.match(body, /stop before orchestration/);
    assert.match(body, /installed and available on PATH/);
    assert.match(body, /do not substitute another command, worker, provider, or model/);
    assert.match(body, /agentknot orchestrate/);
    assert.match(body, /--handoff-json/);
    assert.match(body, /--workspace[\s\S]*git rev-parse --show-toplevel/);
    assert.match(body, /compact terminal JSON handoff/);
    assert.match(body, /controller-owned `artifactValidation`/);
    assert.match(body, /not the later integrated workspace/);
    assert.match(body, /do not poll processes, relist full records, or repeat artifact verification/);
    assert.match(body, /Do not independently repeat the delegated repository work/);
    assert.match(body, /artifact-preview/);
    assert.doesNotMatch(body, /agentknot artifacts/);
    assert.doesNotMatch(body, /agentknot artifact-verify/);

    const contract = `${description}\n${body}`.toLowerCase();
    for (const eligible of ['implementation', 'test', 'analysis', 'repair', 'documentation']) {
      assert.match(contract, new RegExp(eligible));
    }
    for (const upstream of ['informational chat', 'product decisions', 'artifact integration', 'commit', 'push', 'merge', 'deployment']) {
      assert.match(contract, new RegExp(upstream));
    }
    assert.match(contract, /never apply a patch automatically/);
    assert.doesNotMatch(body, /git\s+(?:apply|am|commit|push|merge)\b/);

    const hook = JSON.parse(await readFile(path.join(repositoryRoot, integration.hook), 'utf8')) as {
      hooks?: {
        PostToolUse?: Array<{ hooks?: Array<Record<string, unknown>> }>;
        UserPromptSubmit?: Array<{ hooks?: Array<Record<string, unknown>> }>;
        SessionEnd?: Array<{ hooks?: Array<Record<string, unknown>> }>;
      };
    };
    assert.deepEqual(hook.hooks?.PostToolUse, [
      {
        hooks: [
          {
            type: 'command',
            command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.mjs" ${integration.controller} '${integration.explicitInvocation}'`,
            timeout: 3,
          },
        ],
      },
    ]);
    const handlers = hook.hooks?.UserPromptSubmit;
    assert.equal(handlers?.length, 1);
    assert.equal(handlers?.[0]?.hooks?.length, 1);
    assert.deepEqual(handlers?.[0]?.hooks?.[0], {
      type: 'command',
      command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.mjs" ${integration.controller} '${integration.explicitInvocation}'`,
      timeout: 3660,
      statusMessage: 'Running AgentKnot automatic delegation',
      additionalContextLimit: 18000,
    });
    assert.deepEqual(hook.hooks?.SessionEnd, [
      {
        hooks: [
          {
            type: 'command',
            command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.mjs" ${integration.controller} '${integration.explicitInvocation}'`,
            timeout: integration.controller === 'codex' ? 3 : 5,
          },
        ],
      },
    ]);
    const hookScript = await readFile(path.join(repositoryRoot, integration.hookScript), 'utf8');
    assert.match(hookScript, /process\.stdin/);
    assert.match(hookScript, /policy\.mode !== 'auto'/);
    assert.match(hookScript, /AGENTKNOT_AUTOMATIC_HANDOFF_V1/);
    assert.match(hookScript, /artifact-preview/);
    assert.match(hookScript, /AGENTKNOT_SERVER_URL/);
    assert.match(hookScript, /'--server'/);
    assert.match(hookScript, /'inherit'/);
    assert.doesNotMatch(hookScript, /git\s+(?:apply|am|commit|push|merge)\b/);
    if (integration.agentMetadata !== undefined) {
      const agentMetadata = await readFile(path.join(repositoryRoot, integration.agentMetadata), 'utf8');
      assert.match(agentMetadata, /allow_implicit_invocation: false/);
      assert.match(agentMetadata, /display_name: "AgentKnot Delegate"/);
    }
    skills.push({ description, body, hook, hookScript });
  }

  assert.equal(
    normalizeControllerDifferences(skills[0]?.description ?? ''),
    normalizeControllerDifferences(skills[1]?.description ?? '')
  );
  assert.equal(
    normalizeControllerDifferences(skills[0]?.body ?? ''),
    normalizeControllerDifferences(skills[1]?.body ?? '')
  );
  assert.equal(skills[0]?.hookScript, skills[1]?.hookScript);
});

test('repository dogfood roles use replaceable worker pools and read-only reviewer profiles', async () => {
  const config = JSON.parse(
    await readFile(path.join(repositoryRoot, 'agentknot.config.json'), 'utf8')
  ) as {
    workers: Record<
      string,
      { commandArgs?: string[]; environment?: Record<string, string>; unsetEnvironment?: string[] }
    >;
    routes: Record<string, { worker?: string }>;
    routePools: Record<string, { routes: string[] }>;
    delegation: {
      planner: { route: string };
      dispatch: { defaultRoute: string; routeSelection?: { rules: Array<{ route: string }> } };
      qualityReview?: { route?: string };
    };
  };
  assert.equal(config.delegation.planner.route, 'advanced-workers');
  assert.equal(config.delegation.dispatch.defaultRoute, 'advanced-workers');
  assert.equal(config.delegation.dispatch.routeSelection?.rules[0]?.route, 'routine-workers');
  assert.equal(config.delegation.qualityReview?.route, 'review-workers');

  for (const poolName of ['advanced-workers', 'routine-workers', 'review-workers']) {
    const members = config.routePools[poolName]?.routes ?? [];
    assert.ok(members.length >= 2);
    assert.ok(new Set(members.map((route) => config.routes[route]?.worker)).size >= 2);
  }

  assert.deepEqual(config.workers['repository-review']?.commandArgs, [
    '--no-skills',
    '--tools',
    'read,grep,find,ls',
  ]);
  assert.deepEqual(config.workers['opencode-readonly']?.commandArgs, ['--agent', 'plan']);
  const continueAfterDeniedTool = {
    OPENCODE_CONFIG_CONTENT: '{"experimental":{"continue_loop_on_deny":true}}',
  };
  assert.deepEqual(config.workers.opencode?.environment, continueAfterDeniedTool);
  assert.deepEqual(config.workers['opencode-readonly']?.environment, continueAfterDeniedTool);
  assert.deepEqual(config.workers['opencode-readonly']?.unsetEnvironment, ['OPENCODE_API_KEY']);
});

test('controller hook accepts an adapter-provided source namespace without core controller branches', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-neutral-hook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const callsFile = await writeFakeAgentKnot(directory);
  const environment = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ''}`,
    XDG_RUNTIME_DIR: path.join(directory, 'runtime'),
    AGENTKNOT_CONFIG: undefined,
    AGENTKNOT_SERVER_URL: 'http://127.0.0.1:17394',
    FAKE_AGENTKNOT_CALLS: callsFile,
    FAKE_AGENTKNOT_HANDOFF: JSON.stringify({
      plan: { willDispatch: false, reasoning: 'Keep this prompt upstream.' },
      children: [],
      artifacts: [],
    }),
  };
  const source = 'custom-controller';
  const explicitInvocation = '/custom:delegate';

  assert.match(
    await runHook(
      path.join(repositoryRoot, integrations[0].hookScript),
      source,
      environment,
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'custom-session',
        cwd: repositoryRoot,
        prompt: 'Perform one bounded repository task.',
      },
      explicitInvocation
    ),
    /kept it upstream/
  );
  const calls = (await readFile(callsFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  const orchestrate = calls.find((call) => call[0] === 'orchestrate');
  assert.ok(orchestrate);
  assert.equal(orchestrate[orchestrate.indexOf('--source') + 1], source);
});

test('controller hook follows the latest structured tool workspace across repositories', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-tool-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const callsFile = await writeFakeAgentKnot(directory);
  const runtimeDirectory = path.join(directory, 'runtime');
  const firstWorkspace = path.join(directory, 'first');
  const secondWorkspace = path.join(directory, 'second');
  await Promise.all([
    mkdir(runtimeDirectory, { mode: 0o700 }),
    mkdir(firstWorkspace),
    mkdir(secondWorkspace),
  ]);
  await Promise.all([
    execFileAsync('git', ['init', '--quiet'], { cwd: firstWorkspace }),
    execFileAsync('git', ['init', '--quiet'], { cwd: secondWorkspace }),
  ]);
  const environment = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ''}`,
    XDG_RUNTIME_DIR: runtimeDirectory,
    AGENTKNOT_CONFIG: undefined,
    AGENTKNOT_SERVER_URL: 'http://127.0.0.1:17394',
    FAKE_AGENTKNOT_CALLS: callsFile,
    FAKE_AGENTKNOT_HANDOFF: JSON.stringify({
      plan: { willDispatch: false, reasoning: 'Keep this prompt upstream.' },
      children: [],
      artifacts: [],
    }),
  };
  const hookPath = path.join(repositoryRoot, integrations[0].hookScript);
  const source = 'custom-controller';
  const explicitInvocation = '/custom:delegate';
  const sessionId = 'custom-tool-workspace-session';

  assert.equal(
    await runHook(
      hookPath,
      source,
      environment,
      {
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: directory,
        tool_input: { arguments: { workdir: pathToFileURL(firstWorkspace).href } },
      },
      explicitInvocation
    ),
    ''
  );
  assert.match(
    await runHook(
      hookPath,
      source,
      environment,
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: directory,
        prompt: 'Continue in the current repository.',
      },
      explicitInvocation
    ),
    /kept it upstream/
  );

  assert.equal(
    await runHook(
      hookPath,
      source,
      environment,
      {
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: directory,
        tool_input: { workspace: secondWorkspace },
      },
      explicitInvocation
    ),
    ''
  );
  assert.equal(
    await runHook(
      hookPath,
      source,
      environment,
      {
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: directory,
        tool_input: { command: `cd ${firstWorkspace}` },
      },
      explicitInvocation
    ),
    ''
  );
  assert.match(
    await runHook(
      hookPath,
      source,
      environment,
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: directory,
        prompt: 'Continue after switching repositories.',
      },
      explicitInvocation
    ),
    /kept it upstream/
  );

  const calls = (await readFile(callsFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  const orchestrations = calls.filter((call) => call[0] === 'orchestrate');
  assert.equal(orchestrations.length, 2);
  const firstOrchestration = orchestrations[0];
  const secondOrchestration = orchestrations[1];
  assert.ok(firstOrchestration);
  assert.ok(secondOrchestration);
  assert.equal(firstOrchestration[firstOrchestration.indexOf('--workspace') + 1], firstWorkspace);
  assert.equal(secondOrchestration[secondOrchestration.indexOf('--workspace') + 1], secondWorkspace);
});

for (const integration of integrations) {
  test(`${integration.controller} hook binds one explicitly named repository to its controller session`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-session-workspace-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const runtimeDirectory = path.join(directory, 'runtime');
    await mkdir(runtimeDirectory, { mode: 0o700 });
    const sessionHome = path.dirname(repositoryRoot);
    const explicitWorkspace = `~/${path.basename(repositoryRoot)}`;
    const sessionId = `session_${integration.controller}_explicit_workspace`;
    const environment = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      HOME: sessionHome,
      XDG_RUNTIME_DIR: runtimeDirectory,
      AGENTKNOT_CONFIG: undefined,
      AGENTKNOT_SERVER_URL: 'http://127.0.0.1:17394',
      FAKE_AGENTKNOT_CALLS: callsFile,
      FAKE_AGENTKNOT_HANDOFF: JSON.stringify({
        plan: { willDispatch: false, reasoning: 'Keep this prompt upstream.' },
        children: [],
        artifacts: [],
      }),
    };
    const hookPath = path.join(repositoryRoot, integration.hookScript);

    const first = await runHook(hookPath, integration.controller, environment, {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      cwd: directory,
      prompt: `请处理 ${explicitWorkspace} 中的一个明确任务。`,
    });
    assert.match(first, /kept it upstream/);

    const continuation = '然后继续检查同一个项目。';
    const second = await runHook(hookPath, integration.controller, environment, {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      cwd: directory,
      prompt: continuation,
    });
    assert.match(second, /kept it upstream/);

    assert.equal(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'SessionEnd',
        session_id: sessionId,
        cwd: directory,
      }),
      ''
    );
    const resumedPrompt = '恢复后继续检查同一个项目。';
    assert.match(
      await runHook(
        hookPath,
        integration.controller,
        environment,
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: sessionId,
          cwd: directory,
          prompt: resumedPrompt,
        },
        null
      ),
      /kept it upstream/
    );
    assert.equal(
      await runHook(
        hookPath,
        integration.controller,
        environment,
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: sessionId,
          cwd: directory,
          prompt: `${integration.explicitInvocation} continue explicitly.`,
        },
        null
      ),
      ''
    );

    const calls = (await readFile(callsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 6);
    for (const orchestrate of [calls[1], calls[3], calls[5]]) {
      assert.ok(orchestrate);
      assert.equal(orchestrate[0], 'orchestrate');
      assert.equal(orchestrate[orchestrate.indexOf('--workspace') + 1], repositoryRoot);
    }
    assert.equal(calls[3]?.[calls[3].indexOf('--prompt') + 1], continuation);
    assert.equal(calls[5]?.[calls[5].indexOf('--prompt') + 1], resumedPrompt);
  });
}

test('controller hooks reject a resumed binding when the repository at that path was replaced', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-replaced-repository-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'repository');
  await mkdir(repository);
  await execFileAsync('git', ['init', '--quiet'], { cwd: repository });

  for (const integration of integrations) {
    const callsFile = await writeFakeAgentKnot(directory);
    await writeFile(callsFile, '');
    const runtimeDirectory = path.join(directory, `runtime-${integration.controller}`);
    await mkdir(runtimeDirectory, { mode: 0o700 });
    const sessionId = `session_${integration.controller}_replaced_repository`;
    const environment = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      XDG_RUNTIME_DIR: runtimeDirectory,
      AGENTKNOT_CONFIG: undefined,
      AGENTKNOT_SERVER_URL: 'http://127.0.0.1:17394',
      FAKE_AGENTKNOT_CALLS: callsFile,
      FAKE_AGENTKNOT_HANDOFF: JSON.stringify({
        plan: { willDispatch: false, reasoning: 'Keep this prompt upstream.' },
        children: [],
        artifacts: [],
      }),
    };
    const hookPath = path.join(repositoryRoot, integration.hookScript);

    assert.match(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: directory,
        prompt: `Inspect ${repository}.`,
      }),
      /kept it upstream/
    );
    await runHook(hookPath, integration.controller, environment, {
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      cwd: directory,
    });

    await rm(path.join(repository, '.git'), { recursive: true, force: true });
    await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
    assert.equal(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: directory,
        prompt: 'Resume work in the previous repository.',
      }),
      ''
    );
  }
});

test('controller hooks bypass ambiguous explicit repositories from a non-Git cwd', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-ambiguous-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const callsFile = await writeFakeAgentKnot(directory);
  await writeFile(callsFile, '');
  const otherRepository = path.join(directory, 'other-repository');
  await mkdir(otherRepository);
  await execFileAsync('git', ['init', '--quiet'], { cwd: otherRepository });

  for (const integration of integrations) {
    const result = await runHook(
      path.join(repositoryRoot, integration.hookScript),
      integration.controller,
      {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        XDG_RUNTIME_DIR: path.join(directory, 'missing-runtime'),
        AGENTKNOT_CONFIG: undefined,
        AGENTKNOT_SERVER_URL: 'http://127.0.0.1:17394',
        FAKE_AGENTKNOT_CALLS: callsFile,
        FAKE_AGENTKNOT_HANDOFF: '{}',
      },
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: `session_${integration.controller}_ambiguous`,
        cwd: directory,
        prompt: `Compare ${repositoryRoot} with ${otherRepository}.`,
      }
    );
    assert.equal(result, '');
  }

  assert.equal(await readFile(callsFile, 'utf8'), '');
});

test('controller hook runs configured automatic delegation before the model and embeds valid preview evidence', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-hook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const callsFile = await writeFakeAgentKnot(directory);
  const configPath = path.join(directory, 'agentknot.config.json');

  const prompt = 'Audit the bounded controller handoff and report every mismatch.';
  const childOutput = `${'x'.repeat(4_000)}One mismatch found.`;
  const handoff = {
    schemaVersion: 1,
    id: 'orchestration_test',
    status: 'succeeded',
    plan: { decision: 'delegate', willDispatch: true, reasoning: 'Bounded audit.' },
    children: [{ jobId: 'job_test', status: 'succeeded', output: childOutput }],
    qualityReview: { status: 'completed', verdict: 'accept', findings: [] },
    artifactValidation: {
      status: 'completed',
      outcome: 'passed',
      command: { argv: ['npm', 'test'], outcome: 'passed', stdoutTail: '5/5 passed' },
      cleanup: 'cleaned',
    },
    artifacts: [
      { jobId: 'job_test', status: 'verified', valid: true, attempts: [{ attempt: 1, size: 24, valid: true }] },
    ],
    result: { action: 'delegated' },
  };
  const hookPath = path.join(repositoryRoot, integrations[0].hookScript);
  const environment = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ''}`,
    AGENTKNOT_CONFIG: configPath,
    FAKE_AGENTKNOT_CALLS: callsFile,
    FAKE_AGENTKNOT_HANDOFF: JSON.stringify(handoff),
    FAKE_AGENTKNOT_PREVIEW: JSON.stringify({ content: 'diff --git a/a b/a\n+fixed\n', truncated: false }),
  };
  const result = await runHook(hookPath, 'codex', environment, {
    hook_event_name: 'UserPromptSubmit',
    cwd: repositoryRoot,
    prompt,
  });
  const output = JSON.parse(result) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /AGENTKNOT_AUTOMATIC_HANDOFF_V1/);
  assert.match(output.hookSpecificOutput.additionalContext, /One mismatch found/);
  assert.match(output.hookSpecificOutput.additionalContext, /artifactValidation/);
  assert.match(output.hookSpecificOutput.additionalContext, /5\/5 passed/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /truncated by controller hook/);
  assert.match(output.hookSpecificOutput.additionalContext, /diff --git a\/a b\/a/);

  const calls = (await readFile(callsFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls[0], ['delegation', '--json', '--config', configPath]);
  assert.equal(calls[1]?.[0], 'orchestrate');
  assert.equal(calls[1]?.[calls[1].indexOf('--source') + 1], 'codex');
  assert.equal(calls[1]?.[calls[1].indexOf('--delegation') + 1], 'inherit');
  assert.equal(calls[1]?.[calls[1].indexOf('--prompt') + 1], prompt);
  assert.deepEqual(calls[2]?.slice(0, 4), ['artifact-preview', 'job_test', '1', '--json']);

  const explicit = await runHook(hookPath, 'codex', environment, {
    hook_event_name: 'UserPromptSubmit',
    cwd: repositoryRoot,
    prompt: '$agentknot-delegate run this explicitly',
  });
  assert.equal(explicit, '');
  assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 3);
});

for (const integration of integrations) {
  test(`${integration.controller} hook discovers an available server for every handoff call`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-discovered-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const serverUrl = 'http://127.0.0.1:17392';
    const prompt = 'Inspect one discovered bounded component.';
    const handoff = {
      plan: { willDispatch: true, reasoning: 'Dispatch one bounded task.' },
      children: [{ jobId: 'job_discovered', status: 'succeeded', output: 'Completed the task.' }],
      artifacts: [
        {
          jobId: 'job_discovered',
          status: 'verified',
          attempts: [{ attempt: 1, size: 24, valid: true }],
        },
      ],
    };
    const result = await runHook(
      path.join(repositoryRoot, integration.hookScript),
      integration.controller,
      {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        AGENTKNOT_CONFIG: undefined,
        AGENTKNOT_SERVER_URL: undefined,
        FAKE_AGENTKNOT_CALLS: callsFile,
        FAKE_AGENTKNOT_CLIENT: JSON.stringify({ status: 'available', url: serverUrl }),
        FAKE_AGENTKNOT_HANDOFF: JSON.stringify(handoff),
        FAKE_AGENTKNOT_PREVIEW: JSON.stringify({ content: 'diff --git a/discovered b/discovered\n+fixed\n', truncated: false }),
      },
      { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt }
    );
    const output = JSON.parse(result) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(output.hookSpecificOutput.additionalContext, /Completed the task/);
    assert.match(output.hookSpecificOutput.additionalContext, /diff --git a\/discovered b\/discovered/);

    const calls = (await readFile(callsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls, [
      ['client', '--json'],
      ['delegation', '--json', '--server', serverUrl],
      [
        'orchestrate',
        '--source',
        integration.controller,
        '--workspace',
        repositoryRoot,
        '--delegation',
        'inherit',
        '--handoff-json',
        '--prompt',
        prompt,
        '--server',
        serverUrl,
      ],
      ['artifact-preview', 'job_discovered', '1', '--json', '--server', serverUrl],
    ]);
  });
}

for (const integration of integrations) {
  test(`${integration.controller} hook keeps repository config opt-in after unconfigured discovery`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-unconfigured-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const configPath = path.join(repositoryRoot, 'agentknot.config.json');
    const prompt = 'Keep this bounded prompt upstream.';
    const result = await runHook(
      path.join(repositoryRoot, integration.hookScript),
      integration.controller,
      {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        AGENTKNOT_CONFIG: undefined,
        AGENTKNOT_SERVER_URL: undefined,
        FAKE_AGENTKNOT_CALLS: callsFile,
        FAKE_AGENTKNOT_CLIENT: JSON.stringify({ status: 'unconfigured' }),
        FAKE_AGENTKNOT_HANDOFF: JSON.stringify({
          plan: { willDispatch: false, reasoning: 'No configured automatic delegation.' },
          children: [],
          artifacts: [],
        }),
      },
      { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt }
    );
    const output = JSON.parse(result) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.match(output.hookSpecificOutput.additionalContext, /kept it upstream/);

    const calls = (await readFile(callsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls, [
      ['client', '--json'],
      ['delegation', '--json', '--config', configPath],
      [
        'orchestrate',
        '--source',
        integration.controller,
        '--workspace',
        repositoryRoot,
        '--delegation',
        'inherit',
        '--handoff-json',
        '--prompt',
        prompt,
        '--config',
        configPath,
      ],
    ]);
  });
}

for (const integration of integrations) {
  for (const discovery of [
    {
      name: 'unavailable discovery',
      output: JSON.stringify({
        status: 'unavailable',
        url: 'http://127.0.0.1:17393',
        error: 'server is not reachable',
      }),
      exit: '1',
    },
    { name: 'malformed discovery JSON', output: '{', exit: undefined },
    { name: 'malformed available discovery', output: JSON.stringify({ status: 'available' }), exit: undefined },
  ] as const) {
    test(`${integration.controller} hook bounds ${discovery.name} without fallback`, async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-discovery-failure-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const callsFile = await writeFakeAgentKnot(directory);
      const result = await runHook(
        path.join(repositoryRoot, integration.hookScript),
        integration.controller,
        {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          AGENTKNOT_CONFIG: undefined,
          AGENTKNOT_SERVER_URL: undefined,
          FAKE_AGENTKNOT_CALLS: callsFile,
          FAKE_AGENTKNOT_CLIENT: discovery.output,
          FAKE_AGENTKNOT_CLIENT_EXIT: discovery.exit,
          FAKE_AGENTKNOT_PREVIEW: 'FORBIDDEN_PREVIEW',
        },
        {
          hook_event_name: 'UserPromptSubmit',
          cwd: repositoryRoot,
          prompt: 'Do not fall back from local discovery.',
        }
      );
      const output = JSON.parse(result) as { decision: string; reason: string };
      assert.equal(output.decision, 'block');
      assert.match(output.reason, /^AgentKnot automatic entry failed to return a usable handoff:/);
      assert.match(output.reason, /blocked before the controller-model request/);
      assert.doesNotMatch(output.reason, /AGENTKNOT_AUTOMATIC_HANDOFF_V1/);
      assert.doesNotMatch(output.reason, /FORBIDDEN_PREVIEW/);
      assert.ok(output.reason.length <= 60_000);

      const calls = (await readFile(callsFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(calls, [['client', '--json']]);
    });
  }
}

for (const integration of integrations) {
  test(`${integration.controller} hook uses one selected shared server without reading local config`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-server-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const serverUrl = 'http://127.0.0.1:17391';
    const prompt = 'Inspect one bounded component.';
    const result = await runHook(
      path.join(repositoryRoot, integration.hookScript),
      integration.controller,
      {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        AGENTKNOT_CONFIG: undefined,
        AGENTKNOT_SERVER_URL: serverUrl,
        FAKE_AGENTKNOT_CALLS: callsFile,
        FAKE_AGENTKNOT_HANDOFF: JSON.stringify({
          plan: { willDispatch: false, reasoning: 'Keep this bounded prompt upstream.' },
          children: [],
          artifacts: [],
        }),
      },
      { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt }
    );
    const output = JSON.parse(result) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.match(output.hookSpecificOutput.additionalContext, /kept it upstream/);

    const calls = (await readFile(callsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls, [
      ['delegation', '--json', '--server', serverUrl],
      [
        'orchestrate',
        '--source',
        integration.controller,
        '--workspace',
        repositoryRoot,
        '--delegation',
        'inherit',
        '--handoff-json',
        '--prompt',
        prompt,
        '--server',
        serverUrl,
      ],
    ]);
  });
}

for (const integration of integrations) {
  test(`${integration.controller} hook bounds automatic handoff failure without fallback`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-failure-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const configPath = path.join(directory, 'agentknot.config.json');
    const prompt = 'Audit the bounded controller handoff and report every mismatch.';
    const result = await runHook(
      path.join(repositoryRoot, integration.hookScript),
      integration.controller,
      {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        AGENTKNOT_CONFIG: configPath,
        FAKE_AGENTKNOT_CALLS: callsFile,
        FAKE_AGENTKNOT_HANDOFF: '{',
        FAKE_AGENTKNOT_PREVIEW: 'FORBIDDEN_PREVIEW',
      },
      { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt }
    );
    const output = JSON.parse(result) as { decision: string; reason: string };
    const context = output.reason;
    assert.equal(output.decision, 'block');
    assert.equal(context.startsWith('AgentKnot automatic entry failed to return a usable handoff:'), true);
    assert.equal(context.includes('before dispatch'), false);
    assert.match(context, /blocked before the controller-model request/);
    assert.ok(context.length <= 60_000);
    for (const forbidden of [
      'AGENTKNOT_AUTOMATIC_HANDOFF_V1',
      'FORBIDDEN_PREVIEW',
      'children',
      'artifacts',
      'fallback-worker',
      'fallback-provider',
      'fallback-model',
    ]) {
      assert.equal(context.includes(forbidden), false);
    }

    const calls = (await readFile(callsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls, [
      ['delegation', '--json', '--config', configPath],
      [
        'orchestrate',
        '--source',
        integration.controller,
        '--workspace',
        repositoryRoot,
        '--delegation',
        'inherit',
        '--handoff-json',
        '--prompt',
        prompt,
        '--config',
        configPath,
      ],
    ]);
  });
}

for (const integration of integrations) {
  test(`${integration.controller} hook preserves terminal orchestration failure and blocks upstream work`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-terminal-failure-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const configPath = path.join(directory, 'agentknot.config.json');
    const prompt = 'Review the current repository without changing files.';
    const orchestrationId = 'orchestration_dirty_workspace';
    const terminalError = `Workspace repository is not clean: ${repositoryRoot}`;
    const result = await runHook(
      path.join(repositoryRoot, integration.hookScript),
      integration.controller,
      {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        AGENTKNOT_CONFIG: configPath,
        FAKE_AGENTKNOT_CALLS: callsFile,
        FAKE_AGENTKNOT_HANDOFF_EXIT: '1',
        FAKE_AGENTKNOT_HANDOFF: JSON.stringify({
          schemaVersion: 1,
          id: orchestrationId,
          status: 'failed',
          children: [],
          artifacts: [],
          error: { name: 'Error', message: terminalError },
        }),
        FAKE_AGENTKNOT_PREVIEW: 'FORBIDDEN_PREVIEW',
      },
      { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt }
    );
    const output = JSON.parse(result) as { decision: string; reason: string };
    assert.equal(output.decision, 'block');
    assert.match(output.reason, new RegExp(orchestrationId));
    assert.match(output.reason, /ended with status failed/);
    assert.match(output.reason, new RegExp(terminalError.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(output.reason, /blocked before the controller-model request/);
    assert.doesNotMatch(output.reason, /AGENTKNOT_AUTOMATIC_HANDOFF_V1|FORBIDDEN_PREVIEW/);

    const calls = (await readFile(callsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls, [
      ['delegation', '--json', '--config', configPath],
      [
        'orchestrate',
        '--source',
        integration.controller,
        '--workspace',
        repositoryRoot,
        '--delegation',
        'inherit',
        '--handoff-json',
        '--prompt',
        prompt,
        '--config',
        configPath,
      ],
    ]);
  });
}

for (const [removed, survivor] of [
  [integrations[0], integrations[1]],
  [integrations[1], integrations[0]],
] as const) {
  test(
    `temporary ${survivor.controller} install keeps its handoff after removing ${removed.controller}`,
    async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-install-'));
      t.after(() => rm(directory, { recursive: true, force: true }));

      await Promise.all(
        integrations.map((integration) =>
          cp(
            path.join(repositoryRoot, 'integrations', integration.controller),
            path.join(directory, integration.controller),
            { recursive: true }
          )
        )
      );
      const removedPackagePath = path.join(directory, removed.controller);
      await rm(removedPackagePath, { recursive: true, force: true });
      await assert.rejects(
        readFile(
          path.join(removedPackagePath, 'agentknot', 'hooks', 'user-prompt-submit.mjs'),
          'utf8'
        ),
        /ENOENT/
      );

      const survivorPackagePath = path.join(directory, survivor.controller, 'agentknot');
      const hookPath = path.join(survivorPackagePath, 'hooks', 'user-prompt-submit.mjs');
      const manifest = JSON.parse(
        await readFile(
          path.join(
            directory,
            survivor.controller,
            path.relative(path.join('integrations', survivor.controller), survivor.manifest)
          ),
          'utf8'
        )
      ) as Record<string, unknown>;
      const skillSource = await readFile(
        path.join(survivorPackagePath, 'skills', 'agentknot-delegate', 'SKILL.md'),
        'utf8'
      );
      assert.equal(manifest.name, 'agentknot');
      assert.match(skillSource, /agentknot orchestrate/);
      assert.match(skillSource, new RegExp(`--source ${survivor.controller}`));
      assert.equal(hookPath.startsWith(`${removedPackagePath}${path.sep}`), false);

      const callsFile = await writeFakeAgentKnot(directory);
      const configPath = path.join(directory, 'agentknot.config.json');
      const prompt = 'Audit the bounded controller handoff and report every mismatch.';
      const environment = {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        AGENTKNOT_CONFIG: configPath,
        FAKE_AGENTKNOT_CALLS: callsFile,
        FAKE_AGENTKNOT_HANDOFF: JSON.stringify({
          plan: { willDispatch: true },
          children: [],
          artifacts: [],
        }),
      };
      const result = await runHook(hookPath, survivor.controller, environment, {
        hook_event_name: 'UserPromptSubmit',
        cwd: repositoryRoot,
        prompt,
      });
      const output = JSON.parse(result) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      assert.match(output.hookSpecificOutput.additionalContext, /AGENTKNOT_AUTOMATIC_HANDOFF_V1/);

      const calls = (await readFile(callsFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(calls[0], ['delegation', '--json', '--config', configPath]);
      const orchestrate = calls[1];
      assert.ok(orchestrate);
      assert.equal(orchestrate[0], 'orchestrate');
      assert.equal(orchestrate[orchestrate.indexOf('--source') + 1], survivor.controller);
      assert.equal(orchestrate[orchestrate.indexOf('--delegation') + 1], 'inherit');
      assert.equal(orchestrate[orchestrate.indexOf('--prompt') + 1], prompt);
      assert.equal(orchestrate.includes(removedPackagePath), false);
      assert.equal(calls.length, 2);
    }
  );
}

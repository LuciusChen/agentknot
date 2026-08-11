import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const integrations = [
  {
    controller: 'codex',
    manifest: 'integrations/codex/agentknot/.codex-plugin/plugin.json',
    marketplace: '.agents/plugins/marketplace.json',
    marketplaceSource: './integrations/codex/agentknot',
    skill: 'integrations/codex/agentknot/skills/agentknot-delegate/SKILL.md',
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
    hook: 'integrations/claude/agentknot/hooks/hooks.json',
    hookScript: 'integrations/claude/agentknot/hooks/user-prompt-submit.mjs',
    explicitInvocation: '/agentknot:agentknot-delegate',
  },
] as const;

interface ParsedSkill {
  metadata: Record<string, string>;
  body: string;
}

interface FakeCall {
  args: string[];
  cwd: string;
}

function parseSkill(source: string): ParsedSkill {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error('skill must contain YAML frontmatter');
  }
  const metadata = Object.fromEntries(
    match[1].split('\n').map((line) => {
      const separator = line.indexOf(':');
      assert.ok(separator > 0, 'frontmatter entries must contain a key and value');
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    })
  );
  return { metadata, body: match[2] };
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
  explicitInvocation: string | null = integrations.find(
    (integration) => integration.controller === controller
  )?.explicitInvocation ?? '/agentknot:delegate'
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
      `appendFileSync(process.env.FAKE_AGENTKNOT_CALLS, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');\n` +
      `if (args[0] === 'client') {\n` +
      `  process.stdout.write(process.env.FAKE_AGENTKNOT_CLIENT ?? '{"status":"unconfigured"}');\n` +
      `  if (process.env.FAKE_AGENTKNOT_CLIENT_EXIT === '1') process.exitCode = 1;\n` +
      `} else if (args[0] === 'delegation') {\n` +
      `  process.stdout.write(process.env.FAKE_AGENTKNOT_POLICY ?? '{"mode":"auto"}');\n` +
      `  if (process.env.FAKE_AGENTKNOT_POLICY_EXIT === '1') process.exitCode = 1;\n` +
      `} else {\n` +
      `  process.stderr.write('forbidden AgentKnot command: ' + args[0] + '\\n');\n` +
      `  process.exitCode = 42;\n` +
      `}\n`
  );
  await chmod(executable, 0o755);
  await writeFile(callsFile, '');
  return callsFile;
}

async function readCalls(callsFile: string): Promise<FakeCall[]> {
  const source = await readFile(callsFile, 'utf8');
  if (source.trim() === '') return [];
  return source
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FakeCall);
}

function hookEnvironment(directory: string, callsFile: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ''}`,
    XDG_RUNTIME_DIR: path.join(directory, 'runtime'),
    AGENTKNOT_CONFIG: undefined,
    AGENTKNOT_SERVER_URL: 'http://127.0.0.1:17394',
    FAKE_AGENTKNOT_CALLS: callsFile,
    FAKE_AGENTKNOT_POLICY: JSON.stringify({ mode: 'auto' }),
  };
}

function parseHookContext(output: string): string {
  const result = JSON.parse(output) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  assert.equal(result.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.equal(typeof result.hookSpecificOutput?.additionalContext, 'string');
  return result.hookSpecificOutput?.additionalContext ?? '';
}

function assertObligation(output: string): string {
  const context = parseHookContext(output);
  assert.match(context, /^AGENTKNOT_HANDOFF_OBLIGATION_V1\n/);
  assert.match(context, /upstream controller owns intent, planning, and decomposition/);
  assert.match(context, /informational, product, integration, commit, push, merge, and deploy/);
  assert.match(context, /strict schemaVersion 1 TaskAssessment/);
  assert.match(context, /recommendation, complexity, parallelizable, taskKinds, reasoning/);
  assert.match(context, /title, kind, prompt, and acceptanceCriteria/);
  assert.match(context, /normal agentknot-delegate Skill\/CLI/);
  assert.match(context, /only validates, routes, schedules, and verifies/);
  assert.match(context, /Do not choose a route or model locally/);
  return context;
}

function assertNoPromptOrLegacyCalls(calls: FakeCall[], prompt: string): void {
  assert.equal(calls.some((call) => call.args.includes(prompt)), false);
  assert.equal(calls.some((call) => call.args[0] === 'orchestrate'), false);
  assert.equal(calls.some((call) => call.args[0] === 'artifact-preview'), false);
}

test('Codex and Claude packages preserve parity and expose the controller-authored handoff contract', async () => {
  const packageManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')
  ) as Record<string, unknown>;
  assert.deepEqual(packageManifest.bin, { agentknot: './dist/src/cli.js' });

  const skills: Array<{ description: string; body: string }> = [];
  const hooks: string[] = [];
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
    else assert.equal('skills' in manifest, false);

    const { metadata, body } = parseSkill(
      await readFile(path.join(repositoryRoot, integration.skill), 'utf8')
    );
    assert.equal(metadata.name, 'agentknot-delegate');
    const description = metadata.description;
    assert.ok(description !== undefined);
    assert.match(description, /Use whenever a repository task/);
    assert.match(description, /strict TaskAssessment/);
    assert.match(body, new RegExp(integration.explicitInvocation.replace('$', '\\$')));
    assert.match(body, /Construct `TASK`/);
    assert.match(body, /Construct `ASSESSMENT`/);
    for (const field of [
      'schemaVersion',
      'recommendation',
      'complexity',
      'parallelizable',
      'taskKinds',
      'reasoning',
      'subtasks',
      'title',
      'kind',
      'prompt',
      'acceptanceCriteria',
    ]) {
      assert.match(body, new RegExp(`"${field}"`));
    }
    assert.match(body, /--source (?:codex|claude)/);
    assert.match(body, /--workspace[\s\S]*git rev-parse --show-toplevel/);
    assert.match(body, /--delegation force/);
    assert.match(body, /--assessment-json "\$ASSESSMENT"/);
    assert.match(body, /--handoff-json/);
    assert.match(body, /--prompt "\$TASK"/);
    assert.match(body, /compact terminal JSON handoff/);
    assert.match(body, /result\.artifactReview/);
    assert.match(body, /controller-owned `artifactValidation`/);
    assert.match(body, /artifact-preview/);
    assert.match(body, /Never apply a patch automatically/);
    assert.match(body, /informational chat/);
    for (const upstream of ['product decisions', 'artifact integration', 'commit', 'push', 'merge', 'deployment']) {
      assert.match(body, new RegExp(upstream));
    }
    assert.match(body, /agentknot client --json/);
    assert.match(body, /SERVER_URL="\$\(/);
    assert.match(body, /set -- --server "\$SERVER_URL" --progress/);
    assert.match(body, /never infer `agentknot\.config\.json` from the target repository/);
    assert.match(body, /AGENTKNOT_SERVER_URL and AGENTKNOT_CONFIG cannot be used together/);
    assert.doesNotMatch(body, /agentknot artifacts/);
    assert.doesNotMatch(body, /agentknot artifact-verify/);
    skills.push({ description, body });

    const hook = await readFile(path.join(repositoryRoot, integration.hookScript), 'utf8');
    assert.match(hook, /delegation', '--json'/);
    assert.match(hook, /AGENTKNOT_HANDOFF_OBLIGATION_V1/);
    assert.doesNotMatch(hook, /AGENTKNOT_AUTOMATIC_HANDOFF_V1/);
    assert.doesNotMatch(hook, /artifact-preview/);
    assert.doesNotMatch(hook, /--progress/);
    assert.doesNotMatch(hook, /path\.join\(workspace, 'agentknot\.config\.json'\)/);
    assert.doesNotMatch(hook, /forwardStderr/);
    assert.doesNotMatch(hook, /decision: 'block'/);
    assert.doesNotMatch(hook, /\['orchestrate'/);
    hooks.push(hook);

    const hookManifest = JSON.parse(
      await readFile(path.join(repositoryRoot, integration.hook), 'utf8')
    ) as { hooks?: { UserPromptSubmit?: Array<{ hooks?: Array<Record<string, unknown>> }> } };
    assert.equal(hookManifest.hooks?.UserPromptSubmit?.length, 1);
    const promptHook = hookManifest.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
    assert.equal(promptHook?.timeout, 10);
    assert.equal(promptHook?.statusMessage, 'AgentKnot is checking workspace delegation policy');
    assert.doesNotMatch(String(promptHook?.statusMessage), /planning|worker|verif/i);
  }

  assert.equal(
    normalizeControllerDifferences(skills[0]?.description ?? ''),
    normalizeControllerDifferences(skills[1]?.description ?? '')
  );
  assert.equal(
    normalizeControllerDifferences(skills[0]?.body ?? ''),
    normalizeControllerDifferences(skills[1]?.body ?? '')
  );
  assert.equal(hooks[0], hooks[1]);

  const agentMetadata = await readFile(
    path.join(repositoryRoot, 'integrations/codex/agentknot/skills/agentknot-delegate/agents/openai.yaml'),
    'utf8'
  );
  assert.match(agentMetadata, /allow_implicit_invocation: true/);
  assert.doesNotMatch(agentMetadata, /allow_implicit_invocation: false/);
});

for (const integration of integrations) {
  test(`${integration.controller} hook injects one nonblocking obligation without executing a task`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-obligation-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const environment = hookEnvironment(directory, callsFile);
    const prompt = `SECRET_RAW_PROMPT_${integration.controller}: implement the bounded repository task`;
    const output = await runHook(
      path.join(repositoryRoot, integration.hookScript),
      integration.controller,
      environment,
      { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt }
    );
    const context = assertObligation(output);
    assert.doesNotMatch(context, /SECRET_RAW_PROMPT/);
    assert.equal(context.length <= 8_000, true);

    const calls = await readCalls(callsFile);
    assert.deepEqual(calls, [
      { args: ['delegation', '--json', '--server', 'http://127.0.0.1:17394'], cwd: repositoryRoot },
    ]);
    assertNoPromptOrLegacyCalls(calls, prompt);
  });

  test(`${integration.controller} hook bypasses explicit Skill invocation before discovery`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-explicit-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const prompt = `${integration.explicitInvocation} delegate this bounded task`;
    const output = await runHook(
      path.join(repositoryRoot, integration.hookScript),
      integration.controller,
      hookEnvironment(directory, callsFile),
      { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt }
    );
    assert.equal(output, '');
    assert.deepEqual(await readCalls(callsFile), []);
  });

  test(`${integration.controller} hook keeps non-auto policy upstream without a handoff context`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-policy-mode-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const environment = hookEnvironment(directory, callsFile);
    environment.FAKE_AGENTKNOT_POLICY = JSON.stringify({ mode: 'suggest' });
    const output = await runHook(
      path.join(repositoryRoot, integration.hookScript),
      integration.controller,
      environment,
      { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt: 'Keep this upstream.' }
    );
    assert.equal(output, '');
    assert.deepEqual(await readCalls(callsFile), [
      { args: ['delegation', '--json', '--server', 'http://127.0.0.1:17394'], cwd: repositoryRoot },
    ]);
  });
}

for (const integration of integrations) {
  test(`${integration.controller} hook uses an available shared endpoint or explicit local config`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-discovery-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const serverUrl = 'http://127.0.0.1:17392';
    const availableEnvironment = hookEnvironment(directory, callsFile);
    availableEnvironment.AGENTKNOT_SERVER_URL = undefined;
    availableEnvironment.FAKE_AGENTKNOT_CLIENT = JSON.stringify({ status: 'available', url: serverUrl });
    const availableOutput = await runHook(
      path.join(repositoryRoot, integration.hookScript),
      integration.controller,
      availableEnvironment,
      { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt: 'Use the discovered server.' }
    );
    assertObligation(availableOutput);
    assert.deepEqual(await readCalls(callsFile), [
      { args: ['client', '--json'], cwd: repositoryRoot },
      { args: ['delegation', '--json', '--server', serverUrl], cwd: repositoryRoot },
    ]);

    await writeFile(callsFile, '');
    const localEnvironment = hookEnvironment(directory, callsFile);
    localEnvironment.AGENTKNOT_SERVER_URL = undefined;
    localEnvironment.AGENTKNOT_CONFIG = 'agentknot.config.json';
    const output = await runHook(
      path.join(repositoryRoot, integration.hookScript),
      integration.controller,
      localEnvironment,
      { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt: 'Use the explicit local configuration.' }
    );
    assertObligation(output);
    assert.deepEqual(await readCalls(callsFile), [
      {
        args: ['delegation', '--json', '--config', path.join(repositoryRoot, 'agentknot.config.json')],
        cwd: repositoryRoot,
      },
    ]);
  });
}

for (const integration of integrations) {
  test(`${integration.controller} hook never infers configuration from the target repository`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-no-fallback-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const environment = hookEnvironment(directory, callsFile);
    environment.AGENTKNOT_SERVER_URL = undefined;
    environment.FAKE_AGENTKNOT_CLIENT = JSON.stringify({ status: 'unconfigured' });
    const prompt = `PRIVATE_PROMPT_${integration.controller}_unconfigured`;
    const output = await runHook(
      path.join(repositoryRoot, integration.hookScript),
      integration.controller,
      environment,
      { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt }
    );
    const context = parseHookContext(output);
    assert.match(context, /handoff status: unavailable/i);
    assert.match(context, /no shared AgentKnot endpoint is configured/);
    assert.match(context, /Do not block this user prompt/);
    assert.doesNotMatch(context, /PRIVATE_PROMPT/);
    const calls = await readCalls(callsFile);
    assert.deepEqual(calls, [{ args: ['client', '--json'], cwd: repositoryRoot }]);
    assertNoPromptOrLegacyCalls(calls, prompt);
  });
}

for (const integration of integrations) {
  for (const failure of [
    {
      name: 'server and config conflict',
      environment: (environment: NodeJS.ProcessEnv) => {
        environment.AGENTKNOT_CONFIG = 'agentknot.config.json';
      },
      expectedCalls: [],
    },
    {
      name: 'unavailable discovery',
      environment: (environment: NodeJS.ProcessEnv) => {
        environment.AGENTKNOT_SERVER_URL = undefined;
        environment.FAKE_AGENTKNOT_CLIENT = JSON.stringify({
          status: 'unavailable',
          error: 'x'.repeat(50_000),
        });
        environment.FAKE_AGENTKNOT_CLIENT_EXIT = '1';
      },
      expectedCalls: ['client'],
    },
    {
      name: 'malformed discovery',
      environment: (environment: NodeJS.ProcessEnv) => {
        environment.AGENTKNOT_SERVER_URL = undefined;
        environment.FAKE_AGENTKNOT_CLIENT = '{';
      },
      expectedCalls: ['client'],
    },
    {
      name: 'policy lookup failure',
      environment: (environment: NodeJS.ProcessEnv) => {
        environment.FAKE_AGENTKNOT_POLICY_EXIT = '1';
      },
      expectedCalls: ['delegation'],
    },
    {
      name: 'malformed policy',
      environment: (environment: NodeJS.ProcessEnv) => {
        environment.FAKE_AGENTKNOT_POLICY = '{';
      },
      expectedCalls: ['delegation'],
    },
  ] as const) {
    test(`${integration.controller} hook gives bounded unavailable context for ${failure.name}`, async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-unavailable-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const callsFile = await writeFakeAgentKnot(directory);
      const environment = hookEnvironment(directory, callsFile);
      failure.environment(environment);
      const prompt = `PRIVATE_PROMPT_${integration.controller}_${failure.name}`;
      const output = await runHook(
        path.join(repositoryRoot, integration.hookScript),
        integration.controller,
        environment,
        { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt }
      );
      const context = parseHookContext(output);
      assert.match(context, /^AGENTKNOT_HANDOFF_OBLIGATION_V1\n/);
      assert.match(context, /unavailable/);
      assert.match(context, /Do not block this user prompt/);
      assert.doesNotMatch(context, /(?:decision:\s*['"]block|blocked before the controller-model request)/);
      assert.doesNotMatch(context, /PRIVATE_PROMPT/);
      assert.equal(context.length <= 8_000, true);

      const calls = await readCalls(callsFile);
      assert.deepEqual(calls.map((call) => call.args[0]), failure.expectedCalls);
      assertNoPromptOrLegacyCalls(calls, prompt);
    });
  }
}

for (const integration of integrations) {
  test(`${integration.controller} session binding survives resume and ignores transcript-shaped data`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-session-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const runtimeDirectory = path.join(directory, 'runtime');
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    const sessionId = `session_${integration.controller}_resume`;
    const sessionHome = path.dirname(repositoryRoot);
    const explicitWorkspace = `~/${path.basename(repositoryRoot)}`;
    const environment = {
      ...hookEnvironment(directory, callsFile),
      HOME: sessionHome,
      XDG_RUNTIME_DIR: runtimeDirectory,
    };
    const hookPath = path.join(repositoryRoot, integration.hookScript);

    assertObligation(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: directory,
        prompt: `Work in ${explicitWorkspace} on one bounded task.`,
      })
    );
    assertObligation(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: directory,
        prompt: 'Continue the same bounded task.',
      })
    );
    assert.equal(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'SessionEnd',
        session_id: sessionId,
        cwd: directory,
      }),
      ''
    );
    const transcriptDecoy = path.join(directory, 'transcript-decoy');
    await mkdir(transcriptDecoy);
    await runGit(transcriptDecoy, 'init', '--quiet');
    assertObligation(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: directory,
        prompt: 'Resume the same bounded task.',
        transcript: [{ tool_input: { workspace: transcriptDecoy } }],
      }, null)
    );
    assert.equal(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: directory,
        prompt: `${integration.explicitInvocation} run explicitly`,
      }, null),
      ''
    );

    const calls = await readCalls(callsFile);
    assert.equal(calls.length, 3);
    assert.equal(calls.every((call) => call.args[0] === 'delegation'), true);
    assert.equal(calls.every((call) => call.cwd === repositoryRoot), true);
    assertNoPromptOrLegacyCalls(calls, 'Work in');
  });
}

async function runGit(cwd: string, ...args: string[]): Promise<void> {
  const child = spawn('git', args, { cwd, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git exited ${String(code)}`));
    });
  });
}

for (const integration of integrations) {
  test(`${integration.controller} PostToolUse focus follows one exact structured workspace and ignores commands`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-focus-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const firstWorkspace = path.join(directory, 'first');
    const secondWorkspace = path.join(directory, 'second');
    await mkdir(firstWorkspace);
    await mkdir(secondWorkspace);
    await runGit(firstWorkspace, 'init', '--quiet');
    await runGit(secondWorkspace, 'init', '--quiet');
    const environment = hookEnvironment(directory, callsFile);
    const hookPath = path.join(repositoryRoot, integration.hookScript);
    const sessionId = `session_${integration.controller}_focus`;

    assert.equal(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: directory,
        tool_input: { nested: { workdir: pathToFileURL(firstWorkspace).href } },
      }),
      ''
    );
    assertObligation(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: directory,
        prompt: 'Continue in the focused repository.',
      })
    );
    assert.equal(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: directory,
        tool_input: { workspace: secondWorkspace },
      }),
      ''
    );
    assert.equal(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: directory,
        tool_input: { command: `cd ${firstWorkspace}` },
      }),
      ''
    );
    assertObligation(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: directory,
        prompt: 'Continue after switching repositories.',
      })
    );

    const calls = await readCalls(callsFile);
    assert.deepEqual(calls.map((call) => call.cwd), [firstWorkspace, secondWorkspace]);
    assertNoPromptOrLegacyCalls(calls, 'Continue');
  });
}

for (const integration of integrations) {
  test(`${integration.controller} rejects a resumed binding when the repository identity changes`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-replaced-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const callsFile = await writeFakeAgentKnot(directory);
    const repository = path.join(directory, 'repository');
    await mkdir(repository);
    await runGit(repository, 'init', '--quiet');
    const environment = hookEnvironment(directory, callsFile);
    const sessionId = `session_${integration.controller}_replaced`;
    const hookPath = path.join(repositoryRoot, integration.hookScript);

    assertObligation(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: directory,
        prompt: `Inspect ${repository}.`,
      })
    );
    await runHook(hookPath, integration.controller, environment, {
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      cwd: directory,
    });
    await rm(repository, { recursive: true, force: true });
    await mkdir(repository);
    await runGit(repository, 'init', '--quiet');

    assert.equal(
      await runHook(hookPath, integration.controller, environment, {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: directory,
        prompt: 'Resume work in the previous repository.',
      }),
      ''
    );
    const calls = await readCalls(callsFile);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cwd, repository);
  });
}

for (const [removed, survivor] of [
  [integrations[0], integrations[1]],
  [integrations[1], integrations[0]],
] as const) {
  test(`temporary ${survivor.controller} install remains independent after removing ${removed.controller}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-controller-independent-'));
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
    await rm(path.join(directory, removed.controller), { recursive: true, force: true });
    const survivorPackage = path.join(directory, survivor.controller, 'agentknot');
    const survivorHook = path.join(survivorPackage, 'hooks', 'user-prompt-submit.mjs');
    const survivorSkill = await readFile(
      path.join(survivorPackage, 'skills', 'agentknot-delegate', 'SKILL.md'),
      'utf8'
    );
    assert.match(survivorSkill, /--assessment-json "\$ASSESSMENT"/);
    assert.doesNotMatch(survivorSkill, new RegExp(removed.controller));

    const callsFile = await writeFakeAgentKnot(directory);
    const prompt = `Independent ${survivor.controller} bounded task.`;
    const output = await runHook(
      survivorHook,
      survivor.controller,
      hookEnvironment(directory, callsFile),
      { hook_event_name: 'UserPromptSubmit', cwd: repositoryRoot, prompt }
    );
    assertObligation(output);
    const calls = await readCalls(callsFile);
    assert.deepEqual(calls.map((call) => call.args[0]), ['delegation']);
    assertNoPromptOrLegacyCalls(calls, prompt);
  });
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const integrations = [
  {
    controller: 'codex',
    explicitInvocation: '$agentknot-delegate',
    source: 'codex',
    root: 'integrations/codex/agentknot',
    manifest: 'integrations/codex/agentknot/.codex-plugin/plugin.json',
    skill: 'integrations/codex/agentknot/skills/agentknot-delegate/SKILL.md',
  },
  {
    controller: 'claude',
    explicitInvocation: '/agentknot:agentknot-delegate',
    source: 'claude',
    root: 'integrations/claude/agentknot',
    manifest: 'integrations/claude/agentknot/.claude-plugin/plugin.json',
    skill: 'integrations/claude/agentknot/skills/agentknot-delegate/SKILL.md',
  },
] as const;

function parseSkill(source: string): { metadata: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
  assert.ok(match);
  return { metadata: match[1] ?? '', body: match[2] ?? '' };
}

async function runHook(
  hookPath: string,
  controller: string,
  explicitInvocation: string,
  payload: unknown
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [hookPath, controller, explicitInvocation], {
    cwd: repositoryRoot,
    env: { ...process.env, PATH: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return { code: await closed, stdout, stderr };
}

function hookContext(output: string): string {
  const parsed = JSON.parse(output) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  assert.equal(parsed.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.equal(typeof parsed.hookSpecificOutput?.additionalContext, 'string');
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}

test('optional controller packages expose one common MCP client and no runtime ownership', async () => {
  const normalizedSkills: string[] = [];
  const hookSources: string[] = [];
  for (const integration of integrations) {
    const manifest = JSON.parse(
      await readFile(path.join(repositoryRoot, integration.manifest), 'utf8')
    ) as Record<string, unknown>;
    assert.equal(manifest.name, 'agentknot');
    assert.equal(manifest.mcpServers, './.mcp.json');
    assert.equal('hooks' in manifest, false);
    if (integration.controller === 'codex') assert.equal(manifest.skills, './skills/');

    const mcp = JSON.parse(
      await readFile(path.join(repositoryRoot, integration.root, '.mcp.json'), 'utf8')
    ) as { mcpServers: { agentknot: { command: string; args: string[] } } };
    assert.deepEqual(mcp, {
      mcpServers: { agentknot: { command: 'agentknot', args: ['mcp'] } },
    });

    const hooks = JSON.parse(
      await readFile(path.join(repositoryRoot, integration.root, 'hooks/hooks.json'), 'utf8')
    ) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
    assert.deepEqual(Object.keys(hooks.hooks), ['UserPromptSubmit']);
    const hook = hooks.hooks.UserPromptSubmit?.[0]?.hooks[0];
    assert.equal(hook?.timeout, 2);
    assert.equal(hook?.statusMessage, 'Applying AgentKnot delegation guard');
    assert.doesNotMatch(String(hook?.statusMessage), /planning|worker|verif/i);

    const hookSource = await readFile(
      path.join(repositoryRoot, integration.root, 'hooks/user-prompt-submit.mjs'),
      'utf8'
    );
    assert.doesNotMatch(hookSource, /child_process|execFile|spawn|agentknot', \[|client|delegation', '--json/);
    assert.doesNotMatch(hookSource, /session|workspace|git|systemd|launchd/i);
    assert.match(hookSource, /independent controller-neutral middleware/);
    hookSources.push(hookSource);

    const { metadata, body } = parseSkill(
      await readFile(path.join(repositoryRoot, integration.skill), 'utf8')
    );
    assert.match(metadata, /name: agentknot-delegate/);
    assert.match(metadata, new RegExp(integration.explicitInvocation.replace('$', '\\$')));
    assert.match(body, /controller-neutral middleware/);
    assert.match(body, /upstream controller owns intent, planning, decomposition, acceptance/);
    assert.match(body, /agentknot_broker_status/);
    assert.match(body, /agentknot_broker_start/);
    assert.match(body, /agentknot_delegation_policy/);
    assert.match(body, /agentknot_orchestration_start/);
    assert.match(body, /agentknot_orchestration_status/);
    assert.match(body, /agentknot_artifact_preview/);
    assert.match(body, /Never apply, stage, commit, push, merge, or deploy/);
    assert.match(body, new RegExp(`--source ${integration.source}`));
    assert.doesNotMatch(body, /service install|systemd|launchd|Unix socket/i);
    normalizedSkills.push(
      body
        .replaceAll(integration.source, '<controller>')
        .replaceAll(integration.explicitInvocation, '<explicit>')
    );
  }
  assert.equal(hookSources[0], hookSources[1]);
  assert.equal(normalizedSkills[0], normalizedSkills[1]);
});

for (const integration of integrations) {
  test(`${integration.controller} hook is fast, stateless, resume-safe, and never invokes AgentKnot`, async () => {
    const hookPath = path.join(repositoryRoot, integration.root, 'hooks/user-prompt-submit.mjs');
    const first = await runHook(hookPath, integration.controller, integration.explicitInvocation, {
      hook_event_name: 'UserPromptSubmit',
      session_id: `new-${integration.controller}`,
      cwd: '/one/repository',
      prompt: 'Continue the repository implementation.',
    });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stderr, '');
    const firstContext = hookContext(first.stdout);
    assert.match(firstContext, /^AGENTKNOT_CONTROLLER_OBLIGATION_V2\n/);
    assert.match(firstContext, /planning, decomposition, acceptance, and artifact promotion upstream/);
    assert.match(firstContext, /common AgentKnot MCP tools/);
    assert.match(firstContext, /try agentknot_broker_start once/);
    assert.match(firstContext, /Do not scan an AgentKnot checkout, start a runtime/);
    assert.doesNotMatch(firstContext, /Continue the repository implementation/);

    const resumedElsewhere = await runHook(
      hookPath,
      integration.controller,
      integration.explicitInvocation,
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: `new-${integration.controller}`,
        cwd: '/different/repository',
        prompt: 'go on',
      }
    );
    assert.equal(resumedElsewhere.code, 0, resumedElsewhere.stderr);
    assert.equal(hookContext(resumedElsewhere.stdout), firstContext);

    const explicit = await runHook(hookPath, integration.controller, integration.explicitInvocation, {
      hook_event_name: 'UserPromptSubmit',
      prompt: `${integration.explicitInvocation} run the bounded task`,
    });
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(explicit.stdout, '');

    const malformed = await runHook(
      hookPath,
      integration.controller,
      integration.explicitInvocation,
      '{not-json'
    );
    assert.equal(malformed.code, 0, malformed.stderr);
    assert.equal(malformed.stdout, '');

    const unrelated = await runHook(hookPath, integration.controller, integration.explicitInvocation, {
      hook_event_name: 'PostToolUse',
      tool_input: { workspace: '/must/not/be/persisted' },
    });
    assert.equal(unrelated.code, 0, unrelated.stderr);
    assert.equal(unrelated.stdout, '');
  });
}

test('Codex skill remains implicitly invocable', async () => {
  const metadata = await readFile(
    path.join(
      repositoryRoot,
      'integrations/codex/agentknot/skills/agentknot-delegate/agents/openai.yaml'
    ),
    'utf8'
  );
  assert.match(metadata, /allow_implicit_invocation: true/);
});

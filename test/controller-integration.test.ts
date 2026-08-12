import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
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
    hooks: 'integrations/codex/agentknot/hooks/hooks.json',
    sessionStart: 'integrations/codex/agentknot/hooks/session-start.mjs',
  },
  {
    controller: 'claude',
    explicitInvocation: '/agentknot:agentknot-delegate',
    source: 'claude',
    root: 'integrations/claude/agentknot',
    manifest: 'integrations/claude/agentknot/.claude-plugin/plugin.json',
    skill: 'integrations/claude/agentknot/skills/agentknot-delegate/SKILL.md',
    hooks: 'integrations/claude/agentknot/hooks/hooks.json',
    sessionStart: 'integrations/claude/agentknot/hooks/session-start.mjs',
  },
] as const;

function parseSkill(source: string): { metadata: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
  assert.ok(match);
  return { metadata: match[1] ?? '', body: match[2] ?? '' };
}

test('optional controller packages expose one common MCP client without per-prompt hooks', async () => {
  const normalizedSkills: string[] = [];
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

    await access(path.join(repositoryRoot, integration.hooks));

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
  assert.equal(normalizedSkills[0], normalizedSkills[1]);
});

async function runSessionStart(
  script: string,
  input: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('controller packages load one stateless contract on start, resume, clear, and compact', async () => {
  const normalizedHooks: string[] = [];
  const normalizedScripts: string[] = [];
  for (const integration of integrations) {
    const hooksSource = await readFile(path.join(repositoryRoot, integration.hooks), 'utf8');
    const hooks = JSON.parse(hooksSource) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
    };
    assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart']);
    assert.equal(hooks.hooks.SessionStart?.[0]?.matcher, 'startup|resume|clear|compact');
    assert.equal(hooks.hooks.SessionStart?.[0]?.hooks[0]?.type, 'command');
    assert.equal(hooks.hooks.SessionStart?.[0]?.hooks[0]?.timeout, 2);
    assert.equal(hooks.hooks.SessionStart?.[0]?.hooks[0]?.additionalContextLimit, 1200);
    assert.doesNotMatch(hooksSource, /UserPromptSubmit|PostToolUse|SessionEnd/);

    const scriptPath = path.join(repositoryRoot, integration.sessionStart);
    const scriptSource = await readFile(scriptPath, 'utf8');
    assert.doesNotMatch(scriptSource, /node:child_process|node:fs|fetch\(|transcript_path|event\.prompt/);
    for (const source of ['startup', 'resume', 'clear', 'compact']) {
      const result = await runSessionStart(
        scriptPath,
        JSON.stringify({ hook_event_name: 'SessionStart', source, prompt: 'must not be read' })
      );
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.match(output.hookSpecificOutput.additionalContext, /controller-neutral middleware/);
      assert.match(output.hookSpecificOutput.additionalContext, /must load and follow/);
      assert.match(output.hookSpecificOutput.additionalContext, /controller retains intent, planning/);
      assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /must not be read/);
    }
    for (const input of [
      '{',
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', source: 'startup' }),
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'unknown' }),
    ]) {
      const result = await runSessionStart(scriptPath, input);
      assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
    }
    normalizedHooks.push(hooksSource.replaceAll(integration.controller, '<controller>'));
    normalizedScripts.push(scriptSource);
  }
  assert.equal(normalizedHooks[0], normalizedHooks[1]);
  assert.equal(normalizedScripts[0], normalizedScripts[1]);
});

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

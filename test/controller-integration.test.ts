import assert from 'node:assert/strict';
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

    await assert.rejects(
      access(path.join(repositoryRoot, integration.root, 'hooks/hooks.json')),
      /ENOENT/
    );

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

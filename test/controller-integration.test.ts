import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const integrations = [
  {
    controller: 'codex',
    manifest: 'integrations/codex/agentknot/.codex-plugin/plugin.json',
    marketplace: '.agents/plugins/marketplace.json',
    marketplaceSource: './integrations/codex/agentknot',
    skill: 'integrations/codex/agentknot/skills/agentknot-delegate/SKILL.md',
    explicitInvocation: '$agentknot-delegate',
  },
  {
    controller: 'claude',
    manifest: 'integrations/claude/agentknot/.claude-plugin/plugin.json',
    marketplace: '.claude-plugin/marketplace.json',
    marketplaceSource: './integrations/claude/agentknot',
    skill: 'integrations/claude/agentknot/skills/agentknot-delegate/SKILL.md',
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

test('Codex and Claude plugins expose the same bounded AgentKnot delegation contract', async () => {
  const skills: Array<{ description: string; body: string }> = [];

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
    assert.match(String(manifest.version), /^\d+\.\d+\.\d+$/);
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
    assert.match(description, /model-triggered/);
    assert.match(body, new RegExp(integration.explicitInvocation.replace('$', '\\$')));
    assert.match(body, new RegExp(`--source ${integration.controller}`));
    assert.match(body, /agentknot orchestrate/);
    assert.match(body, /--workspace[\s\S]*git rev-parse --show-toplevel/);
    assert.match(body, /terminal JSON record/);
    for (const command of ['agentknot artifacts', 'agentknot artifact-verify', 'agentknot artifact-preview']) {
      assert.ok(body.includes(command));
    }

    const contract = `${description}\n${body}`.toLowerCase();
    for (const eligible of ['implementation', 'test', 'analysis', 'repair', 'documentation']) {
      assert.match(contract, new RegExp(eligible));
    }
    for (const upstream of ['informational chat', 'product decisions', 'artifact integration', 'commit', 'push', 'merge', 'deployment']) {
      assert.match(contract, new RegExp(upstream));
    }
    assert.match(contract, /never apply a patch automatically/);
    assert.doesNotMatch(body, /git\s+(?:apply|am|commit|push|merge)\b/);
    skills.push({ description, body });
  }

  assert.equal(
    normalizeControllerDifferences(skills[0]?.description ?? ''),
    normalizeControllerDifferences(skills[1]?.description ?? '')
  );
  assert.equal(
    normalizeControllerDifferences(skills[0]?.body ?? ''),
    normalizeControllerDifferences(skills[1]?.body ?? '')
  );
});

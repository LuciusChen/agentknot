import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import type { DelegationConfig } from '../src/config.js';
import type { OrchestrationRecord } from '../src/orchestration-types.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

interface CliFixture {
  configPath: string;
  workspace: string;
}

async function createModeOffFixture(): Promise<CliFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-cli-orchestration-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  const configPath = path.join(directory, 'agentknot.config.json');
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        defaultRoute: 'mock',
        storage: { directory: 'jobs', orchestrationDirectory: 'orchestrations' },
        workers: { mock: { adapter: 'mock' } },
        routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
        delegation: { mode: 'off' },
      },
      null,
      2
    )}\n`
  );
  return { configPath, workspace };
}

async function runCli(configPath: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [cliPath, ...args, '--config', configPath], {
    env: { ...process.env, AGENTKNOT_CONFIG: undefined },
  });
}

test('CLI orchestration commands use deterministic mode-off configuration', async () => {
  const fixture = await createModeOffFixture();
  const orchestrate = await runCli(
    fixture.configPath,
    'orchestrate',
    '--prompt',
    'Keep this task upstream.',
    '--workspace',
    fixture.workspace,
    '--source',
    'test',
    '--delegation',
    'force',
    '--json'
  );
  const record = JSON.parse(orchestrate.stdout) as OrchestrationRecord;

  assert.equal(record.status, 'succeeded');
  assert.equal(record.request.prompt, 'Keep this task upstream.');
  assert.equal(record.request.workspace, fixture.workspace);
  assert.equal(record.request.source, 'test');
  assert.equal(record.request.delegation, 'force');
  assert.equal(record.policy.mode, 'off');
  assert.equal(record.plan?.mode, 'off');
  assert.equal(record.plan?.willDispatch, false);
  assert.equal(record.result?.action, 'upstream');
  assert.deepEqual(record.children, []);

  const delegation = await runCli(fixture.configPath, 'delegation', '--json');
  const policy = JSON.parse(delegation.stdout) as DelegationConfig;
  assert.equal(policy.mode, 'off');
  assert.equal(policy.planner.route, 'mock');

  const list = await runCli(fixture.configPath, 'orchestrations', '--json');
  const records = JSON.parse(list.stdout) as OrchestrationRecord[];
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, record.id);
  assert.equal(records[0]?.result?.action, 'upstream');

  const shown = await runCli(fixture.configPath, 'orchestration-show', record.id);
  const shownRecord = JSON.parse(shown.stdout) as OrchestrationRecord;
  assert.deepEqual(shownRecord, record);
});

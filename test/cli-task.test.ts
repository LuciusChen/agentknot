import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { SqliteJobStore } from '../src/store.js';
import type { JobArtifactVerificationReport, JobRecord } from '../src/types.js';
import { SqliteWorkOrderStore } from '../src/work-order-store.js';
import type { WorkOrderRecord } from '../src/work-order.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

interface TaskJsonOutput {
  schemaVersion: 1;
  workOrder: WorkOrderRecord;
  job?: JobRecord;
  artifactVerification?: JobArtifactVerificationReport;
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: directory, encoding: 'utf8' });
  return String(result.stdout);
}

async function runCli(configPath: string, ...args: string[]): Promise<{
  stdout: string;
  stderr: string;
}> {
  const result = await execFileAsync(
    process.execPath,
    [cliPath, ...args, '--config', configPath],
    {
      env: { ...process.env, AGENTKNOT_CONFIG: undefined },
      encoding: 'utf8',
    }
  );
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function assertTruncatedTaskField(
  stdout: string,
  prefix: string,
  index = 0,
  valuePrefix = prefix
): void {
  const line = stdout
    .split('\n')
    .filter((candidate) => candidate.startsWith(prefix))[index];
  if (line === undefined) throw new Error(`Missing task report line with prefix ${prefix}`);
  const value = line.slice(valuePrefix.length);
  assert.match(value, /… \[truncated\]$/u);
  assert.equal(Buffer.byteLength(value, 'utf8'), 240);
}

test('task issues a WorkOrder, binds a durable Job, and reloads its result after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-cli-task-'));
  const workspace = path.join(directory, 'workspace');
  const configPath = path.join(directory, 'agentknot.config.json');
  await mkdir(workspace);
  try {
    await git(workspace, 'init', '-q');
    await git(workspace, 'config', 'user.email', 'agentknot-test@example.invalid');
    await git(workspace, 'config', 'user.name', 'AgentKnot test');
    await writeFile(path.join(workspace, 'README.md'), 'base\n');
    await git(workspace, 'add', '--', '.');
    await git(workspace, 'commit', '-qm', 'base');
    const baseCommit = (await git(workspace, 'rev-parse', 'HEAD')).trim();

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          defaultRoute: 'executor',
          storage: { directory: 'jobs', orchestrationDirectory: 'orchestrations' },
          workspaceIsolation: { mode: 'git-worktree', directory: 'worktrees' },
          workers: {
            mock: { adapter: 'mock', responsePrefix: 'Task fixture completed' },
          },
          routes: {
            executor: { worker: 'mock', provider: 'test', model: 'task-fixture' },
          },
          delegation: { mode: 'off' },
        },
        null,
        2
      )}\n`
    );

    const created = await runCli(
      configPath,
      'task',
      'Create task-result.txt.',
      '--workspace',
      workspace,
      '--acceptance',
      'task-result.txt contains the task fixture.',
      '--constraint',
      'Do not modify the source workspace.',
      '--base-revision',
      baseCommit
    );
    assert.match(created.stdout, /Task started\. Waiting for execution to finish/u);
    assert.match(created.stdout, /Task\n  Objective: Create task-result\.txt\./u);
    assert.match(created.stdout, /Expected outcome:\n    - task-result\.txt contains the task fixture\./u);
    assert.match(created.stdout, /Constraints:\n    - Do not modify the source workspace\./u);
    assert.match(created.stdout, /Status\n  Execution completed successfully\./u);
    assert.match(created.stdout, /Summary\n  Task fixture completed:/u);
    assert.match(created.stdout, /Changes\n  none/u);
    assert.match(created.stdout, /Tests\n  Worker-reported checks: not available/u);
    assert.match(created.stdout, /Artifact integrity: passed/u);
    assert.match(created.stdout, /Next action\n  Review the result/u);
    assert.doesNotMatch(created.stdout, /work_order_|job_/u);
    assert.doesNotMatch(created.stdout, /SHA-256|sha256|Base commit|\/artifacts\//u);
    assert.doesNotMatch(created.stdout, /^\s*\{/mu);

    let workOrderId = '';
    let jobId = '';
    const store = await SqliteWorkOrderStore.open(path.join(directory, 'work-orders'), {
      readOnly: true,
    });
    try {
      const workOrders = await store.list();
      assert.equal(workOrders.length, 1);
      const persisted = workOrders[0];
      assert.ok(persisted);
      assert.ok(persisted.executorJobId);
      workOrderId = persisted.id;
      jobId = persisted.executorJobId;
      assert.equal(persisted.status, 'issued');
      assert.deepEqual(persisted.command.acceptanceCriteria, [
        'task-result.txt contains the task fixture.',
      ]);
      assert.deepEqual(persisted.command.constraints, [
        'Do not modify the source workspace.',
      ]);
      assert.equal(persisted.command.baseRevision, baseCommit);
      assert.deepEqual(
        persisted.events.map((event) => event.type),
        ['work-order.issued', 'work-order.executor-job.bound']
      );
    } finally {
      await store.close();
    }

    const jobStore = await SqliteJobStore.open(path.join(directory, 'jobs'), {
      readOnly: true,
    });
    try {
      const executorJob = await jobStore.get(jobId);
      assert.ok(executorJob);
      assert.equal(
        executorJob.request.prompt,
        [
          'Execute the following AgentKnot WorkOrder command.',
          '',
          'Objective:',
          'Create task-result.txt.',
          '',
          'Acceptance criteria:',
          '- task-result.txt contains the task fixture.',
          '',
          'Constraints:',
          '- Do not modify the source workspace.',
        ].join('\n')
      );
    } finally {
      await jobStore.close();
    }

    const restarted = await runCli(configPath, 'task-show', workOrderId);
    assert.match(restarted.stdout, /Task\n  Objective: Create task-result\.txt\./u);
    assert.match(restarted.stdout, /Status\n  Execution completed successfully\./u);
    assert.match(restarted.stdout, /Changes\n  none/u);
    assert.match(restarted.stdout, /Tests\n  Worker-reported checks: not available/u);
    assert.match(restarted.stdout, /Artifact integrity: passed/u);
    assert.match(restarted.stdout, /Next action\n  Review the result/u);
    assert.doesNotMatch(restarted.stdout, new RegExp(`${workOrderId}|${jobId}`, 'u'));
    assert.doesNotMatch(restarted.stdout, /SHA-256|sha256|Base commit|\/artifacts\//u);

    const restoredJson = JSON.parse(
      (await runCli(configPath, 'task-show', workOrderId, '--json')).stdout
    ) as TaskJsonOutput;
    assert.equal(restoredJson.schemaVersion, 1);
    assert.equal(restoredJson.workOrder.id, workOrderId);
    assert.equal(restoredJson.workOrder.executorJobId, jobId);
    assert.equal(restoredJson.job?.id, jobId);
    assert.equal(restoredJson.artifactVerification?.valid, true);
    assert.match(restoredJson.job?.artifacts?.[0]?.path ?? '', /\/artifacts\//u);
    assert.match(restoredJson.job?.artifacts?.[0]?.sha256 ?? '', /^[0-9a-f]{64}$/u);

    const createdJson = JSON.parse(
      (
        await runCli(
          configPath,
          'task',
          'Report the current state.',
          '--workspace',
          workspace,
          '--acceptance',
          'The current state is reported.',
          '--constraint',
          'Do not change files.',
          '--json'
        )
      ).stdout
    ) as TaskJsonOutput;
    assert.match(createdJson.workOrder.id, /^work_order_[0-9a-f-]{36}$/u);
    assert.equal(createdJson.workOrder.command.objective, 'Report the current state.');
    assert.equal(createdJson.job?.id, createdJson.workOrder.executorJobId);
    assert.equal(createdJson.job?.status, 'succeeded');
    assert.equal(createdJson.artifactVerification?.valid, true);
    assert.equal((await git(workspace, 'rev-parse', 'HEAD')).trim(), baseCommit);
    assert.equal(await git(workspace, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    const longAscii = 'A'.repeat(400);
    const longUnicode = '界'.repeat(200);
    const longTask = await runCli(
      configPath,
      'task',
      longAscii,
      '--workspace',
      workspace,
      '--acceptance',
      longUnicode,
      '--constraint',
      longAscii
    );
    assertTruncatedTaskField(longTask.stdout, '  Objective: ');
    assertTruncatedTaskField(longTask.stdout, '    - ', 0);
    assertTruncatedTaskField(longTask.stdout, '    - ', 1);
    assertTruncatedTaskField(longTask.stdout, '  Task fixture completed: ', 0, '  ');

    const machine = JSON.parse(
      (
        await runCli(
          configPath,
          'task',
          longAscii,
          '--workspace',
          workspace,
          '--acceptance',
          longUnicode,
          '--constraint',
          longAscii,
          '--json'
        )
      ).stdout
    ) as TaskJsonOutput;
    const expectedPrompt = [
      'Execute the following AgentKnot WorkOrder command.',
      '',
      'Objective:',
      longAscii,
      '',
      'Acceptance criteria:',
      `- ${longUnicode}`,
      '',
      'Constraints:',
      `- ${longAscii}`,
    ].join('\n');
    assert.equal(machine.workOrder.command.objective, longAscii);
    assert.deepEqual(machine.workOrder.command.acceptanceCriteria, [longUnicode]);
    assert.deepEqual(machine.workOrder.command.constraints, [longAscii]);
    assert.equal(machine.job?.request.prompt, expectedPrompt);
    assert.equal(machine.job?.result?.output, `Task fixture completed: ${expectedPrompt}`);
    assert.doesNotMatch(JSON.stringify(machine), /… \[truncated\]/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

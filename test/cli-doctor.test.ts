import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const probeFixture = path.resolve('test/fixtures/fake-pi-diagnostics.mjs');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(configPath: string, ...args: string[]): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args, '--config', configPath], {
      env: { ...process.env, AGENTKNOT_CONFIG: undefined },
    });
    return { code: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error: unknown) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
    };
  }
}

async function createFixture(
  worker: 'mock' | 'pi',
  environment?: Record<string, string>
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentknot-cli-doctor-'));
  const configPath = path.join(directory, 'agentknot.config.json');
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        defaultRoute: 'secondary',
        storage: { directory: 'jobs', orchestrationDirectory: 'orchestrations' },
        workers:
          worker === 'mock'
            ? { mock: { adapter: 'mock' } }
            : {
                pi: {
                  adapter: 'pi-rpc',
                  command: process.execPath,
                  commandArgs: [probeFixture],
                  noSession: true,
                  ...(environment === undefined ? {} : { environment }),
                },
              },
        routes: {
          luna: {
            worker: worker === 'mock' ? 'mock' : 'pi',
            provider: 'opencode-go',
            model: 'gpt-5.6-luna',
            thinkingLevel: 'max',
            requiredEnv: [],
          },
          secondary: {
            worker: worker === 'mock' ? 'mock' : 'pi',
            provider: 'secondary-provider',
            model: 'secondary-model',
            thinkingLevel: 'medium',
            requiredEnv: [],
          },
        },
      },
      null,
      2
    )}\n`
  );
  return configPath;
}

test('CLI doctor keeps configuration-only checks explicit and successful', async () => {
  const configPath = await createFixture('mock');

  const result = await runCli(configPath, 'doctor');
  assert.equal(result.code, 0);
  const diagnostic = JSON.parse(result.stdout) as {
    ok: boolean;
    route: string;
    message: string;
    liveInference: { checked: boolean; status: string };
  };
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.route, 'secondary');
  assert.match(diagnostic.message, /live inference was not checked/i);
  assert.deepEqual(diagnostic.liveInference, { checked: false, status: 'not-checked' });
});

test('CLI doctor --live probes the explicitly selected Luna route and exits successfully', async () => {
  const configPath = await createFixture('pi');

  const result = await runCli(configPath, 'doctor', '--route', 'luna', '--live');
  assert.equal(result.code, 0, result.stderr);
  const diagnostic = JSON.parse(result.stdout) as {
    ok: boolean;
    route: string;
    liveInference: { checked: boolean; status: string };
    message: string;
  };
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.route, 'luna');
  assert.deepEqual(diagnostic.liveInference, { checked: true, status: 'succeeded' });
  assert.match(diagnostic.message, /opencode-go\/gpt-5\.6-luna/);
  assert.match(diagnostic.message, /thinking level max/);
});

test('CLI doctor --live remains route-neutral and honors the configured default route', async () => {
  const configPath = await createFixture('pi');

  const result = await runCli(configPath, 'doctor', '--live');
  assert.equal(result.code, 0, result.stderr);
  const diagnostic = JSON.parse(result.stdout) as {
    ok: boolean;
    route: string;
    message: string;
    liveInference: { checked: boolean; status: string };
  };
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.route, 'secondary');
  assert.match(diagnostic.message, /secondary-provider\/secondary-model/);
  assert.match(diagnostic.message, /thinking level medium/);
  assert.deepEqual(diagnostic.liveInference, { checked: true, status: 'succeeded' });
});

test('CLI doctor --live returns the provider error and a nonzero exit', async () => {
  const configPath = await createFixture('pi', { FAKE_PI_ERROR: 'Luna provider returned 403' });

  const result = await runCli(configPath, 'doctor', '--route', 'luna', '--live');
  assert.equal(result.code, 1);
  const diagnostic = JSON.parse(result.stdout) as {
    ok: boolean;
    message: string;
    liveInference: { checked: boolean; status: string };
  };
  assert.equal(diagnostic.ok, false);
  assert.match(diagnostic.message, /Luna provider returned 403/);
  assert.deepEqual(diagnostic.liveInference, { checked: true, status: 'failed' });
});

test('CLI doctor --live reports unsupported adapters honestly', async () => {
  const configPath = await createFixture('mock');

  const unsupported = await runCli(configPath, 'doctor', '--route', 'luna', '--live');
  assert.equal(unsupported.code, 1);
  const diagnostic = JSON.parse(unsupported.stdout) as {
    ok: boolean;
    message: string;
    liveInference: { checked: boolean; status: string };
  };
  assert.equal(diagnostic.ok, false);
  assert.match(diagnostic.message, /unsupported/i);
  assert.deepEqual(diagnostic.liveInference, { checked: false, status: 'unsupported' });
});

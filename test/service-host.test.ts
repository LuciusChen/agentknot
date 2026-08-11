import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { dispatchServiceCommand } from '../src/service-cli.js';
import {
  LAUNCHD_LABEL,
  SERVICE_OWNERSHIP_MARKER,
  ServiceDefinitionError,
  ServiceHost,
  ServiceManagerCommandError,
  UnsupportedServicePlatformError,
  renderLaunchAgent,
  renderSystemdUnit,
  type ServiceCommandExecutor,
  type ServiceCommandResult,
  type ServiceDefinition,
  type ServiceHostContext,
} from '../src/service-host.js';

interface CommandCall {
  readonly command: string;
  readonly args: string[];
}

class FakeServiceManager {
  readonly calls: CommandCall[] = [];
  systemdActive = false;
  launchdActive = false;

  readonly execute: ServiceCommandExecutor = async (command, args) => {
    this.calls.push({ command, args: [...args] });
    if (command === 'systemctl') return this.systemd(args);
    return this.launchd(args);
  };

  private systemd(args: readonly string[]): ServiceCommandResult {
    const operation = args[1];
    if (operation === 'is-active') {
      return this.systemdActive ? passed('active\n') : failed(3, 'inactive\n');
    }
    if (operation === 'restart' || operation === 'start') this.systemdActive = true;
    if (operation === 'stop' || operation === 'disable') this.systemdActive = false;
    return passed();
  }

  private launchd(args: readonly string[]): ServiceCommandResult {
    const operation = args[0];
    if (operation === 'print') {
      return this.launchdActive
        ? passed('state = running\n')
        : failed(113, 'Could not find service\n');
    }
    if (operation === 'bootstrap') this.launchdActive = true;
    if (operation === 'bootout') this.launchdActive = false;
    return passed();
  }
}

function passed(stdout = ''): ServiceCommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function failed(exitCode: number, stderr: string): ServiceCommandResult {
  return { exitCode, stdout: '', stderr };
}

function context(
  platform: NodeJS.Platform,
  homeDirectory: string,
  environment: ServiceHostContext['environment'] = {}
): ServiceHostContext {
  return { platform, homeDirectory, environment, uid: 501 };
}

function definition(root: string): ServiceDefinition {
  return {
    nodeExecutable: path.join(root, 'Node Runtime', 'node'),
    cliEntryPath: path.join(root, 'Agent Knot', 'cli.js'),
    configPath: path.join(root, 'config & $ % <x> "quoted".json'),
    executionPath: `${path.join(root, 'user $ % bin')}${path.delimiter}/usr/bin`,
    host: '127.0.0.1',
    port: 17_391,
  };
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'agentknot-service-host-'));
}

test('Linux service installs active under XDG and preserves lifecycle command order', async () => {
  const root = await temporaryRoot();
  const manager = new FakeServiceManager();
  const configHome = path.join(root, 'xdg config');
  const host = new ServiceHost(
    context('linux', path.join(root, 'home'), { XDG_CONFIG_HOME: configHome }),
    manager.execute
  );
  try {
    const paths = await host.install(definition(root));
    assert.equal(paths.definitionPath, path.join(configHome, 'systemd', 'user', 'agentknot.service'));
    assert.equal((await lstat(paths.definitionPath)).mode & 0o7777, 0o600);
    assert.equal((await host.status()).state, 'running');
    assert.deepEqual(manager.calls.slice(0, 4).map((call) => call.args), [
      ['--user', 'daemon-reload'],
      ['--user', 'enable', 'agentknot.service'],
      ['--user', 'restart', 'agentknot.service'],
      ['--user', 'is-active', 'agentknot.service'],
    ]);

    await host.stop();
    assert.equal((await host.status()).state, 'stopped');
    await host.start();
    await host.restart();
    await host.uninstall();
    assert.equal(manager.systemdActive, false);
    await assert.rejects(lstat(paths.definitionPath), { code: 'ENOENT' });
    assert.deepEqual(manager.calls.slice(-2).map((call) => call.args), [
      ['--user', 'disable', '--now', 'agentknot.service'],
      ['--user', 'daemon-reload'],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native manager failures remain visible instead of being reported as stopped', async () => {
  const root = await temporaryRoot();
  const manager = new FakeServiceManager();
  const serviceContext = context('linux', path.join(root, 'home'));
  const host = new ServiceHost(serviceContext, manager.execute);
  try {
    await host.install(definition(root));
    const denied = new ServiceHost(serviceContext, async () => failed(1, 'permission denied\n'));
    await assert.rejects(denied.status(), (error: unknown) => {
      assert.ok(error instanceof ServiceManagerCommandError);
      assert.equal(error.result.exitCode, 1);
      assert.match(error.message, /permission denied/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS service bootstraps on install and bootout makes KeepAlive stop real', async () => {
  const root = await temporaryRoot();
  const manager = new FakeServiceManager();
  const home = path.join(root, 'home');
  const host = new ServiceHost(context('darwin', home), manager.execute);
  try {
    const paths = await host.install(definition(root));
    assert.equal(
      paths.definitionPath,
      path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    );
    assert.equal(manager.launchdActive, true);
    await host.stop();
    assert.equal(manager.launchdActive, false);
    assert.deepEqual(manager.calls.slice(-2).map((call) => call.args), [
      ['print', `gui/501/${LAUNCHD_LABEL}`],
      ['bootout', `gui/501/${LAUNCHD_LABEL}`],
    ]);

    await host.start();
    await host.restart();
    assert.equal(manager.launchdActive, true);
    await host.uninstall();
    assert.equal(manager.launchdActive, false);
    await assert.rejects(lstat(paths.definitionPath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native definitions preserve separate argv and escape manager syntax', () => {
  const value = definition('/tmp/root');
  const unit = renderSystemdUnit(value);
  assert.match(unit, new RegExp(`# ${SERVICE_OWNERSHIP_MARKER}`));
  assert.match(unit, /"\/tmp\/root\/Node Runtime\/node"/u);
  assert.match(unit, /config & \$\$ %% <x> \\"quoted\\"/u);
  assert.match(unit, /Environment="PATH=\/tmp\/root\/user \$ %% bin:\/usr\/bin"/u);
  assert.match(unit, /"serve" "--config"/u);

  const plist = renderLaunchAgent(value);
  assert.match(plist, new RegExp(`<!-- ${SERVICE_OWNERSHIP_MARKER} -->`));
  assert.match(plist, /config &amp; \$ % &lt;x&gt; &quot;quoted&quot;/u);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/tmp\/root\/user \$ % bin:\/usr\/bin<\/string>/u);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/u);
  assert.match(plist, /<string>serve<\/string>\s*<string>--config<\/string>/u);
});

test('owned-file checks reject unowned, insecure, and symlink definitions without manager calls', async () => {
  const root = await temporaryRoot();
  const manager = new FakeServiceManager();
  const host = new ServiceHost(context('linux', path.join(root, 'home')), manager.execute);
  const paths = host.paths;
  try {
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.definitionPath, 'user-owned definition\n', { mode: 0o600 });
    await assert.rejects(host.install(definition(root)), /Refusing to modify unowned/);
    assert.equal(await readFile(paths.definitionPath, 'utf8'), 'user-owned definition\n');

    await chmod(paths.definitionPath, 0o644);
    await assert.rejects(host.uninstall(), /mode-0600/);
    await unlink(paths.definitionPath);
    const target = path.join(root, 'target');
    await writeFile(target, `# ${SERVICE_OWNERSHIP_MARKER}\n`, { mode: 0o600 });
    await symlink(target, paths.definitionPath);
    await assert.rejects(host.status(), /not a symlink/);
    assert.equal(manager.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('service CLI validates config only for install and unsupported platforms fail explicitly', async () => {
  const root = await temporaryRoot();
  const configPath = path.join(root, 'agentknot.config.json');
  const manager = new FakeServiceManager();
  const host = new ServiceHost(context('linux', path.join(root, 'home')), manager.execute);
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        defaultRoute: 'mock',
        storage: { directory: 'jobs' },
        workers: { mock: { adapter: 'mock' } },
        routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
      })
    );
    const installed = await dispatchServiceCommand(['install', '--port', '17392'], {
      configPath,
      serviceHost: host,
    });
    assert.equal(installed.operation, 'install');
    const status = await dispatchServiceCommand(['status'], {
      configPath: path.join(root, 'missing.json'),
      serviceHost: host,
    });
    assert.equal(status.operation, 'status');
    await assert.rejects(
      dispatchServiceCommand(['install'], {
        configPath: path.join(root, 'missing.json'),
        serviceHost: host,
      }),
      /ENOENT/
    );
    assert.throws(
      () => new ServiceHost(context('win32', root), manager.execute),
      UnsupportedServicePlatformError
    );
    assert.throws(() => new ServiceHost(context('linux', 'relative'), manager.execute), ServiceDefinitionError);
    assert.throws(
      () => renderSystemdUnit({ ...definition(root), executionPath: 'relative:/usr/bin' }),
      /PATH entries must be absolute/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

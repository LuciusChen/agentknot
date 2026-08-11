import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BrokerProfileValidationError,
  readBrokerLaunchProfile,
  resolveBrokerLaunchProfilePath,
  writeBrokerLaunchProfile,
} from '../src/broker-profile.js';

test('broker launch profiles use platform application-config paths without shell state', () => {
  assert.equal(
    resolveBrokerLaunchProfilePath({
      environment: { XDG_CONFIG_HOME: '/config', HOME: '/home/test' },
      platform: 'linux',
    }),
    '/config/agentknot/broker-launch.json'
  );
  assert.equal(
    resolveBrokerLaunchProfilePath({ environment: { HOME: '/home/test' }, platform: 'darwin' }),
    '/home/test/Library/Application Support/AgentKnot/broker-launch.json'
  );
  assert.equal(
    resolveBrokerLaunchProfilePath({
      environment: { HOME: '/home/test', APPDATA: '/appdata' },
      platform: 'win32',
    }),
    '/appdata/AgentKnot/broker-launch.json'
  );
});

test('broker launch profiles round-trip one strict mode-0600 config selection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentknot-broker-profile-'));
  const environment = { HOME: root, USERPROFILE: root };
  const configPath = path.join(root, 'agentknot.config.json');
  try {
    const written = await writeBrokerLaunchProfile(
      { configPath, port: 7391 },
      { environment, platform: 'linux' }
    );
    assert.deepEqual(await readBrokerLaunchProfile({ environment, platform: 'linux' }), written);
    const profilePath = resolveBrokerLaunchProfilePath({ environment, platform: 'linux' });
    assert.equal((await lstat(profilePath)).mode & 0o7777, 0o600);

    await writeFile(profilePath, '{"schemaVersion":1,"configPath":"relative","port":7391}\n');
    await chmod(profilePath, 0o600);
    await assert.rejects(
      readBrokerLaunchProfile({ environment, platform: 'linux' }),
      BrokerProfileValidationError
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

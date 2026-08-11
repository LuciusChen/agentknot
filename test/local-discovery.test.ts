import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  createLocalDiscoveryRegistration,
  LocalDiscoveryValidationError,
  MAX_LOCAL_DISCOVERY_RECORD_BYTES,
  readLocalDiscovery,
  resolveLocalDiscoveryPaths,
  type LocalDiscoveryEnvironment,
  type LocalDiscoveryRecord,
} from '../src/local-discovery.js';

interface Fixture {
  root: string;
  runtime: string;
  home: string;
  environment: LocalDiscoveryEnvironment;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentknot-local-discovery-'));
  const runtime = path.join(root, 'runtime');
  const home = path.join(root, 'home');
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  await chmod(runtime, 0o700);
  await chmod(home, 0o700);
  return {
    root,
    runtime,
    home,
    environment: { XDG_RUNTIME_DIR: runtime, HOME: home, USERPROFILE: home },
  };
}

async function removeFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

function validRecord(overrides: Partial<LocalDiscoveryRecord> = {}): LocalDiscoveryRecord {
  return {
    schemaVersion: 1,
    url: 'http://127.0.0.1:7391',
    instanceId: randomUUID(),
    startedAt: '2020-01-02T03:04:05.000Z',
    ...overrides,
  };
}

async function prepareRecordDirectory(fixture: Fixture): Promise<string> {
  const paths = await resolveLocalDiscoveryPaths({ environment: fixture.environment });
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  return paths.recordPath;
}

async function writeRecord(recordPath: string, record: unknown, mode = 0o600): Promise<void> {
  await writeFile(recordPath, typeof record === 'string' ? record : `${JSON.stringify(record)}\n`, {
    mode,
  });
  await chmod(recordPath, mode);
}

test('local discovery chooses a valid XDG runtime path and falls back for invalid paths', async () => {
  const fixture = await createFixture();
  try {
    const runtimePaths = await resolveLocalDiscoveryPaths({ environment: fixture.environment });
    assert.equal(runtimePaths.directory, path.join(fixture.runtime, 'agentknot'));
    assert.equal(runtimePaths.recordPath, path.join(runtimePaths.directory, 'server.json'));
    assert.equal(path.isAbsolute(runtimePaths.directory), true);

    const relativeRuntime = await resolveLocalDiscoveryPaths({
      environment: { XDG_RUNTIME_DIR: 'relative-runtime', HOME: fixture.home },
    });
    assert.equal(relativeRuntime.directory, path.join(fixture.home, '.cache', 'agentknot'));

    const missingRuntime = await resolveLocalDiscoveryPaths({
      environment: {
        XDG_RUNTIME_DIR: path.join(fixture.root, 'missing-runtime'),
        HOME: fixture.home,
      },
    });
    assert.equal(missingRuntime.directory, path.join(fixture.home, '.cache', 'agentknot'));

    const configuredCache = await resolveLocalDiscoveryPaths({
      environment: {
        XDG_RUNTIME_DIR: path.join(fixture.root, 'missing-runtime'),
        XDG_CACHE_HOME: path.join(fixture.root, 'cache'),
        HOME: fixture.home,
      },
    });
    assert.equal(configuredCache.directory, path.join(fixture.root, 'cache', 'agentknot'));

    const insecureRuntime = path.join(fixture.root, 'insecure-runtime');
    await mkdir(insecureRuntime, { mode: 0o755 });
    await chmod(insecureRuntime, 0o755);
    const insecurePaths = await resolveLocalDiscoveryPaths({
      environment: { XDG_RUNTIME_DIR: insecureRuntime, HOME: fixture.home },
    });
    assert.equal(insecurePaths.directory, path.join(fixture.home, '.cache', 'agentknot'));
  } finally {
    await removeFixture(fixture);
  }
});

test('registration holds one owner, publishes only on request, and atomically writes secure records', async () => {
  const fixture = await createFixture();
  const registration = await createLocalDiscoveryRegistration({
    environment: fixture.environment,
    now: () => new Date('2020-01-02T03:04:05.000Z'),
  });
  try {
    const directoryStats = await lstat(registration.paths.directory);
    assert.equal(directoryStats.isDirectory(), true);
    assert.equal(directoryStats.mode & 0o7777, 0o700);
    assert.equal(await readLocalDiscovery({ environment: fixture.environment }), undefined);

    await assert.rejects(
      registration.publish(0),
      /must be a nonzero integer from 1 through 65535/
    );

    const record = await registration.publish(7391);
    assert.equal(record.schemaVersion, 1);
    assert.match(record.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(record.startedAt, '2020-01-02T03:04:05.000Z');
    assert.equal(record.url, 'http://127.0.0.1:7391');

    const recordStats = await lstat(registration.paths.recordPath);
    assert.equal(recordStats.isFile(), true);
    assert.equal(recordStats.isSymbolicLink(), false);
    assert.equal(recordStats.mode & 0o7777, 0o600);
    const bytes = await readFile(registration.paths.recordPath);
    assert.ok(bytes.byteLength <= MAX_LOCAL_DISCOVERY_RECORD_BYTES);
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), record);
    assert.deepEqual(await registration.read(), record);
    assert.deepEqual(await readLocalDiscovery({ environment: fixture.environment }), record);
    assert.deepEqual(
      (await readdir(registration.paths.directory)).filter((name) => name.endsWith('.json')),
      ['server.json']
    );

    const replacement = await registration.publish(7392);
    assert.equal(replacement.instanceId, record.instanceId);
    assert.equal(replacement.url, 'http://127.0.0.1:7392');
    assert.deepEqual(await readLocalDiscovery({ environment: fixture.environment }), replacement);
  } finally {
    await registration.close();
    await removeFixture(fixture);
  }
  assert.equal(await readLocalDiscovery({ environment: fixture.environment }), undefined);
});

test('read rejects malformed, non-strict, unsafe, oversized, symlink, non-regular, and insecure records', async () => {
  const fixture = await createFixture();
  const recordPath = await prepareRecordDirectory(fixture);
  try {
    const stale = validRecord({ startedAt: '2000-01-01T00:00:00.000Z' });
    await writeRecord(recordPath, stale);
    assert.deepEqual(await readLocalDiscovery({ environment: fixture.environment }), stale);

    await writeRecord(
      recordPath,
      JSON.stringify({ ...stale, unexpected: true })
    );
    await assert.rejects(
      readLocalDiscovery({ environment: fixture.environment }),
      LocalDiscoveryValidationError
    );

    await writeRecord(
      recordPath,
      JSON.stringify({ schemaVersion: 1, url: stale.url, instanceId: stale.instanceId })
    );
    await assert.rejects(
      readLocalDiscovery({ environment: fixture.environment }),
      /missing field startedAt/
    );

    await writeRecord(
      recordPath,
      JSON.stringify({ ...stale, url: 'http://localhost:7391' })
    );
    await assert.rejects(
      readLocalDiscovery({ environment: fixture.environment }),
      /127\.0\.0\.1:<nonzero-port>/
    );

    await writeRecord(
      recordPath,
      JSON.stringify({ ...stale, schemaVersion: 2 })
    );
    await assert.rejects(
      readLocalDiscovery({ environment: fixture.environment }),
      /schemaVersion must be exactly 1/
    );

    await writeRecord(recordPath, '{not-json');
    await assert.rejects(
      readLocalDiscovery({ environment: fixture.environment }),
      /malformed JSON/
    );

    await writeRecord(recordPath, 'x'.repeat(MAX_LOCAL_DISCOVERY_RECORD_BYTES + 1));
    await assert.rejects(
      readLocalDiscovery({ environment: fixture.environment }),
      /exceeds 4096 bytes/
    );

    await writeRecord(recordPath, stale, 0o644);
    await assert.rejects(
      readLocalDiscovery({ environment: fixture.environment }),
      /must have mode 0600/
    );

    await rm(recordPath, { force: true });
    const target = path.join(fixture.root, 'target.json');
    await writeRecord(target, stale);
    await symlink(target, recordPath);
    await assert.rejects(
      readLocalDiscovery({ environment: fixture.environment }),
      /must not be a symlink/
    );

    await rm(recordPath, { force: true });
    await mkdir(recordPath);
    await assert.rejects(
      readLocalDiscovery({ environment: fixture.environment }),
      /must be a regular file/
    );
  } finally {
    await removeFixture(fixture);
  }
});

test('discovery ownership contention is refused until the first lifetime owner closes', async () => {
  const fixture = await createFixture();
  const first = await createLocalDiscoveryRegistration({ environment: fixture.environment });
  try {
    await assert.rejects(
      createLocalDiscoveryRegistration({ environment: fixture.environment }),
      /Another execution-owning AgentKnot runtime already owns storage directory/
    );
  } finally {
    await first.close();
  }

  const second = await createLocalDiscoveryRegistration({ environment: fixture.environment });
  await second.close();
  await removeFixture(fixture);
});

test('cleanup is identity-aware and leaves a newer or different record untouched', async () => {
  const fixture = await createFixture();
  const registration = await createLocalDiscoveryRegistration({ environment: fixture.environment });
  try {
    const original = await registration.publish(7391);
    const newer = validRecord({ url: 'http://127.0.0.1:7392' });
    assert.notEqual(newer.instanceId, original.instanceId);
    await writeRecord(registration.paths.recordPath, newer);

    assert.equal(await registration.cleanup(), false);
    assert.deepEqual(await registration.read(), newer);
  } finally {
    await registration.close();
    await removeFixture(fixture);
  }
});

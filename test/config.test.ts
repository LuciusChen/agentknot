import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig, resolveRoute } from '../src/config.js';

test('parseConfig keeps worker and provider as independent routing dimensions', () => {
  const config = parseConfig({
    version: 1,
    defaultRoute: 'luna',
    storage: { directory: '.agentknot/jobs' },
    workers: {
      pi: { adapter: 'pi-rpc', command: 'pi', commandArgs: ['--no-skills'] },
    },
    routes: {
      luna: {
        worker: 'pi',
        provider: 'opencode-go',
        model: 'gpt-5.6-luna',
        thinkingLevel: 'high',
        requiredEnv: ['OPENCODE_API_KEY'],
      },
    },
  });

  assert.deepEqual(config.workers.pi, {
    adapter: 'pi-rpc',
    command: 'pi',
    commandArgs: ['--no-skills'],
  });

  assert.deepEqual(resolveRoute(config), {
    name: 'luna',
    worker: 'pi',
    provider: 'opencode-go',
    model: 'gpt-5.6-luna',
    thinkingLevel: 'high',
    requiredEnv: ['OPENCODE_API_KEY'],
    maxAttempts: 1,
    timeoutMs: 1_800_000,
  });
});

test('parseConfig validates workspace isolation and preserves direct compatibility by default', () => {
  const base = {
    version: 1,
    defaultRoute: 'mock',
    storage: { directory: '.agentknot/jobs' },
    workers: { mock: { adapter: 'mock' } },
    routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
  };
  assert.equal(parseConfig(base).workspaceIsolation?.mode, 'none');
  assert.equal(
    parseConfig({ ...base, workspaceIsolation: { mode: 'git-worktree', directory: '/tmp/worktrees' } })
      .workspaceIsolation?.mode,
    'git-worktree'
  );
  assert.throws(() => parseConfig({ ...base, workspaceIsolation: { mode: 'unsafe' } }), /mode must be/);
  assert.throws(
    () => parseConfig({ ...base, workspaceIsolation: { mode: 'git-worktree', directory: 42 } }),
    /directory must be/
  );
});

test('parseConfig rejects routes pointing to a missing worker', () => {
  assert.throws(
    () =>
      parseConfig({
        version: 1,
        defaultRoute: 'bad',
        storage: { directory: '.agentknot/jobs' },
        workers: { mock: { adapter: 'mock' } },
        routes: { bad: { worker: 'missing', provider: 'x', model: 'y' } },
      }),
    /unknown worker/
  );
});

test('parseConfig normalizes bounded automatic delegation without coupling it to a controller', () => {
  const config = parseConfig({
    version: 1,
    defaultRoute: 'luna',
    storage: {
      directory: '.agentknot/jobs',
      orchestrationDirectory: '.agentknot/orchestrations',
    },
    workspaceIsolation: { mode: 'git-worktree' },
    workers: { pi: { adapter: 'pi-rpc' } },
    routes: {
      luna: { worker: 'pi', provider: 'opencode-go', model: 'gpt-5.6-luna' },
      secondary: { worker: 'pi', provider: 'secondary-provider', model: 'secondary-model' },
    },
    delegation: {
      mode: 'auto',
      planner: { strategy: 'hybrid', route: 'luna' },
      dispatch: {
        defaultRoute: 'secondary',
        maxChildren: 3,
        maxDepth: 1,
        maxConcurrency: 2,
        routeSelection: {
          mode: 'shadow',
          rules: [
            { route: 'luna', taskKinds: ['documentation'], complexities: ['low', 'medium'] },
            { route: 'secondary' },
          ],
        },
      },
      policy: {
        delegate: ['documentation', 'test-gap-analysis'],
        keepUpstream: ['product-decision', 'artifact-integration'],
      },
      fallback: 'upstream',
    },
  });

  assert.deepEqual(config.storage, {
    directory: '.agentknot/jobs',
    orchestrationDirectory: '.agentknot/orchestrations',
  });
  assert.deepEqual(config.delegation, {
    mode: 'auto',
    planner: { strategy: 'hybrid', route: 'luna' },
    dispatch: {
      defaultRoute: 'secondary',
      maxChildren: 3,
      maxDepth: 1,
      maxConcurrency: 2,
      routeSelection: {
        mode: 'shadow',
        rules: [
          { route: 'luna', taskKinds: ['documentation'], complexities: ['low', 'medium'] },
          { route: 'secondary' },
        ],
      },
    },
    policy: {
      delegate: ['documentation', 'test-gap-analysis'],
      keepUpstream: ['product-decision', 'artifact-integration'],
    },
    fallback: 'upstream',
  });

  const defaults = parseConfig({
    version: 1,
    defaultRoute: 'mock',
    storage: { directory: '.agentknot/jobs' },
    workspaceIsolation: { mode: 'git-worktree' },
    workers: { mock: { adapter: 'mock' } },
    routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
    delegation: { mode: 'auto' },
  });
  assert.deepEqual(defaults.delegation?.dispatch, {
    defaultRoute: 'mock',
    maxChildren: 2,
    maxDepth: 1,
    maxConcurrency: 2,
  });
  assert.equal(defaults.delegation?.dispatch.routeSelection, undefined);
});

test('parseConfig strictly validates optional shadow and active route selection rules', () => {
  const base = {
    version: 1,
    defaultRoute: 'mock',
    storage: { directory: '.agentknot/jobs' },
    workers: {
      mock: { adapter: 'mock' },
    },
    routes: {
      mock: { worker: 'mock', provider: 'mock', model: 'mock' },
      alternate: { worker: 'mock', provider: 'mock', model: 'alternate' },
    },
  };
  const valid = {
    mode: 'shadow',
    rules: [
      { route: 'alternate', taskKinds: ['documentation'], complexities: ['low', 'medium'] },
      { route: 'mock', complexities: ['high'] },
      { route: 'mock' },
    ],
  };
  assert.deepEqual(
    parseConfig({ ...base, delegation: { mode: 'off', dispatch: { routeSelection: valid } } })
      .delegation?.dispatch.routeSelection,
    valid
  );
  const active = { ...valid, mode: 'active' };
  assert.deepEqual(
    parseConfig({ ...base, delegation: { mode: 'off', dispatch: { routeSelection: active } } })
      .delegation?.dispatch.routeSelection,
    active
  );

  const invalidRouteSelections: unknown[] = [
    null,
    {},
    { mode: 'shadow' },
    { mode: 'shadow', rules: null },
    { mode: 'shadow', rules: 'not-an-array' },
    { mode: 'auto', rules: [{ route: 'mock' }] },
    { mode: 'enforce', rules: [{ route: 'mock' }] },
    { mode: 'unknown', rules: [{ route: 'mock' }] },
    { mode: 'shadow', rules: [] },
    { mode: 'shadow', rules: Array.from({ length: 21 }, () => ({ route: 'mock' })) },
    { mode: 'shadow', rules: [null] },
    { mode: 'shadow', rules: [{ route: '' }] },
    { mode: 'shadow', rules: [{ route: 'missing' }] },
    { mode: 'shadow', rules: [{ route: 'mock', taskKinds: 'documentation' }] },
    { mode: 'shadow', rules: [{ route: 'mock', taskKinds: [1] }] },
    { mode: 'shadow', rules: [{ route: 'mock', taskKinds: [] }] },
    { mode: 'shadow', rules: [{ route: 'mock', taskKinds: ['documentation', 'documentation'] }] },
    { mode: 'shadow', rules: [{ route: 'mock', complexities: 'medium' }] },
    { mode: 'shadow', rules: [{ route: 'mock', complexities: [1] }] },
    { mode: 'shadow', rules: [{ route: 'mock', complexities: [] }] },
    { mode: 'shadow', rules: [{ route: 'mock', complexities: ['medium', 'medium'] }] },
    { mode: 'shadow', rules: [{ route: 'mock', complexities: ['urgent'] }] },
    { mode: 'shadow', rules: [{ route: 'mock' }], unexpected: true },
    { mode: 'shadow', rules: [{ route: 'mock', unexpected: true }] },
  ];
  for (const routeSelection of invalidRouteSelections) {
    assert.throws(
      () => parseConfig({ ...base, delegation: { mode: 'off', dispatch: { routeSelection } } }),
      /routeSelection/
    );
  }
});

test('parseConfig rejects unsafe or unresolved delegation settings', () => {
  const base = {
    version: 1,
    defaultRoute: 'mock',
    storage: { directory: '.agentknot/jobs' },
    workers: { mock: { adapter: 'mock' } },
    routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
  };

  assert.throws(
    () => parseConfig({ ...base, delegation: { mode: 'auto', planner: { route: 'missing' } } }),
    /planner\.route references unknown route/
  );
  assert.throws(
    () =>
      parseConfig({
        ...base,
        delegation: { mode: 'auto', dispatch: { defaultRoute: 'mock', maxDepth: 2 } },
      }),
    /maxDepth must be 1/
  );
  assert.throws(
    () =>
      parseConfig({
        ...base,
        delegation: { mode: 'auto', dispatch: { defaultRoute: 'mock', maxChildren: 2, maxConcurrency: 3 } },
      }),
    /maxConcurrency must not exceed maxChildren/
  );
  assert.throws(
    () =>
      parseConfig({
        ...base,
        delegation: { mode: 'suggest', planner: { route: 'mock' } },
      }),
    /requires workspaceIsolation\.mode "git-worktree"/
  );
});

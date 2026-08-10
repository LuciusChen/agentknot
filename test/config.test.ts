import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig, resolveDelegationConfig, resolveRoute } from '../src/config.js';

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

test('parseConfig registers OpenCode JSON as an independent worker runtime', () => {
  const config = parseConfig({
    version: 1,
    defaultRoute: 'native-luna',
    storage: { directory: '.agentknot/jobs' },
    workers: {
      native: {
        adapter: 'opencode-json',
        command: '/opt/opencode',
        commandArgs: ['--log-level', 'ERROR'],
        environment: { XDG_CACHE_HOME: '/tmp/opencode-cache' },
        unsetEnvironment: ['OPENCODE_API_KEY', 'OPENCODE_API_KEY'],
      },
    },
    routes: {
      'native-luna': {
        worker: 'native',
        provider: 'opencode-go',
        model: 'gpt-5.6-luna',
        thinkingLevel: 'max',
      },
    },
  });

  assert.deepEqual(config.workers.native, {
    adapter: 'opencode-json',
    command: '/opt/opencode',
    commandArgs: ['--log-level', 'ERROR'],
    environment: { XDG_CACHE_HOME: '/tmp/opencode-cache' },
    unsetEnvironment: ['OPENCODE_API_KEY'],
  });
  assert.deepEqual(resolveRoute(config), {
    name: 'native-luna',
    worker: 'native',
    provider: 'opencode-go',
    model: 'gpt-5.6-luna',
    thinkingLevel: 'max',
    requiredEnv: [],
    maxAttempts: 1,
    timeoutMs: 1_800_000,
  });
});

test('parseConfig keeps route pools above complete exact routes', () => {
  const base = {
    version: 1,
    defaultRoute: 'a',
    storage: { directory: '.agentknot/jobs' },
    workspaceIsolation: { mode: 'git-worktree' },
    workers: { mock: { adapter: 'mock' } },
    routes: {
      a: { worker: 'mock', provider: 'p1', model: 'm1' },
      b: { worker: 'mock', provider: 'p2', model: 'm2' },
    },
    routePools: {
      balanced: { strategy: 'least-active', routes: ['a', 'b'] },
    },
    delegation: {
      mode: 'auto',
      planner: { strategy: 'hybrid', route: 'a' },
      dispatch: {
        defaultRoute: 'balanced',
        maxChildren: 2,
        maxDepth: 1,
        maxConcurrency: 2,
        routeSelection: { mode: 'active', rules: [{ route: 'balanced', complexities: ['high'] }] },
      },
      fallback: 'fail',
    },
  };
  const config = parseConfig(base);
  assert.deepEqual(config.routePools, {
    balanced: { strategy: 'least-active', routes: ['a', 'b'] },
  });
  assert.equal(config.delegation?.dispatch.defaultRoute, 'balanced');
  assert.equal(config.delegation?.dispatch.routeSelection?.rules[0]?.route, 'balanced');
  assert.equal(
    parseConfig({
      ...base,
      delegation: { ...base.delegation, planner: { strategy: 'hybrid', route: 'balanced' } },
    }).delegation?.planner.route,
    'balanced'
  );

  assert.throws(
    () => parseConfig({ ...base, routePools: { a: base.routePools.balanced } }),
    /conflicts with an exact route/
  );
  assert.throws(
    () => parseConfig({ ...base, routePools: { balanced: { strategy: 'least-active', routes: ['a'] } } }),
    /2-20/
  );
  assert.throws(
    () =>
      parseConfig({
        ...base,
        routePools: { balanced: { strategy: 'least-active', routes: ['a', 'missing'] } },
      }),
    /unknown route/
  );
  assert.throws(
    () => parseConfig({ ...base, routePools: { balanced: { strategy: 'random', routes: ['a', 'b'] } } }),
    /least-active/
  );
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
      qualityReview: { route: 'luna', complexities: ['low'] },
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
    qualityReview: { route: 'luna', complexities: ['low'] },
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
  assert.equal(defaults.delegation?.qualityReview, undefined);
});

test('parseConfig validates optional artifact validation and preserves its resolved policy values', () => {
  const base = {
    version: 1,
    defaultRoute: 'mock',
    storage: { directory: '.agentknot/jobs' },
    workers: { mock: { adapter: 'mock' } },
    routes: { mock: { worker: 'mock', provider: 'mock', model: 'mock' } },
  };
  const artifactValidation = {
    argv: ['node', './validate-artifact.mjs', '--format', 'json'],
    timeoutMs: 300_000,
    maxOutputBytes: 65_536,
  };
  const config = parseConfig({
    ...base,
    delegation: { mode: 'off', artifactValidation },
  });
  assert.deepEqual(config.delegation?.artifactValidation, artifactValidation);
  assert.deepEqual(resolveDelegationConfig(config).artifactValidation, artifactValidation);

  assert.equal(parseConfig({ ...base, delegation: { mode: 'off' } }).delegation?.artifactValidation, undefined);
  assert.equal(resolveDelegationConfig(parseConfig(base)).artifactValidation, undefined);

  const invalid: unknown[] = [
    null,
    {},
    { timeoutMs: 1, maxOutputBytes: 1 },
    { argv: ['node'], maxOutputBytes: 1 },
    { argv: ['node'], timeoutMs: 1 },
    { argv: [], timeoutMs: 1, maxOutputBytes: 1 },
    { argv: new Array(1), timeoutMs: 1, maxOutputBytes: 1 },
    { argv: Array.from({ length: 33 }, () => 'node'), timeoutMs: 1, maxOutputBytes: 1 },
    { argv: [''], timeoutMs: 1, maxOutputBytes: 1 },
    { argv: ['   '], timeoutMs: 1, maxOutputBytes: 1 },
    { argv: ['node', 1], timeoutMs: 1, maxOutputBytes: 1 },
    { argv: ['node'], timeoutMs: 0, maxOutputBytes: 1 },
    { argv: ['node'], timeoutMs: 300_001, maxOutputBytes: 1 },
    { argv: ['node'], timeoutMs: 1.5, maxOutputBytes: 1 },
    { argv: ['node'], timeoutMs: 1, maxOutputBytes: 0 },
    { argv: ['node'], timeoutMs: 1, maxOutputBytes: 65_537 },
    { argv: ['node'], timeoutMs: 1, maxOutputBytes: 1.5 },
    { argv: ['node'], timeoutMs: 1, maxOutputBytes: 1, unexpected: true },
  ];
  for (const artifactValidation of invalid) {
    assert.throws(
      () => parseConfig({ ...base, delegation: { mode: 'off', artifactValidation } }),
      /artifactValidation/
    );
  }
});

test('parseConfig strictly validates an optional single-attempt quality reviewer target', () => {
  const base = {
    version: 1,
    defaultRoute: 'worker',
    storage: { directory: '.agentknot/jobs' },
    workers: { mock: { adapter: 'mock' } },
    routes: {
      worker: { worker: 'mock', provider: 'mock', model: 'worker' },
      reviewer: { worker: 'mock', provider: 'mock', model: 'reviewer', maxAttempts: 1 },
      retrying: { worker: 'mock', provider: 'mock', model: 'retrying', maxAttempts: 2 },
    },
    routePools: {
      reviewers: { strategy: 'least-active', routes: ['worker', 'reviewer'] },
      mixedAttempts: { strategy: 'least-active', routes: ['reviewer', 'retrying'] },
    },
  };
  assert.deepEqual(
    parseConfig({
      ...base,
      delegation: {
        mode: 'off',
        qualityReview: { route: 'reviewer', complexities: ['low', 'medium'] },
      },
    }).delegation?.qualityReview,
    { route: 'reviewer', complexities: ['low', 'medium'] }
  );
  assert.deepEqual(
    parseConfig({
      ...base,
      delegation: {
        mode: 'off',
        qualityReview: { route: 'reviewers', complexities: ['low'] },
      },
    }).delegation?.qualityReview,
    { route: 'reviewers', complexities: ['low'] }
  );

  const invalid: unknown[] = [
    null,
    {},
    { route: '', complexities: ['low'] },
    { route: 'missing', complexities: ['low'] },
    { route: 'reviewer' },
    { route: 'reviewer', complexities: [] },
    { route: 'reviewer', complexities: ['low', 'low'] },
    { route: 'reviewer', complexities: ['urgent'] },
    { route: 'retrying', complexities: ['low'] },
    { route: 'mixedAttempts', complexities: ['low'] },
    { route: 'reviewer', complexities: ['low'], unexpected: true },
  ];
  for (const qualityReview of invalid) {
    assert.throws(
      () => parseConfig({ ...base, delegation: { mode: 'off', qualityReview } }),
      /qualityReview/
    );
  }
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

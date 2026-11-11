// Unit tests for the dev CLI's pure parts. Run with `pnpm test:dev-cli` (node --test).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveConfig, selectServices, serviceDefinitions } from '../lib/config.mjs';
import { brandCss } from '../lib/home.mjs';
import { checkNode } from '../lib/prepare.mjs';
import { renderBoard } from '../lib/status.mjs';
import {
  DevError,
  UsageError,
  makeTerm,
  parseArgs,
  parseEnv,
  secret,
  setEnvValues,
  stripAnsi,
} from '../lib/util.mjs';

test('parseArgs: command, flags with and without values', () => {
  assert.deepEqual(parseArgs([], ['only']), { command: 'up', positionals: [], flags: {} });
  const parsed = parseArgs(
    ['up', '--only', 'api,mobile', '--no-web', '--timeout=30', '-d'],
    ['only', 'timeout'],
  );
  assert.equal(parsed.command, 'up');
  assert.deepEqual(parsed.flags, {
    only: 'api,mobile',
    'no-web': true,
    timeout: '30',
    detach: true,
  });
  assert.deepEqual(parseArgs(['logs', 'api', '--tail', '5'], ['tail']).positionals, ['api']);
  assert.throws(() => parseArgs(['up', '--only'], ['only']), UsageError);
});

test('selectServices: --only, --no-<service>, and a clear error for a typo', () => {
  assert.deepEqual(selectServices({}), ['api', 'mobile', 'ops', 'web']);
  assert.deepEqual(selectServices({ only: 'mobile,api' }), ['api', 'mobile']);
  assert.deepEqual(selectServices({ 'no-web': true }), ['api', 'mobile', 'ops']);
  assert.deepEqual(selectServices({ only: 'api,web', 'no-web': true }), ['api']);
  assert.throws(
    () => selectServices({ only: 'api,wbe' }),
    /comma separated list of: api, mobile, ops, web/,
  );
});

test('resolveConfig: defaults, files, then the environment', () => {
  const none = resolveConfig({}, { root: {}, api: {} });
  assert.equal(none.ports.api, 4000);
  assert.equal(none.ports.mobile, 8099);
  assert.equal(none.database.url, 'postgresql://cashflow:cashflow@localhost:5432/cashflow');
  assert.equal(
    none.database.testUrl,
    'postgresql://cashflow:cashflow@localhost:5432/cashflow_test',
  );

  const files = {
    root: { POSTGRES_PORT: '5433' },
    api: { PORT: '4000', DATABASE_URL: 'postgresql://cashflow:cashflow@localhost:5433/cashflow' },
  };
  assert.equal(resolveConfig({}, files).database.port, 5433);

  const alt = resolveConfig(
    { API_PORT: '4500', POSTGRES_DB: 'scratch', MOBILE_PORT: '8199' },
    files,
  );
  assert.equal(alt.urls.api, 'http://localhost:4500');
  assert.equal(alt.ports.mobile, 8199);
  assert.equal(alt.database.name, 'scratch');
  assert.equal(alt.database.port, 5433);
  assert.equal(alt.database.testUrl.endsWith('/scratch_test'), true);

  const own = resolveConfig({ DATABASE_URL: 'postgresql://u:p@db.internal:6000/app' }, files);
  assert.equal(own.database.host, 'db.internal');
  assert.equal(own.database.local, false);
  assert.throws(() => resolveConfig({ API_PORT: 'abc' }, files), UsageError);
});

test('serviceDefinitions: every service knows its port, health check and log', () => {
  const config = resolveConfig({ API_PORT: '4500' }, { root: {}, api: {} });
  const defs = serviceDefinitions(config);
  assert.deepEqual(Object.keys(defs), ['api', 'mobile', 'ops', 'web']);
  assert.equal(defs.api.health, 'http://localhost:4500/health');
  assert.equal(defs.mobile.env.EXPO_PUBLIC_API_URL, 'http://localhost:4500');
  assert.equal(defs.ops.env.CASHFLOW_API_URL, 'http://localhost:4500');
  // Dev tools are a property of the local .env. The supervisor only ever forces them off.
  assert.equal(defs.api.env.ENABLE_DEV_TOOLS, undefined);
  const off = serviceDefinitions(config, { devTools: false });
  assert.equal(off.api.env.ENABLE_DEV_TOOLS, 'false');
  assert.equal(off.mobile.env.EXPO_PUBLIC_DEV_TOOLS, 'false');
});

test('env files: parse, replace in place, append what is missing', () => {
  const text = '# comment\nPORT=4000\nJWT_SECRET="placeholder"\n\nEMPTY=\n';
  assert.deepEqual(parseEnv(text), { PORT: '4000', JWT_SECRET: 'placeholder', EMPTY: '' });
  const next = setEnvValues(text, { PORT: '4500', ENABLE_DEV_TOOLS: 'true' });
  assert.equal(
    next,
    '# comment\nPORT=4500\nJWT_SECRET="placeholder"\n\nEMPTY=\nENABLE_DEV_TOOLS=true\n',
  );
  assert.equal(setEnvValues(next, { ENABLE_DEV_TOOLS: 'true' }), next);
});

test('secrets are random and long enough for the API to accept', () => {
  const a = secret(32);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, secret(32));
});

test('checkNode: too old stops with instructions, newer warns, exact is quiet', () => {
  assert.throws(
    () => checkNode('18.19.0', 22),
    (err) => err instanceof DevError && /nvm install 22/.test(err.fix),
  );
  assert.equal(checkNode('22.11.0', 22).warning, null);
  assert.match(checkNode('23.11.0', 22).warning, /newer than the 22/);
});

const sampleStatus = {
  running: true,
  supervisorPid: 4242,
  services: [
    {
      name: 'api',
      title: 'API',
      url: 'http://localhost:4000',
      port: 4000,
      pid: 1,
      managed: true,
      selected: true,
      health: 'healthy',
    },
    {
      name: 'web',
      title: 'Marketing site',
      url: 'http://localhost:3100',
      port: 3100,
      pid: null,
      managed: false,
      selected: false,
      health: 'stopped',
    },
  ],
  home: { url: 'http://localhost:4100', port: 4100, health: 'healthy' },
  postgres: {
    host: 'localhost',
    port: 5432,
    database: 'cashflow',
    reachable: true,
    migrated: true,
    seeded: true,
    accounts: 13,
  },
  devTools: { enabled: true, menu: 'tap the coin five times', shortcut: 'Ctrl+`' },
  clock: { today: '2026-11-18', wallToday: '2026-11-11', aheadDays: 7 },
  logs: { dir: '.dev/logs' },
  envFiles: { api: 'apps/api/.env', mobile: 'apps/mobile/.env' },
};

test('the status board is plain text without a terminal, and never shows a secret', () => {
  const stream = { isTTY: false, write: () => true };
  const board = renderBoard(sampleStatus, makeTerm({ stream }), {
    personas: [
      {
        group: 'CUSTOMER',
        email: 'demo@cashflow.local',
        title: 'Blue Door Bakery',
        key: 'active-plan',
        state: { label: 'Active plan, current' },
      },
    ],
    password: 'demo-password-123',
  });
  assert.equal(board, stripAnsi(board), 'no ANSI escape codes');
  assert.match(board, /simulated date 2026-11-18 \(7 days ahead of 2026-11-11\)/);
  assert.match(board, /API\s+http:\/\/localhost:4000\s+4000\s+1\s+healthy/);
  assert.doesNotMatch(board, /Marketing site/, 'a service that was not started is not listed');
  assert.match(board, /demo@cashflow\.local/);
  assert.match(
    board,
    /ADMIN_API_TOKEN or REVIEWER_API_TOKEN from apps\/api\/\.env \(not shown here\)/,
  );
  assert.match(board, /tap the coin five times/);
  assert.match(board, /\.\/dev smoke/);
});

test('the status board uses color on a terminal', () => {
  const stream = { isTTY: true, write: () => true };
  const board = renderBoard(sampleStatus, makeTerm({ stream, color: true }));
  assert.notEqual(board, stripAnsi(board));
});

test('the dev home page takes its colors from the shared brand tokens', () => {
  const css = brandCss("  colors: {\n    ink: '#15121C',\n    brightGold: '#FFD43B',\n  },\n");
  assert.equal(css, ':root { --ink: #15121C; --bright-gold: #FFD43B; }');
  assert.match(brandCss(), /--paper: #[0-9A-F]{6};/i);
});

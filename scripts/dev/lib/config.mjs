// Ports, URLs and the database address, resolved once per command.
//
// Precedence for every value: the environment of this command, then the local .env files,
// then the default. So `API_PORT=4001 POSTGRES_DB=scratch ./dev` runs a second copy beside
// the first without editing a file.
import path from 'node:path';

import { ROOT, LOG_DIR, readEnvFile, UsageError } from './util.mjs';

export const SERVICE_NAMES = ['api', 'mobile', 'ops', 'web'];

export const DEFAULT_PORTS = {
  api: 4000,
  mobile: 8099,
  ops: 3200,
  web: 3100,
  home: 4100,
  postgres: 5432,
};

export const ENV_FILES = {
  root: path.join(ROOT, '.env'),
  api: path.join(ROOT, 'apps/api/.env'),
  mobile: path.join(ROOT, 'apps/mobile/.env'),
  ops: path.join(ROOT, 'apps/ops/.env.local'),
};

const port = (value, name) => {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new UsageError(`${name} must be a port number, got "${value}"`);
  }
  return n;
};

export function resolveConfig(env = process.env, files = {}) {
  const rootEnv = files.root ?? readEnvFile(ENV_FILES.root);
  const apiEnv = files.api ?? readEnvFile(ENV_FILES.api);

  const pgPortOverride = port(env.POSTGRES_PORT, 'POSTGRES_PORT');
  const pgPort =
    pgPortOverride ?? port(rootEnv.POSTGRES_PORT, 'POSTGRES_PORT') ?? DEFAULT_PORTS.postgres;

  // The database address: DATABASE_URL from the environment wins outright. Otherwise the
  // one in apps/api/.env, with its port or database name replaced when POSTGRES_PORT or
  // POSTGRES_DB is set for this command.
  let databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    const base = new URL(
      apiEnv.DATABASE_URL ?? `postgresql://cashflow:cashflow@localhost:${pgPort}/cashflow`,
    );
    if (pgPortOverride !== undefined || !apiEnv.DATABASE_URL) base.port = String(pgPort);
    if (env.POSTGRES_DB) base.pathname = `/${env.POSTGRES_DB}`;
    databaseUrl = base.toString();
  }
  const db = new URL(databaseUrl);
  const database = decodeURIComponent(db.pathname.replace(/^\//, ''));
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${database.endsWith('_test') ? database : `${database}_test`}`;

  const ports = {
    api: port(env.API_PORT, 'API_PORT') ?? port(apiEnv.PORT, 'PORT') ?? DEFAULT_PORTS.api,
    mobile: port(env.MOBILE_PORT, 'MOBILE_PORT') ?? DEFAULT_PORTS.mobile,
    ops: port(env.OPS_PORT, 'OPS_PORT') ?? DEFAULT_PORTS.ops,
    web: port(env.WEB_PORT, 'WEB_PORT') ?? DEFAULT_PORTS.web,
    home: port(env.DEV_HOME_PORT, 'DEV_HOME_PORT') ?? DEFAULT_PORTS.home,
    postgres: Number(db.port || 5432),
  };
  const url = (p) => `http://localhost:${p}`;
  return {
    ports,
    urls: {
      api: url(ports.api),
      mobile: url(ports.mobile),
      ops: url(ports.ops),
      web: url(ports.web),
      home: url(ports.home),
    },
    database: {
      url: databaseUrl,
      testUrl: testUrl.toString(),
      host: db.hostname,
      port: ports.postgres,
      name: database,
      user: decodeURIComponent(db.username),
      /** True when Postgres is on this machine, so docker compose can provide it. */
      local: ['localhost', '127.0.0.1', '::1'].includes(db.hostname),
    },
    /** True when the command line or environment asked for something other than the files say. */
    overridden: {
      database: Boolean(env.DATABASE_URL || env.POSTGRES_DB || pgPortOverride !== undefined),
    },
  };
}

/**
 * The services the supervisor can run: how to start each, the environment it needs, and
 * how to tell it is up.
 */
export function serviceDefinitions(config, { devTools = true } = {}) {
  const pnpm = (filter, ...args) => ['pnpm', ['--filter', filter, 'exec', ...args]];
  const devToolsEnv = devTools ? {} : { ENABLE_DEV_TOOLS: 'false', EXPO_PUBLIC_DEV_TOOLS: 'false' };
  return {
    api: {
      name: 'api',
      title: 'API',
      color: 'gold',
      port: config.ports.api,
      url: config.urls.api,
      extra: `${config.urls.api}/docs`,
      health: `${config.urls.api}/health`,
      command: pnpm('@cashflow/api', 'tsx', 'watch', '--env-file-if-exists=.env', 'src/index.ts'),
      env: {
        PORT: String(config.ports.api),
        DATABASE_URL: config.database.url,
        ...devToolsEnv,
      },
      log: path.join(LOG_DIR, 'api.log'),
    },
    mobile: {
      name: 'mobile',
      title: 'App (Expo web)',
      color: 'cyan',
      port: config.ports.mobile,
      url: config.urls.mobile,
      health: config.urls.mobile,
      command: pnpm(
        '@cashflow/mobile',
        'expo',
        'start',
        '--web',
        '--port',
        String(config.ports.mobile),
      ),
      env: {
        EXPO_PUBLIC_API_URL: config.urls.api,
        EXPO_PUBLIC_OPS_URL: config.urls.ops,
        EXPO_PUBLIC_DEV_HOME_URL: config.urls.home,
        // Expo opens a browser tab on start unless told not to.
        BROWSER: 'none',
        EXPO_NO_TELEMETRY: '1',
        ...devToolsEnv,
      },
      log: path.join(LOG_DIR, 'mobile.log'),
    },
    ops: {
      name: 'ops',
      title: 'Ops console',
      color: 'magenta',
      port: config.ports.ops,
      url: config.urls.ops,
      health: `${config.urls.ops}/sign-in`,
      command: pnpm('@cashflow/ops', 'next', 'dev', '--port', String(config.ports.ops)),
      env: { CASHFLOW_API_URL: config.urls.api, NEXT_TELEMETRY_DISABLED: '1' },
      log: path.join(LOG_DIR, 'ops.log'),
    },
    web: {
      name: 'web',
      title: 'Marketing site',
      color: 'blue',
      port: config.ports.web,
      url: config.urls.web,
      health: config.urls.web,
      command: pnpm('@cashflow/web', 'next', 'dev', '--port', String(config.ports.web)),
      env: { NEXT_TELEMETRY_DISABLED: '1' },
      log: path.join(LOG_DIR, 'web.log'),
    },
  };
}

/** Which services a command line selects. `--only api,mobile`, `--no-web`, `--no-ops`. */
export function selectServices(flags) {
  let names = SERVICE_NAMES;
  if (typeof flags.only === 'string') {
    names = flags.only
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = names.filter((n) => !SERVICE_NAMES.includes(n));
    if (unknown.length > 0 || names.length === 0) {
      throw new UsageError(
        `--only takes a comma separated list of: ${SERVICE_NAMES.join(', ')}. Got "${flags.only}"`,
      );
    }
  } else if (flags.only === true) {
    throw new UsageError(`--only needs a list, for example --only api,mobile`);
  }
  for (const name of SERVICE_NAMES) {
    if (flags[`no-${name}`]) names = names.filter((n) => n !== name);
  }
  return SERVICE_NAMES.filter((n) => names.includes(n));
}

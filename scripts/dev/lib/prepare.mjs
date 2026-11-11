// Everything between a fresh clone and "ready to start the servers": preflight checks,
// install, local .env files, Postgres, migrations, the Prisma client, and demo data.
// Every step is idempotent and skips itself when there is nothing to do.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { DEFAULT_PORTS, ENV_FILES, resolveConfig } from './config.mjs';
import {
  CACHE_FILE,
  DevError,
  LOG_DIR,
  ROOT,
  exists,
  fileHash,
  insideRepo,
  portInUse,
  portOwner,
  readEnvFile,
  readJson,
  rel,
  run,
  runLogged,
  secret,
  seconds,
  setEnvValues,
  sleep,
  writeJson,
} from './util.mjs';

const SETUP_LOG = path.join(LOG_DIR, 'setup.log');

const readCache = () => readJson(CACHE_FILE, {});
const updateCache = (patch) => writeJson(CACHE_FILE, { ...readCache(), ...patch });

// ---- Preflight ----

export function requiredNodeMajor() {
  try {
    return Number(
      fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim().replace(/^v/, '').split('.')[0],
    );
  } catch {
    return 22;
  }
}

/** Throws a DevError when Node is too old. Returns a warning when it is newer than tested. */
export function checkNode(version = process.versions.node, required = requiredNodeMajor()) {
  const major = Number(version.split('.')[0]);
  if (major < required) {
    throw new DevError(
      `Node ${version} is too old. This project needs Node ${required} (see .nvmrc).`,
      `Install it with one of:\n      nvm install ${required} && nvm use ${required}\n      brew install node@${required}\n      https://nodejs.org/en/download\n    then run ./dev again.`,
    );
  }
  return {
    version,
    warning:
      major > required
        ? `Node ${version} is newer than the ${required} this project is tested on. Continuing.`
        : null,
  };
}

function wantedPnpm() {
  const pkg = readJson(path.join(ROOT, 'package.json'), {});
  const m = /^pnpm@(\d+)\.[\w.-]+/.exec(pkg.packageManager ?? '');
  return { spec: m ? m[0] : 'pnpm@10', major: m ? Number(m[1]) : 10 };
}

/** Makes sure pnpm is on the PATH, enabling it through corepack when it is not. */
export function ensurePnpm(term) {
  const wanted = wantedPnpm();
  let res = run('pnpm', ['--version']);
  if (!res.ok) {
    // Running this command is consent to set up the package manager the repo names.
    term.start(`pnpm not found. Enabling ${wanted.spec} through corepack`);
    const enable = run('corepack', ['enable', 'pnpm']);
    const prepare = enable.ok ? run('corepack', ['prepare', wanted.spec, '--activate']) : enable;
    res = run('pnpm', ['--version']);
    if (!res.ok) {
      const why = (prepare.stderr || enable.stderr).trim().split('\n').pop() ?? '';
      throw new DevError(
        `pnpm is not installed and corepack could not enable it${why ? `: ${why}` : '.'}`,
        `Install it yourself, then run ./dev again:\n      npm install -g ${wanted.spec}\n    or, if corepack needs permission:\n      sudo corepack enable pnpm`,
      );
    }
    term.ok(`pnpm ${res.stdout.trim()}`, `enabled through corepack (corepack enable pnpm)`);
    return;
  }
  const version = res.stdout.trim();
  term.ok(`pnpm ${version}`);
  if (Number(version.split('.')[0]) !== wanted.major) {
    term.warn(
      `package.json asks for ${wanted.spec}. pnpm ${version} may resolve the lockfile differently.`,
    );
  }
}

function dockerProblem() {
  const version = run('docker', ['--version']);
  if (!version.ok) {
    return new DevError(
      'Docker is not installed, and Postgres runs in a Docker container.',
      'Install Docker Desktop (https://docs.docker.com/get-docker/), start it, then run ./dev again.\n    Or point the project at a Postgres you already run: DATABASE_URL=postgresql://user:pass@host:5432/db ./dev',
    );
  }
  const info = run('docker', ['info'], { timeout: 15_000 });
  if (!info.ok) {
    return new DevError(
      'Docker is installed but its daemon is not running.',
      'Start Docker Desktop (or `sudo systemctl start docker` on Linux), wait for it to finish starting, then run ./dev again.',
    );
  }
  return null;
}

/**
 * For each service: free, already ours (reuse it), or taken by something else (stop).
 * Returns the names of the services that are already running from this checkout.
 */
export async function checkPorts(services, term) {
  const reuse = [];
  for (const service of services) {
    if (!(await portInUse(service.port))) continue;
    const owner = portOwner(service.port);
    if (owner && insideRepo(owner.cwd)) {
      reuse.push({ name: service.name, pid: owner.pid });
      term.ok(
        `Port ${service.port} (${service.name})`,
        `already running from this checkout, pid ${owner.pid}. Reusing it`,
      );
      continue;
    }
    const who = owner
      ? `pid ${owner.pid}${owner.command ? ` (${owner.command})` : ''}${owner.cwd ? `, started in ${owner.cwd}` : ''}`
      : 'another program';
    const variable = `${service.name === 'home' ? 'DEV_HOME' : service.name.toUpperCase()}_PORT`;
    throw new DevError(
      `Port ${service.port} is needed for ${service.title} and is in use by ${who}.`,
      `Stop that program, or run this one on another port:\n      ${variable}=${service.port + 1} ./dev`,
    );
  }
  return reuse;
}

// ---- Install ----

export async function ensureInstalled(term) {
  const lock = fileHash(path.join(ROOT, 'pnpm-lock.yaml'));
  const installed = exists(path.join(ROOT, 'node_modules/.modules.yaml'));
  if (installed && readCache().lockHash === lock) {
    term.ok('Dependencies', 'up to date');
    return false;
  }
  const began = Date.now();
  term.start(
    installed
      ? 'Installing dependencies (lockfile changed)'
      : 'Installing dependencies (first run, about a minute)',
  );
  const args = ['install', ...(process.env.CI ? ['--frozen-lockfile'] : [])];
  const res = await runLogged('pnpm', args, { logFile: SETUP_LOG });
  if (!res.ok) {
    throw new DevError(
      'pnpm install failed.',
      `The full output is in ${rel(SETUP_LOG)}. Fix what it reports and run ./dev again.`,
    );
  }
  updateCache({ lockHash: lock });
  term.ok('Dependencies installed', seconds(Date.now() - began));
  return true;
}

// ---- .env files ----

function dockerPostgresPort() {
  const res = run('docker', ['port', 'cashflow-postgres', '5432/tcp']);
  const m = res.ok ? /:(\d+)\s*$/m.exec(res.stdout.trim().split('\n')[0] ?? '') : null;
  return m ? Number(m[1]) : null;
}

/** The host port for Postgres on a first run: the container's, or the first free one. */
async function pickPostgresPort() {
  const existing = dockerPostgresPort();
  if (existing) return { port: existing, note: null };
  for (let port = DEFAULT_PORTS.postgres; port < DEFAULT_PORTS.postgres + 10; port++) {
    if (!(await portInUse(port))) {
      return {
        port,
        note:
          port === DEFAULT_PORTS.postgres
            ? null
            : `Port ${DEFAULT_PORTS.postgres} is taken by another program, so Postgres will use ${port}`,
      };
    }
  }
  return { port: DEFAULT_PORTS.postgres, note: null };
}

function createFromExample(target, example, values) {
  const text = fs.readFileSync(example, 'utf8');
  fs.writeFileSync(target, setEnvValues(text, values), { mode: 0o600 });
}

/**
 * Creates the local .env files that are missing, from the committed examples, with fresh
 * secrets. An existing file is never rewritten: the only change ever made to one is adding
 * a dev tools key that is not in it yet. Secret values are never printed.
 */
export async function ensureEnvFiles(term, { devTools = true, env = process.env } = {}) {
  const created = [];
  if (!exists(ENV_FILES.root)) {
    const picked = env.POSTGRES_PORT
      ? { port: Number(env.POSTGRES_PORT), note: null }
      : await pickPostgresPort();
    createFromExample(ENV_FILES.root, path.join(ROOT, '.env.example'), {
      POSTGRES_PORT: String(picked.port),
    });
    created.push('.env');
    if (picked.note) term.warn(`${picked.note}. Written to .env as POSTGRES_PORT`);
  }
  // Resolved after the root file exists, so the database address uses the port just picked.
  const config = resolveConfig(env);

  if (!exists(ENV_FILES.api)) {
    createFromExample(ENV_FILES.api, path.join(ROOT, 'apps/api/.env.example'), {
      PORT: String(config.ports.api),
      DATABASE_URL: config.database.url,
      DATABASE_URL_TEST: config.database.testUrl,
      JWT_SECRET: secret(48),
      ADMIN_API_TOKEN: secret(32),
      REVIEWER_API_TOKEN: secret(32),
      ENABLE_DEV_TOOLS: String(devTools),
    });
    created.push('apps/api/.env (JWT secret, admin and reviewer tokens generated)');
  } else if (devTools && readEnvFile(ENV_FILES.api).ENABLE_DEV_TOOLS === undefined) {
    fs.writeFileSync(
      ENV_FILES.api,
      setEnvValues(fs.readFileSync(ENV_FILES.api, 'utf8'), { ENABLE_DEV_TOOLS: 'true' }),
    );
    term.ok('apps/api/.env', 'added ENABLE_DEV_TOOLS=true (dev menu, personas, simulated clock)');
  }

  const mobileValues = {
    EXPO_PUBLIC_API_URL: config.urls.api,
    EXPO_PUBLIC_DEV_TOOLS: String(devTools),
    EXPO_PUBLIC_OPS_URL: config.urls.ops,
    EXPO_PUBLIC_DEV_HOME_URL: config.urls.home,
  };
  if (!exists(ENV_FILES.mobile)) {
    createFromExample(ENV_FILES.mobile, path.join(ROOT, 'apps/mobile/.env.example'), mobileValues);
    created.push('apps/mobile/.env');
  } else if (devTools) {
    const current = readEnvFile(ENV_FILES.mobile);
    const missing = Object.fromEntries(
      Object.entries(mobileValues).filter(([key]) => current[key] === undefined),
    );
    if (Object.keys(missing).length > 0) {
      fs.writeFileSync(
        ENV_FILES.mobile,
        setEnvValues(fs.readFileSync(ENV_FILES.mobile, 'utf8'), missing),
      );
      term.ok('apps/mobile/.env', `added ${Object.keys(missing).join(', ')}`);
    }
  }

  if (!exists(ENV_FILES.ops)) {
    createFromExample(ENV_FILES.ops, path.join(ROOT, 'apps/ops/.env.example'), {
      CASHFLOW_API_URL: config.urls.api,
      OPS_SESSION_SECRET: secret(32),
    });
    created.push('apps/ops/.env.local (session secret generated)');
  }

  if (created.length > 0) {
    term.ok('Created local env files', 'gitignored, secrets not shown');
    for (const file of created) term.line(`      ${file}`);
  } else {
    term.ok('Local env files', 'present');
  }
  return config;
}

// ---- Postgres ----

function loadPg() {
  try {
    return createRequire(path.join(ROOT, 'apps/api/package.json'))('pg');
  } catch {
    throw new DevError(
      'The Postgres client is not installed yet.',
      'Run ./dev without --skip-install so dependencies are installed first.',
    );
  }
}

async function withClient(url, fn) {
  const pg = loadPg();
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

const maintenanceUrl = (config) => {
  const url = new URL(config.database.url);
  url.pathname = '/postgres';
  return url.toString();
};

/** 'up', 'down' (nothing listening), or 'refused' (something answers but will not let us in). */
export async function postgresState(config) {
  try {
    await withClient(maintenanceUrl(config), (c) => c.query('SELECT 1'));
    return 'up';
  } catch (err) {
    if (err instanceof DevError) throw err;
    const listening = await portInUse(config.database.port);
    return listening && !['ECONNREFUSED', 'ECONNRESET'].includes(err.code) ? 'refused' : 'down';
  }
}

export async function ensurePostgres(config, term) {
  const { database } = config;
  let state = await postgresState(config);
  if (state === 'up') {
    term.ok(`Postgres on :${database.port}`, 'accepting connections');
  } else if (state === 'refused') {
    throw new DevError(
      `Something is listening on port ${database.port} but it is not this project's Postgres (the cashflow login was refused).`,
      `Run the project's Postgres on another port. It is remembered in .env:\n      POSTGRES_PORT=${database.port + 1} ./dev\n    (then update DATABASE_URL in apps/api/.env to the same port if that file already exists)`,
    );
  } else {
    if (!database.local) {
      throw new DevError(
        `Cannot reach Postgres at ${database.host}:${database.port}.`,
        'Check DATABASE_URL in apps/api/.env, or unset it to use the Postgres container this project starts.',
      );
    }
    const problem = dockerProblem();
    if (problem) throw problem;
    const began = Date.now();
    term.start(`Starting Postgres in Docker on :${database.port}`);
    const res = await runLogged('docker', ['compose', 'up', '-d', '--wait'], {
      env: { ...process.env, POSTGRES_PORT: String(database.port) },
      logFile: SETUP_LOG,
    });
    if (!res.ok) {
      throw new DevError(
        'docker compose could not start Postgres.',
        `The output is in ${rel(SETUP_LOG)}. A common cause is the port being taken: try POSTGRES_PORT=${database.port + 1} ./dev`,
      );
    }
    // The container reports healthy just before the init script's restart completes.
    for (let i = 0; i < 60 && state !== 'up'; i++) {
      state = await postgresState(config);
      if (state !== 'up') await sleep(500);
    }
    if (state !== 'up') {
      throw new DevError(
        `Postgres started but is not accepting connections on :${database.port}.`,
        'Look at `docker logs cashflow-postgres`, then run ./dev again.',
      );
    }
    term.ok(`Postgres started on :${database.port}`, seconds(Date.now() - began));
  }

  // The databases themselves. The container's init script creates the defaults; a database
  // name chosen with POSTGRES_DB, or a Postgres this project did not start, may lack them.
  const wanted = [database.name, new URL(config.database.testUrl).pathname.slice(1)];
  await withClient(maintenanceUrl(config), async (client) => {
    for (const name of wanted) {
      const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (found.rowCount === 0) {
        await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
        term.ok(`Created database ${name}`);
      }
    }
  });
}

const apiEnv = (config) => ({ ...process.env, DATABASE_URL: config.database.url });

export async function ensurePrismaClient(term) {
  const schema = fileHash(path.join(ROOT, 'apps/api/prisma/schema.prisma'));
  const generated = exists(path.join(ROOT, 'apps/api/src/generated/prisma/client.ts'));
  if (generated && readCache().schemaHash === schema) return;
  term.start('Generating the Prisma client');
  const res = await runLogged('pnpm', ['--filter', '@cashflow/api', 'exec', 'prisma', 'generate'], {
    logFile: SETUP_LOG,
  });
  if (!res.ok) {
    throw new DevError('prisma generate failed.', `The output is in ${rel(SETUP_LOG)}.`);
  }
  updateCache({ schemaHash: schema });
  term.ok('Prisma client generated');
}

export async function ensureMigrated(config, term) {
  term.start('Applying database migrations');
  const res = await runLogged(
    'pnpm',
    ['--filter', '@cashflow/api', 'exec', 'prisma', 'migrate', 'deploy'],
    { env: apiEnv(config), logFile: SETUP_LOG },
  );
  if (!res.ok) {
    throw new DevError(
      'Applying migrations failed.',
      `The output is in ${rel(SETUP_LOG)}. If the database is from an older checkout, rebuild it with \`pnpm db:reset\` and run ./dev again.`,
    );
  }
  term.ok(`Migrations applied to ${config.database.name}`);
}

/** Users in the database, or null when it cannot be read (not migrated, not reachable). */
export async function countUsers(config) {
  try {
    return await withClient(config.database.url, async (client) => {
      const res = await client.query('SELECT count(*)::int AS n FROM "User"');
      return res.rows[0].n;
    });
  } catch {
    return null;
  }
}

export async function ensureSeeded(config, term, { reseed = false } = {}) {
  const users = await countUsers(config);
  if (!reseed && users !== null && users > 0) {
    term.ok('Demo data', `present (${users} accounts). --reseed rebuilds it`);
    return false;
  }
  const began = Date.now();
  term.start(reseed ? 'Rebuilding demo data' : 'Seeding demo data (five months of jobs replayed)');
  const res = await runLogged(
    'pnpm',
    ['--filter', '@cashflow/api', 'exec', 'tsx', '--env-file-if-exists=.env', 'prisma/seed.ts'],
    { env: apiEnv(config), logFile: SETUP_LOG },
  );
  if (!res.ok) {
    throw new DevError(
      'Seeding demo data failed.',
      `The output is in ${rel(SETUP_LOG)}. The last lines usually name the persona that did not build.`,
    );
  }
  term.ok('Demo data seeded', seconds(Date.now() - began));
  return true;
}

/** Windows is not supported natively. Say so plainly. */
export function checkPlatform() {
  if (process.platform === 'win32') {
    throw new DevError(
      'This command runs on macOS and Linux. On Windows, use WSL.',
      'Install WSL (https://learn.microsoft.com/windows/wsl/install), clone the repo inside it, and run ./dev there.',
    );
  }
}

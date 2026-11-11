// What is running, where, and whether it is healthy. One collector feeds the terminal
// board, `status --json`, and the dev home page.
import { ENV_FILES, resolveConfig, serviceDefinitions, SERVICE_NAMES } from './config.mjs';
import { countUsers } from './prepare.mjs';
import {
  DEV_DIR,
  LOG_DIR,
  STATE_FILE,
  http,
  pidAlive,
  portInUse,
  portOwner,
  readEnvFile,
  readJson,
  rel,
} from './util.mjs';

export const DEV_MENU_SHORTCUT = 'Ctrl+`';
export const DEV_MENU_HINT = `In the app, tap the coin five times (the CashFlow wordmark on the welcome screen), or press ${DEV_MENU_SHORTCUT} on web`;

export const readState = () => readJson(STATE_FILE, null);

/** The supervisor's state file, when the supervisor that wrote it is still alive. */
export function liveState() {
  const state = readState();
  return state && pidAlive(state.supervisorPid) ? state : null;
}

async function healthOf(service) {
  const res = await http(service.health, { timeoutMs: 2500 });
  return res.status >= 200 && res.status < 400;
}

export async function collectStatus(env = process.env) {
  const state = liveState();
  const config = resolveConfig(env);
  // A running supervisor knows the ports it started on, whatever the environment says now.
  const ports = state?.config.ports ?? config.ports;
  const urls = state?.config.urls ?? config.urls;
  const database = state?.config.database ?? config.database;
  const defs = serviceDefinitions({ ...config, ports, urls });

  const services = await Promise.all(
    SERVICE_NAMES.map(async (name) => {
      const def = defs[name];
      const entry = state?.services?.[name] ?? null;
      const listening = await portInUse(def.port);
      const healthy = listening ? await healthOf(def) : false;
      const pid = entry?.pid ?? (listening ? (portOwner(def.port)?.pid ?? null) : null);
      let health = 'stopped';
      if (healthy) health = 'healthy';
      else if (entry?.status === 'exited') health = 'exited';
      else if (entry || listening) health = 'starting';
      return {
        name,
        title: def.title,
        url: def.url,
        port: def.port,
        pid,
        /** True when the supervisor started it and `stop` will stop it. */
        managed: Boolean(entry?.managed),
        selected: state ? Boolean(entry) : null,
        health,
        exitCode: entry?.exitCode ?? null,
        log: entry?.log ? rel(entry.log) : null,
      };
    }),
  );

  const api = services.find((s) => s.name === 'api');
  let clock = null;
  let devToolsEnabled = false;
  let overview = null;
  if (api.health === 'healthy') {
    const res = await http(`${urls.api}/v1/dev/overview`, { timeoutMs: 4000 });
    if (res.ok && res.body) {
      devToolsEnabled = true;
      overview = res.body;
      clock = res.body.clock;
    }
  }

  const accounts = await countUsers({ database }).catch(() => null);
  const postgresListening = await portInUse(database.port);
  const homeUp = state ? (await http(`${urls.home}/api/ping`, { timeoutMs: 1500 })).ok : false;

  return {
    running: state !== null,
    supervisorPid: state?.supervisorPid ?? null,
    startedAt: state?.startedAt ?? null,
    healthy: services.filter((s) => s.selected !== false).every((s) => s.health === 'healthy'),
    services,
    home: { url: urls.home, port: ports.home, health: homeUp ? 'healthy' : 'stopped' },
    postgres: {
      host: database.host,
      port: database.port,
      database: database.name,
      reachable: accounts !== null || postgresListening,
      migrated: accounts !== null,
      accounts,
      seeded: accounts !== null && accounts > 0,
    },
    devTools: {
      enabled: devToolsEnabled,
      configured: readEnvFile(ENV_FILES.api).ENABLE_DEV_TOOLS === 'true',
      menu: DEV_MENU_HINT,
      shortcut: DEV_MENU_SHORTCUT,
    },
    clock,
    counts: overview?.counts ?? null,
    ledger: overview?.ledger ?? null,
    logs: {
      dir: rel(LOG_DIR),
      files: Object.fromEntries(
        [...SERVICE_NAMES, 'setup', 'supervisor'].map((n) => [n, `${rel(LOG_DIR)}/${n}.log`]),
      ),
    },
    envFiles: Object.fromEntries(Object.entries(ENV_FILES).map(([k, v]) => [k, rel(v)])),
    stateDir: rel(DEV_DIR),
  };
}

const pad = (text, width) => String(text).padEnd(width);

/**
 * The status board as text. `personas` is the list from the API when it is up with dev
 * tools on. No secret is ever read or shown: only where they live.
 */
export function renderBoard(status, term, { personas = null, password = null } = {}) {
  const { c } = term;
  const lines = [];
  const date = status.clock
    ? status.clock.aheadDays > 0
      ? `simulated date ${status.clock.today} (${status.clock.aheadDays} days ahead of ${status.clock.wallToday})`
      : `date ${status.clock.today} (the real date)`
    : 'date unknown (API not up, or dev tools off)';
  lines.push('');
  lines.push(`  ${c.bold(c.gold('CashFlow dev'))}  ${c.dim(date)}`);
  lines.push('');
  lines.push(
    c.dim(`  ${pad('SERVICE', 16)}${pad('URL', 36)}${pad('PORT', 7)}${pad('PID', 8)}HEALTH`),
  );
  const healthText = (h, note = '') => {
    const text = `${h}${note}`;
    if (h === 'healthy') return c.green(text);
    if (h === 'starting') return c.yellow(text);
    if (h === 'stopped') return c.dim(text);
    return c.red(text);
  };
  for (const s of status.services) {
    if (s.selected === false) continue;
    const note =
      s.health === 'healthy' && !s.managed && status.running ? ' (reused, not managed)' : '';
    lines.push(
      `  ${pad(s.title, 16)}${pad(s.url, 36)}${pad(s.port, 7)}${pad(s.pid ?? '', 8)}${healthText(s.health, note)}`,
    );
  }
  lines.push(
    `  ${pad('Dev home', 16)}${pad(status.home.url, 36)}${pad(status.home.port, 7)}${pad(status.supervisorPid ?? '', 8)}${healthText(status.home.health)}`,
  );
  const pg = status.postgres;
  const pgHealth = !pg.reachable
    ? c.red('not reachable')
    : !pg.migrated
      ? c.yellow('up, not migrated')
      : pg.seeded
        ? c.green(`healthy, ${pg.accounts} accounts`)
        : c.yellow('up, no demo data');
  lines.push(
    `  ${pad('Postgres', 16)}${pad(`${pg.host}:${pg.port}/${pg.database}`, 36)}${pad(pg.port, 7)}${pad('', 8)}${pgHealth}`,
  );
  lines.push('');

  if (personas && personas.length > 0) {
    lines.push(
      `  ${c.bold('Demo logins')}${password ? c.dim(`  every one uses the password ${password}`) : ''}`,
    );
    for (const p of personas.filter((x) => x.group === 'CUSTOMER')) {
      lines.push(`    ${pad(p.email, 34)}${pad(p.title, 24)}${c.dim(p.state.label)}`);
    }
    const fresh = personas.filter((x) => x.group === 'FRESH');
    if (fresh.length > 0) {
      lines.push(
        `    ${pad('fresh-*@cashflow.local', 34)}${c.dim(`${fresh.length} logins with nothing created: ${fresh.map((p) => p.key.replace('fresh-', '')).join(', ')}`)}`,
      );
    }
  } else {
    lines.push(`  ${c.bold('Demo login')}  demo@cashflow.local / demo-password-123`);
  }
  lines.push('');
  lines.push(
    `  ${c.bold('Dev menu')}     ${status.devTools.enabled ? status.devTools.menu : c.yellow(`off. Set ENABLE_DEV_TOOLS=true in ${status.envFiles.api} and EXPO_PUBLIC_DEV_TOOLS=true in ${status.envFiles.mobile}`)}`,
  );
  lines.push(
    `  ${c.bold('Ops console')}  sign in with ADMIN_API_TOKEN or REVIEWER_API_TOKEN from ${status.envFiles.api} (not shown here)`,
  );
  lines.push(
    `  ${c.bold('Logs')}         ${status.logs.dir}/<service>.log   ./dev logs api --tail 50`,
  );
  lines.push('');
  lines.push(`  ${c.bold('Next')}`);
  lines.push(`    ${pad('./dev status', 26)}${c.dim('this board again. --json for machines')}`);
  lines.push(`    ${pad('./dev smoke', 26)}${c.dim('the happy path, scripted over HTTP')}`);
  lines.push(
    `    ${pad('./dev advance --days 7', 26)}${c.dim('move the simulated clock and run the jobs')}`,
  );
  lines.push(`    ${pad('./dev stop', 26)}${c.dim('stop what this command started')}`);
  lines.push('');
  return lines.join('\n');
}

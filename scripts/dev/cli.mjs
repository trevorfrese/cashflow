#!/usr/bin/env node
// The dev command. `./dev` at the repo root runs this. Node built-ins only, so it works on
// a fresh clone before anything is installed. `./dev help` lists every command and flag.
import { selectServices, serviceDefinitions, resolveConfig } from './lib/config.mjs';
import {
  checkNode,
  checkPlatform,
  checkPorts,
  ensureEnvFiles,
  ensureInstalled,
  ensureMigrated,
  ensurePnpm,
  ensurePostgres,
  ensurePrismaClient,
  ensureSeeded,
} from './lib/prepare.mjs';
import { dev, runSmoke } from './lib/scenario.mjs';
import { collectStatus, liveState, renderBoard } from './lib/status.mjs';
import {
  spawnDetachedSupervisor,
  stopSupervisor,
  supervise,
  waitHealthy,
} from './lib/supervisor.mjs';
import {
  DevError,
  LOG_DIR,
  UsageError,
  http,
  makeTerm,
  parseArgs,
  rel,
  run,
  seconds,
  sleep,
  stripAnsi,
  tailFile,
} from './lib/util.mjs';
import fs from 'node:fs';
import path from 'node:path';

const HELP = `
CashFlow dev: one command from a fresh clone to a running, seeded system.

  ./dev                     set up and start everything, then show the status board
  ./dev help                this text

Run
  ./dev [up]                preflight, install, .env files, Postgres, migrate, seed, start
      --only api,mobile     start only these services (api, mobile, ops, web)
      --no-web              leave one out (also --no-ops, --no-mobile, --no-api)
      --reseed              wipe the database and rebuild the demo data
      --detach, -d          start in the background and return once everything is healthy
      --non-interactive     the same, plus no colors or spinners (automatic without a terminal)
      --timeout <seconds>   how long to wait for services to be healthy (default 240)
      --no-dev-tools        run with the dev menu, personas and simulated clock switched off
      --open                open the dev home page in a browser when everything is up
      --json                print the final status as JSON on stdout
  ./dev status [--json]     what is running, where, and whether it is healthy
  ./dev wait [--timeout s]  block until every started service is healthy
  ./dev logs <service>      print a service log (api, mobile, ops, web, setup, supervisor)
      --tail <n>            last n lines (default 80)
      --follow              keep printing as the log grows
  ./dev stop                stop the services this command started, and nothing else
  ./dev doctor              run the preflight checks only

Drive (these mirror the dev menu in the app, and need the API up with dev tools on)
  ./dev personas [--json]   every persona, what it demonstrates, and its state right now
  ./dev session <persona>   sign in as a persona: who it is and where the app lands
      --token               print only the access token, for curl. A local test token.
      --json                the whole session as JSON (tokens only with --token)
  ./dev clock [--json]      the simulated date
  ./dev advance             move the clock forward, running every job for each day crossed
      --days <n>            by n days
      --to <YYYY-MM-DD>     to a date
      --next <persona>      to the next date something happens to that persona
  ./dev reset               wipe everything and rebuild the demo data (a few seconds)
      --persona <key>       rebuild only one persona, as a new account
  ./dev smoke               the scripted happy path over HTTP. Exit code 1 on any failed step
      --reset               rebuild the demo data afterwards (smoke moves the clock forward)
      --json                the steps as JSON

Environment (for a second copy beside the first, or a taken port)
  API_PORT MOBILE_PORT OPS_PORT WEB_PORT DEV_HOME_PORT POSTGRES_PORT
  POSTGRES_DB               database name (default cashflow). Created if missing.
  DATABASE_URL              a Postgres you already run, instead of the Docker container
  NO_COLOR                  no colors

macOS and Linux. On Windows, run it inside WSL.
`;

const VALUED = ['only', 'timeout', 'tail', 'days', 'to', 'next', 'persona', 'services', 'reuse'];

const out = (text) => process.stdout.write(`${text}\n`);
const printJson = (value) => out(JSON.stringify(value, null, 2));

async function board(term, stream = process.stdout) {
  const status = await collectStatus();
  let personas = null;
  let password = null;
  if (status.devTools.enabled) {
    const list = await dev('/personas').catch(() => null);
    personas = list?.personas ?? null;
    password = list?.password ?? null;
  }
  const boardTerm = makeTerm({ stream });
  stream.write(`${renderBoard(status, boardTerm, { personas, password })}\n`);
  void term;
  return status;
}

// ---- up ----

async function up(flags) {
  const interactive =
    Boolean(process.stdout.isTTY && process.stderr.isTTY) && !flags['non-interactive'];
  const detach = Boolean(flags.detach) || !interactive;
  const term = makeTerm({ color: interactive ? undefined : false });
  const devTools = !flags['no-dev-tools'];
  const timeoutMs = (Number(flags.timeout) || 240) * 1000;
  const names = selectServices(flags);
  const began = Date.now();

  checkPlatform();
  term.line('');
  term.line(
    `  ${term.c.bold(term.c.gold('CashFlow'))} ${term.c.dim('sandbox only: no real money moves in this code')}`,
  );
  term.line('');

  // Already running: say so and show the board, instead of starting a second copy.
  const existing = liveState();
  if (existing) {
    const running = Object.keys(existing.services);
    const same = names.every((n) => running.includes(n));
    if (!same) {
      throw new DevError(
        `Already running with a different set of services (${running.join(', ')}).`,
        'Stop it first with ./dev stop, then start what you want.',
      );
    }
    if (flags.reseed) {
      throw new DevError(
        'The system is running. --reseed is for a start from stopped.',
        'Use ./dev reset to rebuild the demo data while it runs.',
      );
    }
    term.ok('Already running', `supervisor pid ${existing.supervisorPid}. ./dev stop to stop it`);
    const defs = serviceDefinitions(existing.config, { devTools });
    await waitHealthy(
      names.map((n) => defs[n]),
      { timeoutMs, supervisorPid: existing.supervisorPid },
    );
    return finish({ term, flags, began, firstLine: 'Everything is healthy' });
  }

  const node = checkNode();
  term.ok(`Node ${node.version}`);
  if (node.warning) term.warn(node.warning);
  ensurePnpm(term);
  await ensureInstalled(term);
  const config = await ensureEnvFiles(term, { devTools });
  await ensurePostgres(config, term);
  await ensurePrismaClient(term);
  await ensureMigrated(config, term);
  await ensureSeeded(config, term, { reseed: Boolean(flags.reseed) });

  const defs = serviceDefinitions(config, { devTools });
  const services = names.map((n) => defs[n]);
  const reuse = await checkPorts(
    [...services, { name: 'home', title: 'the dev home page', port: config.ports.home }],
    term,
  );
  const toWait = services.filter((s) => !reuse.some((r) => r.name === s.name));

  if (detach) {
    const pid = spawnDetachedSupervisor({ serviceNames: names, reuse, devTools });
    term.start(`Starting ${names.join(', ')} in the background`);
    try {
      const waited = await waitHealthy(services, {
        timeoutMs,
        supervisorPid: pid,
        onTick: () => undefined,
      });
      term.ok(`Services healthy: ${names.join(', ')}`, seconds(waited));
    } catch (err) {
      await stopSupervisor();
      throw err;
    }
    return finish({ term, flags, began, firstLine: 'Ready' });
  }

  // Attached: this process is the supervisor. Logs stream below the board until Ctrl+C.
  const colors = { api: 'gold', mobile: 'cyan', ops: 'magenta', web: 'blue' };
  const sup = await supervise({
    config,
    services,
    reuse,
    devTools,
    attached: true,
    stream: (service, line) => {
      const tag = term.c[colors[service.name] ?? 'dim'](service.name.padEnd(6));
      process.stdout.write(`${tag} ${term.c.dim('│')} ${line}\n`);
    },
  });
  try {
    term.start(`Starting ${names.join(', ')}`);
    const waited = await waitHealthy(toWait, {
      timeoutMs,
      onTick: (pending) => term.start(`Waiting for ${pending.join(', ')}`),
    });
    term.ok(`Services healthy: ${names.join(', ')}`, seconds(waited));
  } catch (err) {
    await sup.shutdown();
    throw err;
  }
  await finish({ term, flags, began, firstLine: 'Ready' });
  term.line(term.c.dim('  Logs follow. Ctrl+C stops everything this command started.'));
  term.line('');
  sup.startStreaming();
  await sup.done;
  term.line('');
  term.ok('Stopped');
}

async function finish({ term, flags, began, firstLine }) {
  term.ok(firstLine, `${seconds(Date.now() - began)} in total`);
  if (flags.json) {
    printJson(await collectStatus());
  } else {
    await board(term);
  }
  if (flags.open) {
    const url = (await collectStatus()).home.url;
    run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  }
}

// ---- The background supervisor (internal: started by `up --detach`) ----

async function superviseCommand(flags) {
  const config = resolveConfig();
  const devTools = !flags['no-dev-tools'];
  const defs = serviceDefinitions(config, { devTools });
  const names = String(flags.services ?? '')
    .split(',')
    .filter(Boolean);
  const reuse = String(flags.reuse ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => {
      const [name, pid] = pair.split(':');
      return { name, pid: Number(pid) };
    });
  const sup = await supervise({ config, services: names.map((n) => defs[n]), reuse, devTools });
  await sup.done;
}

// ---- status, wait, logs, stop, doctor ----

async function status(flags) {
  if (flags.json) return printJson(await collectStatus());
  const result = await board(makeTerm());
  if (!result.running) {
    process.stderr.write(
      '  Nothing was started by ./dev. The board shows what answers on the configured ports.\n\n',
    );
  }
}

async function wait(flags) {
  const state = liveState();
  if (!state) {
    throw new DevError('Nothing is running.', 'Start it with ./dev --detach, then wait.');
  }
  const defs = serviceDefinitions(state.config);
  const services = Object.keys(state.services).map((n) => defs[n]);
  const waited = await waitHealthy(services, {
    timeoutMs: (Number(flags.timeout) || 240) * 1000,
    supervisorPid: state.supervisorPid,
  });
  if (flags.json) return printJson(await collectStatus());
  out(`healthy: ${services.map((s) => s.name).join(', ')} (${seconds(waited)})`);
}

async function logs(positionals, flags) {
  const name = positionals[0];
  const names = ['api', 'mobile', 'ops', 'web', 'setup', 'supervisor'];
  if (!names.includes(name)) {
    throw new UsageError(`./dev logs needs a service: ${names.join(', ')}`);
  }
  const file = path.join(LOG_DIR, `${name}.log`);
  if (!fs.existsSync(file)) {
    throw new DevError(
      `There is no ${rel(file)} yet.`,
      `It is written when ${name} is started by ./dev.`,
    );
  }
  const clean = (line) => (process.stdout.isTTY ? line : stripAnsi(line));
  const count = Math.max(1, Number(flags.tail) || 80);
  for (const line of tailFile(file, count)) out(clean(line));
  if (!flags.follow) return;
  let position = fs.statSync(file).size;
  for (;;) {
    await sleep(400);
    const { size } = fs.statSync(file);
    if (size < position) position = 0;
    if (size === position) continue;
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size - position);
    fs.readSync(fd, buffer, 0, buffer.length, position);
    fs.closeSync(fd);
    position = size;
    process.stdout.write(clean(buffer.toString('utf8')));
  }
}

async function stop(flags) {
  const result = await stopSupervisor();
  if (flags.json) return printJson(result);
  if (!result.stopped) return out(`Nothing to stop: ${result.reason}.`);
  out(`Stopped: ${result.services.join(', ') || 'no services'}, and the dev home page.`);
  if (result.left.length > 0) {
    out(`Left running (not started by ./dev): ${result.left.join(', ')}.`);
  }
  out('Postgres is left running in Docker. `pnpm db:down` stops it.');
}

async function doctor() {
  const term = makeTerm({ stream: process.stdout });
  checkPlatform();
  const node = checkNode();
  term.ok(`Node ${node.version}`);
  if (node.warning) term.warn(node.warning);
  ensurePnpm(term);
  const docker = run('docker', ['info'], { timeout: 15_000 });
  if (docker.ok) term.ok('Docker', 'daemon running');
  else
    term.warn(
      docker.missing
        ? 'Docker is not installed'
        : 'Docker is installed but the daemon is not running',
    );
  const config = resolveConfig();
  for (const [name, port] of Object.entries(config.ports)) {
    const res = await http(`http://localhost:${port}`, { timeoutMs: 800 });
    term.info(
      `${name} port ${port}: ${res.status === 0 && res.error === 'ECONNREFUSED' ? 'free' : 'in use'}`,
    );
  }
}

// ---- Scenario commands ----

async function personas(flags) {
  const list = await dev('/personas');
  if (flags.json) return printJson(list);
  const term = makeTerm({ stream: process.stdout });
  out('');
  out(`  Simulated date ${list.clock.today}. Every login uses the password ${list.password}.`);
  let section = '';
  for (const p of list.personas) {
    const heading = `${p.group === 'FRESH' ? 'Fresh applicants' : 'Existing customers'}: ${p.section}`;
    if (heading !== section) {
      section = heading;
      out('');
      out(`  ${term.c.bold(heading)}`);
    }
    out(`    ${term.c.gold(p.key.padEnd(22))}${p.title.padEnd(32)}${term.c.dim(p.state.label)}`);
    out(`    ${''.padEnd(22)}${term.c.dim(p.demonstrates)}`);
    if (p.nextEvent)
      out(`    ${''.padEnd(22)}${term.c.dim(`next: ${p.nextEvent.label} on ${p.nextEvent.date}`)}`);
  }
  out('');
}

async function session(positionals, flags) {
  const key = positionals[0];
  if (!key) throw new UsageError('./dev session needs a persona key. ./dev personas lists them');
  const result = await dev(`/personas/${encodeURIComponent(key)}/session`, { method: 'POST' });
  if (flags.token) {
    process.stderr.write(
      'A local test token for sandbox data. It expires in minutes and is worth nothing elsewhere.\n',
    );
  }
  if (flags.json) {
    const { tokens, ...rest } = result;
    return printJson(flags.token ? result : { ...rest, tokens: { expiresIn: tokens.expiresIn } });
  }
  if (flags.token) return out(result.tokens.accessToken);
  out(`Signed in as ${result.persona.title} (${result.user.email}), user ${result.user.id}.`);
  out(`State: ${result.persona.state.label}. The app lands on ${result.landing.screen}.`);
  out(`For an access token to use with curl: ./dev session ${key} --token`);
}

async function clock(flags) {
  const result = await dev('/clock');
  if (flags.json) return printJson(result);
  out(
    result.aheadDays > 0
      ? `${result.today} (simulated, ${result.aheadDays} days ahead of ${result.wallToday})`
      : `${result.today} (the real date)`,
  );
}

async function advance(flags) {
  const given = ['days', 'to', 'next'].filter((k) => flags[k] !== undefined);
  if (given.length !== 1) {
    throw new UsageError(
      './dev advance needs exactly one of --days <n>, --to <YYYY-MM-DD>, --next <persona>',
    );
  }
  const body =
    flags.days !== undefined
      ? { days: Number(flags.days) }
      : flags.to !== undefined
        ? { toDate: String(flags.to) }
        : { toNextEventFor: String(flags.next) };
  const result = await dev('/clock/advance', { method: 'POST', body });
  if (flags.json) return printJson(result);
  out(
    `${result.from} to ${result.to} (${result.days} ${result.days === 1 ? 'day' : 'days'})${result.event ? `: ${result.event.label}` : ''}`,
  );
  for (const line of result.changes) out(`  ${line}`);
}

async function reset(flags) {
  if (flags.persona !== undefined) {
    const key = String(flags.persona);
    const result = await dev(`/personas/${encodeURIComponent(key)}/reset`, { method: 'POST' });
    if (flags.json) {
      const { tokens, ...rest } = result;
      return printJson({ ...rest, tokens: { expiresIn: tokens.expiresIn } });
    }
    return out(
      `Rebuilt ${result.persona.title} as a new account (${result.user.id}): ${result.persona.state.label}.`,
    );
  }
  const result = await dev('/reset', { method: 'POST' });
  if (flags.json) return printJson(result);
  out(
    `Demo data rebuilt in ${result.seconds.toFixed(1)}s. ${result.personas.length} personas. The date is ${result.clock.today}.`,
  );
}

async function smoke(flags) {
  const term = makeTerm({ stream: flags.json ? process.stderr : process.stdout });
  term.line('');
  term.line(`  ${term.c.bold('Smoke: the happy path over HTTP')}`);
  const result = await runSmoke({
    reset: Boolean(flags.reset),
    onStep: (s) => {
      if (s.ok) term.ok(s.name, `${s.detail ? `${s.detail}  ` : ''}${s.ms}ms`);
      else term.fail(`${s.name}: ${s.detail}`);
    },
  });
  if (flags.json) printJson(result);
  const failed = result.steps.find((s) => !s.ok);
  if (failed) {
    if (!flags.json && failed.response !== undefined) {
      term.line('');
      term.line('  The failing response:');
      term.line(
        JSON.stringify(failed.response, null, 2)
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
      );
    }
    term.line('');
    term.line(`  FAILED at step ${result.steps.length} of the smoke run: ${failed.name}`);
    process.exitCode = 1;
    return;
  }
  term.line('');
  term.line(`  PASSED: ${result.steps.length} steps.`);
  if (!flags.reset && result.clock.to && result.clock.to !== result.clock.from) {
    term.line(
      `  The simulated clock moved from ${result.clock.from} to ${result.clock.to}. ./dev reset puts it back.`,
    );
  }
  term.line('');
}

// ---- Entry ----

async function main() {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2), VALUED);
  if (flags.help || command === 'help') return out(HELP);
  switch (command) {
    case 'up':
      return up(flags);
    case '__supervise':
      return superviseCommand(flags);
    case 'status':
      return status(flags);
    case 'wait':
      return wait(flags);
    case 'logs':
      return logs(positionals, flags);
    case 'stop':
    case 'down':
      return stop(flags);
    case 'doctor':
      return doctor();
    case 'personas':
      return personas(flags);
    case 'session':
      return session(positionals, flags);
    case 'clock':
      return clock(flags);
    case 'advance':
      return advance(flags);
    case 'reset':
      return reset(flags);
    case 'smoke':
      return smoke(flags);
    default:
      throw new UsageError(`Unknown command "${command}". ./dev help lists them`);
  }
}

main().catch((err) => {
  const term = makeTerm();
  term.stop();
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  if (err instanceof DevError) {
    process.stderr.write(`\n  ${term.c.red('Stopped:')} ${err.message}\n`);
    if (err.fix) process.stderr.write(`\n    ${err.fix}\n`);
    process.stderr.write('\n');
    process.exit(1);
  }
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(1);
});

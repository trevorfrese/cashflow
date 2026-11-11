// One process that owns the dev servers: starts them, writes their logs, records what it
// started in .dev/state.json, serves the dev home page, and stops exactly what it started.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { startHomeServer } from './home.mjs';
import { liveState, readState } from './status.mjs';
import {
  DevError,
  LOG_DIR,
  ROOT,
  STATE_FILE,
  http,
  pidAlive,
  rel,
  sleep,
  stripAnsi,
  tailFile,
  writeJson,
} from './util.mjs';

const KILL_AFTER_MS = 6000;

function killGroup(pid, signal) {
  try {
    // Negative pid: the whole process group, so pnpm, the dev server and its workers all go.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Starts the services and stays alive until told to stop.
 *
 * `services` are definitions from `serviceDefinitions`. `reuse` lists services that are
 * already running from this checkout: they are recorded as not managed and left alone.
 * With `stream` set (a function taking a line), child output is also passed to it once
 * `startStreaming()` is called.
 */
export async function supervise({
  config,
  services,
  reuse = [],
  devTools = true,
  attached = false,
  stream = null,
}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const children = new Map();
  let streaming = false;
  let stopping = false;

  const state = {
    version: 1,
    supervisorPid: process.pid,
    startedAt: new Date().toISOString(),
    attached,
    devTools,
    root: ROOT,
    config: { ports: config.ports, urls: config.urls, database: config.database },
    services: {},
  };
  const save = () => writeJson(STATE_FILE, state);

  for (const service of services) {
    const reused = reuse.find((r) => r.name === service.name);
    if (reused) {
      state.services[service.name] = {
        pid: reused.pid,
        port: service.port,
        url: service.url,
        log: null,
        managed: false,
        status: 'running',
      };
      continue;
    }
    const log = fs.createWriteStream(service.log, { flags: 'w' });
    log.write(`==== ${service.name} started ${new Date().toISOString()} ====\n`);
    const [command, args] = service.command;
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...service.env, FORCE_COLOR: attached ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    children.set(service.name, child);
    state.services[service.name] = {
      pid: child.pid,
      port: service.port,
      url: service.url,
      log: service.log,
      managed: true,
      status: 'running',
    };
    for (const source of [child.stdout, child.stderr]) {
      readline.createInterface({ input: source }).on('line', (line) => {
        log.write(`${line}\n`);
        if (streaming && stream) stream(service, line);
      });
    }
    child.on('error', (err) => {
      log.write(`failed to start: ${String(err)}\n`);
    });
    child.on('exit', (code, signal) => {
      children.delete(service.name);
      log.end(`==== ${service.name} exited ${code ?? signal} ${new Date().toISOString()} ====\n`);
      state.services[service.name].status = 'exited';
      state.services[service.name].exitCode = code;
      if (!stopping) {
        save();
        if (stream) {
          stream(
            service,
            `exited with ${code ?? signal}. See ${rel(service.log)}. The other services keep running.`,
          );
        }
      }
    });
  }
  save();

  const home = await startHomeServer({ port: config.ports.home });

  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });

  const shutdown = async () => {
    if (stopping) return done;
    stopping = true;
    home.close();
    const pids = [...children.values()].map((c) => c.pid);
    for (const pid of pids) killGroup(pid, 'SIGTERM');
    const deadline = Date.now() + KILL_AFTER_MS;
    while (children.size > 0 && Date.now() < deadline) await sleep(100);
    for (const pid of pids) if (pidAlive(pid)) killGroup(pid, 'SIGKILL');
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      // Already removed.
    }
    finished();
    return done;
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => void shutdown());
  }

  return {
    state,
    shutdown,
    done,
    startStreaming: () => {
      streaming = true;
    },
  };
}

/** Starts the supervisor as its own background process and returns its pid. */
export function spawnDetachedSupervisor({ serviceNames, reuse, devTools, env = process.env }) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.openSync(path.join(LOG_DIR, 'supervisor.log'), 'w');
  const args = [
    path.join(ROOT, 'scripts/dev/cli.mjs'),
    '__supervise',
    '--services',
    serviceNames.join(','),
    ...(reuse.length > 0 ? ['--reuse', reuse.map((r) => `${r.name}:${r.pid}`).join(',')] : []),
    ...(devTools ? [] : ['--no-dev-tools']),
  ];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

/**
 * Waits until every service answers its health check. Throws a DevError naming the first
 * service that exited or did not come up in time, with the end of its log.
 */
export async function waitHealthy(
  services,
  { timeoutMs, onTick = () => undefined, supervisorPid = null },
) {
  const pending = new Map(services.map((s) => [s.name, s]));
  const began = Date.now();
  const failure = (service, why) => {
    const tail = tailFile(service.log, 25).map((l) => `      ${stripAnsi(l)}`);
    return new DevError(
      `${service.title} ${why}.`,
      `Its log is ${rel(service.log)}. The end of it:\n${tail.join('\n') || '      (empty)'}`,
    );
  };
  while (pending.size > 0) {
    for (const service of [...pending.values()]) {
      const res = await http(service.health, { timeoutMs: 2500 });
      if (res.status >= 200 && res.status < 400) pending.delete(service.name);
    }
    if (pending.size === 0) break;
    const state = readState();
    for (const service of pending.values()) {
      const entry = state?.services?.[service.name];
      if (entry?.status === 'exited') {
        throw failure(
          service,
          `exited with code ${entry.exitCode ?? 'unknown'} before it was healthy`,
        );
      }
    }
    if (supervisorPid && !pidAlive(supervisorPid)) {
      throw new DevError(
        'The supervisor process stopped before the services were healthy.',
        `See ${rel(path.join(LOG_DIR, 'supervisor.log'))}.`,
      );
    }
    if (Date.now() - began > timeoutMs) {
      const service = [...pending.values()][0];
      throw failure(
        service,
        `was not healthy at ${service.health} after ${Math.round(timeoutMs / 1000)}s`,
      );
    }
    onTick([...pending.keys()]);
    await sleep(500);
  }
  return Date.now() - began;
}

/** Stops a running supervisor and everything it started. Returns what it did. */
export async function stopSupervisor() {
  const state = readState();
  if (!state) return { stopped: false, reason: 'nothing is running (no .dev/state.json)' };
  const managed = Object.entries(state.services ?? {})
    .filter(([, s]) => s.managed)
    .map(([name, s]) => ({ name, pid: s.pid }));
  const left = Object.entries(state.services ?? {})
    .filter(([, s]) => !s.managed)
    .map(([name]) => name);
  if (pidAlive(state.supervisorPid)) {
    process.kill(state.supervisorPid, 'SIGTERM');
    const deadline = Date.now() + KILL_AFTER_MS + 4000;
    while (pidAlive(state.supervisorPid) && Date.now() < deadline) await sleep(150);
  }
  // The supervisor crashed, or did not finish in time: stop its children directly.
  for (const { pid } of managed) {
    if (pidAlive(pid)) killGroup(pid, 'SIGTERM');
  }
  await sleep(managed.some(({ pid }) => pidAlive(pid)) ? 1500 : 0);
  for (const { pid } of managed) {
    if (pidAlive(pid)) killGroup(pid, 'SIGKILL');
  }
  if (pidAlive(state.supervisorPid)) {
    try {
      process.kill(state.supervisorPid, 'SIGKILL');
    } catch {
      // Gone.
    }
  }
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // Removed by the supervisor on its way out.
  }
  return { stopped: true, services: managed.map((m) => m.name), left };
}

export { liveState };

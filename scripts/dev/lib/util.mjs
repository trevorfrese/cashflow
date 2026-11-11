// Small helpers for the dev CLI. Node built-ins only: this runs before `pnpm install`.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEV_DIR = path.join(ROOT, '.dev');
export const LOG_DIR = path.join(DEV_DIR, 'logs');
export const STATE_FILE = path.join(DEV_DIR, 'state.json');
export const CACHE_FILE = path.join(DEV_DIR, 'cache.json');

/** A path shown to a person: relative to the repo root. */
export const rel = (p) => path.relative(ROOT, p) || '.';

// ---- Arguments ----

/**
 * Parses `argv` into a command, positionals and flags. `--flag value`, `--flag=value` and
 * bare `--flag` (true) are accepted. `valued` lists the flags that take a value.
 */
export function parseArgs(argv, valued = []) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') flags.help = true;
    else if (arg === '-d') flags.detach = true;
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) flags[name] = arg.slice(eq + 1);
      else if (valued.includes(name)) {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError(`--${name} needs a value`);
        }
        flags[name] = value;
        i += 1;
      } else flags[name] = true;
    } else positionals.push(arg);
  }
  return { command: positionals[0] ?? 'up', positionals: positionals.slice(1), flags };
}

/** A mistake in how the command was called. Printed without a stack, exit code 2. */
export class UsageError extends Error {}

/** Something the developer has to fix. `fix` says how. Printed without a stack, exit code 1. */
export class DevError extends Error {
  constructor(message, fix) {
    super(message);
    this.fix = fix;
  }
}

// ---- Terminal ----

export function makeTerm({ stream = process.stderr, color } = {}) {
  const tty = Boolean(stream.isTTY);
  const useColor = color ?? (tty && !process.env.NO_COLOR && process.env.TERM !== 'dumb');
  const wrap = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  const c = {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('34'),
    magenta: wrap('35'),
    cyan: wrap('36'),
    gold: wrap('38;5;214'),
  };
  const write = (text) => stream.write(text);
  const mark = {
    ok: useColor ? c.green('✓') : '[ok]',
    fail: useColor ? c.red('✗') : '[fail]',
    warn: useColor ? c.yellow('!') : '[warn]',
    info: useColor ? c.dim('·') : '[..]',
  };
  let spinner = null;

  const stopSpinner = () => {
    if (!spinner) return;
    clearInterval(spinner.timer);
    write('\r\x1b[2K');
    spinner = null;
  };

  return {
    tty,
    useColor,
    c,
    line: (text = '') => {
      stopSpinner();
      write(`${text}\n`);
    },
    ok: (text, detail) => {
      stopSpinner();
      write(`  ${mark.ok} ${text}${detail ? c.dim(`  ${detail}`) : ''}\n`);
    },
    warn: (text) => {
      stopSpinner();
      write(`  ${mark.warn} ${text}\n`);
    },
    fail: (text) => {
      stopSpinner();
      write(`  ${mark.fail} ${text}\n`);
    },
    info: (text) => {
      stopSpinner();
      write(`  ${mark.info} ${text}\n`);
    },
    /**
     * Show work in progress. A spinner on a terminal, one plain line otherwise. Ends when
     * the next line is printed.
     */
    start: (text) => {
      stopSpinner();
      if (!tty || !useColor) {
        write(`  ${mark.info} ${text}\n`);
        return;
      }
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      const began = Date.now();
      let i = 0;
      const draw = () => {
        const secs = Math.floor((Date.now() - began) / 1000);
        write(
          `\r\x1b[2K  ${c.gold(frames[i++ % frames.length])} ${text}${secs >= 2 ? c.dim(`  ${secs}s`) : ''}`,
        );
      };
      draw();
      spinner = { timer: setInterval(draw, 90) };
      spinner.timer.unref?.();
    },
    stop: stopSpinner,
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (text) => text.replace(ANSI, '');

export const seconds = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

// ---- .env files ----

/** KEY=value lines to an object. Comments and blank lines are skipped. Quotes are removed. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

export function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Returns `text` with each KEY in `values` set: an existing `KEY=` line is replaced in
 * place (comments above it stay), a missing key is appended.
 */
export function setEnvValues(text, values) {
  const lines = text.split('\n');
  const pending = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && pending.has(m[1])) {
      const value = pending.get(m[1]);
      pending.delete(m[1]);
      return `${m[1]}=${value}`;
    }
    return line;
  });
  if (pending.size > 0) {
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    for (const [key, value] of pending) out.push(`${key}=${value}`);
    out.push('');
  }
  return out.join('\n');
}

/** A random secret. Never printed: callers say that it exists and where. */
export const secret = (bytes = 32) => randomBytes(bytes).toString('hex');

// ---- Files and hashes ----

export const exists = (p) => fs.existsSync(p);

export function fileHash(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The last `count` lines of a file. Reads at most the final 256 KB. */
export function tailFile(file, count) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-count);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---- Processes ----

/** Runs a command to completion and returns its output. Never throws. */
export function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeout,
  });
  return {
    ok: res.status === 0 && !res.error,
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    missing: res.error?.code === 'ENOENT',
  };
}

/**
 * Runs a command without blocking the event loop (so a spinner keeps turning). Its output
 * goes to `logFile`. Resolves with whether it exited 0.
 */
export function runLogged(command, args, { cwd = ROOT, env = process.env, logFile }) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n$ ${command} ${args.join(' ')}\n`);
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', out, out] });
    child.on('error', (err) => {
      fs.writeSync(out, `${String(err)}\n`);
      fs.closeSync(out);
      resolve({ ok: false, code: null });
    });
    child.on('close', (code) => {
      fs.closeSync(out);
      resolve({ ok: code === 0, code });
    });
  });
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Ports ----

/** True when something accepts TCP connections on the port. */
export function portOpen(port, host = '127.0.0.1', timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Listening on either loopback family. Dev servers bind `::`, `0.0.0.0` or `localhost`. */
export async function portInUse(port) {
  return (await portOpen(port, '127.0.0.1')) || (await portOpen(port, '::1'));
}

/**
 * Who is listening on a port: `{ pid, command, cwd }` or null when that cannot be told
 * (no lsof, or the process belongs to another user).
 */
export function portOwner(port) {
  const pids = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  if (!pids.ok) return null;
  const pid = Number(pids.stdout.trim().split('\n')[0]);
  if (!pid) return null;
  let cwd = null;
  try {
    cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    const res = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const line = res.stdout.split('\n').find((l) => l.startsWith('n'));
    if (line) cwd = line.slice(1);
  }
  const ps = run('ps', ['-p', String(pid), '-o', 'command=']);
  return { pid, cwd, command: ps.stdout.trim().slice(0, 120) };
}

/** True when `dir` is the repo root or inside it. */
export function insideRepo(dir) {
  if (!dir) return false;
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    // Keep the path as given.
  }
  const root = fs.realpathSync(ROOT);
  return real === root || real.startsWith(`${root}${path.sep}`);
}

// ---- HTTP ----

/** GET or POST with a timeout. Returns `{ ok, status, body, text }`. Never throws. */
export async function http(url, { method = 'GET', body, headers = {}, timeoutMs = 4000 } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON. `text` has it.
    }
    return { ok: res.ok, status: res.status, body: json, text };
  } catch (err) {
    return { ok: false, status: 0, body: null, text: '', error: err.cause?.code ?? err.name };
  }
}

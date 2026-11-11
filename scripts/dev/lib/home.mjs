// The dev home page: one local page that shows the running system at a glance.
//
// It is served by the supervisor, not by the ops console or the API, because it has to
// work when those are down (that is when you most want it), it tails log files only the
// supervisor knows about, and a page that ships with no deployable app cannot end up in
// production. It listens on 127.0.0.1 only, needs no sign in, and never sees an operator
// token: what it shows comes from this script and from the API's /v1/dev routes, which
// exist only with ENABLE_DEV_TOOLS=true.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVICE_NAMES } from './config.mjs';
import { collectStatus, DEV_MENU_HINT, liveState } from './status.mjs';
import { LOG_DIR, stripAnsi, tailFile } from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, '../home.html');
const PHONE_PAGE = path.join(HERE, '../phone.html');
const BRAND = path.join(HERE, '../../../packages/shared/src/brand.ts');
const FONT_DIR = path.join(HERE, '../../../apps/mobile/assets/fonts');
const FONTS = [
  'Archivo-Regular.ttf',
  'Archivo-Medium.ttf',
  'Archivo-Bold.ttf',
  'ArchivoExpanded-ExtraBold.ttf',
  'ArchivoExpanded-Black.ttf',
];

/**
 * The brand colors as CSS custom properties, read from the shared tokens so the page never
 * carries its own copy of a hex value.
 */
export function brandCss(source = fs.readFileSync(BRAND, 'utf8')) {
  const vars = [...source.matchAll(/^\s{4}(\w+): '(#[0-9A-Fa-f]{6})',/gm)].map(
    ([, name, hex]) => `--${name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}: ${hex};`,
  );
  return `:root { ${vars.join(' ')} }`;
}
const LOG_NAMES = [...SERVICE_NAMES, 'setup', 'supervisor'];

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

/** Only this machine's browser, asking for this page by a local name. */
function localRequest(req) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  return ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function handleHomeRequest(req, res) {
  if (!localRequest(req))
    return json(res, 403, { error: 'The dev home page only answers on localhost' });
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(PAGE, 'utf8').replace('/*BRAND_TOKENS*/', brandCss()));
  }
  if (req.method === 'GET' && url.pathname === '/phone') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(PHONE_PAGE, 'utf8').replace('/*BRAND_TOKENS*/', brandCss()));
  }
  if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
    const name = url.pathname.slice('/fonts/'.length);
    if (!FONTS.includes(name)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'max-age=86400' });
    return res.end(fs.readFileSync(path.join(FONT_DIR, name)));
  }
  if (req.method === 'GET' && url.pathname === '/api/ping') return json(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return json(res, 200, { ...(await collectStatus()), menuHint: DEV_MENU_HINT });
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const name = url.searchParams.get('service') ?? '';
    if (!LOG_NAMES.includes(name)) return json(res, 404, { error: `No log called "${name}"` });
    const lines = Math.min(400, Math.max(1, Number(url.searchParams.get('lines')) || 80));
    return json(res, 200, {
      service: name,
      lines: tailFile(path.join(LOG_DIR, `${name}.log`), lines).map(stripAnsi),
    });
  }
  // The API's dev routes, relayed, so the page needs no CORS and holds no API address.
  if (url.pathname.startsWith('/api/dev/')) {
    const state = liveState();
    if (!state) return json(res, 503, { error: 'The supervisor state is missing' });
    // A custom header cannot be sent by a plain form on another site, so a page you happen
    // to have open elsewhere cannot reset your data through this relay.
    if (req.method !== 'GET' && req.headers['x-cashflow-dev'] !== '1') {
      return json(res, 403, { error: 'Missing X-CashFlow-Dev header' });
    }
    const target = `${state.config.urls.api}/v1/dev/${url.pathname.slice('/api/dev/'.length)}`;
    try {
      const body = req.method === 'GET' ? undefined : await readBody(req);
      const upstream = await fetch(target, {
        method: req.method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body || undefined,
        signal: AbortSignal.timeout(120_000),
      });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      });
      return res.end(await upstream.text());
    } catch {
      return json(res, 502, { error: 'The API is not reachable' });
    }
  }
  return json(res, 404, { error: 'Not found' });
}

export function startHomeServer({ port }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleHomeRequest(req, res).catch((err) =>
        json(res, 500, { error: String(err.message ?? err) }),
      );
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

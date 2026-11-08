import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { createDownloads } from './downloads.js';
import { pickPaths, pickerSupported } from './picker.js';
import { isAllowedHost, isLocalAddress } from './net.js';
import { HttpError, readBody } from './util.js';
import { log } from './log.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function createHandler({ session, root }) {
  const publicDir = path.join(root, 'public');
  const fontDir = (pkg) => path.join(root, 'node_modules', '@fontsource-variable', pkg, 'files');
  const FONTS = {
    'inter-latin.woff2': path.join(fontDir('inter'), 'inter-latin-wght-normal.woff2'),
    'inter-latin-ext.woff2': path.join(fontDir('inter'), 'inter-latin-ext-wght-normal.woff2'),
    'space-grotesk-latin.woff2': path.join(fontDir('space-grotesk'), 'space-grotesk-latin-wght-normal.woff2'),
    'space-grotesk-latin-ext.woff2': path.join(fontDir('space-grotesk'), 'space-grotesk-latin-ext-wght-normal.woff2'),
  };
  const STATIC = new Set(['/index.html', '/styles.css', '/app.js', '/favicon.svg']);
  const downloads = createDownloads(session);
  const qrCache = new Map();

  async function serveFile(req, res, file, { cache = 'no-cache', csp = false } = {}) {
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      return notFound(res);
    }
    const etag = `"${st.size.toString(36)}-${Math.trunc(st.mtimeMs).toString(36)}"`;
    const headers = {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': cache,
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (csp) headers['Content-Security-Policy'] = CSP;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers['Content-Length'] = String(st.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function qr(req, res, url) {
    const text = url.searchParams.get('u') || '';
    if (!/^https?:\/\/[^\s]{1,200}$/.test(text)) return notFound(res);
    let svg = qrCache.get(text);
    if (!svg) {
      svg = await QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#141413ff', light: '#00000000' } });
      if (qrCache.size > 32) qrCache.clear();
      qrCache.set(text, svg);
    }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(svg);
  }

  /** POST /api/pick — open the host's own file dialog. Host only. */
  async function pick(req, res) {
    if (!isLocalAddress(req.socket.remoteAddress)) throw new HttpError(403, 'Only the host PC can do that.');
    if (req.headers['x-ferry'] !== '1') throw new HttpError(403, 'Missing header.');
    let body = {};
    try {
      body = JSON.parse((await readBody(req, 1024)) || '{}');
    } catch {}
    if (!pickerSupported) return json(res, 200, { unsupported: true });
    let paths;
    try {
      paths = await pickPaths(body.type === 'folder' ? 'folder' : 'files');
    } catch (e) {
      if (e.code === 'BUSY') return json(res, 200, { error: e.message });
      log.warn('Native file dialog failed:', String(e.stderr || e.message).split(/\r?\n/)[0]);
      return json(res, 200, { unsupported: true });
    }
    if (!paths.length) return json(res, 200, { canceled: true });
    const added = await session.addDiskPaths(paths);
    json(res, 200, { added: added.length, duplicates: paths.length - added.length });
  }

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://ferry.local');
    } catch {
      return notFound(res);
    }
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Open Ferry using the IP address of the host PC.');
    }
    const p = url.pathname;
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (p === '/') return await serveFile(req, res, path.join(publicDir, 'index.html'), { csp: true });
        if (STATIC.has(p)) return await serveFile(req, res, path.join(publicDir, p.slice(1)), { csp: p === '/index.html' });
        if (p.startsWith('/fonts/') && FONTS[p.slice(7)]) {
          return await serveFile(req, res, FONTS[p.slice(7)], { cache: 'public, max-age=31536000, immutable' });
        }
        if (p === '/qr.svg') return await qr(req, res, url);
        if (p.startsWith('/dl/')) return await downloads.single(req, res, decodeURIComponent(p.slice(4)), url);
        if (p === '/zip') return await downloads.multi(req, res, url);
      } else if (req.method === 'POST') {
        if (p.startsWith('/relay/')) return downloads.relay(req, res, p.slice(7));
        if (p === '/api/pick') return await pick(req, res);
        if (p === '/api/bye') {
          const tabId = (await readBody(req, 256)).trim();
          session.bye(tabId, req.socket.remoteAddress);
          res.writeHead(204);
          return res.end();
        }
      }
      notFound(res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) log.warn('Request failed:', p, e.message);
      if (!res.headersSent) json(res, status, { error: e.message });
      else res.destroy();
    }
  };
}

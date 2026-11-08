#!/usr/bin/env node
/**
 * Ferry — instant file sharing on your local network.
 *
 *   node server/index.js [--port 8080] [--name "Desktop-PC"] [--no-open] [paths to share…]
 *
 * Paths given on the command line (or dropped onto start.bat) are shared from disk right away.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { Session } from './session.js';
import { createHandler } from './app.js';
import { lanAddresses, refreshRouteAddress, isLocalAddress, isAllowedHost, normIp } from './net.js';
import { pickerSupported, warmUpPicker } from './picker.js';
import { log, color } from './log.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { port: Number(process.env.PORT) || 8080, name: '', open: true, share: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--name') opts.name = argv[++i] || '';
    else if (a.startsWith('--name=')) opts.name = a.slice(7);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node server/index.js [--port 8080] [--name "My PC"] [--no-open] [paths to share…]');
      process.exit(0);
    } else if (!a.startsWith('--')) opts.share.push(a);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) opts.port = 8080;
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
// Development aid: treat browsers on this PC as remote devices, to preview what a phone sees.
const DEBUG_REMOTE = process.env.FERRY_DEBUG_REMOTE === '1';
let port = opts.port;
let pickerReady = pickerSupported;

const getUrls = () => lanAddresses().map((a) => `http://${a.address}:${port}`);

const session = new Session({
  hostName: opts.name.trim() || os.hostname(),
  getUrls,
  nativePicker: () => pickerReady,
});

const server = http.createServer(
  { requestTimeout: 0, headersTimeout: 60_000, keepAliveTimeout: 10_000 }, // multi-GB relays must not time out
  createHandler({ session, root: ROOT }),
);
server.timeout = 0;

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://ferry.local');
  // Reject cross-site WebSocket hijacking: the page must come from this server.
  const origin = req.headers.origin;
  let sameOrigin = true;
  if (origin) {
    try {
      sameOrigin = new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
  }
  if (url.pathname !== '/ws' || !sameOrigin || !isAllowedHost(req.headers.host)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const ip = normIp(req.socket.remoteAddress);
    session.attach(ws, { ip, isHost: !DEBUG_REMOTE && isLocalAddress(ip) });
  });
});

const heartbeat = setInterval(() => session.heartbeat(), 20_000);

function listen(tries = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < 20) {
      port += 1;
      listen(tries + 1);
    } else {
      console.error(`Could not start Ferry: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0', onListening);
}

async function onListening() {
  await refreshRouteAddress();
  const addrs = lanAddresses();
  const primary = addrs[0] ? `http://${addrs[0].address}:${port}` : null;
  const local = `http://localhost:${port}`;

  console.log();
  console.log(`  ${color.orange('■')} ${color.bold('Ferry')} ${color.dim('— instant file sharing on your network')}`);
  console.log();
  if (primary) {
    console.log(`  Open on any device on this network:`);
    addrs.forEach((a, i) => {
      const url = `http://${a.address}:${port}`;
      const note = a.virtual ? color.dim(`  (${a.name})`) : '';
      console.log(i === 0 ? `    ${color.orange('→')} ${color.bold(url)}${note}` : `      ${color.dim(url)}${note}`);
    });
    if (process.stdout.isTTY) {
      try {
        const qr = await QRCode.toString(primary, { type: 'terminal', small: true, margin: 1 });
        console.log('\n' + qr.replace(/^/gm, '    '));
      } catch {}
    } else {
      console.log();
    }
  } else {
    console.log(`  ${color.orange('!')} No network connection found — only this PC can open Ferry right now.`);
    console.log();
  }
  console.log(`  On this PC: ${color.bold(local)}`);
  console.log(color.dim('  The share list lives in memory only and is cleared when Ferry stops.'));
  if (process.platform === 'win32') {
    console.log(color.dim('  If other devices can’t connect, allow Node.js on Private networks in Windows Firewall.'));
  }
  console.log(color.dim('  Close this window or press Ctrl+C to stop.'));
  console.log();

  if (opts.share.length) {
    const added = await session.addDiskPaths(opts.share);
    if (added.length < opts.share.length) log.warn(`${opts.share.length - added.length} path(s) could not be shared.`);
  }

  if (process.platform === 'win32') {
    warmUpPicker().then((r) => {
      pickerReady = r.ok;
      if (!r.ok) log.warn('System file dialog unavailable; the browser picker will be used.', color.dim(r.detail || ''));
    });
  }

  if (opts.open) openBrowser(local);
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]; // '' = window title for start
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  console.log();
  log.info('Stopping — the share list has been cleared.');
  clearInterval(heartbeat);
  session.close();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop); // console window closed (Windows) / terminal hung up

listen();

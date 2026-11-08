/**
 * The live session. Everything lives in memory: devices, shares and transfers vanish
 * when the host stops, and the next launch starts with an empty list.
 *
 * Every change is pushed to every connected tab over WebSocket immediately — no polling.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { rid, cleanName, cleanRelPath, cleanLabel, safeInt, HttpError, formatBytes } from './util.js';
import { walk, displayName, MAX_FOLDER_FILES } from './fsutil.js';
import { normIp } from './net.js';
import { log, color } from './log.js';

const OFFLINE_TTL = 30 * 60 * 1000; // forget a vanished tab (and its shares) after 30 min
const PART_TIMEOUT = 30 * 1000; // a sharing tab must start sending within 30 s
const HISTORY = 100; // finished transfers kept for the Activity tab
const KINDS = new Set(['computer', 'phone', 'tablet']);
const ID = /^[A-Za-z0-9_-]{6,64}$/;

export class Session {
  constructor({ hostName, getUrls, nativePicker }) {
    this.id = rid(9);
    this.startedAt = Date.now();
    this.getUrls = getUrls;
    this.nativePicker = nativePicker;
    this.devices = new Map(); // key -> { key, name, defaultName, customName, kind, isHost, lastSeen }
    this.tabs = new Map(); // tabId -> { tabId, deviceKey, conn, ip, purgeTimer }
    this.conns = new Set();
    this.shares = new Map();
    this.transfers = new Map();
    this.parts = new Map(); // pending relay uploads: partId -> { resolve, reject, timer, tabId, ip }
    this.ticker = null;
    this.pending = { state: false, transfers: false };
    this.devices.set('host', {
      key: 'host',
      name: hostName,
      defaultName: hostName,
      customName: false,
      kind: 'computer',
      isHost: true,
      lastSeen: Date.now(),
    });
  }

  get host() {
    return this.devices.get('host');
  }

  // ───────────────────────── connections ─────────────────────────

  attach(ws, { ip, isHost }) {
    const conn = { id: rid(6), ws, ip, isHost, tabId: null, deviceKey: null, alive: true };
    conn.send = (msg) => {
      if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    };
    this.conns.add(conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        this.onMessage(conn, msg);
      } catch (e) {
        log.warn('Bad message:', e.message);
      }
    });
    ws.on('close', () => this.detach(conn));
    ws.on('error', () => {});
    conn.send({
      type: 'welcome',
      sessionId: this.id,
      startedAt: this.startedAt,
      serverTime: Date.now(),
      isHost,
      hostName: this.host.name,
      urls: this.getUrls(),
      nativePicker: isHost && this.nativePicker(),
    });
  }

  /** Server-side heartbeat; drops phones that vanished from Wi-Fi without closing. */
  heartbeat() {
    for (const conn of this.conns) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {}
    }
  }

  onMessage(conn, m) {
    if (m.type === 'hello') return this.onHello(conn, m);
    if (!conn.tabId) return;
    switch (m.type) {
      case 'share':
        return this.onShare(conn, m);
      case 'unshare':
        return this.onUnshare(conn, m);
      case 'rename':
        return this.onRename(conn, m);
      case 'cancel':
        return this.cancelTransfer(m.id, conn);
      case 'upload-error':
        return this.onUploadError(conn, m);
    }
  }

  onHello(conn, m) {
    if (conn.tabId) return;
    const tabId = typeof m.tabId === 'string' && ID.test(m.tabId) ? m.tabId : null;
    const deviceId = typeof m.deviceId === 'string' && ID.test(m.deviceId) ? m.deviceId : null;
    if (!tabId || !deviceId) return conn.ws.close(1008, 'Bad hello');
    // The raw device id never leaves the server; others only see this hash.
    const deviceKey = conn.isHost ? 'host' : 'd' + crypto.createHash('sha256').update(deviceId).digest('base64url').slice(0, 16);

    let tab = this.tabs.get(tabId);
    if (tab && tab.deviceKey !== deviceKey) return conn.ws.close(1008, 'Tab conflict');
    if (tab?.conn && tab.conn !== conn) {
      const old = tab.conn;
      tab.conn = null;
      old.ws.close(4000, 'Replaced');
    }
    if (!tab) {
      tab = { tabId, deviceKey, conn: null, ip: conn.ip, purgeTimer: null };
      this.tabs.set(tabId, tab);
    }
    clearTimeout(tab.purgeTimer);
    tab.purgeTimer = null;
    tab.conn = conn;
    tab.ip = conn.ip;
    conn.tabId = tabId;
    conn.deviceKey = deviceKey;

    const custom = cleanLabel(m.name);
    const fallback = cleanLabel(m.defaultName) || 'Device';
    let dev = this.devices.get(deviceKey);
    if (!dev) {
      dev = { key: deviceKey, name: custom || fallback, defaultName: fallback, customName: !!custom, kind: 'computer', isHost: false, lastSeen: 0 };
      this.devices.set(deviceKey, dev);
    } else if (custom) {
      dev.name = custom;
      dev.customName = true;
    } else if (!dev.customName && !dev.isHost) {
      dev.name = fallback;
    }
    if (!dev.isHost) {
      dev.kind = KINDS.has(m.kind) ? m.kind : 'computer';
      dev.defaultName = fallback;
    }
    const wasOffline = Date.now() - dev.lastSeen > 2000 && !this.isOnline(dev, conn);
    dev.lastSeen = Date.now();
    if (!dev.isHost && wasOffline) log.info(`${color.green('●')} ${dev.name} joined ${color.dim(`(${conn.ip})`)}`);

    // The tab is the source of truth for the files it holds: after a reload it holds
    // none, after a brief disconnect it still holds them all.
    const keep = new Set();
    for (const raw of (Array.isArray(m.shares) ? m.shares : []).slice(0, 5000)) {
      const s = this.cleanBrowserShare(raw, tab);
      if (s) {
        keep.add(s.id);
        this.upsertShare(s, true);
      }
    }
    for (const s of [...this.shares.values()]) {
      if (s.ownerTab === tabId && !keep.has(s.id)) this.removeShare(s.id, true);
    }

    conn.send({ type: 'ready', deviceKey, tabId });
    conn.send(this.transfersMessage());
    this.scheduleState();
  }

  detach(conn) {
    this.conns.delete(conn);
    if (!conn.tabId) return;
    const tab = this.tabs.get(conn.tabId);
    if (!tab || tab.conn !== conn) return;
    tab.conn = null;
    for (const [partId, p] of this.parts) {
      if (p.tabId === tab.tabId) {
        this.parts.delete(partId);
        clearTimeout(p.timer);
        p.reject(new HttpError(503, 'The sharing device went offline.'));
      }
    }
    const dev = this.devices.get(tab.deviceKey);
    if (dev) {
      dev.lastSeen = Date.now();
      if (!this.isOnline(dev)) log.info(`${color.dim('○')} ${dev.name} left`);
    }
    tab.purgeTimer = setTimeout(() => this.purgeTab(tab.tabId), OFFLINE_TTL);
    tab.purgeTimer.unref?.();
    this.scheduleState();
  }

  purgeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    clearTimeout(tab.purgeTimer);
    this.tabs.delete(tabId);
    for (const s of [...this.shares.values()]) if (s.ownerTab === tabId) this.removeShare(s.id, true);
    const dev = this.devices.get(tab.deviceKey);
    if (dev && !dev.isHost && ![...this.tabs.values()].some((t) => t.deviceKey === dev.key)) {
      this.devices.delete(dev.key);
    }
    this.scheduleState();
  }

  /** The tab is closing for good (sendBeacon on pagehide): its files are gone now. */
  bye(tabId, ip) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.ip !== normIp(ip)) return;
    let removed = 0;
    for (const s of [...this.shares.values()]) {
      if (s.ownerTab === tabId) {
        this.removeShare(s.id, true);
        removed++;
      }
    }
    if (removed) this.scheduleState();
  }

  isOnline(dev, ignoreConn) {
    if (dev.isHost) return true;
    for (const t of this.tabs.values()) if (t.deviceKey === dev.key && t.conn && t.conn !== ignoreConn) return true;
    return false;
  }

  isAvailable(share) {
    return share.source === 'disk' || !!this.tabs.get(share.ownerTab)?.conn;
  }

  deviceName(key) {
    return this.devices.get(key)?.name || 'A device';
  }

  /** Why a browser-held share can't be fetched right now, in plain words. */
  unavailableReason(share) {
    const dev = this.devices.get(share.deviceKey);
    if (dev && this.isOnline(dev)) return `The ${dev.name} tab that shared “${share.name}” was closed.`;
    return `${this.deviceName(share.deviceKey)} is offline, so “${share.name}” can't be downloaded right now.`;
  }

  // ───────────────────────── shares ─────────────────────────

  cleanBrowserShare(raw, tab) {
    const id = typeof raw?.id === 'string' && ID.test(raw.id) ? raw.id : null;
    if (!id) return null;
    const existing = this.shares.get(id);
    if (existing && existing.ownerTab !== tab.tabId) return null;
    const kind = raw.kind === 'folder' ? 'folder' : 'file';
    const lastModified = Number.isFinite(raw.lastModified) ? raw.lastModified : Date.now();
    const base = {
      id,
      deviceKey: tab.deviceKey,
      ownerTab: tab.tabId,
      source: 'browser',
      kind,
      name: cleanName(raw.name, kind === 'folder' ? 'Folder' : 'file'),
      mime: typeof raw.mime === 'string' ? raw.mime.slice(0, 120) : '',
      lastModified,
      addedAt: existing?.addedAt ?? Date.now(),
    };
    if (kind === 'file') {
      const size = safeInt(raw.size);
      return size === null ? null : { ...base, size, count: 1 };
    }
    const list = Array.isArray(raw.files) ? raw.files : [];
    if (!list.length || list.length > MAX_FOLDER_FILES) return null;
    const files = [];
    let size = 0;
    for (const f of list) {
      const p = cleanRelPath(f?.path);
      const sz = safeInt(f?.size);
      if (!p || sz === null) return null; // keep indexes aligned with the tab's File list
      files.push({ path: p, size: sz, mtime: Number.isFinite(f.lastModified) ? f.lastModified : lastModified });
      size += sz;
    }
    return { ...base, size, count: files.length, files };
  }

  upsertShare(share, quiet = false) {
    const isNew = !this.shares.has(share.id);
    this.shares.set(share.id, share);
    if (isNew) {
      const what = share.kind === 'folder' ? `${share.name}/ (${share.count.toLocaleString()} files)` : share.name;
      log.info(`${color.orange('+')} ${this.deviceName(share.deviceKey)} shared ${what} ${color.dim(formatBytes(share.size))}`);
    }
    if (!quiet) this.scheduleState();
  }

  removeShare(id, quiet = false) {
    const share = this.shares.get(id);
    if (!share) return;
    this.shares.delete(id);
    for (const t of this.transfers.values()) {
      if (t.status === 'active' && t.shareIds.includes(id)) {
        t.cancelRequested = true;
        t.abort?.();
      }
    }
    log.info(`${color.dim('−')} ${share.name} ${color.dim('no longer shared')}`);
    if (!quiet) this.scheduleState();
  }

  onShare(conn, m) {
    const tab = this.tabs.get(conn.tabId);
    if (!tab) return;
    for (const raw of (Array.isArray(m.shares) ? m.shares : []).slice(0, 5000)) {
      const s = this.cleanBrowserShare(raw, tab);
      if (s) this.upsertShare(s, true);
    }
    this.scheduleState();
  }

  onUnshare(conn, m) {
    const ids = Array.isArray(m.ids) ? m.ids.slice(0, 5000) : [];
    for (const id of ids) {
      const s = this.shares.get(id);
      if (s && s.deviceKey === conn.deviceKey) this.removeShare(id, true);
    }
    this.scheduleState();
  }

  onRename(conn, m) {
    const dev = this.devices.get(conn.deviceKey);
    if (!dev) return;
    const name = cleanLabel(m.name);
    dev.name = name || dev.defaultName;
    dev.customName = !!name;
    this.scheduleState();
  }

  /** Share paths picked on the host: they are served straight from disk. */
  async addDiskPaths(paths) {
    const added = [];
    for (const p of paths) {
      const abs = path.resolve(p);
      if ([...this.shares.values()].some((s) => s.source === 'disk' && s.path === abs)) continue;
      let st;
      try {
        st = await fsp.stat(abs);
      } catch {
        continue;
      }
      const base = {
        id: rid(9),
        deviceKey: 'host',
        ownerTab: null,
        source: 'disk',
        path: abs,
        name: cleanName(displayName(abs)),
        mime: '',
        lastModified: st.mtimeMs,
        addedAt: Date.now(),
      };
      if (st.isFile()) {
        added.push({ ...base, kind: 'file', size: st.size, count: 1 });
      } else if (st.isDirectory()) {
        const { files, size } = await walk(abs);
        added.push({ ...base, kind: 'folder', size, count: files.length });
      }
    }
    for (const s of added) this.upsertShare(s, true);
    if (added.length) this.scheduleState();
    return added;
  }

  // ───────────────────────── relay ─────────────────────────

  /**
   * Ask the tab holding `share` to stream its bytes to /relay/<partId>.
   * Resolves with the incoming upload { req, res } once the tab starts sending.
   */
  requestPart(share, fileIndex = null, start = null, end = null) {
    const tab = this.tabs.get(share.ownerTab);
    const conn = tab?.conn;
    if (!conn) {
      const promise = Promise.reject(new HttpError(503, this.unavailableReason(share)));
      promise.catch(() => {});
      return { promise, cancel() {} };
    }
    const partId = rid(16);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.parts.delete(partId);
        reject(new HttpError(504, `${this.deviceName(share.deviceKey)} didn't respond. Is the Ferry tab still open there?`));
      }, PART_TIMEOUT);
      this.parts.set(partId, { resolve, reject, timer, tabId: tab.tabId, ip: conn.ip });
    });
    promise.catch(() => {});
    conn.send({ type: 'upload-request', partId, shareId: share.id, fileIndex, start, end });
    const cancel = () => {
      const p = this.parts.get(partId);
      if (p) {
        this.parts.delete(partId);
        clearTimeout(p.timer);
        p.reject(new HttpError(499, 'Canceled.'));
      }
      conn.send({ type: 'upload-cancel', partId });
    };
    return { promise, cancel, partId };
  }

  /** Called for POST /relay/<partId>. */
  acceptPart(partId, req, res) {
    const p = this.parts.get(partId);
    if (!p) return 'missing';
    if (normIp(req.socket.remoteAddress) !== p.ip) return 'forbidden';
    this.parts.delete(partId);
    clearTimeout(p.timer);
    p.resolve({ req, res });
    return 'ok';
  }

  onUploadError(conn, m) {
    const p = this.parts.get(m.partId);
    if (!p || p.tabId !== conn.tabId) return;
    this.parts.delete(m.partId);
    clearTimeout(p.timer);
    p.reject(new HttpError(502, cleanLabel(m.message, 200) || 'The sharing device could not read the file.'));
  }

  // ───────────────────────── transfers ─────────────────────────

  /** Who is downloading: the tab id from ?t=, else best guess by IP. */
  identify(tabId, req) {
    const tab = typeof tabId === 'string' ? this.tabs.get(tabId) : null;
    if (tab) return { key: tab.deviceKey, name: this.deviceName(tab.deviceKey), tabId: tab.tabId };
    const ip = normIp(req.socket.remoteAddress);
    for (const c of this.conns) {
      if (c.ip === ip && c.deviceKey) return { key: c.deviceKey, name: this.deviceName(c.deviceKey), tabId: c.tabId };
    }
    return { key: null, name: ip, tabId: null };
  }

  notify(tabId, text, level = 'error') {
    const conn = tabId && this.tabs.get(tabId)?.conn;
    conn?.send({ type: 'notice', level, text });
  }

  startTransfer({ name, kind, shares, to, total }) {
    const fromKeys = [...new Set(shares.map((s) => s.deviceKey))];
    const t = {
      id: rid(9),
      name,
      kind,
      shareIds: shares.map((s) => s.id),
      fromKeys,
      fromName: fromKeys.map((k) => this.deviceName(k)).join(', '),
      toKey: to.key,
      toName: to.name,
      total,
      bytes: 0,
      speed: 0,
      status: 'active',
      startedAt: Date.now(),
      endedAt: null,
      lastBytes: 0,
      lastTick: Date.now(),
      abort: null,
      cancelRequested: false,
    };
    this.transfers.set(t.id, t);
    this.scheduleTransfers();
    this.ensureTicker();
    return t;
  }

  endTransfer(t, status) {
    if (t.status !== 'active') return;
    t.status = status;
    t.endedAt = Date.now();
    t.speed = 0;
    const secs = Math.max(0.001, (t.endedAt - t.startedAt) / 1000);
    const mark = status === 'done' ? color.green('✓') : color.orange('×');
    const how = status === 'done' ? `${formatBytes(t.total)} in ${secs.toFixed(1)} s · ${formatBytes(t.total / secs)}/s` : status;
    log.info(`${mark} ${t.name} ${color.dim(`${t.fromName} → ${t.toName}`)} ${color.dim(how)}`);
    const finished = [...this.transfers.values()].filter((x) => x.status !== 'active');
    for (const old of finished.slice(0, Math.max(0, finished.length - HISTORY))) this.transfers.delete(old.id);
    this.scheduleTransfers();
  }

  cancelTransfer(id, conn) {
    const t = this.transfers.get(id);
    if (!t || t.status !== 'active') return;
    if (conn && conn.deviceKey !== t.toKey && !t.fromKeys.includes(conn.deviceKey)) return;
    t.cancelRequested = true;
    t.abort?.();
  }

  ensureTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), 250);
  }

  tick() {
    const now = Date.now();
    const items = [];
    for (const t of this.transfers.values()) {
      if (t.status !== 'active') continue;
      const dt = (now - t.lastTick) / 1000;
      if (dt > 0) {
        const inst = (t.bytes - t.lastBytes) / dt;
        t.speed = t.speed ? t.speed * 0.75 + inst * 0.25 : inst;
      }
      t.lastBytes = t.bytes;
      t.lastTick = now;
      items.push({ id: t.id, bytes: t.bytes, speed: Math.round(t.speed) });
    }
    if (!items.length) {
      clearInterval(this.ticker);
      this.ticker = null;
      return;
    }
    const msg = JSON.stringify({ type: 'progress', items });
    for (const c of this.conns) if (c.tabId) c.send(msg);
  }

  // ───────────────────────── broadcasting ─────────────────────────

  scheduleState() {
    if (this.pending.state) return;
    this.pending.state = true;
    setImmediate(() => {
      this.pending.state = false;
      this.broadcastState();
    });
  }

  scheduleTransfers() {
    if (this.pending.transfers) return;
    this.pending.transfers = true;
    setImmediate(() => {
      this.pending.transfers = false;
      const msg = JSON.stringify(this.transfersMessage());
      for (const c of this.conns) if (c.tabId) c.send(msg);
    });
  }

  broadcastState() {
    const devices = [...this.devices.values()].map((d) => ({
      key: d.key,
      name: d.name,
      kind: d.kind,
      isHost: d.isHost,
      online: this.isOnline(d),
      lastSeen: d.lastSeen,
    }));
    const shares = [];
    const paths = {};
    for (const s of this.shares.values()) {
      shares.push({
        id: s.id,
        deviceKey: s.deviceKey,
        source: s.source,
        kind: s.kind,
        name: s.name,
        size: s.size,
        count: s.count,
        mime: s.mime,
        lastModified: s.lastModified,
        addedAt: s.addedAt,
        available: this.isAvailable(s),
      });
      if (s.source === 'disk') paths[s.id] = s.path;
    }
    const base = { type: 'state', devices, shares, serverTime: Date.now() };
    const remote = JSON.stringify(base);
    const host = JSON.stringify({ ...base, paths }); // disk paths are only shown on the host itself
    for (const c of this.conns) if (c.tabId) c.send(c.isHost ? host : remote);
  }

  transfersMessage() {
    const items = [...this.transfers.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        shareIds: t.shareIds,
        fromKeys: t.fromKeys,
        fromName: t.fromName,
        toKey: t.toKey,
        toName: t.toName,
        total: t.total,
        bytes: t.bytes,
        speed: Math.round(t.speed),
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
      }));
    return { type: 'transfers', items, serverTime: Date.now() };
  }

  close() {
    clearInterval(this.ticker);
    for (const t of this.transfers.values()) if (t.status === 'active') t.abort?.();
    for (const c of this.conns) c.ws.close(1001, 'Host stopped');
  }
}

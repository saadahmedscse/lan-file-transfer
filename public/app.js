/* Ferry — client. One WebSocket carries every update; nothing polls. */
(() => {
  'use strict';

  // ───────────────────────── helpers ─────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const esc = (v) =>
    String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // crypto.randomUUID needs a secure context; plain http on a LAN isn't one.
  const randomId = (bytes = 12) => {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v === null || v === '') localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {}
    },
  };

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = n;
    let i = -1;
    do {
      v /= 1024;
      i++;
    } while (v >= 1024 && i < units.length - 1);
    return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  function fmtDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '';
    if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    const h = Math.floor(sec / 3600);
    return `${h} h ${Math.round((sec - h * 3600) / 60)} min`;
  }

  const now = () => Date.now() + S.skew;

  function ago(ts) {
    const d = (now() - ts) / 1000;
    if (d < 45) return 'just now';
    if (d < 90) return '1 min ago';
    if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  // ───────────────────────── icons ─────────────────────────

  const ICON = {
    video: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9.5 4.5 2.5-4.5 2.5z"/>',
    audio: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m20 16-4.5-4.5L7 20"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>',
    archive: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M12 3v2.5"/><path d="M12 8v2.5"/><rect x="10" y="13" width="4" height="4" rx="1"/>',
    disc: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/>',
    code: '<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="m13.5 5-3 14"/>',
    app: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 9h16"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>',
    computer: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 17.5h2"/>',
    tablet: '<rect x="4.5" y="3" width="15" height="18" rx="2.5"/><path d="M11 17.5h2"/>',
    download: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    upload: '<path d="M12 15V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    x: '<path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16.5h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5h.01"/>',
    swap: '<path d="M7 4v16"/><path d="m3.5 16.5 3.5 3.5 3.5-3.5"/><path d="M17 20V4"/><path d="m13.5 7.5 3.5-3.5 3.5 3.5"/>',
    wifi: '<path d="M2.5 9a14 14 0 0 1 19 0"/><path d="M5.5 12.5a9.5 9.5 0 0 1 13 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M12 19.5h.01"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  };
  const icon = (name, size = 18, stroke = 1.75) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ICON.file}</svg>`;

  const EXT = {
    video: 'mp4 m4v mkv mov avi wmv webm flv mpg mpeg 3gp ts m2ts vob',
    audio: 'mp3 m4a aac wav flac ogg oga opus wma aiff aif alac mid midi amr',
    image: 'jpg jpeg png gif webp heic heif bmp tif tiff svg raw cr2 cr3 nef arw dng psd ai avif ico jxl',
    doc: 'pdf doc docx xls xlsx ppt pptx odt ods odp txt md rtf csv epub mobi pages numbers key log',
    archive: 'zip rar 7z tar gz tgz bz2 xz zst cab lz lzma',
    disc: 'iso dmg img vhd vhdx vmdk qcow2',
    code: 'js mjs ts jsx tsx json html htm css scss py java c cpp h hpp cs go rs rb php sh ps1 bat cmd sql xml yml yaml toml ini kt swift dart lua',
    app: 'exe msi apk apks xapk ipa appx msix deb rpm pkg app jar',
  };
  const EXT_MAP = new Map();
  for (const [type, list] of Object.entries(EXT)) for (const e of list.split(' ')) EXT_MAP.set(e, type);
  const TYPE_LABEL = { video: 'Video', audio: 'Audio', image: 'Image', doc: 'Document', archive: 'Archive', disc: 'Disk image', code: 'Code', app: 'App', file: 'File', folder: 'Folder' };

  function typeOf(share) {
    if (share.kind === 'folder') return 'folder';
    const dot = share.name.lastIndexOf('.');
    const ext = dot > 0 ? share.name.slice(dot + 1).toLowerCase() : '';
    if (EXT_MAP.has(ext)) return EXT_MAP.get(ext);
    const m = share.mime || '';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('text/') || m === 'application/pdf') return 'doc';
    return 'file';
  }

  function detectDevice() {
    const ua = navigator.userAgent || '';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return { kind: 'tablet', label: 'iPad' };
    if (/iPhone|iPod/.test(ua)) return { kind: 'phone', label: 'iPhone' };
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? { kind: 'phone', label: 'Android phone' } : { kind: 'tablet', label: 'Android tablet' };
    if (/Windows/.test(ua)) return { kind: 'computer', label: 'Windows PC' };
    if (/CrOS/.test(ua)) return { kind: 'computer', label: 'Chromebook' };
    if (/Mac OS X|Macintosh/.test(ua)) return { kind: 'computer', label: 'Mac' };
    if (/Linux/.test(ua)) return { kind: 'computer', label: 'Linux PC' };
    return { kind: 'computer', label: 'Device' };
  }

  // ───────────────────────── state ─────────────────────────

  let deviceId = store.get('ferry.device');
  if (!deviceId) {
    deviceId = randomId(12);
    store.set('ferry.device', deviceId);
  }
  const tabId = randomId(12); // per page load: a reload means the held files are gone
  const device = detectDevice();

  const S = {
    ws: null,
    connected: false,
    welcome: null,
    sessionId: null,
    myKey: null,
    devices: [],
    shares: [],
    paths: {},
    transfers: [],
    skew: 0,
    tab: 'available',
    query: '',
    gotState: false,
    newIds: new Map(), // shareId -> time first seen (NEW badge)
    pending: new Map(), // shareId | 'all:<deviceKey>' -> time clicked
    picking: false,
    nativeFailed: false,
    unseen: 0,
    rendered: new Set(),
    toldAboutDrops: false,
  };

  /** Files this tab is sharing: shareId -> { meta, file } | { meta, files } */
  const held = new Map();
  const uploads = new Map(); // partId -> AbortController

  const isHost = () => !!S.welcome?.isHost;
  const deviceOf = (key) => S.devices.find((d) => d.key === key);
  const myDevice = () => deviceOf(S.myKey);
  const isLoopback = (h) => h === 'localhost' || h === '[::1]' || h === '::1' || /^127\./.test(h);

  // ───────────────────────── connection ─────────────────────────

  let retry = 0;
  let retryTimer = null;

  function connect() {
    clearTimeout(retryTimer);
    if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    S.ws = ws;
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      handle(m);
    };
    ws.onclose = () => {
      if (S.ws !== ws) return;
      S.connected = false;
      for (const ac of uploads.values()) ac.abort();
      renderStatus();
      render();
      const delay = Math.min(8000, 300 * 2 ** retry++);
      retryTimer = setTimeout(connect, delay);
    };
  }

  function reconnectNow() {
    if (S.ws && S.ws.readyState <= WebSocket.OPEN) return;
    retry = 0;
    connect();
  }

  function send(msg) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(msg));
  }

  function handle(m) {
    switch (m.type) {
      case 'welcome':
        return onWelcome(m);
      case 'ready':
        S.myKey = m.deviceKey;
        S.connected = true;
        retry = 0;
        renderStatus();
        renderMe();
        return render();
      case 'state':
        return onState(m);
      case 'transfers':
        return onTransfers(m);
      case 'progress':
        return onProgress(m);
      case 'upload-request':
        return onUploadRequest(m);
      case 'upload-cancel':
        uploads.get(m.partId)?.abort();
        return;
      case 'notice':
        return toast(m.text, m.level === 'error' ? 'error' : 'info');
    }
  }

  function onWelcome(m) {
    if (S.sessionId && S.sessionId !== m.sessionId) {
      // The host restarted: its memory is empty, so this tab starts fresh too.
      held.clear();
      S.newIds.clear();
      S.pending.clear();
      S.gotState = false;
      toast('The host restarted — this is a new session.', 'info');
    }
    S.sessionId = m.sessionId;
    S.welcome = m;
    S.skew = m.serverTime - Date.now();
    send({
      type: 'hello',
      tabId,
      deviceId,
      name: store.get('ferry.name') || '',
      defaultName: device.label,
      kind: device.kind,
      shares: [...held.values()].map((h) => h.meta),
    });
    renderRole();
    renderAddress();
    renderMe();
  }

  function onState(m) {
    S.skew = m.serverTime - Date.now();
    const prevShares = new Set(S.shares.map((s) => s.id));
    const prevOnline = new Set(S.devices.filter((d) => d.online).map((d) => d.key));
    S.devices = m.devices || [];
    S.shares = m.shares || [];
    S.paths = m.paths || {};

    if (S.gotState) {
      const fresh = S.shares.filter((s) => !prevShares.has(s.id) && s.deviceKey !== S.myKey);
      for (const s of fresh) S.newIds.set(s.id, Date.now());
      if (fresh.length) {
        const byDevice = new Map();
        for (const s of fresh) byDevice.set(s.deviceKey, [...(byDevice.get(s.deviceKey) || []), s]);
        for (const [key, list] of byDevice) {
          const who = deviceOf(key)?.name || 'A device';
          toast(list.length === 1 ? `${who} shared “${list[0].name}”` : `${who} shared ${plural(list.length, 'item')}`, 'accent', 'download');
        }
        if (document.hidden) {
          S.unseen += fresh.length;
          document.title = `(${S.unseen}) Ferry`;
        }
      }
      for (const d of S.devices) {
        if (d.online && !prevOnline.has(d.key) && d.key !== S.myKey && !d.isHost) toast(`${d.name} joined`, 'ok', d.kind);
      }
    }
    S.gotState = true;
    for (const id of S.newIds.keys()) if (!S.shares.some((s) => s.id === id)) S.newIds.delete(id);
    renderMe();
    renderStatus();
    render();
  }

  function onTransfers(m) {
    const before = new Map(S.transfers.map((t) => [t.id, t.status]));
    S.transfers = m.items || [];
    for (const t of S.transfers) {
      if (t.toKey === S.myKey && t.status === 'active') {
        if (t.shareIds.length === 1) S.pending.delete(t.shareIds[0]);
        if (t.kind === 'zip') for (const k of [...S.pending.keys()]) if (k.startsWith('all:')) S.pending.delete(k);
      }
      const was = before.get(t.id);
      if (was === 'active' && t.status === 'failed' && (t.toKey === S.myKey || t.fromKeys.includes(S.myKey))) {
        toast(`Transfer of “${t.name}” was interrupted.`, 'error');
      }
    }
    render();
  }

  function onProgress(m) {
    const byId = new Map(S.transfers.map((t) => [t.id, t]));
    for (const p of m.items) {
      const t = byId.get(p.id);
      if (t) {
        t.bytes = p.bytes;
        t.speed = p.speed;
      }
    }
    applyProgress();
  }

  // ───────────────────────── relay: serving my files ─────────────────────────

  async function onUploadRequest(m) {
    const h = held.get(m.shareId);
    const file = h && (h.meta.kind === 'folder' ? h.files?.[m.fileIndex] : h.file);
    if (!file) {
      send({ type: 'upload-error', partId: m.partId, message: 'This tab no longer has that file.' });
      return;
    }
    const body = Number.isFinite(m.start) && Number.isFinite(m.end) ? file.slice(m.start, m.end + 1) : file;
    const ac = new AbortController();
    uploads.set(m.partId, ac);
    try {
      await fetch(`/relay/${encodeURIComponent(m.partId)}`, {
        method: 'POST',
        body,
        signal: ac.signal,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    } catch {
      if (!ac.signal.aborted) {
        send({ type: 'upload-error', partId: m.partId, message: `Couldn't read “${file.name}” — it may have been moved or changed.` });
      }
    } finally {
      uploads.delete(m.partId);
    }
  }

  // ───────────────────────── sharing ─────────────────────────

  function addEntries(entries) {
    const singles = [];
    const folders = new Map();
    for (const e of entries) {
      const parts = String(e.path || e.file.name)
        .split('/')
        .filter(Boolean);
      if (parts.length <= 1) singles.push(e.file);
      else {
        const top = parts[0];
        if (!folders.has(top)) folders.set(top, []);
        folders.get(top).push({ file: e.file, rel: parts.slice(1).join('/') });
      }
    }
    const metas = [];
    for (const f of singles) {
      const id = randomId(12);
      const meta = { id, kind: 'file', name: f.name, size: f.size, mime: f.type || '', lastModified: f.lastModified || Date.now() };
      held.set(id, { meta, file: f });
      metas.push(meta);
    }
    for (const [name, items] of folders) {
      const id = randomId(12);
      const files = items.map((i) => ({ path: i.rel, size: i.file.size, lastModified: i.file.lastModified || Date.now() }));
      const meta = {
        id,
        kind: 'folder',
        name,
        size: files.reduce((a, f) => a + f.size, 0),
        count: files.length,
        lastModified: Math.max(...files.map((f) => f.lastModified)),
        files,
      };
      held.set(id, { meta, files: items.map((i) => i.file) });
      metas.push(meta);
    }
    if (!metas.length) {
      toast('Nothing to share — that folder looks empty.', 'info');
      return;
    }
    send({ type: 'share', shares: metas });
    if (isHost() && !S.toldAboutDrops) {
      S.toldAboutDrops = true;
      toast('Shared from this tab — keep it open. “Choose files” shares straight from disk instead.', 'info');
    }
  }

  async function nativePick(type) {
    if (S.picking) return;
    S.picking = true;
    renderRole();
    try {
      const r = await fetch('/api/pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ferry': '1' },
        body: JSON.stringify({ type }),
      });
      const j = await r.json();
      if (j.unsupported) {
        S.nativeFailed = true;
        toast('The system file dialog isn’t available — using the browser picker.', 'info');
        browserPick(type);
      } else if (j.error) {
        toast(j.error, 'error');
      } else if (j.added) {
        toast(`Sharing ${plural(j.added, 'item')} straight from disk.`, 'ok', 'check');
      } else if (j.duplicates) {
        toast('Already shared.', 'info');
      }
    } catch {
      toast('Couldn’t reach the host.', 'error');
    } finally {
      S.picking = false;
      renderRole();
    }
  }

  function browserPick(type) {
    (type === 'folder' ? $('#folder-input') : $('#file-input')).click();
  }

  function pick(type) {
    if (isHost() && S.welcome?.nativePicker && !S.nativeFailed) nativePick(type);
    else browserPick(type);
  }

  function unshare(ids) {
    if (!ids.length) return;
    for (const id of ids) held.delete(id);
    send({ type: 'unshare', ids });
  }

  async function entriesFromDrop(dt) {
    const items = [...(dt.items || [])].filter((i) => i.kind === 'file');
    // webkitGetAsEntry must be read synchronously, before the first await.
    const roots = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    const plainFiles = [...(dt.files || [])];
    if (!roots.some(Boolean)) return plainFiles.map((file) => ({ file, path: file.name }));
    const out = [];
    const readAll = (reader) =>
      new Promise((resolve) => {
        const all = [];
        const next = () =>
          reader.readEntries(
            (batch) => {
              if (!batch.length) return resolve(all);
              all.push(...batch);
              next();
            },
            () => resolve(all),
          );
        next();
      });
    async function walk(entry, prefix) {
      if (entry.isFile) {
        try {
          const file = await new Promise((res, rej) => entry.file(res, rej));
          out.push({ file, path: prefix + file.name });
        } catch {}
      } else if (entry.isDirectory) {
        for (const child of await readAll(entry.createReader())) await walk(child, `${prefix}${entry.name}/`);
      }
    }
    for (const r of roots) if (r) await walk(r, '');
    return out;
  }

  // ───────────────────────── downloading ─────────────────────────

  function triggerDownload(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function markPending(key) {
    S.pending.set(key, Date.now());
    setTimeout(() => {
      if (S.pending.get(key) && Date.now() - S.pending.get(key) >= 19000) {
        S.pending.delete(key);
        render();
      }
    }, 20000);
    render();
  }

  function downloadShare(id) {
    const s = S.shares.find((x) => x.id === id);
    if (!s || !s.available) return;
    S.newIds.delete(id);
    markPending(id);
    triggerDownload(`/dl/${encodeURIComponent(id)}?t=${tabId}`);
  }

  function downloadAll(deviceKey) {
    const list = S.shares.filter((s) => s.deviceKey === deviceKey && s.available);
    if (!list.length) return;
    for (const s of list) S.newIds.delete(s.id);
    const name = deviceOf(deviceKey)?.name || 'Ferry';
    markPending(`all:${deviceKey}`);
    triggerDownload(`/zip?ids=${list.map((s) => encodeURIComponent(s.id)).join(',')}&name=${encodeURIComponent(name)}&t=${tabId}`);
  }

  // ───────────────────────── rendering ─────────────────────────

  function myIncoming(shareId) {
    return S.transfers.find((t) => t.status === 'active' && t.toKey === S.myKey && t.shareIds.length === 1 && t.shareIds[0] === shareId);
  }

  function progressBlock(t) {
    return `<div class="prog" data-t="${esc(t.id)}">
      <div class="prog-top"><span class="prog-pct">0%</span><span class="prog-rate">Connecting…</span></div>
      <div class="bar"><i></i></div>
    </div>`;
  }

  function cancelButton(t, label) {
    return `<button class="btn-icon" type="button" data-act="cancel" data-t="${esc(t.id)}" data-k="cancel:${esc(t.id)}" aria-label="${esc(label)}">${icon('x', 15, 2)}</button>`;
  }

  function startingState() {
    return `<span class="state"><span class="spinner" aria-hidden="true"></span>Starting…</span>`;
  }

  function shareMeta(s) {
    const type = typeOf(s);
    const parts = [s.kind === 'folder' ? `Folder · ${plural(s.count, 'item')}` : TYPE_LABEL[type], fmtBytes(s.size)];
    return parts;
  }

  function rowClass(id, extra = '') {
    const enter = S.rendered.has(id) ? '' : ' enter';
    S.nextRendered.add(id);
    return `row${extra}${enter}`;
  }

  function availableRow(s, dev) {
    const type = typeOf(s);
    const isNew = S.newIds.has(s.id) && Date.now() - S.newIds.get(s.id) < 3 * 60 * 1000;
    const incoming = myIncoming(s.id);
    const meta = shareMeta(s);
    let side;
    if (!s.available) {
      meta.push(dev && !dev.online ? `available when ${dev.name} is back` : 'the sharing tab was closed');
      side = `<span class="unavail">Unavailable</span>`;
    } else if (incoming) {
      side = progressBlock(incoming) + cancelButton(incoming, `Cancel download of ${s.name}`);
      meta.push(ago(s.addedAt));
    } else if (S.pending.has(s.id)) {
      side = startingState();
      meta.push(ago(s.addedAt));
    } else {
      meta.push(ago(s.addedAt));
      side = `<button class="btn-tint" type="button" data-act="download" data-id="${esc(s.id)}" data-k="dl:${esc(s.id)}" aria-label="Download ${esc(s.name)}">${icon('download', 16, 2)}<span class="lbl">Download</span></button>`;
    }
    return `<div class="${rowClass(s.id, `${s.available ? '' : ' is-off'}${isNew && s.available ? ' is-new' : ''}`)}">
      <div class="tile${type === 'folder' ? ' accent' : ''}">${icon(type, 19)}</div>
      <div class="row-main">
        <div class="row-title"><span class="row-name" title="${esc(s.name)}">${esc(s.name)}</span>${isNew && s.available ? '<span class="badge-new">NEW</span>' : ''}</div>
        <div class="row-meta">${esc(meta.join(' · '))}</div>
      </div>
      <div class="row-side">${side}</div>
    </div>`;
  }

  function sortedDevices() {
    return [...S.devices].sort((a, b) => {
      if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  // Available first, then newest first.
  const byRelevance = (a, b) => Number(b.available) - Number(a.available) || b.addedAt - a.addedAt;

  const matches = (s) => !S.query || s.name.toLowerCase().includes(S.query) || (deviceOf(s.deviceKey)?.name || '').toLowerCase().includes(S.query);

  function viewAvailable() {
    const others = S.shares.filter((s) => s.deviceKey !== S.myKey);
    if (!others.length) return emptyAvailable();
    const shown = others.filter(matches);
    if (!shown.length) return emptySearch();
    const groups = [];
    for (const dev of sortedDevices()) {
      const list = shown.filter((s) => s.deviceKey === dev.key).sort(byRelevance);
      if (!list.length) continue;
      const avail = list.filter((s) => s.available);
      const status = dev.isHost ? 'Host · online' : dev.online ? 'Online' : `Offline · seen ${ago(dev.lastSeen)}`;
      const allKey = `all:${dev.key}`;
      let action = '';
      if (avail.length >= 2) {
        action = S.pending.has(allKey)
          ? `<span class="state" style="margin-left:auto"><span class="spinner" aria-hidden="true"></span>Preparing…</span>`
          : `<button class="btn-link" type="button" data-act="dlall" data-dev="${esc(dev.key)}" data-k="${esc(allKey)}" aria-label="Download all from ${esc(dev.name)} as one zip">Download all<span class="sz"> · ${fmtBytes(avail.reduce((a, s) => a + s.size, 0))}</span></button>`;
      }
      groups.push(`<div class="group${dev.online ? '' : ' is-off'}">
        <div class="group-head">
          <span class="group-icon">${icon(dev.kind, 17)}</span>
          <span class="group-name">${esc(dev.name)}</span>
          <span class="group-status"><span class="dot${dev.online ? '' : ' off'}" aria-hidden="true"></span>${esc(status)}</span>
          ${action}
        </div>
        ${list.map((s) => availableRow(s, dev)).join('')}
      </div>`);
    }
    return groups.join('');
  }

  function mineRow(s) {
    const type = typeOf(s);
    const meta = shareMeta(s).map(esc);
    const sending = S.transfers.filter((t) => t.status === 'active' && t.shareIds.includes(s.id));
    if (sending.length === 1) {
      const t = sending[0];
      meta.push(`<span class="hl" data-tp="${esc(t.id)}">Sending to ${esc(t.toName)} · <span class="pct">0%</span></span>`);
    } else if (sending.length > 1) {
      meta.push(`<span class="hl">Sending to ${sending.length} devices</span>`);
    } else if (s.source === 'disk') {
      meta.push(esc(S.paths[s.id] ? `From disk · ${S.paths[s.id]}` : 'From disk'));
    } else if (held.has(s.id)) {
      meta.push('Held by this tab');
    } else {
      meta.push(s.available ? 'Held by another tab' : 'Unavailable — that tab was closed');
    }
    return `<div class="${rowClass(s.id, s.available ? '' : ' is-off')}">
      <div class="tile${type === 'folder' ? ' accent' : ''}">${icon(type, 19)}</div>
      <div class="row-main">
        <div class="row-title"><span class="row-name" title="${esc(s.name)}">${esc(s.name)}</span></div>
        <div class="row-meta" title="${esc(S.paths[s.id] || '')}">${meta.join(' · ')}</div>
      </div>
      <div class="row-side">
        <button class="btn-outline" type="button" data-act="unshare" data-id="${esc(s.id)}" data-k="un:${esc(s.id)}" aria-label="Stop sharing ${esc(s.name)}">${icon('x', 15, 2)}<span class="lbl">Stop sharing</span></button>
      </div>
    </div>`;
  }

  function viewMine() {
    const mine = S.shares.filter((s) => s.deviceKey === S.myKey);
    if (!mine.length) return emptyMine();
    const shown = mine.filter(matches).sort(byRelevance);
    if (!shown.length) return emptySearch();
    const parts = [];
    if (mine.some((s) => held.has(s.id))) {
      parts.push(`<div class="note">${icon('info', 16)}<span>Keep this tab open — other devices download these straight from it. Closing or reloading it stops sharing them.</span></div>`);
    }
    const total = mine.reduce((a, s) => a + s.size, 0);
    parts.push(`<div class="group">
      <div class="list-head">
        <span>${plural(mine.length, 'item')} · ${fmtBytes(total)}</span>
        ${mine.length >= 2 ? `<button class="btn-link" type="button" data-act="unshare-all" data-k="unall">Stop sharing all</button>` : ''}
      </div>
      ${shown.map(mineRow).join('')}
    </div>`);
    return parts.join('');
  }

  function activityRow(t) {
    const incoming = t.toKey === S.myKey;
    const outgoing = t.fromKeys.includes(S.myKey);
    const dir = incoming ? 'download' : outgoing ? 'upload' : 'swap';
    const meta = [`${t.fromName} → ${incoming ? 'you' : t.toName}`, fmtBytes(t.total)];
    let side;
    if (t.status === 'active') {
      meta.push(`started ${ago(t.startedAt)}`);
      side = progressBlock(t) + (incoming || outgoing ? cancelButton(t, `Cancel transfer of ${t.name}`) : '');
    } else {
      const secs = Math.max(0.001, ((t.endedAt || t.startedAt) - t.startedAt) / 1000);
      if (t.status === 'done') meta.push(`${fmtBytes(t.total / secs)}/s avg`);
      meta.push(ago(t.endedAt || t.startedAt));
      side =
        t.status === 'done'
          ? `<span class="state"><span class="ok">${icon('check', 16, 2.2)}</span>Done</span>`
          : `<span class="state"><span class="bad">${icon(t.status === 'canceled' ? 'x' : 'alert', 16, 2)}</span>${t.status === 'canceled' ? 'Canceled' : 'Interrupted'}</span>`;
    }
    return `<div class="${rowClass('t:' + t.id)}">
      <div class="tile${t.status === 'active' ? ' accent' : ''}">${icon(dir, 19)}</div>
      <div class="row-main">
        <div class="row-title"><span class="row-name" title="${esc(t.name)}">${esc(t.name)}</span></div>
        <div class="row-meta">${esc(meta.join(' · '))}</div>
      </div>
      <div class="row-side">${side}</div>
    </div>`;
  }

  function viewActivity() {
    if (!S.transfers.length) {
      return emptyState('swap', 'No transfers yet', 'Downloads to and from this session show up here with live progress.');
    }
    const shown = S.transfers.filter((t) => !S.query || t.name.toLowerCase().includes(S.query));
    if (!shown.length) return emptySearch();
    return `<div class="group">${shown.map(activityRow).join('')}</div>`;
  }

  function emptyState(iconName, title, text, extra = '') {
    return `<div class="empty">
      <div class="empty-icon">${icon(iconName, 26, 1.7)}</div>
      <div class="empty-title">${esc(title)}</div>
      <div class="empty-text">${text}</div>
      ${extra}
    </div>`;
  }

  function emptyAvailable() {
    const others = S.devices.filter((d) => d.key !== S.myKey && d.online);
    if (!others.length) {
      const addr = displayAddress();
      return emptyState(
        'wifi',
        'Waiting for other devices',
        addr
          ? `Open <strong>${esc(addr)}</strong> on your phone or laptop${matchMedia('(max-width: 880px)').matches ? '' : ', or scan the code'}. Anything they share shows up here instantly.`
          : 'Connect this PC to Wi-Fi or a network, then open Ferry on your other devices.',
      );
    }
    const chips = `<div class="chips">${others.map((d) => `<span class="chip">${icon(d.kind, 15)}${esc(d.name)}</span>`).join('')}</div>`;
    return emptyState('download', 'Nothing shared yet', 'Files shared from other devices appear here the moment they’re added.', chips);
  }

  function emptyMine() {
    return emptyState(
      'upload',
      'You’re not sharing anything',
      isHost()
        ? '“Choose files” shares straight from this PC’s disk. You can also drag files onto the orange panel.'
        : 'Drop files on the orange panel or choose them. They stream from this device while this tab stays open.',
    );
  }

  function emptySearch() {
    return emptyState('search', 'No matches', `Nothing here matches “${esc(S.query)}”.`);
  }

  function render() {
    renderCounts();
    const list = $('#list');
    const focusKey = document.activeElement?.closest?.('#list') ? document.activeElement.dataset.k : null;
    const top = list.scrollTop;
    S.nextRendered = new Set();
    list.innerHTML = S.tab === 'available' ? viewAvailable() : S.tab === 'mine' ? viewMine() : viewActivity();
    S.rendered = S.nextRendered;
    list.scrollTop = top;
    if (focusKey) list.querySelector(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    applyProgress();
  }

  function applyProgress() {
    const byId = new Map(S.transfers.map((t) => [t.id, t]));
    for (const el of document.querySelectorAll('[data-t].prog')) {
      const t = byId.get(el.dataset.t);
      if (!t) continue;
      const pct = t.total ? Math.min(100, Math.floor((t.bytes / t.total) * 100)) : 0;
      el.querySelector('.prog-pct').textContent = `${pct}%`;
      const eta = t.speed > 0 ? fmtDuration((t.total - t.bytes) / t.speed) : '';
      el.querySelector('.prog-rate').textContent = t.bytes === 0 ? 'Connecting…' : `${fmtBytes(t.speed)}/s${eta ? ` · ${eta}` : ''}`;
      el.querySelector('.bar > i').style.width = `${pct}%`;
    }
    for (const el of document.querySelectorAll('[data-tp]')) {
      const t = byId.get(el.dataset.tp);
      if (t) el.querySelector('.pct').textContent = `${t.total ? Math.min(100, Math.floor((t.bytes / t.total) * 100)) : 0}%`;
    }
  }

  function renderCounts() {
    const others = S.shares.filter((s) => s.deviceKey !== S.myKey).length;
    const mine = S.shares.filter((s) => s.deviceKey === S.myKey).length;
    const active = S.transfers.filter((t) => t.status === 'active').length;
    $('#count-available').textContent = S.myKey && others ? String(others) : '';
    $('#count-mine').textContent = S.myKey && mine ? String(mine) : '';
    $('#count-activity').textContent = active ? String(active) : '';
  }

  function renderStatus() {
    const live = $('#live');
    live.classList.toggle('off', !S.connected);
    if (S.connected) S.everConnected = true;
    $('#live-text').innerHTML = S.connected
      ? '<span class="long">Live — new shares appear the moment they’re added</span><span class="short">Live</span>'
      : S.everConnected
        ? '<span class="long">Reconnecting to the host…</span><span class="short">Reconnecting…</span>'
        : '<span class="long">Connecting to the host…</span><span class="short">Connecting…</span>';
    // Offline devices only count while they still have something listed.
    const relevant = S.devices.filter((d) => d.online || S.shares.some((s) => s.deviceKey === d.key));
    const online = relevant.filter((d) => d.online).length;
    $('#online-text').textContent = relevant.length ? `LAN only · ${online} of ${plural(relevant.length, 'device')} online` : 'LAN only';
  }

  function currentName() {
    return myDevice()?.name || store.get('ferry.name') || (isHost() ? S.welcome.hostName : device.label);
  }

  function renderMe() {
    $('#me-icon').innerHTML = icon(isHost() ? 'computer' : device.kind, 15, 1.9);
    $('#me-name').textContent = S.welcome ? currentName() : 'This device';
  }

  function renderRole() {
    const host = isHost();
    $('#lede').textContent = host
      ? 'Files are shared straight from this PC’s disk. Everyone in the session downloads them directly — no cloud, no copies, no size limit.'
      : 'Files stay on this device. Others download them straight from it while this tab stays open — no cloud, no size limit.';
    $('#drop-title').textContent = S.picking ? 'Waiting for the file dialog on this PC…' : 'Drag files or folders onto this panel';
    $('#drop-sub').textContent = S.picking
      ? 'Pick files there — they’ll be shared straight from disk.'
      : host
        ? '“Choose files” opens this PC’s own file dialog. Nothing is copied.'
        : 'Any size, any type. Shows up on every device instantly.';
    $('#pick-files').disabled = S.picking;
    $('#pick-folder').disabled = S.picking;
  }

  function displayUrl() {
    const urls = S.welcome?.urls || [];
    if (isLoopback(location.hostname)) return urls[0] || '';
    return location.origin;
  }
  const displayAddress = () => displayUrl().replace(/^https?:\/\//, '');

  function renderAddress() {
    const url = displayUrl();
    const img = $('#qr-img');
    if (url) {
      $('#addr').textContent = displayAddress();
      img.src = `/qr.svg?u=${encodeURIComponent(url)}`;
      img.alt = `QR code for ${url}`;
      img.hidden = false;
      $('#qr').hidden = false;
    } else {
      $('#addr').textContent = 'No network connection';
      img.hidden = true;
      $('#qr').hidden = true;
    }
  }

  // ───────────────────────── toasts ─────────────────────────

  function toast(text, kind = 'info', iconName) {
    const box = $('#toasts');
    while (box.children.length >= 4) box.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const ic = iconName || (kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info');
    el.innerHTML = `<span class="toast-icon">${icon(ic, 17, 2)}</span><span>${esc(text)}</span>`;
    box.appendChild(el);
    const ttl = kind === 'error' ? 6500 : 4200;
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 220);
    }, ttl);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    return ok;
  }

  // ───────────────────────── events ─────────────────────────

  $('#pick-files').addEventListener('click', () => pick('files'));
  $('#pick-folder').addEventListener('click', () => pick('folder'));

  $('#file-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    addEntries(files.map((file) => ({ file, path: file.name })));
  });
  $('#folder-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    addEntries(files.map((file) => ({ file, path: file.webkitRelativePath || file.name })));
  });

  $('#copy-addr').addEventListener('click', async () => {
    const url = displayUrl();
    if (!url) return;
    const ok = await copyText(url);
    toast(ok ? 'Address copied' : url, ok ? 'ok' : 'info', 'copy');
  });

  // Rename this device
  const meChip = $('#me-chip');
  const meForm = $('#me-form');
  const meInput = $('#me-input');
  let renaming = false;
  meChip.addEventListener('click', () => {
    renaming = true;
    meInput.value = currentName();
    meChip.hidden = true;
    meForm.hidden = false;
    meInput.focus();
    meInput.select();
  });
  function finishRename(save) {
    if (!renaming) return;
    renaming = false;
    if (save) {
      const v = meInput.value.trim().slice(0, 40);
      const fallback = isHost() ? S.welcome?.hostName : device.label;
      store.set('ferry.name', v && v !== fallback ? v : '');
      send({ type: 'rename', name: v });
    }
    meForm.hidden = true;
    meChip.hidden = false;
    renderMe();
  }
  meForm.addEventListener('submit', (e) => {
    e.preventDefault();
    finishRename(true);
    meChip.focus();
  });
  meInput.addEventListener('blur', () => finishRename(true));
  meInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      finishRename(false);
      meChip.focus();
    }
  });

  // Tabs
  const tabs = [...document.querySelectorAll('.tab')];
  function selectTab(name, focus) {
    S.tab = name;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    }
    S.rendered = new Set();
    $('#list').scrollTop = 0;
    render();
  }
  for (const t of tabs) {
    t.addEventListener('click', () => selectTab(t.dataset.tab));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = tabs.indexOf(t);
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(next.dataset.tab, true);
    });
  }
  tabs.forEach((t) => (t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1));

  // Search
  const searchInput = $('#search-input');
  const searchToggle = $('#search-toggle');
  function openSearch() {
    searchInput.hidden = false;
    searchToggle.setAttribute('aria-expanded', 'true');
    $('#tabs-bar').classList.add('searching');
    searchInput.focus();
  }
  function closeSearch() {
    searchInput.value = '';
    S.query = '';
    searchInput.hidden = true;
    searchToggle.setAttribute('aria-expanded', 'false');
    $('#tabs-bar').classList.remove('searching');
    render();
  }
  searchToggle.addEventListener('click', () => (searchInput.hidden ? openSearch() : closeSearch()));
  searchInput.addEventListener('input', () => {
    S.query = searchInput.value.trim().toLowerCase();
    S.rendered = new Set();
    render();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSearch();
      searchToggle.focus();
    }
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      openSearch();
    }
  });

  // List actions (event delegation — the list is re-rendered on every update)
  $('#list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    switch (b.dataset.act) {
      case 'download':
        return downloadShare(b.dataset.id);
      case 'dlall':
        return downloadAll(b.dataset.dev);
      case 'cancel':
        return send({ type: 'cancel', id: b.dataset.t });
      case 'unshare':
        return unshare([b.dataset.id]);
      case 'unshare-all':
        return unshare(S.shares.filter((s) => s.deviceKey === S.myKey).map((s) => s.id));
    }
  });

  // Drag & drop anywhere on the page
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
    $('#drop-title').textContent = 'Release to share';
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  const endDrag = () => {
    dragDepth = 0;
    document.body.classList.remove('dragging');
    renderRole();
  };
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) endDrag();
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    endDrag();
    addEntries(await entriesFromDrop(e.dataTransfer));
  });

  // Page lifecycle
  window.addEventListener('pagehide', () => {
    if (held.size) navigator.sendBeacon?.('/api/bye', tabId);
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) reconnectNow();
  });
  window.addEventListener('beforeunload', (e) => {
    if (uploads.size) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      S.unseen = 0;
      document.title = 'Ferry';
      reconnectNow();
    }
  });
  window.addEventListener('online', reconnectNow);

  // Relative times ("2 min ago") and NEW badges age on their own.
  setInterval(() => {
    if (!document.hidden && S.gotState) render();
  }, 30000);

  renderRole();
  renderStatus();
  renderMe();
  render();
  connect();
})();

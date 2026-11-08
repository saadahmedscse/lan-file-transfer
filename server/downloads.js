/**
 * Downloads. Three sources, one URL scheme:
 *   • disk     — a path picked on the host; streamed from disk, with Range/resume support
 *   • browser  — a File held by a tab on some device; the server asks that tab to stream it
 *                and pipes the bytes straight through (nothing is stored on the host)
 *   • folders  — any mix of the above, streamed as a ZIP with a precomputed Content-Length
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform, pipeline } from 'node:stream';
import { planZip, writeZip } from './zip.js';
import { walk } from './fsutil.js';
import { HttpError, contentDisposition, cleanName, cleanRelPath } from './util.js';
import { log } from './log.js';

const CHUNK = 1 << 20;

export function createDownloads(session) {
  // ───────────── helpers ─────────────

  function fail(req, res, err, to) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : 'Something went wrong on the host.';
    if (!(err instanceof HttpError)) log.warn('Download error:', err.message);
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(message);
    } else {
      res.destroy();
    }
    if (status !== 499) session.notify(to?.tabId, message);
  }

  /** Counts bytes into the transfer and verifies the exact expected length. */
  function counter(t, expected) {
    let seen = 0;
    return new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > expected) return cb(new Error('Source sent more data than expected.'));
        t.bytes += chunk.length;
        cb(null, chunk);
      },
      flush(cb) {
        cb(seen === expected ? null : new Error('Source ended early.'));
      },
    });
  }

  function pump(src, res, t, expected, onEnd) {
    t.abort = () => {
      src.destroy();
      res.destroy();
    };
    pipeline(src, counter(t, expected), res, (err) => {
      onEnd?.(err);
      session.endTransfer(t, err ? (t.cancelRequested ? 'canceled' : 'failed') : 'done');
    });
  }

  function parseRange(req, size, etag, mtimeMs) {
    const header = req.headers.range;
    if (!header || size === 0) return null;
    const ifRange = req.headers['if-range'];
    if (ifRange) {
      if (ifRange.startsWith('"') || ifRange.startsWith('W/')) {
        if (ifRange !== etag) return null;
      } else if (!(Date.parse(ifRange) >= Math.floor(mtimeMs / 1000) * 1000)) {
        return null;
      }
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return null; // multi-range: just send the whole file
    let start;
    let end;
    if (m[1] === '') {
      if (m[2] === '') return null;
      const n = Number(m[2]);
      if (n === 0) return 'invalid';
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start > end || start >= size) return 'invalid';
    return { start, end };
  }

  function fileHeaders(name, length, etag, mtimeMs) {
    return {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(length),
      'Content-Disposition': contentDisposition(name),
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': new Date(mtimeMs).toUTCString(),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
  }

  /** Common Range / HEAD handling. Returns null when the response is already complete. */
  function prepareRange(req, res, name, size, etag, mtimeMs) {
    const range = parseRange(req, size, etag, mtimeMs);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return null;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    const headers = fileHeaders(name, length, etag, mtimeMs);
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    const status = range ? 206 : 200;
    if (req.method === 'HEAD') {
      res.writeHead(status, headers);
      res.end();
      return null;
    }
    return { range, start, end, length, headers, status };
  }

  function uniqueName(name, used, isFile) {
    let candidate = name;
    let n = 2;
    const ext = isFile ? path.extname(name) : '';
    const stem = ext ? name.slice(0, -ext.length) : name;
    while (used.has(candidate.toLowerCase())) candidate = `${stem} (${n++})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  }

  /** Send the upload's HTTP response once its bytes are consumed (or drop it on failure). */
  function finishUpload(up, err) {
    if (!err && !up.res.headersSent) {
      up.res.writeHead(204);
      up.res.end();
    } else {
      up.req.destroy();
    }
  }

  // ───────────── sources ─────────────

  async function sendDiskFile(req, res, share, to) {
    let st;
    try {
      st = await fsp.stat(share.path);
    } catch {
      st = null;
    }
    if (!st?.isFile()) throw new HttpError(410, `“${share.name}” was moved or deleted on ${session.host.name}.`);
    const etag = `"d${st.size.toString(36)}-${Math.trunc(st.mtimeMs).toString(36)}"`;
    const r = prepareRange(req, res, share.name, st.size, etag, st.mtimeMs);
    if (!r) return;
    res.writeHead(r.status, r.headers);
    const t = session.startTransfer({ name: share.name, kind: 'file', shares: [share], to, total: r.length });
    const src =
      st.size === 0
        ? fs.createReadStream(share.path)
        : fs.createReadStream(share.path, { start: r.start, end: r.end, highWaterMark: CHUNK });
    pump(src, res, t, r.length);
  }

  async function sendRelayFile(req, res, share, to) {
    if (!session.isAvailable(share)) throw new HttpError(503, session.unavailableReason(share));
    const etag = `"b${share.id}-${share.size.toString(36)}"`;
    const r = prepareRange(req, res, share.name, share.size, etag, share.lastModified);
    if (!r) return;
    const t = session.startTransfer({ name: share.name, kind: 'file', shares: [share], to, total: r.length });
    const part = session.requestPart(share, null, r.range ? r.start : null, r.range ? r.end : null);
    let gone = false;
    const onClose = () => {
      gone = true;
      part.cancel();
    };
    res.once('close', onClose);
    t.abort = () => {
      part.cancel();
      res.destroy();
    };
    let up;
    try {
      up = await part.promise;
    } catch (e) {
      session.endTransfer(t, t.cancelRequested || gone ? 'canceled' : 'failed');
      throw e;
    } finally {
      res.off('close', onClose);
    }
    if (gone || res.destroyed) {
      up.req.destroy();
      session.endTransfer(t, 'canceled');
      return;
    }
    res.writeHead(r.status, r.headers);
    pump(up.req, res, t, r.length, (err) => finishUpload(up, err));
  }

  async function sendZip(req, res, shares, zipName, to) {
    const entries = [];
    const used = new Set();
    let current = null; // the relay part currently streaming, so cancel can reach it

    const relayOpener = (share, fileIndex) => async () => {
      const part = session.requestPart(share, fileIndex);
      current = part;
      const up = await part.promise;
      up.req.once('end', () => finishUpload(up, null));
      return up.req;
    };

    for (const s of shares) {
      if (!session.isAvailable(s)) throw new HttpError(503, session.unavailableReason(s));
      const top = uniqueName(cleanRelPath(s.name) || 'item', used, s.kind === 'file');
      if (s.kind === 'file') {
        if (s.source === 'disk') {
          const st = await fsp.stat(s.path).catch(() => null);
          if (!st?.isFile()) throw new HttpError(410, `“${s.name}” was moved or deleted on ${session.host.name}.`);
          entries.push({ name: top, size: st.size, mtime: st.mtimeMs, open: () => fs.createReadStream(s.path, { highWaterMark: CHUNK }) });
        } else {
          entries.push({ name: top, size: s.size, mtime: s.lastModified, open: relayOpener(s, null) });
        }
      } else if (s.source === 'disk') {
        const st = await fsp.stat(s.path).catch(() => null);
        if (!st?.isDirectory()) throw new HttpError(410, `“${s.name}” was moved or deleted on ${session.host.name}.`);
        const { files } = await walk(s.path); // fresh listing: the folder may have changed
        for (const f of files) {
          const abs = path.join(s.path, ...f.path.split('/'));
          entries.push({ name: `${top}/${cleanRelPath(f.path)}`, size: f.size, mtime: f.mtime, open: () => fs.createReadStream(abs, { highWaterMark: CHUNK }) });
        }
      } else {
        s.files.forEach((f, i) => entries.push({ name: `${top}/${f.path}`, size: f.size, mtime: f.mtime, open: relayOpener(s, i) }));
      }
    }

    const plan = planZip(entries);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(plan.total),
      'Content-Disposition': contentDisposition(zipName),
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();

    const t = session.startTransfer({ name: zipName, kind: 'zip', shares, to, total: plan.total });
    t.abort = () => {
      current?.cancel();
      res.destroy();
    };
    res.once('close', () => {
      if (!res.writableFinished) current?.cancel();
    });
    try {
      await writeZip(res, plan, (_rec, i) => entries[i].open(), (n) => (t.bytes += n));
      res.end();
      session.endTransfer(t, 'done');
    } catch (e) {
      res.destroy();
      session.endTransfer(t, t.cancelRequested ? 'canceled' : 'failed');
      if (!t.cancelRequested && !/closed the connection/.test(e.message)) {
        session.notify(to.tabId, `Download of “${zipName}” stopped: ${e.message}`);
      }
    }
  }

  // ───────────── routes ─────────────

  /** GET /dl/<shareId>?t=<tabId> */
  async function single(req, res, shareId, url) {
    const to = session.identify(url.searchParams.get('t'), req);
    try {
      const share = session.shares.get(shareId);
      if (!share) throw new HttpError(404, 'That item is no longer shared.');
      if (share.kind === 'folder') return await sendZip(req, res, [share], `${share.name}.zip`, to);
      if (share.source === 'disk') return await sendDiskFile(req, res, share, to);
      return await sendRelayFile(req, res, share, to);
    } catch (e) {
      fail(req, res, e, to);
    }
  }

  /** GET /zip?ids=a,b,c&name=<archive name>&t=<tabId> — several shares as one ZIP. */
  async function multi(req, res, url) {
    const to = session.identify(url.searchParams.get('t'), req);
    try {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 1000);
      const shares = ids.map((id) => session.shares.get(id)).filter((s) => s && session.isAvailable(s));
      if (!shares.length) throw new HttpError(404, 'Nothing available to download.');
      const name = `${cleanName(url.searchParams.get('name') || 'Ferry', 'Ferry')}.zip`;
      await sendZip(req, res, shares, name, to);
    } catch (e) {
      fail(req, res, e, to);
    }
  }

  /** POST /relay/<partId> — a sharing tab streams the bytes it was asked for. */
  function relay(req, res, partId) {
    const result = session.acceptPart(partId, req, res);
    if (result === 'ok') return;
    res.writeHead(result === 'forbidden' ? 403 : 404, { 'Content-Type': 'text/plain' });
    res.end();
    req.resume();
  }

  return { single, multi, relay };
}

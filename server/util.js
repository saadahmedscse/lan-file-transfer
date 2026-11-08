import crypto from 'node:crypto';

/** URL-safe random id. 16 bytes ≈ 128 bits — unguessable, used as capability tokens. */
export const rid = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** A single file or folder name: no path separators, no control characters. */
export function cleanName(value, fallback = 'file') {
  let s = typeof value === 'string' ? value : '';
  s = s.replace(CONTROL, '').replace(/[\\/]/g, '_').trim();
  if (s === '.' || s === '..') s = '';
  if (s.length > 255) s = s.slice(0, 255);
  return s || fallback;
}

/**
 * A relative path inside a shared folder, always with "/" separators.
 * Drops empty, "." and ".." segments so a zip can never write outside its folder.
 */
export function cleanRelPath(value) {
  if (typeof value !== 'string') return '';
  return value
    .split(/[\\/]+/)
    .map((seg) => seg.replace(CONTROL, '').replace(/:/g, '_').trim().slice(0, 255))
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/** A short human label (device names, notices). */
export function cleanLabel(value, max = 40) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function safeInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const rfc5987 = (s) =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Content-Disposition that survives non-ASCII names in every browser. */
export function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987(name)}`;
}

export function formatBytes(n) {
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

export async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

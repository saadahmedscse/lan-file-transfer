import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './util.js';

export const MAX_FOLDER_FILES = 250_000;

/**
 * Recursively list the files in a folder: relative "/" paths, sizes and mtimes.
 * Unreadable entries are skipped; symlinked folders are not followed (no loops).
 */
export async function walk(root, limit = MAX_FOLDER_FILES) {
  const files = [];
  let size = 0;

  async function visit(dir, rel) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const dirs = [];
    const candidates = [];
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(e);
      else if (e.isFile() || e.isSymbolicLink()) candidates.push(e);
    }
    for (let i = 0; i < candidates.length; i += 64) {
      const batch = candidates.slice(i, i + 64);
      const stats = await Promise.all(batch.map((e) => fsp.stat(path.join(dir, e.name)).catch(() => null)));
      for (let j = 0; j < batch.length; j++) {
        const st = stats[j];
        if (!st || !st.isFile()) continue;
        if (files.length >= limit) throw new HttpError(413, `That folder has more than ${limit.toLocaleString()} files.`);
        files.push({ path: rel ? `${rel}/${batch[j].name}` : batch[j].name, size: st.size, mtime: st.mtimeMs });
        size += st.size;
      }
    }
    for (const d of dirs) await visit(path.join(dir, d.name), rel ? `${rel}/${d.name}` : d.name);
  }

  await visit(root, '');
  return { files, size };
}

/** Display name for a picked path; a drive root like "D:\" becomes "D:". */
export function displayName(p) {
  const base = path.basename(p);
  if (base) return base;
  return p.replace(/[\\/]+$/, '') || p;
}

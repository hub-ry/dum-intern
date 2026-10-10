import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { sep, isAbsolute, extname } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

type Opened = { handle: FileHandle; size: number; type: string };

async function lstatNoSymlink(p: string): Promise<Stats | null> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink()) return null;
    return st;
  } catch {
    return null;
  }
}

/** Opens root/segments... only if every ancestor (including the root's own) is a real directory and the leaf a real file. */
export async function openArtifactFile(root: string, segments: string[]): Promise<Opened | null> {
  if (!isAbsolute(root) || !segments.length || segments.some((s) => !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(s))) return null;
  const parts = root.split(sep).filter((p) => p !== "");
  let current: string = sep;
  const dirs: string[] = [current];
  for (const p of parts) {
    current = current === sep ? `${sep}${p}` : `${current}${sep}${p}`;
    dirs.push(current);
  }
  for (const d of dirs) {
    const st = await lstatNoSymlink(d);
    if (!st || !st.isDirectory()) return null;
  }
  for (let i = 0; i < segments.length; i++) {
    current = `${current}${sep}${segments[i]}`;
    const st = await lstatNoSymlink(current);
    if (!st) return null;
    const last = i === segments.length - 1;
    if (last ? !st.isFile() : !st.isDirectory()) return null;
    if (last) {
      const type = MIME[extname(current).toLowerCase()];
      if (!type) return null;
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
      let handle: FileHandle;
      try {
        handle = await open(current, flags);
      } catch {
        return null;
      }
      try {
        const fst = await handle.stat();
        if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) {
          await handle.close();
          return null;
        }
        return { handle, size: fst.size, type };
      } catch {
        await handle.close().catch(() => {});
        return null;
      }
    }
  }
  return null;
}


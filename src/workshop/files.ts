// Private durable files for the workshop store: a 0700 home, 0600 records, bounded reads that
// never follow a symlink, and replacements that are complete and synced before they get their
// name. One process owns a home at a time; the owner lock carries the pid and a random token so
// a stale lock from a dead process is recovered and a live one is never removed by someone else.

import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const LOCK_MAX_BYTES = 4096;
const LOCK_ATTEMPTS = 4;

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

/** Make `path` a private directory (0700), refusing a symlink or a non-directory in its place. */
export function ensurePrivateDir(path: string): void {
  const abs = resolve(path);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error(`${abs} is a symlink - the workshop won't use it`);
    if (!st.isDirectory()) throw new Error(`${abs} isn't a directory`);
  } catch (err) {
    if (code(err) !== "ENOENT") throw err;
    mkdirSync(abs, { recursive: true, mode: 0o700 });
    if (lstatSync(abs).isSymbolicLink()) throw new Error(`${abs} is a symlink - the workshop won't use it`);
  }
  chmodSync(abs, 0o700);
}

/**
 * The real path `path` would have: its nearest existing ancestor resolved through symlinks, with
 * the missing tail appended. Lets a home that doesn't exist yet be compared with a directory.
 */
export function intendedRealPath(path: string): string {
  let dir = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(dir), ...tail);
    } catch (err) {
      if (code(err) !== "ENOENT") throw err;
      const parent = dirname(dir);
      if (parent === dir) return join(dir, ...tail);
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}

/** True when `child` is `ancestor` itself or lives below it (both already real, absolute). */
export function isWithin(child: string, ancestor: string): boolean {
  if (child === ancestor) return true;
  const base = ancestor.endsWith("/") ? ancestor : `${ancestor}/`;
  return child.startsWith(base);
}

/** The whole text of one regular file, never through a symlink, or null when absent. */
export function readPrivateFile(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch (err) {
    if (code(err) === "ENOENT") return null;
    if (code(err) === "ELOOP") throw new Error(`${path} is a symlink - the workshop won't follow it`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} isn't a regular file`);
    if (st.size > maxBytes) throw new Error(`${path} is ${st.size} bytes - the workshop reads it up to ${maxBytes}`);
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, got) !== 0) throw new Error(`${path} is changing while the workshop reads it - try again`);
    return buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf8");
  let put = 0;
  while (put < buf.length) put += writeSync(fd, buf, put, buf.length - put);
}

/** A complete 0600 temporary file next to `path`, synced to disk. The caller renames it. */
function tempFile(path: string, text: string): string {
  const dir = dirname(path);
  for (let attempt = 0; ; attempt++) {
    const temp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
    let fd: number;
    try {
      fd = openSync(temp, CREATE_FLAGS, 0o600);
    } catch (err) {
      if (code(err) === "EEXIST" && attempt < 3) continue;
      throw err;
    }
    try {
      writeAll(fd, text);
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      try { unlinkSync(temp); } catch { /* already gone */ }
      throw err;
    }
    closeSync(fd);
    return temp;
  }
}

function syncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Replace `path` atomically: temp file, fsync, rename over, then fsync the directory entry. */
export function writePrivateFile(path: string, text: string): void {
  const file = resolve(path);
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) throw new Error(`${file} is a symlink - the workshop won't replace it`);
    if (!st.isFile()) throw new Error(`${file} isn't a regular file`);
  } catch (err) {
    if (code(err) !== "ENOENT") throw err;
  }
  const temp = tempFile(file, text);
  try {
    renameSync(temp, file);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* already gone */ }
    throw err;
  }
  syncDir(dirname(file));
}

/** Create `path` with `text` only when nothing is there; false when it already exists. */
function createExclusive(path: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, CREATE_FLAGS, 0o600);
  } catch (err) {
    if (code(err) === "EEXIST") return false;
    throw err;
  }
  try {
    writeAll(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDir(dirname(path));
  return true;
}

type LockHolder = { pid: number; token: string };

function parseHolder(raw: string | null): LockHolder | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { pid, token } = value as Record<string, unknown>;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof token !== "string" || !token) return null;
    return { pid: pid as number, token };
  } catch {
    return null;
  }
}

/** Alive, or not ours to signal (EPERM): either way the process is there. */
function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return code(err) === "EPERM";
  }
}

export class LockHeldError extends Error {
  readonly pid: number;
  constructor(path: string, pid: number) {
    super(`another workshop process (pid ${pid}) owns ${path} - close it there first`);
    this.name = "LockHeldError";
    this.pid = pid;
  }
}

/**
 * Own `path` for this process. A lock whose pid is gone is recovered; a live pid (including one
 * this user may not signal) is refused. Returns the release, which removes the lock only while it
 * still carries this process's token.
 */
export function acquireOwnerLock(path: string): () => void {
  const token = randomUUID();
  const body = `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    if (createExclusive(path, body)) return makeRelease(path, token);
    const holder = parseHolder(readPrivateFile(path, LOCK_MAX_BYTES));
    if (holder === null) {
      // Removed between the create and the read, or unreadable: a missing one is retried, an
      // unreadable one is for a person to inspect.
      let present = true;
      try { lstatSync(path); } catch (err) { present = code(err) !== "ENOENT"; }
      if (!present) continue;
      throw new Error(`${path} isn't a workshop lock the store can read - if no workshop is running, delete it and try again`);
    }
    if (processAlive(holder.pid)) throw new LockHeldError(path, holder.pid);
    // Stale: its process is gone on this machine. Remove and try again.
    try {
      unlinkSync(path);
    } catch (err) {
      if (code(err) !== "ENOENT") throw err;
    }
  }
  throw new Error(`${path} keeps reappearing - another program is writing there`);
}

function makeRelease(path: string, token: string): () => void {
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    try {
      if (parseHolder(readPrivateFile(path, LOCK_MAX_BYTES))?.token === token) unlinkSync(path);
    } catch {
      // Left in place: its pid is gone once this process exits, so the next owner recovers it.
    }
  };
}

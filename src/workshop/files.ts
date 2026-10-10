// Private durable files for the workshop store: a 0700 home, 0600 records, bounded reads that
// never follow a symlink, and replacements that are complete and synced before they get their
// name. One process owns a home at a time; the owner lock carries the pid and a random token so
// a stale lock from a dead process is recovered and a live one is never removed by someone else.
//
// The owner lock's read-check-unlink-create sequence runs under a kernel advisory lock on a stable
// private guard file next to it (`owner.lock.guard`), so two starters that both see a stale owner
// can't both "recover" it. Node has no flock(2), so the short critical section runs in a child:
// util-linux flock(1) takes the guard through an inherited descriptor and runs owner-lock-helper.ts,
// which calls back into ownerLockOperation below. The guard is created once and never unlinked or
// replaced; whoever holds its lock exits, cleanly or not, and the kernel drops the lock.

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
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
import { fileURLToPath } from "node:url";

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const LOCK_MAX_BYTES = 4096;
const LOCK_ATTEMPTS = 4;
/** Flags for the guard: never through a symlink, never blocking on a FIFO put in its place. */
const GUARD_FLAGS = constants.O_RDONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** The descriptor number the guard is pinned to in the flock child; flock reopens it by that path. */
const GUARD_FD = 3;
/** How long flock(1) waits for the guard before giving up; a critical section takes milliseconds. */
const GUARD_WAIT_SECONDS = 5;
/** flock's exit status when it could not take the guard in time (its own choice, not the helper's). */
const GUARD_BUSY_EXIT = 75;
/** Backstop on the whole child, well past flock's wait plus a helper start. */
const GUARD_CHILD_TIMEOUT_MS = 30_000;
const GUARD_CHILD_MAX_OUTPUT = 64 * 1024;

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

/** What one guarded owner-lock operation found; the helper prints it, the parent acts on it. */
export type OwnerLockOutcome =
  | { ok: true; outcome: "acquired" | "released" | "absent" | "kept" }
  | { ok: false; kind: "live"; pid: number; message: string }
  | { ok: false; kind: "malformed" | "operational"; message: string };

export type OwnerLockOperation = "acquire" | "release";

/**
 * The owner-lock critical section. Runs only while the caller holds the guard lock (the helper is
 * the one caller), so between reading `path` and changing it nothing else does the same.
 *
 * acquire: create the owner record for `pid`/`token`; recover one whose process is gone; report
 * a live one (including one already carrying this very pid and token, which is idempotent).
 * release: unlink the record only when it carries both `pid` and `token`; anything else is kept.
 */
export function ownerLockOperation(operation: OwnerLockOperation, path: string, pid: number, token: string): OwnerLockOutcome {
  if (operation !== "acquire" && operation !== "release") return { ok: false, kind: "operational", message: `unknown owner-lock operation ${String(operation)}` };
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof token !== "string" || !token) {
    return { ok: false, kind: "operational", message: "owner-lock operation needs a positive pid and a token" };
  }
  let holder: LockHolder | null;
  let raw: string | null;
  try {
    if (operation === "release") {
      raw = readPrivateFile(path, LOCK_MAX_BYTES);
      if (raw === null) return { ok: true, outcome: "absent" };
      holder = parseHolder(raw);
      if (holder === null || holder.pid !== pid || holder.token !== token) return { ok: true, outcome: "kept" };
      try {
        unlinkSync(path);
      } catch (err) {
        if (code(err) !== "ENOENT") throw err;
      }
      syncDir(dirname(path));
      return { ok: true, outcome: "released" };
    }

    const body = `${JSON.stringify({ pid, token, createdAt: new Date().toISOString() })}\n`;
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      if (createExclusive(path, body)) return { ok: true, outcome: "acquired" };
      raw = readPrivateFile(path, LOCK_MAX_BYTES);
      if (raw === null) continue; // gone between the create and the read: something outside the guard; try again
      holder = parseHolder(raw);
      if (holder === null) {
        return { ok: false, kind: "malformed", message: `${path} isn't a workshop lock the store can read - if no workshop is running, delete it and try again` };
      }
      if (holder.pid === pid && holder.token === token) return { ok: true, outcome: "acquired" };
      if (processAlive(holder.pid)) {
        return { ok: false, kind: "live", pid: holder.pid, message: `another workshop process (pid ${holder.pid}) owns ${path} - close it there first` };
      }
      // Stale: its process is gone on this machine. Under the guard, nobody else removes it with us.
      try {
        unlinkSync(path);
      } catch (err) {
        if (code(err) !== "ENOENT") throw err;
      }
    }
    return { ok: false, kind: "operational", message: `${path} keeps reappearing - another program is writing there` };
  } catch (err) {
    return { ok: false, kind: "operational", message: err instanceof Error ? err.message : String(err) };
  }
}

/** The guard that serializes owner-lock operations on `path`: a sibling file that is never removed. */
export function ownerGuardPath(path: string): string {
  return `${path}.guard`;
}

/**
 * Open the guard for `path`, creating it privately the first time, and refuse anything that isn't
 * our own private regular file with a single name: a symlink (O_NOFOLLOW), a directory or FIFO, a
 * file someone else owns, or one whose directory entry no longer points at what we opened.
 */
function openGuard(path: string): number {
  const guard = ownerGuardPath(path);
  let fd: number;
  try {
    fd = openSync(guard, GUARD_FLAGS, 0o600);
  } catch (err) {
    if (code(err) === "ELOOP") throw new Error(`${guard} is a symlink - the workshop won't use it as the owner guard`);
    if (code(err) === "EISDIR") throw new Error(`${guard} is a directory - the workshop won't use it as the owner guard`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${guard} isn't a regular file - the workshop won't use it as the owner guard`);
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) throw new Error(`${guard} belongs to uid ${st.uid}, not this user - the workshop won't use it as the owner guard`);
    if (st.nlink !== 1) throw new Error(`${guard} has ${st.nlink} names - the workshop won't use it as the owner guard`);
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600); // ours; the umask at creation may have been loose
    const named = lstatSync(guard);
    if (named.ino !== st.ino || named.dev !== st.dev) throw new Error(`${guard} changed while the workshop opened it - try again`);
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

const HELPER_PATH = fileURLToPath(new URL("./owner-lock-helper.ts", import.meta.url));

/** The tsx loader this process can reach, as a URL node's --import accepts, independent of cwd. */
function tsxImport(): string {
  try {
    return import.meta.resolve("tsx");
  } catch (err) {
    throw new Error(`the owner-lock helper needs tsx, which can't be resolved from ${import.meta.url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Error for a guard that stayed busy or a helper that could not run: operational, retryable. */
export class OwnerLockBusyError extends Error {
  constructor(path: string, detail: string) {
    super(`${path} is busy - ${detail}`);
    this.name = "OwnerLockBusyError";
  }
}

/**
 * Run one owner-lock operation under the guard's kernel lock, in a child:
 * flock --exclusive --timeout N --conflict-exit-code 75 /proc/self/fd/3 node --import tsx helper ...
 * flock opens /proc/self/fd/3 itself, so the lock lives on its own open file description and goes
 * away when the child exits however it exits; the parent's descriptor never holds the lock.
 */
function runGuarded(operation: OwnerLockOperation, path: string, pid: number, token: string): OwnerLockOutcome {
  const loader = tsxImport();
  const fd = openGuard(path);
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(
      "flock",
      [
        "--exclusive",
        "--timeout", String(GUARD_WAIT_SECONDS),
        "--conflict-exit-code", String(GUARD_BUSY_EXIT),
        `/proc/self/fd/${GUARD_FD}`,
        process.execPath, "--import", loader, HELPER_PATH, operation, path, String(pid), token,
      ],
      {
        stdio: ["ignore", "pipe", "pipe", fd],
        encoding: "utf8",
        timeout: GUARD_CHILD_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: GUARD_CHILD_MAX_OUTPUT,
        windowsHide: true,
      },
    );
  } finally {
    closeSync(fd);
  }
  if (result.error) {
    const why = code(result.error) === "ENOENT" ? "flock (util-linux) isn't installed or isn't on PATH" : result.error.message;
    throw new OwnerLockBusyError(path, `the owner-lock helper couldn't run: ${why}`);
  }
  const printed = parseOutcome(result.stdout);
  if (printed) return printed;
  if (result.status === GUARD_BUSY_EXIT) {
    throw new OwnerLockBusyError(path, `another workshop process held its guard for over ${GUARD_WAIT_SECONDS} seconds - try again`);
  }
  const stderr = (result.stderr ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  const how = result.signal ? `was stopped by ${result.signal}` : `exited ${result.status}`;
  throw new OwnerLockBusyError(path, `the owner-lock helper ${how} without reporting${stderr ? `: ${stderr}` : ""}`);
}

/** The last JSON line the helper printed, when it is an outcome; anything else is "didn't report". */
function parseOutcome(stdout: string | null | undefined): OwnerLockOutcome | null {
  const lines = (stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    const value: unknown = JSON.parse(last);
    if (!value || typeof value !== "object" || typeof (value as { ok?: unknown }).ok !== "boolean") return null;
    const v = value as Record<string, unknown>;
    const { outcome, kind, message, pid } = v;
    if (v.ok === true) {
      return outcome === "acquired" || outcome === "released" || outcome === "absent" || outcome === "kept" ? { ok: true, outcome } : null;
    }
    if (typeof message !== "string") return null;
    if (kind === "live") return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? { ok: false, kind, pid, message } : null;
    if (kind === "malformed" || kind === "operational") return { ok: false, kind, message };
    return null;
  } catch {
    return null;
  }
}

/**
 * Own `path` for this process. A lock whose pid is gone is recovered; a live pid (including one
 * this user may not signal) is refused with LockHeldError. The check and the change run under the
 * guard, so concurrent starters see each other. A busy guard or a helper that can't run raises
 * OwnerLockBusyError. Returns the release, which removes the lock only while it still carries this
 * process's pid and token. The release runs one guarded operation and does not retry: an
 * OwnerLockBusyError from it means the record is still ours on disk, and calling the release
 * again is the retry.
 */
export function acquireOwnerLock(path: string): () => void {
  path = resolve(path);
  const token = randomUUID();
  const outcome = runGuarded("acquire", path, process.pid, token);
  if (outcome.ok) return makeRelease(path, token);
  if (outcome.kind === "live") throw new LockHeldError(path, outcome.pid);
  throw new Error(outcome.message);
}

function makeRelease(path: string, token: string): () => void {
  let held = true;
  return () => {
    if (!held) return;
    // A busy guard or a helper that can't run throws OwnerLockBusyError here, and `held` stays
    // true: the record may still be ours, and the caller decides whether to try again. Once this
    // process exits its pid is gone and the next owner recovers the record either way.
    const outcome = runGuarded("release", path, process.pid, token);
    if (!outcome.ok) throw new Error(`${path} couldn't be released: ${outcome.message}`);
    // released, absent, or kept: in every case nothing of ours remains to remove.
    held = false;
  };
}

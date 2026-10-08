// Dum's private records under an app-owned base: H (skills.home()), a zone directory under it, or
// Electron's userData. Never a folder the user shared. Every directory below the base is a real
// directory, every record a regular file; a symlink anywhere is refused, never followed. Reads are
// bounded, replacements are atomic, and creation never replaces. Directories 0700, files 0600.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
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
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

/** One regular file, never through a final symlink, never bigger than `max`. */
function readBounded(abs: string, label: string, max: number): Buffer {
  let fd: number;
  try {
    fd = openSync(abs, READ_FLAGS);
  } catch (err) {
    if (code(err) === "ELOOP") throw new Error(`${label} is a symlink - Dum won't follow it`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${label} isn't a regular file`);
    if (st.size > max) throw new Error(`${label} is ${Math.ceil(st.size / 1024)} KiB - Dum reads it up to ${Math.floor(max / 1024)} KiB`);
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    // A file that grew past what was measured is not a bounded read any more.
    if (readSync(fd, Buffer.alloc(1), 0, 1, got) !== 0) throw new Error(`${label} is changing while Dum reads it - try again`);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** A complete temporary file in `dir`, synced to disk. The caller links or renames it. */
function tempFile(dir: string, name: string, body: string): string {
  for (let attempt = 0; ; attempt++) {
    const temp = join(dir, `.${name}.dum-${randomBytes(6).toString("hex")}.tmp`);
    let fd: number;
    try {
      fd = openSync(temp, WRITE_FLAGS, 0o600);
    } catch (err) {
      if (code(err) === "EEXIST" && attempt < 3) continue;
      throw err;
    }
    try {
      const buf = Buffer.from(body);
      let put = 0;
      while (put < buf.length) put += writeSync(fd, buf, put, buf.length - put);
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      unlinkSync(temp);
      throw err;
    }
    closeSync(fd);
    return temp;
  }
}

/** A real directory, never a symlink. Creates it (private) when `create`; false when absent. */
function realDir(path: string, label: string, create: boolean): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error(`${label} is a symlink - Dum won't follow it`);
      if (!st.isDirectory()) throw new Error(`${label} isn't a directory`);
      return true;
    } catch (err) {
      if (code(err) !== "ENOENT") throw err;
      if (!create) return false;
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (made) {
        if (code(made) !== "EEXIST") throw made;
      }
    }
  }
  throw new Error(`couldn't create ${label}`);
}

function parts(relative: string): string[] {
  const list = relative.split("/");
  if (!relative || list.some((p) => !p || p === "." || p === ".." || p.includes("\\") || p.includes("\0"))) {
    throw new Error(`"${relative}" isn't a private record name`);
  }
  return list;
}

/**
 * The real directory holding `relative`, every step verified, or null when part of it is absent
 * and `create` is false. The base itself must not be a symlink; it is created when missing.
 */
function recordDir(base: string, list: string[], create: boolean): string | null {
  const abs = resolve(base);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error(`${abs} is a symlink - Dum won't follow it`);
    if (!st.isDirectory()) throw new Error(`${abs} isn't a directory`);
  } catch (err) {
    if (code(err) !== "ENOENT") throw err;
    if (!create) return null;
    mkdirSync(abs, { recursive: true, mode: 0o700 });
    if (lstatSync(abs).isSymbolicLink()) throw new Error(`${abs} is a symlink - Dum won't follow it`);
  }
  let dir = realpathSync(abs);
  let label = "";
  for (const part of list.slice(0, -1)) {
    dir = join(dir, part);
    label = label ? `${label}/${part}` : part;
    if (!realDir(dir, label, create)) return null;
  }
  return dir;
}

function leafCheck(file: string, label: string): void {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) throw new Error(`${label} is a symlink - Dum won't follow it`);
    if (!st.isFile()) throw new Error(`${label} isn't a regular file`);
  } catch (err) {
    if (code(err) !== "ENOENT") throw err;
  }
}

/** Absolute path of a private record under `base`, creating and verifying every directory to it. */
export function statePath(base: string, relative: string): string {
  const list = parts(relative);
  const file = join(recordDir(base, list, true)!, list.at(-1)!);
  leafCheck(file, relative);
  return file;
}

/** A record's text, or null when it doesn't exist. Throws on a symlink, a non-file or more than `maxBytes`. */
export function readState(base: string, relative: string, maxBytes: number): string | null {
  const list = parts(relative);
  const dir = recordDir(base, list, false);
  if (!dir) return null;
  try {
    return readBounded(join(dir, list.at(-1)!), relative, maxBytes).toString("utf8");
  } catch (err) {
    if (code(err) === "ENOENT") return null;
    throw err;
  }
}

/** Replace a record atomically: a complete private temp file renamed over it. */
export function writeState(base: string, relative: string, text: string): void {
  const file = statePath(base, relative);
  const temp = tempFile(dirname(file), basename(file), text);
  try {
    renameSync(temp, file);
  } catch (err) {
    unlinkSync(temp);
    throw err;
  }
}

/**
 * Create a record only if nothing is there. The bytes are complete before the name appears, and
 * link(2) refuses an existing name instead of replacing it. False when it already exists.
 */
export function createState(base: string, relative: string, text: string): boolean {
  const file = statePath(base, relative);
  const dir = dirname(file);
  const temp = tempFile(dir, basename(file), text);
  try {
    if (realpathSync(dir) !== dir) throw new Error(`${relative}: its directory moved - Dum didn't create it`);
    linkSync(temp, file);
    return true;
  } catch (err) {
    if (code(err) === "EEXIST") return false;
    if (code(err) === "EPERM" || code(err) === "ENOTSUP" || code(err) === "EOPNOTSUPP" || code(err) === "EXDEV") {
      throw new Error(`${relative}: this filesystem can't create files without risking a replace, so Dum didn't create it`);
    }
    throw err;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // already gone
    }
  }
}

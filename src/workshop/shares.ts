// Files Ryan asked Dum to hand him: a resume, a PDF, notes. A share points at one file under an
// allowed root (DUM_SHARE_ROOTS, by default ~/internship and the dedicated ~/dum-shared), and the
// workshop serves it at /files/<share id>/<name> to whoever may use the workshop: the token, or
// Ryan's own tailnet devices. Nothing is copied. The link always shows the file as it is now.
//
// Only what was shared is reachable, never the rest of a root. Every serve checks the file again:
// still under a root, still the same real path, no hidden or secret-looking part, no
// credential-looking line in anything textual. Moving, deleting or tainting the file closes the link.

import { constants as fsConstants, lstatSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { scrub } from "../context/root-context.ts";
import { WorkshopError } from "./errors.ts";
import { isWithin, readPrivateFile, writePrivateFile } from "./files.ts";

export type Share = { id: string; path: string; name: string; createdAt: string };
export type ShareView = Share & { size: number | null; urlPath: string };

type Doc = { schemaVersion: 1; shares: Share[] };

export const MAX_SHARES = 1000;
/** Large enough for any document or photo; a share is a link, not a backup. */
export const MAX_SHARE_BYTES = 64 * 1024 * 1024;
/** Textual files are read in full for the credential check, so they stay small. */
const MAX_TEXT_SCAN_BYTES = 4 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const MAX_PATH_CHARS = 4096;
const SHARE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Names that hold secrets by convention. Matched against every part of the path below the root. */
const SECRET_NAME = [
  /(?:^|[._-])(?:env|environment|secrets?|tokens?|passwords?|passwd|credentials?|private[_-]?key|api[_-]?keys?)(?:[._-]|$)/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|ovpn|ppk)$/i,
];

const INLINE: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** Shown as plain text, never rendered: markup in them can't run on the workshop's origin. */
const PLAIN = new Set([".txt", ".md", ".tex", ".csv", ".tsv", ".log", ".json", ".yaml", ".yml", ".py", ".ts", ".js", ".c", ".cc", ".cpp", ".h", ".hpp", ".java", ".sql", ".sh", ".bib"]);

/** How the browser should get a file: a type it may show inline, or a download. */
export function presentation(name: string): { type: string; inline: boolean } {
  const ext = extname(name).toLowerCase();
  if (INLINE[ext]) return { type: INLINE[ext]!, inline: true };
  if (PLAIN.has(ext)) return { type: "text/plain; charset=utf-8", inline: true };
  return { type: "application/octet-stream", inline: false };
}

/** A Content-Disposition value that keeps the real file name, safely quoted for any characters. */
export function disposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function shareUrlPath(share: Pick<Share, "id" | "name">): string {
  return `/files/${share.id}/${encodeURIComponent(share.name)}`;
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

/** The part of `path` that names a secret or a hidden file, if any. */
function forbiddenPart(parts: string[]): string | null {
  for (const p of parts) {
    if (p.startsWith(".")) return p;
    if (SECRET_NAME.some((re) => re.test(p))) return p;
  }
  return null;
}

/** First bytes of a file: a NUL means binary, so there's no text to check for credentials. */
function looksTextual(path: string): boolean {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return !buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

export type SharesOptions = {
  /** The workshop home; shares.json lives here. */
  stateDir: string;
  /** Directories whose files may be shared. Missing ones are skipped; dangerous ones refuse startup. */
  roots: string[];
  /** Whose ~ the paths use. Tests pass their own. */
  userHome?: string;
};

export class Shares {
  readonly roots: string[];
  /** Configured roots that don't exist, so startup can say so. */
  readonly missing: string[] = [];
  private readonly file: string;
  private readonly userHome: string;
  private doc: Doc;

  constructor(opts: SharesOptions) {
    this.userHome = realpathSync(opts.userHome ?? homedir());
    this.file = join(opts.stateDir, "shares.json");
    const stateReal = realpathSync(opts.stateDir);
    const roots: string[] = [];
    for (const raw of opts.roots) {
      const wanted = this.expand(raw);
      let real: string;
      try {
        real = realpathSync(wanted);
      } catch (err) {
        if (errno(err) === "ENOENT") {
          this.missing.push(wanted);
          continue;
        }
        throw err;
      }
      if (!lstatSync(real).isDirectory()) throw new Error(`share root ${wanted} isn't a directory`);
      // A root is a folder of things to hand over, never home itself, the filesystem, or anything
      // holding configuration or the workshop's own state.
      if (isWithin(this.userHome, real)) throw new Error(`share root ${wanted} contains the whole home folder; name a narrower folder`);
      if (isWithin(stateReal, real) || isWithin(real, stateReal)) throw new Error(`share root ${wanted} overlaps the workshop's own state`);
      if (real.split(sep).some((p) => p.startsWith("."))) throw new Error(`share root ${wanted} is inside a hidden folder`);
      if (!roots.includes(real)) roots.push(real);
    }
    this.roots = roots;
    const text = readPrivateFile(this.file, 16 * 1024 * 1024);
    if (text === null) this.doc = { schemaVersion: 1, shares: [] };
    else {
      const parsed = JSON.parse(text) as Doc;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.shares)) throw WorkshopError.corrupt("shares.json has an unknown shape");
      this.doc = parsed;
    }
  }

  private expand(raw: string): string {
    const p = raw.trim();
    if (p === "~") return this.userHome;
    if (p.startsWith("~/")) return resolve(this.userHome, p.slice(2));
    return resolve(p);
  }

  /** Where a requested path really is, if it may be shared; otherwise a reason Dum can repeat. */
  check(raw: string): { real: string; size: number } {
    if (typeof raw !== "string" || !raw.trim()) throw WorkshopError.invalid("Name the file to share.");
    if (raw.length > MAX_PATH_CHARS || raw.includes("\0")) throw WorkshopError.invalid("That path isn't valid.");
    const trimmed = raw.trim();
    if (!isAbsolute(trimmed) && !trimmed.startsWith("~/")) throw WorkshopError.invalid("Give the file's full path, like ~/internship/resume/hubbart_resume.pdf.");
    const allowed = `Files can be shared from ${this.roots.map((r) => this.show(r)).join(" and ") || "no folder (none of the share roots exist)"}.`;
    let real: string;
    try {
      real = realpathSync(this.expand(trimmed));
    } catch (err) {
      if (errno(err) === "ENOENT" || errno(err) === "ENOTDIR") throw WorkshopError.notFound(`There's no file at ${trimmed}.`);
      throw err;
    }
    const root = this.roots.find((r) => isWithin(real, r) && real !== r);
    if (!root) throw WorkshopError.invalid(`${trimmed} isn't in a shared folder. ${allowed}`);
    const bad = forbiddenPart(relative(root, real).split(sep));
    if (bad) throw WorkshopError.invalid(`Refused: "${bad}" is hidden or named like a secret, so it's never shared.`);
    const st = lstatSync(real);
    if (!st.isFile()) throw WorkshopError.invalid(`${trimmed} isn't a regular file.`);
    if (st.size > MAX_SHARE_BYTES) throw WorkshopError.invalid(`${trimmed} is over ${MAX_SHARE_BYTES / 1024 / 1024} MB; share something smaller.`);
    if (looksTextual(real)) {
      if (st.size > MAX_TEXT_SCAN_BYTES) throw WorkshopError.invalid(`${trimmed} is a text file over ${MAX_TEXT_SCAN_BYTES / 1024 / 1024} MB, too big to check for credentials.`);
      const text = readPrivateFile(real, MAX_TEXT_SCAN_BYTES) ?? "";
      if (scrub(text) !== text) throw WorkshopError.invalid(`Refused: a line in ${trimmed} looks like a credential, so it isn't shared.`);
    }
    return { real, size: st.size };
  }

  private show(path: string): string {
    return isWithin(path, this.userHome) ? `~/${relative(this.userHome, path)}` : path;
  }

  private save(): void {
    writePrivateFile(this.file, JSON.stringify(this.doc, null, 1));
  }

  private view(s: Share): ShareView {
    let size: number | null = null;
    try {
      const now = this.check(s.path);
      if (now.real === s.path) size = now.size;
    } catch {
      // The file moved, vanished or fails a check now: listed, but its link answers 404.
    }
    return { ...s, size, urlPath: shareUrlPath(s) };
  }

  /** Shares a file, or returns its existing share: one file, one stable link. */
  share(raw: string, now = new Date()): ShareView {
    const { real } = this.check(raw);
    const existing = this.doc.shares.find((s) => s.path === real);
    if (existing) return this.view(existing);
    if (this.doc.shares.length >= MAX_SHARES) throw WorkshopError.conflict(`There are already ${MAX_SHARES} shared files. Unshare some first.`);
    const share: Share = { id: randomUUID(), path: real, name: basename(real), createdAt: now.toISOString() };
    this.doc = { ...this.doc, shares: [...this.doc.shares, share] };
    this.save();
    return this.view(share);
  }

  list(): ShareView[] {
    return this.doc.shares.map((s) => this.view(s));
  }

  get(id: string): ShareView {
    const s = SHARE_ID.test(id) ? this.doc.shares.find((x) => x.id === id) : undefined;
    if (!s) throw WorkshopError.notFound("No such shared file.");
    return this.view(s);
  }

  unshare(id: string): Share {
    const s = SHARE_ID.test(id) ? this.doc.shares.find((x) => x.id === id) : undefined;
    if (!s) throw WorkshopError.notFound("No such shared file.");
    this.doc = { ...this.doc, shares: this.doc.shares.filter((x) => x.id !== id) };
    this.save();
    return s;
  }

  /**
   * Opens a shared file for serving, or null when the link no longer leads anywhere it may: the
   * share is gone, the name doesn't match, or the file moved, vanished or fails the checks now.
   */
  async open(id: string, name: string): Promise<{ handle: FileHandle; size: number; name: string } | null> {
    const s = SHARE_ID.test(id) ? this.doc.shares.find((x) => x.id === id) : undefined;
    if (!s || s.name !== name) return null;
    try {
      if (this.check(s.path).real !== s.path) return null;
    } catch {
      return null;
    }
    const st = lstatSync(s.path);
    let handle: FileHandle;
    try {
      handle = await open(s.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      return null;
    }
    const fst = await handle.stat();
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) {
      await handle.close();
      return null;
    }
    return { handle, size: fst.size, name: s.name };
  }
}

/** DUM_SHARE_ROOTS (colon separated), or the defaults. */
export function shareRoots(env: string | undefined, userHome = homedir()): { roots: string[]; dedicated: string | null } {
  const dedicated = join(userHome, "dum-shared");
  const list = (env ?? "").split(":").map((s) => s.trim()).filter(Boolean);
  if (list.length) return { roots: list, dedicated: null };
  return { roots: [join(userHome, "internship"), dedicated], dedicated };
}

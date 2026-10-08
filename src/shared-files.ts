// The user's own files as Dum may reach them: what they shared with this request, plus the zone's
// followed folders, under one namespace of `<grant-id>/<relative>` names. A grant comes only from
// main's native picker or confirmed path; selection grants reading and, through change(), a write
// target on command. It never grants competency. No Git, no .gitignore, no watching: the policy
// below is explicit, and a folder exposes only the files enumerated when it was granted.

import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { home as dumHome } from "./skills.ts";
import { ResourcePathSchema, SHARE_LIMITS } from "./share-types.ts";
import type { RequestBinding, ResourcePath, Resources, ShareGrant, SourceSnapshot } from "./share-types.ts";
import type { Follows } from "./follow.ts";

/** Bytes of relative names one grant may enumerate, and grants one request may hold. */
export const GRANT_LIMITS = { nameBytes: 256 * 1024, roots: 8 } as const;
/** Diffs shown in the conversation or sent to the helper. */
const DIFF_LIMITS = { lines: 120, bytes: 64 * 1024 } as const;

export function sha(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

// ---------------------------------------------------------------------------------------------
// Deny policy

const SECRET_DIRS: Record<string, true> = {
  ".ssh": true,
  ".gnupg": true,
  ".aws": true,
  ".azure": true,
  ".kube": true,
  ".docker": true,
  ".claude": true,
  ".codex": true,
  ".password-store": true,
  ".terraform.d": true,
  ".mozilla": true,
  gcloud: true,
  keyrings: true,
};
/** Login-token profiles, refused anywhere on a chosen path. */
const PROFILE_DIRS: Record<string, true> = {
  gh: true,
  hub: true,
  op: true,
  "1Password": true,
  "github-copilot": true,
  "google-chrome": true,
  chromium: true,
};
/** Dependency and build output: not the user's source. */
const CACHE_DIRS: Record<string, true> = { node_modules: true, dist: true, build: true, target: true };
const SECRET_FILE =
  /^(?:\.env(?:\..*)?|\.envrc|\.netrc|_netrc|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.git-credentials|\.htpasswd|\.pgpass|\.vault-token|\.claude\.json|credentials(?:(?:\.[A-Za-z0-9_-]+)*\.(?:json|toml|ya?ml|ini|xml|txt))?|auth\.json|tokens?\.json|secrets?\.(?:json|ya?ml|toml|env|txt)|service[-_]?account.*\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ovpn|gpg|tfstate|tfstate\.backup))$/i;
const SYSTEM = /^\/(?:proc|sys|dev|run|etc|private\/etc|System)(?:\/|$)/;

/** `path` itself or anything below it. */
function within(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return !rel || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** realpath of the path itself, or of its nearest existing ancestor plus the missing rest. */
function realish(abs: string): string {
  let probe = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(probe), ...rest);
    } catch (err) {
      if (code(err) !== "ENOENT" && code(err) !== "ENOTDIR") throw err;
      const up = dirname(probe);
      if (up === probe) throw err;
      rest.unshift(basename(probe));
      probe = up;
    }
  }
}

/**
 * Why a path's names are off limits, or null. Login-profile folder names count only on a chosen
 * root, where they mean ~/.config/gh and the like; inside a project "op" is just a folder.
 */
function namesDenied(parts: string[], profiles: boolean): string | null {
  for (const part of parts) {
    if (SECRET_DIRS[part] || (profiles && PROFILE_DIRS[part])) return `${part} holds credentials - Dum never reads it`;
    if (part.startsWith(".")) return `${part} is hidden - Dum doesn't read hidden files or folders`;
    if (CACHE_DIRS[part]) return `${part} is dependency or build output, not your source`;
  }
  const last = parts.at(-1) ?? "";
  return SECRET_FILE.test(last) ? `${last} looks like credentials - Dum never reads it` : null;
}

/** Why a chosen file or folder (canonical, absolute) can't be granted, or null. */
function rootDenied(abs: string): string | null {
  if (abs === "/") return "/ is your whole disk - choose a project folder";
  let home = homedir();
  try {
    home = realpathSync(home);
  } catch {
    // no home directory on disk: compare the path as given
  }
  if (within(abs, home)) return `${abs} holds your home directory - choose a project folder inside it`;
  if (SYSTEM.test(abs)) return "system files can't be shared";
  if (within(realish(dumHome()), abs)) return "Dum's own private state (your tree, zones and settings) can't be shared";
  if (within(join(home, "Library"), abs)) return "~/Library holds app data, keychains and profiles - Dum never reads it";
  return namesDenied(abs.split("/").filter(Boolean), true);
}

// ---------------------------------------------------------------------------------------------
// Bounded reads

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A stat that changes when an editor saves or replaces the file. */
export function statKey(st: BigIntStats): string {
  return `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
}

export type Bytes = { text: string; sha: string; stat: string };

/**
 * One regular UTF-8 text file, never through a final symlink, never bigger than the share limit,
 * read completely. `label` names it in errors, so absolute paths stay out of messages.
 */
export function readText(abs: string, label: string): Bytes {
  let fd: number;
  try {
    fd = openSync(abs, READ_FLAGS);
  } catch (err) {
    if (code(err) === "ELOOP") throw new Error(`${label} is a symlink - Dum won't follow it`);
    if (code(err) === "ENOENT") throw new Error(`${label} doesn't exist`);
    throw err;
  }
  let buf: Buffer;
  let st: BigIntStats;
  try {
    st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw new Error(`${label} isn't a regular file`);
    const max = SHARE_LIMITS.fileBytes;
    if (st.size > BigInt(max)) throw new Error(`${label} is ${Math.ceil(Number(st.size) / 1024)} KiB - Dum reads files up to ${max / 1024} KiB`);
    buf = Buffer.alloc(Number(st.size));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    // A file that grew while being read is not a complete snapshot.
    if (readSync(fd, Buffer.alloc(1), 0, 1, got) !== 0) throw new Error(`${label} is changing too fast to read - save it and try again`);
    buf = buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
  if (buf.includes(0)) throw new Error(`${label} is a binary file`);
  let text: string;
  try {
    text = UTF8.decode(buf);
  } catch {
    throw new Error(`${label} isn't UTF-8 text`);
  }
  return { text, sha: sha(buf), stat: statKey(st) };
}

/** Lines with their terminators, so a missing final newline is a real difference. */
const LINES = /[^\n]*\n|[^\n]+$/g;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Lines `from`..`to` (1-based, at most SHARE_LIMITS.readLines), with the whole file's SHA. */
export function slice(path: ResourcePath, body: string, digest: string, from: number, to: number): { path: ResourcePath; text: string; sha: string; from: number } {
  const lines = (body.match(LINES) ?? []).map((l) => l.replace(/\n$/, ""));
  const first = Math.min(Math.max(1, Math.floor(from) || 1), Math.max(lines.length, 1));
  const want = Math.max(Math.floor(to) || first, first);
  const last = Math.min(want, first + SHARE_LIMITS.readLines - 1, Math.max(lines.length, first));
  return { path, text: lines.slice(first - 1, last).join("\n"), sha: digest, from: first };
}

// ---------------------------------------------------------------------------------------------
// Unified diffs

type Op = { kind: " " | "-" | "+"; line: string };

/** Myers' shortest edit script, or null when the edit distance is too large to bother with. */
function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD) && found < 0; d++) {
    // The k range this round reads is [-d-1, d+1]; keep only that window.
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const w = trace[d]!;
    const at = (k: number) => w[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ kind: " ", line: a[x - 1]! }); x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "+", line: b[prevY]! });
      else ops.push({ kind: "-", line: a[prevX]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function lineOps(a: string[], b: string[]): Op[] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const midA = a.slice(s, a.length - e);
  const midB = b.slice(s, b.length - e);
  const mid = myers(midA, midB, 2000) ?? [...midA.map((line) => ({ kind: "-" as const, line })), ...midB.map((line) => ({ kind: "+" as const, line }))];
  return [
    ...a.slice(0, s).map((line) => ({ kind: " " as const, line })),
    ...mid,
    ...a.slice(a.length - e).map((line) => ({ kind: " " as const, line })),
  ];
}

/**
 * A Git-style unified diff that `git apply` accepts; `before` null is a new file and `after` null
 * a removed one. Empty when nothing changed.
 */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  const ops = lineOps((before ?? "").match(LINES) ?? [], (after ?? "").match(LINES) ?? []);
  const changed = ops.map((o, i) => (o.kind === " " ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length && (before === null) === (after === null)) return "";
  const head = before === null
    ? [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`]
    : after === null
      ? [`diff --git a/${path} b/${path}`, "deleted file mode 100644", `--- a/${path}`, "+++ /dev/null"]
      : [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  // Old/new line numbers before each op.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 0;
  let nn = 0;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(nn);
    if (op.kind !== "+") o++;
    if (op.kind !== "-") nn++;
  }
  const out = [...head];
  let i = 0;
  while (i < changed.length) {
    const start = Math.max(0, changed[i]! - context);
    let end = changed[i]!;
    while (i + 1 < changed.length && changed[i + 1]! - end <= 2 * context) end = changed[++i]!;
    i++;
    const stop = Math.min(ops.length - 1, end + context);
    const hunk = ops.slice(start, stop + 1);
    const oldLen = hunk.filter((x) => x.kind !== "+").length;
    const newLen = hunk.filter((x) => x.kind !== "-").length;
    const oldStart = oldLen ? oldAt[start]! + 1 : oldAt[start]!;
    const newStart = newLen ? newAt[start]! + 1 : newAt[start]!;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (const op of hunk) {
      out.push(`${op.kind}${op.line.replace(/\n$/, "")}`);
      if (!op.line.endsWith("\n")) out.push("\\ No newline at end of file");
    }
  }
  return `${out.join("\n")}\n`;
}

/** At most DIFF_LIMITS lines and bytes, saying what was left out. */
export function bound(body: string, more = "the rest"): string {
  const lines = body.replace(/\n$/, "").split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length >= DIFF_LIMITS.lines || bytes + Buffer.byteLength(line) + 1 > DIFF_LIMITS.bytes) break;
    kept.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  const left = lines.length - kept.length;
  return left > 0 ? `${kept.join("\n")}\n… ${left} more line${left === 1 ? "" : "s"} - ${more}` : kept.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Grants

/** The granted root moved, was replaced or became a symlink since consent: it must be granted again. */
export class Moved extends Error {}

/** `<grant-id>/<relative>` split, or null when it isn't a resource name. */
export function parsePath(path: string): { id: string; rel: string } | null {
  if (!ResourcePathSchema.safeParse(path).success) return null;
  const at = path.indexOf("/");
  return { id: path.slice(0, at), rel: path.slice(at + 1) };
}

/**
 * Regular files under a folder the user chose, sorted, as `/`-separated relative names. Symlinks
 * are never followed and denied names never entered. An over-limit folder is refused whole rather
 * than silently cut short.
 */
export function enumerate(root: string): string[] {
  const home = realish(dumHome());
  const files: string[] = [];
  let bytes = 0;
  const walk = (dir: string, prefix: string[]) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (!prefix.length) throw err;
      return; // a subfolder Dum may not open stays unread
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const parts = [...prefix, entry.name];
      const rel = parts.join("/");
      if (!entry.isDirectory() && !entry.isFile()) continue; // symlinks, sockets and devices are never part of a grant
      if (namesDenied(parts, false) || join(dir, entry.name) === home) continue;
      if (parts.length > SHARE_LIMITS.depth) throw new Error(`${basename(root)} goes deeper than ${SHARE_LIMITS.depth} folders - choose a smaller folder`);
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), parts);
      } else {
        // A name no resource can spell stays out.
        if (parts.some((p) => p.includes("\\") || CONTROL.test(p))) continue;
        files.push(rel);
        bytes += Buffer.byteLength(rel);
        if (files.length > SHARE_LIMITS.files) throw new Error(`${basename(root)} has more than ${SHARE_LIMITS.files} files Dum could read - choose a smaller folder`);
        if (bytes > GRANT_LIMITS.nameBytes) throw new Error(`${basename(root)} has too many long file names - choose a smaller folder`);
      }
    }
  };
  walk(root, []);
  return files;
}

/**
 * One chosen file or folder, held at its canonical path. Every access rechecks that the root is
 * still where the user chose it and that no symlink stands anywhere below it.
 */
export class Grant {
  readonly files: Set<string>;

  constructor(
    readonly id: string,
    readonly kind: "file" | "folder",
    /** Canonical absolute path; host-private. */
    readonly root: string,
    files: Iterable<string>,
  ) {
    this.files = new Set(files);
  }

  /**
   * A grant for what the user chose. `authorizedPath` comes from main's picker or confirmed typed
   * path; its final component may not be a symlink, and it must pass the deny policy.
   */
  static open(authorizedPath: string, kind: "file" | "folder", id: string = randomUUID()): Grant {
    if (!isAbsolute(authorizedPath) || authorizedPath.includes("\0")) throw new Error("choose a file or folder to share");
    let st;
    try {
      st = lstatSync(authorizedPath);
    } catch (err) {
      if (code(err) === "ENOENT") throw new Error(`${basename(authorizedPath)} doesn't exist`);
      throw err;
    }
    if (st.isSymbolicLink()) throw new Error(`${basename(authorizedPath)} is a symlink - choose the real ${kind}`);
    const root = realpathSync(authorizedPath);
    const why = rootDenied(root);
    if (why) throw new Error(why);
    if (kind === "file") {
      if (!st.isFile()) throw new Error(`${basename(root)} isn't a regular file`);
      readText(root, basename(root));
      return new Grant(id, kind, root, [basename(root)]);
    }
    if (!st.isDirectory()) throw new Error(`${basename(root)} isn't a folder`);
    return new Grant(id, kind, root, enumerate(root));
  }

  get label(): string {
    return basename(this.root).slice(0, 300);
  }

  paths(): ResourcePath[] {
    return [...this.files].map((rel) => `${this.id}/${rel}`);
  }

  /** Whether the root is still the one the user chose: here, gone for now, or moved. */
  where(): "here" | "missing" | "moved" {
    let st;
    try {
      st = lstatSync(this.root);
    } catch (err) {
      if (code(err) === "ENOENT" || code(err) === "ENOTDIR") return "missing";
      throw err;
    }
    if (st.isSymbolicLink() || !(this.kind === "file" ? st.isFile() : st.isDirectory())) return "moved";
    return realpathSync(this.root) === this.root ? "here" : "moved";
  }

  /** Throws unless the root is still where the user chose it. */
  check(): void {
    const where = this.where();
    if (where === "moved") throw new Moved(`${this.label} moved since you shared it - share it again`);
    if (where === "missing") throw new Error(`${this.label} isn't there any more`);
  }

  /**
   * The absolute path for a relative name, with every existing component below the root a real
   * directory and the file itself never a symlink. `exists` is false when the file is absent.
   */
  locate(rel: string): { abs: string; exists: boolean } {
    if (this.kind === "file") {
      if (rel !== basename(this.root)) throw new Error(`${this.id}/${rel} isn't the file you shared`);
      return { abs: this.root, exists: true };
    }
    const parts = rel.split("/");
    let at = this.root;
    for (const [i, part] of parts.entries()) {
      at = join(at, part);
      let st;
      try {
        st = lstatSync(at);
      } catch (err) {
        if (code(err) === "ENOENT") return { abs: join(this.root, ...parts), exists: false };
        throw err;
      }
      if (st.isSymbolicLink()) throw new Error(`${this.id}/${rel} goes through a symlink - Dum only uses a file's real path`);
      if (i < parts.length - 1 && !st.isDirectory()) throw new Error(`${this.id}/${parts.slice(0, i + 1).join("/")} isn't a folder`);
    }
    return { abs: at, exists: true };
  }

  /** The complete current bytes of a granted file. */
  snapshot(rel: string): Bytes & { abs: string } {
    this.check();
    if (!this.files.has(rel)) throw new Error(`${this.id}/${rel} isn't a file you shared`);
    const path = `${this.id}/${rel}`;
    const { abs, exists } = this.locate(rel);
    if (!exists) throw new Error(`${path} doesn't exist`);
    const bytes = readText(abs, path);
    // An ancestor swapped for a symlink between the check and the open shows up here.
    if (realpathSync(abs) !== abs) throw new Error(`${path} moved while Dum read it`);
    return { ...bytes, abs };
  }

  /**
   * Where change() may write `rel`, and the SHA of what is there now. A granted file that exists is
   * hashed; a new name is allowed only under a folder grant, through real folders, and only where
   * nothing exists yet. A new name joins the grant so the written file can be read back.
   */
  target(rel: string): { absolute: string; currentSha: string | null } {
    this.check();
    const path = `${this.id}/${rel}`;
    if (this.files.has(rel)) {
      const { abs, exists } = this.locate(rel);
      if (exists) {
        const bytes = readText(abs, path);
        if (realpathSync(abs) !== abs) throw new Error(`${path} moved while Dum read it`);
        return { absolute: abs, currentSha: bytes.sha };
      }
      if (this.kind === "file") throw new Error(`${path} doesn't exist any more`);
      return { absolute: abs, currentSha: null };
    }
    if (this.kind === "file") throw new Error(`${path} isn't the file you shared - new files go only in a shared folder`);
    const why = namesDenied(rel.split("/"), false);
    if (why) throw new Error(why);
    const { abs, exists } = this.locate(rel);
    if (exists) throw new Error(`${path} isn't part of what you shared - share it again to change it`);
    if (this.files.size >= SHARE_LIMITS.files) throw new Error(`${this.label} already has ${SHARE_LIMITS.files} files`);
    this.files.add(rel);
    return { absolute: abs, currentSha: null };
  }
}

// ---------------------------------------------------------------------------------------------
// Request shares

type Share = { grant: Grant; at: number };

/**
 * One request's shares plus the zone's followed folders, as Resources. Shares bind to the request
 * that took them: before the request starts (activate) a selection lapses after
 * SHARE_LIMITS.pendingMs; once it starts, everything lapses when revoke() ends it.
 */
export class SharedFiles implements Resources {
  private readonly shares = new Map<string, Share>();
  private active = false;
  private ended = false;

  constructor(
    readonly binding: RequestBinding,
    private readonly follows: Follows | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** A file or folder the user chose, for this request only. Trusted main input only. */
  async grant(authorizedPath: string, kind: "file" | "folder"): Promise<ShareGrant> {
    this.live();
    if (this.shares.size >= GRANT_LIMITS.roots) throw new Error(`a request can share at most ${GRANT_LIMITS.roots} files or folders`);
    const grant = Grant.open(authorizedPath, kind);
    for (const s of this.shares.values()) {
      if (s.grant.root === grant.root) return this.view(s.grant);
    }
    this.shares.set(grant.id, { grant, at: this.now() });
    return this.view(grant);
  }

  /** The request started: its shares now last until it ends. */
  activate(): void {
    this.live();
    this.lapse();
    this.active = true;
  }

  /** Drop one share, or end the request: every share lapses and nothing more can be read. */
  revoke(shareId?: string): void {
    if (shareId !== undefined) {
      this.shares.delete(shareId);
      return;
    }
    this.shares.clear();
    this.ended = true;
  }

  /** What this request may read: its shares, then the zone's followed folders. */
  grants(): ShareGrant[] {
    if (this.ended) return [];
    this.lapse();
    const out = [...this.shares.values()].map((s) => this.view(s.grant));
    if (!this.follows) return out;
    const followed = this.follows.resources().list();
    for (const f of this.follows.list()) {
      out.push({ id: f.id, kind: "folder", scope: "zone", label: f.label, files: followed.filter((p) => p.startsWith(`${f.id}/`)) });
    }
    return out;
  }

  list(): ResourcePath[] {
    if (this.ended) return [];
    this.lapse();
    return [...[...this.shares.values()].flatMap((s) => s.grant.paths()), ...(this.follows?.resources().list() ?? [])];
  }

  async file(path: ResourcePath): Promise<SourceSnapshot> {
    const found = this.find(path);
    if ("resources" in found) return found.resources.file(path);
    const snap = this.guard(found.grant, () => found.grant.snapshot(found.rel));
    return { path, sourcePath: snap.abs, text: snap.text, sha: snap.sha, complete: true };
  }

  async read(path: ResourcePath, from: number, to: number): Promise<{ path: ResourcePath; text: string; sha: string; from: number }> {
    const found = this.find(path);
    if ("resources" in found) return found.resources.read(path, from, to);
    const snap = this.guard(found.grant, () => found.grant.snapshot(found.rel));
    return slice(path, snap.text, snap.sha, from, to);
  }

  async target(path: ResourcePath): Promise<{ absolute: string; currentSha: string | null }> {
    const found = this.find(path);
    if ("resources" in found) return found.resources.target(path);
    return this.guard(found.grant, () => found.grant.target(found.rel));
  }

  private view(grant: Grant): ShareGrant {
    return { id: grant.id, kind: grant.kind, scope: "request", label: grant.label, files: grant.paths() };
  }

  private live(): void {
    if (this.ended) throw new Error("that request is over - share again with your next message");
  }

  /** Selections nobody sent within the pending window lapse. */
  private lapse(): void {
    if (this.active) return;
    const now = this.now();
    for (const [id, s] of this.shares) if (now - s.at > SHARE_LIMITS.pendingMs) this.shares.delete(id);
  }

  private find(path: ResourcePath): { grant: Grant; rel: string } | { resources: Resources } {
    this.live();
    this.lapse();
    const parsed = parsePath(path);
    if (!parsed) throw new Error(`${path} isn't a shared file name - use a name from list_files`);
    const share = this.shares.get(parsed.id);
    if (share) return { grant: share.grant, rel: parsed.rel };
    if (this.follows?.list().some((f) => f.id === parsed.id)) return { resources: this.follows.resources() };
    throw new Error(`${path} isn't shared with this request - only the user can share it`);
  }

  /** A root that moved since consent is revoked, so it has to be shared again. */
  private guard<T>(grant: Grant, run: () => T): T {
    try {
      return run();
    } catch (err) {
      if (err instanceof Moved) this.shares.delete(grant.id);
      throw err;
    }
  }
}

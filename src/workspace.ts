// The project as dum may touch it: explicit bounded reads, read-only Git views, proposals saved as
// artifacts for your editor, and brand-new files that can never replace anything.
//
// Nothing here overwrites a project file. Existing files only ever get a proposal under
// .dum/proposals; new files are installed with an exclusive hard link, so a save from your editor
// that lands first always wins.

import { createHash, randomBytes } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
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
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { home as dumHome } from "./skills.ts";
import type { Store } from "./store.ts";

export type Artifact = { path: string; text: string; sha: string; from: number };

export const LIMITS = {
  /** Largest file read, proposed or created. */
  fileBytes: 256 * 1024,
  /** Longest excerpt. */
  excerptLines: 120,
  /** Diffs and command output shown in the conversation. */
  diffLines: 120,
  diffBytes: 64 * 1024,
  listFiles: 5000,
  gitMs: 10_000,
  gitBuffer: 8 * 1024 * 1024,
} as const;

/** Raised for a path outside the project, so a user command can offer :share instead. */
export class Outside extends Error {}

export function sha(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Path policy

const INTERNAL: Record<string, true> = { ".git": true, ".dum": true, node_modules: true };
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
/** Login-token profiles under ~/.config. Inside a project only there; outside, under any name. */
const PROFILE_DIRS: Record<string, true> = {
  gh: true,
  hub: true,
  op: true,
  "1Password": true,
  "github-copilot": true,
  "google-chrome": true,
  chromium: true,
};
const SECRET_FILE =
  /^(?:\.env(?:\..*)?|\.envrc|\.netrc|_netrc|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.git-credentials|\.htpasswd|\.pgpass|\.vault-token|\.claude\.json|credentials(?:(?:\.[A-Za-z0-9_-]+)*\.(?:json|toml|ya?ml|ini|xml|txt))?|auth\.json|tokens?\.json|secrets?\.(?:json|ya?ml|toml|env|txt)|service[-_]?account.*\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ovpn|gpg|tfstate|tfstate\.backup))$/i;

function outside(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** `path` itself or anything below it. */
function within(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return !rel || !outside(rel);
}

/** Why a project-relative path is off limits, or null. */
export function denied(rel: string): string | null {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  for (const [i, part] of parts.entries()) {
    if (INTERNAL[part]) return `${part} is dum's or Git's internal state, not project source`;
    if (SECRET_DIRS[part]) return `${part} holds credentials - dum never reads it`;
    if (PROFILE_DIRS[part] && parts[i - 1] === ".config") return `.config/${part} holds credentials - dum never reads it`;
  }
  if (parts.length && SECRET_FILE.test(parts.at(-1)!)) return `${parts.at(-1)} looks like credentials - dum never reads it`;
  return null;
}

function externalDenied(abs: string): string | null {
  if (/^\/(?:proc|sys|dev|run)(?:\/|$)/.test(abs)) return "system files can't be shared";
  if (within(realish(resolve(dumHome())), abs)) return "dum's own private state (your tree, its links and settings) can't be shared";
  const parts = abs.split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    if (SECRET_DIRS[part] || PROFILE_DIRS[part]) return `${part} holds credentials - dum never reads it, even shared`;
    if (part === ".git") return "Git internals can't be shared";
  }
  if (SECRET_FILE.test(parts.at(-1) ?? "")) return `${parts.at(-1)} looks like credentials - dum never reads it, even shared`;
  return null;
}

/** Why `root` can't be a project: it is /, your home directory, or a folder holding it. */
function tooBroad(root: string): string | null {
  let home = resolve(homedir());
  try {
    home = realpathSync(home);
  } catch {
    // no home directory on disk: compare the path as given
  }
  if (root === "/" || within(root, home)) {
    return `${root} holds your home directory - dum won't treat all of it as one project. cd into a project folder, or \`git init\` one`;
  }
  return null;
}

function expand(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
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

// ---------------------------------------------------------------------------------------------
// Bounded file IO

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** One regular file, never through a final symlink, never bigger than `max`. */
function readBounded(abs: string, max: number): Buffer {
  let fd: number;
  try {
    fd = openSync(abs, READ_FLAGS);
  } catch (err) {
    if (code(err) === "ELOOP") throw new Error(`${basename(abs)} is a symlink - dum won't follow it`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${basename(abs)} isn't a regular file`);
    if (st.size > max) throw new Error(`${basename(abs)} is ${Math.ceil(st.size / 1024)} KiB - dum reads files up to ${max / 1024} KiB`);
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    // A file that grew past the limit while being read is not a bounded read any more.
    if (readSync(fd, Buffer.alloc(1), 0, 1, got) !== 0) throw new Error(`${basename(abs)} is changing too fast to read - save it and try again`);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function text(buf: Buffer, name: string): string {
  if (buf.includes(0)) throw new Error(`${name} is a binary file`);
  return buf.toString("utf8");
}

/** Lines with their terminators, so a missing final newline is a real difference. */
function linesOf(body: string): string[] {
  return body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function plainLines(body: string): string[] {
  return linesOf(body).map((l) => l.replace(/\n$/, ""));
}

function numbered(body: string, from: number): string {
  const lines = body === "" ? [] : body.split("\n");
  const width = String(from + Math.max(lines.length - 1, 0)).length;
  return lines.map((l, i) => `${String(from + i).padStart(width)}  ${l}`).join("\n");
}

/** At most LIMITS.diffLines lines and LIMITS.diffBytes bytes, saying what was left out. */
export function bound(body: string, more = "the rest"): string {
  const lines = body.replace(/\n$/, "").split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length >= LIMITS.diffLines || bytes + Buffer.byteLength(line) + 1 > LIMITS.diffBytes) break;
    kept.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  const left = lines.length - kept.length;
  return left > 0 ? `${kept.join("\n")}\n… ${left} more line${left === 1 ? "" : "s"} - ${more}` : kept.join("\n");
}

const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** A complete temporary file in `dir`, synced to disk. The caller links or renames it. */
function tempFile(dir: string, name: string, body: string, mode: number): string {
  for (let attempt = 0; ; attempt++) {
    const temp = join(dir, `.${name}.dum-${randomBytes(6).toString("hex")}.tmp`);
    let fd: number;
    try {
      fd = openSync(temp, WRITE_FLAGS, mode);
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

/**
 * Install `body` as `dir/name` only if nothing is there. The bytes are complete before the name
 * appears, and link(2) refuses an existing name instead of replacing it. False when it exists.
 */
export function installExclusive(dir: string, name: string, body: string, mode: number, verify: () => void): boolean {
  const temp = tempFile(dir, name, body, mode);
  try {
    verify();
    linkSync(temp, join(dir, name));
    return true;
  } catch (err) {
    if (code(err) === "EEXIST") return false;
    if (code(err) === "EPERM" || code(err) === "ENOTSUP" || code(err) === "EOPNOTSUPP" || code(err) === "EXDEV") {
      throw new Error("this filesystem can't create files without risking a replace, so dum didn't create it");
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

/** A real directory, never a symlink. Creates it (private) when `create`; false when absent. */
function realDir(path: string, label: string, create: boolean, mode = 0o700): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error(`${label} is a symlink - dum won't follow it`);
      if (!st.isDirectory()) throw new Error(`${label} isn't a directory`);
      return true;
    } catch (err) {
      if (code(err) !== "ENOENT") throw err;
      if (!create) return false;
      try {
        mkdirSync(path, { mode });
      } catch (made) {
        if (code(made) !== "EEXIST") throw made;
      }
    }
  }
  throw new Error(`couldn't create ${label}`);
}

// ---------------------------------------------------------------------------------------------
// dum's own state under .dum

function stateParts(name: string): string[] {
  const parts = name.split("/");
  if (!name || parts.some((p) => !p || p === "." || p === ".." || p.includes("\\") || p.includes("\0"))) {
    throw new Error(`"${name}" isn't a state file name`);
  }
  return parts;
}

/** Walk .dum and the named subdirectories; every one must be a real directory. Null if absent. */
function stateDir(root: string, parts: string[], create: boolean): string | null {
  let dir = join(realpathSync(root), ".dum");
  let label = ".dum";
  if (!realDir(dir, label, create)) return null;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    label = `${label}/${part}`;
    if (!realDir(dir, label, create)) return null;
  }
  return dir;
}

function leafCheck(file: string, label: string): void {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) throw new Error(`${label} is a symlink - dum won't follow it`);
    if (!st.isFile()) throw new Error(`${label} isn't a regular file`);
  } catch (err) {
    if (code(err) !== "ENOENT") throw err;
  }
}

/** Absolute path of a state file under the project's .dum, with every directory verified real. */
export function statePath(root: string, name: string): string {
  const parts = stateParts(name);
  const file = join(stateDir(root, parts, true)!, parts.at(-1)!);
  leafCheck(file, `.dum/${name}`);
  return file;
}

/** A state file's text, or null when it doesn't exist. Symlinks anywhere refuse. */
export function readState(root: string, name: string, max: number = LIMITS.fileBytes): string | null {
  const parts = stateParts(name);
  const dir = stateDir(root, parts, false);
  if (!dir) return null;
  try {
    return readBounded(join(dir, parts.at(-1)!), max).toString("utf8");
  } catch (err) {
    if (code(err) === "ENOENT") return null;
    throw new Error(`.dum/${name}: ${(err as Error).message}`);
  }
}

/** Replace a state file atomically: a complete private temp file renamed over it. */
export function writeState(root: string, name: string, body: string): void {
  const file = statePath(root, name);
  const temp = tempFile(dirname(file), basename(file), body, 0o600);
  try {
    renameSync(temp, file);
  } catch (err) {
    unlinkSync(temp);
    throw err;
  }
}

/** Create a state file only if it doesn't exist yet; never replaces. False when it exists. */
export function createState(root: string, name: string, body: string): boolean {
  const file = statePath(root, name);
  const dir = dirname(file);
  return installExclusive(dir, basename(file), body, 0o600, () => {
    if (realpathSync(dir) !== dir) throw new Error(`.dum/${name}: its directory moved - dum didn't create it`);
  });
}

// ---------------------------------------------------------------------------------------------
// Git, read-only

const SAFE_GIT = [
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.pager=cat",
  "-c", "core.quotePath=false",
  "-c", "color.ui=false",
  "-c", "log.showSignature=false",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "protocol.allow=never",
];
// Dirty submodules would mean a nested `git status` under the submodule's own config, whose filter
// drivers noFilters never sees. A submodule moved to another commit still shows.
const SUBMODULES = "--ignore-submodules=dirty";
const DIFF_FLAGS = ["--relative", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--submodule=short", SUBMODULES];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ENV_KEEP = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "XDG_CONFIG_HOME"];

/** Only what Git needs: no GIT_DIR, GIT_EXTERNAL_DIFF, pager, askpass, fetching or anyone's credentials. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
  for (const key of ENV_KEEP) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

type GitOut = { stdout: string; stderr: string; code: number; truncated: boolean };

export function gitSync(root: string, args: string[]): GitOut {
  try {
    const stdout = execFileSync("git", [...SAFE_GIT, ...args], {
      cwd: root, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: LIMITS.gitMs, maxBuffer: LIMITS.gitBuffer, killSignal: "SIGKILL", shell: false,
    });
    return { stdout, stderr: "", code: 0, truncated: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null; stdout?: string; stderr?: string; signal?: string };
    if (e.code === "ENOENT") throw new Error("git isn't installed - dum needs it to see changes");
    if (e.code === "ENOBUFS") return { stdout: e.stdout ?? "", stderr: "", code: 0, truncated: true };
    if (e.signal) return { stdout: e.stdout ?? "", stderr: `git stopped after ${LIMITS.gitMs / 1000}s`, code: 124, truncated: true };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message, code: e.status ?? 1, truncated: false };
  }
}

const execFileAsync = promisify(execFile);

async function gitAsync(root: string, args: string[]): Promise<GitOut> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...SAFE_GIT, ...args], {
      cwd: root, env: gitEnv(), encoding: "utf8", timeout: LIMITS.gitMs, maxBuffer: LIMITS.gitBuffer,
      killSignal: "SIGKILL", shell: false, windowsHide: true,
    });
    return { stdout, stderr, code: 0, truncated: false };
  } catch (err) {
    const e = err as Error & { code?: string | number; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string };
    const stdout = e.stdout ?? "";
    if (e.code === "ENOENT") throw new Error("git isn't installed - dum needs it to see changes");
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { stdout, stderr: "", code: 0, truncated: true };
    if (e.killed || e.signal) return { stdout, stderr: `git stopped after ${LIMITS.gitMs / 1000}s`, code: 124, truncated: true };
    return { stdout, stderr: e.stderr ?? e.message, code: typeof e.code === "number" ? e.code : 1, truncated: false };
  }
}

/** Pathspecs taken literally, so `*` or `:(top)` in a name can't widen the set. */
function literal(paths: string[]): string[] {
  return paths.map((p) => `:(literal)${p}`);
}

function nul(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

/**
 * `-c` overrides that switch off every configured filter driver. .gitattributes picks drivers by
 * name, and status and diff would run their clean or process commands on changed worktree files.
 * Listing the configuration runs nothing; this is asked again before every worktree view.
 */
function noFilters(root: string): string[] {
  const out = gitSync(root, ["config", "-z", "--name-only", "--get-regexp", "^filter\\."]);
  if (out.code === 1 && !out.stdout) return [];
  if (out.code !== 0) throw new Error(`git couldn't read its filter settings: ${out.stderr.trim()}`);
  const names = new Set<string>();
  for (const key of nul(out.stdout)) {
    const dot = key.lastIndexOf(".");
    if (dot > "filter.".length) names.add(key.slice("filter.".length, dot));
  }
  const args: string[] = [];
  for (const name of names) {
    if (name.includes("=")) throw new Error(`the Git filter "${name}" has a name dum can't switch off - it won't show worktree changes`);
    args.push("-c", `filter.${name}.clean=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`);
  }
  return args;
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

/** A Git-style unified diff that `git apply` accepts. Empty when nothing changed. */
export function unifiedDiff(path: string, before: string | null, after: string, context = 3): string {
  const a = linesOf(before ?? "");
  const b = linesOf(after);
  const ops = lineOps(a, b);
  const changed = ops.map((o, i) => (o.kind === " " ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return "";
  const head = before === null
    ? [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`]
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
    const slice = ops.slice(start, stop + 1);
    const oldLen = slice.filter((x) => x.kind !== "+").length;
    const newLen = slice.filter((x) => x.kind !== "-").length;
    const oldStart = oldLen ? oldAt[start]! + 1 : oldAt[start]!;
    const newStart = newLen ? newAt[start]! + 1 : newAt[start]!;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (const op of slice) {
      out.push(`${op.kind}${op.line.replace(/\n$/, "")}`);
      if (!op.line.endsWith("\n")) out.push("\\ No newline at end of file");
    }
  }
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// The workspace

type Loaded = { rel: string; abs: string; buf: Buffer; body: string; sha: string };

const CATALOG = "dum runs only read-only Git views: status, diff [path], diff --staged, log [count]. Run builds, tests and scripts in your own terminal.";

export class Workspace {
  readonly root: string;
  private readonly git: boolean;
  private readonly store: Store | undefined;

  constructor(root: string, store?: Store) {
    this.root = realpathSync(root);
    const broad = tooBroad(this.root);
    if (broad) throw new Error(broad);
    this.store = store;
    this.git = gitSync(this.root, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
  }

  /** A project path checked lexically and through every existing symlink. Throws Outside. */
  private locate(path: string): { rel: string; abs: string } {
    if (!path || path.includes("\0")) throw new Error("give a file path");
    const abs = resolve(this.root, expand(path.trim()));
    const rel = relative(this.root, abs);
    if (!rel || outside(rel)) throw new Outside(`${path} is outside ${basename(this.root)}`);
    const lexical = denied(rel);
    if (lexical) throw new Error(lexical);
    const real = realish(abs);
    const realRel = relative(this.root, real);
    if (!realRel || outside(realRel)) throw new Error(`${rel} is a symlink that leaves ${basename(this.root)}`);
    const through = denied(realRel);
    if (through) throw new Error(`${rel} leads to ${realRel}: ${through}`);
    for (const p of new Set([rel, realRel])) if (this.ignored(p)) throw new Error(`${p} is ignored by .gitignore - dum leaves ignored files alone`);
    return { rel: rel.split(sep).join("/"), abs: real };
  }

  private ignored(rel: string): boolean {
    if (!this.git) return false;
    const out = gitSync(this.root, ["check-ignore", "-q", "--", rel]);
    if (out.code === 0) return true;
    if (out.code === 1) return false;
    throw new Error(`couldn't check whether ${rel} is ignored`);
  }

  private load(path: string): Loaded {
    const { rel, abs } = this.locate(path);
    let buf: Buffer;
    try {
      buf = readBounded(abs, LIMITS.fileBytes);
    } catch (err) {
      if (code(err) === "ENOENT") throw new Error(`${rel} doesn't exist`);
      if (code(err) === "EISDIR") throw new Error(`${rel} is a directory`);
      throw err;
    }
    // An ancestor swapped for a symlink between the check and the open would show up here.
    if (realpathSync(abs) !== abs) throw new Error(`${rel} moved while dum read it`);
    return { rel, abs, buf, body: text(buf, rel), sha: sha(buf) };
  }

  /** Tracked and untracked project files; ignored, secret, internal and escaping paths left out. */
  list(): string[] {
    if (!this.git) throw new Error(`${basename(this.root)} isn't a Git repository`);
    const out = gitSync(this.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (out.code !== 0) throw new Error(`git couldn't list files: ${out.stderr.trim()}`);
    const files: string[] = [];
    for (const rel of new Set(nul(out.stdout))) {
      if (files.length >= LIMITS.listFiles) break;
      if (denied(rel)) continue;
      const abs = join(this.root, rel);
      try {
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) {
          const real = realpathSync(abs);
          const realRel = relative(this.root, real);
          if (!realRel || outside(realRel) || denied(realRel) || !lstatSync(real).isFile()) continue;
        } else if (!st.isFile()) continue;
      } catch {
        continue; // deleted but still tracked, or a dangling link
      }
      files.push(rel);
    }
    return files.sort();
  }

  /** The whole file, up to LIMITS.fileBytes. */
  file(path: string): Artifact {
    const f = this.load(path);
    return { path: f.rel, text: f.body, sha: f.sha, from: 1 };
  }

  /** Lines `from`..`to` (1-based, at most LIMITS.excerptLines), with the whole file's SHA. */
  read(path: string, from = 1, to = 80): Artifact {
    const f = this.load(path);
    return slice(f.rel, f.body, f.sha, from, to);
  }

  /**
   * `path[:start[-end]]` shown in the conversation. Your outside files go through shareExternal,
   * which asks you first; dum can never reach outside the project.
   */
  async inspect(arg: string, by: "you" | "dum" = "you"): Promise<string> {
    const { path, from, to } = parseSpec(arg);
    let art: Artifact;
    let total: number;
    const course = this.course(path);
    if (course) {
      const body = readState(this.root, course);
      if (body === null) throw new Error(`.dum/${course} doesn't exist`);
      art = slice(`.dum/${course}`, body, sha(body), from, to);
      total = plainLines(body).length;
    } else {
      try {
        const f = this.load(path);
        art = slice(f.rel, f.body, f.sha, from, to);
        total = plainLines(f.body).length;
      } catch (err) {
        if (!(err instanceof Outside)) throw err;
        if (by === "dum") throw new Error(`${path} is outside the project - only they can share it, with :share`);
        const shared = await this.shareExternal(path);
        art = slice(shared.path, shared.text, shared.sha, from, to);
        total = plainLines(shared.text).length;
      }
    }
    const last = art.from + Math.max(art.text === "" ? 0 : art.text.split("\n").length - 1, 0);
    this.store?.excerpt(art.path, art.from, art.text, by);
    return `${art.path}:${art.from}-${last} of ${total} lines, sha256 ${art.sha}\n${numbered(art.text, art.from)}`;
  }

  /** `.dum/courses/<name>` is the one internal path you can show dum: your course scratch. */
  private course(path: string): string | null {
    const rel = relative(this.root, resolve(this.root, expand(path.trim())));
    const m = rel.split(sep).join("/").match(/^\.dum\/(courses\/.+)$/);
    return m ? m[1]! : null;
  }

  /**
   * One file outside the project, read once after you say yes. Credentials, system files and
   * directories are refused even when you approve.
   */
  async shareExternal(path: string): Promise<Artifact> {
    if (!path.trim() || path.includes("\0")) throw new Error("give a file path");
    const given = resolve(this.root, expand(path.trim()));
    const insideRel = relative(this.root, given);
    if (insideRel && !outside(insideRel)) return this.file(insideRel);
    if (!this.store) throw new Error("sharing a file outside the project needs your approval in dum");
    const before = externalDenied(given);
    if (before) throw new Error(before);
    let real: string;
    try {
      real = realpathSync(given);
    } catch (err) {
      if (code(err) === "ENOENT") throw new Error(`${given} doesn't exist`);
      throw err;
    }
    const why = externalDenied(real);
    if (why) throw new Error(why);
    const realRel = relative(this.root, real);
    if (realRel && !outside(realRel)) return this.file(realRel);
    if (!lstatSync(real).isFile()) throw new Error(`${real} isn't a regular file`);
    const answer = await this.store.askQuestion(
      `share ${real} with dum? (y/n)`,
      `it's outside ${basename(this.root)}; dum reads this one file once and nothing else there`,
      false,
      "share",
    );
    if (!/^\s*y(?:es)?\s*$/i.test(answer)) throw new Error(`not shared: ${real}`);
    if (realpathSync(given) !== real) throw new Error(`${given} changed where it points while you decided - not shared`);
    const buf = readBounded(real, LIMITS.fileBytes);
    return { path: real, text: text(buf, real), sha: sha(buf), from: 1 };
  }

  /** What changed since the last commit, as a bounded diff, tracked and untracked alike. */
  async changes(arg = "", by: "you" | "dum" = "you"): Promise<string> {
    const body = await this.diffText(arg.trim().split(/\s+/).filter(Boolean), false);
    const shown = bound(body || (arg.trim() ? `no changes in ${arg.trim()}` : "no changes since the last commit"), "use :inspect <path> for a whole file");
    this.store?.excerpt(arg.trim() || "working tree", 1, shown, by, "saved changes");
    return shown;
  }

  private async diffText(paths: string[], staged: boolean): Promise<string> {
    if (!this.git) throw new Error(`${basename(this.root)} isn't a Git repository`);
    const scope: string[] = [];
    for (const p of paths) {
      const abs = resolve(this.root, expand(p));
      const rel = relative(this.root, abs);
      if (!rel || outside(rel)) throw new Outside(`${p} is outside ${basename(this.root)}`);
      const why = denied(rel);
      if (why) throw new Error(why);
      scope.push(rel.split(sep).join("/"));
    }
    const spec = scope.length ? ["--", ...literal(scope)] : [];
    const base = gitSync(this.root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).code === 0 ? "HEAD" : EMPTY_TREE;
    const target = staged ? ["--cached", base] : [base];
    const guard = noFilters(this.root);
    const names = await gitAsync(this.root, [...guard, "diff", "--relative", "--name-only", "-z", "--no-renames", SUBMODULES, ...target, ...spec]);
    if (names.code !== 0) throw new Error(`git couldn't diff: ${names.stderr.trim()}`);
    const tracked = nul(names.stdout).filter((p) => !denied(p)).slice(0, 400);
    const parts: string[] = [];
    if (tracked.length) {
      const out = await gitAsync(this.root, [...guard, "diff", ...DIFF_FLAGS, "-U3", ...target, "--", ...literal(tracked)]);
      if (out.code !== 0) throw new Error(`git couldn't diff: ${out.stderr.trim()}`);
      if (out.stdout) parts.push(out.stdout.replace(/\n$/, ""));
    }
    if (!staged) {
      const others = await gitAsync(this.root, ["ls-files", "-z", "--others", "--exclude-standard", ...spec]);
      for (const rel of nul(others.stdout).filter((p) => !denied(p)).slice(0, 200)) parts.push(this.added(rel));
    }
    return parts.filter(Boolean).join("\n");
  }

  /** An untracked file shown the way Git shows an added one. */
  private added(rel: string): string {
    const head = `diff --git a/${rel} b/${rel}\nnew file (untracked)`;
    try {
      const f = this.load(rel);
      const diff = unifiedDiff(rel, null, f.body);
      return diff ? diff.replace(/\n$/, "").replace(/^diff --git[^\n]*\nnew file mode 100644/, head) : `${head}\n(empty file)`;
    } catch (err) {
      return `${head}\n(${(err as Error).message})`;
    }
  }

  /**
   * Refuses a path that goes through a symlink anywhere, even one that stays in the project: what
   * dum may change is decided by path, so another name for a file must not stand in for it.
   */
  private unaliased(rel: string): void {
    let at = this.root;
    for (const part of rel.split("/")) {
      at = join(at, part);
      try {
        if (lstatSync(at).isSymbolicLink()) throw new Error(`${rel} goes through the symlink ${relative(this.root, at)} - dum only proposes changes at a file's real path`);
      } catch (err) {
        if (code(err) === "ENOENT" || code(err) === "ENOTDIR") return;
        throw err;
      }
    }
  }

  /**
   * A change to an existing file, as a proposal. The file must still match the SHA dum read
   * (null means it must not exist yet). The project file is never written: the full patch is
   * saved once under .dum/proposals for you to review and apply in your editor.
   */
  propose(path: string, expectedSha: string | null, next: string): { diff: string; artifact: string } {
    const { rel } = this.locate(path);
    this.unaliased(rel);
    if (next.includes("\0") || Buffer.byteLength(next) > LIMITS.fileBytes) throw new Error(`a proposal must be text under ${LIMITS.fileBytes / 1024} KiB`);
    let current: Loaded | null = null;
    try {
      current = this.load(rel);
    } catch (err) {
      if (!/doesn't exist$/.test((err as Error).message)) throw err;
    }
    if (current && expectedSha === null) throw new Error(`${rel} already exists - read it first; dum proposes changes against what it read`);
    if (!current && expectedSha !== null) throw new Error(`${rel} no longer exists - it changed since dum read it, so no proposal was made`);
    if (current && current.sha !== expectedSha) throw new Error(`${rel} changed since dum read it - no proposal made; read it again`);
    const patch = unifiedDiff(rel, current ? current.body : null, next);
    if (!patch) throw new Error(`that proposal doesn't change ${rel}`);
    const body = [
      `# dum proposal for ${rel}`,
      `# baseline sha256 ${expectedSha ?? "(new file)"}`,
      `# nothing was applied: review it, then apply it in your editor or with git apply`,
      patch,
    ].join("\n");
    let name = "";
    for (let attempt = 0; !name; attempt++) {
      const when = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
      const what = rel.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(-60) || "file";
      const candidate = `proposals/${when}-${what}-${(expectedSha ?? "new").slice(0, 8)}-${randomBytes(3).toString("hex")}.patch`;
      if (createState(this.root, candidate, body)) name = candidate;
      else if (attempt >= 3) throw new Error("couldn't save the proposal");
    }
    const artifact = `.dum/${name}`;
    const diff = bound(patch, `the full patch is in ${artifact}`);
    this.store?.diff(rel, diff, "proposed", artifact);
    return { diff, artifact };
  }

  /**
   * A brand-new file. Every directory on the way must be real (created if missing), and the
   * file appears complete or not at all; if anything exists at that path, nothing changes.
   */
  create(path: string, content: string): void {
    const { rel } = this.locate(path);
    if (content.includes("\0") || Buffer.byteLength(content) > LIMITS.fileBytes) throw new Error(`a new file must be text under ${LIMITS.fileBytes / 1024} KiB`);
    const parts = rel.split("/");
    let dir = this.root;
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part);
      realDir(dir, relative(this.root, dir), true, 0o755);
    }
    const name = parts.at(-1)!;
    const target = join(dir, name);
    try {
      lstatSync(target);
      throw new Error(`${rel} already exists - dum never replaces a file; it can propose a change instead`);
    } catch (err) {
      if (code(err) !== "ENOENT") throw err;
    }
    const made = installExclusive(dir, name, content, 0o666, () => {
      if (realpathSync(dir) !== dir) throw new Error(`${rel}: a directory on the way became a symlink - not created`);
    });
    if (!made) throw new Error(`${rel} appeared while dum was creating it - yours was kept, dum's discarded`);
    this.store?.diff(rel, bound(unifiedDiff(rel, null, content), "open the file in your editor"), "created");
  }

  /** One of a fixed set of read-only Git views. Never a shell, never anything else. */
  async run(action: string): Promise<{ output: string; code: number }> {
    const cmd = action.trim().replace(/^git\s+/, "").replace(/\s+/g, " ");
    let label: string;
    let out: { output: string; code: number };
    let m: RegExpMatchArray | null;
    if (cmd === "status") {
      label = "git status";
      out = await this.status();
    } else if (/^diff (?:--staged|--cached)$/.test(cmd)) {
      label = "git diff --staged";
      out = { output: bound(await this.diffText([], true) || "nothing staged", "narrow it with :changes <path>"), code: 0 };
    } else if ((m = cmd.match(/^diff(?: (.+))?$/))) {
      label = `git diff${m[1] ? ` ${m[1]}` : ""}`;
      out = { output: bound(await this.diffText(m[1] ? m[1].split(" ") : [], false) || "no changes", "narrow it with :changes <path>"), code: 0 };
    } else if ((m = cmd.match(/^log(?: (?:-n ?)?(\d{1,3}))?$/))) {
      const count = Math.min(Number(m[1] ?? 20) || 20, 100);
      label = `git log -n ${count}`;
      const r = await gitAsync(this.root, ["log", "--oneline", "--no-color", "--decorate=short", "-n", String(count)]);
      out = { output: bound((r.stdout || r.stderr).trim() || "no commits yet"), code: r.code };
    } else {
      throw new Error(`can't run "${action.trim()}" - ${CATALOG}`);
    }
    this.store?.result(label, out.output, out.code);
    return out;
  }

  private async status(): Promise<{ output: string; code: number }> {
    const r = await gitAsync(this.root, [...noFilters(this.root), "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all", SUBMODULES]);
    if (r.code !== 0) return { output: bound(r.stderr.trim()), code: r.code };
    const tokens = nul(r.stdout);
    const lines: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.startsWith("## ")) { lines.push(t); continue; }
      const xy = t.slice(0, 2);
      const path = t.slice(3);
      const from = /[RC]/.test(xy) ? tokens[++i] : undefined;
      if (denied(path) || (from && denied(from))) continue;
      lines.push(`${xy} ${from ? `${from} -> ` : ""}${path}`);
    }
    return { output: bound(lines.join("\n") || "clean"), code: 0 };
  }
}

function slice(path: string, body: string, digest: string, from: number, to: number): Artifact {
  const lines = plainLines(body);
  const first = Math.min(Math.max(1, Math.floor(from) || 1), Math.max(lines.length, 1));
  const want = Math.max(Math.floor(to) || first, first);
  const last = Math.min(want, first + LIMITS.excerptLines - 1, Math.max(lines.length, first));
  return { path, text: lines.slice(first - 1, last).join("\n"), sha: digest, from: first };
}

/** `path`, `path:12` or `path:12-40`. */
export function parseSpec(arg: string): { path: string; from: number; to: number } {
  const m = arg.trim().match(/^(.*?)(?::(\d+)(?:-(\d+))?)?$/);
  const path = (m?.[1] ?? arg).trim();
  if (!path) throw new Error("give a file path, like src/main.py:10-30");
  const from = m?.[2] ? Number(m[2]) : 1;
  const to = m?.[3] ? Number(m[3]) : m?.[2] ? from + 39 : 80;
  return { path, from, to };
}

// Public notes: short, bounded, explicitly published pages that the owner writes on purpose.
//
// Two trees, both owned here and nowhere else:
//   private  <workshop home>/public-notes/<uuid>/revision-<n>.json   0700 dirs, 0600 files
//   public   <DUM_PUBLIC_NOTES_DIR>/                                   0755 dirs, 0644 files
//            index.html, notes.css, notes/<uuid>/index.html, notes/<uuid>/page-N.html,
//            topics/<slug>/index.html
//
// A revision file is written once and never rewritten; a revise adds revision-<n+1>.json. The
// public tree is a deterministic projection of the latest revision of every note, rebuilt whole on
// each create or revise and at configured startup. This module reads only its own revision files:
// never the workshop state, goals, teachings, jobs or context. What is published is exactly what
// was validated from the explicit payload, HTML-escaped.
//
// The public root is provisioned by the hosting owner. It must be a real directory on a canonical
// path, disjoint from the workshop home (and so from the artifact tree). Every write re-checks the
// root and each component beneath it; a symlink anywhere on the way is refused, not followed.

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { WorkshopError } from "./errors.ts";
import { ensurePrivateDir, intendedRealPath, isWithin, readPrivateFile } from "./files.ts";

// ---------------------------------------------------------------------------------------------
// Limits and shapes

export const NOTES_SITE_ORIGIN = "https://notes.ryhub.dev";
export const NOTES_SITE_TITLE = "ry's notes";
export const EMPTY_HOMEPAGE_TEXT = "No public notes yet.";

export const MAX_NOTE_TITLE = 160;
export const MAX_NOTE_TOPIC = 80;
export const MIN_NOTE_PAGES = 1;
export const MAX_NOTE_PAGES = 12;
export const MAX_PAGE_HEADING = 160;
export const MAX_PAGE_TEXT = 4000;
export const MAX_PAGE_CODE = 4000;
export const MAX_NOTE_LINKS = 8;
export const MAX_LINK_LABEL = 120;
export const MAX_LINK_URL = 500;
/** The serialized payload ceiling, the same as the API body limit. */
export const MAX_NOTE_BODY_BYTES = 32 * 1024;
/** A revision file on disk is the payload plus a little metadata. */
const MAX_REVISION_FILE_BYTES = 64 * 1024;
const MAX_NOTES_LISTED = 5000;
const MAX_REVISIONS_PER_NOTE = 100_000;

const NOTE_SCHEMA_VERSION = 1;
const PRIVATE_DIR = "public-notes";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION_FILE = /^revision-([1-9]\d{0,8})\.json$/;
const PAGE_FILE = /^page-([1-9]\d{0,3})\.html$/;
const TOPIC_SLUG = /^[a-z0-9][a-z0-9-]{0,39}-[0-9a-f]{10}$/;
const CSS_FILE = "notes.css";
const TOPIC_DIR = "topics";
const NOTES_DIR = "notes";

export type NotePage = { heading: string; text: string; code?: string };
export type NoteLink = { label: string; url: string };
export type NotePayload = { title: string; topic: string; pages: NotePage[]; links?: NoteLink[] };

/** One immutable revision as stored privately. */
export type NoteRevision = NotePayload & {
  schemaVersion: number;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** What the API hands back: the latest revision plus its stable public URL. */
export type NoteRecord = NoteRevision & { url: string };

export type NoteSummary = {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  title: string;
  topic: string;
  pageCount: number;
  url: string;
};

export type PublicNotesOptions = {
  /** The workshop store's canonical home; revisions live under <home>/public-notes. */
  home: string;
  /** The hosting owner's public directory (DUM_PUBLIC_NOTES_DIR). Must already exist. */
  publicRoot: string;
  /** Other private trees the public root must not overlap. The home is always included. */
  reserved?: string[];
};

/** Thrown when the revision was saved but the public pages could not be (re)built. */
export class NotesProjectionError extends Error {
  readonly note: NoteRecord;
  constructor(note: NoteRecord, cause: unknown) {
    super(`note ${note.id} revision ${note.revision} is saved privately, but its public pages could not be written: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "NotesProjectionError";
    this.note = note;
  }
}

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

// ---------------------------------------------------------------------------------------------
// Payload validation: strict strings, closed shapes, HTTPS-only links.

// Lone surrogates can come out of JSON.parse; they are not text we publish.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// C0 controls except tab/newline, DEL, C1 controls, line/paragraph separators.
const CONTROL_MULTILINE = /[\0-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u2028\u2029]/;
// Any control at all, for one-line fields.
const CONTROL_ANY = /[\0-\x1F\x7F-\x9F\u2028\u2029]/;

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw WorkshopError.invalid(`${what} has an unknown field "${key.slice(0, 40)}"; only ${allowed.join(", ")} are accepted`);
  }
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw WorkshopError.invalid(`${what} must be an object`);
  return value as Record<string, unknown>;
}

/** A required string: well-formed, no control characters (newlines and tabs allowed only when `multiline`), non-blank, bounded. */
function requireStrictString(value: unknown, what: string, max: number, multiline: boolean): string {
  if (typeof value !== "string") throw WorkshopError.invalid(`${what} must be a string`);
  if (value.length > max) throw WorkshopError.invalid(`${what} must be at most ${max} characters`);
  if (LONE_SURROGATE.test(value)) throw WorkshopError.invalid(`${what} contains malformed text`);
  if ((multiline ? CONTROL_MULTILINE : CONTROL_ANY).test(value)) throw WorkshopError.invalid(`${what} contains control characters`);
  if (value.trim() === "") throw WorkshopError.invalid(`${what} must not be blank`);
  return value;
}

function requireLink(value: unknown, what: string): NoteLink {
  const obj = requireObject(value, what);
  rejectUnknownKeys(obj, ["label", "url"], what);
  const label = requireStrictString(obj.label, `${what}.label`, MAX_LINK_LABEL, false);
  const raw = requireStrictString(obj.url, `${what}.url`, MAX_LINK_URL, false);
  if (/\s/.test(raw)) throw WorkshopError.invalid(`${what}.url must not contain whitespace`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw WorkshopError.invalid(`${what}.url is not an absolute URL`);
  }
  if (url.protocol !== "https:") throw WorkshopError.invalid(`${what}.url must use https`);
  if (url.username || url.password) throw WorkshopError.invalid(`${what}.url must not carry credentials`);
  if (!url.hostname) throw WorkshopError.invalid(`${what}.url needs a host`);
  if (url.href.length > MAX_LINK_URL) throw WorkshopError.invalid(`${what}.url must be at most ${MAX_LINK_URL} characters`);
  if (CONTROL_ANY.test(url.href) || /\s/.test(url.href)) throw WorkshopError.invalid(`${what}.url contains control characters`);
  return { label, url: url.href };
}

function requirePage(value: unknown, what: string): NotePage {
  const obj = requireObject(value, what);
  rejectUnknownKeys(obj, ["heading", "text", "code"], what);
  const page: NotePage = {
    heading: requireStrictString(obj.heading, `${what}.heading`, MAX_PAGE_HEADING, false),
    text: requireStrictString(obj.text, `${what}.text`, MAX_PAGE_TEXT, true),
  };
  if (obj.code !== undefined) page.code = requireStrictString(obj.code, `${what}.code`, MAX_PAGE_CODE, true);
  return page;
}

/**
 * The one validator for a note, used by the API and the CLI alike. Accepts exactly
 * {title, topic, pages: [{heading, text, code?}], links?: [{label, url}]} and nothing else, so a
 * payload that drags along any other field is refused rather than partly accepted.
 */
export function validateNotePayload(value: unknown): NotePayload {
  const obj = requireObject(value, "note");
  rejectUnknownKeys(obj, ["title", "topic", "pages", "links"], "note");
  const title = requireStrictString(obj.title, "title", MAX_NOTE_TITLE, false);
  const topic = requireStrictString(obj.topic, "topic", MAX_NOTE_TOPIC, false);
  if (!Array.isArray(obj.pages)) throw WorkshopError.invalid("pages must be an array");
  if (obj.pages.length < MIN_NOTE_PAGES || obj.pages.length > MAX_NOTE_PAGES) {
    throw WorkshopError.invalid(`pages must hold ${MIN_NOTE_PAGES} to ${MAX_NOTE_PAGES} pages`);
  }
  const pages = obj.pages.map((p, i) => requirePage(p, `pages[${i}]`));
  const out: NotePayload = { title, topic, pages };
  if (obj.links !== undefined) {
    if (!Array.isArray(obj.links)) throw WorkshopError.invalid("links must be an array");
    if (obj.links.length > MAX_NOTE_LINKS) throw WorkshopError.invalid(`links must hold at most ${MAX_NOTE_LINKS} links`);
    out.links = obj.links.map((l, i) => requireLink(l, `links[${i}]`));
  }
  const bytes = Buffer.byteLength(JSON.stringify(out), "utf8");
  if (bytes > MAX_NOTE_BODY_BYTES) throw WorkshopError.invalid(`the note is ${bytes} bytes serialized; the limit is ${MAX_NOTE_BODY_BYTES}`);
  return out;
}

/** The public URL every revision of a note keeps. */
export function noteUrl(id: string): string {
  return `${NOTES_SITE_ORIGIN}/notes/${id}/`;
}

/** A deterministic, filesystem- and URL-safe directory name for a topic: readable prefix plus a hash of the exact topic. */
export function topicSlug(topic: string): string {
  const readable = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  const hash = createHash("sha256").update(topic, "utf8").digest("hex").slice(0, 10);
  return `${readable || "topic"}-${hash}`;
}

// ---------------------------------------------------------------------------------------------
// HTML: everything that came from a payload goes through escape(); the templates hold no JS.

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

export const NOTES_CSS = `html{background:#f7f5f0;color:#1d1d1b}
body{max-width:700px;margin:2rem auto;padding:0 1rem;font:1.05rem/1.55 Georgia,"Times New Roman",serif}
a{color:#1a4fb4;text-decoration:underline}
h1,h2{line-height:1.25;font-weight:normal}
h1{font-size:1.7rem;margin:0 0 .5rem}
h2{font-size:1.3rem;margin:1.5rem 0 .5rem}
.meta,.position{color:#55534d;font-size:.9rem}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
pre{background:#eeebe3;padding:.75rem;overflow:auto;font:.9rem/1.4 ui-monospace,Menlo,Consolas,monospace}
nav.pager{margin:2rem 0 1rem;display:flex;gap:1.5rem}
ol.notes,ul.links{padding-left:1.25rem}
ol.notes li{margin:.4rem 0}
footer{margin-top:2.5rem;font-size:.9rem;color:#55534d}
`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="stylesheet" href="/${CSS_FILE}">
</head>
<body>
${body}</body>
</html>
`;
}

function indexEntry(n: NoteRevision): string {
  return `<li><span class="meta">${escape(dateOf(n.createdAt))}</span> <a href="/${NOTES_DIR}/${n.id}/">${escape(n.title)}</a> <span class="meta">in <a href="/${TOPIC_DIR}/${topicSlug(n.topic)}/">${escape(n.topic)}</a></span></li>`;
}

export function renderHomepage(notes: NoteRevision[]): string {
  const list = notes.length === 0
    ? `<p>${escape(EMPTY_HOMEPAGE_TEXT)}</p>\n`
    : `<ol class="notes">\n${notes.map(indexEntry).join("\n")}\n</ol>\n`;
  return layout(NOTES_SITE_TITLE, `<h1>${escape(NOTES_SITE_TITLE)}</h1>\n${list}`);
}

/** A topic's notes; with `topic` null the directory belongs to a topic no current note uses, and says so. */
export function renderTopicIndex(topic: string | null, notes: NoteRevision[]): string {
  const list = notes.length === 0
    ? `<p>No public notes are filed under this topic.</p>\n`
    : `<ol class="notes">\n${notes.map(indexEntry).join("\n")}\n</ol>\n`;
  const heading = topic === null ? "Topic" : topic;
  return layout(`${heading} - ${NOTES_SITE_TITLE}`, `<p class="meta"><a href="/">${escape(NOTES_SITE_TITLE)}</a></p>\n<h1>${escape(heading)}</h1>\n${list}`);
}

/** The file name page `k` (1-based) lives at inside the note directory. */
export function pageFileName(k: number): string {
  return k === 1 ? "index.html" : `page-${k}.html`;
}

export function renderNotePage(note: NoteRevision, k: number): string {
  const page = note.pages[k - 1];
  if (!page) throw new Error(`note ${note.id} has no page ${k}`);
  const total = note.pages.length;
  const revised = note.revision > 1 ? ` <span class="meta">(revised ${escape(dateOf(note.updatedAt))})</span>` : "";
  const parts: string[] = [];
  parts.push(`<p class="meta"><a href="/">${escape(NOTES_SITE_TITLE)}</a></p>`);
  parts.push(`<h1>${escape(note.title)}</h1>`);
  parts.push(`<p class="meta"><a href="/${TOPIC_DIR}/${topicSlug(note.topic)}/">${escape(note.topic)}</a> · ${escape(dateOf(note.createdAt))}${revised}</p>`);
  parts.push(`<p class="position">Page ${k} of ${total}</p>`);
  parts.push(`<h2>${escape(page.heading)}</h2>`);
  parts.push(`<p class="text">${escape(page.text)}</p>`);
  if (page.code !== undefined) parts.push(`<pre><code>${escape(page.code)}</code></pre>`);
  const nav: string[] = [];
  if (k > 1) nav.push(`<a rel="prev" href="/${NOTES_DIR}/${note.id}/${pageFileName(k - 1)}">Previous</a>`);
  if (k < total) nav.push(`<a rel="next" href="/${NOTES_DIR}/${note.id}/${pageFileName(k + 1)}">Next</a>`);
  nav.push(`<a href="/">Home</a>`);
  parts.push(`<nav class="pager">${nav.join(" ")}</nav>`);
  if (note.links && note.links.length > 0) {
    const items = note.links.map((l) => `<li><a href="${escape(l.url)}" rel="noopener">${escape(l.label)}</a></li>`);
    parts.push(`<footer>Sources\n<ul class="links">\n${items.join("\n")}\n</ul>\n</footer>`);
  }
  return layout(`${note.title} (${k}/${total}) - ${NOTES_SITE_TITLE}`, `${parts.join("\n")}\n`);
}

// ---------------------------------------------------------------------------------------------
// Private revision files

function parseRevision(text: string, path: string): NoteRevision {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw WorkshopError.corrupt(`${path} is not valid JSON`);
  }
  const obj = requireObject(raw, path);
  const { schemaVersion, id, revision, createdAt, updatedAt, ...payload } = obj;
  if (schemaVersion !== NOTE_SCHEMA_VERSION) throw WorkshopError.corrupt(`${path} has schema version ${String(schemaVersion)}, expected ${NOTE_SCHEMA_VERSION}`);
  if (typeof id !== "string" || !UUID.test(id)) throw WorkshopError.corrupt(`${path} has no valid id`);
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) throw WorkshopError.corrupt(`${path} has no valid revision`);
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw WorkshopError.corrupt(`${path} has no valid createdAt`);
  if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) throw WorkshopError.corrupt(`${path} has no valid updatedAt`);
  let valid: NotePayload;
  try {
    valid = validateNotePayload(payload);
  } catch (err) {
    throw WorkshopError.corrupt(`${path} holds an invalid note: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { schemaVersion: NOTE_SCHEMA_VERSION, id, revision, createdAt, updatedAt, ...valid };
}

function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf8");
  let put = 0;
  while (put < buf.length) put += writeSync(fd, buf, put, buf.length - put);
}

function syncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A complete, synced temporary file beside `path` with the given mode; the caller links or renames it. */
function tempBeside(path: string, text: string, mode: number): string {
  const dir = dirname(path);
  for (let attempt = 0; ; attempt++) {
    const temp = join(dir, `.${basename(path)}.${randomUUID().slice(0, 12)}.tmp`);
    let fd: number;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    } catch (err) {
      if (code(err) === "EEXIST" && attempt < 3) continue;
      throw err;
    }
    try {
      writeAll(fd, text);
      fchmodSync(fd, mode); // the process umask (0077 under systemd) must not shrink the requested mode
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

/** Create `path` from a complete temp file via link(2), which fails rather than replace. Never overwrites. */
function createPrivateFileOnce(path: string, text: string): void {
  const temp = tempBeside(path, text, 0o600);
  try {
    linkSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* already gone */ }
    if (code(err) === "EEXIST") throw WorkshopError.conflict(`${basename(path)} already exists; revisions are never rewritten`);
    throw err;
  }
  unlinkSync(temp);
  syncDir(dirname(path));
}

// ---------------------------------------------------------------------------------------------
// Public tree writes: every component checked at write time, nothing followed.

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (code(err) === "ENOENT") return null;
    throw err;
  }
}

/** Replace `path` atomically with a 0644 file; refuses a symlink or non-file in its place. */
function writePublicFile(path: string, text: string): void {
  const st = lstatOrNull(path);
  if (st) {
    if (st.isSymbolicLink()) throw new Error(`${path} is a symlink; the notes projection won't replace it`);
    if (!st.isFile()) throw new Error(`${path} isn't a regular file`);
  }
  const temp = tempBeside(path, text, 0o644);
  try {
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* already gone */ }
    throw err;
  }
  syncDir(dirname(path));
}

/** Make `path` a real 0755 directory; refuses a symlink or non-directory in its place. */
function ensurePublicDir(path: string): void {
  const st = lstatOrNull(path);
  if (st) {
    if (st.isSymbolicLink()) throw new Error(`${path} is a symlink; the notes projection won't use it`);
    if (!st.isDirectory()) throw new Error(`${path} isn't a directory`);
  } else {
    mkdirSync(path, { mode: 0o755 });
    const after = lstatSync(path);
    if (after.isSymbolicLink() || !after.isDirectory()) throw new Error(`${path} changed while being created`);
  }
  chmodSync(path, 0o755);
}

// ---------------------------------------------------------------------------------------------

export class PublicNotes {
  readonly home: string;
  readonly privateRoot: string;
  readonly publicRoot: string;

  constructor(options: PublicNotesOptions) {
    if (typeof options.home !== "string" || !options.home.trim()) throw WorkshopError.invalid("public notes need the workshop home");
    const home = resolve(options.home);
    if (intendedRealPath(home) !== home) throw WorkshopError.invalid(`workshop home ${home} must be canonical for public notes`);
    this.home = home;
    this.privateRoot = join(home, PRIVATE_DIR);
    this.publicRoot = PublicNotes.preparePublicRoot(options.publicRoot, [home, ...(options.reserved ?? [])]);
    ensurePrivateDir(this.privateRoot);
  }

  /**
   * The public root must be given absolutely, exist as a real directory, be canonical (no symlink
   * in it or above it), and share no path with the workshop home or any other reserved tree in
   * either direction. Nothing is created: the hosting owner provisions it.
   */
  private static preparePublicRoot(supplied: unknown, reserved: string[]): string {
    if (typeof supplied !== "string" || !supplied.trim()) throw WorkshopError.invalid("DUM_PUBLIC_NOTES_DIR must name the public notes directory");
    const root = supplied.trim().replace(/(.)\/+$/, "$1");
    if (!isAbsolute(root)) throw WorkshopError.invalid(`DUM_PUBLIC_NOTES_DIR ${root} must be an absolute path`);
    const normalized = resolve(root);
    if (normalized !== root) throw WorkshopError.invalid(`DUM_PUBLIC_NOTES_DIR ${root} must be a plain path without . or .. segments`);
    if (normalized === "/") throw WorkshopError.invalid("DUM_PUBLIC_NOTES_DIR must not be the filesystem root");
    let real: string;
    try {
      real = realpathSync(normalized);
    } catch (err) {
      throw WorkshopError.invalid(`DUM_PUBLIC_NOTES_DIR ${normalized} can't be used: ${code(err) === "ENOENT" ? "it does not exist; the hosting owner provisions it" : (err instanceof Error ? err.message : String(err))}`);
    }
    if (real !== normalized) throw WorkshopError.invalid(`DUM_PUBLIC_NOTES_DIR ${normalized} must be canonical; it resolves to ${real}`);
    const st = lstatSync(normalized);
    if (st.isSymbolicLink() || !st.isDirectory()) throw WorkshopError.invalid(`DUM_PUBLIC_NOTES_DIR ${normalized} must be a real directory`);
    for (const other of reserved) {
      const otherReal = intendedRealPath(other);
      if (isWithin(normalized, otherReal) || isWithin(otherReal, normalized)) {
        throw WorkshopError.invalid(`DUM_PUBLIC_NOTES_DIR ${normalized} overlaps the private tree ${otherReal}; the public root must be disjoint from the workshop`);
      }
    }
    return normalized;
  }

  /** Re-check the root right before writing: still the same real directory, still disjoint. */
  private checkPublicRoot(): void {
    const st = lstatOrNull(this.publicRoot);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${this.publicRoot} is no longer a real directory`);
    if (realpathSync(this.publicRoot) !== this.publicRoot) throw new Error(`${this.publicRoot} is no longer canonical`);
    if (isWithin(this.publicRoot, this.home) || isWithin(this.home, this.publicRoot)) throw new Error(`${this.publicRoot} overlaps the workshop home`);
  }

  // -- private records --------------------------------------------------------------------------
  private checkPrivateRoot(): void {
    for (const path of [this.home, this.privateRoot]) {
      const st = lstatOrNull(path);
      if (!st || st.isSymbolicLink() || !st.isDirectory() || realpathSync(path) !== path) {
        throw WorkshopError.corrupt(`${path} is no longer a canonical private directory`);
      }
    }
  }


  private noteDir(id: string): string {
    this.checkPrivateRoot();
    return join(this.privateRoot, id);
  }

  /** Revision numbers present for a note, ascending; [] when the note has no directory. */
  private revisionNumbers(id: string): number[] {
    const dir = this.noteDir(id);
    const st = lstatOrNull(dir);
    if (!st) return [];
    if (st.isSymbolicLink() || !st.isDirectory()) throw WorkshopError.corrupt(`${dir} isn't a private note directory`);
    const numbers: number[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const m = REVISION_FILE.exec(entry.name);
      if (!m || !entry.isFile()) continue;
      const n = Number(m[1]);
      if (n <= MAX_REVISIONS_PER_NOTE) numbers.push(n);
    }
    return numbers.sort((a, b) => a - b);
  }

  private readRevision(id: string, revision: number): NoteRevision {
    const path = join(this.noteDir(id), `revision-${revision}.json`);
    const text = readPrivateFile(path, MAX_REVISION_FILE_BYTES);
    if (text === null) throw WorkshopError.notFound(`note ${id} has no revision ${revision}`);
    const rev = parseRevision(text, path);
    if (rev.id !== id || rev.revision !== revision) throw WorkshopError.corrupt(`${path} describes ${rev.id} revision ${rev.revision}`);
    return rev;
  }

  private latestOrNull(id: string): NoteRevision | null {
    const numbers = this.revisionNumbers(id);
    if (numbers.length === 0) return null;
    return this.readRevision(id, numbers[numbers.length - 1]!);
  }

  /** Every note's latest revision, oldest creation first, ties broken by id. Reads only revision files. */
  private latestAll(): NoteRevision[] {
    this.checkPrivateRoot();
    const out: NoteRevision[] = [];
    const ids: string[] = [];
    for (const entry of readdirSync(this.privateRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && UUID.test(entry.name)) ids.push(entry.name);
    }
    ids.sort();
    if (ids.length > MAX_NOTES_LISTED) throw WorkshopError.corrupt(`more than ${MAX_NOTES_LISTED} notes under ${this.privateRoot}`);
    for (const id of ids) {
      const latest = this.latestOrNull(id);
      if (latest) out.push(latest);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  private static withUrl(rev: NoteRevision): NoteRecord {
    return { ...structuredClone(rev), url: noteUrl(rev.id) };
  }

  static summarize(rev: NoteRevision): NoteSummary {
    return { id: rev.id, revision: rev.revision, createdAt: rev.createdAt, updatedAt: rev.updatedAt, title: rev.title, topic: rev.topic, pageCount: rev.pages.length, url: noteUrl(rev.id) };
  }

  private storeRevision(rev: NoteRevision): void {
    const dir = this.noteDir(rev.id);
    ensurePrivateDir(dir);
    createPrivateFileOnce(join(dir, `revision-${rev.revision}.json`), `${JSON.stringify(rev, null, 2)}\n`);
  }

  // -- public API ---------------------------------------------------------------------------------

  list(): NoteSummary[] {
    return this.latestAll().map(PublicNotes.summarize);
  }

  get(id: string): NoteRecord {
    if (typeof id !== "string" || !UUID.test(id)) throw WorkshopError.invalid("note id must be a lowercase UUID");
    const latest = this.latestOrNull(id);
    if (!latest) throw WorkshopError.notFound(`no public note ${id}`);
    return PublicNotes.withUrl(latest);
  }

  /** Validate, persist revision 1, then rebuild the public tree. A failed rebuild surfaces as NotesProjectionError with the saved note. */
  create(payload: unknown): NoteRecord {
    const valid = validateNotePayload(payload);
    const now = new Date().toISOString();
    let id = randomUUID();
    while (lstatOrNull(this.noteDir(id))) id = randomUUID();
    const rev: NoteRevision = { schemaVersion: NOTE_SCHEMA_VERSION, id, revision: 1, createdAt: now, updatedAt: now, ...valid };
    this.storeRevision(rev);
    return this.project(rev);
  }

  /** Validate, persist revision n+1 without touching older ones, then rebuild. */
  revise(id: string, payload: unknown): NoteRecord {
    if (typeof id !== "string" || !UUID.test(id)) throw WorkshopError.invalid("note id must be a lowercase UUID");
    const valid = validateNotePayload(payload);
    const latest = this.latestOrNull(id);
    if (!latest) throw WorkshopError.notFound(`no public note ${id}`);
    const rev: NoteRevision = {
      schemaVersion: NOTE_SCHEMA_VERSION,
      id,
      revision: latest.revision + 1,
      createdAt: latest.createdAt,
      updatedAt: new Date().toISOString(),
      ...valid,
    };
    this.storeRevision(rev);
    return this.project(rev);
  }

  private project(rev: NoteRevision): NoteRecord {
    const record = PublicNotes.withUrl(rev);
    try {
      this.rebuild();
    } catch (err) {
      throw new NotesProjectionError(record, err);
    }
    return record;
  }

  /**
   * Write the whole public tree from the latest revisions: homepage, stylesheet, every note's
   * pages, every topic index. Pages beyond a note's current count are removed; nothing else is
   * ever deleted. Deterministic for the same records, so a restart reproduces the same bytes.
   */
  rebuild(): void {
    const notes = this.latestAll();
    this.checkPublicRoot();
    const root = this.publicRoot;
    writePublicFile(join(root, CSS_FILE), NOTES_CSS);
    const notesDir = join(root, NOTES_DIR);
    ensurePublicDir(notesDir);
    for (const note of notes) {
      const dir = join(notesDir, note.id);
      ensurePublicDir(dir);
      for (let k = 1; k <= note.pages.length; k++) writePublicFile(join(dir, pageFileName(k)), renderNotePage(note, k));
      this.removeStalePages(dir, note.pages.length);
    }
    const topicsDir = join(root, TOPIC_DIR);
    ensurePublicDir(topicsDir);
    const byTopic = new Map<string, NoteRevision[]>();
    for (const note of notes) {
      const group = byTopic.get(note.topic) ?? [];
      group.push(note);
      byTopic.set(note.topic, group);
    }
    const liveSlugs = new Set<string>();
    for (const [topic, group] of [...byTopic.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const slug = topicSlug(topic);
      liveSlugs.add(slug);
      const dir = join(topicsDir, slug);
      ensurePublicDir(dir);
      writePublicFile(join(dir, "index.html"), renderTopicIndex(topic, group));
    }
    // A topic directory this projection made earlier but no note uses now gets a truthful empty index; it is not deleted.
    for (const entry of readdirSync(topicsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !TOPIC_SLUG.test(entry.name) || liveSlugs.has(entry.name)) continue;
      const index = join(topicsDir, entry.name, "index.html");
      const st = lstatOrNull(index);
      if (st && st.isFile()) writePublicFile(index, renderTopicIndex(null, []));
    }
    writePublicFile(join(root, "index.html"), renderHomepage(notes));
  }

  /** Inside one owned note directory, unlink page-N.html files with N beyond the current page count. Regular files only. */
  private removeStalePages(dir: string, pageCount: number): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const m = PAGE_FILE.exec(entry.name);
      if (!m || !entry.isFile() || entry.isSymbolicLink()) continue;
      const n = Number(m[1]);
      if (n <= pageCount || n < 2) continue;
      const path = join(dir, entry.name);
      const st = lstatOrNull(path);
      if (!st || !st.isFile()) continue;
      unlinkSync(path);
    }
    syncDir(dir);
  }
}

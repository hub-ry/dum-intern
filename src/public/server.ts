// Dum's public static site server. Node 24 runs this file directly; it uses
// only Node builtins and serves nothing but files inside one public root.
//
//   HOST             bind address, loopback only (default 127.0.0.1)
//   PORT             default 8070
//   DUM_PUBLIC_ROOT  directory to serve (default ../site next to this file)
//
// Behind cloudflared every request arrives on loopback, so this server never
// listens on a non-loopback address.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { constants as fsConstants, type FileHandle, open, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Configuration

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? "8070");
const CONFIGURED_ROOT = process.env.DUM_PUBLIC_ROOT
  ? resolve(process.env.DUM_PUBLIC_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..", "site");

const NAV_MARKER = "<!--NAV-->";
const NAV_FILE = "nav.html";
const MAX_URL_LENGTH = 2048;

// Only these extensions are ever served. Anything else inside the root
// (.ts, .md, package.json would be .json so keep the root free of it, etc.)
// is answered with 404 as if it did not exist.
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Exact paths that map to a page in the root.
const PAGE_MAP: Readonly<Record<string, string>> = {
  "": "index.html",
  "index.html": "index.html",
  docs: "docs.html",
  "docs.html": "docs.html",
  philosophy: "philosophy.html",
  "philosophy.html": "philosophy.html",
};

// Sections that used to exist. Their pages, subpaths and APIs are gone for good.
const RETIRED = new Set(["install", "subjects", "builds"]);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

// ---------------------------------------------------------------------------
// Request path parsing

type Route =
  | { kind: "file"; segments: string[] }
  | { kind: "status"; status: number; reason: string }
  | { kind: "redirect"; location: string };

function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(host)) return true;
  return false;
}

/**
 * Turn the raw request target into clean path segments, or null when the
 * request is malformed or tries to leave the root. Works on the raw text
 * before any normalisation: each segment is percent-decoded on its own and a
 * decoded slash, backslash, NUL, control character or dot-segment is a
 * rejection, not something to be cleaned up.
 */
function parseSegments(rawUrl: string): string[] | null {
  if (rawUrl.length > MAX_URL_LENGTH || !rawUrl.startsWith("/")) return null;
  let path = rawUrl;
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  if (path.includes("\\") || path.includes("\0")) return null;

  const segments: string[] = [];
  for (const raw of path.split("/")) {
    if (raw === "") continue; // leading, trailing or doubled slash
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === "" || seg === "." || seg === "..") return null;
    if (seg.startsWith(".")) return null; // dotfiles and hidden dirs
    if (/[\0-\x1f\x7f/\\]/.test(seg)) return null;
    segments.push(seg);
  }
  return segments;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function route(rawUrl: string): Route {
  const parsed = parseSegments(rawUrl);
  if (parsed === null) return { kind: "status", status: 400, reason: "Bad Request" };

  let segments = parsed;

  // /site/x is a long-standing alias for /x.
  if (segments[0] === "site") segments = segments.slice(1);

  const first = segments[0] ?? "";
  const firstBase = first.endsWith(".html") ? first.slice(0, -".html".length) : first;
  if (RETIRED.has(firstBase)) return { kind: "status", status: 410, reason: "Gone" };
  if (first === "api") return { kind: "status", status: 404, reason: "Not Found" };

  if (segments.length <= 1) {
    const page = Object.hasOwn(PAGE_MAP, first) ? PAGE_MAP[first] : undefined;
    if (page !== undefined) return { kind: "file", segments: [page] };
  }

  const last = segments[segments.length - 1] ?? "";
  const ext = extensionOf(last);
  if (ext === "") {
    // Extensionless path: only a directory index, never an arbitrary file.
    // Keep relative assets rooted in the directory for links without a slash.
    const pathname = rawUrl.split(/[?#]/, 1)[0] ?? "";
    if (!pathname.endsWith("/")) {
      const queryAt = rawUrl.indexOf("?");
      const query = queryAt === -1 ? "" : rawUrl.slice(queryAt).split("#", 1)[0];
      return { kind: "redirect", location: `/${segments.map(encodeURIComponent).join("/")}/${query}` };
    }
    return { kind: "file", segments: [...segments, "index.html"] };
  }
  if (!(ext in MIME_TYPES)) return { kind: "status", status: 404, reason: "Not Found" };
  return { kind: "file", segments };
}

// ---------------------------------------------------------------------------
// File access

class NotFound extends Error {}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Open a regular file under the canonical root. Check the canonical path
 * before opening, then check the opened descriptor through Linux procfs so
 * a concurrent directory replacement cannot swap in a file outside the root.
 * O_NOFOLLOW rejects a replaced leaf symlink. O_NONBLOCK prevents a replaced
 * FIFO from hanging the request before the regular-file check.
 */
async function readPublicFile(root: string, segments: string[]): Promise<Buffer> {
  const candidate = join(root, ...segments);
  if (!isInside(root, candidate) || candidate === root) throw new NotFound();

  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (err) {
    throw toNotFound(err);
  }
  if (!isInside(root, canonical)) throw new NotFound();

  let handle: FileHandle;
  try {
    handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    throw toNotFound(err);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new NotFound();
    let real: string;
    try {
      real = await realpath(`/proc/self/fd/${handle.fd}`);
    } catch (err) {
      throw toNotFound(err);
    }
    if (!isInside(root, real)) throw new NotFound();
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
}

function toNotFound(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
    case "EISDIR":
    case "ELOOP":
    case "ENAMETOOLONG":
    case "EACCES":
    case "EPERM":
      return new NotFound();
    default:
      return err instanceof Error ? err : new Error(String(err));
  }
}

async function injectNav(root: string, html: Buffer): Promise<Buffer> {
  const text = html.toString("utf8");
  const at = text.indexOf(NAV_MARKER);
  if (at === -1) return html;
  let nav: string;
  try {
    nav = (await readPublicFile(root, [NAV_FILE])).toString("utf8");
  } catch (err) {
    if (err instanceof NotFound) return html; // no nav shipped; page still works
    throw err;
  }
  return Buffer.from(text.slice(0, at) + nav + text.slice(at + NAV_MARKER.length), "utf8");
}

// ---------------------------------------------------------------------------
// HTTP

function baseHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", CSP);
}

function sendStatus(req: IncomingMessage, res: ServerResponse, status: number, reason: string, extra: Record<string, string> = {}): void {
  const body = Buffer.from(`${status} ${reason}\n`, "utf8");
  baseHeaders(res);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", String(body.length));
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.statusCode = status;
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

function sendFile(req: IncomingMessage, res: ServerResponse, body: Buffer, ext: string): void {
  baseHeaders(res);
  res.setHeader("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
  res.setHeader("Content-Length", String(body.length));
  res.setHeader("Cache-Control", ext === ".html" ? "no-store" : "public, max-age=3600");
  res.statusCode = 200;
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

async function handle(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendStatus(req, res, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
    return;
  }
  const r = route(req.url ?? "");
  if (r.kind === "status") {
    sendStatus(req, res, r.status, r.reason);
    return;
  }
  if (r.kind === "redirect") {
    sendStatus(req, res, 308, "Permanent Redirect", { Location: r.location });
    return;
  }
  const ext = extensionOf(r.segments[r.segments.length - 1] ?? "");
  try {
    let body = await readPublicFile(root, r.segments);
    if (ext === ".html") body = await injectNav(root, body);
    sendFile(req, res, body, ext);
  } catch (err) {
    if (err instanceof NotFound) {
      sendStatus(req, res, 404, "Not Found");
      return;
    }
    console.error(`[dum-public] error serving ${req.method} ${req.url}:`, err);
    sendStatus(req, res, 500, "Internal Server Error");
  }
}

// ---------------------------------------------------------------------------
// Startup

async function main(): Promise<void> {
  if (!isLoopback(HOST)) {
    console.error(`[dum-public] refusing to bind non-loopback HOST=${HOST}; this server sits behind cloudflared on localhost`);
    process.exit(1);
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`[dum-public] invalid PORT=${process.env.PORT}`);
    process.exit(1);
  }

  let root: string;
  try {
    root = await realpath(CONFIGURED_ROOT);
  } catch {
    console.error(`[dum-public] public root does not exist: ${CONFIGURED_ROOT}`);
    process.exit(1);
  }

  const server = createServer((req, res) => {
    handle(root, req, res).catch((err) => {
      console.error("[dum-public] unhandled error:", err);
      if (!res.headersSent) sendStatus(req, res, 500, "Internal Server Error");
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  server.on("error", (err) => {
    console.error("[dum-public] server error:", err);
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    console.log(`[dum-public] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  server.listen(PORT, HOST, () => {
    console.log(`[dum-public] listening on http://${HOST}:${PORT} serving ${root}`);
  });
}

main().catch((err) => {
  console.error("[dum-public] fatal:", err);
  process.exit(1);
});

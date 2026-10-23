// Dum on dumintern.com. The public pages live in src/site. A signed-in
// person's skill tree, readings, and builds live in a folder on hub.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { constants as fsConstants, type FileHandle, open, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeUrl, exchangeCode, gistMatches, githubLogin, oauthConfigured } from "./github.ts";
import { hints, ProductError } from "./model.ts";
import { defaultStateDir, Store, type Account } from "./store.ts";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? "8074");
const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "site");
const PDFJS = process.env.DUM_PDFJS?.trim() || dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/build/pdf.min.mjs")));
const COOKIE = "dum_session";
const AUTH_COOKIE = "dum_auth";
const NAV_MARKER = "<!--NAV-->";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".ico": "image/x-icon",
};

const PAGES: Record<string, string> = {
  "": "index.html",
  "index.html": "index.html",
  docs: "docs.html",
  "docs.html": "docs.html",
  app: "app.html",
  "app.html": "app.html",
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

type BrowserChallenge = { proof: string; exp: number };
type Pending = BrowserChallenge & { login: string };
const pending = new Map<string, Pending>();
const oauthStates = new Map<string, BrowserChallenge>();

const store = new Store(defaultStateDir());
const secretPromise = loadSecret(store.stateDir);

function loadSecret(dir: string): Promise<Buffer> {
  const path = join(dir, "session.key");
  return (async () => {
    try {
      const buf = await readFile(path);
      if (buf.length >= 32) return buf;
    } catch { /* create one */ }
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const buf = randomBytes(32);
    await writeFile(path, buf, { mode: 0o600 });
    return buf;
  })();
}

function sign(secret: Buffer, githubId: number): string {
  const body = Buffer.from(JSON.stringify({ id: githubId, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function readSession(secret: Buffer, header: string | undefined): number | null {
  const match = header?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;
  const [body, mac] = decodeURIComponent(match[1]).split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { id?: number; exp?: number };
    if (!payload.id || !payload.exp || payload.exp < Date.now()) return null;
    return payload.id;
  } catch {
    return null;
  }
}

function cookie(token: string, secure: boolean, name = COOKIE, maxAge = 60 * 60 * 24 * 30): string {
  const parts = [`${name}=${encodeURIComponent(token)}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function browserProof(req: IncomingMessage): string | undefined {
  return req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`))?.[1];
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64_000) throw new ProductError("That request is too large.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProductError("Send JSON.");
  }
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(buf.length));
  for (const [key, value] of Object.entries(extra)) res.setHeader(key, value);
  res.end(buf);
}

function publicOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? `127.0.0.1:${PORT}`;
  const proto = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  return `${proto}://${host}`;
}

function secureCookie(req: IncomingMessage): boolean {
  return !String(req.headers.host ?? "").startsWith("127.") && !String(req.headers.host ?? "").startsWith("localhost");
}

async function accountFrom(req: IncomingMessage): Promise<Account | null> {
  const secret = await secretPromise;
  const id = readSession(secret, req.headers.cookie);
  if (!id) return null;
  return store.account(id);
}

async function requireAccount(req: IncomingMessage): Promise<Account> {
  const account = await accountFrom(req);
  if (!account) throw new ProductError("Sign in first.");
  return account;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/me") {
    const account = await accountFrom(req);
    send(res, 200, { oauth: oauthConfigured(), account: account ? { login: account.login, root: account.root, githubId: account.githubId } : null });
    return;
  }
  if (req.method === "POST" && path === "/api/logout") {
    send(res, 200, { ok: true }, { "Set-Cookie": cookie("", secureCookie(req), COOKIE, 0) });
    return;
  }
  if (req.method === "POST" && path === "/api/auth/start") {
    const body = await readBody(req) as { login?: string };
    const login = githubLogin(String(body.login ?? ""));
    const code = `dum-${randomBytes(12).toString("hex")}`;
    const proof = randomBytes(32).toString("hex");
    pending.set(code, { login, proof, exp: Date.now() + 15 * 60 * 1000 });
    send(res, 200, {
      code,
      login,
      gist: "https://gist.github.com/",
      note: "Create a public gist. Name the file dum-login. Paste this code as the whole file. Then check it here.",
    }, { "Set-Cookie": cookie(proof, secureCookie(req), AUTH_COOKIE, 15 * 60) });
    return;
  }
  if (req.method === "POST" && path === "/api/auth/finish") {
    const body = await readBody(req) as { login?: string; code?: string };
    const code = String(body.code ?? "");
    const row = pending.get(code);
    if (!row || row.exp < Date.now() || row.proof !== browserProof(req)) throw new ProductError("That code expired or belongs to another browser. Start again.");
    const login = githubLogin(String(body.login ?? row.login));
    if (login.toLowerCase() !== row.login.toLowerCase()) throw new ProductError("That code was started for a different username.");
    const user = await gistMatches(login, code);
    if (!user) throw new ProductError("No public gist named dum-login has this code yet.");
    if (pending.get(code) !== row || row.exp < Date.now()) throw new ProductError("That code expired or was already used. Start again.");
    pending.delete(code);
    const account = await store.ensureAccount(user.id, user.login);
    const secret = await secretPromise;
    send(res, 200, { login: account.login, root: account.root }, { "Set-Cookie": cookie(sign(secret, account.githubId), secureCookie(req)) });
    return;
  }
  if (req.method === "GET" && path === "/auth/github") {
    if (!oauthConfigured()) {
      send(res, 404, "GitHub OAuth is not configured. Use the gist sign-in on /app.\n");
      return;
    }
    const state = randomBytes(16).toString("hex");
    const proof = randomBytes(32).toString("hex");
    oauthStates.set(state, { proof, exp: Date.now() + 10 * 60 * 1000 });
    res.statusCode = 302;
    res.setHeader("Set-Cookie", cookie(proof, secureCookie(req), AUTH_COOKIE, 10 * 60));
    res.setHeader("Location", authorizeUrl(`${publicOrigin(req)}/auth/github/callback`, state));
    res.end();
    return;
  }
  if (req.method === "GET" && path === "/auth/github/callback") {
    const state = url.searchParams.get("state") ?? "";
    const row = oauthStates.get(state);
    if (!row || row.exp < Date.now() || row.proof !== browserProof(req)) throw new ProductError("That GitHub sign-in expired or belongs to another browser. Try again.");
    oauthStates.delete(state);
    const user = await exchangeCode(url.searchParams.get("code") ?? "");
    const account = await store.ensureAccount(user.id, user.login);
    const secret = await secretPromise;
    res.statusCode = 302;
    res.setHeader("Set-Cookie", cookie(sign(secret, account.githubId), secureCookie(req)));
    res.setHeader("Location", "/app");
    res.end();
    return;
  }

  const account = await requireAccount(req);
  if (req.method === "GET" && path === "/api/workspace") {
    const tree = await store.tree(account);
    const root = await store.workspace(account);
    send(res, 200, { account: { login: account.login, root: account.root, path: root }, tree });
    return;
  }
  if (req.method === "POST" && path === "/api/root") {
    const body = await readBody(req) as { root?: string };
    const next = await store.setRoot(account, String(body.root ?? ""));
    send(res, 200, { root: next.root, path: await store.workspace(next) });
    return;
  }
  if (req.method === "POST" && path === "/api/goals") {
    const body = await readBody(req) as { title?: string; aim?: string; outline?: string };
    const title = String(body.title ?? "").trim();
    const aim = String(body.aim ?? "").trim();
    if (title.length < 1 || title.length > 80) throw new ProductError("Name the goal in 80 characters or fewer.");
    if (aim.length < 1 || aim.length > 2000) throw new ProductError("Say what you want to be able to build, in a paragraph.");
    const tree = await store.createGoal(account, title, aim, String(body.outline ?? ""));
    send(res, 200, { tree });
    return;
  }
  if (req.method === "POST" && path === "/api/read") {
    const body = await readBody(req) as { skillId?: string; page?: number; pages?: number };
    const tree = await store.readSkill(account, String(body.skillId ?? ""), Number(body.page), Number(body.pages));
    send(res, 200, { tree });
    return;
  }
  if (req.method === "POST" && path === "/api/swear") {
    const body = await readBody(req) as { skillId?: string; text?: string };
    const tree = await store.swear(account, String(body.skillId ?? ""), String(body.text ?? ""));
    send(res, 200, { tree });
    return;
  }
  if (req.method === "POST" && path === "/api/builds") {
    const body = await readBody(req) as { goalId?: string; title?: string; blockIds?: string[] };
    const ids = Array.isArray(body.blockIds) ? body.blockIds.map(String) : [];
    const tree = await store.build(account, String(body.goalId ?? ""), String(body.title ?? ""), ids);
    send(res, 200, { tree });
    return;
  }
  if (req.method === "GET" && path === "/api/hints") {
    const tree = await store.tree(account);
    const goal = url.searchParams.get("goal") ?? tree.goals[0]?.id ?? "";
    send(res, 200, goal ? hints(tree, goal) : { learn: [], build: [] });
    return;
  }
  const reading = path.match(/^\/api\/readings\/([0-9a-f-]{36})\/pdf$/);
  if (req.method === "GET" && reading) {
    const { pdf, pages, skillTitle } = await store.readingPdf(account, reading[1]);
    const bytes = await readFile(pdf);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("X-Dum-Pages", String(pages));
    res.setHeader("X-Dum-Title", encodeURIComponent(skillTitle));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Security-Policy", CSP);
    res.end(bytes);
    return;
  }
  send(res, 404, { error: "Not found." });
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

async function readUnder(root: string, segments: string[]): Promise<Buffer> {
  const candidate = join(root, ...segments);
  const canonical = await realpath(candidate);
  if (canonical !== root && !canonical.startsWith(root + sep)) throw new Error("outside");
  let handle: FileHandle;
  try {
    handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    throw new Error("missing");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("missing");
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
}

async function serveSite(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed\n");
    return;
  }
  let path = url.pathname;
  if (path.startsWith("/site/")) path = path.slice("/site".length);
  if (path.startsWith("/vendor/")) {
    const name = path.slice("/vendor/".length);
    if (name !== "pdf.min.mjs" && name !== "pdf.worker.min.mjs") {
      send(res, 404, "Not found\n");
      return;
    }
    const body = await readUnder(await realpath(PDFJS), [name]);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.some((seg) => seg === "." || seg === ".." || seg.startsWith("."))) {
    send(res, 400, "Bad request\n");
    return;
  }
  let fileSegs: string[];
  if (segments.length <= 1 && Object.hasOwn(PAGES, segments[0] ?? "")) fileSegs = [PAGES[segments[0] ?? ""]];
  else {
    const last = segments[segments.length - 1] ?? "";
    if (!extensionOf(last)) {
      if (!url.pathname.endsWith("/")) {
        res.statusCode = 308;
        res.setHeader("Location", `${url.pathname}/`);
        res.end();
        return;
      }
      fileSegs = [...segments, "index.html"];
    } else fileSegs = segments;
  }
  const ext = extensionOf(fileSegs[fileSegs.length - 1] ?? "");
  if (!(ext in MIME)) {
    send(res, 404, "Not found\n");
    return;
  }
  let body = await readUnder(await realpath(SITE), fileSegs);
  if (ext === ".html" && body.includes(NAV_MARKER)) {
    try {
      const nav = await readUnder(await realpath(SITE), ["nav.html"]);
      body = Buffer.from(body.toString("utf8").replace(NAV_MARKER, nav.toString("utf8")));
    } catch { /* page still works */ }
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[ext]);
  res.setHeader("Content-Length", String(body.length));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("Cache-Control", ext === ".html" ? "no-store" : "public, max-age=3600");
  res.end(req.method === "HEAD" ? undefined : body);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) await handleApi(req, res, url);
    else await serveSite(req, res, url);
  } catch (err) {
    const message = err instanceof ProductError ? err.message : err instanceof Error && err.message.startsWith("That") ? err.message : "Something went wrong.";
    const status = err instanceof ProductError ? 400 : 500;
    if (status === 500) console.error("[dum]", err);
    if (!res.headersSent) send(res, status, url.pathname.startsWith("/api/") ? { error: message } : `${message}\n`);
  }
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[dum] unhandled", err);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

if (!isLoopback(HOST)) {
  console.error(`[dum] refusing to bind ${HOST}`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`[dum] http://${HOST}:${PORT}  state ${store.stateDir}`);
});

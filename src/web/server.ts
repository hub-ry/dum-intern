// The web copy of a skill tree, at /<id>. The id is the key: whoever has the link can see and
// edit that tree, and nothing lists or searches them. One JSON file per tree, no database.
//
//   PORT=8787 DUM_WEB_DATA=./web-data npx tsx src/web/server.ts

import { createServer as httpServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as sync from "../sync.ts";
import { view } from "./view.ts";
import { parseBuilds, renderBuilds } from "./builds.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The most a request body may weigh: a big tree is a few hundred KB. */
const MAX_BODY = 1 << 20;

/** New trees one address may make in an hour, so nobody fills the disk. */
const CREATES_PER_HOUR = 20;

const Skill = z.object({
  name: z.string().min(1).max(200),
  lang: z.string().max(40),
  how: z.enum(["typed", "explained", "course", "added", "reasoned"]),
  level: z.enum(["recognize", "build", "apply"]),
  requires: z.array(z.string().max(200)).max(3),
  why: z.string().max(2000),
  at: z.string().max(40),
});
const Snapshot = z.object({
  skills: z.array(Skill).max(5000),
  removed: z.record(z.string().max(260), z.string().max(40)).refine((r) => Object.keys(r).length <= 5000),
});
const Edit = z.object({ op: z.enum(["add", "remove"]), name: z.string().min(1).max(200), lang: z.string().max(40) });

type Stored = { version: number; snapshot: sync.Snapshot; created: string; updated: string };

const STATIC: Record<string, string> = { "page.js": "text/javascript", "page.css": "text/css" };

const SITE_PAGES: Record<string, string> = { "/": "index.html", "/install": "install.html", "/philosophy": "philosophy.html", "/docs": "docs.html", "/builds": "builds.html", "/subjects": "subjects.html" };
const SITE_ASSETS: Record<string, string> = {
  "site.css": "text/css; charset=utf-8",
  "game.js": "text/javascript; charset=utf-8",
  "setup.js": "text/javascript; charset=utf-8",
  "wizard.js": "text/javascript; charset=utf-8",
  "hack-regular.woff2": "font/woff2",
  "hack-bold.woff2": "font/woff2",
  "hack-LICENSE.md": "text/plain; charset=utf-8",
  "favicon.png": "image/png",
};
const SITE_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "cache-control": "public, max-age=300",
  "x-content-type-options": "nosniff",
};
// Builds embeds YouTube videos, which needs a frame source and, for YouTube to play, the page origin as referrer.
const BUILDS_HEADERS = {
  ...SITE_HEADERS,
  "content-security-policy": SITE_HEADERS["content-security-policy"] + "; frame-src https://www.youtube-nocookie.com",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** Every page gets the same nav; only the current page's link is marked, so nothing moves between pages. */
function withNav(html: string, nav: string, route: string): string {
  if (!html.includes("<!--NAV-->")) throw new Error(`site page for ${route} has no <!--NAV--> placeholder`);
  return html.replace("<!--NAV-->", nav.replace(`href="${route}"`, `href="${route}" aria-current="page"`));
}

const HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  // The id is the key, so it must never leave in a Referer, land in a search index, or sit in a cache.
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export type Options = { data: string; trustProxy?: boolean };

export function createServer(o: Options): Server {
  mkdirSync(o.data, { recursive: true });
  // Off-track prerequisites are read from DUM_HOME; the server has none of its own to read.
  process.env.DUM_HOME ??= o.data;
  const here = new URL(".", import.meta.url).pathname;
  const page = readFileSync(`${here}page.html`, "utf8");
  const statics = Object.fromEntries(Object.keys(STATIC).map((f) => [f, readFileSync(`${here}${f}`, "utf8")]));
  const site = new URL("../site/", import.meta.url);
  const nav = readFileSync(new URL("nav.html", site), "utf8");
  const builds = renderBuilds(parseBuilds(readFileSync(new URL("builds.json", site), "utf8")));
  const sitePages = Object.fromEntries(Object.entries(SITE_PAGES).map(([route, file]) => {
    const html = withNav(readFileSync(new URL(file, site), "utf8"), nav, route);
    return [route, Buffer.from(route === "/builds" ? html.replace("<!--BUILDS-->", builds) : html)];
  }));
  const siteAssets = Object.fromEntries(Object.keys(SITE_ASSETS).map((file) => [`/site/${file}`, { body: readFileSync(new URL(file, site)), type: SITE_ASSETS[file]! }]));
  const file = (id: string) => `${o.data}/${id}.json`;
  const locks = new Map<string, Promise<unknown>>();
  const creates = new Map<string, number[]>();

  function load(id: string): Stored | null {
    try {
      return JSON.parse(readFileSync(file(id), "utf8")) as Stored;
    } catch {
      return null;
    }
  }

  function save(id: string, s: Stored) {
    const tmp = `${file(id)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, file(id));
  }

  /** One change to a tree at a time, so two writes never interleave. */
  function locked<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
    const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
    locks.set(id, run.catch(() => {}));
    return run;
  }

  function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
    res.writeHead(status, { ...HEADERS, "content-type": `${type}; charset=utf-8` });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  async function body(req: IncomingMessage): Promise<unknown> {
    let size = 0;
    const parts: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new Error("too big");
      parts.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8") || "null");
  }

  function address(req: IncomingMessage): string {
    const fwd = o.trustProxy ? String(req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() : "";
    return fwd || req.socket.remoteAddress || "?";
  }

  function allowCreate(ip: string): boolean {
    const now = Date.now();
    const recent = (creates.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= CREATES_PER_HOUR) return false;
    creates.set(ip, [...recent, now]);
    return true;
  }

  const shown = (s: Stored) => ({ version: s.version, snapshot: s.snapshot, view: view({ skills: s.snapshot.skills }) });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    const m = req.method ?? "GET";
    const sitePage = sitePages[url.pathname];
    if ((m === "GET" || m === "HEAD") && sitePage) {
      res.writeHead(200, { ...(url.pathname === "/builds" ? BUILDS_HEADERS : SITE_HEADERS), "content-type": "text/html; charset=utf-8" });
      return res.end(m === "HEAD" ? undefined : sitePage);
    }
    const siteAsset = siteAssets[url.pathname];
    if ((m === "GET" || m === "HEAD") && siteAsset) {
      res.writeHead(200, { ...SITE_HEADERS, "content-type": siteAsset.type });
      return res.end(m === "HEAD" ? undefined : siteAsset.body);
    }

    if (m === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true });
    if (m === "GET" && parts[0] === "static" && parts[1] && STATIC[parts[1]]) return send(res, 200, statics[parts[1]]!, STATIC[parts[1]]);
    if (m === "GET" && parts.length === 1 && ID.test(parts[0]!)) return send(res, 200, page, "text/html");
    if (parts[0] !== "api" || parts[1] !== "trees") return send(res, 404, { error: "not found" });

    if (m === "POST" && parts.length === 2) {
      if (!allowCreate(address(req))) return send(res, 429, { error: "too many new trees from here - try later" });
      const snap = Snapshot.safeParse(await body(req));
      if (!snap.success) return send(res, 400, { error: "that isn't a skill tree" });
      const id = randomUUID();
      const now = new Date().toISOString();
      save(id, { version: 1, snapshot: snap.data, created: now, updated: now });
      return send(res, 201, { id, version: 1 });
    }

    const id = parts[2] ?? "";
    if (!ID.test(id)) return send(res, 404, { error: "not found" });

    if (m === "GET" && parts.length === 3) {
      const s = load(id);
      return s ? send(res, 200, shown(s)) : send(res, 404, { error: "no tree at this link" });
    }

    if (m === "PUT" && parts.length === 3) {
      const got = z.object({ version: z.number().int(), snapshot: Snapshot }).safeParse(await body(req));
      if (!got.success) return send(res, 400, { error: "that isn't a skill tree" });
      return locked(id, () => {
        const s = load(id);
        if (!s) return send(res, 404, { error: "no tree at this link" });
        // Written over only by someone who saw the latest version; anyone else merges first.
        if (got.data.version !== s.version) return send(res, 409, shown(s));
        const next = { ...s, version: s.version + 1, snapshot: got.data.snapshot, updated: new Date().toISOString() };
        save(id, next);
        return send(res, 200, shown(next));
      });
    }

    if (m === "POST" && parts.length === 4 && parts[3] === "edit") {
      const e = Edit.safeParse(await body(req));
      if (!e.success) return send(res, 400, { error: "that isn't an edit" });
      return locked(id, () => {
        const s = load(id);
        if (!s) return send(res, 404, { error: "no tree at this link" });
        const out = sync.edit(s.snapshot, e.data);
        if ("refused" in out) return send(res, 422, { refused: out.refused, ...shown(s) });
        const next = { ...s, version: s.version + 1, snapshot: out, updated: new Date().toISOString() };
        save(id, next);
        return send(res, 200, shown(next));
      });
    }

    if (m === "POST" && parts.length === 4 && parts[3] === "rotate") {
      return locked(id, () => {
        const s = load(id);
        if (!s) return send(res, 404, { error: "no tree at this link" });
        const fresh = randomUUID();
        save(fresh, { ...s, updated: new Date().toISOString() });
        unlinkSync(file(id));
        return send(res, 200, { id: fresh, version: s.version });
      });
    }

    if (m === "DELETE" && parts.length === 3) {
      return locked(id, () => {
        if (existsSync(file(id))) unlinkSync(file(id));
        res.writeHead(204, HEADERS);
        res.end();
      });
    }

    return send(res, 405, { error: "not allowed" });
  }

  return httpServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, (err as Error).message === "too big" ? 413 : 400, { error: "bad request" });
      else res.end();
    });
  });
}


if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8787;
  const data = process.env.DUM_WEB_DATA || "./web-data";
  createServer({ data, trustProxy: process.env.TRUST_PROXY === "1" }).listen(port, process.env.HOST || "127.0.0.1", () => {
    console.log(`dum docs and trees on http://${process.env.HOST || "127.0.0.1"}:${port}, data in ${data}`);
  });
}

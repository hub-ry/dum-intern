import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, redact, type Config } from "./config.ts";
import { HttpError, Intern } from "./intern.ts";
import { createLlm } from "./llm.ts";
import { createMaritime, maritimeComputer, MaritimeError } from "./maritime.ts";
import { zipStore } from "./skilldoc.ts";
import { Store } from "./store.ts";
import { publicNode } from "./types.ts";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");
const FILES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/app.css": "app.css",
  "/favicon.svg": "favicon.svg",
};
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src https: http:",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export type Running = {
  url: string;
  close: () => Promise<void>;
};

export function startServer(config: Config = loadConfig()): Promise<Running> {
  const store = new Store(config.stateDir);
  const secrets = [config.llm.apiKey, config.maritime.apiKey];
  const maritime = config.mock ? null : createMaritime(config.maritime);
  const desktop = maritime
    ? maritimeComputer(maritime, async () => {
        const existing = store.computerId();
        if (existing) return existing;
        const created = await maritime.getOrCreate("dum-intern", "dum-intern");
        store.setComputerId(created.id);
        return created.id;
      })
    : null;
  const intern = new Intern(
    store,
    config,
    config.mock ? null : createLlm(config.llm),
    desktop,
  );

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      sendError(res, error, secrets);
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname);
    if (req.method === "GET" && FILES[path]) return sendFile(res, FILES[path]);
    if (req.method === "GET" && path === "/api/health") {
      return sendJson(res, 200, { ok: true, mode: config.mock ? "mock" : "live" });
    }
    if (req.method === "GET" && path === "/api/state") return sendJson(res, 200, state());
    if (req.method === "POST" && path === "/api/chat") return chat(req, res);
    if (req.method === "POST" && path === "/api/teach") {
      const body = await readJson(req);
      const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
      return sendJson(res, 200, intern.begin(nodeId, body.revise === true));
    }
    if (req.method === "POST" && path === "/api/teach/save") return sendJson(res, 200, intern.save());
    const dismiss = path.match(/^\/api\/nodes\/([a-z0-9-]{1,64})\/dismiss$/);
    if (req.method === "POST" && dismiss) return sendJson(res, 200, intern.dismiss(dismiss[1]));
    const skill = path.match(/^\/api\/skills\/([a-z0-9-]{1,64})\.md$/);
    if (req.method === "GET" && skill) return sendSkill(res, skill[1]);
    if (req.method === "GET" && path === "/api/export.zip") return sendExport(res);
    if (req.method === "POST" && path === "/api/desktop/open") return openDesktop(res);
    if (req.method === "GET" && path === "/api/desktop/screenshot") return screenshot(res);
    if (req.method === "POST" && path === "/api/reset") {
      if (intern.isBusy) throw new HttpError(409, "The intern is still working.");
      store.reset();
      return sendJson(res, 200, state());
    }
    sendJson(res, 404, { error: "Not found." });
  }

  function state() {
    return {
      mode: config.mock ? "mock" : "live",
      missing: config.missing,
      model: config.llm.model,
      nodes: store.nodes().map(publicNode),
      messages: store.messages(),
      teaching: store.teaching(),
      desktop: store.desktop(),
    };
  }

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) throw new HttpError(400, "Write a message first.");
    if (intern.isBusy) throw new HttpError(409, "The intern is still working.");
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Content-Security-Policy": CSP,
    });
    try {
      await intern.chat(text, (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      });
    } catch (error) {
      const message = error instanceof HttpError ? error.message : "The intern failed.";
      res.write(`event: error\ndata: ${JSON.stringify({ message: redact(message, secrets) })}\n\n`);
      res.write(`event: done\ndata: {}\n\n`);
    }
    res.end();
  }

  function sendSkill(res: ServerResponse, id: string): void {
    const notes = store.skillFile(id);
    if (!notes) {
      sendJson(res, 404, { error: "That skill has no note yet." });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${id}.md"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(notes);
  }

  function sendExport(res: ServerResponse): void {
    const files = store.exportZipFiles();
    const zip = zipStore(files);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename=\"dum-skills.zip\"",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(zip);
  }

  async function openDesktop(res: ServerResponse): Promise<void> {
    if (!desktop) {
      sendJson(res, 200, { viewerUrl: null, mock: true });
      return;
    }
    try {
      const link = await openOnce();
      sendJson(res, 200, { viewerUrl: link.url, expiresAt: link.expiresAt, mode: link.mode });
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : "Desktop request failed.", secrets);
      sendJson(res, 502, { error: message });
    }
  }

  async function openOnce() {
    if (!desktop) throw new Error("Desktop is not configured.");
    try {
      return await desktop.open();
    } catch (error) {
      if (error instanceof MaritimeError && error.status === 404) {
        store.setComputerId(null);
        return await desktop.open();
      }
      throw error;
    }
  }

  async function screenshot(res: ServerResponse): Promise<void> {
    if (!desktop) throw new HttpError(404, "Screenshots are available when Maritime is configured.");
    const shot = await desktop.screenshot();
    res.writeHead(200, {
      "Content-Type": shot.type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(shot.bytes);
  }

  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : config.port;
      const url = `http://${config.host}:${port}`;
      console.log(`dum-intern listening on ${url} (${config.mock ? `mock, missing ${config.missing.join(", ") || "keys"}` : "live"})`);
      resolve({
        url,
        close: () => new Promise((done, reject) => {
          server.close((error) => {
            store.close();
            if (error) reject(error);
            else done();
          });
        }),
      });
    });
  });
}

function sendFile(res: ServerResponse, name: string): void {
  const path = join(PUBLIC, normalize(name));
  if (!path.startsWith(PUBLIC)) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  try {
    statSync(path);
  } catch {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  const type = MIME[extname(path)] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-cache",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  createReadStream(path).pipe(res);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: unknown, secrets: string[]): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = error instanceof HttpError ? error.status : error instanceof MaritimeError ? 502 : 500;
  const message = redact(error instanceof Error ? error.message : "Request failed.", secrets);
  sendJson(res, status, { error: message });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "That was not a JSON object.");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "That was not JSON.");
  }
}

function readBody(req: IncomingMessage, limit = 200_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "That request is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const running = await startServer();
  const shutdown = () => {
    running.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

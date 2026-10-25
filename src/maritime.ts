// Maritime Computers REST client.
// Docs: https://maritime.sh/docs/computers
// API:  https://maritime.sh/docs/api
// Spec: https://api.maritime.sh/openapi.json
// One persistent Linux desktop per externalUserId. Bearer mk_ key.

import type { Computer, ExecResult } from "./types.ts";

export class MaritimeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly slug?: string,
  ) {
    super(message);
    this.name = "MaritimeError";
  }
}

export type ComputerInfo = {
  id: string;
  status: string;
  externalUserId: string | null;
  name: string | null;
};

export type ViewerLink = {
  url: string;
  expiresAt: string;
  mode: "watch" | "control";
};

export type MaritimeClient = {
  getOrCreate(externalUserId: string, name: string): Promise<ComputerInfo>;
  wake(id: string): Promise<{ status: string }>;
  exec(id: string, command: string, timeoutS?: number): Promise<ExecResult>;
  writeFile(id: string, path: string, content: string): Promise<void>;
  readFile(id: string, path: string): Promise<string>;
  listDir(id: string, path: string): Promise<{ name: string; isDir: boolean }[]>;
  viewer(id: string, mode?: "watch" | "control", ttlS?: number): Promise<ViewerLink>;
  screenshot(id: string): Promise<{ bytes: Buffer; type: string }>;
};

export function createMaritime(options: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}): MaritimeClient {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");

  async function call(path: string, init: RequestInit & { raw?: Buffer | string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${options.apiKey}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(90_000),
    });
    return response;
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await call(path, init);
    if (!response.ok) throw await asError(response);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  return {
    async getOrCreate(externalUserId, name) {
      const response = await call("/api/v1/computers", {
        method: "POST",
        body: JSON.stringify({ externalUserId, name, os: "linux", arch: "x86_64" }),
      });
      if (response.status === 200 || response.status === 201) return readComputer(await response.json());
      if (response.status === 409) {
        const listed = await json<{ computers?: unknown[] }>(
          `/api/v1/computers?externalUserId=${encodeURIComponent(externalUserId)}`,
        );
        const found = (listed.computers ?? []).map(readComputer).find((item) => item.externalUserId === externalUserId);
        if (found) return found;
      }
      throw await asError(response);
    },
    async wake(id) {
      return json<{ status: string }>(`/api/v1/computers/${encodeURIComponent(id)}/wake`, { method: "POST" });
    },
    async exec(id, command, timeoutS = 30) {
      const body = await json<{ exitCode?: number | null; stdout?: string; stderr?: string }>(
        `/api/v1/computers/${encodeURIComponent(id)}/exec`,
        {
          method: "POST",
          body: JSON.stringify({ command, timeoutS: clamp(timeoutS, 1, 30) }),
        },
      );
      return {
        exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
        stdout: body.stdout ?? "",
        stderr: body.stderr ?? "",
      };
    },
    async writeFile(id, path, content) {
      const response = await call(
        `/api/v1/computers/${encodeURIComponent(id)}/files?path=${encodeURIComponent(assertDeskPath(path))}`,
        {
          method: "PUT",
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          body: content,
        },
      );
      if (!response.ok) throw await asError(response);
    },
    async readFile(id, path) {
      const response = await call(
        `/api/v1/computers/${encodeURIComponent(id)}/files?path=${encodeURIComponent(assertDeskPath(path))}`,
      );
      if (!response.ok) throw await asError(response);
      return await response.text();
    },
    async listDir(id, path) {
      const body = await json<{ entries?: { name?: string; isDir?: boolean }[] }>(
        `/api/v1/computers/${encodeURIComponent(id)}/files/list?path=${encodeURIComponent(assertDeskPath(path))}`,
      );
      return (body.entries ?? []).map((entry) => ({
        name: entry.name ?? "",
        isDir: Boolean(entry.isDir),
      }));
    },
    async viewer(id, mode = "watch", ttlS = 3600) {
      const body = await json<{ url?: string; expiresAt?: string; mode?: string }>(
        `/api/v1/computers/${encodeURIComponent(id)}/viewer`,
        { method: "POST", body: JSON.stringify({ mode, ttlS: clamp(ttlS, 30, 3600) }) },
      );
      if (!body.url || !body.expiresAt) throw new MaritimeError("Maritime did not return a viewer link.", 502);
      return { url: body.url, expiresAt: body.expiresAt, mode: body.mode === "control" ? "control" : "watch" };
    },
    async screenshot(id) {
      const response = await call(`/api/v1/computers/${encodeURIComponent(id)}/screenshot?format=jpeg&quality=70`);
      if (!response.ok) throw await asError(response);
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        type: response.headers.get("content-type") || "image/jpeg",
      };
    },
  };
}

export function assertDeskPath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) {
    throw new MaritimeError("That path is not allowed on the desktop.", 400, "bad_path");
  }
  const ok = path === "/data" || path.startsWith("/data/") || path === "/home/desk" || path.startsWith("/home/desk/");
  if (!ok) throw new MaritimeError("Files stay under /home/desk or /data.", 400, "bad_path");
  return path;
}

/** Run a command so a tail -f of session.log shows it on the desktop the person is watching. */
export function visibleCommand(command: string): string {
  const b64 = Buffer.from(command, "utf8").toString("base64");
  return [
    "bash -lc",
    quote(`set -o pipefail; mkdir -p /home/desk/work; cd /home/desk/work || exit 1; cmd=$(printf %s ${b64} | base64 -d); printf '$ %s\\n' "$cmd" | tee -a /home/desk/work/session.log; bash -lc "$cmd" 2>&1 | tee -a /home/desk/work/session.log`),
  ].join(" ");
}

export const OPEN_DESKTOP = [
  "bash -lc",
  quote([
    "mkdir -p /home/desk/work",
    "touch /home/desk/work/session.log /home/desk/notes.txt",
    "if command -v xfce4-terminal >/dev/null 2>&1; then nohup xfce4-terminal --title=dum-intern -e 'tail -n +1 -f /home/desk/work/session.log' >/tmp/dum-term.log 2>&1 & disown || true; fi",
    "if command -v code >/dev/null 2>&1; then nohup code /home/desk/work >/tmp/dum-code.log 2>&1 & disown || true;",
    "elif command -v codium >/dev/null 2>&1; then nohup codium /home/desk/work >/tmp/dum-code.log 2>&1 & disown || true;",
    "elif command -v mousepad >/dev/null 2>&1; then nohup mousepad /home/desk/notes.txt >/tmp/dum-code.log 2>&1 & disown || true; fi",
    "echo ready",
  ].join(" ")),
].join(" ");

export function maritimeComputer(client: MaritimeClient, computerId: () => Promise<string>): Computer & {
  open(): Promise<ViewerLink>;
  screenshot(): Promise<{ bytes: Buffer; type: string }>;
} {
  let prepared = false;
  return {
    async open() {
      const id = await computerId();
      await client.wake(id);
      if (!prepared) {
        prepared = true;
        await client.exec(id, OPEN_DESKTOP, 30);
      }
      return client.viewer(id, "watch", 3600);
    },
    async run(command) {
      const id = await computerId();
      if (!prepared) {
        prepared = true;
        await client.wake(id);
        await client.exec(id, OPEN_DESKTOP, 30);
      }
      return client.exec(id, visibleCommand(command), 30);
    },
    async writeFile(path, content) {
      await client.writeFile(await computerId(), path, content);
    },
    async readFile(path) {
      return client.readFile(await computerId(), path);
    },
    async listDir(path) {
      return client.listDir(await computerId(), path);
    },
    async screenshot() {
      return client.screenshot(await computerId());
    },
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readComputer(value: unknown): ComputerInfo {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (typeof body.id !== "string" || !body.id) throw new MaritimeError("Maritime did not return a computer id.", 502);
  return {
    id: body.id,
    status: typeof body.status === "string" ? body.status : "unknown",
    externalUserId: typeof body.externalUserId === "string" ? body.externalUserId : null,
    name: typeof body.name === "string" ? body.name : null,
  };
}

async function asError(response: Response): Promise<MaritimeError> {
  let message = response.statusText || "Maritime request failed";
  let slug: string | undefined;
  try {
    const body = await response.json() as { error?: unknown; message?: unknown; detail?: unknown };
    if (typeof body.error === "string") slug = body.error;
    if (typeof body.message === "string") message = body.message;
    else if (typeof body.detail === "string") message = body.detail;
    else if (body.detail && typeof body.detail === "object") message = JSON.stringify(body.detail);
  } catch {
    /* the body was not JSON */
  }
  return new MaritimeError(slug ? `${slug}: ${message}` : message, response.status, slug);
}

// Finding the models that stay on this Mac: Ollama and LM Studio over loopback, their catalogs, and
// the setup status main shows. No loop or chat client here, so main imports this and never the backend.
// Only 127.0.0.1/::1 is ever contacted, redirects are refused, and cloud-routed Ollama models are left out.

import { z } from "zod";
import type { BackendSetup, BackendStatus, LoginMethod, ModelOption } from "./types.ts";

export type LocalServer = "ollama" | "lmstudio";
export type LocalEndpoints = Readonly<Record<LocalServer, string>>;

export const LOCAL_ENDPOINTS: LocalEndpoints = { ollama: "http://127.0.0.1:11434", lmstudio: "http://127.0.0.1:1234" };
export const SERVERS: readonly LocalServer[] = ["ollama", "lmstudio"];
export const NAMES: Readonly<Record<LocalServer, string>> = { ollama: "Ollama", lmstudio: "LM Studio" };
const UNVERIFIED = "Local endpoint could not be verified";
const OLLAMA_EFFORTS = ["low", "medium", "high"] as const;
const PROBE_MS = 2000;

const OllamaTags = z.object({
  models: z.array(z.object({ name: z.string().min(1), remote_host: z.string().optional(), remote_model: z.string().optional() }).loose()),
}).loose();
const OllamaShow = z.object({ capabilities: z.array(z.string()).default([]), remote_host: z.string().optional() }).loose();
const LmStudioModels = z.object({
  data: z.array(z.object({ id: z.string().min(1), type: z.string(), capabilities: z.array(z.string()).optional() }).loose()),
}).loose();

/** Throws unless `base` is plain http on 127.0.0.1 or ::1. */
export function loopbackBase(base: string): URL {
  const url = new URL(base);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") || url.username || url.password) {
    throw new Error(`${UNVERIFIED}: ${url.host} isn't this Mac's loopback address`);
  }
  return url;
}

/** Ollama tags that route to Ollama's cloud (`:cloud`, `-cloud`). */
export function cloudTagged(name: string): boolean {
  const tag = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : "";
  return tag === "cloud" || tag.endsWith("-cloud") || name.endsWith("-cloud");
}

async function getJson(base: string, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const url = new URL(path, loopbackBase(base));
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal,
  });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel();
    throw new Error(`${UNVERIFIED}: it tried to redirect`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${UNVERIFIED}: ${url.pathname} answered ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`${UNVERIFIED}: ${url.pathname} didn't answer JSON`);
  }
}

function parsed<T>(schema: z.ZodType<T>, data: unknown, path: string): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`${UNVERIFIED}: unexpected ${path} answer`);
  return result.data;
}

/** One server's catalog, cloud models excluded. */
export async function catalog(endpoints: LocalEndpoints, server: LocalServer, signal: AbortSignal): Promise<ModelOption[]> {
  const base = endpoints[server];
  if (server === "lmstudio") {
    const { data } = parsed(LmStudioModels, await getJson(base, "/api/v0/models", signal), "/api/v0/models");
    return data
      .filter((m) => m.type === "llm" || m.type === "vlm")
      .map((m) => ({
        id: `lmstudio/${m.id}`,
        label: `LM Studio · ${m.id}`,
        efforts: [],
        // Text-only until a real chat-completions image call passes (llm-setup-design §4.4).
        images: false,
        actions: m.capabilities?.includes("tool_use") ?? false,
        verified: false,
      }));
  }
  const { models } = parsed(OllamaTags, await getJson(base, "/api/tags", signal), "/api/tags");
  const out: ModelOption[] = [];
  for (const m of models) {
    if (m.remote_host || m.remote_model || cloudTagged(m.name)) continue;
    const show = parsed(OllamaShow, await getJson(base, "/api/show", signal, { model: m.name }), "/api/show");
    if (show.remote_host) continue;
    if (!show.capabilities.includes("completion")) continue;
    out.push({
      id: `ollama/${m.name}`,
      label: `Ollama · ${m.name}`,
      efforts: show.capabilities.includes("thinking") ? OLLAMA_EFFORTS : [],
      images: show.capabilities.includes("vision"),
      actions: show.capabilities.includes("tools"),
      verified: false,
    });
  }
  return out;
}

/** The server isn't running: nothing listens on its port. */
export function refused(e: unknown): boolean {
  const cause = e instanceof Error ? (e.cause as { code?: string } | undefined) : undefined;
  return cause?.code === "ECONNREFUSED";
}

export function localSetup(endpoints: LocalEndpoints = LOCAL_ENDPOINTS): BackendSetup {
  for (const server of SERVERS) loopbackBase(endpoints[server]);
  const methods: readonly LoginMethod[] = ["none"];
  async function status(): Promise<BackendStatus> {
    const found: string[] = [];
    const problems: string[] = [];
    let installed = false;
    let models = 0;
    for (const server of SERVERS) {
      try {
        const list = await catalog(endpoints, server, AbortSignal.timeout(PROBE_MS));
        installed = true;
        models += list.length;
        found.push(`${NAMES[server]} · ${list.length} ${list.length === 1 ? "model" : "models"}`);
      } catch (e) {
        if (!refused(e) && !(e instanceof DOMException && e.name === "TimeoutError")) problems.push(e instanceof Error ? e.message : String(e));
      }
    }
    const message = found.length ? found.join(", ") : problems[0] ?? "Not running. Get Ollama at https://ollama.com/download";
    return { id: "local", label: "On this Mac", installed, methods, ready: models > 0 ? "none" : null, loginRunning: false, loginNeedsCode: false, message };
  }
  return {
    id: "local",
    status,
    async login(method, ui) {
      if (method !== "none") throw new Error("Local models need no sign-in");
      ui.changed();
    },
    cancelLogin() {
      // No sign-in flow runs for local models.
    },
    async signOut(method) {
      if (method !== "none") throw new Error("Local models need no sign-in");
    },
  };
}

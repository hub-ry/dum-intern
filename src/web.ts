// The terminal's side of the web copy: make the link, keep both copies in step, take it down.
// Every call here fails quietly - dum works offline, and a sync that can't happen just waits.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import * as skills from "./skills.ts";
import * as sync from "./sync.ts";

export type Config = { server: string; id: string };

const file = () => `${skills.home()}/web.json`;

/** How long a sync may take before dum gets on without it. */
const TIMEOUT_MS = 4000;

export function config(): Config | null {
  try {
    const c = JSON.parse(readFileSync(file(), "utf8"));
    return typeof c?.server === "string" && typeof c?.id === "string" ? c : null;
  } catch {
    return null;
  }
}

function save(c: Config | null) {
  if (!c) {
    try {
      unlinkSync(file());
    } catch {
      /* already gone */
    }
    return;
  }
  mkdirSync(skills.home(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n");
  renameSync(tmp, file());
}

export const pageUrl = (c: Config) => `${c.server.replace(/\/+$/, "")}/${c.id}`;
const apiUrl = (c: Config, rest = "") => `${c.server.replace(/\/+$/, "")}/api/trees/${c.id}${rest}`;

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Put this tree on the server and remember where. Returns the page's URL. */
export async function link(server: string): Promise<string> {
  const base = server.replace(/\/+$/, "");
  const got = await call(`${base}/api/trees`, { method: "POST", body: JSON.stringify(sync.local()) });
  if (got.status !== 201 || typeof got.body?.id !== "string") throw new Error(got.body?.error ?? `the server said ${got.status}`);
  const c = { server: base, id: got.body.id };
  save(c);
  return pageUrl(c);
}

export type Result = { ok: true; pulled: boolean } | { ok: false; why: string };

/**
 * Both copies into one: the web's edits come down through the merge, and anything new here goes
 * up. Writes over the server only on the version it last saw, so a page edit is never lost.
 */
export async function syncNow(): Promise<Result> {
  const c = config();
  if (!c) return { ok: false, why: "not linked - dum --web <server> makes a link" };
  try {
    let remote = await call(apiUrl(c));
    for (let tries = 0; tries < 3; tries++) {
      if (remote.status === 404) return { ok: false, why: "the server has no tree at this link any more" };
      if (remote.status !== 200 && remote.status !== 409) return { ok: false, why: `the server said ${remote.status}` };
      const here = sync.local();
      const merged = sync.merge(here, remote.body.snapshot);
      const pulled = !sync.same(merged, here);
      if (pulled) sync.apply(merged);
      if (sync.same(merged, remote.body.snapshot)) return { ok: true, pulled };
      const put = await call(apiUrl(c), { method: "PUT", body: JSON.stringify({ version: remote.body.version, snapshot: merged }) });
      if (put.status === 200) return { ok: true, pulled };
      remote = put; // someone wrote in between: merge with theirs and go again
    }
    return { ok: false, why: "the tree kept changing under the sync - try again" };
  } catch (err) {
    return { ok: false, why: (err as Error).name === "TimeoutError" ? "the server didn't answer" : "couldn't reach the server" };
  }
}

let pending: ReturnType<typeof setTimeout> | null = null;

/** Sync a moment from now, once, however many changes land meanwhile. Never holds the process open. */
export function soon(after?: (r: Result) => void) {
  if (!config()) return;
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void syncNow().then((r) => after?.(r));
  }, 1500);
  pending.unref?.();
}

/** A new link for the same tree; the old one stops working. */
export async function rotate(): Promise<string> {
  const c = config();
  if (!c) throw new Error("not linked");
  const got = await call(apiUrl(c, "/rotate"), { method: "POST" });
  if (got.status !== 200 || typeof got.body?.id !== "string") throw new Error(got.body?.error ?? `the server said ${got.status}`);
  const next = { ...c, id: got.body.id };
  save(next);
  return pageUrl(next);
}

/** Take the web copy down and forget the link. The tree here is untouched. */
export async function unlink(): Promise<void> {
  const c = config();
  if (!c) return;
  try {
    await call(apiUrl(c), { method: "DELETE" });
  } finally {
    save(null);
  }
}

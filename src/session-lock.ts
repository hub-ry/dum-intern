// One dum per project at a time: two would each rewrite .dum/transcript.json and memory under
// the other. The lock is .dum/session.lock. Every change to it - taking it, taking over one whose
// process is gone, letting it go - happens only while holding .dum/session.lock.guard, created
// exclusively and held for a few synchronous file operations. So no two dums ever move, check or
// remove the lock at once, and a live holder's lock can't be swept away by a contender.

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createState, readState, statePath } from "./workspace.ts";

const LOCK = "session.lock";
const GUARD = "session.lock.guard";
const MAX = 4096;
/** How long to wait for another dum's guard: it holds it for milliseconds, never longer. */
const GUARD_WAIT_MS = 600;
const GUARD_STEP_MS = 15;

type Holder = { pid: number; host: string; who: string; token: string };

function holder(raw: string | null): Holder | null {
  if (raw === null) return null;
  try {
    const h: unknown = JSON.parse(raw);
    if (!h || typeof h !== "object") return null;
    const { pid, host, who, token } = h as Record<string, unknown>;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof host !== "string" || typeof who !== "string" || typeof token !== "string") return null;
    return { pid: pid as number, host, who, token };
  } catch {
    return null;
  }
}

/** Alive, or not ours to signal: either way not gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function record(who: string, token: string): string {
  return `${JSON.stringify({ pid: process.pid, host: hostname(), who, token, started: new Date().toISOString() })}\n`;
}

/**
 * Run `step` holding the guard, or return "busy" when another dum holds it past the short wait.
 * A guard is never taken from anyone, even a process that's gone: nothing could prove it free
 * without another guard. That one is for a person to remove; `guardBusy` says how.
 */
function guarded<T>(root: string, who: string, step: () => T): T | "busy" {
  const token = randomUUID();
  const body = record(who, token);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; ; waited += GUARD_STEP_MS) {
    if (createState(root, GUARD, body)) break;
    if (waited >= GUARD_WAIT_MS) return "busy";
    Atomics.wait(pause, 0, 0, GUARD_STEP_MS);
  }
  try {
    return step();
  } finally {
    // Only its holder removes a guard, and nobody else can make one while it stands.
    if (holder(readState(root, GUARD, MAX))?.token === token) unlinkSync(statePath(root, GUARD));
  }
}

/** Why the guard couldn't be had, and how to recover when its holder is gone. */
function guardBusy(root: string): Error {
  let h: Holder | null = null;
  try { h = holder(readState(root, GUARD, MAX)); } catch { /* unreadable: said below */ }
  if (h && h.host === hostname() && alive(h.pid)) return new Error(`another dum (${h.who}, pid ${h.pid}) is opening or closing this project - try again in a moment`);
  const by = h ? ` by ${h.who} (pid ${h.pid}${h.host === hostname() ? ", no longer running" : ` on ${h.host}`})` : "";
  return new Error(`.dum/session.lock.guard was left${by}. If no dum is open in this project, delete .dum/session.lock.guard and try again`);
}

/**
 * Hold this project for one dum, or throw saying who has it. Returns the release, which removes
 * the lock only while it is still this one. A lock whose process is gone on this machine is
 * taken over; one from another machine, or that can't be read, is left for a person to remove.
 */
export function acquire(root: string, who: "terminal" | "desktop"): () => void {
  const token = randomUUID();
  const got = guarded(root, who, () => {
    const raw = readState(root, LOCK, MAX);
    if (raw !== null) {
      const h = holder(raw);
      if (!h) throw new Error("dum can't read .dum/session.lock - if no dum is open in this project, delete that file and try again");
      if (h.host !== hostname() || alive(h.pid)) {
        throw new Error(`dum is already open in this project (${h.who}, pid ${h.pid}${h.host === hostname() ? "" : ` on ${h.host}`}) - close it there first. If it isn't running, delete .dum/session.lock`);
      }
      // Gone on this machine. Under the guard nothing else can touch the lock meanwhile.
      unlinkSync(statePath(root, LOCK));
    }
    if (!createState(root, LOCK, record(who, token))) throw new Error(".dum/session.lock appeared while dum held its guard - another program is writing there");
  });
  if (got === "busy") throw guardBusy(root);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    // Guard busy past the wait, or .dum unreadable: the lock stays, and once this process is gone
    // the next dum takes it over. Letting go never throws at exit.
    try {
      guarded(root, who, () => {
        if (holder(readState(root, LOCK, MAX))?.token === token) unlinkSync(statePath(root, LOCK));
      });
    } catch { /* left for takeover */ }
  };
}

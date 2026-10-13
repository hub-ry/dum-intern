// A named lock on Dum's own code. Several conversations can run at once, and any of them may ask
// the engineer to change Dum itself; the engineer takes this lock before editing, testing and
// restarting, and releases it after. A lock left behind by a turn that died expires on its own.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LOCK = join(homedir(), ".local", "state", "dum", "repo.lock");
export const STALE_MS = 30 * 60_000;

type Holder = { who: string; at: string };

export function holder(path: string): Holder | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Holder;
  } catch {
    return null;
  }
}

/** Takes the lock if it's free, stale, or already ours. Returns who holds it if not. */
export function tryTake(path: string, who: string, now = new Date()): { ok: true } | { ok: false; holder: Holder } {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ who, at: now.toISOString() }), { flag: "wx", mode: 0o600 });
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const h = holder(path);
      if (h && h.who === who) return { ok: true };
      if (h && now.getTime() - Date.parse(h.at) < STALE_MS) return { ok: false, holder: h };
      rmSync(path, { force: true }); // stale or unreadable: someone died holding it
    }
  }
  return { ok: false, holder: holder(path) ?? { who: "unknown", at: now.toISOString() } };
}

export function release(path: string, who: string): boolean {
  const h = holder(path);
  if (!h || h.who !== who) return false;
  rmSync(path, { force: true });
  return true;
}

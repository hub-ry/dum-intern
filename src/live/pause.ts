// The live view's off switch. An agent about to put private details on hub's screen (an address,
// a birthday, a form with personal answers) runs `dum live pause` first, and the stream stops
// before the next sample. A pause with no end lasts until `dum live resume`.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Pause } from "./live.ts";

export const DEFAULT_PAUSE = join(homedir(), ".local", "state", "dum", "live-pause.json");

export function readPause(path: string): Pause | null {
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Pause;
    return typeof p.at === "string" && (p.until === null || typeof p.until === "string") ? p : null;
  } catch {
    return null;
  }
}

/** minutes 0 pauses until resumed. */
export function writePause(path: string, minutes: number, now = new Date()): Pause {
  const p: Pause = { until: minutes > 0 ? new Date(now.getTime() + minutes * 60_000).toISOString() : null, at: now.toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(p), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return p;
}

export function clearPause(path: string): void {
  rmSync(path, { force: true });
}

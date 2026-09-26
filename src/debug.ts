// A log you can tail, for the voices that fail silently on purpose.

import { appendFileSync, mkdirSync } from "node:fs";

const DEBUG = !!process.env.DUM_DEBUG;

let LOG = "/dev/null";

export function debug(...a: unknown[]) {
  if (!DEBUG) return;
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* debugging must never be the thing that breaks the run */
  }
}

/** Pointed at the repo once one is known - `debug` is called before that. */
export function debugTo(root: string) {
  try {
    mkdirSync(`${root}/.dum`, { recursive: true });
    LOG = `${root}/.dum/debug.log`;
  } catch {
    /* leave it at /dev/null */
  }
}

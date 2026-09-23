// A log you can tail, for the voices that fail silently on purpose.
//
// The wizard fails silently by design - garnish that apologises is worse than
// garnish that is absent. But silent failure is indistinguishable from a wizard
// that simply had nothing to say, which makes it undebuggable. `DUM_DEBUG=1`
// is the seam between those two.
//
// Goes to a file, not to stderr. Under the panes there is no stderr to write
// to: Ink owns the screen, and a line printed behind its back sits there until
// the next full redraw. A log you can `tail -f` in another window is also just
// better for a thing that fires once per answer.

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

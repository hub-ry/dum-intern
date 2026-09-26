// The trackpad, for a program that took over the terminal.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/** Button events and SGR coordinates on; off again. */
export const ON = "\x1b[?1000h\x1b[?1006h";
export const OFF = "\x1b[?1000l\x1b[?1006l";

export type Wheel = { x: number; y: number; delta: number };

/** Wheel events, in terminal coordinates (1-based). */
export const mouse = new EventEmitter();

/** Scrolls routed to a pane by name: `scrolls.on("code", (delta) => ...)`. */
export const scrolls = new EventEmitter();

/** How long a held ESC waits for the rest of a mouse report before it's a keypress. */
const ESC_WAIT = 15;

/** Lines per wheel notch. */
const STEP = 3;

const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Take mouse reports out of a chunk. */
export function strip(chunk: string): { rest: string; wheels: Wheel[]; held: string } {
  const wheels: Wheel[] = [];
  let rest = chunk.replace(SGR, (_, b: string, x: string, y: string, end: string) => {
    const btn = Number(b);
    // 64 up, 65 down; the low bits can carry shift/alt/ctrl.
    if (end === "M" && (btn & 64) === 64) wheels.push({ x: Number(x), y: Number(y), delta: (btn & 1 ? 1 : -1) * STEP });
    return "";
  });
  let held = "";
  const tail = /\x1b(\[(<[\d;]*)?)?$/.exec(rest);
  if (tail) {
    held = tail[0];
    rest = rest.slice(0, tail.index);
  }
  return { rest, wheels, held };
}

/** A stdin for Ink that never sees a mouse report. */
export function filtered(real: NodeJS.ReadStream): { stdin: NodeJS.ReadStream; close: () => void } {
  const out = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  Object.assign(out, {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      real.setRawMode?.(mode);
      return out;
    },
    ref: () => {
      real.ref();
      return out;
    },
    unref: () => {
      real.unref();
      return out;
    },
  });
  let held = "";
  let timer: NodeJS.Timeout | null = null;
  const onData = (chunk: Buffer | string) => {
    if (timer) clearTimeout(timer);
    timer = null;
    const r = strip(held + chunk.toString("utf8"));
    held = r.held;
    for (const w of r.wheels) mouse.emit("wheel", w);
    if (r.rest) out.write(r.rest);
    // Nothing came to finish it: it was the escape key (or alt-[), not a report.
    if (held) {
      timer = setTimeout(() => {
        const h = held;
        held = "";
        timer = null;
        out.write(h);
      }, ESC_WAIT);
    }
  };
  real.on("data", onData);
  return {
    stdin: out,
    close: () => {
      real.off("data", onData);
      out.end();
    },
  };
}

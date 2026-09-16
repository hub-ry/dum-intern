// The line-printer renderer.
//
// What dum-intern looked like before the panes, kept for two reasons that are
// not nostalgia. Ink needs a TTY, and this program is deliberately drivable
// from a pipe - `Input` reads a whole piped stdin up front so a scripted
// session works end to end. So this is the renderer for `--plain` and for any
// non-TTY stdout.
//
// It subscribes to the store exactly like the Ink renderer does, and formats
// with the same `lines.ts`. `session.ts` cannot tell which one is attached,
// which is why there is no second path through the agent loop to keep in sync.

import { stdout, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { c, collapse, format } from "./lines.ts";
import type { Prompt, Store } from "./store.ts";

const WIDTH = 74;

export function banner(repo: string, mode: string) {
  console.log();
  console.log(`  ${c.amber("▛▚▘")} ${c.bold("dum-intern")}  ${c.dim(repo)}  ${c.blue(mode)}`);
  console.log(`  ${c.dim("it builds what you can explain.")}`);
  console.log();
}

/** Something to look at while the intern thinks. No-op off a TTY - `\r` does not erase in a pipe. */
export function thinking(label: string) {
  if (!stdout.isTTY) return () => {};
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => {
    stdout.write(`\r  ${c.amber(frames[i++ % frames.length]!)} ${c.dim(label)}`);
  }, 80);
  return () => {
    clearInterval(t);
    stdout.write(`\r${" ".repeat(label.length + 6)}\r`);
  };
}

/**
 * Terminal input, with a piped mode for testing.
 *
 * Two modes because they fail differently. At a terminal, a closed stdin means
 * you walked away and nothing should get built. Through a pipe, EOF arrives the
 * instant the data is buffered - racing there would kill a session whose
 * answers are all sitting in memory.
 */
export class Input {
  private piped: string[] | null;
  private rl: ReturnType<typeof createInterface> | null;

  constructor() {
    this.piped = stdin.isTTY ? null : readFileSync(0, "utf8").split("\n");
    while (this.piped?.length && this.piped[this.piped.length - 1] === "") this.piped.pop();
    this.rl = this.piped ? null : createInterface({ input: stdin, output: stdout });
  }

  async ask(prompt: string): Promise<string> {
    if (this.piped) {
      if (!this.piped.length) throw new Error("input ended - nothing was built");
      const line = this.piped.shift()!;
      stdout.write(prompt + line + "\n");
      return line;
    }
    return Promise.race([
      this.rl!.question(prompt),
      new Promise<never>((_, rej) =>
        this.rl!.once("close", () => rej(new Error("input ended - nothing was built"))),
      ),
    ]);
  }

  close() {
    this.rl?.close();
  }
}

/**
 * Drive a session with nothing but lines.
 *
 * The transcript is append-only, so a high-water mark is the entire diff this
 * renderer needs: no keys, no reconciliation, and no redrawing a line that has
 * already scrolled off.
 */
export async function runPlain(store: Store, input: Input): Promise<void> {
  let printed = 0;
  let wake: (() => void) | null = null;
  let stop: (() => void) | null = null;

  const draw = () => {
    const s = store.getSnapshot();
    // Kill the spinner before printing: `\r` and fresh lines fight otherwise.
    stop?.();
    stop = null;
    for (; printed < s.transcript.length; printed++) {
      for (const line of collapse(format(s.transcript[printed]!, WIDTH)))
        console.log("  " + line);
    }
    if (s.busy && !s.prompt) stop = thinking(s.status || "thinking");
    if (s.prompt && wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  store.subscribe(draw);
  draw();

  for (;;) {
    const s = store.getSnapshot();
    if (!s.prompt) {
      await new Promise<void>((r) => (wake = r));
      continue;
    }
    const reply = (await input.ask(promptFor(s.prompt))).trim();
    console.log();
    store.submit(reply);
  }
}

function promptFor(p: NonNullable<Prompt>): string {
  if (p.type === "spec") return `  ${c.bold("build this?")} ${c.dim("[y/N]")} `;
  if (p.type === "next") return `  ${c.dim("›")} `;
  return `  ${c.dim(">")} `;
}

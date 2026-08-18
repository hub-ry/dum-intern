// Everything the terminal looks like.
//
// Kept separate from the session because the whole point of running our own
// agent loop is that the terminal stays dum-intern's. The moment rendering
// lives inside the runner, it starts looking like whatever CLI is underneath.

import { stdout, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[38;5;179m${s}\x1b[0m`,
  green: (s: string) => `\x1b[38;5;108m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[38;5;110m${s}\x1b[0m`,
  red: (s: string) => `\x1b[38;5;167m${s}\x1b[0m`,
};

const WIDTH = 74;

export function wrap(text: string, indent = ""): string {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if ((line + " " + w).trim().length > WIDTH) {
        out.push(indent + line.trim());
        line = w;
      } else line += " " + w;
    }
    out.push(indent + line.trim());
  }
  return out.join("\n");
}

export function banner(repo: string, mode: string) {
  console.log();
  console.log(`  ${c.amber("▛▚▘")} ${c.bold("dum-intern")}  ${c.dim(repo)}  ${c.blue(mode)}`);
  console.log(`  ${c.dim("it builds what you can explain.")}`);
  console.log();
}

export function box(color: (s: string) => string, title: string, body: string) {
  console.log();
  console.log(`  ${color(`╭─ ${title} `)}${color("─".repeat(Math.max(0, 64 - title.length)))}`);
  for (const line of body.split("\n")) console.log(`  ${color("│")}  ${line}`);
  console.log(`  ${color("╰")}${color("─".repeat(67))}`);
  console.log();
}

export function lesson(l: {
  concept: string;
  what_it_is: string;
  why_it_exists: string;
  in_industry: string;
  here: string;
}) {
  const parts = [
    c.bold(l.concept),
    "",
    c.dim("what it is"),
    wrap(l.what_it_is, "  "),
    "",
    c.dim("why it exists"),
    wrap(l.why_it_exists, "  "),
    "",
    c.dim("in industry"),
    wrap(l.in_industry, "  "),
    "",
    c.dim("here"),
    wrap(l.here, "  "),
  ];
  box(c.amber, "wizard", parts.join("\n"));
}

export function say(text: string) {
  console.log(wrap(text, "  "));
  console.log();
}

/**
 * One line per tool call, marked with what actually happened to it.
 *
 * `held` and `refused` must look different from `ran`. A denied write that
 * renders like a successful one is a terminal that lies about what the intern
 * did, which is disqualifying for a program whose entire job is to say no.
 */
export function tool(name: string, detail: string, outcome: "ran" | "held" | "refused") {
  const mark =
    outcome === "ran" ? c.dim("·") : outcome === "held" ? c.amber("⊘") : c.red("✗");
  const note =
    outcome === "held"
      ? c.amber("  (held - no spec yet)")
      : outcome === "refused"
        ? c.red("  (refused - outside the repo)")
        : "";
  return console.log(`  ${mark} ${c.dim(name)}${detail ? c.dim("  " + detail) : ""}${note}`);
}

/** Something to look at while the intern thinks. No-op off a TTY - `\r` does not erase in a pipe. */
export function thinking(label: string) {
  if (!stdout.isTTY) {
    console.log(`  ${c.dim(label + "...")}`);
    return () => {};
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => {
    stdout.write(`\r  ${c.amber(frames[i++ % frames.length])} ${c.dim(label)}`);
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

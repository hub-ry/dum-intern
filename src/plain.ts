// The line-printer renderer.

import { stdout, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { c, collapse, format, voiceName } from "./lines.ts";
import type { Prompt, Store } from "./store.ts";

const WIDTH = 74;

export function banner(repo: string, mode: string) {
  console.log();
  console.log(`  ${c.amber("▛▚▘")} ${c.bold("dum-intern")}  ${c.dim(repo)}  ${c.blue(mode)}`);
  console.log(`  ${c.dim("it only writes what you've unlocked.")}`);
  console.log();
}

/** Something to look at while the intern thinks. */
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

/** Terminal input, with a piped mode for testing. */
export class Input {
  private rl: ReturnType<typeof createInterface> | null = null;
  /** Piped lines that arrived before anyone asked. */
  private queue: string[] = [];
  private waiter: { resolve: (l: string) => void; reject: (e: Error) => void } | null = null;
  private ended = false;

  constructor() {
    if (stdin.isTTY) {
      this.rl = createInterface({ input: stdin, output: stdout });
      return;
    }
    // Lines are read as they arrive, not slurped up front.
    const rl = createInterface({ input: stdin });
    rl.on("line", (line) => {
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve(line);
      } else this.queue.push(line);
    });
    rl.on("close", () => {
      this.ended = true;
      this.waiter?.reject(new Error("input ended - nothing was built"));
      this.waiter = null;
    });
    this.rl = rl;
  }

  async ask(prompt: string): Promise<string> {
    if (!stdin.isTTY) {
      // The prompt goes out first, so a script driving dum can see it's waiting.
      stdout.write(prompt);
      const line =
        this.queue.shift() ??
        (this.ended
          ? Promise.reject(new Error("input ended - nothing was built"))
          : new Promise<string>((resolve, reject) => (this.waiter = { resolve, reject })));
      const got = await line;
      stdout.write(got + "\n");
      return got;
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

/** Drive a session with nothing but lines. */
export async function runPlain(store: Store, input: Input): Promise<void> {
  let printed = 0;
  // Said once, when the intern's model is first known, and again only if a voice changes model
  // - a line printer has no corner to keep it in.
  let models = "";
  let shown: unknown = null;
  let wake: (() => void) | null = null;
  let stop: (() => void) | null = null;

  const draw = () => {
    const s = store.getSnapshot();
    // Kill the spinner before printing: `\r` and fresh lines fight otherwise.
    stop?.();
    stop = null;
    const v = (x: { model: string; effort: string }) => voiceName(x.model, x.effort);
    // Held until the effort is read back, which lands a beat after the model.
    const ready = s.models.intern.model && (s.models.intern.effort || s.transcript.some((e) => e.kind === "say"));
    const said = ready
      ? `dum is ${v(s.models.intern)}${s.models.wizard.model ? `, the wizard is ${v(s.models.wizard)}` : ""}`
      : "";
    if (said && said !== models) {
      models = said;
      console.log("  " + c.dim(said));
    }
    // Help and hints go to the stage in the panes; here they're just printed.
    if (s.stage.kind === "info" && s.stage !== shown) {
      shown = s.stage;
      console.log(`  ${c.bold(s.stage.title)}`);
      for (const l of s.stage.body.split("\n")) console.log(`  ${c.dim(l)}`);
      console.log();
    }
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

  let hinted: Prompt = null;
  for (;;) {
    const s = store.getSnapshot();
    if (!s.prompt) {
      await new Promise<void>((r) => (wake = r));
      continue;
    }
    // Once per prompt.
    if (s.prompt !== hinted) {
      hinted = s.prompt;
      // No editor here, so the hole is typed in yours - the line says where.
      const t = s.prompt.type === "next" ? s.todos[0] : undefined;
      const how = s.mode === "anti-vibe" ? "explain it here" : "type it and say done";
      if (t) console.log(`  ${c.dim(`your turn: ${t.concept} in ${t.path} - ${how}, or course ${t.concept}`)}`);
      if (s.prompt.type === "plan") console.log(`  ${c.dim("y builds it · course <skill> unlocks one first")}`);
      if (s.prompt.type === "course") console.log(`  ${c.dim(`type the gap in ${s.prompt.card.path} and say done · quit leaves`)}`);
    }
    const reply = (await input.ask(promptFor(s.prompt))).trim();
    console.log();
    store.submit(reply);
  }
}

function promptFor(p: NonNullable<Prompt>): string {
  if (p.type === "plan") return `  ${c.bold("build this?")} ${c.dim("[y/N]")} `;
  if (p.type === "course") return `  ${c.amber("course ›")} `;
  if (p.type === "next") return `  ${c.dim("›")} `;
  return `  ${c.dim(">")} `;
}

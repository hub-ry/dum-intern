// The terminal: one conversation in native scrollback, the same for a TTY and for a pipe. The
// cast keeps its faces beside what they say; the only live line is the input at the bottom.

import { createInterface, clearScreenDown, cursorTo, moveCursor, type Interface } from "node:readline";
import { c, collapse, expression, format, hang, inert, infoLines, printable, speaker, turn, voiceName, wrap } from "./lines.ts";
import { load, framesFor, draw, type Sprite } from "./sprite.ts";
import type { Entry, Prompt, State, Store } from "./store.ts";

const ART = new URL("./art/", import.meta.url).pathname;
/** Width of a pipe's lines: a terminal has its own. */
const PIPE_WIDTH = 74;
/** The widest face, so words beside either line up. */
const FACE_WIDTH = 9;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Out = NodeJS.WritableStream & { isTTY?: boolean; columns?: number };
type In = NodeJS.ReadableStream & { isTTY?: boolean };
type Faces = { dum: Sprite; wizard: Sprite };

export type Options = {
  /** Transcript entries before this index are older history: only the newest few are reprinted. */
  history: number;
  /** The session is over from the terminal's side: input ended (0) or ctrl-c with nothing to stop (130). */
  onEnd: (code: number) => void;
  input?: In;
  output?: Out;
  /** Colour only. NO_COLOR keeps both faces in monochrome. */
  color?: boolean;
};

/** How many restored entries are reprinted at startup; :log shows the rest. */
export const HISTORY_SHOWN = 6;

/** The faces, or null: missing art is a cosmetic failure and must stay one. */
function sprites(): Faces | null {
  try {
    return { dum: load(ART + "intern.txt"), wizard: load(ART + "wizard.txt") };
  } catch {
    return null;
  }
}

/** Every entry as the terminal draws it, faces included: what :log and tools/replay print. */
export function transcriptLines(entries: Entry[], width: number, color = true): string[] {
  const t = new Lines(width, sprites());
  return entries.flatMap((e) => t.entry(e)).map((line) => color ? line : printable(line));
}

/** Turns entries into lines, remembering who spoke last so a face shows when the speaker changes. */
class Lines {
  last: string | null = null;
  constructor(
    readonly width: number,
    readonly faces: Faces | null,
  ) {}

  entry(e: Entry): string[] {
    const who = speaker(e);
    if (!who || who === "you") {
      if (who) this.last = who;
      return collapse(format(e, this.width));
    }
    const gutter = this.faces ? FACE_WIDTH + 2 : 2;
    const body = format(e, this.width - gutter);
    if (who === this.last) return collapse(body.map((l) => (l ? " ".repeat(gutter) + l : l)));
    this.last = who;
    const sprite = this.faces?.[who];
    const face = sprite ? draw(sprite, framesFor(sprite, expression(e))[0]!) : null;
    const name = who === "dum" ? c.bold(c.blue("dum")) : c.bold(c.amber("wizard"));
    return ["", ...collapse(turn(face, FACE_WIDTH, name, body))];
  }
}

/** The line the input sits on. */
function promptFor(p: NonNullable<Prompt>): string {
  if (p.type === "plan") return `  ${c.bold("build this?")} ${c.dim("[y/N] ›")} `;
  if (p.type === "course") return `  ${c.amber("course ›")} `;
  return `  ${c.blue("›")} `;
}

/** A face, padded to the widest one so what's beside it lines up. */
function padFace(row: string | undefined): string {
  return (row ?? "") + " ".repeat(Math.max(0, FACE_WIDTH - printable(row ?? "").length));
}

export class Terminal {
  private readonly input: In;
  private readonly output: Out;
  private readonly tty: boolean;
  private readonly color: boolean;
  private readonly rl: Interface;
  private readonly lines: Lines;
  private readonly unsubscribe: () => void;
  private printed: number;
  private models = "";
  private shown: State["stage"] | null = null;
  private spin = 0;
  private timer: NodeJS.Timeout | null = null;
  /** Pipe input waits for a prompt; a terminal's goes straight to the store. */
  private queue: string[] = [];
  private ended = false;
  private stopped = false;
  private delivering = false;
  /** A pipe: the prompt is written and the line it waits for isn't. */
  private bare = false;
  private readonly sigint = () => this.interrupt();

  constructor(
    private readonly store: Store,
    private readonly opts: Options,
  ) {
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
    this.tty = !!(this.input.isTTY && this.output.isTTY);
    this.color = opts.color ?? !process.env.NO_COLOR;
    const width = this.tty ? Math.max(40, Math.min(100, (this.output.columns ?? 80) - 4)) : PIPE_WIDTH;
    this.lines = new Lines(width, sprites());
    this.printed = Math.max(0, Math.min(opts.history, store.getSnapshot().transcript.length) - HISTORY_SHOWN);

    this.rl = this.tty
      ? createInterface({ input: this.input, output: this.output, terminal: true, historySize: 200 })
      : createInterface({ input: this.input, terminal: false });
    this.rl.setPrompt(this.paint(`  ${c.dim("›")} `));
    this.rl.on("line", (line) => this.typed(line));
    this.rl.on("close", () => {
      this.ended = true;
      // ctrl-d at a terminal, or the end of a pipe: once nothing is left to answer, that's the end.
      this.deliver();
    });
    // ctrl-c: readline sees it on a terminal; a pipe gets the signal.
    if (this.tty) this.rl.on("SIGINT", this.sigint);
    else process.on("SIGINT", this.sigint);

    this.banner();
    this.unsubscribe = store.subscribe(() => this.draw());
    this.draw();
  }

  /** The whole conversation so far, reprinted: :log. */
  log() {
    const all = this.store.getSnapshot().transcript;
    this.print(["", c.bold(`conversation so far · ${all.length} entries`), ...transcriptLines(all, this.lines.width, this.color), c.dim("end of the log"), ""]);
    this.lines.last = null;
  }

  /** Idempotent: a restart, an exit and the end of input can all arrive at once. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    process.off("SIGINT", this.sigint);
    this.rl.removeAllListeners("close");
    this.rl.removeAllListeners("line");
    if (this.tty) this.clearInput();
    else if (this.bare) this.output.write("\n");
    this.rl.close();
  }

  // -- drawing ------------------------------------------------------------

  private paint(text: string): string {
    return this.color ? text : printable(text);
  }

  private banner() {
    const s = this.store.getSnapshot();
    const v = (who: "intern" | "wizard") => inert(voiceName(s.models[who].model, s.models[who].effort));
    this.models = this.said(s);
    const out = [""];
    const faces = this.lines.faces;
    if (faces) {
      const wiz = draw(faces.wizard, framesFor(faces.wizard, "idle")[0]!);
      const dum = draw(faces.dum, framesFor(faces.dum, "idle")[0]!);
      const label = [
        [c.bold(c.amber("wizard")), c.bold(c.blue("dum"))],
        [c.dim(v("wizard")), c.dim(v("intern"))],
        [c.dim("anchors from real practice"), c.dim("your intern: learns from you")],
      ];
      const rows = Math.max(wiz.length, dum.length);
      const left = Array.from({ length: rows }, (_, i) => `${padFace(wiz[i])}  ${label[i]?.[0] ?? ""}`.trimEnd());
      const right = Array.from({ length: rows }, (_, i) => `${padFace(dum[i])}  ${label[i]?.[1] ?? ""}`.trimEnd());
      // Side by side where both columns fit; a narrow terminal gets them one above the other.
      const column = 40;
      if (column + Math.max(...right.map((r) => printable(r).length)) <= this.lines.width) {
        for (let i = 0; i < rows; i++) out.push(`${left[i]}${" ".repeat(Math.max(1, column - printable(left[i]!).length))}${right[i]}`);
      } else out.push(...left, "", ...right);
      out.push("");
    } else if (this.models) out.push(c.dim(this.models));
    out.push(`${c.amber("▛▚▘")} ${c.bold("dum-intern")}  ${c.dim(inert(s.repo))}  ${c.blue(s.mode)}`);
    out.push(...wrap("edit in your own editor; :inspect and :changes share your saved work. :help lists commands.", "", this.lines.width).map((l) => c.dim(l)), "");
    this.print(out);
  }

  /** Both voices as a sentence, once they're known. */
  private said(s: State): string {
    if (!s.models.intern.model) return "";
    const wizard = s.models.wizard.model ? `, the wizard is ${voiceName(s.models.wizard.model, s.models.wizard.effort)}` : "";
    return inert(`dum is ${voiceName(s.models.intern.model, s.models.intern.effort)}${wizard}`);
  }

  private draw() {
    if (this.stopped) return;
    const s = this.store.getSnapshot();
    const out: string[] = [];
    // Said again only if a voice changes model: a line printer has no corner to keep it in.
    const said = this.said(s);
    if (said && said !== this.models) {
      this.models = said;
      out.push(c.dim(said));
    }
    for (; this.printed < s.transcript.length; this.printed++) {
      const e = s.transcript[this.printed]!;
      // What you type is already on screen where you typed it.
      if (e.kind === "user" && this.printed >= this.opts.history) {
        this.lines.last = "you";
        continue;
      }
      out.push(...this.lines.entry(e));
    }
    if (s.stage.kind === "info" && s.stage !== this.shown) {
      this.shown = s.stage;
      const body = infoLines(s.stage.body).flatMap((l) => hang(l, this.lines.width));
      out.push("", c.bold(inert(s.stage.title)), ...body, "");
      this.lines.last = null;
    }
    if (out.length) this.print(out);
    this.status(s);
    this.deliver();
  }

  /** Lines above the input, which is redrawn beneath them with whatever was half typed. */
  private print(lines: string[]) {
    const body = this.paint(lines.map((l) => (l ? "  " + l : "")).join("\n") + "\n");
    if (!this.tty) {
      if (this.bare) this.output.write("\n");
      this.bare = false;
      this.output.write(body);
      return;
    }
    this.clearInput();
    this.output.write(body);
    if (!this.stopped) this.rl.prompt(true);
  }

  /** Wipe the input line (and any rows it wrapped onto), leaving the cursor where it began. */
  private clearInput() {
    const rows = this.rl.getCursorPos().rows;
    if (rows) moveCursor(this.output, 0, -rows);
    cursorTo(this.output, 0);
    clearScreenDown(this.output);
  }

  /** The input line says what's waiting: your answer, or what dum is busy with. */
  private status(s: State) {
    if (!this.tty || this.stopped) return;
    const busy = !this.store.inputReady && (s.busy || !!s.status);
    if (busy && !this.timer) {
      this.timer = setInterval(() => {
        this.spin++;
        this.status(this.store.getSnapshot());
      }, 100);
      this.timer.unref();
    }
    if (!busy) {
      clearInterval(this.timer ?? undefined);
      this.timer = null;
    }
    const text = this.paint(
      s.prompt && this.store.inputReady
        ? promptFor(s.prompt)
        : busy
          ? `  ${c.amber(SPIN[this.spin % SPIN.length]!)} ${c.dim(inert(s.status || "thinking").replace(/\s+/g, " ").slice(0, 60))}  ${c.dim("›")} `
          : `  ${c.dim("›")} `,
    );
    if (this.rl.getPrompt() === text) return;
    this.rl.setPrompt(text);
    this.rl.prompt(true);
  }

  // -- input --------------------------------------------------------------

  private typed(line: string) {
    if (this.stopped) return;
    if (!this.tty) {
      this.queue.push(line);
      this.deliver();
      return;
    }
    // Readline left `prompt + line` behind; rewrite it the way the conversation shows a reply.
    const rows = Math.max(1, Math.ceil(printable(this.rl.getPrompt() + line).length / (this.output.columns ?? 80)));
    moveCursor(this.output, 0, -rows);
    cursorTo(this.output, 0);
    clearScreenDown(this.output);
    if (line.trim()) this.output.write(this.paint(`  ${c.dim("›")} ${inert(line)}\n`));
    this.lines.last = "you";
    // An empty line answers a prompt (a plan's "no"); while dum works it's nothing. A line typed
    // while dum works is kept by the store for its next question, or run if it's a command.
    if (line.trim() || this.store.getSnapshot().prompt) this.store.submit(line.trim());
    if (this.stopped) return;
    this.status(this.store.getSnapshot());
    this.rl.prompt(true);
  }

  /** Hand queued pipe lines over one per prompt, and end once input has run out at a prompt. */
  private deliver() {
    if (this.delivering || this.stopped) return;
    this.delivering = true;
    try {
      while (!this.stopped) {
        const s = this.store.getSnapshot();
        // Ended with dum working: it finishes, and the end is noticed at its next prompt.
        if (!s.prompt || !this.store.inputReady) return;
        if (this.tty) {
          if (this.ended) this.opts.onEnd(0);
          return;
        }
        const prompt = this.paint(promptFor(s.prompt));
        const line = this.queue.shift();
        if (line === undefined) {
          if (this.ended) {
            this.print([c.dim("input ended.")]);
            this.opts.onEnd(0);
            return;
          }
          // Written first, so a script driving dum can see it's waiting.
          if (!this.bare) this.output.write(prompt);
          this.bare = true;
          return;
        }
        this.output.write(`${this.bare ? "" : prompt}${inert(line)}\n`);
        this.bare = false;
        this.lines.last = "you";
        this.store.submit(line.trim());
      }
    } finally {
      this.delivering = false;
    }
  }

  /** ctrl-c: stops what dum is doing and keeps the session; with nothing to stop, leaves. */
  private interrupt() {
    if (this.stopped) return;
    if (this.store.getSnapshot().busy && this.store.onInterrupt) {
      this.print([c.dim("interrupting dum - ctrl-c while it's idle quits")]);
      this.store.onInterrupt();
      return;
    }
    this.opts.onEnd(130);
  }
}

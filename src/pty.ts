// A real shell for the stage's shell page: node-pty runs it, xterm's headless
// emulator keeps the screen. Started on first use, alive for the session.

import * as pty from "node-pty";
import xterm from "@xterm/headless";
import { EventEmitter } from "node:events";

export type Row = { text: string };

class Shell extends EventEmitter {
  private p: pty.IPty | null = null;
  private term: xterm.Terminal | null = null;
  private size = { cols: 80, rows: 24 };
  private cwd = process.cwd();
  private pending = false;

  /** Where it starts. Only takes effect before the first start. */
  setCwd(cwd: string) {
    this.cwd = cwd;
  }

  get started() {
    return this.p !== null;
  }

  start() {
    if (this.p) return;
    const shell = process.env.SHELL || "/bin/sh";
    this.term = new xterm.Terminal({ ...this.size, scrollback: 2000, allowProposedApi: true });
    this.p = pty.spawn(shell, [], {
      name: "xterm-256color",
      ...this.size,
      cwd: this.cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    this.p.onData((d) => this.term!.write(d, () => this.changed()));
    this.p.onExit(() => {
      this.p = null;
      this.term = null;
      this.changed();
    });
  }

  /** Coalesce redraws: output arrives in bursts. */
  private changed() {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this.emit("change");
    }, 16);
  }

  write(data: string) {
    this.start();
    this.term?.scrollToBottom();
    this.p?.write(data);
  }

  resize(cols: number, rows: number) {
    cols = Math.max(10, cols);
    rows = Math.max(3, rows);
    if (cols === this.size.cols && rows === this.size.rows) return;
    this.size = { cols, rows };
    this.term?.resize(cols, rows);
    this.p?.resize(cols, rows);
  }

  scroll(delta: number) {
    this.term?.scrollLines(delta);
    this.changed();
  }

  /** The visible screen, one ANSI-coloured string per row, and the cursor if it's on screen. */
  screen(): { rows: string[]; cursor: { x: number; y: number } | null } {
    const t = this.term;
    if (!t) return { rows: [], cursor: null };
    const b = t.buffer.active;
    const rows: string[] = [];
    for (let i = 0; i < t.rows; i++) rows.push(paint(b.getLine(b.viewportY + i)));
    const y = b.baseY + b.cursorY - b.viewportY;
    return { rows, cursor: y >= 0 && y < t.rows ? { x: b.cursorX, y } : null };
  }

  /** The program running in the foreground, if it isn't the shell itself. "" when idle. */
  running(): string {
    if (!this.p) return "";
    const fg = this.p.process;
    const sh = (process.env.SHELL || "/bin/sh").split("/").pop();
    return fg && fg !== sh && !/^-?(zsh|bash|sh|fish)$/.test(fg) ? fg : "";
  }

  kill() {
    this.p?.kill();
    this.p = null;
  }
}

/** One buffer line as text with foreground colour, bold and inverse kept. */
function paint(line: xterm.IBufferLine | undefined): string {
  if (!line) return "";
  let out = "";
  let last = "";
  let end = line.length;
  while (end > 0 && !line.getCell(end - 1)?.getChars()) end--;
  for (let x = 0; x < end; x++) {
    const c = line.getCell(x)!;
    const fg = c.isFgDefault()
      ? ""
      : c.isFgPalette()
        ? `38;5;${c.getFgColor()}`
        : `38;2;${(c.getFgColor() >> 16) & 255};${(c.getFgColor() >> 8) & 255};${c.getFgColor() & 255}`;
    const sgr = [fg, c.isBold() ? "1" : "", c.isInverse() ? "7" : ""].filter(Boolean).join(";");
    if (sgr !== last) {
      out += `\x1b[0m${sgr ? `\x1b[${sgr}m` : ""}`;
      last = sgr;
    }
    out += c.getChars() || " ";
  }
  return out + (last ? "\x1b[0m" : "");
}

export const shell = new Shell();

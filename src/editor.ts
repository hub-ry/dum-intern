// A text buffer with a cursor, and what every key does to it.
//
// Kept out of the component for the reason typing.ts is: it can be tested
// without a terminal, and the pane stays a viewport that draws whatever this
// says. Modal, with vim's keys, because the tree beside it already speaks
// them - but the arrows, home/end and page keys work in both modes, so nobody
// who never learned vim is locked out of reading a file. Editing needs `i`.

export type Key = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
};

export const NONE: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageUp: false,
  pageDown: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

export const key = (k: Partial<Key>): Key => ({ ...NONE, ...k });

export type Mode = "normal" | "insert";

type Snap = { lines: string[]; row: number; col: number };

export type Buf = {
  /** Never empty: a file with nothing in it is one empty line. */
  lines: string[];
  /** Whether the file ended in a newline, so saving does not add or lose one. */
  eol: boolean;
  row: number;
  col: number;
  /** The column the cursor wants, so j/k across a short line come back out at the same place. */
  want: number;
  top: number;
  left: number;
  mode: Mode;
  /** A `:` command or `/` search being typed. */
  cmd: { kind: ":" | "/"; text: string } | null;
  /** The lines as last written, by identity. Dirty is "not this array". */
  saved: string[];
  undo: Snap[];
  redo: Snap[];
  /** Whole lines from dd or yy. Linewise only; that covers what a pane like this is for. */
  reg: string[];
  search: string;
  /** A key waiting for its second half: gg, dd, yy. */
  pending: "" | "g" | "d" | "y";
  /** One line for the status row, gone on the next key. */
  message: string;
  /** Why this cannot be edited, or "" if it can. */
  readOnly: string;
};

export type View = { rows: number; cols: number };

/**
 * What a key asks of the world outside the buffer. `cmd:` is one of dum's own
 * commands typed on the `:` line (`:run`, `:graph`, `:log`), and `shell:` is
 * vim's `:!` - the pane passes both up rather than knowing what they do.
 */
export type Effect = "save" | "leave" | "reload" | `cmd:${string}` | `shell:${string}`;

/** dum's commands, the same on the input line and on the file's `:` line. */
export const COMMANDS = ["run", "graph", "log", "help"] as const;

const UNDO_MAX = 200;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function open(text: string, opts: { readOnly?: string; at?: number } = {}): Buf {
  const eol = text.endsWith("\n");
  const lines = (eol ? text.slice(0, -1) : text).split("\n");
  return {
    lines,
    eol,
    row: clamp(opts.at ?? 0, 0, lines.length - 1),
    col: 0,
    want: 0,
    top: 0,
    left: 0,
    mode: "normal",
    cmd: null,
    saved: lines,
    undo: [],
    redo: [],
    reg: [],
    search: "",
    pending: "",
    message: "",
    readOnly: opts.readOnly ?? "",
  };
}

export const text = (b: Buf): string => b.lines.join("\n") + (b.eol ? "\n" : "");

export const dirty = (b: Buf): boolean => b.lines !== b.saved;

/** The file was written: what is on screen is what is on disk. */
export const saved = (b: Buf): Buf => ({ ...b, saved: b.lines });

export const tell = (b: Buf, message: string): Buf => ({ ...b, message });

/** Where a buffer column lands on screen, with tabs drawn two wide. */
export function vcol(line: string, col: number): number {
  let v = 0;
  for (let i = 0; i < col && i < line.length; i++) v += line[i] === "\t" ? 2 : 1;
  return v + Math.max(0, col - line.length);
}

/** Put the cursor on a line, at its first character, as `:` number does. */
export function goto(b: Buf, row: number): Buf {
  const r = clamp(row, 0, b.lines.length - 1);
  const col = firstNonBlank(b.lines[r]!);
  return { ...b, row: r, col, want: col };
}

/**
 * Keep the cursor on screen.
 *
 * Scrolls only when the cursor leaves the window, with a few lines of margin,
 * rather than centring on every move the way the tree does - an editor that
 * recentres under you is one you cannot read while you move.
 */
export function scroll(b: Buf, view: View): Buf {
  const rows = Math.max(1, view.rows);
  const cols = Math.max(1, view.cols);
  const off = Math.min(3, Math.floor((rows - 1) / 2));
  let top = b.top;
  if (b.row < top + off) top = b.row - off;
  else if (b.row > top + rows - 1 - off) top = b.row - rows + 1 + off;
  top = clamp(top, 0, Math.max(0, b.lines.length - rows));

  const v = vcol(b.lines[b.row]!, b.col);
  let left = b.left;
  if (v < left) left = v;
  else if (v >= left + cols) left = v - cols + 1;
  left = Math.max(0, left);

  return top === b.top && left === b.left ? b : { ...b, top, left };
}

export function press(b: Buf, ch: string, key: Key, view: View): { buf: Buf; effects: Effect[] } {
  const clean = b.message ? { ...b, message: "" } : b;
  const r = clean.cmd
    ? command(clean, ch, key)
    : clean.mode === "insert"
      ? insert(clean, ch, key, view)
      : normal(clean, ch, key, view);
  return { buf: scroll(r.buf, view), effects: r.effects ?? [] };
}

/** Pasted text lands at the cursor in either mode, as one undo step. */
export function paste(b: Buf, s: string): Buf {
  if (b.cmd) return { ...b, cmd: { ...b.cmd, text: b.cmd.text + s.replace(/[\r\n]+/g, " ") } };
  if (b.readOnly) return tell(b, `read only - ${b.readOnly}`);
  const at = b.mode === "insert" ? b : snap(b);
  return insertText(at, s.replace(/\r\n|\r/g, "\n"));
}

type Step = { buf: Buf; effects?: Effect[] };

// -- movement ---------------------------------------------------------------

const maxCol = (b: Buf, row: number) => {
  const len = b.lines[row]!.length;
  return b.mode === "insert" ? len : Math.max(0, len - 1);
};

function to(b: Buf, row: number, col: number, keepWant = false): Buf {
  row = clamp(row, 0, b.lines.length - 1);
  col = clamp(col, 0, maxCol(b, row));
  return { ...b, row, col, want: keepWant ? b.want : col };
}

const vertical = (b: Buf, by: number) => to(b, b.row + by, b.want, true);

const firstNonBlank = (line: string) => Math.max(0, line.search(/\S|$/));

const kind = (c: string | undefined) => (c === undefined || /\s/.test(c) ? 0 : /\w/.test(c) ? 1 : 2);

/** The start of the next word, the way `w` finds it: across lines, stopping on an empty one. */
function nextWord(b: Buf): [number, number] {
  let { row, col } = b;
  const line = b.lines[row]!;
  const k = kind(line[col]);
  if (k) while (col < line.length && kind(line[col]) === k) col++;
  for (;;) {
    const l = b.lines[row]!;
    while (col < l.length && kind(l[col]) === 0) col++;
    if (col < l.length) return [row, col];
    if (row === b.lines.length - 1) return [row, Math.max(0, l.length - 1)];
    row++;
    col = 0;
    if (!b.lines[row]!.length) return [row, 0];
  }
}

/** The start of this word, or the previous one if already there. */
function prevWord(b: Buf): [number, number] {
  let { row, col } = b;
  for (;;) {
    if (col > 0) col--;
    else if (row > 0) {
      row--;
      col = b.lines[row]!.length;
      if (!col) return [row, 0];
      col--;
    } else return [0, 0];
    const l = b.lines[row]!;
    if (kind(l[col]) === 0) continue;
    const k = kind(l[col]);
    while (col > 0 && kind(l[col - 1]) === k) col--;
    return [row, col];
  }
}

// -- editing ----------------------------------------------------------------

function snap(b: Buf): Buf {
  const undo = [...b.undo, { lines: b.lines, row: b.row, col: b.col }].slice(-UNDO_MAX);
  return { ...b, undo, redo: [] };
}

const splice = (lines: string[], row: number, count: number, ...repl: string[]) => [
  ...lines.slice(0, row),
  ...repl,
  ...lines.slice(row + count),
];

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];

/** Insert text at the cursor. Newlines in it become lines. */
function insertText(b: Buf, s: string): Buf {
  const line = b.lines[b.row]!;
  const before = line.slice(0, b.col);
  const after = line.slice(b.col);
  const parts = s.split("\n");
  if (parts.length === 1) {
    const col = b.col + s.length;
    return { ...b, lines: splice(b.lines, b.row, 1, before + s + after), col, want: col };
  }
  const repl = [before + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + after];
  const row = b.row + parts.length - 1;
  const col = parts[parts.length - 1]!.length;
  return { ...b, lines: splice(b.lines, b.row, 1, ...repl), row, col, want: col };
}

/** Enter in insert mode: the new line starts where this one did. */
function newline(b: Buf): Buf {
  const line = b.lines[b.row]!;
  const indent = indentOf(line).slice(0, b.col);
  const next = indent + line.slice(b.col).trimStart();
  return {
    ...b,
    lines: splice(b.lines, b.row, 1, line.slice(0, b.col), next),
    row: b.row + 1,
    col: indent.length,
    want: indent.length,
  };
}

function backspace(b: Buf): Buf {
  const line = b.lines[b.row]!;
  if (b.col > 0) {
    const col = b.col - 1;
    return { ...b, lines: splice(b.lines, b.row, 1, line.slice(0, col) + line.slice(b.col)), col, want: col };
  }
  if (b.row === 0) return b;
  const prev = b.lines[b.row - 1]!;
  return { ...b, lines: splice(b.lines, b.row - 1, 2, prev + line), row: b.row - 1, col: prev.length, want: prev.length };
}

function forwardDelete(b: Buf): Buf {
  const line = b.lines[b.row]!;
  if (b.col < line.length) {
    return { ...b, lines: splice(b.lines, b.row, 1, line.slice(0, b.col) + line.slice(b.col + 1)) };
  }
  if (b.row === b.lines.length - 1) return b;
  return { ...b, lines: splice(b.lines, b.row, 2, line + b.lines[b.row + 1]!) };
}

function deleteLines(b: Buf, row: number, count: number): Buf {
  const reg = b.lines.slice(row, row + count);
  let lines = splice(b.lines, row, count);
  if (!lines.length) lines = [""];
  const at = clamp(row, 0, lines.length - 1);
  return to({ ...b, lines, reg }, at, firstNonBlank(lines[at]!));
}

function put(b: Buf, above: boolean): Buf {
  if (!b.reg.length) return tell(b, "nothing to put - dd or yy first");
  const at = above ? b.row : b.row + 1;
  const lines = splice(b.lines, at, 0, ...b.reg);
  return to({ ...snap(b), lines }, at, firstNonBlank(lines[at]!));
}

function undo(b: Buf): Buf {
  const last = b.undo[b.undo.length - 1];
  if (!last) return tell(b, "already at oldest change");
  const redo = [...b.redo, { lines: b.lines, row: b.row, col: b.col }];
  return to({ ...b, lines: last.lines, undo: b.undo.slice(0, -1), redo }, last.row, last.col);
}

function redo(b: Buf): Buf {
  const next = b.redo[b.redo.length - 1];
  if (!next) return tell(b, "already at newest change");
  const undo = [...b.undo, { lines: b.lines, row: b.row, col: b.col }];
  return to({ ...b, lines: next.lines, redo: b.redo.slice(0, -1), undo }, next.row, next.col);
}

// -- search -----------------------------------------------------------------

/** Next match after the cursor (or before, backwards), wrapping once. */
function find(b: Buf, back: boolean): Buf {
  if (!b.search) return tell(b, "nothing to search for - / first");
  // Smart case: a pattern with no capitals ignores case, the way it does in
  // vim and most editors' find boxes.
  const fold = b.search === b.search.toLowerCase();
  const norm = (s: string) => (fold ? s.toLowerCase() : s);
  const pat = norm(b.search);
  const n = b.lines.length;
  for (let step = 0; step <= n; step++) {
    const row = (((back ? b.row - step : b.row + step) % n) + n) % n;
    const line = norm(b.lines[row]!);
    let col: number;
    if (step === 0) {
      col = back ? line.lastIndexOf(pat, b.col - 1) : line.indexOf(pat, b.col + 1);
      if (back && b.col === 0) col = -1;
    } else if (step === n) {
      // Back where we started: only the cursor's own position is left.
      col = line.indexOf(pat) === b.col ? b.col : -1;
    } else col = back ? line.lastIndexOf(pat) : line.indexOf(pat);
    if (col >= 0) {
      const wrapped = back ? row > b.row || (row === b.row && col > b.col) : row < b.row || (row === b.row && col < b.col);
      const moved = to(b, row, col);
      return wrapped ? tell(moved, back ? "search hit top, continuing at bottom" : "search hit bottom, continuing at top") : moved;
    }
  }
  return tell(b, `not found: ${b.search}`);
}

// -- modes ------------------------------------------------------------------

const readOnly = (b: Buf): Step => ({ buf: tell(b, `read only - ${b.readOnly}`) });

function normal(b: Buf, ch: string, key: Key, view: View): Step {
  const rows = Math.max(1, view.rows);

  if (b.pending) {
    const p = b.pending;
    b = { ...b, pending: "" };
    if (p === "g" && ch === "g") return { buf: to(b, 0, firstNonBlank(b.lines[0]!)) };
    if (p === "d" && ch === "d") return b.readOnly ? readOnly(b) : { buf: deleteLines(snap(b), b.row, 1) };
    if (p === "y" && ch === "y") return { buf: tell({ ...b, reg: [b.lines[b.row]!] }, "yanked 1 line") };
    // A half-typed chord followed by something else is nothing, not a
    // different command: `gj` must not move down.
    return { buf: b };
  }

  if (key.escape) return { buf: b, effects: ["leave"] };
  if (key.ctrl && ch === "s") return { buf: b, effects: ["save"] };

  // moving
  if (key.downArrow || ch === "j" || (key.ctrl && ch === "n")) return { buf: vertical(b, 1) };
  if (key.upArrow || ch === "k" || (key.ctrl && ch === "p")) return { buf: vertical(b, -1) };
  if (key.return) return { buf: to(b, b.row + 1, firstNonBlank(b.lines[Math.min(b.row + 1, b.lines.length - 1)]!)) };
  if (key.leftArrow || ch === "h") return { buf: to(b, b.row, b.col - 1) };
  if (key.rightArrow || ch === "l") return { buf: to(b, b.row, b.col + 1) };
  if (key.home || ch === "0") return { buf: to(b, b.row, 0) };
  if (key.end || ch === "$") return { buf: to(b, b.row, Infinity) };
  if (ch === "^") return { buf: to(b, b.row, firstNonBlank(b.lines[b.row]!)) };
  if (ch === "w") return { buf: to(b, ...nextWord(b)) };
  if (ch === "b") return { buf: to(b, ...prevWord(b)) };
  if (ch === "G") return { buf: to(b, Infinity, firstNonBlank(b.lines[b.lines.length - 1]!)) };
  if (ch === "g") return { buf: { ...b, pending: "g" } };
  if (key.ctrl && ch === "d") return { buf: vertical(b, Math.floor(rows / 2)) };
  if (key.ctrl && ch === "u") return { buf: vertical(b, -Math.floor(rows / 2)) };
  if (key.pageDown || (key.ctrl && ch === "f")) return { buf: vertical(b, Math.max(1, rows - 2)) };
  if (key.pageUp || (key.ctrl && ch === "b")) return { buf: vertical(b, -Math.max(1, rows - 2)) };
  if (ch === "n") return { buf: find(b, false) };
  if (ch === "N") return { buf: find(b, true) };
  if (ch === "/" || ch === ":") return { buf: { ...b, cmd: { kind: ch, text: "" } } };
  if (ch === "y") return { buf: { ...b, pending: "y" } };
  if (ch === "u") return { buf: undo(b) };
  if (key.ctrl && ch === "r") return { buf: redo(b) };

  // editing
  const edits = "iaIAoOxDdpPJ";
  if (!ch || key.ctrl || key.meta || !edits.includes(ch)) return { buf: b };
  if (b.readOnly) return readOnly(b);

  const line = b.lines[b.row]!;
  const typing = (at: Buf, col: number): Step => ({ buf: to({ ...snap(at), mode: "insert" }, at.row, col) });
  switch (ch) {
    case "i":
      return typing(b, b.col);
    case "a":
      return typing(b, line.length ? b.col + 1 : 0);
    case "I":
      return typing(b, firstNonBlank(line));
    case "A":
      return typing(b, line.length);
    case "o": {
      const indent = indentOf(line);
      return typing({ ...b, lines: splice(b.lines, b.row + 1, 0, indent), row: b.row + 1 }, indent.length);
    }
    case "O": {
      const indent = indentOf(line);
      return typing({ ...b, lines: splice(b.lines, b.row, 0, indent) }, indent.length);
    }
    case "x":
      if (!line.length) return { buf: b };
      return { buf: to({ ...snap(b), lines: splice(b.lines, b.row, 1, line.slice(0, b.col) + line.slice(b.col + 1)) }, b.row, b.col) };
    case "D":
      return { buf: to({ ...snap(b), lines: splice(b.lines, b.row, 1, line.slice(0, b.col)) }, b.row, b.col - 1) };
    case "d":
      return { buf: { ...b, pending: "d" } };
    case "p":
      return { buf: put(b, false) };
    case "P":
      return { buf: put(b, true) };
    case "J": {
      if (b.row === b.lines.length - 1) return { buf: b };
      const next = b.lines[b.row + 1]!.trimStart();
      const joined = line + (line.length && next.length && !/\s$/.test(line) ? " " : "") + next;
      return { buf: to({ ...snap(b), lines: splice(b.lines, b.row, 2, joined) }, b.row, line.length) };
    }
  }
  return { buf: b };
}

function insert(b: Buf, ch: string, key: Key, view: View): Step {
  const rows = Math.max(1, view.rows);
  if (key.escape) return { buf: to({ ...b, mode: "normal" }, b.row, b.col - 1) };
  if (key.ctrl && ch === "s") return { buf: b, effects: ["save"] };
  if (key.downArrow) return { buf: vertical(b, 1) };
  if (key.upArrow) return { buf: vertical(b, -1) };
  if (key.leftArrow) return { buf: to(b, b.row, b.col - 1) };
  if (key.rightArrow) return { buf: to(b, b.row, b.col + 1) };
  if (key.home) return { buf: to(b, b.row, 0) };
  if (key.end) return { buf: to(b, b.row, Infinity) };
  if (key.pageDown) return { buf: vertical(b, Math.max(1, rows - 2)) };
  if (key.pageUp) return { buf: vertical(b, -Math.max(1, rows - 2)) };
  if (key.return) return { buf: newline(b) };
  if (key.backspace) return { buf: backspace(b) };
  if (key.delete) return { buf: forwardDelete(b) };
  if (key.tab) return { buf: insertText(b, "  ") };
  if (key.ctrl || key.meta || !ch) return { buf: b };
  // A chunk can carry an Enter inside it - see typing.ts. Each one is a real
  // line break here, indented like a typed Enter would be.
  let out = b;
  for (const part of ch.replace(/\r\n|\r/g, "\n").split(/(\n)/)) {
    if (part === "\n") out = newline(out);
    else if (part) out = insertText(out, part);
  }
  return { buf: out };
}

function command(b: Buf, ch: string, key: Key): Step {
  const cmd = b.cmd!;
  if (key.escape) return { buf: { ...b, cmd: null } };
  if (key.backspace || key.delete) {
    return { buf: { ...b, cmd: cmd.text ? { ...cmd, text: cmd.text.slice(0, -1) } : null } };
  }
  if (key.return) {
    const done = { ...b, cmd: null };
    const t = cmd.text.trim();
    if (cmd.kind === "/") {
      // An empty search repeats the last one, as it does in vim.
      return { buf: find({ ...done, search: t || b.search }, false) };
    }
    if (t === "w") return { buf: done, effects: ["save"] };
    if (t === "q" || t === "q!") return { buf: done, effects: ["leave"] };
    if (t === "wq" || t === "x") return { buf: done, effects: ["save", "leave"] };
    if (t === "e" || t === "e!") return { buf: done, effects: ["reload"] };
    if (t === "$") return { buf: to(done, Infinity, 0) };
    if (t.startsWith("!")) return { buf: done, effects: [`shell:${t.slice(1).trim()}`] };
    if ((COMMANDS as readonly string[]).includes(t)) return { buf: done, effects: [`cmd:${t}`] };
    if (/^\d+$/.test(t)) return { buf: to(done, Number(t) - 1, firstNonBlank(done.lines[clamp(Number(t) - 1, 0, done.lines.length - 1)]!)) };
    return { buf: tell(done, t ? `not a command: ${t}` : "") };
  }
  if (key.ctrl || key.meta || !ch || key.tab) return { buf: b };
  return { buf: { ...b, cmd: { ...cmd, text: cmd.text + ch.replace(/[\r\n]+/g, "") } } };
}

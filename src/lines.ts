// One transcript entry, turned into styled lines.

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[38;5;179m${s}\x1b[0m`,
  green: (s: string) => `\x1b[38;5;108m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[38;5;110m${s}\x1b[0m`,
  red: (s: string) => `\x1b[38;5;167m${s}\x1b[0m`,
};

import type { CourseCard, Entry, Outcome } from "./store.ts";

/** Hard-wrap to a printable width, ignoring the ANSI already in the string. */
export function wrap(text: string, indent = "", width = 74): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      // Measured without escape codes, or inline code wraps early.
      if (printable((line + " " + w).trim()).length > width) {
        out.push(indent + line.trim());
        line = w;
      } else line += " " + w;
    }
    out.push(indent + line.trim());
  }
  return out;
}

/**
 * A row that overflows, wrapped under its own layout: leading indent kept, and when it opens with
 * a label column (two or more spaces after the first words) the rest hangs under that column.
 */
export function hang(line: string, width: number): string[] {
  if (printable(line).length <= width) return [line];
  const column = /^(\s*)(\S.*?)(\s{2,})(?=\S)/.exec(line)?.[0];
  const head = column && printable(column).length <= width / 2 ? column : /^\s*/.exec(line)![0];
  const col = printable(head).length;
  return wrap(line.slice(head.length), "", width - col).map((l, i) => (i ? " ".repeat(col) : head) + l);
}

/** A model id as a person would say it: "claude-opus-5-5" is "opus 5.5". */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/.exec(id.trim());
  if (!m) return id.trim();
  return `${m[1]} ${m[2]}${m[3] ? "." + m[3] : ""}`;
}

/** The first `n` sentences of some text. */
export function sentences(text: string, n: number): string {
  const parts = text.trim().match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [text];
  return parts.slice(0, n).join("").trim();
}

/** "opus 5.5 · high": the model, and the effort it runs at when that's known. */
export function voiceName(model: string, effort = ""): string {
  if (!model) return "";
  return effort ? `${modelName(model)} · ${effort}` : modelName(model);
}

/** Lines of code a spoken message shows from one fenced block. Past that, it's a change to propose. */
const FENCE_SHOWN = 20;

/** Markdown, rendered rather than shown. A fenced block longer than `fence` lines is cut short. */
export function markdown(md: string, width: number, fence = Infinity): string[] {
  const out: string[] = [];
  let fenced = false;
  let inBlock = 0;
  for (const raw of md.split("\n")) {
    // Code keeps its own line breaks and indentation.
    if (/^\s*```/.test(raw)) {
      if (fenced && inBlock > fence) out.push(c.dim(`  … ${inBlock - fence} more lines not shown - ask dum to propose it as a change`));
      fenced = !fenced;
      inBlock = 0;
      continue;
    }
    if (fenced) {
      if (++inBlock <= fence) out.push("  " + c.blue(raw));
      continue;
    }
    const inline = (s: string) =>
      s.replace(/`([^`]+)`/g, (_, t) => c.blue(t)).replace(/\*\*([^*]+)\*\*/g, (_, t) => c.bold(t));
    // Uppercased before it is styled, and never inside backticks: shouting after styling turned
    // the colour escapes into literal junk, and `median(xs)` is code, not a word that can
    // change case.
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      if (out.length) out.push("");
      const loud = h[2]!.split(/(`[^`]+`)/).map((p) => (p.startsWith("`") ? p : p.toUpperCase())).join("");
      out.push(c.bold(inline(loud)));
      continue;
    }
    const line = inline(raw);
    const li = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (li) {
      const pad = " ".repeat(li[1]!.length);
      const [first, ...rest] = wrap(li[2]!, "", Math.max(8, width - pad.length - 2));
      out.push(`${pad}${c.dim("-")} ${first}`);
      for (const r of rest) out.push(`${pad}  ${r}`);
      continue;
    }
    if (!line.trim()) {
      out.push("");
      continue;
    }
    out.push(...wrap(line, "", width));
  }
  // An unclosed fence still says what it held back.
  if (fenced && inBlock > fence) out.push(c.dim(`  … ${inBlock - fence} more lines not shown - ask dum to propose it as a change`));
  while (out.length && !out[0]!.trim()) out.shift();
  // A heading adds a blank above itself and the source usually has one too.
  return out.filter((l, i) => l.trim() || out[i - 1]?.trim());
}

/** A framed block. */
export function box(
  color: (s: string) => string,
  title: string,
  body: string[],
  width: number,
): string[] {
  // Every row is exactly `width` printable columns.
  const inner = Math.max(16, width - 4);
  const w = inner + 4;
  const head = `╭─ ${title} ` + "─".repeat(Math.max(0, w - title.length - 5)) + "╮";
  const out = [color(head)];
  for (const line of body) {
    const clipped = clip(line, inner);
    const pad = " ".repeat(Math.max(0, inner - printable(clipped).length));
    out.push(`${color("│")} ${clipped}${pad} ${color("│")}`);
  }
  out.push(color("╰" + "─".repeat(w - 2) + "╯"));
  return out;
}

/** Truncate to a printable width without cutting an escape sequence in half. */
export function clip(s: string, width: number): string {
  if (printable(s).length <= width) return s;
  let out = "";
  let seen = 0;
  for (let i = 0; i < s.length; ) {
    const esc = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    if (seen >= width - 1) break;
    out += s[i];
    seen++;
    i++;
  }
  return out + "…\x1b[0m";
}

/** Visible length, with the escape sequences discounted. */
export function printable(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** A course: dum's lesson and worked example, the wizard's line, and the gap that's yours. */
export function courseLines(k: CourseCard, width: number): string[] {
  const out: string[] = [...wrap(k.lesson, "", width), ""];
  if (k.example) out.push(...k.example.split("\n").map((l) => "  " + c.blue(l)), "");
  if (k.wizard) out.push(...wrap(k.wizard, "", width - 3).map((l, i) => (i ? "   " : c.amber("🧙 ")) + c.dim(l)), "");
  out.push(...wrap(`your gap: ${k.task}`, "", width).map(c.bold));
  out.push(...wrap(`in ${k.path}${k.run ? ` · run: ${k.run}` : ""}`, "", width).map(c.dim));
  return out;
}

/** Lines of a fill shown in the transcript before it points at the file. */
const FILL_SHOWN = 12;
/** Numbered lines of a shared or read excerpt shown before pointing at the rest. */
export const EXCERPT_SHOWN = 40;
/** Lines of a diff shown before pointing at the artifact. */
export const DIFF_SHOWN = 60;
/** Lines of a command's output shown. */
export const RESULT_SHOWN = 30;

/**
 * Untrusted text made inert: escape sequences (colour, cursor, OSC titles and clipboard) and
 * control bytes are dropped, newline and tab kept. Shared files, model prose and command output
 * pass through here before dum adds its own styling, so none of them can redraw or fake a line.
 */
export function inert(s: string): string {
  return s
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[\s\S])?/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Every string in an entry (and one level into its card) made inert. */
function inertEntry(e: Entry): Entry {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (typeof v === "string") out[k] = inert(v);
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = Object.fromEntries(Object.entries(v).map(([a, b]) => [a, typeof b === "string" ? inert(b) : b]));
    else out[k] = v;
  }
  // Same keys, same kinds of value: only the characters inside strings changed.
  const clean = out as Entry;
  return clean;
}

/** One line per tool call, marked with what happened to it, said as dum's action. */
function toolLine(name: string, detail: string, outcome: Outcome, why?: string): string {
  // A hole isn't a refusal of anything.
  if (name === "hole") return `${c.amber("▌")} ${c.bold("hole")}${c.dim("  " + detail)}${c.amber("  (locked - yours)")}`;
  const mark = outcome === "ran" ? c.dim("·") : outcome === "held" ? c.amber("⊘") : c.red("✗");
  const label = outcome === "ran" ? c.dim(name) : c.bold(name);
  const note = why
    ? (outcome === "held" ? c.amber : c.red)(`  (${outcome} - ${why})`)
    : outcome === "held"
      ? c.amber("  (held - no plan yet)")
      : outcome === "refused"
        ? c.red("  (refused - outside the repo)")
        : "";
  return `${mark} ${c.dim("dum")} ${label}${detail ? c.dim("  " + detail) : ""}${note}`;
}

/** Code as it sits in a file: tabs made visible as spaces, never wider than the terminal. */
function codeRow(text: string, width: number): string {
  return clip(text.replace(/\t/g, "    ").replace(/\r$/, ""), Math.max(8, width));
}

/** A numbered excerpt: `12 │ code`, cut short past EXCERPT_SHOWN. */
export function excerptLines(path: string, from: number, text: string, width: number): string[] {
  const rows = text.replace(/\n$/, "").split("\n");
  const start = Math.max(1, from);
  const last = start + rows.length - 1;
  const num = String(last).length;
  const shown = rows.slice(0, EXCERPT_SHOWN).map((l, i) => `${c.dim(`${String(start + i).padStart(num)} │`)} ${codeRow(l, width - num - 3)}`);
  const more = rows.length - EXCERPT_SHOWN;
  if (more > 0) shown.push(c.dim(`${" ".repeat(num)} │ … ${more} more lines - :inspect ${path}:${start + EXCERPT_SHOWN}-${last}`));
  return shown;
}

/**
 * A unified diff with the file's line numbers down the side: the new number for kept and added
 * lines, the old number for removed ones. Cut short past DIFF_SHOWN.
 */
export function diffLines(diff: string, width: number, rest = ""): string[] {
  const rows = diff.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let before = 0;
  let after = 0;
  const num = (n: number) => String(n).padStart(4);
  // Several files in one diff (all saved changes): each says where it starts.
  const many = rows.filter((r) => r.startsWith("diff --git ")).length > 1;
  for (const row of rows) {
    if (out.length >= DIFF_SHOWN) break;
    const file = /^diff --git a\/.* b\/(.*)$/.exec(row);
    if (file && many) {
      out.push(c.bold(`── ${codeRow(file[1]!, width - 3)}`));
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(row);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      out.push(c.dim(`     ${codeRow(row, width - 5)}`));
    } else if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity |rename )/.test(row)) {
      // The header says which file; the entry (or the line above) already does.
      continue;
    } else if (row.startsWith("+")) out.push(`${c.dim(num(after++))} ${c.green(codeRow(row, width - 5))}`);
    else if (row.startsWith("-")) out.push(`${c.dim(num(before++))} ${c.red(codeRow(row, width - 5))}`);
    else if (row.startsWith("\\")) out.push(c.dim(`     ${row}`));
    else {
      out.push(`${c.dim(num(after))} ${codeRow(row, width - 5)}`);
      before++;
      after++;
    }
  }
  const counted = rows.filter((r) => (many && r.startsWith("diff --git ")) || !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity |rename )/.test(r)).length;
  if (counted > out.length) out.push(c.dim(`     … ${counted - out.length} more lines${rest ? ` in ${rest}` : ""}`));
  return out;
}

/** Squeeze runs of blank rows down to one. */
export function collapse(lines: string[]): string[] {
  return lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1]!.trim()));
}

/** Who is speaking in an entry, for a face beside it: dum, the wizard, you, or nobody (an action). */
export function speaker(e: Entry): "dum" | "wizard" | "you" | null {
  switch (e.kind) {
    case "say":
    case "plan":
    case "course":
      return "dum";
    case "question":
      return e.question ? "dum" : e.answer ? "you" : null;
    case "quip":
      return "wizard";
    case "user":
      return "you";
    default:
      return null;
  }
}

/** The face a speaker wears for an entry: dum asks with its "asking" face. */
export function expression(e: Entry): string {
  if (e.kind === "quip") return "talking";
  if (e.kind === "question" || e.kind === "plan") return "asking";
  return "idle";
}

/** An entry as the lines that draw it. Who said it is the caller's: see `speaker`. */
export function format(raw: Entry, width: number): string[] {
  const e = inertEntry(raw);
  switch (e.kind) {
    case "say":
      return [...markdown(e.text, width, FENCE_SHOWN), ""];
    case "note":
      return [...wrap(e.text, "", width).map(c.dim), ""];
    case "course":
      return [
        "",
        ...box(c.amber, `course: ${e.card.lang ? `${e.card.skill} (${e.card.lang})` : e.card.skill}`, courseLines(e.card, width - 4), width),
        ...(e.passed === null ? [] : [e.passed ? c.green("  recognized") : c.dim("  left - unchanged")]),
        "",
      ];
    case "quip":
      return [...wrap(e.text, "", width).map(c.italic), ""];
    case "tool":
      return [toolLine(e.name, e.detail, e.outcome, e.why)];
    case "fill": {
      // The code itself, not just that it happened.
      const lines = e.code.split("\n");
      const shown = lines.slice(0, FILL_SHOWN).map((l) => c.dim("  │ ") + c.blue(l));
      const more = lines.length - FILL_SHOWN;
      return [
        `${c.green("✓")} ${c.dim("fill")}${c.dim(`  ${e.path}: ${e.concept}`)}${c.dim("  (a skill you hold)")}`,
        ...shown,
        ...(more > 0 ? [c.dim(`  │ … ${more} more in ${e.path}`)] : []),
      ];
    }
    case "plan":
      return [
        "",
        ...box(c.green, "plan", markdown(e.plan, width - 4), width),
        ...(e.paused ? [c.dim("  on hold")] : e.approved === null ? [] : [e.approved ? c.green("  approved") : c.dim("  sent back with your reply")]),
        "",
      ];
    case "question": {
      if (!e.question) return e.answer ? [...you(e.answer, width), ""] : [];
      const out = [...wrap(e.question, "", width).map(c.bold)];
      if (e.why) out.push(...wrap(e.why, "", width).map(c.dim));
      if (e.answer) out.push(...you(e.answer, width));
      out.push("");
      return out;
    }
    case "user":
      return [...you(e.text, width), ""];
    case "excerpt": {
      const who = e.by === "dum" ? "dum read" : "you shared";
      // Saved changes arrive as a unified diff: numbered by the diff's own hunks, not from line 1.
      if (e.note === "saved changes" || /^diff --git /.test(e.text)) {
        return [`${c.blue("▸")} ${c.dim(who)} ${c.bold(e.path)}${e.note ? c.dim(`  ${e.note}`) : ""}`, ...diffLines(e.text, width), ""];
      }
      const rows = e.text.replace(/\n$/, "").split("\n").length;
      const to = e.from + rows - 1;
      return [
        `${c.blue("▸")} ${c.dim(who)} ${c.bold(`${e.path}:${e.from}-${to}`)}${e.note ? c.dim(`  ${e.note}`) : ""}`,
        ...excerptLines(e.path, e.from, e.text, width),
        "",
      ];
    }
    case "diff": {
      if (e.outcome === "refused") {
        // A refused change is code AI may not write for you: its text stays unseen.
        return [`${c.red("✗")} ${c.dim("dum's change to")} ${c.bold(e.path)} ${c.red("refused")}`, ""];
      }
      const head =
        e.outcome === "created"
          ? `${c.green("+")} ${c.dim("dum created")} ${c.bold(e.path)} ${c.dim("(new file)")}`
          : `${c.amber("±")} ${c.dim("dum proposes a change to")} ${c.bold(e.path)}`;
      const tail = e.outcome === "proposed" && e.artifact ? [c.dim(`  saved as ${e.artifact} - apply it in your editor if you agree; nothing in ${e.path} changed`)] : [];
      return [head, ...diffLines(e.diff, width, e.artifact ?? ""), ...tail, ""];
    }
    case "result": {
      const rows = e.output.replace(/\n$/, "").split("\n").filter((l, i, a) => l || i < a.length - 1);
      const mark = e.code === 0 ? c.green("✓") : c.red("✗");
      const shown = rows.slice(0, RESULT_SHOWN).map((l) => c.dim("  │ ") + codeRow(l, width - 4));
      const more = rows.length - RESULT_SHOWN;
      return [
        `${mark} ${c.dim("ran")} ${c.bold(e.label)} ${c.dim(`exit ${e.code}`)}`,
        ...(rows.length && rows.some((r) => r.trim()) ? shown : [c.dim("  │ (no output)")]),
        ...(more > 0 ? [c.dim(`  │ … ${more} more lines`)] : []),
        "",
      ];
    }
    case "shot":
      return [
        `${c.blue("▸")} ${c.dim("you shared a picture of")} ${c.bold(e.label)}${c.dim("  one look, picture not kept")}`,
        ...wrap(e.observation, "  ", width).map(c.dim),
        "",
      ];
  }
}

/** What you typed, as the conversation shows it. */
function you(text: string, width: number): string[] {
  return wrap(text, "", width - 2).map((l, i) => (i ? "  " : `${c.dim("›")} `) + l);
}

/**
 * A speaker's turn: their face down the left, their name and words beside it. With no face (no
 * colour to draw one in), the name goes on its own line above the words.
 */
export function turn(face: string[] | null, faceWidth: number, name: string, body: string[]): string[] {
  if (!face) return [name, ...body.map((l) => (l ? "  " + l : l))];
  const rows = [name, ...body];
  const n = Math.max(rows.length, face.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = face[i] ?? "";
    const pad = " ".repeat(Math.max(0, faceWidth - printable(f).length));
    out.push(`${f}${pad}  ${rows[i] ?? ""}`.trimEnd() || "");
  }
  return out;
}

/** An info page's body, with the skill tree's markers and track bars picked out. */
export function infoLines(body: string): string[] {
  return inert(body).split("\n").map((l) => {
    const m = /^(\s*)([●◐○·✓]) (\S.*?)((?:  |\s+\().*)?$/.exec(l);
    if (m) {
      const mark = m[2] === "●" || m[2] === "✓" ? c.green(m[2]) : m[2] === "·" ? c.dim(m[2]) : c.blue(m[2]!);
      return `${m[1]}${mark} ${m[2] === "·" ? c.dim(m[3]!) : m[3]}${m[4] ? c.dim(m[4]) : ""}`;
    }
    if (/[█░]/.test(l)) return c.bold(l);
    return l;
  });
}

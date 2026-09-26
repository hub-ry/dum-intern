// One transcript entry, turned into styled lines.
//
// Both renderers use this. The Ink panes put each line in a `<Text>` and the
// line-printer hands it to console.log, which works because Ink passes raw
// ANSI through untouched and measures the printable width correctly - verified
// before this was written, since the whole scheme collapses if it does not.
//
// The point is that the two renderers cannot drift. A quip is set in and
// narrower in both, a held tool call looks held in both, and neither file
// holds an opinion about it.

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[38;5;179m${s}\x1b[0m`,
  green: (s: string) => `\x1b[38;5;108m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[38;5;110m${s}\x1b[0m`,
  red: (s: string) => `\x1b[38;5;167m${s}\x1b[0m`,
};

import type { Entry, Lesson, Outcome } from "./store.ts";

/** Hard-wrap to a printable width, ignoring the ANSI already in the string. */
export function wrap(text: string, indent = "", width = 74): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      // Measured without escape codes. Counting them wrapped any line with
      // inline code in it a word or three early.
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
 * Markdown, rendered rather than shown.
 *
 * The spec is the one screen in this program you are asked to approve, and it
 * used to print as raw `## build` and `- item` source. Approving something is
 * a reading task; making the reader parse markup is a tax on the only moment
 * that actually gates the build.
 */
export function markdown(md: string, width: number): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of md.split("\n")) {
    // Code keeps its own line breaks and indentation. Word-wrapping it is how
    // a four-space body ended up flush left.
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push("  " + c.blue(raw));
      continue;
    }
    const line = raw
      .replace(/`([^`]+)`/g, (_, t) => c.blue(t))
      .replace(/\*\*([^*]+)\*\*/g, (_, t) => c.bold(t));
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (out.length) out.push("");
      out.push(c.bold(h[2]!.toUpperCase()));
      continue;
    }
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
  while (out.length && !out[0]!.trim()) out.shift();
  // A heading adds a blank above itself and the source usually has one too.
  // Two blank rows inside a frame read as a rendering fault, not as spacing.
  return out.filter((l, i) => l.trim() || out[i - 1]?.trim());
}

/**
 * A framed block.
 *
 * Closed on all four sides. The old one drew rounded corners on the left and
 * then simply stopped, which reads as a box that failed to render rather than
 * as a deliberate style, and it never wrapped its body - so a long spec line
 * ran straight through the frame it was supposed to sit inside.
 */
export function box(
  color: (s: string) => string,
  title: string,
  body: string[],
  width: number,
): string[] {
  // Every row is exactly `width` printable columns. The old frame was built
  // from three different arithmetics and came out one column short on the top
  // and bottom rules, which then pushed the body past the pane and wrapped it.
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

/**
 * Columns [from, to) of a styled string.
 *
 * The colour in force at `from` is re-opened at the start and everything is
 * closed at the end, so a window cut out of the middle of a coloured token
 * renders in that token's colour and does not leak it into the next thing
 * drawn. This is what lets the editor scroll sideways through highlighted
 * lines and put a cursor in the middle of one.
 */
export function slice(s: string, from: number, to: number): string {
  const ESC = /\x1b\[[0-9;]*m/y;
  let out = "";
  let seen = 0;
  let active = "";
  for (let i = 0; i < s.length && seen < to; ) {
    ESC.lastIndex = i;
    const esc = ESC.exec(s);
    if (esc) {
      active = esc[0] === "\x1b[0m" ? "" : esc[0];
      if (seen > from) out += esc[0];
      i += esc[0].length;
      continue;
    }
    if (seen >= from) {
      if (seen === from && active) out += active;
      out += s[i];
    }
    seen++;
    i++;
  }
  return out && active ? out + "\x1b[0m" : out;
}

/** Visible length, with the escape sequences discounted. */
export function printable(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function lessonLines(l: Lesson, width: number): string[] {
  const body: string[] = [c.bold(l.concept), ""];
  const section = (label: string, text: string) => {
    body.push(c.dim(label));
    body.push(...wrap(text, "  ", width - 8));
    body.push("");
  };
  section("what it is", l.what_it_is);
  section("why it exists", l.why_it_exists);
  section("in industry", l.in_industry);
  section("here", l.here);
  body.pop();
  return box(c.amber, "wizard", body, width);
}

/**
 * The wizard, in the margin.
 *
 * Set narrower and further in than anything the intern says, because the
 * indent is doing the work a second pane does later: telling you at a glance
 * that this is the voice you are free to ignore. A quip that renders like a
 * question gets read like a question, and then the wizard is interrupting you.
 */
function quipLines(text: string, about: string, width: number): string[] {
  const bar = c.amber("│");
  // A quip that arrived a beat late gets anchored to the answer it is about.
  // Without this it reads as a non-sequitur, and a non-sequitur in the margin
  // is the exact wallpaper the wizard must never become.
  const head = about ? `re: "${about}"\n` : "";
  const body = wrap(head + text, "", Math.max(24, Math.min(56, width - 10)));
  return [
    `   ${bar} ${c.amber("🧙")} ${c.dim(body[0] ?? "")}`,
    ...body.slice(1).map((l) => `   ${bar}    ${c.dim(l)}`),
    "",
  ];
}

/**
 * One line per tool call, marked with what happened to it.
 *
 * `held` and `refused` must not look like `ran`. A denied write that renders
 * like a successful one is a terminal lying about what the intern did, which
 * is disqualifying for a program whose entire job is to say no.
 */
function toolLine(name: string, detail: string, outcome: Outcome): string {
  const mark = outcome === "ran" ? c.dim("·") : outcome === "held" ? c.amber("⊘") : c.red("✗");
  const label = outcome === "ran" ? c.dim(name) : c.bold(name);
  const note =
    outcome === "held"
      ? c.amber("  (held - no spec yet)")
      : outcome === "refused"
        ? c.red("  (refused - outside the repo)")
        : "";
  return `${mark} ${label}${detail ? c.dim("  " + detail) : ""}${note}`;
}

/**
 * Squeeze runs of blank rows down to one.
 *
 * Entries pad themselves so they are readable next to anything, which means
 * two neighbours both contribute a blank and you get a gap that reads as a
 * missing element. In a pane the rows are also finite, so this is space the
 * transcript wants back.
 */
export function collapse(lines: string[]): string[] {
  return lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1]!.trim()));
}

/** An entry as the lines that draw it. */
export function format(e: Entry, width: number): string[] {
  switch (e.kind) {
    case "say":
      return [...markdown(e.text, width), ""];
    case "note":
      return [c.dim(e.text), ""];
    case "lesson":
      return ["", ...lessonLines(e.lesson, width), ""];
    case "quip":
      return quipLines(e.text, e.about, width);
    case "tool":
      return [toolLine(e.name, e.detail, e.outcome)];
    case "answer":
      // Unattributed on purpose: nobody said this. It is looked up, not
      // spoken, so it gets no name and no colour of its own.
      return [c.dim(`? ${e.question}`), ...wrap(e.body, "", width), ""];
    case "review":
      return [
        `${c.amber("⚖")} ${c.amber("wizard")} ${c.dim("on what was just built")}`,
        ...wrap(e.text, "  ", width - 2),
        "",
      ];
    case "spec":
      return [
        "",
        ...box(c.green, "spec", markdown(e.spec, width - 4), width),
        ...(e.approved === null
          ? []
          : [e.approved ? c.green("  approved") : c.dim("  declined")]),
        "",
      ];
    case "question": {
      if (!e.question) return e.answer ? [`${c.dim("›")} ${e.answer}`, ""] : [];
      const out = [...wrap(e.question, "", width).map(c.bold)];
      if (e.why) out.push(...wrap(e.why, "", width).map(c.dim));
      if (e.answer !== null) out.push(`${c.dim(">")} ${e.answer}`);
      out.push("");
      return out;
    }
  }
}

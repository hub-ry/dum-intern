// The conversation, one element per Store entry. Old entries stay readable whatever kind they are.

import type { Entry, Prompt } from "../../store.ts";
import { h, icon, plain } from "./dom.ts";
import { SPRITES } from "./sprites.ts";
import { framesFor } from "../../art-parser.ts";

/** A still portrait of the idle frame, drawn once and reused as a data URL. */
const portraits = new Map<string, string>();
function portrait(who: "dum" | "wizard"): HTMLImageElement {
  let url = portraits.get(who);
  if (!url) {
    const sprite = SPRITES[who];
    const frame = framesFor(sprite, "idle")[0]!;
    const cols = Math.max(...frame.rows.map((r) => r.length));
    const canvas = document.createElement("canvas");
    const px = 4;
    canvas.width = cols * px;
    canvas.height = frame.rows.length * px;
    const ctx = canvas.getContext("2d")!;
    frame.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const hex = sprite.palette.get(row[x]!);
        if (!hex) continue;
        ctx.fillStyle = `#${hex}`;
        ctx.fillRect(x * px, y * px, px, px);
      }
    });
    url = canvas.toDataURL("image/png");
    portraits.set(who, url);
  }
  return h("img", { class: `portrait portrait-${who}`, src: url, alt: "" });
}

/** `code` and **bold**, as elements. Nothing in the text is ever parsed as HTML. */
function inline(text: string): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const m of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g)) {
    if (m.index > at) out.push(document.createTextNode(text.slice(at, m.index)));
    out.push(m[1] !== undefined ? h("code", {}, m[1]) : h("strong", {}, m[2]!));
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

/** The small markdown dum writes: paragraphs, `##` headings, `-` lists and fenced code. */
export function prose(text: string): HTMLElement {
  const box = h("div", { class: "prose" });
  const lines = plain(text).replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: HTMLUListElement | null = null;
  const endPara = () => {
    if (para.length) box.append(h("p", {}, ...inline(para.join("\n"))));
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      endPara();
      list = null;
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i]!);
      box.append(h("pre", { class: "code" }, h("code", {}, code.join("\n"))));
      continue;
    }
    const heading = /^\s*#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      endPara();
      list = null;
      box.append(h("h4", {}, ...inline(heading[1]!)));
      continue;
    }
    const item = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (item) {
      endPara();
      if (!list) box.append((list = h("ul")));
      list.append(h("li", {}, ...inline(item[1]!)));
      continue;
    }
    if (!line.trim()) {
      endPara();
      list = null;
      continue;
    }
    list = null;
    para.push(line);
  }
  endPara();
  return box;
}

function chip(text: string, tone: "ok" | "warn" | "bad" | "info" | "muted"): HTMLElement {
  return h("span", { class: `chip chip-${tone}` }, text);
}

function speech(cls: string, who: "dum" | "wizard" | "you", label: string, ...body: (Node | null)[]): HTMLLIElement {
  return h(
    "li",
    { class: `entry speech ${cls}` },
    who === "you" ? null : portrait(who),
    h("div", { class: "speech-body" }, h("div", { class: "speaker" }, label), ...body),
  );
}

/** A fold for anything long: diffs, excerpts, command output. Short ones start open. */
function fold(cls: string, summary: Node[], body: Node[], open: boolean): HTMLLIElement {
  return h(
    "li",
    { class: `entry fold ${cls}` },
    h("details", { open }, h("summary", {}, icon("chevron"), ...summary), ...body),
  );
}

function numbered(text: string, from: number): HTMLElement {
  const pre = h("pre", { class: "code numbered" });
  text.split("\n").forEach((line, i) => {
    pre.append(h("span", { class: "ln", "aria-hidden": "true" }, String(from + i)), h("span", { class: "lc" }, line), "\n");
  });
  return pre;
}

function diffBody(diff: string): HTMLElement {
  const pre = h("pre", { class: "code diff" });
  for (const line of diff.split("\n")) {
    const cls = line.startsWith("@@") ? "hunk" : line.startsWith("+++") || line.startsWith("---") ? "file" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    pre.append(h("span", { class: `dl ${cls}` }, line), "\n");
  }
  return pre;
}

/** Opens a file dum reported, in the app the system picks for it. Main checks the path against its records. */
export type Opener = (record: "proposal" | "course", path: string) => void;

const lineCount = (t: string) => t.split("\n").length;

function openButton(label: string, onClick: () => void): HTMLButtonElement {
  return h("button", { type: "button", class: "link-btn", onclick: onClick }, icon("external"), h("span", {}, label));
}

function render(e: Entry, prompt: Prompt, open: Opener): HTMLLIElement {
  switch (e.kind) {
    case "say":
      return speech(`say${e.lead ? " lead" : ""}`, "dum", "dum", prose(e.text));
    case "quip":
      return speech("quip", "wizard", "wizard", prose(e.text));
    case "user":
      return speech("user", "you", "you", h("div", { class: "user-text" }, e.text));
    case "note":
      return h("li", { class: "entry note" }, e.text);
    case "question": {
      const waiting = e.answer === null && prompt?.type === "question" && prompt.question === e.question;
      const li = h("li", { class: "entry question" });
      if (e.question) {
        li.append(
          speech(
            "ask",
            "dum",
            "dum asks",
            prose(e.question),
            e.why ? h("div", { class: "why" }, e.why) : null,
            waiting ? chip("waiting for you", "warn") : e.answer === null ? chip("not answered", "muted") : null,
          ),
        );
      }
      if (e.answer !== null) li.append(speech("user", "you", "you", h("div", { class: "user-text" }, e.answer || "(nothing)")));
      return li;
    }
    case "plan": {
      const live = prompt?.type === "plan" && prompt.plan === e.plan;
      const status = e.paused
        ? chip("paused for a course", "info")
        : e.approved === null
          ? chip(live ? "waiting for you" : "no answer", live ? "warn" : "muted")
          : e.approved
            ? chip("approved", "ok")
            : chip("not approved", "bad");
      return h("li", { class: `entry card plan${live ? " live" : ""}` }, h("div", { class: "card-head" }, icon("boundary"), h("span", {}, "plan"), status), prose(e.plan));
    }
    case "course": {
      const c = e.card;
      const live = e.passed === null && prompt?.type === "course" && prompt.card.skill === c.skill && prompt.card.path === c.path;
      const status = e.passed === null ? chip(live ? "in progress" : "unfinished", live ? "info" : "muted") : e.passed ? chip("passed", "ok") : chip("left", "muted");
      return h(
        "li",
        { class: `entry card course${live ? " live" : ""}` },
        h("div", { class: "card-head" }, icon("tree"), h("span", {}, `course · ${c.skill}${c.lang ? ` in ${c.lang}` : ""}`), status),
        h("div", { class: "course-part" }, h("div", { class: "label" }, "lesson"), prose(c.lesson)),
        c.example ? h("div", { class: "course-part" }, h("div", { class: "label" }, "example"), h("pre", { class: "code" }, h("code", {}, c.example))) : null,
        c.wizard ? speech("quip inset", "wizard", "wizard", prose(c.wizard)) : null,
        h("div", { class: "course-part" }, h("div", { class: "label" }, "your turn"), prose(c.task)),
        h(
          "div",
          { class: "course-meta" },
          h("span", {}, "the gap is in ", h("code", {}, c.path)),
          c.run ? h("span", {}, "run it with ", h("code", {}, c.run)) : null,
          live ? openButton("open the file", () => open("course", c.path)) : null,
        ),
      );
    }
    case "tool": {
      const tone = e.outcome === "ran" ? "ok" : e.outcome === "held" ? "warn" : "bad";
      return h(
        "li",
        { class: `entry tool tool-${e.outcome}`, title: `${e.name} ${e.detail}` },
        h("span", { class: `dot dot-${tone}`, "aria-hidden": "true" }),
        h("span", { class: "tool-name" }, e.name),
        h("span", { class: "tool-detail" }, e.detail),
        e.outcome !== "ran" ? chip(e.outcome, tone) : h("span", { class: "visually-hidden" }, "ran"),
        e.why ? h("span", { class: "tool-why" }, e.why) : null,
      );
    }
    case "fill":
      return fold("fill", [h("span", {}, `filled ${e.concept} in `), h("code", {}, e.path)], [h("pre", { class: "code" }, h("code", {}, e.code))], false);
    case "excerpt": {
      const summary: Node[] = [h("span", {}, e.by === "you" ? "you shared " : "dum read "), h("code", {}, `${e.path}:${e.from}`)];
      if (e.note) summary.push(h("span", { class: "fold-note" }, e.note));
      return fold("excerpt", summary, [numbered(e.text, e.from)], lineCount(e.text) <= 16);
    }
    case "diff": {
      const label = e.outcome === "proposed" ? "proposed change to " : e.outcome === "created" ? "created " : "refused change to ";
      const tone = e.outcome === "proposed" ? "info" : e.outcome === "created" ? "ok" : "bad";
      const body: Node[] = [];
      if (e.artifact && e.outcome === "proposed") {
        body.push(
          h(
            "div",
            { class: "artifact" },
            h("span", {}, "saved as ", h("code", {}, e.artifact), ". dum doesn't apply it - your file is untouched."),
            openButton("open proposal", () => open("proposal", e.artifact!)),
          ),
        );
      } else if (e.outcome === "proposed") body.push(h("div", { class: "artifact" }, "a proposal only - your file is untouched."));
      else if (e.outcome === "created") body.push(h("div", { class: "artifact" }, "a new file - nothing of yours was overwritten."));
      body.push(diffBody(e.diff));
      return fold(`diff diff-${e.outcome}`, [h("span", {}, label), h("code", {}, e.path), chip(e.outcome, tone)], body, e.outcome !== "refused" && lineCount(e.diff) <= 30);
    }
    case "result":
      return fold(
        "result",
        [h("code", {}, `$ ${e.label}`), chip(`exit ${e.code}`, e.code === 0 ? "muted" : "bad")],
        [h("pre", { class: "code" }, h("code", {}, e.output || "(no output)"))],
        e.code !== 0 || lineCount(e.output) <= 12,
      );
    case "shot":
      return fold(
        "shot",
        [icon("screen"), h("span", {}, "you shared a picture of "), h("strong", {}, e.label)],
        [h("p", { class: "fold-note" }, `what one look at it saw. Only this text is kept, not the picture (sha256 ${e.sha.slice(0, 12)}…).`), prose(e.observation)],
        true,
      );
  }
}

/** Keeps the list in step with the store without rebuilding what didn't change, so folds and selections survive. */
export class Transcript {
  readonly el = h("ol", { class: "transcript", role: "log", "aria-label": "Conversation" });
  private shown = new Map<number, { key: string; el: HTMLLIElement }>();

  constructor(private open: Opener) {}

  update(entries: Entry[], prompt: Prompt) {
    const first = entries[0]?.id;
    const firstShown = this.shown.keys().next().value;
    if (entries.length < this.shown.size || (first !== undefined && firstShown !== undefined && first !== firstShown)) this.clear();
    const live = new Set<number>();
    for (const e of entries) {
      live.add(e.id);
      // Waiting markers depend on the prompt, so it is part of what decides a redraw.
      const key = JSON.stringify(e) + (e.kind === "question" || e.kind === "plan" || e.kind === "course" ? JSON.stringify(prompt) : "");
      const was = this.shown.get(e.id);
      if (was?.key === key) continue;
      const el = render(e, prompt, this.open);
      el.dataset.id = String(e.id);
      if (was) {
        const opens = [...was.el.querySelectorAll("details")].map((d) => d.open);
        el.querySelectorAll("details").forEach((d, i) => {
          if (i < opens.length) d.open = opens[i]!;
        });
        was.el.replaceWith(el);
      } else this.el.append(el);
      this.shown.set(e.id, { key, el });
    }
    for (const [id, s] of this.shown) {
      if (live.has(id)) continue;
      s.el.remove();
      this.shown.delete(id);
    }
  }

  clear() {
    this.el.replaceChildren();
    this.shown.clear();
  }
}

// The conversation, one element per Store entry. Old entries (plans, courses, proposals) stay readable as history, without controls.

import type { Entry, Prompt } from "../../store-types.ts";
import type { ChangeReceipt } from "../../zone-types.ts";
import { chip, h, icon, plain, type Client } from "./dom.ts";
import { portrait } from "./sprites.ts";
import { diffBody, revertButton } from "./change-view.ts";

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

const lineCount = (t: string) => t.split("\n").length;

const DIFF_LABEL: Record<Extract<Entry, { kind: "diff" }>["outcome"], { label: string; tone: "ok" | "info" | "bad" | "muted" }> = {
  applied: { label: "changed ", tone: "ok" },
  reverted: { label: "reverted change to ", tone: "muted" },
  proposed: { label: "proposed change to ", tone: "info" },
  created: { label: "created ", tone: "ok" },
  refused: { label: "refused change to ", tone: "bad" },
};

function render(e: Entry, prompt: Prompt, client: Client, changes: readonly ChangeReceipt[]): HTMLLIElement {
  switch (e.kind) {
    case "say":
      return speech(`say${e.lead ? " lead" : ""}`, "dum", "Dum", prose(e.text));
    case "quip":
      return speech("quip", "wizard", "Wizard", prose(e.text));
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
            "Dum asks",
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
      const status = e.approved === null ? chip("no answer", "muted") : e.approved ? chip("approved", "ok") : chip("not approved", "bad");
      return h("li", { class: "entry card plan" }, h("div", { class: "card-head" }, icon("boundary"), h("span", {}, "plan, from an older session"), status), prose(e.plan));
    }
    case "course": {
      const c = e.card;
      const status = e.passed === null ? chip("unfinished", "muted") : e.passed ? chip("passed", "ok") : chip("left", "muted");
      return h(
        "li",
        { class: "entry card course" },
        h("div", { class: "card-head" }, icon("tree"), h("span", {}, `course · ${c.skill}${c.lang ? ` in ${c.lang}` : ""}, from an older session`), status),
        h("div", { class: "course-part" }, h("div", { class: "label" }, "lesson"), prose(c.lesson)),
        c.example ? h("div", { class: "course-part" }, h("div", { class: "label" }, "example"), h("pre", { class: "code" }, h("code", {}, c.example))) : null,
        c.wizard ? speech("quip inset", "wizard", "Wizard", prose(c.wizard)) : null,
        h("div", { class: "course-part" }, h("div", { class: "label" }, "task"), prose(c.task)),
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
      const summary: Node[] = [h("span", {}, e.by === "you" ? "you shared " : "Dum read "), h("code", {}, `${e.path}:${e.from}`)];
      if (e.note) summary.push(h("span", { class: "fold-note" }, e.note));
      return fold("excerpt", summary, [numbered(e.text, e.from)], lineCount(e.text) <= 16);
    }
    case "diff": {
      const { label, tone } = DIFF_LABEL[e.outcome];
      const body: Node[] = [];
      if (e.outcome === "applied" && e.changeId) {
        const changeId = e.changeId;
        body.push(
          h(
            "div",
            { class: "artifact" },
            h("span", {}, "Dum wrote this to your file. Revert puts it back, unless you've edited it since."),
            revertButton(client, changes.find((c) => c.id === changeId), changeId),
          ),
        );
      } else if (e.outcome === "reverted") body.push(h("div", { class: "artifact" }, "put back the way it was."));
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

  constructor(private client: Client) {}

  update(entries: Entry[], prompt: Prompt, changes: readonly ChangeReceipt[]) {
    const first = entries[0]?.id;
    const firstShown = this.shown.keys().next().value;
    if (entries.length < this.shown.size || (first !== undefined && firstShown !== undefined && first !== firstShown)) this.clear();
    const live = new Set<number>();
    const bound = String(!!this.client.snap?.binding);
    for (const e of entries) {
      live.add(e.id);
      // Waiting markers depend on the prompt, and Revert on the change's receipt, so both decide a redraw.
      const extra = e.kind === "question" ? JSON.stringify(prompt) : e.kind === "diff" && e.changeId ? JSON.stringify(changes.find((c) => c.id === e.changeId) ?? null) + bound : "";
      const key = JSON.stringify(e) + extra;
      const was = this.shown.get(e.id);
      if (was?.key === key) continue;
      const el = render(e, prompt, this.client, changes);
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

// Records over a goal's panel: Memory, Suggested projects (with handing a project in) and Changes.
// Skills: your global tree, tier progress and the Web tree link. The host writes record text on
// request; nothing here grants anything.

import type { Snapshot, TreeSync, ViewName } from "../protocol.ts";
import type { View as TreeData } from "../../web/view.ts";
import { h, icon, iconButton, plain, type Client } from "./dom.ts";
import { ChangesPane } from "./change-view.ts";
import { SkillTree } from "./tree.ts";

export type RecordTab = Extract<ViewName, "memory" | "projects" | "changes">;

export const RECORD_TITLES: Record<RecordTab, string> = { memory: "Memory", projects: "Suggested projects", changes: "Changes" };

/** `:projects`, `:submit` and `:remember` run through the existing command path; their answer lands in Chat. */
async function command(client: Client, name: "projects" | "submit" | "remember", argument: string) {
  const binding = client.requestBinding();
  if (!binding) {
    client.showError("Open a goal first.");
    return null;
  }
  return client.call({ type: "command", name, argument, binding });
}

const textInput = (label: string, placeholder: string) => h("input", { class: "input", type: "text", spellcheck: "false", placeholder, "aria-label": label });

function form(label: string, input: HTMLInputElement, submit: string, run: (value: string) => Promise<unknown>): HTMLFormElement {
  const f = h("form", { class: "tool" }, h("label", { class: "field" }, h("span", {}, label), input), h("button", { type: "submit", class: "btn small" }, submit));
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return input.focus();
    await run(input.value.trim());
    input.value = "";
  });
  return f;
}

export class RecordsView {
  readonly el = h("div", { class: "records" });
  private tab: RecordTab = "memory";
  private awaiting = false;
  private infoText = h("pre", { class: "info-text" });
  private changes: ChangesPane;
  private shares = h("ul", { class: "shares", "aria-label": "Shared for the hand-in" });
  private extras: Partial<Record<RecordTab, HTMLElement>>;

  /** `answered` runs after a command whose answer appears in Chat. */
  constructor(private client: Client, private answered: () => void) {
    this.changes = new ChangesPane(client);
    this.extras = { memory: this.memoryExtras(), projects: this.projectsExtras() };
  }

  get title(): string {
    return RECORD_TITLES[this.tab];
  }

  /** Opens one record; the host fills Memory and Suggested projects into the stage. */
  async show(tab: RecordTab) {
    this.tab = tab;
    this.awaiting = tab !== "changes";
    if (this.client.snap) this.update(this.client.snap);
    await this.client.call({ type: "view", view: tab });
    this.awaiting = false;
    if (this.client.snap) this.update(this.client.snap);
  }

  update(s: Snapshot) {
    const kids: Node[] = [];
    if (!s.activeZone) kids.push(h("p", { class: "muted" }, "Open a goal to see its records."));
    else if (this.tab === "changes") {
      this.changes.update(s);
      kids.push(this.changes.el);
    } else {
      const stage = s.state?.stage;
      this.infoText.textContent = this.awaiting ? "loading…" : stage?.kind === "info" ? plain(stage.body) || "nothing here yet." : "nothing to show.";
      kids.push(this.infoText);
      const extra = this.extras[this.tab];
      if (extra) kids.push(extra);
      if (this.tab === "projects") this.drawShares(s);
    }
    if (this.el.childNodes.length !== kids.length || kids.some((k, i) => this.el.childNodes[i] !== k)) this.el.replaceChildren(...kids);
  }

  private drawShares(s: Snapshot) {
    const shared = s.shares.filter((g) => g.scope === "request");
    this.shares.replaceChildren(
      ...shared.map((g) =>
        h(
          "li",
          { class: "share" },
          icon(g.kind === "folder" ? "folder" : "file"),
          h("span", {}, g.label),
          iconButton("close", `Stop sharing ${g.label}`, () => {
            const binding = this.client.requestBinding();
            if (binding) void this.client.call({ type: "share-remove", shareId: g.id, binding });
          }, "", "icon-btn tiny"),
        ),
      ),
    );
    this.shares.hidden = !shared.length;
  }

  private memoryExtras(): HTMLElement {
    return h(
      "div",
      { class: "pane-extras" },
      form("Remember a note", textInput("Note", "e.g. I prefer small functions"), "Remember", async (note) => {
        const r = await command(this.client, "remember", note);
        if (r?.ok) void this.client.call({ type: "view", view: "memory" });
      }),
      h("button", { type: "button", class: "link-btn", onclick: () => void this.client.call({ type: "open-record", record: "memory" }) }, icon("external"), h("span", {}, "Open the memory file")),
    );
  }

  private projectsExtras(): HTMLElement {
    const run = async (name: "projects" | "submit", arg: string) => {
      const r = await command(this.client, name, arg);
      if (r?.ok) this.answered();
      return r;
    };
    const share = (kind: "file" | "folder") => () => {
      const binding = this.client.requestBinding();
      if (binding) void this.client.call({ type: "share-choose", kind, binding });
    };
    const unaided = h("input", { type: "checkbox" });
    const submitTask = textInput("Project", "p1");
    const submitFiles = textInput("Files", "src/walk.rs src/tree.rs");
    const handIn = h(
      "form",
      { class: "tool" },
      h("h3", {}, "Hand in a project"),
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn ghost small", onclick: share("file") }, icon("file"), "Share a file…"), h("button", { type: "button", class: "btn ghost small", onclick: share("folder") }, icon("folder"), "Share a folder…")),
      this.shares,
      h("label", { class: "field" }, h("span", {}, "Project"), submitTask),
      h("label", { class: "field" }, h("span", {}, "Files"), submitFiles),
      h("label", { class: "check" }, unaided, h("span", {}, "I wrote this myself, without AI help or copied code")),
      h("button", { type: "submit", class: "btn small" }, "Hand it in"),
    );
    handIn.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!submitTask.value.trim()) return submitTask.focus();
      if (!submitFiles.value.trim()) return submitFiles.focus();
      const r = await run("submit", `${submitTask.value.trim()} ${submitFiles.value.trim()}${unaided.checked ? " --unaided" : ""}`);
      if (r?.ok) {
        submitTask.value = "";
        submitFiles.value = "";
        unaided.checked = false;
      }
    });
    return h(
      "div",
      { class: "pane-extras" },
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "btn small", onclick: () => void run("projects", "new") }, "Suggest projects"),
        h("button", { type: "button", class: "btn ghost small", onclick: () => void run("projects", "stop") }, "Stop the project I'm on"),
      ),
      form("Start a project", textInput("Project id", "p1"), "Start", (id) => run("projects", `start ${id}`)),
      handIn,
    );
  }
}

/** Usable built skills, not messages, set the tier. */
export function tierInfo(tree: TreeData | null): { pct: number; tier: "newbie" | "intern" | "good" | "cracked"; built: number } {
  const built = tree?.usableBuilt ?? 0;
  return { pct: Math.min(built / 64, 1), tier: built >= 64 ? "cracked" : built >= 24 ? "good" : built >= 8 ? "intern" : "newbie", built };
}

/** Skills: global progress, the tree, and the Web tree disclosure. Works without a goal or a model. */
export class SkillsView {
  readonly el = h("div", { class: "skills" });
  private tree: SkillTree;
  private tierFill = h("div", { class: "tier-fill tier-newbie" });
  private tierBar = h("div", { class: "tier-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "64" }, this.tierFill);
  private tierText = h("p", { class: "hint" });
  private loading = h("p", { class: "muted" }, "loading…");
  private webServer = h("input", { class: "input", type: "url", placeholder: "https://…", "aria-label": "Server" });
  private webStatus = h("p", { class: "hint", role: "status" });

  constructor(private client: Client, answered: () => void) {
    this.tree = new SkillTree({
      projects: (arg) => void command(client, "projects", arg).then((r) => r?.ok && answered()),
    });
    this.webServer.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      this.webLink();
    });
    this.el.append(
      h("div", { class: "tier" }, this.tierBar, this.tierText),
      this.loading,
      this.tree.el,
      h(
        "details",
        { class: "group web-tree" },
        h("summary", {}, icon("chevron"), "Web tree"),
        h("p", { class: "hint" }, "Keep a copy of your skill tree at a private link you can open and edit in a browser. Only the tree goes there: no goals, sessions, story, conversations, holds, evidence or files."),
        h("label", { class: "field" }, h("span", {}, "Server"), this.webServer),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "btn ghost", onclick: () => this.webLink() }, icon("external"), "Link"),
          h("button", { type: "button", class: "btn ghost", onclick: () => void this.treeSync({ action: "sync" }, "Synced.") }, "Sync now"),
          h("button", { type: "button", class: "btn ghost", onclick: () => void this.treeSync({ action: "rotate" }, "New link made; the old one stopped working. The page opened in your browser.") }, "New link"),
          h("button", { type: "button", class: "btn ghost", onclick: () => void this.treeSync({ action: "off" }, "Unlinked. The web copy is gone; the tree here is untouched.") }, "Unlink"),
        ),
        this.webStatus,
      ),
    );
  }

  update(s: Snapshot) {
    const t = tierInfo(s.tree);
    this.tierFill.className = `tier-fill tier-${t.tier}`;
    this.tierFill.style.width = `${Math.round(t.pct * 100)}%`;
    this.tierBar.setAttribute("aria-label", `${t.tier} · ${t.built} currently usable built skills`);
    this.tierBar.setAttribute("aria-valuenow", String(Math.min(t.built, 64)));
    this.tierText.textContent = `${t.tier}: ${t.built} usable built skill${t.built === 1 ? "" : "s"}. newbie → intern (8) → good (24) → cracked (64). Counts built skills with intact prerequisites, not messages.`;
    this.loading.hidden = !!s.tree;
    this.tree.el.hidden = !s.tree;
    if (s.tree) this.tree.update(s.tree);
  }

  private webLink() {
    const server = this.webServer.value.trim();
    if (!server) return this.client.showError("Type the server's address first.");
    void this.treeSync({ action: "link", server }, "Linked. The page opened in your browser.");
  }

  private async treeSync(sync: TreeSync, done: string) {
    this.webStatus.textContent = "";
    if ((await this.client.call({ type: "tree-sync", sync })).ok) this.webStatus.textContent = done;
  }
}

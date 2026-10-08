// Records and Skills, inside the Chat region. Records: Memory, earlier History, Context (zone notes,
// inherited context, followed folders), Evidence, Boundary, Suggested projects and Changes. Skills: your
// global tree, tier progress and the Web tree link. The host writes record text on request; nothing here
// grants anything.

import type { Snapshot, TreeSync, ViewName } from "../protocol.ts";
import type { View as TreeData } from "../../web/view.ts";
import { ZONE_LIMITS } from "../../zone-types.ts";
import { h, icon, iconButton, plain, type Client, type IconName } from "./dom.ts";
import { ChangesPane } from "./change-view.ts";
import { SkillTree } from "./tree.ts";

export type RecordTab = Extract<ViewName, "memory" | "history" | "context" | "evidence" | "boundary" | "projects" | "changes">;

export const RECORD_TABS: Record<RecordTab, { label: string; icon: IconName }> = {
  memory: { label: "Memory", icon: "memory" },
  history: { label: "History", icon: "history" },
  context: { label: "Context", icon: "context" },
  evidence: { label: "Evidence", icon: "evidence" },
  boundary: { label: "Boundary", icon: "boundary" },
  projects: { label: "Suggested projects", icon: "tools" },
  changes: { label: "Changes", icon: "undo" },
};
/** Tabs whose text the host writes into the stage when asked. */
const TEXT_TABS: RecordTab[] = ["memory", "history", "context", "evidence", "boundary", "projects"];

/** `:projects`, `:submit` and `:remember` run through the existing command path; their answer lands in Chat. */
async function command(client: Client, name: "projects" | "submit" | "remember", argument: string) {
  const binding = client.requestBinding();
  if (!binding) {
    client.showError("Enter a zone first.");
    return null;
  }
  return client.call({ type: "command", name, argument, binding });
}

const textInput = (label: string, placeholder: string) => h("input", { class: "input", type: "text", spellcheck: "false", placeholder, "aria-label": label });

function form(label: string, input: HTMLInputElement, submit: string, run: (value: string) => Promise<unknown>, hint = ""): HTMLFormElement {
  const f = h("form", { class: "tool" }, h("label", { class: "field" }, h("span", {}, label), input, hint ? h("span", { class: "hint" }, hint) : null), h("button", { type: "submit", class: "btn" }, submit));
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
  private tabs = new Map<RecordTab, HTMLButtonElement>();
  private body = h("div", { class: "records-body", role: "tabpanel", id: "records-panel" });
  private infoText = h("pre", { class: "info-text" });
  private changes: ChangesPane;
  private extras: Partial<Record<RecordTab, HTMLElement>>;
  private contextText = h("textarea", { class: "input", rows: "5", "aria-label": "Notes for this zone" });
  private inherited = h("div", { class: "inherited" });
  private follows = h("ul", { class: "follows" });
  private followAdd = h("button", { type: "button", class: "btn ghost", onclick: () => void this.client.call({ type: "follow-add" }) }, icon("plus"), "Follow a folder…");

  /** `answered` runs after a command whose answer appears in Chat. */
  constructor(private client: Client, private answered: () => void) {
    this.changes = new ChangesPane(client);
    const nav = h("div", { class: "records-tabs", role: "tablist", "aria-label": "Records" });
    for (const [name, meta] of Object.entries(RECORD_TABS) as [RecordTab, (typeof RECORD_TABS)[RecordTab]][]) {
      const tab = h("button", { type: "button", role: "tab", class: "pane-tab", "aria-controls": "records-panel", tabindex: "-1", onclick: () => void this.show(name) }, icon(meta.icon), h("span", {}, meta.label));
      this.tabs.set(name, tab);
      nav.append(tab);
    }
    nav.addEventListener("keydown", (e) => {
      const list = [...this.tabs.values()];
      const i = list.findIndex((t) => t === document.activeElement);
      const to = e.key === "ArrowRight" ? list[(i + 1) % list.length] : e.key === "ArrowLeft" ? list[(i - 1 + list.length) % list.length] : e.key === "Home" ? list[0] : e.key === "End" ? list[list.length - 1] : undefined;
      if (!to) return;
      e.preventDefault();
      to.focus();
      to.click();
    });
    this.extras = { memory: this.memoryExtras(), context: this.contextExtras(), projects: this.projectsExtras() };
    this.el.append(nav, this.body);
  }

  get title(): string {
    return RECORD_TABS[this.tab].label;
  }

  /** Opens one record; the host fills text records into the stage. */
  async show(tab: RecordTab) {
    this.tab = tab;
    this.awaiting = TEXT_TABS.includes(tab);
    if (this.client.snap) this.update(this.client.snap);
    this.tabs.get(tab)?.focus();
    await this.client.call({ type: "view", view: tab });
    this.awaiting = false;
    if (this.client.snap) this.update(this.client.snap);
  }

  update(s: Snapshot) {
    for (const [name, tab] of this.tabs) {
      tab.setAttribute("aria-selected", String(name === this.tab));
      tab.tabIndex = name === this.tab ? 0 : -1;
    }
    const kids: Node[] = [];
    if (!s.activeZone) kids.push(h("p", { class: "muted" }, "Enter a zone to see its records."));
    else if (this.tab === "changes") {
      this.changes.update(s);
      kids.push(this.changes.el);
    } else {
      const stage = s.state?.stage;
      this.infoText.textContent = this.awaiting ? "loading…" : stage?.kind === "info" ? plain(stage.body) || "nothing here yet." : "nothing to show.";
      if (this.tab === "history") kids.push(h("p", { class: "hint" }, "Earlier history (before trails): the zone's bounded conversation log. Sessions and their trails are in Full story."));
      kids.push(this.infoText);
      const extra = this.extras[this.tab];
      if (extra) kids.push(extra);
      if (this.tab === "context") this.renderContext(s);
    }
    if (this.body.childNodes.length !== kids.length || kids.some((k, i) => this.body.childNodes[i] !== k)) this.body.replaceChildren(...kids);
  }

  private renderContext(s: Snapshot) {
    const zone = s.activeZone;
    if (!zone) return;
    const own = zone.notes.find((n) => n.id === zone.id);
    if (document.activeElement !== this.contextText) this.contextText.value = own?.text ?? "";
    const others = zone.notes.filter((n) => n.id !== zone.id && n.text.trim());
    this.inherited.replaceChildren(
      h("h4", {}, "Inherited from zones above"),
      ...(zone.ancestorGoals.length ? zone.ancestorGoals.map((g) => h("p", {}, h("span", { class: "muted" }, "Goal above: "), g.goal)) : []),
      ...(others.length ? others.map((n) => h("details", {}, h("summary", {}, icon("chevron"), `${n.name}'s notes`), h("p", { class: "excerpt" }, n.text))) : [h("p", { class: "muted" }, "No notes from zones above.")]),
      h("p", { class: "hint" }, "Personal background is separate: Settings → Use personal context. Inspect it from Current context → Inspect."),
    );
    this.follows.replaceChildren(
      ...(s.follows.length
        ? s.follows.map((f) => h("li", { class: "follow" }, icon("folder"), h("span", {}, f.label), h("span", { class: "muted small" }, `${f.files} file${f.files === 1 ? "" : "s"}`), iconButton("close", `Stop following ${f.label}`, () => void this.client.call({ type: "follow-remove", followId: f.id }), "", "icon-btn tiny")))
        : [h("li", { class: "muted" }, "None in this zone.")]),
    );
    this.followAdd.disabled = !s.activeZone;
  }

  private memoryExtras(): HTMLElement {
    return h(
      "div",
      { class: "pane-extras" },
      form("Remember a note", textInput("Note", "e.g. I prefer small functions"), "Remember", async (note) => {
        const r = await command(this.client, "remember", note);
        if (r?.ok) void this.client.call({ type: "view", view: "memory" });
      }, "Notes stay in this zone and come back next time. They never count as evidence."),
      h("button", { type: "button", class: "link-btn", onclick: () => void this.client.call({ type: "open-record", record: "memory" }) }, icon("external"), h("span", {}, "open the memory file to edit it, then Reload context")),
    );
  }

  private contextExtras(): HTMLElement {
    const save = h("form", { class: "tool" }, h("h3", {}, "Notes for this zone"), this.contextText, h("p", { class: "hint" }, "Background Dum reads in this zone and the zones inside it. It's context, never permission. Saving it changes the context, so a ready handoff needs a refresh."), h("button", { type: "submit", class: "btn" }, "Save notes"));
    save.addEventListener("submit", async (e) => {
      e.preventDefault();
      const s = this.client.snap;
      if (!s?.activeZone) return;
      if (new TextEncoder().encode(this.contextText.value).length > ZONE_LIMITS.contextBytes) return this.client.showError("Those notes are too long.");
      const r = await this.client.call({ type: "zone-context", id: s.activeZone.id, text: this.contextText.value, expectedRevision: s.zones.revision });
      if (r.ok) void this.client.call({ type: "view", view: "context" });
    });
    return h(
      "div",
      { class: "pane-extras" },
      save,
      this.inherited,
      h(
        "div",
        { class: "tool", role: "group", "aria-labelledby": "follow-title" },
        h("h3", { id: "follow-title" }, "Followed folders"),
        h("p", { class: "hint" }, "Folders in this zone whose saved files Dum may read. Dum notices when you save code there. Stopping revokes it."),
        this.follows,
        this.followAdd,
      ),
    );
  }

  private projectsExtras(): HTMLElement {
    const run = async (name: "projects" | "submit", arg: string) => {
      const r = await command(this.client, name, arg);
      if (r?.ok) this.answered();
      return r;
    };
    const unaided = h("input", { type: "checkbox" });
    const submitTask = textInput("Project", "p1");
    const submitFiles = textInput("Files", "src/walk.rs src/tree.rs");
    const handIn = h(
      "form",
      { class: "tool" },
      h("h3", {}, "Hand in a project"),
      h("label", { class: "field" }, h("span", {}, "Project"), submitTask),
      h("label", { class: "field" }, h("span", {}, "Files"), submitFiles, h("span", { class: "hint" }, "Share the files from the message box first, then name them here.")),
      h("label", { class: "check" }, unaided, h("span", {}, "I wrote this myself, without AI help or copied code")),
      h("button", { type: "submit", class: "btn" }, "Hand it in"),
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
        { class: "tool" },
        h("h3", {}, "Suggested projects"),
        h("p", { class: "hint" }, "Projects sized to what you're learning, from your skill tree, this zone and its notes. You build them yourself; that's what unlocks the next handoff."),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "btn", onclick: () => void run("projects", "new") }, "Suggest projects for this zone"),
          h("button", { type: "button", class: "btn ghost", onclick: () => void run("projects", "stop") }, "Stop the project I'm on"),
        ),
      ),
      form("Projects for one skill", textInput("Skill", "recursion in rust"), "Suggest", (skill) => run("projects", skill)),
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

/** Skills: global progress, the tree, and the Web tree disclosure. Works without a zone or a model. */
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
        h("p", { class: "hint" }, "Keep a copy of your skill tree at a private link you can open and edit in a browser. Only the tree goes there: no zones, sessions, story, conversations, holds, evidence or files."),
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

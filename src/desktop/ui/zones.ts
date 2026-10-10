// Goals: what you're working toward. A goal is stored as a zone (zone-types.ts); every word the user
// reads says "goal". The goal editor edits, nests and deletes them, and ⌘K's switcher opens one.
// Both are keyboard-complete; a goal is context, never permission.

import type { Snapshot } from "../protocol.ts";
import type { DirectionView } from "../../delegation-types.ts";
import type { Zone, ZoneId, ZoneRegistry } from "../../zone-types.ts";
import { h, type Client } from "./dom.ts";

/** Live goals only: a deleted goal can't be opened, edited or shown. */
export function liveZones(reg: ZoneRegistry): Zone[] {
  return reg.zones.filter((z) => z.deletedAt === null);
}

/** "Programming › Data Structures" for a goal id, root first. */
export function zonePath(reg: ZoneRegistry, id: ZoneId | null): string {
  const byId = new Map(reg.zones.map((z) => [z.id, z]));
  const names: string[] = [];
  for (let z = id ? byId.get(id) : undefined; z && names.length < 64; z = z.parentId ? byId.get(z.parentId) : undefined) names.unshift(z.name);
  return names.join(" › ");
}

/** A short title for a typed goal: its first clause, at most six words and 80 characters. */
export function goalTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const clause = flat.split(/[.!?;:,\n]| - | — /)[0]?.trim() || flat;
  return clause.split(" ").slice(0, 6).join(" ").slice(0, 80).trim() || flat.slice(0, 80).trim();
}

/** Nesting depth of a live goal, 0 for a top-level one. */
export function goalDepth(reg: ZoneRegistry, z: Zone): number {
  const byId = new Map(reg.zones.map((x) => [x.id, x]));
  let d = 0;
  for (let p = z.parentId ? byId.get(z.parentId) : undefined; p && d < 64; p = p.parentId ? byId.get(p.parentId) : undefined) d++;
  return d;
}

/** Live goals as a nested list: each goal followed by the goals inside it. */
export function goalOrder(reg: ZoneRegistry): Zone[] {
  const live = liveZones(reg);
  const ids = new Set(live.map((z) => z.id));
  const out: Zone[] = [];
  const walk = (parent: ZoneId | null) => {
    for (const z of live.filter((x) => (parent === null ? x.parentId === null || !ids.has(x.parentId) : x.parentId === parent))) {
      out.push(z);
      walk(z.id);
    }
  };
  walk(null);
  return out;
}

/** A goal's language: its own, else the nearest goal above it with one, else "". */
export function goalLanguage(reg: ZoneRegistry, id: ZoneId): string {
  const byId = new Map(reg.zones.map((z) => [z.id, z]));
  let depth = 0;
  for (let z = byId.get(id); z && depth < 64; z = z.parentId ? byId.get(z.parentId) : undefined, depth++) if (z.language) return z.language;
  return "";
}

export type GoalForm = { kind: "create"; parentId: ZoneId | null } | { kind: "edit"; id: ZoneId } | { kind: "delete"; id: ZoneId };

export type GoalEditorHooks = {
  /** A create or edit came back with that goal's alignment; `goalSet` when it created the goal or changed what it says. */
  aligned(view: DirectionView, goalSet: boolean): void;
  /** The form closed: saved, deleted or cancelled. */
  done(): void;
};

/** The goal editor: name, what you're working toward and language; nest a new goal inside; delete. */
export class GoalEditor {
  readonly el = h("div", { class: "goal-editor" });
  private form: GoalForm | null = null;

  constructor(private client: Client, private hooks: GoalEditorHooks) {}

  get title(): string {
    const reg = this.client.snap?.zones;
    const form = this.form;
    if (!form || !reg) return "Goal";
    if (form.kind === "create") return form.parentId ? `New goal inside ${zonePath(reg, form.parentId)}` : "New goal";
    const zone = reg.zones.find((z) => z.id === form.id);
    return `${form.kind === "edit" ? "Edit" : "Delete"} ${zone?.name ?? "goal"}`;
  }

  open(form: GoalForm) {
    this.form = form;
    const reg = this.client.snap?.zones;
    this.el.replaceChildren(reg ? this.render(form, reg) : h("p", { class: "muted" }, "loading…"));
    const first = this.el.querySelector<HTMLElement>("input, textarea, button");
    first?.focus();
    // Editing starts as a Finder rename does: the whole name selected, so typing replaces it.
    if (form.kind === "edit" && first instanceof HTMLInputElement) first.select();
  }

  /** The goal it edits went away. */
  update(s: Snapshot) {
    const form = this.form;
    if (form && form.kind !== "create" && !liveZones(s.zones).some((z) => z.id === form.id)) this.close();
  }

  close() {
    this.form = null;
    this.el.replaceChildren();
    this.hooks.done();
  }

  private render(form: GoalForm, reg: ZoneRegistry): HTMLElement {
    const zone = form.kind === "create" ? null : reg.zones.find((z) => z.id === form.id) ?? null;
    if (form.kind === "delete" && zone) {
      const zones = liveZones(reg);
      const below = (id: ZoneId): number => zones.filter((z) => z.parentId === id).reduce((n, z) => n + 1 + below(z.id), 0);
      const count = below(zone.id);
      return h(
        "div",
        { class: "goal-form", role: "group", "aria-label": `Delete ${zone.name}` },
        h("h3", {}, `Delete ${zone.name}${count ? ` and ${count} goal${count === 1 ? "" : "s"} inside it` : ""}?`),
        h("p", { class: "hint" }, "Your skills, memory notes and evidence stay. The goal's files stay on disk for you to look at."),
        h(
          "div",
          { class: "actions" },
          h("button", {
            type: "button", class: "btn danger",
            onclick: async () => {
              const r = await this.client.call({ type: "zone-delete", id: zone.id, expectedRevision: reg.revision });
              if (r.ok) this.close();
            },
          }, "Delete"),
          h("button", { type: "button", class: "btn ghost", onclick: () => this.close() }, "Cancel"),
        ),
      );
    }
    const name = h("input", { class: "input", type: "text", maxlength: "80", required: true, value: zone?.name ?? "", "aria-label": "Name" });
    const goal = h("textarea", { class: "input", rows: "3", maxlength: "2000", required: true, "aria-label": "What you're working toward" });
    goal.value = zone?.goal ?? "";
    const language = h("input", { class: "input", type: "text", maxlength: "64", value: zone?.language ?? "", "aria-label": "Language", placeholder: "inherit" });
    const el = h(
      "form",
      { class: "goal-form", "aria-label": this.title },
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      h("label", { class: "field" }, h("span", {}, "What you're working toward"), goal),
      h("label", { class: "field" }, h("span", {}, "Language"), language, h("span", { class: "hint" }, "Leave it empty to use the goal above's.")),
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn primary" }, form.kind === "create" ? "Create" : "Save"), h("button", { type: "button", class: "btn ghost", onclick: () => this.close() }, "Cancel")),
    );
    el.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fields = { name: name.value.trim(), goal: goal.value.trim(), language: language.value.trim() || null };
      if (!fields.name) return name.focus();
      if (!fields.goal) return goal.focus();
      const r = form.kind === "create"
        ? await this.client.call({ type: "zone-create", zone: { ...fields, parentId: form.parentId, focusSkills: [] }, enter: true })
        : await this.client.call({ type: "zone-update", id: form.id, patch: fields, expectedRevision: reg.revision });
      if (!r.ok) return;
      if (r.direction) this.hooks.aligned(r.direction, form.kind === "create" || fields.goal !== zone?.goal);
      if (form.kind === "create") {
        const id = r.direction?.zoneId ?? r.snapshot?.zones.activeZoneId;
        if (id) await this.client.call({ type: "panel", panel: { kind: "goal", id } });
      }
      this.close();
    });
    return el;
  }
}

/** ⌘K's goal switcher: type to filter, Up/Down to pick, Enter to open, Esc to close. */
export class GoalSwitcher {
  readonly el = h("div", { class: "switcher", hidden: true, role: "dialog", "aria-label": "Open a goal" });
  private input = h("input", { class: "input", type: "text", role: "combobox", "aria-expanded": "true", "aria-controls": "goal-options", "aria-autocomplete": "list", placeholder: "Open a goal…", "aria-label": "Open a goal" });
  private list = h("ul", { class: "switcher-list", id: "goal-options", role: "listbox", "aria-label": "Goals" });
  private index = 0;
  private returnTo: HTMLElement | null = null;

  constructor(private client: Client) {
    this.input.addEventListener("input", () => {
      this.index = 0;
      this.draw();
    });
    this.input.addEventListener("keydown", (e) => {
      const count = this.list.querySelectorAll('[role="option"]').length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (count) this.index = (this.index + (e.key === "ArrowDown" ? 1 : count - 1)) % count;
        this.draw();
      } else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        const id = this.list.querySelectorAll<HTMLElement>('[role="option"]')[this.index]?.dataset.id;
        if (id) void this.choose(id);
      }
    });
    this.el.append(this.input, this.list);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open() {
    this.returnTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    this.el.hidden = false;
    this.input.value = "";
    this.index = 0;
    this.draw();
    this.input.focus();
  }

  close(restore = true) {
    if (this.el.hidden) return;
    this.el.hidden = true;
    if (restore && this.returnTo?.isConnected) this.returnTo.focus();
    this.returnTo = null;
  }

  private draw() {
    const reg = this.client.snap?.zones;
    if (!reg) return;
    const q = this.input.value.trim().toLowerCase();
    const zones = goalOrder(reg).map((z) => ({ z, path: zonePath(reg, z.id) })).filter((x) => !q || x.path.toLowerCase().includes(q));
    this.index = Math.min(this.index, Math.max(0, zones.length - 1));
    this.list.replaceChildren(
      ...(zones.length
        ? zones.map((x, i) =>
            h(
              "li",
              {
                role: "option",
                id: `goal-option-${i}`,
                class: `switcher-option${i === this.index ? " picked" : ""}`,
                "data-id": x.z.id,
                "aria-selected": String(i === this.index),
                onclick: () => void this.choose(x.z.id),
              },
              h("span", {}, x.path),
              x.z.id === reg.activeZoneId ? h("span", { class: "chip chip-ok" }, "current") : null,
            ),
          )
        : [h("li", { class: "muted" }, "No goal matches. Add one from Your goals.")]),
    );
    this.input.setAttribute("aria-activedescendant", zones.length ? `goal-option-${this.index}` : "");
    this.list.querySelector(".picked")?.scrollIntoView({ block: "nearest" });
  }

  private async choose(id: ZoneId) {
    const r = await this.client.call({ type: "panel", panel: { kind: "goal", id } });
    if (r.ok) this.close(false);
  }
}

// Zones: the learning places. The compact tree under the Zones header creates, edits, deletes and
// enters them, and ⌘K opens the quick switcher. Both are keyboard-complete; a zone is context, never permission.

import type { Snapshot } from "../protocol.ts";
import type { DirectionView } from "../../delegation-types.ts";
import type { Zone, ZoneId, ZoneRegistry } from "../../zone-types.ts";
import { h, icon, type Client } from "./dom.ts";

/** Live zones only: a deleted zone can't be entered, edited or shown. */
function liveZones(reg: ZoneRegistry): Zone[] {
  return reg.zones.filter((z) => z.deletedAt === null);
}

/** "Programming › Data Structures" for a zone id, root first. */
export function zonePath(reg: ZoneRegistry, id: ZoneId | null): string {
  const byId = new Map(reg.zones.map((z) => [z.id, z]));
  const names: string[] = [];
  for (let z = id ? byId.get(id) : undefined; z && names.length < 64; z = z.parentId ? byId.get(z.parentId) : undefined) names.unshift(z.name);
  return names.join(" › ");
}

/** The default name for a goal: whitespace collapsed, first 80 characters (revamp §2, first run). */
export function nameFromGoal(goal: string): string {
  return goal.replace(/\s+/g, " ").trim().slice(0, 80).trim();
}

type Form = { kind: "create"; parentId: ZoneId | null } | { kind: "edit"; id: ZoneId } | { kind: "delete"; id: ZoneId };

export type ZoneTreeOptions = {
  /** A create or edit came back with that zone's alignment, active or not; `goalSet` when it created the zone or changed its goal. */
  aligned(view: DirectionView, goalSet: boolean): void;
  /** A zone's pending alignment badge ("Alignment needed", "deferred"), or "" when there's none to show. */
  badge(id: ZoneId): string;
};

/** The compact zone tree, with roving focus. Arrows move, Right/Left open and close, Enter enters, F2 edits. */
export class ZoneTree {
  readonly el = h("div", { class: "zones" });
  private tree = h("ul", { class: "zone-tree", role: "tree", "aria-label": "Zones" });
  private tools = h("div", { class: "zone-tools actions" });
  private formBox = h("div", { class: "zone-form-box" });
  private collapsed = new Set<ZoneId>();
  private focused: ZoneId | null = null;
  private form: Form | null = null;
  private key = "";

  constructor(private client: Client, private options: ZoneTreeOptions) {
    this.tree.addEventListener("keydown", (e) => this.onKey(e));
    this.el.append(
      this.tree,
      this.tools,
      this.formBox,
      h("p", { class: "hint zone-keys" }, "Up and Down move, Right and Left open and close, Enter enters, F2 edits. A zone is what you're learning, not a folder; your skills carry across zones."),
    );
  }

  /** Opens the goal and name editor for a zone: Current context's Correct → Edit goal. */
  edit(id: ZoneId) {
    this.open({ kind: "edit", id });
  }

  /** Puts keyboard focus on the current tree item. */
  focus() {
    this.focusItem();
  }

  update(s: Snapshot) {
    const key = JSON.stringify(s.zones) + (this.form ? JSON.stringify(this.form) : "") + liveZones(s.zones).map((z) => this.options.badge(z.id)).join("\u0000");
    if (key === this.key) return;
    this.key = key;
    const zones = liveZones(s.zones);
    if (!zones.some((z) => z.id === this.focused)) this.focused = s.zones.activeZoneId ?? zones[0]?.id ?? null;
    const form = this.form;
    if (form && form.kind !== "create" && !zones.some((z) => z.id === form.id)) this.form = null;
    this.draw(s.zones);
  }

  /** Closes an open form; true when Esc had something to close. */
  escape(): boolean {
    if (!this.form) return false;
    this.form = null;
    this.redraw();
    this.focusItem();
    return true;
  }

  private redraw() {
    this.key = "";
    if (this.client.snap) this.update(this.client.snap);
  }

  private open(form: Form) {
    this.form = form;
    this.redraw();
    const first = this.formBox.querySelector<HTMLElement>("input, textarea, button");
    first?.focus();
    // Editing starts as a Finder rename does: the whole name selected, so typing replaces it.
    if (form.kind === "edit" && first instanceof HTMLInputElement) first.select();
  }

  private visible(reg: ZoneRegistry): Zone[] {
    const zones = liveZones(reg);
    const out: Zone[] = [];
    const walk = (parent: ZoneId | null) => {
      for (const z of zones.filter((x) => x.parentId === parent)) {
        out.push(z);
        if (!this.collapsed.has(z.id)) walk(z.id);
      }
    };
    walk(null);
    return out;
  }

  private draw(reg: ZoneRegistry) {
    const zones = liveZones(reg);
    const depth = (z: Zone): number => (z.parentId ? 1 + depth(zones.find((x) => x.id === z.parentId)!) : 1);
    const items = this.visible(reg).map((z) => {
      const hasKids = zones.some((x) => x.parentId === z.id);
      const active = z.id === reg.activeZoneId;
      return h(
        "li",
        {
          role: "treeitem",
          class: `zone-item${active ? " active" : ""}`,
          "data-id": z.id,
          "aria-level": depth(z),
          "aria-expanded": hasKids ? String(!this.collapsed.has(z.id)) : null,
          "aria-selected": String(z.id === this.focused),
          "aria-current": active ? "true" : null,
          tabindex: z.id === this.focused ? "0" : "-1",
          style: `--depth:${depth(z) - 1}`,
          onclick: () => {
            this.focused = z.id;
            this.redraw();
            this.focusItem();
          },
          ondblclick: () => void this.enter(z.id),
        },
        h("span", { class: "zone-twisty", "aria-hidden": "true" }, hasKids ? (this.collapsed.has(z.id) ? "▸" : "▾") : ""),
        h("span", { class: "zone-name" }, z.name),
        active ? h("span", { class: "chip chip-ok" }, "current") : null,
        this.options.badge(z.id) ? h("span", { class: "chip chip-warn" }, this.options.badge(z.id)) : null,
      );
    });
    this.tree.replaceChildren(...(items.length ? items : [h("li", { class: "muted", role: "none" }, "No zones yet.")]));
    const zone = zones.find((z) => z.id === this.focused);
    this.tools.replaceChildren(
      h("button", { type: "button", class: "btn small", onclick: () => this.open({ kind: "create", parentId: null }) }, icon("plus"), "New zone"),
      ...(zone
        ? [
            h("button", { type: "button", class: "btn small primary", disabled: zone.id === reg.activeZoneId, onclick: () => void this.enter(zone.id) }, "Enter"),
            h("button", { type: "button", class: "btn small", onclick: () => this.open({ kind: "create", parentId: zone.id }) }, icon("plus"), "Inside"),
            h("button", { type: "button", class: "btn small ghost", onclick: () => this.open({ kind: "edit", id: zone.id }) }, icon("pencil"), "Edit"),
            h("button", { type: "button", class: "btn small ghost danger-text", onclick: () => this.open({ kind: "delete", id: zone.id }) }, icon("trash"), "Delete"),
          ]
        : []),
    );
    this.formBox.replaceChildren(...(this.form ? [this.renderForm(this.form, reg)] : []));
  }

  private focusItem() {
    this.tree.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }

  private onKey(e: KeyboardEvent) {
    const reg = this.client.snap?.zones;
    if (!reg || !this.focused) return;
    const list = this.visible(reg);
    const i = list.findIndex((z) => z.id === this.focused);
    const zone = list[i];
    if (!zone) return;
    const hasKids = liveZones(reg).some((x) => x.parentId === zone.id);
    let next: Zone | undefined;
    switch (e.key) {
      case "ArrowDown": next = list[i + 1]; break;
      case "ArrowUp": next = list[i - 1]; break;
      case "Home": next = list[0]; break;
      case "End": next = list[list.length - 1]; break;
      case "ArrowRight":
        if (hasKids && this.collapsed.has(zone.id)) this.collapsed.delete(zone.id);
        else if (hasKids) next = list[i + 1];
        break;
      case "ArrowLeft":
        if (hasKids && !this.collapsed.has(zone.id)) this.collapsed.add(zone.id);
        else next = list.find((z) => z.id === zone.parentId);
        break;
      case "Enter":
        e.preventDefault();
        void this.enter(zone.id);
        return;
      case "F2":
        e.preventDefault();
        this.open({ kind: "edit", id: zone.id });
        return;
      default:
        return;
    }
    e.preventDefault();
    if (next) this.focused = next.id;
    this.redraw();
    this.focusItem();
  }

  private async enter(id: ZoneId) {
    const reg = this.client.snap?.zones;
    if (!reg || id === reg.activeZoneId) return;
    await this.client.call({ type: "zone-enter", id, expectedRevision: reg.revision });
  }

  private renderForm(form: Form, reg: ZoneRegistry): HTMLElement {
    const zone = form.kind === "create" ? null : reg.zones.find((z) => z.id === form.id) ?? null;
    if (form.kind === "delete" && zone) {
      const zones = liveZones(reg);
      const below = (id: ZoneId): number => zones.filter((z) => z.parentId === id).reduce((n, z) => n + 1 + below(z.id), 0);
      const count = below(zone.id);
      return h(
        "div",
        { class: "zone-form", role: "group", "aria-label": `Delete ${zone.name}` },
        h("h3", {}, `Delete ${zone.name}${count ? ` and ${count} zone${count === 1 ? "" : "s"} inside it` : ""}?`),
        h("p", { class: "hint" }, "Your skills, memory notes and evidence stay. The zone's files stay on disk for you to look at."),
        h(
          "div",
          { class: "actions" },
          h("button", {
            type: "button", class: "btn danger",
            onclick: async () => {
              const r = await this.client.call({ type: "zone-delete", id: zone.id, expectedRevision: reg.revision });
              if (r.ok) this.escape();
            },
          }, "Delete"),
          h("button", { type: "button", class: "btn ghost", onclick: () => this.escape() }, "Cancel"),
        ),
      );
    }
    const name = h("input", { class: "input", type: "text", maxlength: "80", required: true, value: zone?.name ?? "", "aria-label": "Name" });
    const goal = h("textarea", { class: "input", rows: "3", maxlength: "2000", required: true, "aria-label": "Goal" });
    goal.value = zone?.goal ?? "";
    const language = h("input", { class: "input", type: "text", maxlength: "64", value: zone?.language ?? "", "aria-label": "Language", placeholder: "inherit" });
    const enter = h("input", { type: "checkbox", checked: true });
    const parent = form.kind === "create" && form.parentId ? zonePath(reg, form.parentId) : "";
    const title = form.kind === "create" ? (parent ? `New zone inside ${parent}` : "New zone") : `Edit ${zone?.name ?? ""}`;
    const el = h(
      "form",
      { class: "zone-form", "aria-label": title },
      h("h3", {}, title),
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      h("label", { class: "field" }, h("span", {}, "What you're trying to learn"), goal),
      h("label", { class: "field" }, h("span", {}, "Language"), language, h("span", { class: "hint" }, "Leave it empty to use the zone above's.")),
      form.kind === "create" ? h("label", { class: "check" }, enter, h("span", {}, "Enter it now")) : null,
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn primary" }, form.kind === "create" ? "Create" : "Save"), h("button", { type: "button", class: "btn ghost", onclick: () => this.escape() }, "Cancel")),
    );
    el.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fields = { name: name.value.trim(), goal: goal.value.trim(), language: language.value.trim() || null };
      if (!fields.name) return name.focus();
      if (!fields.goal) return goal.focus();
      const r = form.kind === "create"
        ? await this.client.call({ type: "zone-create", zone: { ...fields, parentId: form.parentId, focusSkills: [] }, enter: enter.checked })
        : await this.client.call({ type: "zone-update", id: form.id, patch: fields, expectedRevision: reg.revision });
      if (!r.ok) return;
      if (r.direction) this.options.aligned(r.direction, form.kind === "create" || fields.goal !== zone?.goal);
      this.escape();
    });
    return el;
  }
}

/** ⌘K's zone switcher: type to filter, Up/Down to pick, Enter to enter, Esc to close. */
export class ZoneSwitcher {
  readonly el = h("div", { class: "switcher", hidden: true, role: "dialog", "aria-label": "Switch zone" });
  private input = h("input", { class: "input", type: "text", role: "combobox", "aria-expanded": "true", "aria-controls": "zone-options", "aria-autocomplete": "list", placeholder: "Switch to zone…", "aria-label": "Switch to zone" });
  private list = h("ul", { class: "switcher-list", id: "zone-options", role: "listbox", "aria-label": "Zones" });
  private index = 0;

  constructor(private client: Client, private returnFocus: () => void) {
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
    this.el.hidden = false;
    this.input.value = "";
    this.index = 0;
    this.draw();
    this.input.focus();
  }

  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.returnFocus();
  }

  private draw() {
    const reg = this.client.snap?.zones;
    if (!reg) return;
    const q = this.input.value.trim().toLowerCase();
    const zones = liveZones(reg).map((z) => ({ z, path: zonePath(reg, z.id) })).filter((x) => !q || x.path.toLowerCase().includes(q));
    this.index = Math.min(this.index, Math.max(0, zones.length - 1));
    this.list.replaceChildren(
      ...(zones.length
        ? zones.map((x, i) =>
            h(
              "li",
              {
                role: "option",
                id: `zone-option-${i}`,
                class: `switcher-option${i === this.index ? " picked" : ""}`,
                "data-id": x.z.id,
                "aria-selected": String(i === this.index),
                onclick: () => void this.choose(x.z.id),
              },
              h("span", {}, x.path),
              x.z.id === reg.activeZoneId ? h("span", { class: "chip chip-ok" }, "current") : null,
            ),
          )
        : [h("li", { class: "muted" }, "No zone matches. Create zones with Manage.")]),
    );
    this.input.setAttribute("aria-activedescendant", zones.length ? `zone-option-${this.index}` : "");
    this.list.querySelector(".picked")?.scrollIntoView({ block: "nearest" });
  }

  private async choose(id: ZoneId) {
    const reg = this.client.snap?.zones;
    if (!reg) return;
    if (id !== reg.activeZoneId) {
      const r = await this.client.call({ type: "zone-enter", id, expectedRevision: reg.revision });
      if (!r.ok) return;
    }
    this.close();
  }
}

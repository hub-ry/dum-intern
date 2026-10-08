// Current context: what Dum is looking at, the goal and agreed direction, what the latest decision used
// (Using / Inspect / Correct), this session's trail of skill visits, and what you can delegate now.
// StoryView browses the retained sessions: this session's full trail and the full story across them.
// Facts only: no score from chat, no model-written retrospective (docs/circle-design.md §4).

import type { Snapshot, ViewName } from "../protocol.ts";
import type { ContextUseItem, Direction } from "../../delegation-types.ts";
import type { LookReason, LookStatusView } from "../../observe-types.ts";
import type { SessionMeta, StoryRow, TrailEvent, TrailSource, TrailStep, TrailView } from "../../trail-types.ts";
import type { SkillRef, ZoneId } from "../../zone-types.ts";
import { chip, h, icon, skillName, when, type Client, type Tone } from "./dom.ts";
import { zonePath } from "./zones.ts";

export type ContextHooks = {
  /** Opens an in-window view in the Chat region. */
  show(view: ViewName): void;
  /** Opens this session's full trail, or the full story. */
  story(kind: "session" | "story"): void;
  /** Correct → Edit goal: the zone editor for the active zone. */
  editGoal(): void;
};

const REASON: Record<LookReason, string> = {
  unchanged: "unchanged; no call",
  dedup: "same picture; no call",
  coalesced: "waiting for the screen to settle",
  busy: "conversation busy",
  decision: "deciding with you",
  voice: "voice in use",
  "no-zone": "no zone",
  "no-frame": "no fresh picture",
  permission: "permission denied",
  "unverified-model": "look model not verified for pictures",
  "stale-epoch": "zone changed; result dropped",
  "rate-limit": "rate limited",
  timeout: "timed out",
  "call-failed": "call failed",
};

const STATUS: Record<LookStatusView["status"], { label: string; tone: Tone }> = {
  watching: { label: "watching", tone: "muted" },
  checking: { label: "checking", tone: "info" },
  blocked: { label: "not looking", tone: "warn" },
  "no-backend": { label: "no backend", tone: "warn" },
  failed: { label: "call failed", tone: "bad" },
};

const USE_TONE: Record<ContextUseItem["status"], Tone> = { used: "ok", omitted: "muted", missing: "bad", stale: "warn" };

const PHASE: Record<Extract<TrailEvent, { kind: "handoff" }>["phase"], string> = {
  commanded: "handoff commanded",
  done: "handoff done",
  blocked: "handoff blocked",
  failed: "handoff failed",
  cancelled: "handoff cancelled",
  interrupted: "handoff interrupted",
  reviewed: "handoff reviewed",
};

/** What the look is doing, in words: status, why, and paused/permission. */
export function lookText(look: LookStatusView): string {
  if (look.paused) return "look paused";
  if (look.permission === "denied" && look.status !== "checking") return "screen permission denied; apps and files still watched";
  const reason = look.reason ? REASON[look.reason] : "";
  return reason ? `${STATUS[look.status].label} · ${reason}` : STATUS[look.status].label;
}

/** One trail event as a line of text, for the ordered list that is the authoritative trail. */
function eventText(e: TrailEvent, visits: ReadonlyMap<string, TrailStep>): string {
  switch (e.kind) {
    case "visit":
    case "map-gap":
      return `${skillName(e.step.skill)}${e.step.revisitOf ? " (revisit)" : ""}${e.step.mapping === "inferred" ? " · inferred" : e.step.mapping === "user" ? " · mapped by you" : ""}`;
    case "touch": {
      const step = visits.get(e.stepId);
      return step ? `still on ${skillName(step.skill)}` : "still on the same skill";
    }
    case "gap":
      return `unmapped topic: ${e.topic}`;
    case "direction":
      return e.previousId ? "direction revised" : "direction agreed";
    case "handoff":
      return PHASE[e.phase];
  }
}

/** The inline chain, oldest first: visits, gaps and markers interleaved by time. */
type Link = { at: string; key: string; event: TrailEvent | { kind: "visit"; step: TrailStep } };

function chain(trail: TrailView): Link[] {
  const links: Link[] = [
    ...trail.visits.map((step) => ({ at: step.firstSeenAt, key: `v${step.id}`, event: { kind: "visit" as const, step } })),
    ...trail.gaps.map((g) => ({ at: g.at, key: `g${g.id}`, event: g })),
    ...trail.markers.map((m) => ({ at: m.at, key: `m${m.seq}`, event: m })),
  ];
  return links.sort((a, b) => a.at.localeCompare(b.at));
}

/** Every skill the tree knows, for Map to skill…: the existing catalog, not a second one. */
function treeSkills(s: Snapshot): SkillRef[] {
  if (!s.tree) return [];
  const out = new Map<string, SkillRef>();
  for (const t of s.tree.tracks) for (const n of t.nodes) out.set(`${n.name}\u0000${t.lang}`, { name: n.name, lang: t.lang });
  for (const o of s.tree.off) out.set(`${o.name}\u0000${o.lang}`, { name: o.name, lang: o.lang });
  return [...out.values()];
}

/** Map to skill…: one picked skill from the tree, for a gap. The user's pick, never a new tree node. */
function mapForm(client: Client, s: Snapshot, sessionId: string, gapId: string, topic: string, done: () => void): HTMLElement {
  const skills = treeSkills(s);
  const select = h(
    "select",
    { class: "input", "aria-label": `Skill for ${topic}`, "data-focus": `map-${gapId}` },
    h("option", { value: "", disabled: true, selected: true }, skills.length ? "choose a skill from your tree" : "your tree has no skills yet"),
    ...skills.map((k, i) => h("option", { value: String(i) }, skillName(k))),
  );
  const form = h("form", { class: "inline-form", "aria-label": `Map ${topic} to a skill` }, select, h("button", { type: "submit", class: "btn small" }, "Map"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const skill = skills[Number(select.value)];
    const binding = client.requestBinding();
    if (!select.value || !skill) return select.focus();
    if (!binding) return;
    const r = await client.call({ type: "trail-map", binding, sessionId, gapId, skill });
    if (r.ok) done();
  });
  return form;
}

function sourceBlock(src: TrailSource): HTMLElement {
  return h(
    "div",
    { class: "source-detail" },
    h("div", { class: "card-head" }, chip(src.kind, "muted"), h("span", { class: "muted small" }, when(src.at))),
    src.excerpt ? h("p", { class: "excerpt" }, src.excerpt) : null,
    src.proof
      ? h("p", {}, chip(src.proof.ok ? "proof" : "attempt", src.proof.ok ? "ok" : "muted"), ` ${src.proof.kind} · ${skillName({ name: src.proof.skill, lang: src.proof.lang })}${src.proof.why ? ` · ${src.proof.why}` : ""}`)
      : null,
  );
}

/** Fetches and shows the retained sources of a step, inline. */
function sourcesList(client: Client, zoneId: ZoneId, sessionId: string, ids: readonly string[]): HTMLElement {
  const box = h("div", { class: "sources" });
  ids.forEach((id, i) => {
    const btn = h("button", {
      type: "button", class: "link-btn",
      onclick: async () => {
        const r = await client.call({ type: "trail-source", zoneId, sessionId, sourceId: id });
        if (r.ok && r.trailSource) btn.replaceWith(sourceBlock(r.trailSource));
      },
    }, icon("file"), h("span", {}, `source ${i + 1}`));
    box.append(btn);
  });
  return box;
}

function stepDetail(client: Client, s: Snapshot, zoneId: ZoneId, sessionId: string, step: TrailStep): HTMLElement {
  return h(
    "div",
    { class: "step-detail", role: "region", "aria-label": `${skillName(step.skill)} detail` },
    h("h4", {}, skillName(step.skill)),
    h("p", {}, chip(step.mapping === "exact" ? "named" : step.mapping === "inferred" ? "inferred" : "mapped by you", step.mapping === "inferred" ? "warn" : "muted"), ` from ${step.origin} · ${when(step.firstSeenAt)}${step.lastSeenAt !== step.firstSeenAt ? `–${when(step.lastSeenAt)}` : ""}`),
    step.topic ? h("p", {}, h("span", { class: "muted" }, "Topic: "), step.topic) : null,
    step.reason ? h("p", {}, h("span", { class: "muted" }, "Why this skill: "), step.reason) : null,
    step.directionId ? null : h("p", { class: "hint" }, "Not aligned: no agreed direction was in force."),
    step.sourceIds.length ? sourcesList(client, zoneId, sessionId, step.sourceIds) : null,
    s.tree ? h("p", { class: "hint" }, "A visit is activity, not proof. Only your evidence moves a skill on your tree.") : null,
  );
}

export class ContextTrail {
  readonly el = h("section", { class: "context", "aria-labelledby": "context-title" });
  private lookBtn = h("button", { type: "button", class: "btn ghost small", onclick: () => this.client.snap && void this.client.call({ type: "look-pause", paused: !this.client.snap.look.paused }) });
  private lookLabel = h("span", { class: "look-state", role: "status" });
  private detailsBtn = h("button", { type: "button", class: "btn ghost small", "aria-expanded": "false", "aria-controls": "context-details", onclick: () => this.toggle("details") }, "Details");
  private body = h("div", { class: "context-body" });
  private open: "inspect" | "correct" | "details" | null = null;
  private inventory: { items: ContextUseItem[]; next: string | null; key: string } | null = null;
  private picked: string | null = null;
  private mapping: string | null = null;
  private key = "";

  constructor(private client: Client, private hooks: ContextHooks) {
    this.el.append(
      h("div", { class: "section-head" }, h("h2", { id: "context-title" }, "Current context"), this.lookLabel, h("span", { class: "spacer" }), this.lookBtn, this.detailsBtn),
      this.body,
    );
  }

  /** Closes Inspect, Correct, Details or a selected step's detail; true when Esc had something to close. */
  escape(): boolean {
    if (this.mapping) this.mapping = null;
    else if (this.picked) this.picked = null;
    else if (this.open) this.open = null;
    else return false;
    this.redraw();
    this.el.querySelector<HTMLElement>(".trail [tabindex='0']")?.focus();
    return true;
  }

  update(s: Snapshot) {
    this.lookLabel.textContent = lookText(s.look);
    this.lookLabel.className = `look-state chip chip-${s.look.paused ? "muted" : STATUS[s.look.status].tone}`;
    this.lookBtn.textContent = s.look.paused ? "Resume" : "Pause";
    this.lookBtn.setAttribute("aria-label", s.look.paused ? "Resume looking" : "Pause looking");
    this.lookBtn.hidden = !s.activeZone;
    this.detailsBtn.setAttribute("aria-expanded", String(this.open === "details"));
    if (this.inventory && this.inventory.key !== `${s.contextUse.subject?.id}:${s.contextUse.contextRevision}:${s.contextUse.correctionRevision}`) this.inventory = null;
    const key = JSON.stringify([s.activeZone?.id, s.activeZone?.goal, s.direction, s.decision?.options, s.contextUse, s.look.seen, s.look.paused, s.look.permission, s.trail, s.session?.id, s.personal, s.follows.length, this.open, this.inventory, this.picked, this.mapping, this.open === "details" ? s.look : null, !!s.tree]);
    if (key === this.key) return;
    this.key = key;
    const inside = this.el.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
    this.draw(s);
    if (inside) this.el.querySelector<HTMLElement>(`[data-focus="${CSS.escape(inside)}"]`)?.focus();
  }

  private redraw() {
    this.key = "";
    if (this.client.snap) this.update(this.client.snap);
  }

  private toggle(part: "inspect" | "correct" | "details") {
    this.open = this.open === part ? null : part;
    if (this.open === "inspect" && !this.inventory) void this.readInventory(false);
    this.redraw();
  }

  /** The first page starts at the snapshot's host-issued cursor; More follows the page's `next`. */
  private async readInventory(more: boolean) {
    const s = this.client.snap;
    const binding = this.client.requestBinding();
    if (!s || !binding) return;
    const r = await this.client.call({ type: "context-use-read", binding, cursor: more ? this.inventory?.next ?? null : s.contextUse.cursor });
    if (!r.ok || !r.contextUse) return;
    const key = `${s.contextUse.subject?.id}:${s.contextUse.contextRevision}:${s.contextUse.correctionRevision}`;
    this.inventory = { items: [...(more && this.inventory ? this.inventory.items : []), ...r.contextUse.items], next: r.contextUse.next, key };
    this.redraw();
  }

  private draw(s: Snapshot) {
    const zone = s.activeZone;
    if (!zone) {
      this.body.replaceChildren(h("p", { class: "muted" }, "Your goal, the direction you agree with Dum and this session's trail show here once you have a zone."));
      return;
    }
    const binding = this.client.requestBinding();
    const parts: (Node | null)[] = [this.goalLine(s), this.usingLine(s)];
    if (this.open === "inspect") parts.push(this.inspect());
    if (this.open === "correct") parts.push(this.correct(s));
    parts.push(this.trailLine(s), this.delegable(s));
    parts.push(
      h(
        "div",
        { class: "actions context-actions" },
        h("button", { type: "button", class: "btn ghost small", disabled: !s.session, onclick: () => this.hooks.story("session") }, "This session"),
        h("button", { type: "button", class: "btn ghost small", onclick: () => this.hooks.story("story") }, icon("story"), "Full story"),
        h("button", { type: "button", class: "btn ghost small", onclick: () => this.hooks.show("context") }, icon("folder"), `Context / followed folders${s.follows.length ? ` (${s.follows.length})` : ""}`),
        h("button", { type: "button", class: "btn ghost small", disabled: !binding, onclick: () => binding && void this.client.call({ type: "session-new", binding }) }, "New session"),
      ),
    );
    if (this.open === "details") parts.push(this.details(s));
    this.body.replaceChildren(...parts.filter((p) => p !== null));
  }

  private goalLine(s: Snapshot): HTMLElement {
    const d = s.direction;
    const step = (action: "start" | "revise") => async () => {
      if (!d) return;
      await this.client.call({ type: "alignment-step", binding: d.binding, action });
    };
    const direction = d?.current
      ? h("span", { class: "direction" }, h("span", { class: "muted" }, "Agreed direction: "), `${d.current.ability} — ${d.current.choice.title}`)
      : h("span", {}, chip(d?.status === "aligning" ? "aligning" : d?.status === "deferred" ? "Alignment deferred" : d?.status === "needs-backend" ? "Alignment waits for a model" : "Alignment needed", d?.status === "aligning" ? "info" : "warn"));
    return h(
      "div",
      { class: "goal-line" },
      h("p", { class: "goal" }, h("span", { class: "muted" }, "Your goal: "), s.activeZone?.goal ?? ""),
      h(
        "p",
        { class: "direction-line" },
        direction,
        d?.contextChanged ? chip("Context changed — review direction", "warn") : null,
        d && d.status !== "aligning"
          ? h("button", { type: "button", class: "btn ghost small", "data-focus": "revise", onclick: step(d.current ? "revise" : "start") }, d.current ? "Revise" : "Align now")
          : null,
      ),
    );
  }

  private usingLine(s: Snapshot): HTMLElement {
    const u = s.contextUse;
    const subject = u.subject ? { alignment: "alignment", decision: "the latest options", request: "your latest request" }[u.subject.kind] : null;
    const counts = [u.counts.used ? `${u.counts.used} used` : "", u.counts.omitted ? `${u.counts.omitted} omitted` : "", u.counts.missing ? `${u.counts.missing} missing` : "", u.counts.stale ? `${u.counts.stale} stale` : ""].filter(Boolean).join(" · ");
    const seen = s.look.seen;
    return h(
      "div",
      { class: "using-line" },
      h(
        "p",
        {},
        h("span", { class: "muted" }, "Using: "),
        subject ? `${subject}: ${counts || "nothing yet"}` : "nothing yet — ask Dum or align your goal",
        seen ? h("span", { class: "muted" }, ` · last seen ${when(seen.at)}${seen.stale ? " (stale)" : ""}: `) : null,
        seen ? h("span", { class: "seen" }, seen.text) : null,
      ),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "btn ghost small", "data-focus": "inspect", "aria-expanded": String(this.open === "inspect"), disabled: !u.subject, onclick: () => this.toggle("inspect") }, "Inspect"),
        h("button", { type: "button", class: "btn ghost small", "data-focus": "correct", "aria-expanded": String(this.open === "correct"), onclick: () => this.toggle("correct") }, "Correct"),
      ),
    );
  }

  private inspect(): HTMLElement {
    const inv = this.inventory;
    if (!inv) return h("p", { class: "muted", role: "status" }, "Reading what Dum used…");
    return h(
      "div",
      { class: "inventory", role: "region", "aria-label": "What Dum used" },
      h(
        "ul",
        { class: "inventory-list" },
        ...inv.items.map((item) =>
          h(
            "li",
            {},
            h("div", { class: "card-head" }, chip(item.status, USE_TONE[item.status]), h("strong", {}, item.ref.label), h("span", { class: "muted small" }, `${item.ref.kind}${item.ref.at ? ` · ${when(item.ref.at)}` : ""} · ${item.ref.revision.slice(0, 8)}`)),
            item.ref.excerpt ? h("details", {}, h("summary", {}, icon("chevron"), "excerpt"), h("p", { class: "excerpt" }, item.ref.excerpt)) : null,
            item.ref.kind === "personal"
              ? h("button", { type: "button", class: "link-btn", onclick: () => void this.client.call({ type: "open-record", record: "personal", sourceId: item.ref.id }) }, icon("external"), h("span", {}, "open the file to edit it, then Reload context"))
              : null,
          ),
        ),
      ),
      inv.items.length ? null : h("p", { class: "muted" }, "Nothing recorded for it."),
      inv.next ? h("button", { type: "button", class: "btn ghost small", onclick: () => void this.readInventory(true) }, "More") : null,
      h("p", { class: "hint" }, "Producers name these sources; a model can't add one. Context never grants permission."),
    );
  }

  private correct(s: Snapshot): HTMLElement {
    const binding = this.client.requestBinding();
    const seen = s.look.seen;
    const d = s.direction;
    const item = (label: string, onclick: () => void, disabled = false) => h("li", {}, h("button", { type: "button", class: "btn ghost small", disabled, onclick }, label));
    return h(
      "div",
      { class: "correct", role: "group", "aria-label": "Correct what Dum uses" },
      h(
        "ul",
        { class: "correct-list" },
        item("Edit goal", () => this.hooks.editGoal()),
        item("Zone notes", () => this.hooks.show("context")),
        item("Revise direction", () => d && void this.client.call({ type: "alignment-step", binding: d.binding, action: d.current ? "revise" : "start" }), !d),
        item("Open memory to edit", () => void this.client.call({ type: "open-record", record: "memory" })),
        item("Reload context", () => binding && void this.client.call({ type: "context-reload", binding }), !binding),
        item(
          seen ? "Ignore this observation" : "No observation to ignore",
          () => binding && seen && void this.client.call({ type: "context-ignore-observation", binding, sourceId: seen.sourceId, expectedCorrectionRevision: s.contextUse.correctionRevision }),
          !binding || !seen,
        ),
        item(s.settings.personalContext ? "Personal background (Settings)" : "Personal background is off (Settings)", () => this.hooks.show("settings")),
        item("Followed folders", () => this.hooks.show("context")),
      ),
      h("p", { class: "hint" }, "Corrections change what the next decision uses. They never erase the trail or unsend what was already used; a ready handoff needs a refresh."),
    );
  }

  private trailLine(s: Snapshot): HTMLElement {
    const trail = s.trail;
    const box = h("div", { class: "trail-line" }, h("span", { class: "muted trail-label", id: "trail-label" }, "This session:"));
    if (!trail || (!trail.visits.length && !trail.gaps.length && !trail.markers.length)) {
      box.append(h("span", { class: "muted" }, " no skills yet."));
      return box;
    }
    const links = chain(trail);
    const focused = links.find((l) => l.key === this.picked) ?? links[links.length - 1]!;
    const list = h("ol", { class: "trail", "aria-labelledby": "trail-label" });
    for (const link of links) {
      const e = link.event;
      const revisit = e.kind === "visit" && e.step.revisitOf !== null;
      const cls = `trail-step trail-${e.kind}${revisit ? " revisit" : ""}${link.key === this.picked ? " picked" : ""}`;
      const label = e.kind === "visit" ? `${skillName(e.step.skill)}${e.step.mapping === "inferred" ? " ·" : ""}` : eventText(e as TrailEvent, new Map());
      list.append(
        h(
          "li",
          { class: cls },
          h("button", {
            type: "button", class: "trail-btn", tabindex: link === focused ? "0" : "-1", "data-focus": `trail-${link.key}`, "data-key": link.key,
            "aria-expanded": e.kind === "visit" || e.kind === "gap" ? String(link.key === this.picked) : null,
            title: e.kind === "visit" ? `${e.step.topic || skillName(e.step.skill)}${revisit ? " (revisit)" : ""}` : label,
            onclick: () => {
              this.picked = this.picked === link.key ? null : link.key;
              this.redraw();
            },
          }, label),
        ),
      );
    }
    list.addEventListener("keydown", (ev) => {
      const buttons = [...list.querySelectorAll<HTMLButtonElement>(".trail-btn")];
      const i = buttons.findIndex((b) => b === document.activeElement);
      const to = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? buttons[i + 1] : ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? buttons[i - 1] : ev.key === "Home" ? buttons[0] : ev.key === "End" ? buttons[buttons.length - 1] : undefined;
      if (!to) return;
      ev.preventDefault();
      for (const b of buttons) b.tabIndex = b === to ? 0 : -1;
      to.focus();
    });
    box.append(list);
    const picked = links.find((l) => l.key === this.picked);
    if (picked?.event.kind === "visit") box.append(stepDetail(this.client, s, trail.zoneId, trail.sessionId, picked.event.step));
    if (picked?.event.kind === "gap") {
      const gap = picked.event;
      box.append(
        h(
          "div",
          { class: "step-detail" },
          h("p", {}, `Dum saw “${gap.topic}” but couldn't match it to a skill confidently.`),
          mapForm(this.client, s, trail.sessionId, gap.id, gap.topic, () => {
            this.picked = null;
            this.redraw();
          }),
        ),
      );
    }
    return box;
  }

  /** Delegable now / Next unlock: from the host's live gate labels on the latest options, and the agreed direction. */
  private delegable(s: Snapshot): HTMLElement {
    const options = s.decision?.options ?? [];
    const now = options.filter((o) => o.eligibility === "can-delegate");
    const learn = options.filter((o) => o.eligibility === "learn-first");
    const built = new Set<string>();
    for (const t of s.tree?.tracks ?? []) for (const n of t.nodes) if (n.state === "built") built.add(`${n.name}\u0000${t.lang}`.toLowerCase());
    const unlock = learn.length
      ? learn.flatMap((o) => o.skills)
      : (s.direction?.current?.choice.builds ?? []).filter((k) => !built.has(`${k.name}\u0000${k.lang}`.toLowerCase()));
    const skillLink = (k: SkillRef) => h("button", { type: "button", class: "link-btn", onclick: () => this.hooks.show("tree") }, skillName(k));
    return h(
      "p",
      { class: "delegable" },
      h("span", { class: "muted" }, "Delegable now: "),
      ...(now.length ? now.map((o) => h("span", { class: "delegable-item" }, o.task)) : [h("span", { class: "muted" }, options.length ? "nothing in these options" : "ask Help me decide")]),
      h("span", { class: "muted" }, " · Next unlock: "),
      ...(unlock.length ? unlock.slice(0, 4).map(skillLink) : [h("span", { class: "muted" }, "—")]),
      h("button", { type: "button", class: "link-btn", onclick: () => this.hooks.show("evidence") }, icon("evidence"), h("span", {}, "evidence")),
    );
  }

  private details(s: Snapshot): HTMLElement {
    const l = s.look;
    const row = (label: string, value: string) => h("div", { class: "kv" }, h("dt", {}, label), h("dd", {}, value));
    return h(
      "dl",
      { class: "look-details", id: "context-details", "aria-label": "Look details" },
      row("Status", lookText(l)),
      row("Screen permission", l.permission),
      l.noPictures ? row("No pictures because", l.noPictures) : null,
      row("Last tick", l.lastTick ? when(l.lastTick) : "none yet"),
      row("Last call", l.lastAttempt ? when(l.lastAttempt) : "none yet"),
      row("Last success", l.lastSuccess ? when(l.lastSuccess) : "none yet"),
      row("Look model", l.chosen ? `${l.chosen.model}${l.chosen.effort ? ` · ${l.chosen.effort}` : ""}${l.resolved ? ` → ${l.resolved}` : ""}` : "not chosen"),
      row("Latest observation", l.seen ? `${l.seen.text}${l.seen.stale ? " (stale)" : ""}` : "none"),
      h("div", { class: "kv" }, h("dt", {}, "Boundary"), h("dd", {}, h("button", { type: "button", class: "link-btn", onclick: () => this.hooks.show("boundary") }, "what Dum may do here"))),
    );
  }
}

/** This session's full trail, or the story across sessions: retained facts and your verdicts, paged by the host. */
export class StoryView {
  readonly el = h("div", { class: "story" });
  private mode: "session" | "story" = "story";
  private session: { zoneId: ZoneId; sessionId: string; meta: SessionMeta | null; events: TrailEvent[]; next: string | null; direction: Direction | null; fromStory: boolean } | null = null;
  private rows: StoryRow[] = [];
  private next: string | null = null;
  private filter: { allZones: boolean; skill: string; from: string; to: string } = { allZones: false, skill: "", from: "", to: "" };
  private picked: number | null = null;

  constructor(private client: Client) {}

  get title(): string {
    return this.mode === "story" ? "Full story" : this.session?.fromStory ? "Session" : "This session";
  }

  /** Opens this session's trail, or the full story for this zone. */
  async show(kind: "session" | "story") {
    const s = this.client.snap;
    if (kind === "session" && s?.session) await this.openSession(s.session.zoneId, s.session.id, false);
    else {
      this.mode = "story";
      this.draw();
      await this.readStory(null);
    }
  }

  /** From a session opened out of the story, back to the story; true when Esc had something to close. */
  escape(): boolean {
    if (this.picked !== null) {
      this.picked = null;
      this.draw();
      return true;
    }
    if (this.mode === "session" && this.session?.fromStory) {
      this.mode = "story";
      this.draw();
      return true;
    }
    return false;
  }

  update(s: Snapshot) {
    // This session's trail grows while you look at it; the next page picks up the new events.
    if (this.mode === "session" && this.session && !this.session.fromStory && s.session?.id === this.session.sessionId && s.session.eventCount !== this.session.meta?.eventCount) {
      void this.openSession(this.session.zoneId, this.session.sessionId, false);
    }
  }

  private async openSession(zoneId: ZoneId, sessionId: string, fromStory: boolean) {
    const r = await this.client.call({ type: "trail-read", zoneId, sessionId, cursor: null });
    if (!r.ok || !r.trail) return;
    const meta = r.trail.session;
    let direction: Direction | null = null;
    if (meta.directionId) {
      const d = await this.client.call({ type: "direction-read", zoneId, directionId: meta.directionId }, true);
      if (d.ok && d.directionRecord) direction = d.directionRecord;
    }
    this.mode = "session";
    this.picked = null;
    this.session = { zoneId, sessionId, meta, events: r.trail.events, next: r.trail.next, direction, fromStory };
    this.draw();
  }

  private async moreEvents() {
    const cur = this.session;
    if (!cur?.next) return;
    const r = await this.client.call({ type: "trail-read", zoneId: cur.zoneId, sessionId: cur.sessionId, cursor: cur.next });
    if (!r.ok || !r.trail) return;
    cur.events.push(...r.trail.events);
    cur.next = r.trail.next;
    this.draw();
  }

  private async readStory(cursor: string | null) {
    const s = this.client.snap;
    const zoneId = this.filter.allZones ? null : s?.activeZone?.id ?? null;
    const [name, lang] = this.filter.skill.split(/\s+in\s+/i);
    const iso = (date: string, end: boolean) => (date ? new Date(`${date}T${end ? "23:59:59.999" : "00:00:00.000"}`).toISOString() : null);
    const r = await this.client.call({
      type: "story-read", zoneId,
      skill: name?.trim() ? { name: name.trim(), lang: lang?.trim() ?? "" } : null,
      from: iso(this.filter.from, false), to: iso(this.filter.to, true), cursor,
    });
    if (!r.ok || !r.story) return;
    this.rows = cursor ? [...this.rows, ...r.story.rows] : r.story.rows;
    this.next = r.story.next;
    this.draw();
  }

  private draw() {
    const s = this.client.snap;
    if (!s) return;
    if (this.mode === "story") this.el.replaceChildren(...this.storyParts(s));
    else this.el.replaceChildren(...this.sessionParts(s));
  }

  private storyParts(s: Snapshot): Node[] {
    const allZones = h("input", { type: "checkbox", checked: this.filter.allZones });
    const skill = h("input", { class: "input", type: "text", value: this.filter.skill, placeholder: "binary search in C++", "aria-label": "Skill" });
    const from = h("input", { class: "input", type: "date", value: this.filter.from, "aria-label": "From" });
    const to = h("input", { class: "input", type: "date", value: this.filter.to, "aria-label": "To" });
    const form = h(
      "form",
      { class: "story-filter", "aria-label": "Filter the story" },
      h("label", { class: "check" }, allZones, h("span", {}, "All zones")),
      h("label", { class: "field-inline" }, h("span", {}, "Skill"), skill),
      h("label", { class: "field-inline" }, h("span", {}, "From"), from),
      h("label", { class: "field-inline" }, h("span", {}, "To"), to),
      h("button", { type: "submit", class: "btn small" }, "Filter"),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.filter = { allZones: allZones.checked, skill: skill.value.trim(), from: from.value, to: to.value };
      void this.readStory(null);
    });
    return [
      form,
      h("p", { class: "hint" }, "Every retained session, newest first. Facts and your own verdicts only; a new direction never regrades old sessions."),
      this.rows.length
        ? h(
          "ol",
          { class: "story-rows" },
          ...this.rows.map((row) =>
            h(
              "li",
              {},
              h(
                "button",
                { type: "button", class: "story-row", onclick: () => void this.openSession(row.zoneId, row.sessionId, true) },
                h("strong", {}, `${when(row.startedAt)}${row.endedAt ? `–${when(row.endedAt)}` : " · open"}`),
                this.filter.allZones ? h("span", { class: "muted" }, zonePath(s.zones, row.zoneId) || "deleted zone") : null,
                h("span", {}, row.preview.map(skillName).join(" → ") + (row.previewMore ? ` +${row.previewMore}` : "") || "no skills"),
                h("span", { class: "muted small" }, `${row.visits} visits · ${row.gaps} unmapped · ${row.handoffsDone} handoffs done · ${row.handoffsReviewed} reviewed${row.directionId ? "" : " · not aligned"}`),
              ),
            ),
          ),
        )
        : h("p", { class: "muted" }, "No sessions match."),
      this.next ? h("button", { type: "button", class: "btn ghost small", onclick: () => void this.readStory(this.next) }, "More") : h("span"),
    ];
  }

  private sessionParts(s: Snapshot): Node[] {
    const cur = this.session;
    if (!cur?.meta) return [h("p", { class: "muted" }, "No session to show.")];
    const meta = cur.meta;
    const visits = new Map<string, TrailStep>();
    for (const e of cur.events) if (e.kind === "visit" || e.kind === "map-gap") visits.set(e.step.id, e.step);
    const d = cur.direction;
    const out: Node[] = [
      cur.fromStory ? h("button", { type: "button", class: "btn ghost small", onclick: () => this.escape() }, "Back to the story") : h("span"),
      h(
        "div",
        { class: "session-head" },
        h("p", {}, h("strong", {}, meta.zoneName), h("span", { class: "muted" }, ` · ${when(meta.startedAt)}${meta.endedAt ? `–${when(meta.endedAt)} (${meta.endReason ?? "ended"})` : " · running"}`)),
        h("p", {}, h("span", { class: "muted" }, "Goal then: "), meta.goal),
        d
          ? h("p", {}, h("span", { class: "muted" }, "Agreed ability: "), d.ability, h("span", { class: "muted" }, " · judged by: "), d.reviewCriterion)
          : h("p", {}, chip("not aligned", "muted"), " No agreed direction when this session started."),
      ),
    ];
    const list = h("ol", { class: "session-events", "aria-label": "Events, oldest first" });
    cur.events.forEach((e, i) => {
      const picked = this.picked === i;
      const openable = e.kind === "visit" || e.kind === "map-gap" || e.kind === "handoff" || e.kind === "gap";
      list.append(
        h(
          "li",
          { class: `event event-${e.kind}${picked ? " picked" : ""}` },
          h("span", { class: "muted small" }, when(e.at)),
          openable
            ? h("button", { type: "button", class: "link-btn", "aria-expanded": String(picked), onclick: () => { this.picked = picked ? null : i; this.draw(); } }, eventText(e, visits))
            : h("span", {}, eventText(e, visits)),
          picked ? this.eventDetail(s, cur.zoneId, cur.sessionId, e) : null,
        ),
      );
    });
    out.push(list, cur.next ? h("button", { type: "button", class: "btn ghost small", onclick: () => void this.moreEvents() }, "More") : h("span"));
    return out;
  }

  private eventDetail(s: Snapshot, zoneId: ZoneId, sessionId: string, e: TrailEvent): HTMLElement {
    if (e.kind === "visit" || e.kind === "map-gap") return stepDetail(this.client, s, zoneId, sessionId, e.step);
    if (e.kind === "gap") {
      const live = s.session?.id === sessionId && !this.session?.meta?.endedAt;
      return h(
        "div",
        { class: "step-detail" },
        h("p", {}, `Unmapped topic: ${e.topic}`),
        live ? mapForm(this.client, s, sessionId, e.id, e.topic, () => void this.openSession(zoneId, sessionId, !!this.session?.fromStory)) : h("p", { class: "hint" }, "Only the running session's gaps can be mapped."),
        sourcesList(this.client, zoneId, sessionId, [e.sourceId]),
      );
    }
    if (e.kind === "handoff") {
      const box = h("div", { class: "step-detail" }, h("p", { class: "muted", role: "status" }, "Reading the handoff…"));
      void this.client.call({ type: "handoff-read", zoneId, handoffId: e.handoffId }).then((r) => {
        if (!r.ok || !r.handoff) return;
        const v = r.handoff;
        box.replaceChildren(
          h(
            "div",
            {},
            h("p", {}, h("span", { class: "muted" }, "Task: "), v.handoff.task),
            h("p", {}, h("span", { class: "muted" }, "Expected result: "), v.handoff.expectedResult),
            h("p", {}, h("span", { class: "muted" }, "You review: "), v.handoff.review),
            v.head.result ? h("p", {}, h("span", { class: "muted" }, "What happened: "), v.head.result) : null,
            v.head.reviewed ? h("p", {}, h("span", { class: "muted" }, "Your verdict: "), v.head.reviewed.verdict) : null,
            e.sourceIds.length ? sourcesList(this.client, zoneId, sessionId, e.sourceIds) : null,
          ),
        );
      });
      return box;
    }
    return h("div");
  }
}

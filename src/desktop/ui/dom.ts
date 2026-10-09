// DOM building for the renderer, and its one request client. Every piece of model or user text lands as a text node.

import type { BubbleAPI, CircleAPI, DesktopAPI, Reply, Request, Snapshot } from "../protocol.ts";
import type { RequestBinding } from "../../share-types.ts";

declare global {
  interface Window {
    /** The working window only. */
    dum: DesktopAPI;
    /** The circle only: its gestures, toggle and small view. */
    dumCircle: CircleAPI;
    /** The bubble only. */
    dumBubble: BubbleAPI;
  }
}

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

/** An element: `class` sets the class, `on*` adds a listener, `true` sets a bare attribute. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

/** Hand-drawn 24px line icons. */
const ICONS = {
  close: "M6 6l12 12M18 6L6 18",
  hide: "M5 12h14",
  gear: "M21.4 10.4v3.2h-2.6l-.8 2.1 1.8 1.8-2.3 2.3-1.8-1.8-2.1.8v2.6h-3.2v-2.6l-2.1-.8-1.8 1.8-2.3-2.3 1.8-1.8-.8-2.1H2.6v-3.2h2.6l.8-2.1-1.8-1.8 2.3-2.3 1.8 1.8 2.1-.8V2.6h3.2v2.6l2.1.8 1.8-1.8 2.3 2.3-1.8 1.8.8 2.1zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  send: "M21 3L3 10.5l7.5 3 3 7.5zM21 3L10.5 13.5",
  stop: "M7 7h10v10H7z",
  screen: "M3 5h18v11H3zM8 20h8M12 16v4",
  tree: "M4 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M16 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M10 19a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6 8v1a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V8M12 13v4",
  memory: "M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7h6",
  history: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v5l3 2",
  context: "M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0",
  evidence: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M8 12l3 3 5-6",
  boundary: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  tools: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  warning: "M12 3l10 18H2zM12 10v5M12 18v.01",
  check: "M5 12.5l4.5 4.5L19 7",
  plus: "M12 5v14M5 12h14",
  chevron: "M6 9l6 6 6-6",
  power: "M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0",
  lock: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  key: "M7 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10 12h11M17 12v3M20 12v2",
  window: "M3 5h18v14H3zM3 9h18M6 7h.01M8.5 7h.01",
  mic: "M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  pause: "M8 5v14M16 5v14",
  play: "M7 5l12 7-12 7z",
  zones: "M3 6h7M3 12h7M3 18h7M14 6h7M14 12h4M14 18h4",
  move: "M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3",
  story: "M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2zM4 21a2 2 0 0 1 2-2h12v2M8 7h6M8 11h6",
  bug: "M8 9a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0zM12 9v9M4 13h4M16 13h4M5 8l3 2M19 8l-3 2M5 19l3-2M19 19l-3-2",
} satisfies Record<string, string>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "icon");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

/** A button with an icon. With `label` only, the label is the accessible name and a tooltip. */
export function iconButton(name: IconName, label: string, onClick: (e: Event) => void, text = "", cls = "icon-btn"): HTMLButtonElement {
  return h("button", { type: "button", class: cls, "aria-label": text ? null : label, title: label, onclick: onClick }, icon(name), text ? h("span", {}, text) : null);
}

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";

/** A small status label; tone is never the only signal, the text says it too. */
export function chip(text: string, tone: Tone): HTMLElement {
  return h("span", { class: `chip chip-${tone}` }, text);
}

/** "binary search (C++)", or the bare name for a language-free skill. */
export function skillName(skill: { name: string; lang: string }): string {
  return skill.lang ? `${skill.name} (${skill.lang})` : skill.name;
}

/** A local time for an ISO timestamp: "14:05", or "3 Oct, 14:05" when it isn't today. */
export function when(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** Terminal colour codes some host text still carries. */
export function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** The working window's one way to talk to main: every reply's snapshot is applied, every refusal is shown. */
export class Client {
  snap: Snapshot | null = null;
  readonly errors = h("div", { class: "errors", role: "alert" });
  private listeners: ((s: Snapshot) => void)[] = [];

  constructor() {
    window.dum.subscribe((s) => this.apply(s));
  }

  /** Called with every snapshot, in registration order. */
  on(listener: (s: Snapshot) => void) {
    this.listeners.push(listener);
    if (this.snap) listener(this.snap);
  }

  async call(request: Request, quiet = false): Promise<Reply> {
    let reply: Reply;
    try {
      reply = await window.dum.invoke(request);
    } catch (err) {
      reply = { ok: false, error: (err as Error).message || "dum didn't answer" };
    }
    if (!reply.ok && !quiet) this.showError(reply.error);
    if (reply.ok && reply.snapshot) this.apply(reply.snapshot);
    return reply;
  }

  showError(message: string) {
    const item = h("div", { class: "error" }, icon("warning"), h("span", {}, message), iconButton("close", "Dismiss", () => item.remove(), "", "icon-btn tiny"));
    this.errors.append(item);
    while (this.errors.childElementCount > 3) this.errors.firstElementChild!.remove();
  }

  /** The binding for a request that needs a live zone, or null before one is open. */
  requestBinding(): RequestBinding | null {
    const b = this.snap?.binding;
    return b && b.zoneId !== null ? { ...b, zoneId: b.zoneId } : null;
  }

  private apply(s: Snapshot) {
    this.snap = s;
    for (const l of this.listeners) l(s);
  }
}

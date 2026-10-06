// DOM building for the renderer. Every piece of model or user text lands as a text node.

import type { DesktopAPI } from "../protocol.ts";

declare global {
  interface Window {
    dum: DesktopAPI;
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
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2.5v3M12 18.5v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2.5 12h3M18.5 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1",
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

export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** Terminal colour codes some panel text still carries. */
export function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

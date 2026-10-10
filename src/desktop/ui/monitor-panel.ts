// The Monitor: one large word for whether Dum is recording the screen ("Recording", "Paused", "Off")
// with the reason beneath, three instrument readings (look model, last check, pictures), a text Pause,
// and the context log as plain monospace lines, newest at the bottom, following unless you scroll up.

import type { Snapshot } from "../protocol.ts";
import type { LookLogKind, LookReason } from "../../observe-types.ts";
import { h, type Client } from "./dom.ts";

const REASON: Record<LookReason, string> = {
  unchanged: "nothing changed",
  dedup: "same picture",
  coalesced: "waiting for the screen to settle",
  busy: "the conversation is busy",
  decision: "deciding with you",
  voice: "voice in use",
  "no-zone": "no goal open",
  "no-frame": "no fresh picture",
  permission: "Screen Recording is blocked",
  "unverified-model": "the look model isn't verified for pictures",
  "stale-epoch": "the goal changed",
  "rate-limit": "rate limited",
  timeout: "the look timed out",
  "call-failed": "the look call failed",
};

const KIND: Record<LookLogKind, string> = { note: "SAW", app: "APP", wizard: "WIZ", skipped: "SKIP", error: "ERR", paused: "PAUSE" };

type Status = { tone: "rec" | "paused" | "off"; word: string; why: string };

/** Recording, paused, or off and why, from typed fields only. */
function status(s: Snapshot): Status {
  const look = s.look;
  const off = (why: string): Status => ({ tone: "off", word: "Off", why });
  if (look.paused) return { tone: "paused", word: "Paused", why: "Dum isn't looking until you resume." };
  if (!s.settings.look.screen && !s.settings.look.apps) return off("Looking is off in Settings.");
  if (!s.settings.look.screen) return off("Screen is off in Settings; app switches are still noticed.");
  if (look.permission === "denied" || look.permission === "restricted") return off("Screen Recording is blocked for Dum.");
  if (!s.agent.chosen || look.status === "no-backend") return off("No look model is chosen.");
  if (look.status === "failed") return off(`${look.reason ? REASON[look.reason] : "The look call failed"}.`.replace(/^./, (c) => c.toUpperCase()));
  if (look.status === "blocked") return off(`${look.reason ? REASON[look.reason] : "Blocked"}.`.replace(/^./, (c) => c.toUpperCase()));
  if (look.noPictures) return off(look.noPictures);
  return { tone: "rec", word: "Recording", why: "One fresh frame each time the screen changes." };
}

/** "just now", "42s ago", "5m ago", "2h ago". */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 5 ? "just now" : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export class MonitorPanel {
  readonly el: HTMLElement;
  /** A 3×3 dot-matrix mark: all nine lit while recording, the middle row while paused, the centre only when off. */
  private matrix = h("span", { class: "matrix", "aria-hidden": "true" }, ...Array.from({ length: 9 }, () => h("i")));
  private word = h("span", { class: "status-word" });
  private why = h("p", { class: "secondary status-why" });
  private facts = h("dl", { class: "readings" });
  private pauseBtn = h("button", { type: "button", class: "text-action", onclick: () => this.client.snap && void this.client.call({ type: "look-pause", paused: !this.client.snap.look.paused }) });
  private permissionBtn = h("button", { type: "button", class: "text-action quiet", onclick: () => void this.client.call({ type: "screen-permission" }) }, "Open Screen Recording settings");
  private log = h("ol", { class: "look-log", role: "log", "aria-label": "Context log", tabindex: "0" });
  private empty = h("p", { class: "secondary" }, "Nothing yet. The log fills as Dum looks.");
  private follow = true;
  private logKey = "";

  constructor(private client: Client) {
    this.log.addEventListener("scroll", () => {
      this.follow = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 24;
    });
    // Relative times age while you watch.
    window.setInterval(() => {
      if (this.el.isConnected && this.client.snap) this.drawFacts(this.client.snap);
    }, 5000);
    this.el = h(
      "section",
      { class: "panel panel-monitor", "aria-labelledby": "monitor-title" },
      h("header", { class: "panel-head" }, h("h1", { id: "monitor-title", tabindex: "-1" }, "Monitor")),
      h(
        "div",
        { class: "panel-body" },
        h("div", { class: "status", role: "status" }, h("p", { class: "status-head" }, this.matrix, this.word), this.why, h("div", { class: "status-actions" }, this.pauseBtn, this.permissionBtn)),
        this.facts,
        h("h2", { class: "label" }, "Context log"),
        this.empty,
        this.log,
      ),
    );
  }

  focus() {
    this.pauseBtn.focus();
  }

  update(s: Snapshot) {
    const st = status(s);
    this.matrix.className = `matrix ${st.tone}`;
    this.word.textContent = st.word;
    this.why.textContent = st.why;
    this.pauseBtn.textContent = s.look.paused ? "Resume" : "Pause";
    this.permissionBtn.hidden = !(s.look.permission === "denied" || s.look.permission === "restricted");
    this.drawFacts(s);
    this.drawLog(s);
  }

  private drawFacts(s: Snapshot) {
    const look = s.look;
    const pictures = s.settings.look.screen && !look.noPictures && !look.paused;
    const row = (k: string, v: string) => h("div", { class: "reading" }, h("dt", { class: "label" }, k), h("dd", {}, v));
    this.facts.replaceChildren(
      row("Look model", look.resolved ?? look.chosen?.model ?? "none"),
      row("Last check", ago(look.lastTick ?? look.lastAttempt)),
      row("Pictures", pictures ? "on" : "off"),
    );
  }

  private drawLog(s: Snapshot) {
    const entries = s.lookLog;
    const key = entries.map((e) => e.id).join(",");
    this.empty.hidden = entries.length > 0;
    this.log.hidden = !entries.length;
    if (key === this.logKey) return;
    this.logKey = key;
    this.log.replaceChildren(
      ...entries.map((e) =>
        h(
          "li",
          { class: `log-row log-${e.kind}` },
          h("time", { datetime: e.at }, clock(e.at)),
          h("span", { class: "log-kind" }, KIND[e.kind]),
          h("span", { class: "log-text" }, e.text),
        ),
      ),
    );
    if (this.follow) this.log.scrollTop = this.log.scrollHeight;
  }
}

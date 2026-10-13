// Hub's screen, streamed into Discord. A bot can't go live in a voice channel, so the stream is
// one message in a private #hub-live channel whose screenshot is swapped every few seconds while
// the screen is changing. Each stretch of activity gets its own message, which is marked ended
// when the screen goes quiet, so the channel also reads as a log of what agents did on hub.
// Pure: change detection, when to post, and what the message says. stream.ts does the rest.

import type { Embed } from "../discord/delivery.ts";
import { quiet } from "../discord/delivery.ts";

/** Change detection looks at an 80x50 grayscale thumbnail, so each pixel averages a 20x20 patch. */
export const THUMB_W = 80;
export const THUMB_H = 50;
/** How far (0-255) a thumbnail pixel must move to count. A blinking text cursor moves one by ~10. */
export const PIXEL_DELTA = 16;
/** How many pixels must move, so a lone cursor or a ticking clock isn't activity. */
export const MIN_CHANGED = 3;
export const SAMPLE_MS = 2_000;
/** The fastest the screenshot is swapped. Discord allows five edits per five seconds per channel. */
export const FRAME_MS = 5_000;
/** Quiet this long and the stretch is over. */
export const IDLE_MS = 3 * 60_000;
export const FRAME_NAME = "hub.jpg";

export function changedPixels(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) >= PIXEL_DELTA) n++;
  return n;
}

/** Whether the screen changed since the last sample. The first sample is only a baseline. */
export function moved(prev: Uint8Array | null, next: Uint8Array): boolean {
  if (!prev) return false;
  if (prev.length !== next.length) return true;
  return changedPixels(prev, next) >= MIN_CHANGED;
}

export type Live = { phase: "idle" } | { phase: "live"; startedAt: number; lastChangeAt: number; lastPostAt: number; dirty: boolean };

/** start: post a new message. frame: swap its screenshot. end, pause: mark it so and stop. */
export type Action = "none" | "start" | "frame" | "end" | "pause";

export function step(s: Live, changed: boolean, paused: boolean, now: number): { next: Live; action: Action } {
  if (s.phase === "idle") {
    if (paused || !changed) return { next: s, action: "none" };
    return { next: { phase: "live", startedAt: now, lastChangeAt: now, lastPostAt: now, dirty: false }, action: "start" };
  }
  if (paused) return { next: { phase: "idle" }, action: "pause" };
  const lastChangeAt = changed ? now : s.lastChangeAt;
  const dirty = s.dirty || changed;
  if (now - lastChangeAt >= IDLE_MS) return { next: { phase: "idle" }, action: "end" };
  if (dirty && now - s.lastPostAt >= FRAME_MS) return { next: { ...s, lastChangeAt, dirty: false, lastPostAt: now }, action: "frame" };
  return { next: { ...s, lastChangeAt, dirty }, action: "none" };
}

export type Pause = { until: string | null; at: string };

export function pausedNow(p: Pause | null, now: number): boolean {
  return p !== null && (p.until === null || Date.parse(p.until) > now);
}

export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under a minute";
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export type View = {
  status: "live" | "ended" | "paused" | "restarted";
  /** The focused window's title on hub's screen, usually the page BrowserOS has open. */
  title: string;
  startedAt: number;
  now: number;
  viewer: string;
  image: boolean;
};

const RED = 0xe0443a;
const GRAY = 0x8a8f98;
const unix = (ms: number) => Math.floor(ms / 1000);

export function liveMessage(v: View): { embeds: Embed[] } {
  const ran = duration(v.now - v.startedAt);
  const status = {
    live: `Live since <t:${unix(v.startedAt)}:t>. This frame is from <t:${unix(v.now)}:R>.`,
    ended: `Ended <t:${unix(v.now)}:t> after ${ran}, when the screen went quiet. Last frame below.`,
    paused: `Paused <t:${unix(v.now)}:t> after ${ran}, so private details stay off Discord.`,
    restarted: `Ended when the live view restarted.`,
  }[v.status];
  const title = v.title.trim().replace(/\s+/g, " ").slice(0, 200);
  const embed: Embed = {
    title: v.status === "live" ? "Live on hub" : v.status === "paused" ? "Paused" : "Was live on hub",
    description: [title ? `**${quiet(title)}**` : "", status, `[Watch or take over](${v.viewer}) (tailnet only)`].filter(Boolean).join("\n"),
    color: v.status === "live" ? RED : GRAY,
    timestamp: new Date(v.now).toISOString(),
  };
  if (v.image) embed.image = { url: `attachment://${FRAME_NAME}` };
  return { embeds: [embed] };
}

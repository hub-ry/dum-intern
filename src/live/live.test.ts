// The live view without a screen or Discord: what counts as the screen changing, when a message
// is started, updated, ended or paused, and what it says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duration, FRAME_MS, IDLE_MS, liveMessage, MIN_CHANGED, moved, PIXEL_DELTA, pausedNow, step, THUMB_H, THUMB_W, type Live } from "./live.ts";
import { clearPause, readPause, writePause } from "./pause.ts";

const blank = () => new Uint8Array(THUMB_W * THUMB_H).fill(240);

test("the first sample is a baseline, not activity", () => {
  assert.equal(moved(null, blank()), false);
});

test("a blinking cursor or one ticking pixel isn't activity", () => {
  const next = blank();
  next[100] = 240 - 10; // a text cursor in one 20x20 patch
  next[2000] = 240 - 60; // a clock digit
  next[2001] = 240 - 60;
  assert.equal(moved(blank(), next), false);
});

test("a page load or typing across a few patches is activity", () => {
  const next = blank();
  for (let i = 0; i < MIN_CHANGED; i++) next[400 + i] = 240 - PIXEL_DELTA;
  assert.equal(moved(blank(), next), true);
});

test("a resized screen counts as changed", () => {
  assert.equal(moved(blank(), new Uint8Array(10)), true);
});

const idle: Live = { phase: "idle" };

test("activity starts a stretch, and a paused or still screen doesn't", () => {
  assert.equal(step(idle, false, false, 0).action, "none");
  assert.equal(step(idle, true, true, 0).action, "none");
  const r = step(idle, true, false, 1000);
  assert.equal(r.action, "start");
  assert.deepEqual(r.next, { phase: "live", startedAt: 1000, lastChangeAt: 1000, lastPostAt: 1000, dirty: false });
});

test("frames are swapped at most every FRAME_MS, and only when something changed", () => {
  let s = step(idle, true, false, 0).next;
  let r = step(s, true, false, FRAME_MS - 1);
  assert.equal(r.action, "none");
  s = r.next;
  r = step(s, false, false, FRAME_MS); // the change seen earlier is still owed a frame
  assert.equal(r.action, "frame");
  s = r.next;
  r = step(s, false, false, FRAME_MS * 3);
  assert.equal(r.action, "none", "nothing changed since the last frame");
});

test("quiet for IDLE_MS ends the stretch; any change resets the clock", () => {
  let s = step(idle, true, false, 0).next;
  s = step(s, true, false, IDLE_MS - 1).next;
  assert.notEqual(step(s, false, false, IDLE_MS * 2 - 2).action, "end");
  const r = step(s, false, false, IDLE_MS * 2 - 1);
  assert.equal(r.action, "end");
  assert.deepEqual(r.next, idle);
});

test("a pause stops a live stretch at once", () => {
  const s = step(idle, true, false, 0).next;
  const r = step(s, true, true, 2000);
  assert.equal(r.action, "pause");
  assert.deepEqual(r.next, idle);
});

test("a timed pause expires; an open one lasts until resumed", () => {
  assert.equal(pausedNow(null, 0), false);
  assert.equal(pausedNow({ until: "2026-10-13T12:00:00.000Z", at: "x" }, Date.parse("2026-10-13T11:59:00Z")), true);
  assert.equal(pausedNow({ until: "2026-10-13T12:00:00.000Z", at: "x" }, Date.parse("2026-10-13T12:00:01Z")), false);
  assert.equal(pausedNow({ until: null, at: "x" }, Date.now() + 1e12), true);
});

test("pause files round-trip and clear", () => {
  const path = join(mkdtempSync(join(tmpdir(), "dum-live-")), "nested", "pause.json");
  assert.equal(readPause(path), null);
  const now = new Date("2026-10-13T12:00:00Z");
  assert.deepEqual(writePause(path, 30, now), { until: "2026-10-13T12:30:00.000Z", at: now.toISOString() });
  assert.deepEqual(readPause(path), { until: "2026-10-13T12:30:00.000Z", at: now.toISOString() });
  assert.equal(writePause(path, 0, now).until, null);
  clearPause(path);
  assert.equal(readPause(path), null);
});

test("durations read plainly", () => {
  assert.equal(duration(20_000), "under a minute");
  assert.equal(duration(4 * 60_000), "4 min");
  assert.equal(duration(125 * 60_000), "2 h 5 min");
});

const view = { title: "Gmail - Inbox - BrowserOS", startedAt: Date.parse("2026-10-13T12:00:00Z"), now: Date.parse("2026-10-13T12:04:00Z"), viewer: "http://hub:6080/vnc.html", image: true };

test("the live message names the window, links the screen and shows the frame", () => {
  const e = liveMessage({ ...view, status: "live" }).embeds[0]!;
  assert.equal(e.title, "Live on hub");
  assert.match(e.description!, /\*\*Gmail - Inbox - BrowserOS\*\*/);
  assert.match(e.description!, /\(http:\/\/hub:6080\/vnc\.html\)/);
  assert.deepEqual(e.image, { url: "attachment://hub.jpg" });
});

test("ended, paused and restarted messages say why, and none can ping", () => {
  assert.match(liveMessage({ ...view, status: "ended" }).embeds[0]!.description!, /after 4 min, when the screen went quiet/);
  assert.match(liveMessage({ ...view, status: "paused" }).embeds[0]!.description!, /private details stay off Discord/);
  const r = liveMessage({ ...view, status: "restarted", image: false }).embeds[0]!;
  assert.equal(r.image, undefined);
  assert.doesNotMatch(liveMessage({ ...view, title: "@everyone look", status: "live" }).embeds[0]!.description!, /@everyone/);
});

test("no message uses an em dash", () => {
  for (const status of ["live", "ended", "paused", "restarted"] as const) assert.doesNotMatch(JSON.stringify(liveMessage({ ...view, status })), /\u2014/);
});

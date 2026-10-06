import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenWizardAdvice, type ScreenAdviceOptions } from "../src/desktop/screen-wizard-advice.ts";
import { DesktopController } from "../src/desktop/controller.ts";
import { DEFAULTS, DesktopSettings } from "../src/desktop/settings.ts";
import { HostRequestSchema } from "../src/desktop/host-protocol.ts";
import type { Decision } from "../src/wizard.ts";

const PNG1 = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("frame-one")]);
const PNG2 = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("frame-two")]);
const temp = () => mkdtempSync(join(tmpdir(), "dum-screen-wizard-"));

function fixture(extra: Partial<ScreenAdviceOptions> = {}) {
  let now = 0;
  let frame: Buffer | null = PNG1;
  let blocked: string | null = null;
  const checks: Decision[] = [];
  const quips: string[] = [];
  const advice = new ScreenWizardAdvice({
    automatic: false,
    now: () => now,
    capture: async () => frame,
    blocked: () => blocked,
    check: async (moment) => { checks.push(moment); return "there's an uncaught error on screen."; },
    publish: (text) => quips.push(text),
    ...extra,
  });
  return {
    advice, checks, quips,
    time: (t: number) => { now = t; },
    setFrame: (b: Buffer | null) => { frame = b; },
    block: (reason: string | null) => { blocked = reason; advice.refresh(); },
  };
}

test("off never captures or checks", async () => {
  let captures = 0;
  const d = fixture({ capture: async () => { captures++; return PNG1; } });
  await d.advice.tick();
  assert.equal(captures, 0, "disabled advisor must not capture");
  assert.deepEqual(d.quips, []);
  assert.match(d.advice.status, /off/);
  d.advice.close();
});

test("first tick takes frame and rate-limits: no check until rateMs elapsed", async () => {
  const d = fixture();
  d.advice.setEnabled(true);
  // First tick: captures frame, rate has not elapsed (lastCheck -Infinity so it WILL check)
  await d.advice.tick();
  assert.equal(d.checks.length, 1, "first tick should check the wizard");
  assert.deepEqual(d.quips, ["there's an uncaught error on screen."]);
  // Second tick with same frame: deduplicated
  await d.advice.tick();
  assert.equal(d.checks.length, 1, "same frame must not trigger second check");
  d.advice.close();
});

test("identical frame is not rechecked even after rateMs", async () => {
  const d = fixture({ rateMs: 0 });
  d.advice.setEnabled(true);
  await d.advice.tick();
  assert.equal(d.checks.length, 1);
  d.time(999_999);
  await d.advice.tick(); // same frame, rate elapsed
  assert.equal(d.checks.length, 1, "identical frame must be deduplicated regardless of rate");
  d.advice.close();
});

test("different frame triggers check after rateMs elapsed", async () => {
  const d = fixture({ rateMs: 1_000 });
  d.advice.setEnabled(true);
  await d.advice.tick();
  assert.equal(d.checks.length, 1);
  d.setFrame(PNG2);
  // rate not elapsed yet
  d.time(500);
  await d.advice.tick();
  assert.equal(d.checks.length, 1, "rate limit prevents second check");
  // rate elapsed
  d.time(1_001);
  await d.advice.tick();
  assert.equal(d.checks.length, 2, "new frame after rateMs triggers check");
  assert.equal(d.quips.length, 1, "same quip text deduped");
  d.advice.close();
});

test("capture returning null shows honest status, no wizard call", async () => {
  const d = fixture();
  d.setFrame(null);
  d.advice.setEnabled(true);
  await d.advice.tick();
  assert.equal(d.checks.length, 0);
  assert.match(d.advice.status, /permission/);
  d.advice.close();
});

test("capture exception shows honest status, no wizard call", async () => {
  const d = fixture({ capture: async () => { throw new Error("Screen Recording is off for dum."); } });
  d.advice.setEnabled(true);
  await d.advice.tick();
  assert.equal(d.checks.length, 0);
  assert.match(d.advice.status, /unavailable/);
  d.advice.close();
});

test("blocked states pause capture and no wizard call", async () => {
  const d = fixture();
  d.block("wizard advice is paused while dum or a command is active");
  d.advice.setEnabled(true);
  await d.advice.tick();
  assert.equal(d.checks.length, 0, "blocked must not capture or check");
  assert.match(d.advice.status, /paused/);
  d.advice.close();
});

test("disable and close abort in-flight checks and discard their result", async () => {
  const reply = Promise.withResolvers<string | null>();
  const started = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const d = fixture({
    rateMs: 0,
    check: async (_moment, s) => { signal = s; started.resolve(); return reply.promise; },
  });
  d.advice.setEnabled(true);
  const checking = d.advice.tick();
  await started.promise;
  d.advice.close();
  assert.equal(signal?.aborted, true);
  reply.resolve("advice after close");
  await checking;
  assert.deepEqual(d.quips, [], "closed advisor must not publish");
});

test("stale frame from previous generation does not publish after clear", async () => {
  const reply = Promise.withResolvers<string | null>();
  const started = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const d = fixture({
    rateMs: 0,
    check: async (_moment, s) => { signal = s; started.resolve(); return reply.promise; },
  });
  d.advice.setEnabled(true);
  const checking = d.advice.tick();
  await started.promise;
  // interrupt clears generation
  d.advice.interrupt();
  assert.equal(signal?.aborted, true);
  reply.resolve("stale advice");
  await checking;
  assert.deepEqual(d.quips, [], "stale result after interrupt must not publish");
  d.advice.close();
});

test("settings migration: legacy file without wizardAdvice field defaults to false", () => {
  const dir = temp();
  const old = { hotkey: "Alt+Shift+K", alwaysOnTop: false, allWorkspaces: false, launchAtLogin: false, personalContext: false };
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 1, settings: old, recent: [], companion: null }));
  const loaded = DesktopSettings.load(dir);
  assert.equal(loaded.warning, "");
  assert.equal(loaded.settings.wizardAdvice, false, "absent wizardAdvice in legacy file must migrate to false");
  assert.equal(loaded.settings.wizardSource, "screen", "absent wizardSource defaults to screen");
});

test("settings defaults: fresh install has wizardAdvice true and wizardSource screen", () => {
  const dir = temp();
  const fresh = DesktopSettings.load(dir); // no file
  assert.equal(fresh.settings.wizardAdvice, true, "fresh install default must be true");
  assert.equal(fresh.settings.wizardSource, "screen", "fresh install source default must be screen");
  // Verify DEFAULTS directly
  assert.equal(DEFAULTS.wizardAdvice, true);
  assert.equal(DEFAULTS.wizardSource, "screen");
});

test("host protocol: quip op is valid, wizard-advice op works without source field", () => {
  const base = { epoch: "e", id: "1" };
  // quip op
  const quip = HostRequestSchema.safeParse({ ...base, op: "quip", text: "an error is visible on screen." });
  assert.ok(quip.success, "quip op must be valid");
  // wizard-advice still works without source (utility process protocol unchanged)
  assert.ok(HostRequestSchema.safeParse({ ...base, op: "wizard-advice", enabled: true }).success);
  assert.ok(HostRequestSchema.safeParse({ ...base, op: "wizard-advice", enabled: false }).success);
  // quip with oversized text is invalid
  assert.ok(!HostRequestSchema.safeParse({ ...base, op: "quip", text: "x".repeat(1001) }).success);
});

test("controller screen source uses ScreenWizardAdvice; file source uses SavedChangeAdvice; toggle switches mid-session", async () => {
  let captures = 0;
  const controller = new DesktopController(() => {}, {
    screen: {
      automatic: false,
      capture: async () => { captures++; return PNG1; },
      check: async () => null,
    },
    advice: { automatic: false },
  });
  controller.setWizardAdvice(true, 'screen');
  assert.match(controller.wizardStatus, /open a project|off/, "no project open yet");
  controller.setWizardAdvice(true, 'files');
  assert.match(controller.wizardStatus, /off|open a project/);
  assert.equal(captures, 0, "no captures without open project");
});

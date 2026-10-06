import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as settle } from "node:timers/promises";
import { SavedChangeAdvice, ADVICE_TIMING, type AdviceOptions } from "../src/desktop/saved-change-advice.ts";
import { DesktopController } from "../src/desktop/controller.ts";
import { Workspace, SAVED_CHANGE_LIMITS, unifiedDiff, type SavedChange } from "../src/workspace.ts";
import { compose, type Decision } from "../src/wizard.ts";
import { byId } from "../src/anchors.ts";
import { HostRequestSchema } from "../src/desktop/host-protocol.ts";

function file(text: string, path = "counter.py"): SavedChange {
  return { path, text, from: 1, sha: createHash("sha256").update(text).digest("hex"), diff: unifiedDiff(path, null, text) };
}

function fixture(extra: Partial<AdviceOptions> = {}) {
  let now = 0;
  let files = [file("count = 1\n")];
  let blocked: string | null = null;
  let reads = 0;
  const checks: Decision[] = [];
  const quips: string[] = [];
  const advice = new SavedChangeAdvice("/project", {
    automatic: false,
    now: () => now,
    read: async () => { reads++; return files; },
    blocked: () => blocked,
    check: async (moment) => { checks.push(moment); return "count loses its value here."; },
    publish: (text) => quips.push(text),
    ...extra,
  });
  return {
    advice, checks, quips,
    get reads() { return reads; },
    time: (time: number) => { now = time; },
    save: (text: string) => { files = [file(text)]; },
    files: (next: SavedChange[]) => { files = next; },
    block: (reason: string | null) => { blocked = reason; advice.refresh(); },
  };
}

async function enabled(d: { advice: SavedChangeAdvice }) {
  d.advice.setEnabled(true);
  await d.advice.tick();
}

test("off never reads or checks, and the first opted-in baseline doesn't replay dirty work", async () => {
  const d = fixture();
  await d.advice.tick();
  assert.equal(d.reads, 0);
  assert.equal(d.checks.length, 0);
  await enabled(d);
  assert.equal(d.reads, 1);
  assert.equal(d.checks.length, 0);
  await d.advice.tick();
  assert.equal(d.checks.length, 0);
  d.advice.setEnabled(false);
  d.save("count = 0\n");
  await d.advice.tick();
  assert.equal(d.reads, 2);
  await enabled(d);
  assert.equal(d.checks.length, 0, "saves made while off are a baseline, not an unsolicited replay");
  d.advice.close();
});

test("saved changes debounce and rate-limit at the exact clock boundaries", async () => {
  const d = fixture();
  await enabled(d);
  d.save("count = 0\n");
  await d.advice.tick();
  d.time(ADVICE_TIMING.debounceMs - 1);
  await d.advice.tick();
  assert.equal(d.checks.length, 0);
  d.time(ADVICE_TIMING.debounceMs);
  await d.advice.tick();
  assert.equal(d.checks.length, 1);
  assert.equal(d.quips.length, 1);
  await d.advice.tick();
  assert.equal(d.checks.length, 1, "the same save never repeats");
  d.save("count = -1\n");
  await d.advice.tick();
  d.time(ADVICE_TIMING.debounceMs + ADVICE_TIMING.rateMs - 1);
  await d.advice.tick();
  assert.equal(d.checks.length, 1);
  d.time(ADVICE_TIMING.debounceMs + ADVICE_TIMING.rateMs);
  await d.advice.tick();
  assert.equal(d.checks.length, 2);
  assert.equal(d.quips.length, 1, "identical advice is suppressed even for a different save");
  d.advice.close();
});

test("a check is single-flight and a newer external save invalidates its late aside", async () => {
  const reply = Promise.withResolvers<string | null>();
  let calls = 0;
  const d = fixture({ debounceMs: 0, rateMs: 0, check: async () => { calls++; return reply.promise; } });
  await enabled(d);
  d.save("count = 0\n");
  const first = d.advice.tick();
  await settle();
  const concurrent = d.advice.tick();
  assert.equal(concurrent, first);
  assert.equal(calls, 1);
  d.save("count = 2\n");
  reply.resolve("the older count breaks the total.");
  await first;
  assert.deepEqual(d.quips, []);
  assert.match(d.advice.status, /older save/);
  d.advice.close();
});

test("disable, close and Stop abort in-flight checks and discard their result", async () => {
  for (const action of ["disable", "close", "stop"] as const) {
    const reply = Promise.withResolvers<string | null>();
    let signal: AbortSignal | undefined;
    const d = fixture({ debounceMs: 0, rateMs: 0, check: async (_moment, s) => { signal = s; return reply.promise; } });
    await enabled(d);
    d.save("count = 0\n");
    const check = d.advice.tick();
    await settle();
    if (action === "disable") d.advice.setEnabled(false);
    else if (action === "close") d.advice.close();
    else d.advice.interrupt();
    assert.equal(signal?.aborted, true, action);
    reply.resolve("a line from the old lifecycle.");
    await check;
    assert.deepEqual(d.quips, [], action);
    if (action !== "close") {
      d.advice.setEnabled(true);
      await d.advice.tick();
      assert.deepEqual(d.quips, [], "resume starts from a quiet baseline");
    }
    d.advice.close();
  }
});

test("busy work, courses and protected unaided practice don't read or leak solutions", async () => {
  const d = fixture({ debounceMs: 0, rateMs: 0 });
  d.block("wizard advice is paused for unaided practice");
  await enabled(d);
  assert.equal(d.reads, 0);
  assert.equal(d.checks.length, 0);
  assert.match(d.advice.status, /unaided practice/);
  d.block(null);
  await d.advice.tick();
  d.block("wizard advice is paused for the optional course");
  d.save("count = 0\n");
  await d.advice.tick();
  assert.equal(d.reads, 1);
  d.block(null);
  await d.advice.tick();
  assert.equal(d.checks.length, 0, "course-time saves don't replay after the pause");
  d.block("wizard advice is paused while dum is working");
  d.save("count = 2\n");
  await d.advice.tick();
  assert.equal(d.reads, 2);
  d.advice.close();
});

test("only newly saved code reaches a bounded payload, not old dirty files", async () => {
  const d = fixture({ debounceMs: 0, rateMs: 0 });
  const old = file("unrelated_existing_dirty_work = 1\n", "old.py");
  d.files([old, file("count = 1\n")]);
  await enabled(d);
  d.files([old, file(`count = 0\n${"# bounded extra context\n".repeat(2000)}`)]);
  await d.advice.tick();
  assert.deepEqual(d.checks[0]!.paths, ["counter.py"]);
  assert.ok(Buffer.byteLength(d.checks[0]!.changes!) <= SAVED_CHANGE_LIMITS.contextBytes);
  assert.doesNotMatch(d.checks[0]!.changes!, /unrelated_existing_dirty_work/);
  assert.match(d.checks[0]!.changes!, /-count = 1/);
  assert.match(d.checks[0]!.changes!, /\+count = 0/);
  d.advice.close();
});

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dum-advice-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  return { root, git, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("safe Git snapshots exclude secrets, ignored tracked files, final and ancestor symlinks", async () => {
  const d = scratch();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "dum-advice-outside-")));
  try {
    writeFileSync(join(d.root, "counter space.py"), "count = 1\n");
    writeFileSync(join(d.root, "ignored.py"), "private_value = 1\n");
    d.git("add", "counter space.py", "ignored.py");
    d.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
    writeFileSync(join(d.root, ".gitignore"), "ignored.py\n");
    writeFileSync(join(d.root, "counter space.py"), "count = 0\n");
    writeFileSync(join(d.root, "ignored.py"), "DO_NOT_SEND_TRACKED_IGNORED = 2\n");
    writeFileSync(join(d.root, ".env"), "DO_NOT_SEND_SECRET=token\n");
    writeFileSync(join(outside, "private.py"), "DO_NOT_SEND_OUTSIDE = 1\n");
    symlinkSync(join(outside, "private.py"), join(d.root, "escape.py"));
    symlinkSync(join(d.root, "counter space.py"), join(d.root, "alias.py"));
    symlinkSync(outside, join(d.root, "linked"));
    const workspace = new Workspace(d.root);
    const files = await workspace.savedChanges(["linked/private.py"]);
    assert.ok(files.some((f) => f.path === "counter space.py"));
    assert.ok(!files.some((f) => /ignored|\.env|escape|alias|linked/.test(f.path)));
    assert.doesNotMatch(files.map((f) => `${f.text}\n${f.diff}`).join("\n"), /DO_NOT_SEND/);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(workspace.savedChanges([], aborted.signal));
  } finally { d.close(); rmSync(outside, { recursive: true, force: true }); }
});

test("workspace snapshots cap the number of saved files", async () => {
  const d = scratch();
  try {
    for (let i = 0; i < SAVED_CHANGE_LIMITS.files + 4; i++) writeFileSync(join(d.root, `file${i}.py`), `count = ${i}\n`);
    assert.equal((await new Workspace(d.root).savedChanges()).length, SAVED_CHANGE_LIMITS.files);
  } finally { d.close(); }
});

test("a saved external-editor change produces a sourced aside with no message to dum", async () => {
  const d = scratch();
  const previousHome = process.env.DUM_HOME;
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dum-advice-home-")));
  process.env.DUM_HOME = home;
  writeFileSync(join(d.root, "money.py"), "total = 1\n");
  d.git("add", "money.py");
  d.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
  const workspace = new Workspace(d.root);
  let reads = 0;
  let calls = 0;
  const floats = byId("python-floats")!;
  const controller = new DesktopController(() => {}, { advice: {
    automatic: false, debounceMs: 0, rateMs: 0,
    read: async (signal, previous) => { reads++; return workspace.savedChanges(previous, signal); },
    check: async (moment) => {
      calls++;
      return compose(JSON.stringify({ anchor: floats.id, say: "the total's binary rounding can change the equality result here." }), moment, [floats]);
    },
  } });
  try {
    await controller.choose(d.root, { path: "", text: "", warning: "" });
    await controller.pollWizardAdvice();
    assert.equal(reads, 0, "a selected but opted-out project is never polled");
    controller.setWizardAdvice(true, 'files');
    await controller.pollWizardAdvice();
    assert.match(controller.wizardStatus, /watching/);
    const token = controller.inputToken;
    writeFileSync(join(d.root, "money.py"), "total = 0.1 + 0.2\nis_exact = total == 0.3\n");
    await controller.pollWizardAdvice();
    const aside = controller.state!.transcript.find((e) => e.kind === "quip");
    assert.ok(aside?.kind === "quip");
    assert.match(aside.text, /source: https:\/\/docs\.python\.org/);
    assert.equal(calls, 1);
    assert.equal(controller.inputToken, token);
    assert.equal(controller.state!.prompt?.type, "next");
    assert.ok(!controller.state!.transcript.some((e) => e.kind === "say" || (e.kind === "question" && e.answer !== null)));
    controller.setWizardAdvice(false, 'files');
  } finally {
    await controller.close();
    d.close();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DUM_HOME;
    else process.env.DUM_HOME = previousHome;
  }
});

test("host advice requests are strict and legacy open requests default to off", () => {
  const base = { epoch: "e", id: "1" };
  const open = HostRequestSchema.parse({ ...base, op: "open", root: "/p", personal: { path: "", text: "", warning: "" } });
  assert.ok(open.op === "open" && open.wizardAdvice === false);
  assert.ok(HostRequestSchema.safeParse({ ...base, op: "wizard-advice", enabled: true }).success);
  assert.ok(!HostRequestSchema.safeParse({ ...base, op: "wizard-advice", enabled: "true" }).success);
  assert.ok(!HostRequestSchema.safeParse({ ...base, op: "wizard-advice", enabled: true, root: "/outside" }).success);
});

test("a project switch aborts its old model call and can't post a stale aside into the new store", async () => {
  const a = scratch();
  const b = scratch();
  const previousHome = process.env.DUM_HOME;
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dum-advice-switch-home-")));
  process.env.DUM_HOME = home;
  const reply = Promise.withResolvers<string | null>();
  const started = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  writeFileSync(join(a.root, "counter.py"), "count = 1\n");
  writeFileSync(join(b.root, "other.py"), "total = 1\n");
  const controller = new DesktopController(() => {}, { advice: {
    automatic: false, debounceMs: 0, rateMs: 0,
    check: async (_moment, current) => { signal = current; started.resolve(); return reply.promise; },
  } });
  try {
    controller.setWizardAdvice(true, 'files');
    await controller.choose(a.root, { path: "", text: "", warning: "" });
    await controller.pollWizardAdvice();
    writeFileSync(join(a.root, "counter.py"), "count = 0\n");
    const checking = controller.pollWizardAdvice();
    await started.promise;
    const switching = controller.choose(b.root, { path: "", text: "", warning: "" });
    await settle();
    assert.equal(signal?.aborted, true);
    reply.resolve("an aside about the old project.");
    await checking;
    await switching;
    assert.equal(controller.state!.root, b.root);
    assert.ok(!controller.state!.transcript.some((e) => e.kind === "quip"));
    await controller.pollWizardAdvice();
    assert.ok(!controller.state!.transcript.some((e) => e.kind === "quip"), "the new project's dirty files are only its baseline");
  } finally {
    reply.resolve(null);
    await controller.close();
    a.close();
    b.close();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DUM_HOME;
    else process.env.DUM_HOME = previousHome;
  }
});

test("activity that starts during a model check aborts it and can't leak a practice hint", async () => {
  const reply = Promise.withResolvers<string | null>();
  const started = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const d = fixture({ debounceMs: 0, rateMs: 0, check: async (_moment, s) => { signal = s; started.resolve(); return reply.promise; } });
  await enabled(d);
  d.save("count = 0\n");
  const checking = d.advice.tick();
  await started.promise;
  d.block("wizard advice is paused for unaided practice");
  assert.equal(signal?.aborted, true);
  reply.resolve("the next implementation step would be a solution.");
  await checking;
  assert.deepEqual(d.quips, []);
  assert.match(d.advice.status, /unaided practice/);
  d.advice.close();
});

test("saved-change read failures show an honest status without an aside or model call", async () => {
  const d = fixture({ read: async () => { throw new Error("bounded Git read failed"); } });
  await enabled(d);
  assert.equal(d.checks.length, 0);
  assert.deepEqual(d.quips, []);
  assert.match(d.advice.status, /couldn't check/);
  d.advice.close();
});

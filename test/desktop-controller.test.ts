// The desktop conversation: prompts answered only by the message meant for them, stops and
// switches that approve nothing, one dum per project, and pictures that are looked at, not kept.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { DesktopController } from "../src/desktop/controller.ts";
import { Store, Cancelled, type Entry } from "../src/store.ts";
import { contract, prepare, toolkit } from "../src/session.ts";
import { acquire } from "../src/session-lock.ts";
import { decode, look } from "../src/look.ts";
import * as memory from "../src/memory.ts";
import * as skills from "../src/skills.ts";
import type { Query } from "../src/oneshot.ts";
import { fileURLToPath } from "node:url";

const tick = () => new Promise((r) => setImmediate(r));
const personal = { path: "", text: "", warning: "" };
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("a tiny picture")]).toString("base64");
const image = { data: PNG, mimeType: "image/png" as const, label: "main.py - Editor" };
const init = { type: "system", subtype: "init", apiKeySource: "none", tools: [], mcp_servers: [], plugins: [] };

/** Scratch skill home and Git repos, removed by `done`. */
function scratch() {
  const dirs: string[] = [];
  const home = mkdtempSync(`${tmpdir()}/dum-home-`);
  dirs.push(home);
  process.env.DUM_HOME = home;
  const repo = (files: Record<string, string> = {}) => {
    const root = realpathSync(mkdtempSync(`${tmpdir()}/dum-desk-`));
    dirs.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    for (const [path, body] of Object.entries(files)) writeFileSync(`${root}/${path}`, body);
    return root;
  };
  const done = () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); };
  return { repo, done };
}

async function until(what: string, ok: () => boolean) {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), what);
}

test("stopping withdraws a parked plan and self-report unanswered, and a late y is only the next request", async () => {
  const { repo, done } = scratch();
  try {
    const root = repo({ "main.py": "print('hi')\n" });
    const store = new Store("r", "understand", root, ["main.py"]);
    const ctx = prepare({ name: "r", root, files: ["main.py"] }, "understand", store, personal);
    const tools = Object.fromEntries(toolkit(ctx).map((t) => [t.name, t.run]));
    skills.write(skills.unlock(skills.read(), { name: "printing", lang: "python", how: "typed", why: "test" }));

    const plan = tools.propose_plan!({ summary: "x", pieces: [
      { skill: "printing", lang: "python", what: "print", paths: ["main.py"] },
      { skill: "change detection", lang: "python", what: "core", core: true, paths: ["core.py"] },
    ] });
    await until("the plan shows", () => store.getSnapshot().prompt?.type === "plan");
    store.cancel();
    await assert.rejects(plan, (err) => err instanceof Cancelled && !err.final);
    assert.equal(ctx.plan, null);
    const entry = () => store.getSnapshot().transcript.find((e) => e.kind === "plan");
    assert.equal(entry()?.kind === "plan" && entry()!.approved, false, "withdrawn means not approved");

    const next = store.askNext();
    store.submit("y");
    assert.equal(await next, "y", "the y answered what was showing: the next request");
    assert.equal(ctx.plan, null);
    assert.equal(store.getSnapshot().prompt, null, "the withdrawn plan never comes back");

    const attest = tools.review_submission!({ skill: "conditionals", lang: "python", paths: ["main.py"], passed: true, feedback: "works" });
    await until("the self-report shows", () => store.getSnapshot().prompt?.type === "question");
    const asked = store.getSnapshot().prompt;
    assert.ok(asked?.type === "question" && asked.purpose === "attest", "a self-report is marked for explicit yes/no controls");
    store.cancel();
    await assert.rejects(attest, Cancelled);
    assert.equal(skills.levelIn(skills.read(), "conditionals", "python"), null, "a withdrawn self-report builds nothing");
  } finally { done(); }
});

test("closing while a permission is parked answers nothing, and nothing after it is heard", async () => {
  const store = new Store("r", "understand");
  const asked = store.askQuestion("share /x/notes.txt with dum? (y/n)", "", false, "share");
  store.close();
  await assert.rejects(asked, (err) => err instanceof Cancelled && err.final);
  const after = store.getSnapshot();
  assert.equal(after.prompt, null);
  store.submit("y");
  store.note("late");
  assert.equal(store.getSnapshot(), after, "a closed store changes for nobody");
  await assert.rejects(store.askNext(), (err) => err instanceof Cancelled && err.final);
  const question = after.transcript.find((e) => e.kind === "question");
  assert.equal(question?.kind === "question" && question.answer, null);
});

test("a picture is refused at a permission prompt, and stopping denies that permission", async () => {
  const { repo, done } = scratch();
  const outside = mkdtempSync(`${tmpdir()}/dum-outside-`);
  const c = new DesktopController(() => {});
  try {
    const root = repo({ "main.py": "x = 1\n" });
    writeFileSync(`${outside}/notes.txt`, "outside notes\n");
    await c.choose(root, personal);
    assert.equal(c.state?.prompt?.type, "next");
    assert.ok(c.canAttach && c.inputToken);

    await c.send(`:inspect ${outside}/notes.txt`, c.inputToken);
    await until("the share permission shows", () => c.state?.prompt?.type === "question");
    const prompt = c.state!.prompt;
    assert.ok(prompt?.type === "question" && prompt.purpose === "share");
    assert.ok(!c.canAttach);
    await assert.rejects(c.send("y", c.inputToken, image), /picture only goes/);
    assert.equal(c.state?.prompt, prompt, "the refused message answered nothing");

    c.interrupt();
    await until("back at what next", () => c.canAttach);
    const t = c.state!.transcript;
    assert.ok(!t.some((e) => e.kind === "excerpt"), "nothing outside was read");
    assert.ok(t.some((e) => e.kind === "note" && /:inspect stopped/.test(e.text)));
    await assert.rejects(c.send("hello", "a-stale-token"), /closed before/);
    await assert.rejects(c.send(":web", c.inputToken), /terminal edition/);
    await assert.rejects(c.send("x".repeat(40 * 1024), c.inputToken), /over/);
    assert.throws(() => c.command("skill", "recursion"), /isn't a desktop command/);
  } finally {
    await c.close();
    rmSync(outside, { recursive: true, force: true });
    done();
  }
});

test("switching projects closes the old one first, and nothing meant for it reaches the new one", async () => {
  const { repo, done } = scratch();
  const c = new DesktopController(() => {});
  try {
    const a = repo({ "a.py": "x = 1\n" });
    const b = repo({ "b.py": "y = 2\n" });
    c.panel("tree");
    assert.ok(c.tree && c.tree.tracks.length, "the tree reads before any project opens");
    await c.choose(a, personal);
    const tokenA = c.inputToken;
    assert.ok(existsSync(`${a}/.dum/session.lock`));
    assert.throws(() => acquire(a, "terminal"), /already open/, "a terminal dum can't open it beside the desktop");

    await c.choose(b, personal);
    assert.equal(c.state?.root, b);
    assert.ok(!existsSync(`${a}/.dum/session.lock`) && existsSync(`${b}/.dum/session.lock`));
    await assert.rejects(c.send(":remember meant for a", tokenA), /closed before/);
    await c.send(":remember meant for b", c.inputToken);
    assert.match(readFileSync(`${b}/.dum/memory.md`, "utf8"), /meant for b/);
    assert.ok(!existsSync(`${a}/.dum/memory.md`), "the old project heard nothing");

    const other = acquire(a, "terminal");
    await assert.rejects(c.choose(a, personal), /already open/);
    assert.equal(c.state?.root, b, "a refused switch leaves the open project as it was");
    assert.ok(c.inputToken);
    other();

    await c.close();
    assert.equal(c.state, null);
    assert.equal(c.inputToken, "");
    assert.ok(!existsSync(`${b}/.dum/session.lock`));
  } finally {
    await c.close();
    done();
  }
});

test("a restored conversation is history: its plan and self-report wait for nothing", async () => {
  const { repo, done } = scratch();
  const c = new DesktopController(() => {});
  try {
    const root = repo({ "main.py": "x = 1\n" });
    const entries: Entry[] = [
      { kind: "plan", id: 1, plan: "add printing", approved: null },
      { kind: "question", id: 2, question: "did you write main.py yourself, without AI or copied code? (y/n)", why: "", answer: null },
      { kind: "shot", id: 3, label: "Terminal", observation: "a failing test", sha: "a".repeat(64) },
    ];
    memory.save(root, entries);
    assert.deepEqual(memory.load(root).entries, entries, "a shared picture's description round-trips; it holds no picture");

    await c.choose(root, personal);
    assert.equal(c.state?.prompt?.type, "next");
    assert.deepEqual(c.state?.transcript.slice(0, 3), entries);

    const store = new Store("r", "understand");
    store.restoreTranscript(entries);
    store.submit("y");
    const t = store.getSnapshot().transcript;
    assert.equal(t[0]?.kind === "plan" && t[0].approved, null, "a y after restoring approves no old plan");
    assert.equal(t[1]?.kind === "question" && t[1].answer, null);
    assert.equal(store.getSnapshot().prompt, null);
  } finally {
    await c.close();
    done();
  }
});

test("a project lock is only taken from a process that's gone, and only its holder removes it", async () => {
  const { repo, done } = scratch();
  try {
    const root = repo();
    mkdirSync(`${root}/.dum`, { recursive: true });
    const lock = `${root}/.dum/session.lock`;
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lock, JSON.stringify({ pid: gone, host: hostname(), who: "terminal", token: "old" }));
    const release = acquire(root, "desktop");
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid);
    release();
    release();
    assert.ok(!existsSync(lock));

    for (const body of [JSON.stringify({ pid: gone, host: "elsewhere", who: "terminal", token: "t" }), "not a lock"]) {
      writeFileSync(lock, body);
      assert.throws(() => acquire(root, "desktop"), /already open|can't read/);
      assert.equal(readFileSync(lock, "utf8"), body, "a lock it can't prove abandoned is left alone");
    }
    rmSync(lock);

    const mine = acquire(root, "desktop");
    const theirs = JSON.stringify({ pid: process.pid, host: hostname(), who: "terminal", token: "theirs" });
    writeFileSync(lock, theirs);
    mine();
    assert.equal(readFileSync(lock, "utf8"), theirs, "releasing never removes someone else's lock");
    rmSync(lock);

    // The guard that serializes every change to the lock is never taken from anyone.
    const guard = `${root}/.dum/session.lock.guard`;
    const abandoned = JSON.stringify({ pid: gone, host: hostname(), who: "desktop", token: "g" });
    writeFileSync(guard, abandoned);
    assert.throws(() => acquire(root, "terminal"), /session\.lock\.guard was left by desktop \(pid \d+, no longer running\)\. If no dum is open in this project, delete \.dum\/session\.lock\.guard/);
    assert.equal(readFileSync(guard, "utf8"), abandoned, "an abandoned guard waits for a person");
    assert.ok(!existsSync(lock));
    writeFileSync(guard, JSON.stringify({ pid: process.pid, host: hostname(), who: "desktop", token: "busy" }));
    assert.throws(() => acquire(root, "terminal"), /opening or closing this project/);
    rmSync(guard);

    const held = acquire(root, "desktop");
    writeFileSync(guard, JSON.stringify({ pid: process.pid, host: hostname(), who: "desktop", token: "busy" }));
    held();
    assert.ok(existsSync(lock), "letting go while the guard is busy leaves the lock for takeover, untouched");
    assert.ok(existsSync(guard));
  } finally { done(); }
});

const loader = fileURLToPath(import.meta.resolve("tsx"));
/** A dum taking and letting go of one project over and over; with CRASH, it dies holding it once. */
const CONTENDER = `
import { acquire } from ${JSON.stringify(new URL("../src/session-lock.ts", import.meta.url).href)};
import { appendFileSync, closeSync, openSync, unlinkSync } from "node:fs";
const { ROOT, LOG, CRASH } = process.env;
const pause = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; i < 30; i++) {
  let release;
  try {
    release = acquire(ROOT, "terminal");
  } catch (err) {
    if (!/already open|opening or closing/.test(err.message)) appendFileSync(LOG, "error " + err.message + "\\n");
    continue;
  }
  try { closeSync(openSync(ROOT + "/holding", "wx")); } catch { appendFileSync(LOG, "overlap\\n"); }
  appendFileSync(LOG, "held\\n");
  Atomics.wait(pause, 0, 0, 2);
  try { unlinkSync(ROOT + "/holding"); } catch {}
  if (CRASH) process.exit(0);
  release();
}
`;

test("dums contending for one project never hold it at once, and a crashed holder's lock is taken over", async () => {
  const { repo, done } = scratch();
  try {
    const root = repo();
    const log = `${root}/contention.log`;
    writeFileSync(log, "");
    const contend = (crash: boolean) => new Promise<number | null>((settle) => {
      const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", CONTENDER], {
        env: { ...process.env, ROOT: root, LOG: log, CRASH: crash ? "1" : "" },
        stdio: ["ignore", "ignore", "inherit"],
      });
      child.on("close", settle);
    });
    assert.deepEqual(await Promise.all([false, false, false, false, true, true].map(contend)), [0, 0, 0, 0, 0, 0]);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(!lines.includes("overlap"), "two dums held the project at once");
    assert.deepEqual(lines.filter((l) => l.startsWith("error")), []);
    assert.ok(lines.includes("held"));
    assert.ok(!existsSync(`${root}/.dum/session.lock.guard`), "no guard is left behind");
    const release = acquire(root, "desktop");
    release();
    assert.ok(!existsSync(`${root}/.dum/session.lock`));
  } finally { done(); }
});

test("a shared picture is looked at once, as a PNG image block, with nothing saved", async () => {
  const { repo, done } = scratch();
  try {
    const root = repo();
    assert.throws(() => decode({ ...image, data: Buffer.from("GIF89a....").toString("base64") }), /isn't a PNG/);
    assert.throws(() => decode({ ...image, data: "not base64!" }), /base64/);

    let options: Record<string, unknown> = {};
    const sent: { message: { content: Record<string, unknown>[] } }[] = [];
    const answering = ((args: { prompt: AsyncIterable<never>; options: Record<string, unknown> }) => {
      options = args.options;
      async function* go() {
        for await (const m of args.prompt) sent.push(m);
        yield init;
        yield { type: "result", subtype: "success", is_error: false, result: "x".repeat(7000) };
      }
      return Object.assign(go(), { close() {}, accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "none" }) });
    }) as unknown as Query;
    const seen = await look(image, "why is this red?", { cwd: root }, answering);
    assert.equal(seen.observation.length, 6001, "bounded");
    assert.equal(seen.sha, createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex"));
    assert.equal(options.persistSession, false, "Claude keeps no session with the picture in it");
    assert.equal(options.resume, undefined);
    assert.deepEqual(options.tools, []);
    const [picture, words] = sent[0]!.message.content;
    assert.deepEqual(picture, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } });

    const stop = new AbortController();
    const hanging = ((args: { options: { abortController: AbortController } }) => {
      async function* go() {
        yield init;
        await new Promise((_, reject) => args.options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return Object.assign(go(), { close() {}, accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "none" }) });
    }) as unknown as Query;
    const stopped = look(image, "", { cwd: root, signal: stop.signal }, hanging);
    setTimeout(() => stop.abort(), 20);
    await assert.rejects(stopped, /stopped/);
  } finally { done(); }
});

/** A `claude` that starts and never answers, recording every process it becomes. */
function silentClaude(dir: string) {
  const bin = `${dir}/claude`;
  writeFileSync(bin, `#!/bin/sh\necho $$ >> "${dir}/pids"\nexec sleep 600\n`);
  chmodSync(bin, 0o755);
  const pids = () => (existsSync(`${dir}/pids`) ? readFileSync(`${dir}/pids`, "utf8").trim().split("\n").map(Number) : []);
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  return { bin, pids, running: () => pids().filter((p) => !gone(p)) };
}

async function withSilentClaude<T>(run: (fake: ReturnType<typeof silentClaude>) => Promise<T>): Promise<T> {
  const dir = realpathSync(mkdtempSync(`${tmpdir()}/dum-fake-claude-`));
  const before = process.env.DUM_CLAUDE_BIN;
  const fake = silentClaude(dir);
  process.env.DUM_CLAUDE_BIN = fake.bin;
  try {
    return await run(fake);
  } finally {
    for (const p of fake.running()) process.kill(p, "SIGKILL");
    if (before === undefined) delete process.env.DUM_CLAUDE_BIN;
    else process.env.DUM_CLAUDE_BIN = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

const practiceFiles = (root: string) => existsSync(`${root}/.dum/practice.json`) || existsSync(`${root}/.dum/evidence.json`);

test("Stop ends a slow :practice: its Claude process dies, nothing is saved, and the next command runs", async () => {
  const { repo, done } = scratch();
  const c = new DesktopController(() => {});
  try {
    await withSilentClaude(async (fake) => {
      const root = repo({ "main.py": "x = 1\n" });
      await c.choose(root, personal);
      await c.send(":practice recursion in python", c.inputToken);
      await until("practice's helper process started", () => fake.pids().length > 0);
      assert.ok(fake.running().length > 0);
      assert.ok(!c.canAttach, "a slow command is running");

      c.interrupt();
      await until("practice stopped", () => c.state!.transcript.some((e) => e.kind === "note" && /:practice stopped/.test(e.text)));
      await until("the helper process is gone", () => fake.running().length === 0);
      assert.equal(c.state?.status, "");
      assert.ok(!practiceFiles(root), "nothing was saved for a stopped practice");
      assert.ok(!c.state!.transcript.some((e) => e.kind === "say"), "no late result was shown");
      await until("back at what next", () => c.canAttach);

      await c.send(":remember still works", c.inputToken);
      assert.match(readFileSync(`${root}/.dum/memory.md`, "utf8"), /still works/);
    });
  } finally {
    await c.close();
    done();
  }
});

test("switching or closing during a slow :submit ends its helper before the project is let go", async () => {
  const { repo, done } = scratch();
  const c = new DesktopController(() => {});
  try {
    await withSilentClaude(async (fake) => {
      const a = repo({ "walk.py": "def walk(n):\n    return 0 if n == 0 else 1 + walk(n - 1)\n" });
      const b = repo({ "b.py": "y = 2\n" });
      skills.write(skills.unlock(skills.read(), { name: "printing", lang: "python", how: "added", level: "build", why: "test" }));
      await c.choose(a, personal);
      await c.send(":submit variables in python walk.py --unaided", c.inputToken);
      await until("the review's helper process started", () => fake.pids().length > 0);

      await c.choose(b, personal);
      assert.ok(!existsSync(`${a}/.dum/session.lock`), "its lock was let go");
      await until("the old project's helper process is gone", () => fake.running().length === 0);
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(!practiceFiles(a), "the old project recorded nothing late");
      assert.equal(skills.levelIn(skills.read(), "variables", "python"), null, "the abandoned review built nothing");

      await c.send(":submit variables in python b.py --unaided", c.inputToken);
      await until("a second helper started", () => fake.pids().length > 1);
      await c.close();
      await until("closing leaves no helper process behind", () => fake.running().length === 0);
      assert.ok(!practiceFiles(b));
    });
  } finally {
    await c.close();
    done();
  }
});

test("Stop while a course is being designed ends the helper and leaves no course behind", async () => {
  const { repo, done } = scratch();
  const c = new DesktopController(() => {});
  try {
    await withSilentClaude(async (fake) => {
      const root = repo({ "main.py": "x = 1\n" });
      skills.write(skills.unlock(skills.read(), { name: "printing", lang: "python", how: "added", level: "build", why: "test" }));
      await c.choose(root, personal);
      await c.send("course variables in python", c.inputToken);
      await until("the course designer's process started", () => fake.pids().length > 0);

      c.interrupt();
      await until("the course stopped and dum is asking what next", () => c.canAttach && c.state!.transcript.some((e) => e.kind === "note" && /course stopped/.test(e.text)));
      await until("the designer's process is gone", () => fake.running().length === 0);
      assert.ok(!existsSync(`${root}/.dum/active-course.json`), "no half-made course is saved");
      assert.ok(!existsSync(`${root}/.dum/courses`) || readdirSync(`${root}/.dum/courses`).length === 0, "no scratch file was created");
      assert.ok(!c.state!.transcript.some((e) => e.kind === "course"), "no course card was shown for the stopped design");
    });
  } finally {
    await c.close();
    done();
  }
});

test("every command the desktop prompt offers is one the desktop accepts, and the terminal's own stay terminal-only", async () => {
  const { repo, done } = scratch();
  const c = new DesktopController(() => {});
  const offered = (surface: "terminal" | "desktop") => [...new Set([...contract(surface).matchAll(/(?<![\w:])(:[a-z]+)\b/g)].map((m) => m[1]!))];
  try {
    await c.choose(repo({ "main.py": "x = 1\n" }), personal);
    const desktop = offered("desktop");
    assert.ok(desktop.length > 3);
    for (const command of desktop) {
      await until(`${command}: ready for a message`, () => !!c.inputToken);
      await c.send(command, c.inputToken).catch((err: Error) => assert.doesNotMatch(err.message, /terminal edition only/, `the desktop prompt offers ${command}`));
    }
    await until("ready", () => !!c.inputToken);
    assert.ok(offered("terminal").includes(":help"));
    await assert.rejects(c.send(":help", c.inputToken), /terminal edition only/, "the terminal prompt's :help isn't a desktop command");
    assert.ok(!desktop.includes(":help"));
  } finally {
    await c.close();
    done();
  }
});

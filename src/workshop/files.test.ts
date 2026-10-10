// Behavioral tests for the owner lock's guarded critical section, with real processes: starters
// that race over a stale owner from a shared start time, a release that meets someone else's
// record, a guard holder that dies, the real helper killed inside the guard while the parent's
// pinned descriptor stays open, a live owner, and a guard that isn't the private regular file it
// must be. Every test uses its own temporary directory outside the repository and never touches
// a real workshop home.

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { acquireOwnerLock, LockHeldError, OwnerLockBusyError, ownerGuardPath, readPrivateFile, writePrivateFile } from "./files.ts";
import { WorkshopError, WorkshopStore } from "./runtime.ts";

const dirs: string[] = [];
const children: ChildProcess[] = [];
const TSX = import.meta.resolve("tsx");
const FILES_URL = new URL("./files.ts", import.meta.url).href;
const HELPER_PATH = fileURLToPath(new URL("./owner-lock-helper.ts", import.meta.url));

/** A private temporary directory by its real path, so the store and the test name the same owner file. */
function freshDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dum-owner-lock-")));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const child of children) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A pid no process has: a child that already exited. */
function deadPid(): number {
  const done = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
  assert.equal(done.status, 0);
  assert.ok(done.pid > 0);
  return done.pid;
}

function holderOf(path: string): { pid: number; token: string } | null {
  const raw = readPrivateFile(path, 4096);
  return raw === null ? null : (JSON.parse(raw) as { pid: number; token: string });
}

type StarterReport = { ok: true; pid: number } | { ok: false; name: string; pid: number | null; message: string };

/**
 * A program that takes the owner lock the way a workshop process does, reports one JSON line, and
 * then keeps the lock until told to exit (or releases it when asked). It imports the real module.
 * In `start-at` mode it first reports that it is ready, then waits for the parent to name a start
 * time on stdin and spins until that instant before its attempt, so several starters attempt the
 * lock together rather than whenever each happened to finish loading.
 */
function starterScript(dir: string): string {
  const path = join(dir, "starter.mjs");
  writeFileSync(
    path,
    [
      `import { acquireOwnerLock } from ${JSON.stringify(FILES_URL)};`,
      "const [ownerPath, mode] = process.argv.slice(2);",
      "function attempt() {",
      "  let release;",
      "  try {",
      "    release = acquireOwnerLock(ownerPath);",
      "    process.stdout.write(JSON.stringify({ ok: true, pid: process.pid }) + '\\n');",
      "  } catch (err) {",
      "    process.stdout.write(JSON.stringify({ ok: false, name: err.name, pid: err.pid ?? null, message: err.message }) + '\\n');",
      "    process.exit(0);",
      "  }",
      "  if (mode === 'release-on-stdin-close') {",
      "    process.stdin.resume();",
      "    process.stdin.on('end', () => { release(); process.exit(0); });",
      "  } else {",
      "    setTimeout(() => process.exit(0), 60_000);",
      "  }",
      "}",
      "if (mode === 'start-at') {",
      "  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\\n');",
      "  let line = '';",
      "  process.stdin.setEncoding('utf8');",
      "  process.stdin.on('data', (chunk) => {",
      "    line += chunk;",
      "    if (!line.includes('\\n')) return;",
      "    process.stdin.pause();",
      "    const startAt = Number(line.trim());",
      "    while (Date.now() < startAt) { /* spin to the shared instant */ }",
      "    attempt();",
      "  });",
      "} else {",
      "  attempt();",
      "}",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return path;
}

type Starter = { child: ChildProcess; ready: Promise<number>; report: Promise<StarterReport> };

/** Resolve each JSON line a child prints, in order, to whoever is waiting for that kind of line. */
function startStarter(script: string, ownerPath: string, mode = "hold"): Starter {
  const child = spawn(process.execPath, ["--import", TSX, script, ownerPath, mode], { stdio: ["pipe", "pipe", "pipe"], detached: true });
  children.push(child);
  let out = "";
  let errOut = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    errOut += chunk;
  });
  let resolveReady!: (pid: number) => void;
  let resolveReport!: (report: StarterReport) => void;
  let fail!: (err: Error) => void;
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    fail = reject;
  });
  const report = new Promise<StarterReport>((resolve, reject) => {
    resolveReport = resolve;
    const previous = fail;
    fail = (err) => {
      previous(err);
      reject(err);
    };
  });
  // A starter that never enters `start-at` mode never reports ready; nobody waits on it then.
  ready.catch(() => {});
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    out += chunk;
    for (let end = out.indexOf("\n"); end !== -1; end = out.indexOf("\n")) {
      const parsed = JSON.parse(out.slice(0, end)) as { ready: true; pid: number } | StarterReport;
      out = out.slice(end + 1);
      if ("ready" in parsed) resolveReady(parsed.pid);
      else resolveReport(parsed);
    }
  });
  child.on("exit", (code, signal) => fail(new Error(`starter exited (${code ?? signal}) before reporting: ${errOut.slice(0, 500)}`)));
  child.on("error", fail);
  return { child, ready, report };
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  });
}

function guardHeld(guard: string): boolean {
  return spawnSync("flock", ["--exclusive", "--nonblock", guard, "true"], { stdio: "ignore" }).status !== 0;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------------------------

test("simultaneous starters over a stale owner: exactly one takes it, every other sees that live pid, and none removes the winner's record", async () => {
  const dir = freshDir();
  const owner = join(dir, "owner.lock");
  const stale = deadPid();
  writePrivateFile(owner, `${JSON.stringify({ pid: stale, token: "stale-token", createdAt: new Date(0).toISOString() })}\n`);
  const script = starterScript(dir);

  // Every starter is loaded and waiting before any attempts; then all attempt at one shared
  // instant, so their critical sections overlap rather than trailing each other's startup.
  const starters = Array.from({ length: 4 }, () => startStarter(script, owner, "start-at"));
  await Promise.all(starters.map((s) => s.ready));
  const startAt = Date.now() + 250;
  for (const s of starters) s.child.stdin!.write(`${startAt}\n`);
  const reports = await Promise.all(starters.map((s) => s.report));
  const winners = reports.filter((r): r is Extract<StarterReport, { ok: true }> => r.ok);
  const losers = reports.filter((r): r is Extract<StarterReport, { ok: false }> => !r.ok);
  assert.equal(winners.length, 1, `exactly one writer: ${JSON.stringify(reports)}`);
  assert.equal(losers.length, 3);
  for (const loser of losers) {
    assert.equal(loser.name, "LockHeldError");
    assert.equal(loser.pid, winners[0].pid);
  }
  // Everyone has reported, so the losers' attempts are complete: the winner's record is still the one on disk.
  const held = holderOf(owner);
  assert.ok(held);
  assert.equal(held.pid, winners[0].pid);
  assert.notEqual(held.pid, stale);
  assert.equal(lstatSync(ownerGuardPath(owner)).isFile(), true);

  // The winner dies without releasing; the next starter recovers its record, and a release removes only ours.
  await Promise.all(starters.map((s) => stop(s.child)));
  const release = acquireOwnerLock(owner);
  assert.equal(holderOf(owner)?.pid, process.pid);
  release();
  assert.equal(existsSync(owner), false);
  assert.equal(lstatSync(ownerGuardPath(owner)).isFile(), true, "the guard is never removed");
});

test("a release that finds another pid or another token in the owner record leaves it in place", () => {
  const dir = freshDir();
  const owner = join(dir, "owner.lock");

  const release = acquireOwnerLock(owner);
  const ours = holderOf(owner);
  assert.ok(ours && ours.pid === process.pid);
  // Same pid, someone else's token.
  const otherToken = { pid: process.pid, token: "not-our-token", createdAt: new Date().toISOString() };
  writePrivateFile(owner, `${JSON.stringify(otherToken)}\n`);
  release();
  assert.equal(holderOf(owner)?.pid, process.pid);
  assert.equal(holderOf(owner)?.token, "not-our-token");
  unlinkSync(owner);

  // Our token, another (live) pid.
  const again = acquireOwnerLock(owner);
  const token = holderOf(owner)!.token;
  const otherPid = { pid: 1, token, createdAt: new Date().toISOString() };
  writePrivateFile(owner, `${JSON.stringify(otherPid)}\n`);
  again();
  assert.equal(holderOf(owner)?.pid, 1);
  assert.equal(holderOf(owner)?.token, token);
  unlinkSync(owner);

  // Ours on both counts: released, and releasing twice is harmless.
  const third = acquireOwnerLock(owner);
  third();
  third();
  assert.equal(existsSync(owner), false);
});

test("a guard holder that is killed frees the kernel lock; the guard keeps its inode and a busy guard is reported as such", async () => {
  const dir = freshDir();
  const owner = join(dir, "owner.lock");
  const guard = ownerGuardPath(owner);
  acquireOwnerLock(owner)();
  const inode = statSync(guard).ino;

  // Another program holds the guard's lock through flock(1) and never lets go on its own.
  const holder = spawn("flock", ["--exclusive", guard, "sleep", "600"], { stdio: "ignore", detached: true });
  children.push(holder);
  await waitFor(() => guardHeld(guard), "the holder to take the guard");

  const started = Date.now();
  assert.throws(() => acquireOwnerLock(owner), (err: unknown) => err instanceof OwnerLockBusyError && /held its guard/.test(err.message));
  assert.ok(Date.now() - started >= 4_000, "waited for the guard rather than failing at once");
  assert.equal(existsSync(owner), false, "nothing was written without the guard");
  assert.equal(statSync(guard).ino, inode);

  await stop(holder);
  await waitFor(() => !guardHeld(guard), "the kernel to drop the dead holder's lock");
  const release = acquireOwnerLock(owner);
  assert.equal(holderOf(owner)?.pid, process.pid);
  assert.equal(statSync(guard).ino, inode, "the guard was reused, not replaced");
  release();
  assert.equal(statSync(guard).ino, inode);
  assert.equal(statSync(guard).mode & 0o777, 0o600);
});

/**
 * A module preloaded ahead of the real owner-lock helper: it reports its pid, then blocks on
 * stdin before the helper's entry runs. flock has already taken the guard by then, so the helper
 * is held deterministically inside the critical section until the test kills it.
 */
function holdScript(dir: string): string {
  const path = join(dir, "hold-before-entry.mjs");
  writeFileSync(
    path,
    [
      "import { readSync } from 'node:fs';",
      "process.stdout.write(JSON.stringify({ holding: process.pid }) + '\\n');",
      "const byte = Buffer.alloc(1);",
      "for (;;) {",
      "  try {",
      "    readSync(0, byte, 0, 1, null);",
      "    break;",
      "  } catch (err) {",
      "    if (err.code !== 'EAGAIN') throw err;",
      "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
      "  }",
      "}",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return path;
}

test("the guard's lock lives on the helper's own open file description: the real helper killed inside the guard frees it while the parent's pinned descriptor stays open", async () => {
  const dir = freshDir();
  const owner = join(dir, "owner.lock");
  const guard = ownerGuardPath(owner);
  acquireOwnerLock(owner)();
  const inode = statSync(guard).ino;

  // The invocation files.ts makes, with the guard pinned to the child's fd 3 and flock reopening
  // it by that path, except that a preload holds the real helper inside the guard until told.
  const fd = openSync(guard, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const holder = spawn(
      "flock",
      [
        "--exclusive",
        "--timeout", "5",
        "--conflict-exit-code", "75",
        "/proc/self/fd/3",
        process.execPath, "--import", TSX, "--import", pathToFileURL(holdScript(dir)).href, HELPER_PATH, "acquire", owner, String(process.pid), "held-then-killed",
      ],
      { stdio: ["pipe", "pipe", "pipe", fd], detached: true },
    );
    children.push(holder);
    let out = "";
    let errOut = "";
    holder.stdout!.setEncoding("utf8");
    holder.stderr!.setEncoding("utf8");
    holder.stderr!.on("data", (chunk: string) => {
      errOut += chunk;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => holder.once("exit", (code, signal) => resolve({ code, signal })));
    const helperPid = await new Promise<number>((resolve, reject) => {
      holder.stdout!.on("data", (chunk: string) => {
        out += chunk;
        const end = out.indexOf("\n");
        if (end !== -1) resolve((JSON.parse(out.slice(0, end)) as { holding: number }).holding);
      });
      void exited.then(({ code, signal }) => reject(new Error(`flock exited (${code ?? signal}) before the helper was held: ${errOut.slice(0, 500)}`)));
    });
    assert.notEqual(helperPid, holder.pid, "the held process is node under flock, not flock itself");
    assert.equal(guardHeld(guard), true, "the helper is inside the guard");
    assert.equal(fstatSync(fd).ino, inode, "the parent's descriptor is open while the child holds the lock");

    // Only the node helper dies; flock sees its child go and exits, and nothing else remains.
    process.kill(helperPid, "SIGKILL");
    const { code, signal } = await exited;
    assert.ok(code !== 0 && code !== 75, `flock reported the killed helper, not success or a busy guard (${code ?? signal})`);
    assert.equal(out.split("\n").filter(Boolean).length, 1, "the helper never reached its entry, so it printed no outcome");

    // The lock went with the helper's open file description, not with the parent's descriptor,
    // which is still open on the same inode. Nothing was written to the owner path.
    await waitFor(() => !guardHeld(guard), "the kernel to drop the dead helper's lock while the parent descriptor is still open");
    assert.equal(fstatSync(fd).ino, inode);
    assert.equal(statSync(guard).ino, inode);
    assert.equal(existsSync(owner), false, "nothing was written without the helper reaching its entry");

    // With the parent's descriptor still open, the same guard inode serves the next acquisition.
    const release = acquireOwnerLock(owner);
    assert.equal(holderOf(owner)?.pid, process.pid);
    assert.equal(statSync(guard).ino, inode, "the guard was reused, not replaced");
    release();
    assert.equal(existsSync(owner), false);
    assert.equal(statSync(guard).ino, inode);
  } finally {
    closeSync(fd);
  }
});

test("a live owner in another process is a LockHeldError carrying its pid, and the store turns it into a 409", async () => {
  const dir = freshDir();
  const owner = join(dir, "owner.lock");
  const script = starterScript(dir);
  const live = startStarter(script, owner, "release-on-stdin-close");
  const report = await live.report;
  assert.ok(report.ok);
  assert.equal(report.pid, live.child.pid);

  assert.throws(() => acquireOwnerLock(owner), (err: unknown) => err instanceof LockHeldError && err.pid === live.child.pid);
  assert.throws(() => new WorkshopStore(dir), (err: unknown) => err instanceof WorkshopError && err.status === 409 && err.message.includes(String(live.child.pid)));
  assert.equal(holderOf(owner)?.pid, live.child.pid, "the live record was not touched");

  // The owner releases on its way out, and the next starter takes the lock at once.
  live.child.stdin!.end();
  await new Promise<void>((resolve) => live.child.once("exit", () => resolve()));
  assert.equal(existsSync(owner), false);
  const store = new WorkshopStore(dir);
  assert.equal(holderOf(owner)?.pid, process.pid);
  store.close();
  assert.equal(existsSync(owner), false);
});

test("a guard that is a symlink or a directory is refused, never replaced, and nothing is written", () => {
  const dir = freshDir();
  const owner = join(dir, "owner.lock");
  const guard = ownerGuardPath(owner);

  const target = join(dir, "elsewhere");
  writeFileSync(target, "not a guard\n", { mode: 0o600 });
  symlinkSync(target, guard);
  assert.throws(() => acquireOwnerLock(owner), /symlink/);
  assert.equal(lstatSync(guard).isSymbolicLink(), true);
  assert.equal(readPrivateFile(target, 4096), "not a guard\n");
  assert.equal(existsSync(owner), false);
  unlinkSync(guard);

  mkdirSync(guard);
  assert.throws(() => acquireOwnerLock(owner), /directory|regular file/);
  assert.equal(lstatSync(guard).isDirectory(), true);
  assert.equal(existsSync(owner), false);
  rmSync(guard, { recursive: true });

  // With the entry gone the guard is created privately and the lock works.
  const release = acquireOwnerLock(owner);
  assert.equal(lstatSync(guard).isFile(), true);
  assert.equal(statSync(guard).mode & 0o777, 0o600);
  assert.equal(statSync(guard).nlink, 1);
  release();
  assert.equal(existsSync(owner), false);
  assert.equal(existsSync(guard), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquire } from "../src/session-lock.ts";

function scratch(): { home: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dum-lock-"));
  return { home: join(root, "home"), done: () => rmSync(root, { recursive: true, force: true }) };
}

/** A process ID that just exited on this machine. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid);
  return child.pid;
}

test("a second writer for the same home is refused while the first holds it, and can take it after release", () => {
  const { home, done } = scratch();
  try {
    const release = acquire(home);
    assert.ok(existsSync(join(home, "session.lock")));
    assert.throws(() => acquire(home), /already open/);
    assert.ok(existsSync(join(home, "session.lock")), "a refused contender leaves the holder's lock");
    release();
    assert.equal(existsSync(join(home, "session.lock")), false);
    assert.equal(existsSync(join(home, "session.lock.guard")), false);
    const again = acquire(home);
    again();
  } finally { done(); }
});

test("a lock left by a process that is gone on this machine is taken over", () => {
  const { home, done } = scratch();
  try {
    mkdirSync(home, { recursive: true });
    const pid = deadPid();
    writeFileSync(join(home, "session.lock"), JSON.stringify({ pid, host: hostname(), token: "old" }));
    const release = acquire(home);
    const now = JSON.parse(readFileSync(join(home, "session.lock"), "utf8"));
    assert.equal(now.pid, process.pid);
    assert.notEqual(now.token, "old");
    release();
  } finally { done(); }
});

test("a lock from another machine or an unreadable lock is left for a person, never swept away", () => {
  const { home, done } = scratch();
  try {
    mkdirSync(home, { recursive: true });
    const foreign = JSON.stringify({ pid: deadPid(), host: `${hostname()}-other`, token: "theirs" });
    writeFileSync(join(home, "session.lock"), foreign);
    assert.throws(() => acquire(home), /already open/);
    assert.equal(readFileSync(join(home, "session.lock"), "utf8"), foreign);
    writeFileSync(join(home, "session.lock"), "not json");
    assert.throws(() => acquire(home), /can't read/);
    assert.equal(readFileSync(join(home, "session.lock"), "utf8"), "not json");
  } finally { done(); }
});

test("releasing never removes a lock that someone else now holds", () => {
  const { home, done } = scratch();
  try {
    const release = acquire(home);
    const theirs = JSON.stringify({ pid: process.pid, host: hostname(), token: "someone-else" });
    writeFileSync(join(home, "session.lock"), theirs);
    release();
    assert.equal(readFileSync(join(home, "session.lock"), "utf8"), theirs);
  } finally { done(); }
});

test("a guard left behind refuses with how to recover instead of being taken", () => {
  const { home, done } = scratch();
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "session.lock.guard"), JSON.stringify({ pid: deadPid(), host: hostname(), token: "stale" }));
    assert.throws(() => acquire(home), /session\.lock\.guard was left.*no longer running/);
    assert.equal(existsSync(join(home, "session.lock")), false);
  } finally { done(); }
});

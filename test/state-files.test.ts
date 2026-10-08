import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, readState, statePath, writeState } from "../src/state-files.ts";

function scratch(): { root: string; home: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dum-state-"));
  return { root, home: join(root, "home"), done: () => rmSync(root, { recursive: true, force: true }) };
}

test("writes create a private home and nested directories, and an absent record reads as null", () => {
  const { home, done } = scratch();
  try {
    assert.equal(readState(home, "zones/a/context.md", 1024), null, "nothing is created by a read");
    assert.equal(existsSync(home), false);
    writeState(home, "zones/a/context.md", "notes\n");
    assert.equal(readState(home, "zones/a/context.md", 1024), "notes\n");
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, "zones", "a")).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, "zones", "a", "context.md")).mode & 0o777, 0o600);
  } finally { done(); }
});

test("a replacement is atomic: the old bytes are swapped whole and no temp file is left", () => {
  const { home, done } = scratch();
  try {
    writeState(home, "zones.json", "{\"a\":1}\n");
    const before = lstatSync(join(home, "zones.json")).ino;
    writeState(home, "zones.json", "{\"a\":2}\n");
    assert.equal(readFileSync(join(home, "zones.json"), "utf8"), "{\"a\":2}\n");
    assert.notEqual(lstatSync(join(home, "zones.json")).ino, before, "renamed over, not rewritten in place");
    assert.deepEqual(readdirSync(home), ["zones.json"]);
  } finally { done(); }
});

test("create never replaces an existing record", () => {
  const { home, done } = scratch();
  try {
    assert.equal(createState(home, "session.lock", "first\n"), true);
    assert.equal(createState(home, "session.lock", "second\n"), false);
    assert.equal(readFileSync(join(home, "session.lock"), "utf8"), "first\n");
    assert.deepEqual(readdirSync(home), ["session.lock"]);
  } finally { done(); }
});

test("a symlinked record is refused on read, write and create, and its target is untouched", () => {
  const { root, home, done } = scratch();
  try {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "token=abc");
    mkdirSync(home);
    symlinkSync(secret, join(home, "memory.md"));
    assert.throws(() => readState(home, "memory.md", 1024), /symlink/);
    assert.throws(() => writeState(home, "memory.md", "x"), /symlink/);
    assert.throws(() => createState(home, "memory.md", "x"), /symlink/);
    assert.throws(() => statePath(home, "memory.md"), /symlink/);
    assert.equal(readFileSync(secret, "utf8"), "token=abc");
  } finally { done(); }
});

test("a symlinked home or zone directory is refused, never followed", () => {
  const { root, home, done } = scratch();
  try {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(join(elsewhere, "zones"), { recursive: true });
    writeFileSync(join(elsewhere, "zones.json"), "{}");
    symlinkSync(elsewhere, home);
    assert.throws(() => readState(home, "zones.json", 1024), /symlink/);
    assert.throws(() => writeState(home, "zones.json", "x"), /symlink/);
    assert.equal(readFileSync(join(elsewhere, "zones.json"), "utf8"), "{}");

    const real = join(root, "real");
    mkdirSync(join(real, "zones"), { recursive: true });
    symlinkSync(join(elsewhere, "zones"), join(real, "zones", "z1"));
    assert.throws(() => readState(real, "zones/z1/memory.md", 1024), /symlink/);
    assert.throws(() => writeState(real, "zones/z1/memory.md", "x"), /symlink/);
    assert.deepEqual(readdirSync(join(elsewhere, "zones")), []);
  } finally { done(); }
});

test("an oversized record throws with its size and stays exactly as it was", () => {
  const { home, done } = scratch();
  try {
    writeState(home, "transcript.json", "x".repeat(4096));
    assert.throws(() => readState(home, "transcript.json", 1024), /4 KiB/);
    assert.equal(readFileSync(join(home, "transcript.json"), "utf8").length, 4096);
  } finally { done(); }
});

test("record names can't climb out of the base or name a non-file", () => {
  const { home, done } = scratch();
  try {
    for (const bad of ["", "../x", "a/../b", "/etc/passwd", "a//b", "a\\b", "./a"]) {
      assert.throws(() => writeState(home, bad, "x"), /isn't a private record name/, bad);
      assert.throws(() => readState(home, bad, 10), /isn't a private record name/, bad);
    }
    mkdirSync(join(home, "dir"), { recursive: true });
    assert.throws(() => readState(home, "dir", 10), /isn't a regular file/);
  } finally { done(); }
});

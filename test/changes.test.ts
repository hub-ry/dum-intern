// Direct changes: written on command only when every named skill is held (rule 1), only over the
// bytes the model read (rule 7), with the diff after and a revert that respects later edits (rule 6).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { change, listChanges, revertChange, type ChangeDeps } from "../src/changes.ts";
import { SharedFiles, sha } from "../src/shared-files.ts";
import { Follows } from "../src/follow.ts";
import { unlock, id, type Tree } from "../src/skills.ts";
import type { RequestBinding, Resources } from "../src/share-types.ts";

const H = mkdtempSync(join(tmpdir(), "dum-changes-home-"));
process.env.DUM_HOME = H;
process.env.DUM_CONTEXT = "off";

const built = (names: string[], t: Tree = { skills: [] }) =>
  names.reduce((tree, name) => unlock(tree, { name, lang: "python", how: "added", level: "build", why: "" }), t);
const basics = built(["printing", "variables", "functions", "conditionals", "return values"]);
const withRecursion = built(["recursion"], basics);
const RECURSION = [{ name: "recursion", lang: "python" }];
const ORIGINAL = "def walk(n):\n    return n\n";
const NEXT = "def walk(n):\n    return walk(n - 1) if n else 0\n";

async function setup(tree: Tree = withRecursion, held: ReadonlySet<string> = new Set()) {
  const root = mkdtempSync(join(tmpdir(), "dum-change-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/walk.py"), ORIGINAL);
  writeFileSync(join(root, "single.py"), "x = 1\n");
  const zoneId = randomUUID();
  const binding: RequestBinding = { zoneId, zoneEpoch: "epoch-1", inputToken: "token-1", requestId: randomUUID() };
  const shares = new SharedFiles(binding, null);
  const folder = await shares.grant(root, "folder");
  const single = await shares.grant(join(root, "single.py"), "file");
  shares.activate();
  const deps: ChangeDeps = { home: H, resources: shares, tree, held, mode: "understand" };
  const walk = `${folder.id}/src/walk.py`;
  const changesDir = join(H, "zones", zoneId, "changes");
  return { root, zoneId, binding, shares, deps, folder, single, walk, changesDir, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a held skill writes the file directly, keeps before/after/patch, and returns the diff", async () => {
  const s = await setup();
  try {
    chmodSync(join(s.root, "src/walk.py"), 0o640);
    const read = await s.shares.file(s.walk);
    const receipt = await change(s.deps, s.zoneId, s.binding, s.walk, read.sha, NEXT, RECURSION);
    assert.equal(readFileSync(join(s.root, "src/walk.py"), "utf8"), NEXT, "written, with no yes/no step");
    assert.equal(statSync(join(s.root, "src/walk.py")).mode & 0o777, 0o640, "permissions kept");
    assert.equal(receipt.target, s.walk);
    assert.equal(receipt.baseSha, read.sha);
    assert.equal(receipt.nextSha, sha(NEXT));
    assert.equal(receipt.revertible, true);
    assert.match(receipt.diff, /^-    return n$/m);
    assert.match(receipt.diff, /^\+    return walk\(n - 1\) if n else 0$/m);
    const dir = join(s.changesDir, receipt.id);
    assert.deepEqual(readdirSync(dir).sort(), ["after", "before", "change.json", "change.patch", "path"]);
    assert.equal(readFileSync(join(dir, "before"), "utf8"), ORIGINAL);
    assert.equal(readFileSync(join(dir, "after"), "utf8"), NEXT);
    assert.equal(statSync(join(dir, "change.json")).mode & 0o777, 0o600);
    const [manifest] = listChanges(H, s.zoneId);
    assert.deepEqual(manifest, {
      version: 1, id: receipt.id, zoneId: s.zoneId, requestId: s.binding.requestId, createdAt: receipt.appliedAt,
      target: s.walk, baseSha: read.sha, nextSha: sha(NEXT), skills: RECURSION, revertedAt: null,
    });
    assert.ok(!JSON.stringify(manifest).includes(s.root), "the absolute path stays out of the manifest");
    assert.deepEqual(readdirSync(join(s.root, "src")), ["walk.py"], "no temp files left behind");
  } finally { s.done(); }
});

test("a locked concept, a 'not yet' or another language is refused and nothing is written", async () => {
  for (const [label, tree, held, path] of [
    ["locked", basics, new Set<string>(), "src/walk.py"],
    ["held", withRecursion, new Set([id("recursion", "python")]), "src/walk.py"],
    ["lost prerequisite", { skills: withRecursion.skills.filter((x) => x.name !== "return values") }, new Set<string>(), "src/walk.py"],
  ] as const) {
    const s = await setup(tree, held);
    try {
      const read = await s.shares.file(`${s.folder.id}/${path}`);
      await assert.rejects(change(s.deps, s.zoneId, s.binding, `${s.folder.id}/${path}`, read.sha, NEXT, RECURSION), /nothing written/, label);
      assert.equal(readFileSync(join(s.root, path), "utf8"), ORIGINAL, label);
      assert.equal(existsSync(s.changesDir), false, `${label}: no change record`);
    } finally { s.done(); }
  }
  const s = await setup();
  try {
    await assert.rejects(change(s.deps, s.zoneId, s.binding, `${s.folder.id}/src/walk.rs`, null, "fn walk() {}\n", RECURSION), /locked|isn't theirs/);
    assert.equal(existsSync(join(s.root, "src/walk.rs")), false, "python recursion doesn't write rust");
    await assert.rejects(change(s.deps, s.zoneId, s.binding, s.walk, sha(ORIGINAL), NEXT, []), /name the skills/);
    assert.equal(readFileSync(join(s.root, "src/walk.py"), "utf8"), ORIGINAL);
  } finally { s.done(); }
});

test("a SHA that isn't the current bytes is refused, and an editor save after the read keeps the user's bytes", async () => {
  const s = await setup();
  try {
    await assert.rejects(change(s.deps, s.zoneId, s.binding, s.walk, sha("something else"), NEXT, RECURSION), /changed since Dum read it/);
    await assert.rejects(change(s.deps, s.zoneId, s.binding, s.walk, null, NEXT, RECURSION), /already exists/);
    const read = await s.shares.file(s.walk);
    writeFileSync(join(s.root, "src/walk.py"), "def walk(n):\n    return 'yours'\n");
    await assert.rejects(change(s.deps, s.zoneId, s.binding, s.walk, read.sha, NEXT, RECURSION), /changed since Dum read it/);
    assert.equal(readFileSync(join(s.root, "src/walk.py"), "utf8"), "def walk(n):\n    return 'yours'\n");
    assert.equal(existsSync(s.changesDir), false);
  } finally { s.done(); }
});

test("an editor save landing while Dum writes wins: the last look before the rename refuses", async () => {
  const s = await setup();
  try {
    const read = await s.shares.file(s.walk);
    // The user saves right after Dum re-read the file for the change.
    const racing: Resources = {
      list: () => s.shares.list(),
      read: (p, a, b) => s.shares.read(p, a, b),
      target: (p) => s.shares.target(p),
      file: async (p) => {
        const snap = await s.shares.file(p);
        writeFileSync(join(s.root, "src/walk.py"), "def walk(n):\n    return 'saved meanwhile'\n");
        return snap;
      },
    };
    await assert.rejects(change({ ...s.deps, resources: racing }, s.zoneId, s.binding, s.walk, read.sha, NEXT, RECURSION), /changed while Dum was writing it/);
    assert.equal(readFileSync(join(s.root, "src/walk.py"), "utf8"), "def walk(n):\n    return 'saved meanwhile'\n");
    assert.deepEqual(listChanges(H, s.zoneId), [], "a change that never landed leaves no record");
    assert.deepEqual(readdirSync(join(s.root, "src")), ["walk.py"]);
  } finally { s.done(); }
});

test("new files only under a folder grant, never over a file that appeared meanwhile", async () => {
  const s = await setup();
  try {
    const target = `${s.folder.id}/src/util/helpers.py`;
    const receipt = await change(s.deps, s.zoneId, s.binding, target, null, "def helper():\n    pass\n", RECURSION);
    assert.equal(readFileSync(join(s.root, "src/util/helpers.py"), "utf8"), "def helper():\n    pass\n");
    assert.match(receipt.diff, /^new file mode 100644$/m);
    assert.equal(receipt.revertible, true);
    assert.equal((await s.shares.file(target)).text, "def helper():\n    pass\n", "the new file is readable through its grant");

    await assert.rejects(change(s.deps, s.zoneId, s.binding, `${s.single.id}/other.py`, null, "x = 2\n", RECURSION), /only in a shared folder/);
    await assert.rejects(change(s.deps, s.zoneId, s.binding, `${randomUUID()}/x.py`, null, "x = 2\n", RECURSION), /isn't shared/);
    await assert.rejects(change(s.deps, s.zoneId, s.binding, `${s.folder.id}/.env`, null, "X=1\n", RECURSION), /hidden/);
    await assert.rejects(change(s.deps, s.zoneId, s.binding, "../escape.py", null, "x\n", RECURSION), /isn't a shared file/);
    assert.equal(existsSync(join(s.root, "other.py")), false);

    const racing: Resources = {
      list: () => s.shares.list(),
      read: (p, a, b) => s.shares.read(p, a, b),
      file: (p) => s.shares.file(p),
      target: async (p) => {
        const t = await s.shares.target(p);
        writeFileSync(t.absolute, "your version\n");
        return t;
      },
    };
    await assert.rejects(change({ ...s.deps, resources: racing }, s.zoneId, s.binding, `${s.folder.id}/src/race.py`, null, "dum's version\n", RECURSION), /appeared while Dum was creating it/);
    assert.equal(readFileSync(join(s.root, "src/race.py"), "utf8"), "your version\n");
    assert.equal(listChanges(H, s.zoneId).length, 1);
  } finally { s.done(); }
});

test("a symlink planted at the target or on the way is never written through", async () => {
  const s = await setup();
  const away = mkdtempSync(join(tmpdir(), "dum-away-"));
  try {
    writeFileSync(join(away, "secret.py"), "outside = True\n");
    const read = await s.shares.file(s.walk);
    rmSync(join(s.root, "src/walk.py"));
    symlinkSync(join(away, "secret.py"), join(s.root, "src/walk.py"));
    await assert.rejects(change(s.deps, s.zoneId, s.binding, s.walk, read.sha, NEXT, RECURSION), /symlink/);
    symlinkSync(away, join(s.root, "out"));
    await assert.rejects(change(s.deps, s.zoneId, s.binding, `${s.folder.id}/out/planted.py`, null, "x\n", RECURSION), /symlink/);
    assert.equal(readFileSync(join(away, "secret.py"), "utf8"), "outside = True\n");
    assert.equal(existsSync(join(away, "planted.py")), false);
  } finally {
    s.done();
    rmSync(away, { recursive: true, force: true });
  }
});

test("revert restores the earlier bytes after the request ended, once, and only over Dum's bytes", async () => {
  const s = await setup();
  try {
    const read = await s.shares.file(s.walk);
    const made = await change(s.deps, s.zoneId, s.binding, s.walk, read.sha, NEXT, RECURSION);
    s.shares.revoke();
    const ui = { ...s.binding, inputToken: "token-2", requestId: "request-2" };
    await assert.rejects(revertChange(H, randomUUID(), { ...ui, zoneId: null }, made.id), /another zone/);
    const reverted = await revertChange(H, s.zoneId, ui, made.id);
    assert.equal(readFileSync(join(s.root, "src/walk.py"), "utf8"), ORIGINAL);
    assert.equal(reverted.revertible, false);
    assert.match(reverted.diff, /^\+    return n$/m);
    assert.ok(listChanges(H, s.zoneId)[0]!.revertedAt);
    await assert.rejects(revertChange(H, s.zoneId, ui, made.id), /already reverted/);
  } finally { s.done(); }
});

test("revert after a user edit is refused and keeps their edit; revert of a new file removes it", async () => {
  const s = await setup();
  try {
    const read = await s.shares.file(s.walk);
    const made = await change(s.deps, s.zoneId, s.binding, s.walk, read.sha, NEXT, RECURSION);
    writeFileSync(join(s.root, "src/walk.py"), "def walk(n):\n    return 'edited after'\n");
    await assert.rejects(revertChange(H, s.zoneId, s.binding, made.id), /changed since Dum wrote it/);
    assert.equal(readFileSync(join(s.root, "src/walk.py"), "utf8"), "def walk(n):\n    return 'edited after'\n");
    assert.equal(listChanges(H, s.zoneId)[0]!.revertedAt, null);

    const created = await change(s.deps, s.zoneId, s.binding, `${s.folder.id}/src/fresh.py`, null, "fresh = 1\n", RECURSION);
    await revertChange(H, s.zoneId, s.binding, created.id);
    assert.equal(existsSync(join(s.root, "src/fresh.py")), false);
    assert.deepEqual(listChanges(H, s.zoneId).map((m) => m.id).sort(), [made.id, created.id].sort());
    await assert.rejects(revertChange(H, s.zoneId, s.binding, randomUUID()), /no such change/);
  } finally { s.done(); }
});

test("changes in a followed folder become the last bytes Dum read, so the look doesn't flag them", async () => {
  const root = mkdtempSync(join(tmpdir(), "dum-followed-"));
  try {
    writeFileSync(join(root, "walk.py"), ORIGINAL);
    const zoneId = randomUUID();
    const binding: RequestBinding = { zoneId, zoneEpoch: "epoch-1", inputToken: "token-1", requestId: randomUUID() };
    const follows = new Follows(H, zoneId);
    const { id: fid } = await follows.add(root);
    const shares = new SharedFiles(binding, follows);
    const deps: ChangeDeps = { home: H, resources: shares, tree: withRecursion, held: new Set(), mode: "understand" };
    await change(deps, zoneId, binding, `${fid}/walk.py`, sha(ORIGINAL), NEXT, RECURSION);
    await change(deps, zoneId, binding, `${fid}/more.py`, null, "more = 1\n", RECURSION);
    assert.equal(readFileSync(join(root, "walk.py"), "utf8"), NEXT);
    const signals = [];
    for (let i = 0; i < 5; i++) signals.push(...(await follows.scan()));
    assert.deepEqual(signals, []);
    assert.deepEqual(follows.resources().list().sort(), [`${fid}/more.py`, `${fid}/walk.py`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a damaged change record is reported, not skipped or reset", async () => {
  const s = await setup();
  try {
    const read = await s.shares.file(s.walk);
    const made = await change(s.deps, s.zoneId, s.binding, s.walk, read.sha, NEXT, RECURSION);
    writeFileSync(join(s.changesDir, made.id, "change.json"), "{broken");
    assert.throws(() => listChanges(H, s.zoneId), /damaged/);
    await assert.rejects(revertChange(H, s.zoneId, s.binding, made.id), /damaged/);
    assert.equal(readFileSync(join(s.changesDir, made.id, "change.json"), "utf8"), "{broken");
    assert.equal(readFileSync(join(s.root, "src/walk.py"), "utf8"), NEXT);
  } finally { s.done(); }
});

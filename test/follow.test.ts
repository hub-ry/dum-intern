// Followed folders: a per-zone read grant the look scans every tick. A change is bytes that differ
// from what Dum last read; the same bytes saved again are not a change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Follows } from "../src/follow.ts";
import { sha } from "../src/shared-files.ts";
import { LOOK, type FileSignal } from "../src/observe-types.ts";
import { SHARE_LIMITS } from "../src/share-types.ts";

// Resolved, so expected paths match what Dum reports where tmpdir is a symlink (macOS: /var → /private/var).
const TMP = realpathSync(tmpdir());
const H = mkdtempSync(join(TMP, "dum-follow-home-"));
process.env.DUM_HOME = H;
process.env.DUM_CONTEXT = "off";

function folder() {
  const root = mkdtempSync(join(TMP, "dum-followed-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/main.py"), "def main():\n    return 1\n");
  writeFileSync(join(root, "notes.md"), "notes\n");
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** Scan until the next re-list tick, collecting every signal on the way. */
async function untilRelist(f: Follows): Promise<FileSignal[][]> {
  const ticks: FileSignal[][] = [];
  for (let i = 0; i < LOOK.relistEvery; i++) ticks.push(await f.scan());
  return ticks;
}

test("a followed folder persists per zone under H and lists its text files by follow id", async () => {
  const p = folder();
  try {
    const zone = randomUUID();
    const follows = new Follows(H, zone);
    const grant = await follows.add(p.root);
    assert.equal(grant.zoneId, zone);
    assert.equal(grant.files, 2);
    assert.deepEqual(follows.resources().list().sort(), [`${grant.id}/notes.md`, `${grant.id}/src/main.py`]);
    const stored = JSON.parse(readFileSync(join(H, "zones", zone, "follows.json"), "utf8"));
    assert.equal(stored.follows[0].root, p.root, "the absolute path stays in the host's private record");
    const again = new Follows(H, zone);
    assert.deepEqual(again.list(), follows.list());
    assert.deepEqual(new Follows(H, randomUUID()).list(), [], "another zone follows nothing");
    assert.deepEqual(await follows.add(p.root), grant, "following the same folder twice is one follow");
    follows.remove(grant.id);
    assert.deepEqual(new Follows(H, zone).list(), []);
  } finally { p.done(); }
});

test("saved, identical re-save and removed: only real byte changes signal", async () => {
  const p = folder();
  try {
    const follows = new Follows(H, randomUUID());
    const { id } = await follows.add(p.root);
    assert.deepEqual(await follows.scan(), []);
    writeFileSync(join(p.root, "src/main.py"), "def main():\n    return 1\n");
    utimesSync(join(p.root, "src/main.py"), new Date(), new Date(Date.now() + 5000));
    assert.deepEqual(await follows.scan(), [], "the same bytes saved again are not a change");
    writeFileSync(join(p.root, "src/main.py"), "def main():\n    return 2\n");
    const next = sha("def main():\n    return 2\n");
    assert.deepEqual(await follows.scan(), [{ path: `${id}/src/main.py`, kind: "saved", sha: next }]);
    assert.deepEqual(await follows.scan(), [], "one save signals once");
    rmSync(join(p.root, "notes.md"));
    assert.deepEqual(await follows.scan(), [{ path: `${id}/notes.md`, kind: "removed", sha: null }]);
    assert.equal(follows.list()[0]!.files, 1);
  } finally { p.done(); }
});

test("new files appear only on the re-list tick, under the deny policy", async () => {
  const p = folder();
  try {
    const follows = new Follows(H, randomUUID());
    const { id } = await follows.add(p.root);
    writeFileSync(join(p.root, "src/added.py"), "print('new')\n");
    writeFileSync(join(p.root, ".env"), "TOKEN=leaked\n");
    writeFileSync(join(p.root, "server.key"), "secret\n");
    mkdirSync(join(p.root, "node_modules/x"), { recursive: true });
    writeFileSync(join(p.root, "node_modules/x/index.js"), "x\n");
    writeFileSync(join(p.root, "image.bin"), Buffer.from([1, 0, 2]));
    symlinkSync(join(p.root, "notes.md"), join(p.root, "alias.md"));
    const ticks = await untilRelist(follows);
    assert.deepEqual(ticks.slice(0, -1).flat(), [], "nothing new before the re-list");
    assert.deepEqual(ticks.at(-1), [{ path: `${id}/src/added.py`, kind: "new", sha: sha("print('new')\n") }]);
    assert.deepEqual(follows.resources().list().sort(), [`${id}/notes.md`, `${id}/src/added.py`, `${id}/src/main.py`]);
    writeFileSync(join(p.root, ".env"), "TOKEN=changed\n");
    assert.deepEqual((await untilRelist(follows)).flat(), [], "a secret's change is never seen");
  } finally { p.done(); }
});

test("diffs are bounded and measured against the last bytes Dum read", async () => {
  const p = folder();
  try {
    const follows = new Follows(H, randomUUID());
    const { id } = await follows.add(p.root);
    writeFileSync(join(p.root, "src/main.py"), "def main():\n    return 2\n");
    const saved = await follows.scan();
    const [d] = await follows.diff(saved);
    assert.equal(d!.path, `${id}/src/main.py`);
    assert.match(d!.diff, /^-    return 1$/m);
    assert.match(d!.diff, /^\+    return 2$/m);
    assert.deepEqual(await follows.diff(saved), [], "what Dum read is the new baseline");

    writeFileSync(join(p.root, "src/main.py"), Array.from({ length: 400 }, (_, i) => `x${i}`).join("\n") + "\n");
    const [big] = await follows.diff(await follows.scan());
    assert.ok(big!.diff.split("\n").length <= 121);
    assert.match(big!.diff, /more lines/);

    rmSync(join(p.root, "notes.md"));
    const [gone] = await follows.diff(await follows.scan());
    assert.match(gone!.diff, /^deleted file mode/m);
    assert.match(gone!.diff, /^-notes$/m);
  } finally { p.done(); }
});

test("a file the model read after a save is not a change any more", async () => {
  const p = folder();
  try {
    const follows = new Follows(H, randomUUID());
    const { id } = await follows.add(p.root);
    writeFileSync(join(p.root, "src/main.py"), "def main():\n    return 3\n");
    const snap = await follows.resources().file(`${id}/src/main.py`);
    assert.equal(snap.text, "def main():\n    return 3\n");
    assert.deepEqual(await follows.scan(), []);
  } finally { p.done(); }
});

test("adding refuses home, symlinks, files, over-limit folders and a ninth folder", async () => {
  const p = folder();
  const wide = mkdtempSync(join(TMP, "dum-wide-"));
  try {
    const follows = new Follows(H, randomUUID());
    await assert.rejects(follows.add(homedir()), /home directory/);
    symlinkSync(p.root, `${p.root}-link`);
    try {
      await assert.rejects(follows.add(`${p.root}-link`), /symlink/);
    } finally { rmSync(`${p.root}-link`); }
    await assert.rejects(follows.add(join(p.root, "notes.md")), /isn't a folder/);
    for (let i = 0; i <= SHARE_LIMITS.files; i++) writeFileSync(join(wide, `f${i}.txt`), "x\n");
    await assert.rejects(follows.add(wide), /more than 2000 files/);
    await assert.rejects(follows.add(join(p.root, "src")).then(() => follows.add(p.root)), /overlaps/);
    const roots = Array.from({ length: 8 }, () => mkdtempSync(join(TMP, "dum-root-")));
    try {
      const many = new Follows(H, randomUUID());
      for (const r of roots) await many.add(r);
      await assert.rejects(many.add(p.root), /at most 8/);
    } finally { for (const r of roots) rmSync(r, { recursive: true, force: true }); }
    assert.deepEqual(follows.list().length, 1);
  } finally {
    p.done();
    rmSync(wide, { recursive: true, force: true });
  }
});

test("a folder that grows over the limits rests instead of being followed in part", async () => {
  const p = folder();
  try {
    const follows = new Follows(H, randomUUID());
    await follows.add(p.root);
    for (let i = 0; i <= SHARE_LIMITS.files; i++) writeFileSync(join(p.root, `f${i}.txt`), "x\n");
    assert.deepEqual((await untilRelist(follows)).flat(), []);
    assert.equal(follows.list()[0]!.files, 0);
    assert.deepEqual(follows.resources().list(), []);
    for (let i = 0; i <= SHARE_LIMITS.files; i++) rmSync(join(p.root, `f${i}.txt`));
    assert.deepEqual(await follows.scan(), [], "back under the limits it starts again without signals");
    assert.equal(follows.list()[0]!.files, 2);
  } finally { p.done(); }
});

test("a followed folder replaced by a symlink stops being followed, and the record says so", async () => {
  const p = folder();
  const away = mkdtempSync(join(TMP, "dum-away-"));
  try {
    const zone = randomUUID();
    const follows = new Follows(H, zone);
    await follows.add(p.root);
    renameSync(p.root, `${p.root}-old`);
    symlinkSync(away, p.root);
    try {
      assert.deepEqual(await follows.scan(), []);
      assert.deepEqual(follows.list(), []);
      assert.deepEqual(new Follows(H, zone).list(), []);
    } finally {
      rmSync(p.root);
      renameSync(`${p.root}-old`, p.root);
    }
  } finally {
    p.done();
    rmSync(away, { recursive: true, force: true });
  }
});

test("a missing folder pauses without removal signals; a damaged record is left intact", async () => {
  const p = folder();
  try {
    const zone = randomUUID();
    const follows = new Follows(H, zone);
    await follows.add(p.root);
    renameSync(p.root, `${p.root}-away`);
    try {
      assert.deepEqual(await follows.scan(), [], "an unmounted folder isn't every file deleted");
      assert.equal(follows.list().length, 1);
    } finally { renameSync(`${p.root}-away`, p.root); }
    assert.deepEqual(await follows.scan(), []);
    assert.equal(follows.list()[0]!.files, 2);

    const broken = randomUUID();
    mkdirSync(join(H, "zones", broken), { recursive: true });
    writeFileSync(join(H, "zones", broken, "follows.json"), "{not json");
    assert.throws(() => new Follows(H, broken), /damaged/);
    assert.equal(readFileSync(join(H, "zones", broken, "follows.json"), "utf8"), "{not json");
    assert.ok(existsSync(join(H, "zones", broken, "follows.json")));
  } finally { p.done(); }
});

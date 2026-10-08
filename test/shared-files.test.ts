// Explicit shares: the chosen file or folder only, under the deny policy, bounded, revalidated on
// every read, and gone when the request ends. No Git anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SharedFiles, sha, unifiedDiff } from "../src/shared-files.ts";
import { Follows } from "../src/follow.ts";
import { SHARE_LIMITS, type RequestBinding } from "../src/share-types.ts";

const H = mkdtempSync(join(tmpdir(), "dum-shares-home-"));
process.env.DUM_HOME = H;
process.env.DUM_CONTEXT = "off";

const binding = (): RequestBinding => ({ zoneId: randomUUID(), zoneEpoch: "epoch-1", inputToken: "token-1", requestId: "request-1" });

/** A project folder with source, secrets, caches, a binary and an outside secret to leak. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "dum-share-"));
  const away = mkdtempSync(join(tmpdir(), "dum-away-"));
  const put = (rel: string, body: string | Buffer, base = root) => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), body);
  };
  put("src/main.py", "def main():\n    return 1\n");
  put("README.md", "# demo\n");
  put(".env", "TOKEN=hunter2\n");
  put("id_ed25519", "key\n");
  put("certs/server.pem", "-----BEGIN-----\n");
  put(".git/config", "[core]\n");
  put("node_modules/x/index.js", "module.exports = 1\n");
  put("dist/out.js", "built\n");
  put("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  put("secret.txt", "outside secret\n", away);
  symlinkSync(join(away, "secret.txt"), join(root, "src/leak.txt"));
  symlinkSync(away, join(root, "linked"));
  return { root, away, put, done: () => { rmSync(root, { recursive: true, force: true }); rmSync(away, { recursive: true, force: true }); } };
}

test("a folder share exposes only its enumerated allowlist: no secrets, hidden, caches or symlinks", async () => {
  const p = project();
  try {
    const shares = new SharedFiles(binding(), null);
    const grant = await shares.grant(p.root, "folder");
    assert.equal(grant.scope, "request");
    assert.equal(grant.kind, "folder");
    const names = grant.files.map((f) => f.slice(grant.id.length + 1));
    assert.deepEqual(names.sort(), ["README.md", "logo.png", "src/main.py"]);
    assert.ok(grant.files.every((f) => f.startsWith(`${grant.id}/`)));
    assert.deepEqual(shares.list().sort(), grant.files.sort());
    await assert.rejects(shares.file(`${grant.id}/logo.png`), /binary/);
    for (const rel of [".env", "id_ed25519", "certs/server.pem", ".git/config", "node_modules/x/index.js", "src/leak.txt", "linked/secret.txt"]) {
      await assert.rejects(shares.file(`${grant.id}/${rel}`), /isn't a file you shared|isn't a shared file name/, rel);
    }
    await assert.rejects(shares.file(`${grant.id}/../${p.away.split("/").pop()}/secret.txt`), /isn't a shared file name/);
    await assert.rejects(shares.file(`${randomUUID()}/src/main.py`), /isn't shared with this request/);
  } finally { p.done(); }
});

test("a file share exposes only <id>/<basename>, read whole with the digest of the full bytes", async () => {
  const p = project();
  try {
    const shares = new SharedFiles(binding(), null);
    const grant = await shares.grant(join(p.root, "src/main.py"), "file");
    assert.deepEqual(grant.files, [`${grant.id}/main.py`]);
    const snap = await shares.file(`${grant.id}/main.py`);
    assert.equal(snap.text, "def main():\n    return 1\n");
    assert.equal(snap.sha, sha("def main():\n    return 1\n"));
    assert.equal(snap.complete, true);
    assert.equal(snap.sourcePath, join(p.root, "src/main.py"));
    await assert.rejects(shares.file(`${grant.id}/README.md`), /isn't a file you shared/);
  } finally { p.done(); }
});

test("chosen roots are refused for home, its ancestors, system, private, credential, hidden and symlinked paths", async () => {
  const p = project();
  try {
    const shares = new SharedFiles(binding(), null);
    await assert.rejects(shares.grant("/", "folder"), /whole disk/);
    await assert.rejects(shares.grant(homedir(), "folder"), /home directory/);
    await assert.rejects(shares.grant(dirname(homedir()), "folder"), /home directory/);
    await assert.rejects(shares.grant("/proc/self/status", "file"), /system files/);
    await assert.rejects(shares.grant("src/main.py", "file"), /choose a file or folder/);
    await assert.rejects(shares.grant(join(p.root, ".env"), "file"), /hidden|credentials/);
    await assert.rejects(shares.grant(join(p.root, "id_ed25519"), "file"), /credentials/);
    await assert.rejects(shares.grant(join(p.root, "node_modules"), "folder"), /build output/);
    await assert.rejects(shares.grant(join(p.root, "src/leak.txt"), "file"), /symlink/);
    await assert.rejects(shares.grant(join(p.root, "linked"), "folder"), /symlink/);
    await assert.rejects(shares.grant(join(p.root, "logo.png"), "file"), /binary/);
    p.put("big.py", "x".repeat(SHARE_LIMITS.fileBytes + 1));
    await assert.rejects(shares.grant(join(p.root, "big.py"), "file"), /KiB/);
    p.put("latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await assert.rejects(shares.grant(join(p.root, "latin1.txt"), "file"), /UTF-8/);
    await assert.rejects(shares.grant(join(p.root, "src"), "file"), /isn't a regular file/);
    await assert.rejects(shares.grant(join(p.root, "src/main.py"), "folder"), /isn't a folder/);
    for (const file of [".ssh/config", ".config/github-copilot/hosts.json", "gcloud/creds.txt"]) {
      p.put(file, "token\n", p.away);
      await assert.rejects(shares.grant(join(p.away, file), "file"), /credentials|hidden/, file);
    }
    // Dum's own home holds your tree, zones and settings.
    mkdirSync(join(H, "zones"), { recursive: true });
    writeFileSync(join(H, "web.json"), "{\"edit\":\"https://example.com/private\"}\n");
    await assert.rejects(shares.grant(join(H, "web.json"), "file"), /private state/);
    await assert.rejects(shares.grant(join(H, "zones"), "folder"), /private state/);
    assert.deepEqual(shares.list(), [], "nothing refused was granted");
  } finally { p.done(); }
});

test("an over-limit folder is refused whole, not silently cut short", async () => {
  const wide = mkdtempSync(join(tmpdir(), "dum-wide-"));
  const deep = mkdtempSync(join(tmpdir(), "dum-deep-"));
  try {
    for (let i = 0; i <= SHARE_LIMITS.files; i++) writeFileSync(join(wide, `f${i}.txt`), "x\n");
    const shares = new SharedFiles(binding(), null);
    await assert.rejects(shares.grant(wide, "folder"), /more than 2000 files/);
    const nested = join(deep, ...Array.from({ length: SHARE_LIMITS.depth }, (_, i) => `d${i}`));
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "too-deep.txt"), "x\n");
    await assert.rejects(shares.grant(deep, "folder"), /deeper than 16/);
    rmSync(join(nested, "too-deep.txt"));
    writeFileSync(join(dirname(nested), "ok.txt"), "x\n");
    const ok = await shares.grant(deep, "folder");
    assert.equal(ok.files.length, 1);
    const roots = Array.from({ length: 8 }, () => mkdtempSync(join(tmpdir(), "dum-root-")));
    try {
      const many = new SharedFiles(binding(), null);
      for (const r of roots) await many.grant(r, "folder");
      await assert.rejects(many.grant(deep, "folder"), /at most 8/);
    } finally { for (const r of roots) rmSync(r, { recursive: true, force: true }); }
  } finally {
    rmSync(wide, { recursive: true, force: true });
    rmSync(deep, { recursive: true, force: true });
  }
});

test("reads are bounded to 120 lines with the whole file's SHA, and a later sibling isn't granted", async () => {
  const p = project();
  try {
    const body = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    p.put("src/long.py", body);
    const shares = new SharedFiles(binding(), null);
    const grant = await shares.grant(p.root, "folder");
    const art = await shares.read(`${grant.id}/src/long.py`, 10, 500);
    assert.equal(art.from, 10);
    assert.equal(art.text.split("\n").length, 120);
    assert.equal(art.text.split("\n")[0], "line 10");
    assert.equal(art.sha, sha(body));
    p.put("src/later.py", "x = 1\n");
    await assert.rejects(shares.file(`${grant.id}/src/later.py`), /isn't a file you shared/);
  } finally { p.done(); }
});

test("every read revalidates: a symlink planted in place or on the way is refused, an editor replace is fresh bytes", async () => {
  const p = project();
  try {
    const shares = new SharedFiles(binding(), null);
    const grant = await shares.grant(p.root, "folder");
    const main = `${grant.id}/src/main.py`;
    // An editor writes a new file and renames it over the old one: same place, new bytes.
    writeFileSync(join(p.root, "src/.main.py.swp"), "def main():\n    return 2\n");
    renameSync(join(p.root, "src/.main.py.swp"), join(p.root, "src/main.py"));
    assert.equal((await shares.file(main)).sha, sha("def main():\n    return 2\n"));

    rmSync(join(p.root, "README.md"));
    symlinkSync(join(p.away, "secret.txt"), join(p.root, "README.md"));
    await assert.rejects(shares.file(`${grant.id}/README.md`), /symlink/);

    renameSync(join(p.root, "src"), join(p.root, "src-real"));
    mkdirSync(join(p.away, "src"));
    writeFileSync(join(p.away, "src/main.py"), "stolen = True\n");
    symlinkSync(join(p.away, "src"), join(p.root, "src"));
    await assert.rejects(shares.file(main), /symlink/);
  } finally { p.done(); }
});

test("a shared root that moved since consent is revoked and must be shared again", async () => {
  const p = project();
  try {
    const shares = new SharedFiles(binding(), null);
    const grant = await shares.grant(p.root, "folder");
    const moved = `${p.root}-moved`;
    renameSync(p.root, moved);
    symlinkSync(moved, p.root);
    try {
      await assert.rejects(shares.file(`${grant.id}/src/main.py`), /moved since you shared it/);
      await assert.rejects(shares.file(`${grant.id}/src/main.py`), /isn't shared with this request/);
      assert.deepEqual(shares.list(), []);
    } finally {
      rmSync(p.root);
      renameSync(moved, p.root);
    }
  } finally { p.done(); }
});

test("pending shares lapse after five minutes; a started request keeps them until it ends", async () => {
  const p = project();
  try {
    let now = 1_000_000;
    const pending = new SharedFiles(binding(), null, () => now);
    const lapsing = await pending.grant(join(p.root, "README.md"), "file");
    now += SHARE_LIMITS.pendingMs + 1;
    assert.deepEqual(pending.list(), []);
    await assert.rejects(pending.file(lapsing.files[0]!), /isn't shared/);

    const started = new SharedFiles(binding(), null, () => now);
    const one = await started.grant(join(p.root, "README.md"), "file");
    const two = await started.grant(join(p.root, "src"), "folder");
    started.activate();
    now += SHARE_LIMITS.pendingMs * 10;
    assert.equal((await started.file(one.files[0]!)).text, "# demo\n");
    started.revoke(two.id);
    assert.deepEqual(started.list(), one.files);
    started.revoke();
    assert.deepEqual(started.list(), []);
    assert.deepEqual(started.grants(), []);
    await assert.rejects(started.file(one.files[0]!), /request is over/);
    await assert.rejects(started.grant(join(p.root, "README.md"), "file"), /request is over/);
  } finally { p.done(); }
});

test("change targets: granted files hash, new names only under a folder, through real folders, where nothing is", async () => {
  const p = project();
  try {
    const shares = new SharedFiles(binding(), null);
    const folder = await shares.grant(p.root, "folder");
    const file = await shares.grant(join(p.root, "README.md"), "file");
    const t = await shares.target(`${folder.id}/src/main.py`);
    assert.deepEqual(t, { absolute: join(p.root, "src/main.py"), currentSha: sha("def main():\n    return 1\n") });
    const fresh = await shares.target(`${folder.id}/src/util/helpers.py`);
    assert.deepEqual(fresh, { absolute: join(p.root, "src/util/helpers.py"), currentSha: null });
    await assert.rejects(shares.target(`${file.id}/other.txt`), /new files go only in a shared folder/);
    await assert.rejects(shares.target(`${folder.id}/.env`), /hidden/);
    await assert.rejects(shares.target(`${folder.id}/config/credentials.json`), /credentials/);
    await assert.rejects(shares.target(`${folder.id}/linked/planted.py`), /symlink/);
    p.put("src/later.py", "mine\n");
    await assert.rejects(shares.target(`${folder.id}/src/later.py`), /isn't part of what you shared/);
  } finally { p.done(); }
});

test("one namespace: the zone's followed folders sit beside the request's shares", async () => {
  const p = project();
  const followed = mkdtempSync(join(tmpdir(), "dum-followed-"));
  try {
    writeFileSync(join(followed, "notes.md"), "followed\n");
    const b = binding();
    const follows = new Follows(H, b.zoneId);
    const f = await follows.add(followed);
    const shares = new SharedFiles(b, follows);
    const g = await shares.grant(join(p.root, "README.md"), "file");
    assert.deepEqual(shares.list(), [`${g.id}/README.md`, `${f.id}/notes.md`]);
    assert.equal((await shares.file(`${f.id}/notes.md`)).text, "followed\n");
    assert.deepEqual(shares.grants().map((x) => [x.id, x.scope]), [[g.id, "request"], [f.id, "zone"]]);
  } finally {
    p.done();
    rmSync(followed, { recursive: true, force: true });
  }
});

/** Apply a unified diff the way `git apply` would, for checking round trips without Git. */
function apply(before: string, patch: string): string | null {
  const a = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  let at = 0;
  const lines = patch.split("\n").slice(0, -1);
  if (lines.some((l) => l === "+++ /dev/null")) return null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(lines[i]!);
    if (!m) continue;
    const start = Number(m[2]) === 0 ? Number(m[1]) : Number(m[1]) - 1;
    while (at < start) out.push(a[at++]!);
    for (i++; i < lines.length && !lines[i]!.startsWith("@@"); i++) {
      const l = lines[i]!;
      const noEol = lines[i + 1] === "\\ No newline at end of file";
      const text = l.slice(1) + (noEol ? "" : "\n");
      if (l[0] === " ") { out.push(a[at++]!); }
      else if (l[0] === "-") { assert.equal(a[at], text); at++; }
      else if (l[0] === "+") out.push(text);
      if (noEol) i++;
    }
    i--;
  }
  while (at < a.length) out.push(a[at++]!);
  return out.join("");
}

test("unified diffs round-trip, including a missing final newline, new and removed files", () => {
  const cases: [string | null, string][] = [
    ["a\nb\nc\n", "a\nB\nc\n"],
    ["one\ntwo", "one\ntwo\n"],
    ["x\n".repeat(30), "y\n" + "x\n".repeat(28) + "z\n"],
    [null, "fresh\n"],
  ];
  for (const [before, after] of cases) {
    const patch = unifiedDiff("g/f.txt", before, after);
    assert.equal(apply(before ?? "", patch), after, JSON.stringify([before, after]));
  }
  assert.match(unifiedDiff("g/f.txt", null, "x\n"), /^new file mode 100644\n--- \/dev\/null$/m);
  assert.match(unifiedDiff("g/f.txt", "x\n", null), /^deleted file mode 100644\n--- a\/g\/f.txt\n\+\+\+ \/dev\/null\n@@ -1,1 \+0,0 @@\n-x$/m);
  assert.equal(unifiedDiff("g/f.txt", "same\n", "same\n"), "");
});

// The web copy of a tree: merging two copies, the edits a page may make, the server, and the
// terminal's client against a real server on a free port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { merge, edit, same, type Snapshot } from "../src/sync.ts";
import { createServer } from "../src/web/server.ts";
import { view } from "../src/web/view.ts";
import { unlock, read, write, remove, removed, id, type Skill } from "../src/skills.ts";

const sk = (name: string, lang: string, at: string, level: Skill["level"] = "build"): Skill => ({ name, lang, how: "typed", level, requires: [], why: "", at });

test("the newest word on each skill wins, a removal included", () => {
  const a: Snapshot = { skills: [sk("printing", "python", "2026-01-01"), sk("lists", "python", "2026-01-05")], removed: { [id("loops", "python")]: "2026-01-03" } };
  const b: Snapshot = { skills: [sk("printing", "python", "2026-01-02", "apply"), sk("loops", "python", "2026-01-02")], removed: { [id("lists", "python")]: "2026-01-04" } };
  const m = merge(a, b);
  assert.deepEqual(m.skills.map((s) => [s.name, s.at, s.level]).sort(), [["lists", "2026-01-05", "build"], ["printing", "2026-01-02", "apply"]]);
  assert.deepEqual(m.removed, { [id("loops", "python")]: "2026-01-03" }, "loops came off after it went on");
  assert.ok(same(merge(a, b), merge(b, a)), "the order of the copies doesn't matter");
  const tie = merge({ skills: [sk("x", "", "t", "recognize")], removed: {} }, { skills: [sk("x", "", "t", "build")], removed: {} });
  assert.equal(tie.skills[0]!.level, "build", "a tie keeps the higher level");
});

test("a page edit follows the terminal's rules: above its prerequisites, and anything comes off", () => {
  const now = new Date("2026-10-03T00:00:00Z");
  let snap: Snapshot = { skills: [sk("printing", "python", "2026-01-01")], removed: {} };
  assert.deepEqual(edit(snap, { op: "add", name: "recursion", lang: "python" }), { refused: "recursion (python) builds on return values, conditionals - add those first" });
  assert.deepEqual(edit(snap, { op: "add", name: "printing", lang: "py" }), { refused: "printing (python) is already on your tree" });
  const added = edit(snap, { op: "add", name: "Variables", lang: "python" }, now) as Snapshot;
  const v = added.skills.find((s) => s.name === "variables")!;
  assert.deepEqual([v.how, v.level, v.at, v.requires], ["added", "build", now.toISOString(), ["printing"]]);
  const off = edit(added, { op: "remove", name: "printing", lang: "python" }, now) as Snapshot;
  assert.deepEqual(off.skills.map((s) => s.name), ["variables"]);
  assert.equal(off.removed[id("printing", "python")], now.toISOString());
  assert.deepEqual(edit(off, { op: "remove", name: "printing", lang: "python" }), { refused: "printing (python) isn't on your tree" });
  snap = edit(off, { op: "add", name: "printing", lang: "python" }, new Date("2026-10-04")) as Snapshot;
  assert.ok(!snap.removed[id("printing", "python")], "adding it back clears the removal");
});

test("the page's view lays tracks out by depth and marks each skill", () => {
  const v = view({ skills: [sk("printing", "python", "t"), sk("variables", "python", "t", "recognize")] });
  const py = v.tracks.find((t) => t.lang === "python" && t.name === "basics")!;
  const node = (n: string) => py.nodes.find((x) => x.name === n)!;
  assert.deepEqual([node("printing").state, node("printing").depth], ["built", 0]);
  assert.deepEqual([node("variables").state, node("variables").depth], ["recognized", 1]);
  assert.equal(node("recursion").state, "locked");
  assert.ok(node("recursion").depth > node("functions").depth);
  assert.equal(py.done, 1);
  const iv = v.tracks.find((t) => t.name === "interview")!;
  assert.equal(iv.nodes.find((n) => n.name === "arrays and strings")!.depth, 0, "a prerequisite from another track doesn't add depth");
});

async function server() {
  const data = mkdtempSync(`${tmpdir()}/dum-web-`);
  const s = createServer({ data });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { base, data, close: () => new Promise<void>((r) => s.close(() => r())) };
}

const tree: Snapshot = { skills: [sk("printing", "python", "2026-01-01")], removed: {} };

test("the server keeps a tree at a private link, edits it under the rules, and never lets a stale write win", async () => {
  const s = await server();
  try {
    const page = await fetch(`${s.base}/`);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const made = await (await fetch(`${s.base}/api/trees`, { method: "POST", body: JSON.stringify(tree) })).json();
    assert.match(made.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(readdirSync(s.data), [`${made.id}.json`]);
    const html = await fetch(`${s.base}/${made.id}`);
    assert.equal(html.status, 200);
    assert.equal(html.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal((await fetch(`${s.base}/api/trees/00000000-0000-4000-8000-000000000000`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/trees/..%2F..%2Fetc`)).status, 404, "an id is a uuid or nothing");

    const api = `${s.base}/api/trees/${made.id}`;
    const refused = await fetch(`${api}/edit`, { method: "POST", body: JSON.stringify({ op: "add", name: "recursion", lang: "python" }) });
    assert.equal(refused.status, 422);
    assert.match((await refused.json()).refused, /builds on/);
    const ok = await (await fetch(`${api}/edit`, { method: "POST", body: JSON.stringify({ op: "add", name: "variables", lang: "python" }) })).json();
    assert.equal(ok.version, 2);
    assert.ok(ok.view.tracks.length > 0);

    const stale = await fetch(api, { method: "PUT", body: JSON.stringify({ version: 1, snapshot: tree }) });
    assert.equal(stale.status, 409, "written over only on the version you saw");
    assert.equal((await stale.json()).snapshot.skills.length, 2, "and the refusal hands back the latest");
    assert.equal((await fetch(api, { method: "PUT", body: JSON.stringify({ version: 2, snapshot: { skills: "nope" } }) })).status, 400);

    const rotated = await (await fetch(`${api}/rotate`, { method: "POST" })).json();
    assert.equal((await fetch(api)).status, 404, "the old link stops working");
    assert.equal((await fetch(`${s.base}/api/trees/${rotated.id}`)).status, 200);
    assert.equal((await fetch(`${s.base}/api/trees/${rotated.id}`, { method: "DELETE" })).status, 204);
    assert.deepEqual(readdirSync(s.data), []);
  } finally {
    await s.close();
  }
});

test("the terminal links, pulls a page edit, pushes its own, and takes the copy down", async () => {
  const s = await server();
  const was = process.env.DUM_HOME;
  process.env.DUM_HOME = mkdtempSync(`${tmpdir()}/dum-web-home-`);
  const web = await import("../src/web.ts");
  try {
    write(unlock({ skills: [] }, { name: "printing", lang: "python", how: "typed", why: "" }));
    assert.deepEqual(await web.syncNow(), { ok: false, why: "not linked - dum --web <server> makes a link" });
    const url = await web.link(s.base);
    assert.match(url, new RegExp(`^${s.base}/[0-9a-f-]{36}$`));
    const api = `${s.base}/api/trees/${web.config()!.id}`;

    await fetch(`${api}/edit`, { method: "POST", body: JSON.stringify({ op: "add", name: "variables", lang: "python" }) });
    assert.deepEqual(await web.syncNow(), { ok: true, pulled: true });
    assert.ok(read().skills.some((x) => x.name === "variables"), "the page's edit landed here");

    remove("printing", "python");
    assert.ok(removed()[id("printing", "python")]);
    assert.deepEqual(await web.syncNow(), { ok: true, pulled: false });
    const remote = await (await fetch(api)).json();
    assert.deepEqual(remote.snapshot.skills.map((x: Skill) => x.name), ["variables"], "and the removal went up");
    assert.deepEqual(await web.syncNow(), { ok: true, pulled: false }, "nothing to do is nothing done");

    const fresh = await web.rotate();
    assert.notEqual(fresh, url);
    await web.unlink();
    assert.equal(web.config(), null);
    assert.equal((await fetch(fresh.replace(/\/([^/]+)$/, "/api/trees/$1"))).status, 404);
    assert.ok(existsSync(`${process.env.DUM_HOME}/skills`), "the tree here is untouched");
  } finally {
    process.env.DUM_HOME = was;
    await s.close();
  }
});

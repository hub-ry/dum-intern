// Boundary tests for public notes: what the validator refuses, what the rendered pages escape, how
// revisions stay immutable while the URL stays put, which roots are refused, what a restart
// rebuilds, and how the private API gates publication. Every test uses its own temporary private
// home and public root outside the repository; nothing here calls a model.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { WorkshopError } from "./errors.ts";
import { WorkshopStore } from "./runtime.ts";
import { NotesProjectionError, PublicNotes, noteUrl, topicSlug, validateNotePayload } from "./public-notes.ts";
import { startWorkshopServer } from "./server.ts";

const dirs: string[] = [];

function fresh(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs.reverse()) rmSync(dir, { recursive: true, force: true });
});

function status(expected: number): (err: unknown) => boolean {
  return (err) => err instanceof WorkshopError && err.status === expected;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Every regular file below `dir`, as paths relative to it, sorted. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) visit(p);
      else out.push(relative(dir, p));
    }
  };
  visit(dir);
  return out.sort();
}

function snapshot(dir: string): Map<string, string> {
  return new Map(walk(dir).map((p) => [p, readFileSync(join(dir, p), "utf8")]));
}

const PAGE = { heading: "Why atomic", text: "Write the whole file,\n  then rename it into place." };

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: "Atomic revisions", topic: "workshop", pages: [PAGE], ...over };
}

function openNotes(): { notes: PublicNotes; home: string; pub: string } {
  const home = fresh("dum-notes-home-");
  const pub = fresh("dum-notes-public-");
  return { notes: new PublicNotes({ home, publicRoot: pub }), home, pub };
}

// ---------------------------------------------------------------------------------------------

test("the validator accepts exactly the documented shape and refuses extra fields, blanks, control characters and non-https links", () => {
  const ok = validateNotePayload(payload({ links: [{ label: "repo", url: "https://example.com/dum" }] }));
  assert.deepEqual(ok, { title: "Atomic revisions", topic: "workshop", pages: [PAGE], links: [{ label: "repo", url: "https://example.com/dum" }] });
  assert.equal("links" in validateNotePayload(payload()), false);

  // Unknown keys at every level: private data cannot ride along.
  assert.throws(() => validateNotePayload(payload({ context: "private" })), status(400));
  assert.throws(() => validateNotePayload(payload({ goalId: "x" })), status(400));
  assert.throws(() => validateNotePayload(payload({ pages: [{ ...PAGE, teachingIds: [] }] })), status(400));
  assert.throws(() => validateNotePayload(payload({ links: [{ label: "a", url: "https://a.example", rel: "x" }] })), status(400));

  // Required, non-blank, bounded, single-line where it must be.
  for (const bad of [undefined, "", "   ", 5, "x".repeat(161), "two\nlines", "tab\there"]) {
    assert.throws(() => validateNotePayload(payload({ title: bad })), status(400), `title ${JSON.stringify(bad)}`);
  }
  assert.throws(() => validateNotePayload(payload({ topic: "x".repeat(81) })), status(400));
  assert.throws(() => validateNotePayload(payload({ pages: [] })), status(400));
  assert.throws(() => validateNotePayload(payload({ pages: Array.from({ length: 13 }, () => PAGE) })), status(400));
  assert.throws(() => validateNotePayload(payload({ pages: {} })), status(400));
  assert.throws(() => validateNotePayload(payload({ pages: [{ heading: "h" }] })), status(400));
  assert.throws(() => validateNotePayload(payload({ pages: [{ heading: " ", text: "t" }] })), status(400));
  assert.throws(() => validateNotePayload(payload({ pages: [{ heading: "h", text: "bell\x07" }] })), status(400));
  assert.throws(() => validateNotePayload(payload({ pages: [{ heading: "h", text: "lone \uD800 surrogate" }] })), status(400));
  assert.throws(() => validateNotePayload(payload({ pages: [{ heading: "h", text: "t", code: 3 }] })), status(400));
  assert.throws(() => validateNotePayload(payload({ pages: [{ heading: "h", text: "t", code: "x".repeat(4001) }] })), status(400));
  assert.throws(() => validateNotePayload(null), status(400));
  assert.throws(() => validateNotePayload([payload()]), status(400));
  // Twelve full pages exceed the serialized ceiling even though each field is within its own limit.
  assert.throws(() => validateNotePayload(payload({ pages: Array.from({ length: 12 }, () => ({ heading: "h", text: "x".repeat(4000) })) })), status(400));

  // Links: https only, no credentials, no whitespace or control characters, bounded count.
  for (const url of ["http://example.com/", "javascript:alert(1)", "ftp://example.com/", "//example.com/x", "https://user:pw@example.com/", "https://user@example.com/", "https://example.com/a b", "https://example.com/\u0001", "example.com", "https://"]) {
    assert.throws(() => validateNotePayload(payload({ links: [{ label: "l", url }] })), status(400), url);
  }
  assert.throws(() => validateNotePayload(payload({ links: [{ label: "", url: "https://example.com/" }] })), status(400));
  assert.throws(() => validateNotePayload(payload({ links: Array.from({ length: 9 }, () => ({ label: "l", url: "https://example.com/" })) })), status(400));
  assert.throws(() => validateNotePayload(payload({ links: {} })), status(400));
});

test("rendered pages escape every payload string in text, attributes and code; the public tree holds no script", () => {
  const { notes, pub } = openNotes();
  const note = notes.create({
    title: "<script>alert(1)</script>",
    topic: "\"><img src=x onerror=alert(2)>",
    pages: [{ heading: "<b>bold</b>", text: "</p><script>evil()</script>", code: "<script>code()</script>" }],
    links: [{ label: "<a>label</a>", url: "https://example.com/?q=\"onmouseover=alert(3)" }],
  });
  const page = readFileSync(join(pub, "notes", note.id, "index.html"), "utf8");
  const home = readFileSync(join(pub, "index.html"), "utf8");
  const topic = readFileSync(join(pub, "topics", topicSlug(note.topic), "index.html"), "utf8");
  for (const html of [page, home, topic]) {
    assert.equal(html.includes("<script"), false);
    assert.equal(html.includes("<img"), false);
    assert.equal(html.includes("\"onmouseover"), false);
    assert.equal(html.includes("</p><script"), false);
  }
  assert.ok(page.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(page.includes("&lt;b&gt;bold&lt;/b&gt;"));
  assert.ok(page.includes("&lt;/p&gt;&lt;script&gt;evil()&lt;/script&gt;"));
  assert.ok(page.includes("<pre><code>&lt;script&gt;code()&lt;/script&gt;</code></pre>"));
  assert.ok(page.includes("&lt;a&gt;label&lt;/a&gt;"));
  assert.ok(page.includes("href=\"https://example.com/?q=%22onmouseover=alert(3)\""));
  assert.ok(home.includes("&quot;&gt;&lt;img src=x onerror=alert(2)&gt;"));
  assert.match(topicSlug(note.topic), /^[a-z0-9-]+-[0-9a-f]{10}$/);
  assert.equal(topicSlug("Loops & conditions"), topicSlug("Loops & conditions"));
  assert.notEqual(topicSlug("loops"), topicSlug("Loops"));
  for (const file of walk(pub)) {
    assert.match(file, /\.(html|css)$/, `${file} is not a rendered page or stylesheet`);
    assert.equal(readFileSync(join(pub, file), "utf8").includes("<script"), false, file);
  }
});

test("revisions are written once and kept, the latest is served at the same URL, and only stale page files disappear", () => {
  const { notes, home, pub } = openNotes();
  mkdirSync(join(pub, "other"));
  writeFileSync(join(pub, "other", "keep.html"), "<p>unrelated</p>");
  const three = [PAGE, { heading: "Second", text: "two" }, { heading: "Third", text: "three" }];
  const first = notes.create(payload({ pages: three }));
  assert.equal(first.revision, 1);
  assert.equal(first.url, noteUrl(first.id));
  assert.equal(first.url, `https://notes.ryhub.dev/notes/${first.id}/`);
  const noteDir = join(pub, "notes", first.id);
  assert.deepEqual(readdirSync(noteDir).sort(), ["index.html", "page-2.html", "page-3.html"]);
  writeFileSync(join(noteDir, "keep.txt"), "not ours");

  const privateDir = join(home, "public-notes", first.id);
  const rev1Path = join(privateDir, "revision-1.json");
  const rev1Before = readFileSync(rev1Path, "utf8");
  assert.equal(modeOf(join(home, "public-notes")), 0o700);
  assert.equal(modeOf(privateDir), 0o700);
  assert.equal(modeOf(rev1Path), 0o600);
  assert.equal(modeOf(join(pub, "notes")), 0o755);
  assert.equal(modeOf(noteDir), 0o755);
  assert.equal(modeOf(join(noteDir, "index.html")), 0o644);
  assert.equal(modeOf(join(pub, "notes.css")), 0o644);

  const second = notes.revise(first.id, payload({ title: "Atomic revisions, revised" }));
  assert.equal(second.id, first.id);
  assert.equal(second.revision, 2);
  assert.equal(second.createdAt, first.createdAt);
  assert.ok(second.updatedAt >= first.updatedAt);
  assert.equal(second.url, first.url);
  assert.equal(readFileSync(rev1Path, "utf8"), rev1Before);
  assert.deepEqual(readdirSync(privateDir).sort(), ["revision-1.json", "revision-2.json"]);
  const stored = JSON.parse(readFileSync(join(privateDir, "revision-2.json"), "utf8"));
  assert.equal(stored.title, "Atomic revisions, revised");
  assert.equal(stored.revision, 2);
  assert.equal(stored.id, first.id);

  const latest = notes.get(first.id);
  assert.equal(latest.revision, 2);
  assert.equal(latest.title, "Atomic revisions, revised");
  assert.equal(latest.pages.length, 1);
  assert.deepEqual(notes.list().map((n) => [n.id, n.revision, n.pageCount, n.title]), [[first.id, 2, 1, "Atomic revisions, revised"]]);

  // Pages 2 and 3 were ours and are gone; the unrelated files stay.
  assert.deepEqual(readdirSync(noteDir).sort(), ["index.html", "keep.txt"]);
  assert.equal(readFileSync(join(pub, "other", "keep.html"), "utf8"), "<p>unrelated</p>");
  const page = readFileSync(join(noteDir, "index.html"), "utf8");
  assert.ok(page.includes("Atomic revisions, revised"));
  assert.ok(page.includes("Page 1 of 1"));
  assert.equal(page.includes("page-2.html"), false);
  assert.ok(page.includes("(revised "));
  const homeHtml = readFileSync(join(pub, "index.html"), "utf8");
  assert.equal(homeHtml.split(`/notes/${first.id}/`).length, 2);

  assert.throws(() => notes.revise("00000000-0000-4000-8000-000000000000", payload()), status(404));
  assert.throws(() => notes.revise("not-a-uuid", payload()), status(400));
  assert.throws(() => notes.get("00000000-0000-4000-8000-000000000000"), status(404));
  assert.throws(() => notes.revise(first.id, payload({ extra: true })), status(400));
  assert.deepEqual(readdirSync(privateDir).sort(), ["revision-1.json", "revision-2.json"]);
});

test("the public tree is built from the explicit payload alone: no workshop state, no source JSON", () => {
  const { notes, home, pub } = openNotes();
  const marker = "PRIVATE-CONTEXT-MARKER-7f3a";
  writeFileSync(join(home, "workshop.json"), JSON.stringify({ goals: [{ title: marker }], teachings: [{ text: marker }] }));
  mkdirSync(join(home, "artifacts"));
  writeFileSync(join(home, "artifacts", "secret.html"), marker);
  notes.create(payload({ pages: [PAGE, { heading: "More", text: "plain" }] }));
  const files = walk(pub);
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.match(file, /\.(html|css)$/);
    assert.equal(readFileSync(join(pub, file), "utf8").includes(marker), false, file);
  }
  assert.equal(files.some((f) => f.endsWith(".json")), false);
  assert.equal(existsSync(join(pub, "public-notes")), false);
  assert.equal(existsSync(join(pub, "artifacts")), false);
});

test("public roots that are symlinked, overlapping, relative or missing are refused; a later symlink stops writes without following it", () => {
  const home = fresh("dum-notes-home-");
  const pub = fresh("dum-notes-public-");

  assert.throws(() => new PublicNotes({ home, publicRoot: join(home, "public") }), status(400));
  const inner = join(pub, "home");
  mkdirSync(inner);
  assert.throws(() => new PublicNotes({ home: inner, publicRoot: pub }), status(400));
  assert.throws(() => new PublicNotes({ home, publicRoot: home }), status(400));
  const artifacts = fresh("dum-notes-artifacts-");
  assert.throws(() => new PublicNotes({ home, publicRoot: artifacts, reserved: [artifacts] }), status(400));
  assert.throws(() => new PublicNotes({ home, publicRoot: join(artifacts, "sub"), reserved: [artifacts] }), status(400));
  const link = join(fresh("dum-notes-linkdir-"), "public-link");
  symlinkSync(pub, link);
  assert.throws(() => new PublicNotes({ home, publicRoot: link }), status(400));
  assert.throws(() => new PublicNotes({ home, publicRoot: join(link, "notes") }), status(400));
  assert.throws(() => new PublicNotes({ home, publicRoot: "public" }), status(400));
  assert.throws(() => new PublicNotes({ home, publicRoot: join(pub, "missing") }), status(400));
  assert.throws(() => new PublicNotes({ home, publicRoot: `${pub}/../${pub.split("/").pop()}` }), status(400));
  assert.throws(() => new PublicNotes({ home, publicRoot: "/" }), status(400));
  assert.throws(() => new PublicNotes({ home, publicRoot: "" }), status(400));
  // Nothing was created in the home by any refusal.
  assert.equal(existsSync(join(home, "public-notes")), false);
  assert.deepEqual(readdirSync(pub), ["home"]);

  const notes = new PublicNotes({ home, publicRoot: pub });
  const ok = notes.create(payload());
  assert.ok(existsSync(join(pub, "notes", ok.id, "index.html")));

  // A child directory replaced by a symlink: the revision is saved, the projection refuses, the target is untouched.
  const elsewhere = fresh("dum-notes-elsewhere-");
  rmSync(join(pub, "notes"), { recursive: true });
  symlinkSync(elsewhere, join(pub, "notes"));
  let caught: unknown;
  try {
    notes.create(payload({ title: "Through a link" }));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof NotesProjectionError);
  assert.equal(notes.get(caught.note.id).title, "Through a link");
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(notes.list().length, 2);
  rmSync(join(pub, "notes"));

  // The root itself replaced by a symlink after initialization: refused, target untouched.
  const moved = `${pub}-moved`;
  dirs.push(moved);
  renameSync(pub, moved);
  symlinkSync(moved, pub);
  const before = walk(moved);
  assert.throws(() => notes.rebuild(), /no longer a real directory/);
  assert.throws(() => notes.create(payload({ title: "After root swap" })), (err: unknown) => err instanceof NotesProjectionError);
  assert.deepEqual(walk(moved), before);
  assert.equal(notes.list().length, 3);
  rmSync(pub);
  renameSync(moved, pub);
});

test("a private root replaced by a symlink refuses reads and writes without touching its target", () => {
  const { notes, home, pub } = openNotes();
  const note = notes.create(payload());
  const root = join(home, "public-notes");
  const moved = join(home, "saved-notes");
  renameSync(root, moved);
  symlinkSync(moved, root);
  const before = snapshot(moved);
  const publicBefore = snapshot(pub);
  assert.throws(() => notes.list(), status(500));
  assert.throws(() => notes.get(note.id), status(500));
  assert.throws(() => notes.create(payload()), status(500));
  assert.throws(() => notes.revise(note.id, payload()), status(500));
  assert.throws(() => notes.rebuild(), status(500));
  assert.deepEqual(snapshot(moved), before);
  assert.deepEqual(snapshot(pub), publicBefore);
});

test("pages carry their position and navigation links; restart reproduces the same public bytes without seeding notes", () => {
  const { notes, home, pub } = openNotes();
  const note = notes.create(payload({
    topic: "Loops & conditions",
    pages: [
      { heading: "One", text: "line one\n  indented line\n\nparagraph two", code: "for (const x of xs) {\n  console.log(x);\n}" },
      { heading: "Two", text: "second" },
      { heading: "Three", text: "third" },
    ],
    links: [{ label: "the code", url: "https://example.com/code" }],
  }));
  const dir = join(pub, "notes", note.id);
  const p1 = readFileSync(join(dir, "index.html"), "utf8");
  const p2 = readFileSync(join(dir, "page-2.html"), "utf8");
  const p3 = readFileSync(join(dir, "page-3.html"), "utf8");
  for (const html of [p1, p2, p3]) {
    assert.ok(html.includes(`<link rel="stylesheet" href="/notes.css">`));
    assert.equal(html.includes("<script"), false);
    assert.ok(html.includes(`<a href="/">Home</a>`));
    assert.ok(html.includes(`href="/topics/${topicSlug("Loops & conditions")}/">Loops &amp; conditions</a>`));
    assert.ok(html.includes(`<a href="https://example.com/code" rel="noopener">the code</a>`));
    assert.ok(html.includes(note.createdAt.slice(0, 10)));
  }
  assert.ok(p1.includes("Page 1 of 3"));
  assert.ok(p1.includes(`<p class="text">line one\n  indented line\n\nparagraph two</p>`));
  assert.ok(p1.includes(`<pre><code>for (const x of xs) {\n  console.log(x);\n}</code></pre>`));
  assert.ok(p1.includes(`rel="next" href="/notes/${note.id}/page-2.html"`));
  assert.equal(p1.includes(`rel="prev"`), false);
  assert.ok(p2.includes("Page 2 of 3"));
  assert.ok(p2.includes(`rel="prev" href="/notes/${note.id}/index.html"`));
  assert.ok(p2.includes(`rel="next" href="/notes/${note.id}/page-3.html"`));
  assert.ok(p3.includes("Page 3 of 3"));
  assert.ok(p3.includes(`rel="prev" href="/notes/${note.id}/page-2.html"`));
  assert.equal(p3.includes(`rel="next"`), false);
  const homeHtml = readFileSync(join(pub, "index.html"), "utf8");
  assert.ok(homeHtml.includes(`<a href="/notes/${note.id}/">Atomic revisions</a>`));

  // Wipe the projection, then start over from the same private home: identical files, identical bytes.
  const before = snapshot(pub);
  for (const entry of readdirSync(pub)) rmSync(join(pub, entry), { recursive: true });
  writeFileSync(join(pub, "stray.html"), "left by someone else");
  const again = new PublicNotes({ home, publicRoot: pub });
  again.rebuild();
  const after = snapshot(pub);
  assert.equal(after.get("stray.html"), "left by someone else");
  after.delete("stray.html");
  assert.deepEqual([...after.keys()], [...before.keys()]);
  for (const [file, text] of before) assert.equal(after.get(file), text, file);
  assert.deepEqual(again.list(), notes.list());

  // An empty source tree must not invent notes during projection.
  const empty = openNotes();
  empty.notes.rebuild();
  assert.deepEqual(walk(empty.pub), ["index.html", "notes.css"]);
  assert.deepEqual(empty.notes.list(), []);
  assert.deepEqual(readdirSync(join(empty.pub, "notes")), []);
  assert.deepEqual(readdirSync(join(empty.pub, "topics")), []);
});

// ---------------------------------------------------------------------------------------------
// The private API

type Started = Awaited<ReturnType<typeof startWorkshopServer>>;
const servers: Started[] = [];
after(async () => {
  for (const s of servers) await s.stop();
});

async function ports(): Promise<{ port: number; artifactPort: number }> {
  const reservations = [createTcpServer(), createTcpServer()];
  try {
    await Promise.all(reservations.map((server) => new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    })));
    const addresses = reservations.map((server) => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      return address.port;
    });
    return { port: addresses[0]!, artifactPort: addresses[1]! };
  } finally {
    await Promise.all(reservations.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

async function start(options: Parameters<typeof startWorkshopServer>[0]): Promise<Started> {
  const started = await startWorkshopServer({ host: "127.0.0.1", ...await ports(), home: fresh("dum-notes-ws-home-"), ...options });
  servers.push(started);
  return started;
}

async function api(ws: Started, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const address = ws.appServer.address();
  assert.ok(address && typeof address === "object");
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

test("the notes API refuses the open loopback mode, reports an unconfigured directory, and publishes only through authenticated POST and PUT", async () => {
  const pub = fresh("dum-notes-public-");

  // Open mode: everything else works, publication does not; startup still repaired the projection.
  const open = await start({ publicNotesDir: pub });
  assert.equal((await api(open, "GET", "/api/goals")).status, 200);
  assert.equal((await api(open, "GET", "/api/notes")).status, 401);
  assert.equal((await api(open, "POST", "/api/notes", payload())).status, 401);
  assert.deepEqual(walk(pub), ["index.html", "notes.css"]);
  await open.stop();

  // Token, no directory.
  const token = "correct-horse-battery";
  const unconfigured = await start({ token });
  assert.equal(unconfigured.notes, null);
  assert.equal((await api(unconfigured, "GET", "/api/notes")).status, 401);
  assert.equal((await api(unconfigured, "GET", "/api/notes", undefined, token)).status, 503);
  assert.equal((await api(unconfigured, "POST", "/api/notes", payload(), token)).status, 503);
  await unconfigured.stop();

  // Token and directory.
  const ws = await start({ token, publicNotesDir: pub });
  assert.ok(ws.notes);
  assert.equal((await api(ws, "POST", "/api/notes", payload())).status, 401);
  assert.equal((await api(ws, "POST", "/api/notes", payload(), "wrong-token-here")).status, 401);
  assert.equal((await api(ws, "POST", "/api/notes", payload({ context: "private" }), token)).status, 400);
  assert.equal((await api(ws, "POST", "/api/notes", payload({ links: [{ label: "l", url: "http://example.com/" }] }), token)).status, 400);
  assert.equal((await api(ws, "POST", "/api/notes", "[]", token)).status, 400);
  assert.equal((await api(ws, "POST", "/api/notes", JSON.stringify(payload({ pages: [{ heading: "h", text: "x".repeat(40_000) }] })), token)).status, 413);
  assert.deepEqual(walk(pub), ["index.html", "notes.css"]);

  const created = await api(ws, "POST", "/api/notes", payload({ pages: [PAGE, { heading: "Two", text: "two" }] }), token);
  assert.equal(created.status, 201);
  const note = created.json.note as Record<string, unknown>;
  assert.equal(note.revision, 1);
  assert.equal(note.url, noteUrl(note.id as string));
  assert.ok(existsSync(join(pub, "notes", note.id as string, "page-2.html")));

  const list = await api(ws, "GET", "/api/notes", undefined, token);
  assert.equal(list.status, 200);
  assert.deepEqual((list.json.notes as Array<Record<string, unknown>>).map((n) => [n.id, n.revision, n.pageCount, n.url]), [[note.id, 1, 2, note.url]]);
  const single = await api(ws, "GET", `/api/notes/${note.id}`, undefined, token);
  assert.equal(single.status, 200);
  assert.equal((single.json.note as Record<string, unknown>).revision, 1);
  assert.equal(((single.json.note as Record<string, unknown>).pages as unknown[]).length, 2);
  assert.equal((await api(ws, "GET", "/api/notes/00000000-0000-4000-8000-000000000000", undefined, token)).status, 404);
  assert.equal((await api(ws, "GET", "/api/notes/not-a-uuid", undefined, token)).status, 400);
  assert.equal((await api(ws, "DELETE", `/api/notes/${note.id}`, undefined, token)).status, 405);
  assert.equal((await api(ws, "PUT", `/api/notes/${note.id}`, payload({ title: "Revised" }))).status, 401);

  const revised = await api(ws, "PUT", `/api/notes/${note.id}`, payload({ title: "Revised" }), token);
  assert.equal(revised.status, 200);
  assert.equal((revised.json.note as Record<string, unknown>).revision, 2);
  assert.equal((revised.json.note as Record<string, unknown>).url, note.url);
  const fetched = await api(ws, "GET", `/api/notes/${note.id}`, undefined, token);
  assert.equal((fetched.json.note as Record<string, unknown>).title, "Revised");
  assert.equal(existsSync(join(pub, "notes", note.id as string, "page-2.html")), false);
  assert.deepEqual(readdirSync(join(ws.store.home, "public-notes", note.id as string)).sort(), ["revision-1.json", "revision-2.json"]);
  // The listing and single reads wrote nothing new.
  const filesBefore = snapshot(pub);
  await api(ws, "GET", "/api/notes", undefined, token);
  await api(ws, "GET", `/api/notes/${note.id}`, undefined, token);
  assert.deepEqual(snapshot(pub), filesBefore);
  await ws.stop();

  // A bad notes directory stops startup and releases the home, so the lock does not outlive the failure.
  const home = fresh("dum-notes-ws-home-");
  await assert.rejects(startWorkshopServer({ host: "127.0.0.1", ...await ports(), home, token, publicNotesDir: join(pub, "missing") }), status(400));
  await assert.rejects(startWorkshopServer({ host: "127.0.0.1", ...await ports(), home, token, publicNotesDir: join(home, "inside") }), status(400));
  const store = new WorkshopStore(home);
  store.close();
  assert.equal(lstatSync(home).isDirectory(), true);
});

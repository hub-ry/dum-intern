// Sharing files: only real files under a share root, never anything hidden, secret-named or
// holding a credential-looking line, one stable link per file, and every serve checks again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Shares, disposition, presentation, shareRoots } from "./shares.ts";
import { WorkshopError } from "./errors.ts";

const PDF = Buffer.concat([Buffer.from("%PDF-1.5\n%"), Buffer.from([0, 0xe2, 0xe3]), Buffer.from("\nresume\n")]);

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "dum-shares-"));
  const home = join(base, "home");
  const state = join(base, "state");
  const files = {
    resume: join(home, "internship", "resume", "hubbart_resume.pdf"),
    notes: join(home, "internship", "notes.md"),
    hidden: join(home, "internship", ".git", "config.txt"),
    secretDir: join(home, "internship", "secrets", "list.txt"),
    envFile: join(home, "internship", "prod.env"),
    key: join(home, "internship", "deploy.pem"),
    leak: join(home, "internship", "leak.md"),
    outside: join(home, "private", "diary.pdf"),
  };
  for (const p of Object.values(files)) mkdirSync(join(p, ".."), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(files.resume, PDF);
  writeFileSync(files.notes, "# Notes\nApplied to Datadog.\n");
  for (const p of [files.hidden, files.secretDir, files.envFile, files.key]) writeFileSync(p, "nothing to see\n");
  writeFileSync(files.leak, "notes\nDISCORD_TOKEN=abcdefghijklmnopqrstuvwxyz\n");
  writeFileSync(files.outside, PDF);
  symlinkSync(files.outside, join(home, "internship", "escape.pdf"));
  symlinkSync(files.resume, join(home, "internship", "current.pdf"));
  const make = () => new Shares({ stateDir: state, roots: ["~/internship", "~/dum-shared"], userHome: home });
  return { home, state, files, make, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const refused = (fn: () => unknown, re: RegExp) =>
  assert.throws(fn, (err: unknown) => err instanceof WorkshopError && err.status < 500 && re.test(err.message));

test("only real files under a share root can be shared, and the refusal says why", () => {
  const f = fixture();
  try {
    const shares = f.make();
    assert.deepEqual(shares.missing, [join(f.home, "dum-shared")], "a missing root is skipped and reported");
    refused(() => shares.share("internship/notes.md"), /full path/);
    refused(() => shares.share(f.files.outside), /isn't in a shared folder.*~\/internship/);
    refused(() => shares.share("~/internship/../private/diary.pdf"), /isn't in a shared folder/);
    refused(() => shares.share("~/internship/escape.pdf"), /isn't in a shared folder/);
    refused(() => shares.share("~/internship"), /isn't in a shared folder/);
    refused(() => shares.share("~/internship/resume"), /isn't a regular file/);
    refused(() => shares.share("~/internship/nope.pdf"), /no file/);
    refused(() => shares.share(f.files.hidden), /"\.git" is hidden or named like a secret/);
    refused(() => shares.share(f.files.secretDir), /"secrets"/);
    refused(() => shares.share(f.files.envFile), /"prod\.env"/);
    refused(() => shares.share(f.files.key), /"deploy\.pem"/);
    refused(() => shares.share(f.files.leak), /looks like a credential/);
    assert.equal(shares.list().length, 0, "nothing refused was recorded");
  } finally {
    f.cleanup();
  }
});

test("a file has one stable link, kept across restarts and reached through any path to it", () => {
  const f = fixture();
  try {
    const first = f.make().share("~/internship/resume/hubbart_resume.pdf", new Date("2026-10-13T00:00:00Z"));
    assert.equal(first.name, "hubbart_resume.pdf");
    assert.equal(first.size, PDF.length);
    assert.equal(first.urlPath, `/files/${first.id}/hubbart_resume.pdf`);
    const again = f.make();
    assert.equal(again.share(f.files.resume).id, first.id, "after a restart, the same file keeps its link");
    assert.equal(again.share("~/internship/current.pdf").id, first.id, "a symlink inside the root leads to the same share");
    assert.equal(again.list().length, 1);
  } finally {
    f.cleanup();
  }
});

test("every serve checks the file again: renamed links, swaps, new credentials and unsharing all close it", async () => {
  const f = fixture();
  try {
    const shares = f.make();
    const pdf = shares.share(f.files.resume);
    const notes = shares.share(f.files.notes);
    const opened = await shares.open(pdf.id, "hubbart_resume.pdf");
    assert.ok(opened);
    assert.equal(opened.size, PDF.length);
    await opened.handle.close();
    assert.equal(await shares.open(pdf.id, "other.pdf"), null, "the name in the link must match");
    assert.equal(await shares.open("not-an-id", "hubbart_resume.pdf"), null);

    // The shared path becomes a symlink to a file outside the root.
    unlinkSync(f.files.resume);
    symlinkSync(f.files.outside, f.files.resume);
    assert.equal(await shares.open(pdf.id, "hubbart_resume.pdf"), null);
    assert.equal(shares.get(pdf.id).size, null, "listed, but marked as not opening");

    // A text file picks up a credential after it was shared.
    const ok = await shares.open(notes.id, "notes.md");
    assert.ok(ok);
    await ok.handle.close();
    appendFileSync(f.files.notes, "api_key: not-a-real-value-123\n");
    assert.equal(await shares.open(notes.id, "notes.md"), null);

    shares.unshare(notes.id);
    assert.throws(() => shares.get(notes.id), /No such shared file/);
    assert.equal(f.make().list().length, 1, "unsharing is saved");
  } finally {
    f.cleanup();
  }
});

test("a share root can't be home itself, a hidden folder, or the workshop's own state", () => {
  const f = fixture();
  try {
    const make = (root: string) => () => new Shares({ stateDir: f.state, roots: [root], userHome: f.home });
    assert.throws(make("~"), /whole home folder/);
    assert.throws(make(join(f.home, "..")), /whole home folder/);
    mkdirSync(join(f.home, ".config", "stuff"), { recursive: true });
    assert.throws(make("~/.config/stuff"), /hidden folder/);
    assert.throws(make(f.state), /workshop's own state/);
    assert.throws(make(join(f.state, "..")), /whole home folder|workshop's own state/);
  } finally {
    f.cleanup();
  }
});

test("browsers show documents and images inline, plain text as text, and download everything else", () => {
  assert.deepEqual(presentation("hubbart_resume.pdf"), { type: "application/pdf", inline: true });
  assert.deepEqual(presentation("photo.JPG"), { type: "image/jpeg", inline: true });
  assert.deepEqual(presentation("resume.tex"), { type: "text/plain; charset=utf-8", inline: true });
  assert.deepEqual(presentation("tracker.html"), { type: "application/octet-stream", inline: false });
  assert.deepEqual(presentation("drawing.svg"), { type: "application/octet-stream", inline: false });
  assert.equal(disposition('my "résumé".pdf', true), `inline; filename="my _r_sum__.pdf"; filename*=UTF-8''my%20%22r%C3%A9sum%C3%A9%22.pdf`);
  assert.deepEqual(shareRoots(undefined, "/h"), { roots: ["/h/internship", "/h/dum-shared"], dedicated: "/h/dum-shared" });
  assert.deepEqual(shareRoots(" /a : /b ", "/h"), { roots: ["/a", "/b"], dedicated: null });
});

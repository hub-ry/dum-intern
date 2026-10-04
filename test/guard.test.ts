// A shell command is the one way code could reach a file without passing the tree. These are
// the shapes it takes: a new file, an edit, a delete, a rename, and a file already mid-edit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { snapshot, restore, changed } from "../src/guard.ts";

function repo(): string {
  const root = mkdtempSync(`${tmpdir()}/dum-guard-`);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(`${root}/main.py`, "# TODO(dum): printing\n# say hi\npass\n");
  writeFileSync(`${root}/util.py`, "def f():\n    return 1\n");
  writeFileSync(`${root}/notes.md`, "notes\n");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return root;
}

const read = (root: string, p: string) => (existsSync(`${root}/${p}`) ? readFileSync(`${root}/${p}`, "utf8") : null);

test("a command that writes, edits, deletes and renames source is undone, and says which files", () => {
  const root = repo();
  const before = snapshot(root);
  writeFileSync(`${root}/main.py`, 'print("hi")\n');
  mkdirSync(`${root}/pkg`);
  writeFileSync(`${root}/pkg/new.py`, "x = 1\n");
  unlinkSync(`${root}/util.py`);
  writeFileSync(`${root}/notes.md`, "the command may write docs\n");
  assert.deepEqual(restore(root, before), ["main.py", "pkg/new.py", "util.py"]);
  assert.equal(read(root, "main.py"), "# TODO(dum): printing\n# say hi\npass\n");
  assert.equal(read(root, "pkg/new.py"), null);
  assert.equal(read(root, "util.py"), "def f():\n    return 1\n");
  assert.equal(read(root, "notes.md"), "the command may write docs\n", "not source: left alone");
  assert.deepEqual(changed(root), []);
});

test("a file already mid-edit goes back to how it was before the command, not to HEAD", () => {
  const root = repo();
  writeFileSync(`${root}/util.py`, "def f():\n    return 2\n");
  const before = snapshot(root);
  writeFileSync(`${root}/util.py`, "def f():\n    return 3\n");
  assert.deepEqual(restore(root, before), ["util.py"]);
  assert.equal(read(root, "util.py"), "def f():\n    return 2\n");
});

test("a rename puts both ends back", () => {
  const root = repo();
  const before = snapshot(root);
  renameSync(`${root}/util.py`, `${root}/helpers.py`);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  assert.deepEqual(restore(root, before), ["helpers.py", "util.py"]);
  assert.equal(read(root, "helpers.py"), null);
  assert.equal(read(root, "util.py"), "def f():\n    return 1\n");
});

test("a command that only runs things changes nothing, and a file they saved meanwhile is theirs", () => {
  const root = repo();
  const before = snapshot(root);
  writeFileSync(`${root}/out.txt`, "program output\n");
  assert.deepEqual(restore(root, before), []);
  writeFileSync(`${root}/main.py`, 'print("they typed this")\n');
  assert.deepEqual(restore(root, snapshot(root)), [], "unchanged since the snapshot");
  const again = snapshot(root);
  writeFileSync(`${root}/main.py`, 'print("they saved again mid-command")\n');
  assert.deepEqual(restore(root, again, new Set(["main.py"])), []);
  assert.equal(read(root, "main.py"), 'print("they saved again mid-command")\n');
});

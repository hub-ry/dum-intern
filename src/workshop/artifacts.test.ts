import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openArtifactFile } from "./artifacts.ts";

test("artifact consumers read regular files and refuse traversal and symlinks", async () => {
  const home = await mkdtemp(join(tmpdir(), "dum-artifact-test-"));
  try {
    const root = join(home, "creation");
    await mkdir(root);
    await writeFile(join(root, "demo.html"), "<html>original</html>");
    const opened = await openArtifactFile(root, ["demo.html"]);
    assert.ok(opened);
    try {
      assert.equal(await opened.handle.readFile("utf8"), "<html>original</html>");
      assert.equal(opened.type, "text/html; charset=utf-8");
    } finally { await opened.handle.close(); }
    await symlink(join(root, "demo.html"), join(root, "alias.html"));
    await symlink(root, join(home, "linked"));
    for (const segments of [[], ["..", "creation", "demo.html"], ["." , "demo.html"], ["alias.html"], ["missing.html"], ["creation/demo.html"]]) {
      assert.equal(await openArtifactFile(root, segments), null);
    }
    assert.equal(await openArtifactFile(join(home, "linked"), ["demo.html"]), null);
    assert.equal(await openArtifactFile(home, ["linked", "demo.html"]), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

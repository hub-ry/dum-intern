import { mkdtemp, mkdir, writeFile, symlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openArtifactFile } from "./artifacts.ts";
import { createServer } from "node:net";
import { get } from "node:http";
import { startWorkshopServer } from "./server.ts";

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

test("aborted artifact downloads close their file handles", { skip: process.platform !== "linux" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "dum-artifact-download-test-"));
  const reservations = [createServer(), createServer()];
  let workshop: Awaited<ReturnType<typeof startWorkshopServer>> | undefined;
  try {
    await Promise.all(reservations.map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
    const ports = reservations.map((server) => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      return address.port;
    });
    await Promise.all(reservations.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    workshop = await startWorkshopServer({ home, port: ports[0], artifactPort: ports[1] });
    await workshop.runner.stop();
    const goal = workshop.store.createGoal({ title: "Download fixture", ambition: "Test interrupted artifact transfers without a model call." });
    const teaching = workshop.store.teach(goal.id, { concept: "loops", text: "A loop visits each item." });
    workshop.store.enqueue(goal.id);
    const job = workshop.store.claimNextJob();
    assert.ok(job);
    workshop.store.completeJob(job.id, {
      title: "Download fixture, not a generated creation",
      panels: [{ caption: "Transport test payload", image: "payload.png", teachingIds: [teaching.id] }],
      verification: { command: "No generation or demo verification in this transport test", output: "Test fixture only" },
      supportingMachinery: [],
    });
    const artifactDir = join(home, "artifacts", job.artifactId!);
    await mkdir(artifactDir);
    await writeFile(join(artifactDir, "payload.png"), Buffer.alloc(4 * 1024 * 1024));
    const descriptorCount = async () => (await readdir(`/proc/${process.pid}/fd`)).length;
    const before = await descriptorCount();
    let peak = before;
    for (let i = 0; i < 40; i++) {
      await new Promise<void>((resolve, reject) => {
        const request = get(`http://127.0.0.1:${ports[1]}/artifacts/${job.id}/payload.png`, (response) => {
          assert.equal(response.statusCode, 200);
          response.once("data", () => { response.destroy(); request.destroy(); });
          response.once("close", resolve);
        });
        request.on("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      peak = Math.max(peak, await descriptorCount());
    }
    // Allow close callbacks and sockets to settle; file handles must close without a GC cycle.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(peak <= before + 4, "cancelled downloads accumulated open descriptors before GC");
    assert.ok(await descriptorCount() <= before + 2, "cancelled downloads retained open descriptors");
    const url = `http://127.0.0.1:${ports[1]}/artifacts/${job.id}/payload.png`;
    const complete = await fetch(url);
    assert.equal(complete.status, 200);
    assert.equal((await complete.arrayBuffer()).byteLength, 4 * 1024 * 1024);
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(4 * 1024 * 1024));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  } finally {
    await workshop?.stop();
    for (const server of reservations) if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

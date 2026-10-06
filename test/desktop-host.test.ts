import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test("a real teaching host isolates prompt epochs, excludes concurrent writers, and releases on close", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "dum-desktop-host-"));
  const root = join(dir, "project");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "counter.py"), "counter = 0\n");
  const children: ChildProcess[] = [];
  function launch() {
    const epoch = randomUUID();
    const child = fork(new URL("../src/desktop/host.ts", import.meta.url), [], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, DUM_HOST_EPOCH: epoch, DUM_HOME: join(dir, "private"), DUM_CONTEXT: "off" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    const messages: any[] = [];
    const listeners = new Set<() => void>();
    child.on("message", message => { messages.push(message); for (const listener of listeners) listener(); });
    return {
      child, epoch,
      send(id: string, value: object) { child.send({ epoch, id, ...value }); },
      async take(predicate: (value: any) => boolean): Promise<any> {
        const pending = Promise.withResolvers<any>();
        const inspect = () => {
          const index = messages.findIndex(predicate);
          if (index < 0) return;
          listeners.delete(inspect);
          pending.resolve(messages.splice(index, 1)[0]);
        };
        listeners.add(inspect);
        inspect();
        return pending.promise;
      },
    };
  }
  try {
    const first = launch();
    await first.take(message => message.type === "ready");
    first.send("open", { op: "open", root, personal: { path: "", text: "", warning: "" } });
    assert.equal((await first.take(message => message.type === "reply" && message.id === "open")).ok, true);
    const initial = await first.take(message => message.type === "state" && message.inputToken);
    assert.equal(initial.state.root, root);
    assert.equal(initial.canAttach, true);
    first.send("stale", { op: "send", text: "yes", inputToken: "stale-prompt" });
    assert.equal((await first.take(message => message.type === "reply" && message.id === "stale")).ok, false);
    first.send("remember", { op: "command", name: "remember", argument: "Use integer cents for money." });
    assert.equal((await first.take(message => message.type === "reply" && message.id === "remember")).ok, true);
    const remembered = await first.take(message => message.type === "state" && message.state?.transcript.some((entry: any) => entry.kind === "note" && entry.text.includes("integer cents")));
    assert.equal(remembered.state.transcript.some((entry: any) => entry.kind === "user" && entry.text === "yes"), false);

    const second = launch();
    await second.take(message => message.type === "ready");
    second.send("open", { op: "open", root, personal: { path: "", text: "", warning: "" } });
    const collision = await second.take(message => message.type === "reply" && message.id === "open");
    assert.equal(collision.ok, false);
    assert.match(collision.error, /already open|already running|another dum/i);
    second.send("close", { op: "close" });
    assert.equal((await second.take(message => message.type === "reply" && message.id === "close")).ok, true);

    first.send("close", { op: "close" });
    assert.equal((await first.take(message => message.type === "reply" && message.id === "close")).ok, true);
    const transcript = JSON.parse(readFileSync(join(root, ".dum", "transcript.json"), "utf8"));
    assert.equal(transcript.some((entry: any) => entry.kind === "note" && entry.text.includes("integer cents")), true);
    const third = launch();
    await third.take(message => message.type === "ready");
    third.send("open", { op: "open", root, personal: { path: "", text: "", warning: "" } });
    assert.equal((await third.take(message => message.type === "reply" && message.id === "open")).ok, true);
    const restored = await third.take(message => message.type === "state" && message.inputToken);
    assert.equal(restored.state.transcript.some((entry: any) => entry.kind === "note" && entry.text.includes("integer cents")), true);
    assert.notEqual(restored.inputToken, initial.inputToken);
    third.send("close", { op: "close" });
    assert.equal((await third.take(message => message.type === "reply" && message.id === "close")).ok, true);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once("exit", () => resolve()))));
    rmSync(dir, { recursive: true, force: true });
  }
});

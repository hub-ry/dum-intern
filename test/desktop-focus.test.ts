// Focus helper client against a scripted child process. The script stands where Resources/dum-focus
// lives; it relays its stdin to the test over a Unix socket and writes the test's replies to its stdout,
// so the test plays the native helper. Waits are on real arrivals, not a clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOCUS_HELPER, Focus } from "../src/desktop/focus.ts";

const PUPPET = `#!${process.execPath}
const net = require("node:net");
const path = require("node:path");
const sock = net.connect(path.join(__dirname, "puppet.sock"));
sock.write(JSON.stringify({ launch: { env: Object.keys(process.env) } }) + "\\n");
process.stdin.on("data", (d) => sock.write(d));
process.stdin.on("end", () => sock.end(JSON.stringify({ eof: true }) + "\\n", () => process.exit(0)));
sock.on("data", (d) => process.stdout.write(d));
sock.on("close", () => process.exit(3));
`;

type Json = Record<string, unknown>;

const it = (name: string, fn: () => Promise<void> | void) => test(name, { timeout: 10_000 }, fn);

/** The test's end of the scripted helper. */
class Helper {
  readonly root = mkdtempSync(join(tmpdir(), "dum-focus-"));
  readonly commands: (Json | "EOF")[] = [];
  launches = 0;
  private socket: Socket | null = null;
  private waiters = new Set<() => void>();
  private server: Server;

  constructor() {
    writeFileSync(join(this.root, FOCUS_HELPER), PUPPET);
    chmodSync(join(this.root, FOCUS_HELPER), 0o755);
    this.server = createServer((socket) => {
      this.socket = socket;
      let pending = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line: Json = JSON.parse(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (line.launch) this.launches++;
          else this.commands.push(line.eof ? "EOF" : line);
        }
        for (const wake of [...this.waiters]) wake();
      });
    });
    this.server.listen(join(this.root, "puppet.sock"));
  }

  async until<T>(check: () => T | undefined | false): Promise<T> {
    for (;;) {
      const value = check();
      if (value) return value;
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiters.add(resolve);
      await promise;
      this.waiters.delete(resolve);
    }
  }

  command(op: string, nth = 0): Promise<Json> {
    return this.until(() => this.commands.filter((c): c is Json => c !== "EOF" && c.op === op)[nth]);
  }

  raw(text: string): void {
    this.socket!.write(text);
  }

  say(event: object): void {
    this.raw(JSON.stringify(event) + "\n");
  }

  exit(): void {
    this.socket!.destroy();
  }

  close(): void {
    this.server.close();
  }
}

const focus = (h: Helper) => new Focus({ platform: "darwin", resourcesPath: h.root });

it("refuses to run off macOS or without a verified executable", async () => {
  const h = new Helper();
  await assert.rejects(new Focus({ platform: "linux", resourcesPath: h.root }).capture(), /macOS/);

  const empty = mkdtempSync(join(tmpdir(), "dum-focus-empty-"));
  await assert.rejects(new Focus({ platform: "darwin", resourcesPath: empty }).frontmost(), /missing/);

  const plain = new Helper();
  chmodSync(join(plain.root, FOCUS_HELPER), 0o644);
  await assert.rejects(focus(plain).capture(), /missing/);

  const linked = mkdtempSync(join(tmpdir(), "dum-focus-link-"));
  symlinkSync(join(h.root, FOCUS_HELPER), join(linked, FOCUS_HELPER));
  await assert.rejects(new Focus({ platform: "darwin", resourcesPath: linked }).capture(), /missing/);
  assert.equal(h.launches + plain.launches, 0);
  h.close();
  plain.close();
});

it("capture and restore round-trip a handle, with replies split and joined across writes", async () => {
  const h = new Helper();
  const f = focus(h);
  const captured = f.capture();
  const request = await h.command("capture");
  assert.deepEqual(Object.keys(request).sort(), ["id", "op"]);
  const reply = JSON.stringify({ op: "captured", id: request.id, handle: "h-1" }) + "\n";
  h.raw(reply.slice(0, 10));
  h.raw(reply.slice(10));
  assert.equal(await captured, "h-1");

  const first = f.restore("h-1");
  const second = f.frontmost();
  const restore = await h.command("restore");
  assert.equal(restore.handle, "h-1");
  const frontmost = await h.command("frontmost");
  // Both replies in one write, out of request order.
  h.raw(
    JSON.stringify({ op: "frontmost", id: frontmost.id, app: null }) + "\n" +
    JSON.stringify({ op: "restored", id: restore.id, ok: true }) + "\n",
  );
  assert.equal(await first, true);
  assert.equal(await second, null);

  // A handle this helper never issued is refused without asking it.
  assert.equal(await f.restore("never-issued"), false);
  assert.equal(h.commands.filter((c) => c !== "EOF" && c.op === "restore").length, 1);
  await f.close();
  h.close();
});

it("frontmost maps the app signal and rejects malformed ones", async () => {
  const h = new Helper();
  const f = focus(h);
  const app = { bundleId: "com.microsoft.VSCode", name: "Code", windowId: 4182 };
  const first = f.frontmost();
  h.say({ op: "frontmost", id: (await h.command("frontmost")).id, app });
  assert.deepEqual(await first, app);

  const second = f.frontmost();
  h.say({ op: "frontmost", id: (await h.command("frontmost", 1)).id, app: { ...app, bundleId: "bad id with spaces" } });
  await assert.rejects(second, /invalid/);
  await f.close();
  h.close();
});

it("unknown events and unsolicited replies stop the helper; its handles die with it", async () => {
  const h = new Helper();
  const f = focus(h);
  const captured = f.capture();
  h.say({ op: "captured", id: (await h.command("capture")).id, handle: "h-1" });
  assert.equal(await captured, "h-1");

  const pending = f.frontmost();
  await h.command("frontmost");
  h.say({ op: "focus-stolen", id: "x" });
  await assert.rejects(pending, /invalid/);
  assert.equal(await f.restore("h-1"), false, "a handle from a stopped helper is dead");

  // The next call starts a fresh helper; an unsolicited reply stops that one too.
  const again = f.frontmost();
  await h.until(() => h.launches === 2);
  const request = await h.command("frontmost", 1);
  h.say({ op: "restored", id: request.id, ok: true });
  await assert.rejects(again, /unexpected/);
  await f.close();
  h.close();
});

it("helper exit fails outstanding requests", async () => {
  const h = new Helper();
  const f = focus(h);
  const pending = f.capture();
  await h.command("capture");
  h.exit();
  await assert.rejects(pending, /stopped/);
  await f.close();
  h.close();
});

it("close sends shutdown, ends the pipe, and later calls are refused", async () => {
  const h = new Helper();
  const f = focus(h);
  const pending = f.frontmost();
  h.say({ op: "frontmost", id: (await h.command("frontmost")).id, app: null });
  await pending;
  await f.close();
  await h.command("shutdown");
  await h.until(() => h.commands.includes("EOF"));
  await assert.rejects(f.capture(), /shut down/);
  h.close();
});

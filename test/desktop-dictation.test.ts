// Voice bridge client against a scripted helper process. The "helper" is a small Node script installed
// where the bundled app's executable lives. It relays its stdin to the test over a Unix socket and writes
// whatever the test sends back to its stdout, so the test plays the native bridge line by line. No native
// app, network or model is involved, and every wait is on a real arrival, not a clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DICTATION_BRIDGE_VERSION, DICTATION_BUNDLE_ID, DictationHelper } from "../src/desktop/dictation.ts";
import type { VoiceEvent } from "../src/desktop/native-protocol.ts";
import type { InputBinding } from "../src/share-types.ts";

const PUPPET = `#!${process.execPath}
const net = require("node:net");
const path = require("node:path");
const sock = net.connect(path.join(__dirname, "..", "..", "..", "puppet.sock"));
sock.write(JSON.stringify({ launch: { argv: process.argv.slice(2), env: Object.keys(process.env) } }) + "\\n");
process.stdin.on("data", (d) => sock.write(d));
process.stdin.on("end", () => sock.end(JSON.stringify({ eof: true }) + "\\n", () => process.exit(0)));
sock.on("data", (d) => process.stdout.write(d));
sock.on("close", () => process.exit(3));
`;

type Json = Record<string, unknown>;
type Plist = Record<string, string>;
const GOOD: Plist = {
  CFBundleIdentifier: DICTATION_BUNDLE_ID,
  CFBundleShortVersionString: "0.1.0",
  CFBundleExecutable: "OpenSuperWhisper",
  DumBridgeVersion: DICTATION_BRIDGE_VERSION,
};

const it = (name: string, fn: () => Promise<void> | void) => test(name, { timeout: 10_000 }, fn);

function plist(values: Plist): string {
  const entries = Object.entries(values).map(([k, v]) => `\t<key>${k}</key>\n\t<string>${v}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${entries}\n</dict>\n</plist>\n`;
}

/** A Resources directory holding a scripted helper bundle. */
function resources(values: Plist = GOOD): string {
  const root = mkdtempSync(join(tmpdir(), "dum-dictation-"));
  const macos = join(root, "OpenSuperWhisper.app", "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  writeFileSync(join(macos, "OpenSuperWhisper"), PUPPET);
  chmodSync(join(macos, "OpenSuperWhisper"), 0o755);
  writeFileSync(join(root, "OpenSuperWhisper.app", "Contents", "Info.plist"), plist(values));
  return root;
}

const mac = (resourcesPath: string, over: Partial<{ platform: string; arch: string; systemVersion: string }> = {}) =>
  new DictationHelper({ platform: "darwin", arch: "arm64", systemVersion: "14.5", resourcesPath, ...over });

/** The test's end of the scripted helper, plus the events the client emitted. */
class Bridge {
  readonly commands: (Json | "EOF")[] = [];
  readonly launches: { argv: string[]; env: string[] }[] = [];
  readonly events: VoiceEvent[] = [];
  private socket: Socket | null = null;
  private waiters = new Set<() => void>();
  private server: Server;

  constructor(root: string) {
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
          if (line.launch) this.launches.push(line.launch as { argv: string[]; env: string[] });
          else this.commands.push(line.eof ? "EOF" : line);
        }
        this.changed();
      });
    });
    this.server.listen(join(root, "puppet.sock"));
  }

  changed(): void {
    for (const wake of [...this.waiters]) wake();
  }

  /** Resolves with the first truthy value of `check`, re-checked whenever something arrives. */
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

  event<K extends VoiceEvent["op"]>(op: K): Promise<Extract<VoiceEvent, { op: K }>> {
    return this.until(() => this.events.find((e): e is Extract<VoiceEvent, { op: K }> => e.op === op));
  }

  say(event: object): void {
    this.raw(JSON.stringify(event) + "\n");
  }

  raw(text: string): void {
    this.socket!.write(text);
  }

  /** The helper process exits on its own. */
  exit(): void {
    this.socket!.destroy();
  }

  close(): void {
    this.server.close();
  }
}

const binding: InputBinding = { zoneId: "6f1c2a7e-1b2c-4d3e-8f40-0123456789ab", zoneEpoch: "e1", inputToken: "t1", requestId: "r1" };

function ready(nonce: unknown, over: object = {}) {
  return { op: "ready", version: 1, nonce, bridgeVersion: DICTATION_BRIDGE_VERSION, modelReady: true, microphoneStatus: "granted", shortcutStatus: "set", ...over };
}

type Running = { helper: DictationHelper; bridge: Bridge; hello: Json };

/** A helper started through configure() with a completed handshake. */
async function running(root = resources()): Promise<Running> {
  const helper = mac(root);
  const bridge = new Bridge(root);
  helper.onEvent((e) => {
    bridge.events.push(e);
    bridge.changed();
  });
  const configured = helper.configure("Control+Option+Space");
  const hello = await bridge.command("hello");
  bridge.say(ready(hello.nonce));
  await configured;
  return { helper, bridge, hello };
}

/** Press g1 and authorize it; returns the recording ID main chose. */
async function pressAndBegin({ helper, bridge }: Running): Promise<string> {
  bridge.say({ op: "pressed", gestureId: "g1" });
  await bridge.event("pressed");
  await helper.start(binding, "g1");
  const begin = await bridge.command("begin");
  return String(begin.recordingId);
}

async function done({ helper, bridge }: Running): Promise<void> {
  await helper.close();
  bridge.close();
}

it("status refuses other platforms and macOS before 14", () => {
  const root = resources();
  for (const over of [{ platform: "linux", arch: "x64" }, { arch: "x64" }, { systemVersion: "13.6" }, { systemVersion: "garbage" }]) {
    const status = mac(root, over).status();
    assert.deepEqual([status.supported, status.available, status.bridge], [false, false, false], JSON.stringify(over));
  }
});

it("status verifies bundle identity, versions, executable mode and containment", () => {
  const ok = mac(resources()).status();
  assert.deepEqual([ok.supported, ok.available, ok.bridge, ok.version], [true, true, false, "0.1.0"]);

  const bad: Plist[] = [
    { ...GOOD, CFBundleIdentifier: "ru.starmel.OpenSuperWhisper" },
    { ...GOOD, CFBundleShortVersionString: "0.0.9" },
    { ...GOOD, DumBridgeVersion: "2" },
    { ...GOOD, CFBundleExecutable: "Other" },
  ];
  for (const values of bad) assert.equal(mac(resources(values)).status().available, false, JSON.stringify(values));

  const plain = resources();
  chmodSync(join(plain, "OpenSuperWhisper.app", "Contents", "MacOS", "OpenSuperWhisper"), 0o644);
  assert.equal(mac(plain).status().available, false, "non-executable helper");

  const binary = resources();
  writeFileSync(join(binary, "OpenSuperWhisper.app", "Contents", "Info.plist"), "bplist00" + plist(GOOD));
  assert.equal(mac(binary).status().available, false, "binary plist is not trusted");

  const outside = resources();
  const linked = mkdtempSync(join(tmpdir(), "dum-dictation-link-"));
  symlinkSync(join(outside, "OpenSuperWhisper.app"), join(linked, "OpenSuperWhisper.app"));
  assert.equal(mac(linked).status().available, false, "app directory linked from outside Resources");

  const exeLink = resources();
  const macos = join(exeLink, "OpenSuperWhisper.app", "Contents", "MacOS");
  writeFileSync(join(macos, "real"), PUPPET);
  chmodSync(join(macos, "real"), 0o755);
  rmSync(join(macos, "OpenSuperWhisper"));
  symlinkSync(join(macos, "real"), join(macos, "OpenSuperWhisper"));
  assert.equal(mac(exeLink).status().available, false, "executable is a link");

  assert.equal(mac(mkdtempSync(join(tmpdir(), "dum-dictation-empty-"))).status().available, false, "missing bundle");
});

it("launch handshake: bridge flag, private environment, nonce echo, then the hotkey", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-secret-not-for-helpers";
  try {
    const t = await running();
    const [launch] = t.bridge.launches;
    assert.deepEqual(launch!.argv, ["--dum-bridge"]);
    assert.ok(!launch!.env.includes("ANTHROPIC_API_KEY"), "secrets stay out of the helper environment");
    assert.equal(t.hello.version, 1);
    assert.match(String(t.hello.nonce), /^[0-9a-f-]{36}$/);
    assert.deepEqual(await t.bridge.command("configure"), { op: "configure", voiceHotkey: "Control+Option+Space" });
    assert.equal(t.helper.status().bridge, true);
    await t.bridge.event("ready");
    await done(t);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

it("a ready with the wrong nonce stops the helper and fails the call", async () => {
  const root = resources();
  const helper = mac(root);
  const bridge = new Bridge(root);
  const configured = helper.configure("Control+Option+Space");
  await bridge.command("hello");
  bridge.say(ready("some-other-launch"));
  await assert.rejects(configured);
  assert.equal(helper.status().bridge, false);
  await done({ helper, bridge, hello: {} });
});

it("a different bridge version turns voice off until restart", async () => {
  const root = resources();
  const helper = mac(root);
  const bridge = new Bridge(root);
  const configured = helper.configure("Control+Option+Space");
  const hello = await bridge.command("hello");
  bridge.say(ready(hello.nonce, { bridgeVersion: "999" }));
  await assert.rejects(configured);
  assert.equal(helper.status().available, false);
  await assert.rejects(helper.setup());
  assert.equal(bridge.launches.length, 1, "no relaunch after a version mismatch");
  await done({ helper, bridge, hello });
});

it("press, authorize, release: begin carries the binding and events arrive in order", async () => {
  const t = await running();
  const id = await pressAndBegin(t);
  assert.deepEqual(await t.bridge.command("begin"), { op: "begin", gestureId: "g1", recordingId: id, binding });
  t.bridge.say({ op: "recording", recordingId: id, binding });
  t.bridge.say({ op: "released", gestureId: "g1" });
  t.bridge.say({ op: "transcribing", recordingId: id, binding });
  t.bridge.say({ op: "transcript", recordingId: id, binding, text: "explain recursion" });
  const transcript = await t.bridge.event("transcript");
  assert.equal(transcript.text, "explain recursion");
  assert.deepEqual(t.bridge.events.filter((e) => e.op !== "ready").map((e) => e.op), ["pressed", "recording", "released", "transcribing", "transcript"]);
  // The finished flight is over: it can't be stopped, and a new one may start.
  await assert.rejects(t.helper.stop(id));
  await t.helper.start(binding, null);
  await done(t);
});

it("a release before authorization means the press can no longer start a recording", async () => {
  const t = await running();
  t.bridge.say({ op: "pressed", gestureId: "g1" });
  t.bridge.say({ op: "released", gestureId: "g1" });
  await t.bridge.event("released");
  await assert.rejects(t.helper.start(binding, "g1"), /ended/);
  await t.helper.setup();
  await t.bridge.command("setup");
  assert.ok(!t.bridge.commands.some((c) => c !== "EOF" && c.op === "begin"));
  await done(t);
});

it("the helper cancelling a begin that lost its key-up race ends the flight", async () => {
  const t = await running();
  const id = await pressAndBegin(t);
  t.bridge.say({ op: "released", gestureId: "g1" });
  t.bridge.say({ op: "cancelled", recordingId: id });
  await t.bridge.event("cancelled");
  await t.helper.start(binding, null);
  await done(t);
});

it("a repeated press while one is held is rejected and the held press is released", async () => {
  const t = await running();
  t.bridge.say({ op: "pressed", gestureId: "g1" });
  t.bridge.say({ op: "pressed", gestureId: "g2" });
  const stopped = await t.bridge.event("error");
  assert.equal(stopped.code, "helper-stopped");
  assert.equal(t.bridge.events.filter((e) => e.op === "pressed").length, 1);
  assert.ok(t.bridge.events.some((e) => e.op === "released" && e.gestureId === "g1"));
  assert.equal(t.helper.status().bridge, false);
  await done(t);
});

it("a transcript bound to another prompt is never delivered", async () => {
  const t = await running();
  const id = await pressAndBegin(t);
  t.bridge.say({ op: "recording", recordingId: id, binding });
  t.bridge.say({ op: "transcribing", recordingId: id, binding });
  t.bridge.say({ op: "transcript", recordingId: id, binding: { ...binding, inputToken: "t2" }, text: "for another prompt" });
  const stopped = await t.bridge.event("error");
  assert.deepEqual([stopped.recordingId, stopped.code], [id, "helper-stopped"]);
  assert.ok(!t.bridge.events.some((e) => e.op === "transcript"));
  await done(t);
});

it("an oversized transcript or an unreadable line stops the helper", async () => {
  const big = await running();
  const id = await pressAndBegin(big);
  big.bridge.say({ op: "recording", recordingId: id, binding });
  big.bridge.say({ op: "transcribing", recordingId: id, binding });
  big.bridge.say({ op: "transcript", recordingId: id, binding, text: "x".repeat(32 * 1024 + 1) });
  await big.bridge.event("error");
  assert.ok(!big.bridge.events.some((e) => e.op === "transcript"));
  await done(big);

  const junk = await running();
  junk.bridge.raw("not json\n");
  await junk.bridge.event("error");
  assert.equal(junk.helper.status().bridge, false);
  await done(junk);
});

it("cancel ends the flight at once and drops the helper's late output for it", async () => {
  const t = await running();
  const id = await pressAndBegin(t);
  t.bridge.say({ op: "recording", recordingId: id, binding });
  await t.bridge.event("recording");
  await t.helper.cancel(id);
  assert.deepEqual(t.bridge.events.at(-1), { op: "cancelled", recordingId: id });
  assert.deepEqual(await t.bridge.command("cancel"), { op: "cancel", recordingId: id });
  // The helper had already finished: its late transcript and its reply to the cancel are ignored.
  t.bridge.say({ op: "transcribing", recordingId: id, binding });
  t.bridge.say({ op: "transcript", recordingId: id, binding, text: "too late" });
  t.bridge.say({ op: "error", recordingId: id, code: "unknown-recording", message: "That recording is no longer active." });
  t.bridge.say({ op: "released", gestureId: "g1" });
  await t.bridge.event("released");
  assert.ok(!t.bridge.events.some((e) => e.op === "transcript" || e.op === "error"));
  assert.equal(t.helper.status().bridge, true, "late output is not a protocol failure");
  await done(t);
});

it("mouse start and stop; a second start and a stale stop are refused", async () => {
  const t = await running();
  await t.helper.start(binding, null);
  const begin = await t.bridge.command("begin");
  assert.equal(begin.gestureId, null);
  const id = String(begin.recordingId);
  await assert.rejects(t.helper.start(binding, null), /already/);
  await assert.rejects(t.helper.stop("some-old-recording"));
  t.bridge.say({ op: "recording", recordingId: id, binding });
  await t.bridge.event("recording");
  await t.helper.stop(id);
  assert.deepEqual(await t.bridge.command("stop"), { op: "stop", recordingId: id });
  await done(t);
});

it("helper exit mid-recording ends the flight and the held press", async () => {
  const t = await running();
  const id = await pressAndBegin(t);
  t.bridge.say({ op: "recording", recordingId: id, binding });
  await t.bridge.event("recording");
  t.bridge.exit();
  const stopped = await t.bridge.event("error");
  assert.equal(stopped.recordingId, id);
  assert.ok(t.bridge.events.some((e) => e.op === "released" && e.gestureId === "g1"));
  assert.equal(t.helper.status().bridge, false);
  await done(t);
});

it("transcripts never reach the console", async () => {
  const seen: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
  try {
    const t = await running();
    const id = await pressAndBegin(t);
    t.bridge.say({ op: "recording", recordingId: id, binding });
    t.bridge.say({ op: "transcribing", recordingId: id, binding });
    t.bridge.say({ op: "transcript", recordingId: id, binding, text: "my private sentence" });
    await t.bridge.event("transcript");
    await done(t);
  } finally {
    methods.forEach((m, i) => (console[m] = original[i]!));
  }
  assert.ok(!seen.some((line) => line.includes("my private sentence")));
});

it("close sends shutdown and closes the pipe", async () => {
  const t = await running();
  await t.helper.close();
  await t.bridge.command("shutdown");
  await t.bridge.until(() => t.bridge.commands.includes("EOF"));
  await assert.rejects(t.helper.setup());
  t.bridge.close();
});

// Main's side of the voice bridge: the controlled OpenSuperWhisper helper built from
// vendor/OpenSuperWhisper in bridge mode (tools/prepare-dictation.mjs).
//
// The helper is a child process on private stdin/stdout pipes, one JSON object per line, with a launch
// nonce and bridge-version handshake. It owns the native push-to-talk shortcut: a press arrives as
// `pressed`, main authorizes it with `start(binding, gestureId)`, release stops and transcribes locally,
// and the final text arrives as `transcript` bound to the same recording and binding. Main validates every
// line against VoiceEventSchema and the live flight; anything else stops the helper. Transcript text is
// handed to listeners only and is never logged here.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import { InputBindingSchema, TokenSchema, type InputBinding } from "../share-types.ts";
import { accelerator } from "./protocol.ts";
import { VoiceEventSchema, type DictationStatus, type VoiceCommand, type VoiceEvent } from "./native-protocol.ts";

/** The helper app inside Electron's Resources directory. */
export const DICTATION_APP = "OpenSuperWhisper.app";
/** A distinct bundle ID, so the helper never shares permissions or settings with a stock OpenSuperWhisper. */
export const DICTATION_BUNDLE_ID = "com.dumintern.opensuperwhisper";
/** Pinned upstream release (commit e406fee45c281fe358b27698bbfca3826e8e4a28). */
export const DICTATION_RELEASE = "0.1.0";
/** Must match `DumBridgeVersion` in the bundle and `bridgeVersion` in the handshake. */
export const DICTATION_BRIDGE_VERSION = "1";

const EXECUTABLE = "OpenSuperWhisper";
const HANDSHAKE_MS = 15_000;
const CLOSE_MS = 3_000;
/** A 32 KiB transcript can grow when JSON-escaped; nothing legitimate comes near this. */
const MAX_LINE = 256 * 1024;
const MAX_PLIST = 64 * 1024;
const RETIRED = 16;
/** The helper needs a home, temp dir and locale; it gets nothing else from Dum's environment. */
const HELPER_ENV = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"];

export type DictationPorts = {
  platform: string;
  arch: string;
  /** macOS product version, from Electron's process.getSystemVersion(). */
  systemVersion: string;
  /** Electron's Resources directory (process.resourcesPath). */
  resourcesPath: string;
};

type Ready = Extract<VoiceEvent, { op: "ready" }>;
type Flight = { id: string; binding: InputBinding; phase: "starting" | "recording" | "transcribing" };
type Bundle = { executable: string; version: string };
type Session = {
  child: ChildProcessByStdio<Writable, Readable, null>;
  nonce: string;
  ready: Ready | null;
  handshake: Promise<void>;
};

function inside(path: string, root: string): boolean {
  return path.startsWith(root + sep);
}

/** String values of top-level-looking `<key>…</key><string>…</string>` pairs in an XML property list. */
function plistStrings(file: string): Map<string, string> | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(MAX_PLIST + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > MAX_PLIST) return null;
    const xml = buffer.subarray(0, size).toString("utf8");
    if (!xml.trimStart().startsWith("<?xml")) return null;
    const out = new Map<string, string>();
    const entity = (s: string) =>
      s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    for (const m of xml.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
      const key = entity(m[1]!);
      if (!out.has(key)) out.set(key, entity(m[2]!).trim());
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

function sameBinding(a: InputBinding, b: InputBinding): boolean {
  return a.zoneId === b.zoneId && a.zoneEpoch === b.zoneEpoch && a.inputToken === b.inputToken && a.requestId === b.requestId;
}

export class DictationHelper {
  private session: Session | null = null;
  private listeners = new Set<(event: VoiceEvent) => void>();
  private flight: Flight | null = null;
  private pressed: string | null = null;
  private retired: string[] = [];
  private voiceHotkey: string | null = null;
  /** Set when the helper answered with the wrong bridge version: it stays off until Dum restarts. */
  private broken: string | null = null;
  private stopped: string | null = null;
  private closed = false;

  constructor(private readonly ports: DictationPorts) {}

  /** Platform, bundle and bridge state. Safe on every platform; never claims more than was checked. */
  status(): DictationStatus {
    const { platform, arch, systemVersion } = this.ports;
    if (platform !== "darwin" || arch !== "arm64") {
      return {
        supported: false, available: false, version: null, bridge: false,
        message: "Voice needs macOS 14 or later on Apple Silicon. Everything voice does also works from the keyboard.",
      };
    }
    const major = /^(\d+)\./.exec(systemVersion);
    if (!major || Number(major[1]) < 14) {
      return {
        supported: false, available: false, version: null, bridge: false,
        message: "Voice needs macOS 14 or later. Everything voice does also works from the keyboard.",
      };
    }
    const bundle = this.bundle();
    if (typeof bundle === "string") return { supported: true, available: false, version: null, bridge: false, message: bundle };
    if (this.broken) return { supported: true, available: false, version: bundle.version, bridge: false, message: this.broken };
    const ready = this.session?.ready;
    if (!ready) {
      return {
        supported: true, available: true, version: bundle.version, bridge: false,
        message: this.stopped ?? "The voice helper starts when voice is configured or used.",
      };
    }
    return { supported: true, available: true, version: bundle.version, bridge: true, message: this.readiness(ready) };
  }

  /** Starts the helper if needed and sets the push-to-talk shortcut. The helper reports `shortcutStatus`. */
  async configure(voiceHotkey: string): Promise<void> {
    if (!accelerator(voiceHotkey)) throw new Error("That voice shortcut is not a valid shortcut.");
    this.voiceHotkey = voiceHotkey;
    const fresh = !this.session;
    await this.ensure();
    // A freshly started helper is configured by ensure() itself.
    if (!fresh) this.send({ op: "configure", voiceHotkey });
  }

  /** Opens the helper's own setup window: microphone permission, language and speech model. */
  async setup(): Promise<void> {
    await this.ensure();
    this.send({ op: "setup" });
  }

  /**
   * Authorizes one recording for `binding`. A gesture ID must be the press the helper reported and has not
   * released; null is a deliberate mouse start, ended by stop(). Events report the recording ID.
   */
  async start(binding: InputBinding, gestureId: string | null): Promise<void> {
    const checked = InputBindingSchema.parse(binding);
    if (gestureId !== null) TokenSchema.parse(gestureId);
    await this.ensure();
    if (this.flight) throw new Error("A recording is already in progress.");
    if (gestureId !== null && gestureId !== this.pressed) throw new Error("That voice key press has already ended.");
    const id = randomUUID();
    this.flight = { id, binding: checked, phase: "starting" };
    this.send({ op: "begin", gestureId, recordingId: id, binding: checked });
  }

  /** Ends capture and transcribes. Only the live recording can be stopped. */
  async stop(recordingId: string): Promise<void> {
    if (this.flight?.id !== recordingId) throw new Error("That recording is no longer active.");
    if (this.flight.phase === "transcribing") return;
    this.send({ op: "stop", recordingId });
  }

  /** Discards the live recording (or the given one, if it is still live). Late helper output for it is dropped. */
  async cancel(recordingId?: string): Promise<void> {
    const flight = this.flight;
    if (!flight || (recordingId !== undefined && recordingId !== flight.id)) return;
    this.retire(flight.id);
    this.send({ op: "cancel", recordingId: flight.id });
    this.emit({ op: "cancelled", recordingId: flight.id });
  }

  onEvent(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    const session = this.session;
    if (!session) return;
    const { promise: exited, resolve } = Promise.withResolvers<void>();
    if (session.child.exitCode !== null || session.child.signalCode !== null) resolve();
    else session.child.once("exit", () => resolve());
    this.send({ op: "shutdown" });
    session.child.stdin.end();
    const timer = setTimeout(() => session.child.kill("SIGKILL"), CLOSE_MS);
    await exited;
    clearTimeout(timer);
  }

  // ── bundle ────────────────────────────────────────────────────────────────

  /** The verified helper executable, or why there is none. */
  private bundle(): Bundle | string {
    const missing = "The voice helper is missing from this build. Reinstall Dum to restore it.";
    try {
      const root = realpathSync(this.ports.resourcesPath);
      const app = join(root, DICTATION_APP);
      if (!lstatSync(app).isDirectory()) return missing;
      const realApp = realpathSync(app);
      if (!inside(realApp, root)) return missing;
      const plist = plistStrings(join(realApp, "Contents", "Info.plist"));
      if (!plist) return "The voice helper's bundle information can't be read. Reinstall Dum.";
      if (plist.get("CFBundleIdentifier") !== DICTATION_BUNDLE_ID) return "The bundled voice helper is not Dum's voice helper. Reinstall Dum.";
      const version = plist.get("CFBundleShortVersionString") ?? "";
      if (version !== DICTATION_RELEASE) return `The bundled voice helper is version ${version || "unknown"}, not ${DICTATION_RELEASE}. Reinstall Dum.`;
      if (plist.get("DumBridgeVersion") !== DICTATION_BRIDGE_VERSION) return "The bundled voice helper speaks a different bridge version. Reinstall Dum.";
      if (plist.get("CFBundleExecutable") !== EXECUTABLE) return "The bundled voice helper has an unexpected executable. Reinstall Dum.";
      const executable = join(realApp, "Contents", "MacOS", EXECUTABLE);
      const stat = lstatSync(executable);
      if (!stat.isFile()) return "The voice helper's executable is missing or a link. Reinstall Dum.";
      if ((stat.mode & 0o100) === 0) return "The voice helper's executable is not executable. Reinstall Dum.";
      if (!inside(realpathSync(executable), realApp)) return missing;
      return { executable, version };
    } catch {
      return missing;
    }
  }

  private readiness(ready: Ready): string {
    if (ready.microphoneStatus === "denied" || ready.microphoneStatus === "restricted") {
      // macOS may list the helper's permission under Dum (its parent process) rather than under the helper.
      return "Microphone access is off for Dum's voice helper. Turn it on for Dum in System Settings > Privacy & Security > Microphone.";
    }
    if (ready.microphoneStatus === "no-device") return "No microphone is connected.";
    if (ready.microphoneStatus !== "granted") return "Open voice setup to allow the microphone.";
    if (!ready.modelReady) return "Open voice setup to choose a speech model.";
    if (ready.shortcutStatus === "invalid") return "The voice helper can't use that voice shortcut. Choose another one.";
    if (ready.shortcutStatus !== "set") return "Voice is ready from the menu. Set a voice shortcut to talk hands-on-keyboard.";
    return "Hold the voice shortcut and talk. Your words go into the draft; nothing is sent until you press Send.";
  }

  // ── process ───────────────────────────────────────────────────────────────

  private async ensure(): Promise<void> {
    if (this.closed) throw new Error("Voice is shut down.");
    if (this.session) return this.session.handshake;
    const status = this.status();
    if (!status.available) throw new Error(status.message);
    const bundle = this.bundle();
    if (typeof bundle === "string") throw new Error(bundle);

    const env: NodeJS.ProcessEnv = {};
    for (const key of HELPER_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(bundle.executable, ["--dum-bridge"], { stdio: ["pipe", "pipe", "inherit"], env });
    const nonce = randomUUID();
    const { promise: handshake, ...settle } = Promise.withResolvers<void>();
    handshake.catch(() => {});
    const session: Session = { child, nonce, ready: null, handshake };
    this.session = session;
    this.stopped = null;

    const timer = setTimeout(() => this.fail(session, "The voice helper did not answer.", false), HANDSHAKE_MS);
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0 && this.session === session) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length > MAX_LINE) return this.fail(session, "The voice helper sent an oversized message.", false);
        const first = !session.ready;
        this.receive(session, line);
        if (first && session.ready && this.session === session) {
          clearTimeout(timer);
          if (this.voiceHotkey) this.send({ op: "configure", voiceHotkey: this.voiceHotkey });
          settle.resolve();
        }
      }
      if (pending.length > MAX_LINE) this.fail(session, "The voice helper sent an oversized message.", false);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => this.exited(session, "The voice helper could not start."));
    child.on("exit", () => this.exited(session, "The voice helper stopped. It starts again the next time voice is used."));
    child.once("exit", () => {
      clearTimeout(timer);
      settle.reject(new Error(this.broken ?? this.stopped ?? "The voice helper stopped."));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      settle.reject(error);
    });

    this.send({ op: "hello", version: 1, nonce });
    return handshake;
  }

  private send(command: VoiceCommand): void {
    const session = this.session;
    if (!session || session.child.stdin.destroyed || !session.child.stdin.writable) return;
    session.child.stdin.write(JSON.stringify(command) + "\n");
  }

  /** Protocol failure: stop the helper. `permanent` keeps voice off until Dum restarts. */
  private fail(session: Session, message: string, permanent: boolean): void {
    if (this.session !== session) return;
    if (permanent) this.broken = message;
    this.exited(session, message);
    session.child.kill("SIGKILL");
  }

  /** Clears the session once and reports anything that was in flight as ended. */
  private exited(session: Session, message: string): void {
    if (this.session !== session) return;
    this.session = null;
    this.stopped = message;
    const flight = this.flight;
    const pressed = this.pressed;
    this.flight = null;
    this.pressed = null;
    if (pressed) this.emit({ op: "released", gestureId: pressed });
    if (flight) this.retire(flight.id);
    this.emit(flight
      ? { op: "error", recordingId: flight.id, code: "helper-stopped", message }
      : { op: "error", code: "helper-stopped", message });
  }

  private retire(id: string): void {
    if (this.flight?.id === id) this.flight = null;
    this.retired.push(id);
    if (this.retired.length > RETIRED) this.retired.shift();
  }

  private emit(event: VoiceEvent): void {
    if (this.closed) return;
    for (const listener of [...this.listeners]) listener(event);
  }

  // ── events ────────────────────────────────────────────────────────────────

  private receive(session: Session, line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return this.fail(session, "The voice helper sent an unreadable message and was stopped.", false);
    }
    const parsed = VoiceEventSchema.safeParse(raw);
    if (!parsed.success) return this.fail(session, "The voice helper sent an invalid message and was stopped.", false);
    const event = parsed.data;
    if (event.op === "ready") {
      if (event.nonce !== session.nonce) return this.fail(session, "The voice helper answered the wrong launch.", false);
      if (event.bridgeVersion !== DICTATION_BRIDGE_VERSION) {
        return this.fail(session, "The voice helper speaks a different bridge version. Reinstall Dum.", true);
      }
      session.ready = event;
      return this.emit(event);
    }
    if (!session.ready) return this.fail(session, "The voice helper spoke before its handshake.", false);
    if (this.accept(event)) return this.emit(event);
    // Output for a recording main already ended (cancelled, or after its terminal event) is dropped quietly.
    const late = "recordingId" in event && event.recordingId !== undefined && this.retired.includes(event.recordingId);
    if (!late) this.fail(session, "The voice helper sent an unexpected message and was stopped.", false);
  }

  /** Applies a correlated event to the gesture and flight state; false if it does not fit. */
  private accept(event: Exclude<VoiceEvent, Ready>): boolean {
    const flight = this.flight;
    switch (event.op) {
      case "pressed":
        if (this.pressed) return false;
        this.pressed = event.gestureId;
        return true;
      case "released":
        if (this.pressed !== event.gestureId) return false;
        this.pressed = null;
        return true;
      case "recording":
        if (flight?.id !== event.recordingId || flight.phase !== "starting" || !sameBinding(flight.binding, event.binding)) return false;
        flight.phase = "recording";
        return true;
      case "transcribing":
        if (flight?.id !== event.recordingId || flight.phase !== "recording" || !sameBinding(flight.binding, event.binding)) return false;
        flight.phase = "transcribing";
        return true;
      case "transcript":
        if (flight?.id !== event.recordingId || flight.phase !== "transcribing" || !sameBinding(flight.binding, event.binding)) return false;
        this.retire(flight.id);
        return true;
      case "cancelled":
        if (flight?.id !== event.recordingId) return false;
        this.retire(flight.id);
        return true;
      case "error":
        if (event.recordingId === undefined) return true;
        if (flight?.id !== event.recordingId) return false;
        this.retire(flight.id);
        return true;
    }
  }
}

// Main's side of the universal focus helper (native/macos/FocusBridge.swift, bundled as Resources/dum-focus).
//
// The helper is a child process on private stdin/stdout pipes, one JSON object per line. It captures the
// frontmost app as an opaque handle, reactivates a captured app, and reports the frontmost app for the
// look. Every reply is validated against FocusEventSchema and must answer a request this process sent;
// anything else stops the helper. Handles are only good for the helper lifetime that issued them.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { AppSignal } from "../observe-types.ts";
import { FocusEventSchema, type FocusBridge, type FocusCommand, type FocusEvent } from "./native-protocol.ts";

/** The universal executable inside Electron's Resources directory. */
export const FOCUS_HELPER = "dum-focus";

const REPLY_MS = 3_000;
const CLOSE_MS = 2_000;
const MAX_LINE = 8 * 1024;

export type FocusPorts = {
  platform: string;
  /** Electron's Resources directory (process.resourcesPath). */
  resourcesPath: string;
};

type Pending = { op: FocusEvent["op"]; resolve: (event: FocusEvent) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Helper = { child: ChildProcessByStdio<Writable, Readable, null>; handles: Set<string> };

export class Focus implements FocusBridge {
  private helper: Helper | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;

  constructor(private readonly ports: FocusPorts) {}

  async capture(): Promise<string> {
    const helper = this.ensure();
    const reply = await this.request(helper, (id) => ({ op: "capture", id }), "captured");
    if (reply.op !== "captured") throw new Error("The focus helper answered out of order.");
    helper.handles.add(reply.handle);
    return reply.handle;
  }

  /** False for a handle from an earlier helper lifetime, an app that quit, or a refused activation. */
  async restore(handle: string): Promise<boolean> {
    const helper = this.helper;
    if (!helper?.handles.has(handle)) return false;
    const reply = await this.request(helper, (id) => ({ op: "restore", id, handle }), "restored");
    return reply.op === "restored" && reply.ok;
  }

  async frontmost(): Promise<AppSignal | null> {
    const reply = await this.request(this.ensure(), (id) => ({ op: "frontmost", id }), "frontmost");
    if (reply.op !== "frontmost") throw new Error("The focus helper answered out of order.");
    return reply.app;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const helper = this.helper;
    if (!helper) return;
    const { child } = helper;
    const { promise: exited, resolve } = Promise.withResolvers<void>();
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
    this.write(helper, { op: "shutdown" });
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), CLOSE_MS);
    await exited;
    clearTimeout(timer);
  }

  /** The running helper, started on first use. */
  private ensure(): Helper {
    if (this.closed) throw new Error("Focus is shut down.");
    if (this.helper) return this.helper;
    if (this.ports.platform !== "darwin") throw new Error("Restoring app focus needs macOS.");
    const missing = "The focus helper is missing from this build. Reinstall Dum to restore it.";
    let executable: string;
    try {
      const root = realpathSync(this.ports.resourcesPath);
      executable = join(root, FOCUS_HELPER);
      const stat = lstatSync(executable);
      if (!stat.isFile() || (stat.mode & 0o100) === 0 || !realpathSync(executable).startsWith(root + sep)) throw new Error(missing);
    } catch {
      throw new Error(missing);
    }

    // AppKit wants a home and locale; nothing else from Dum's environment reaches the helper.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "USER", "TMPDIR", "LANG"]) if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "ignore"], env });
    const helper: Helper = { child, handles: new Set() };
    this.helper = helper;
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0 && this.helper === helper) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length > MAX_LINE) return this.stop(helper, "The focus helper sent an oversized message.");
        this.receive(helper, line);
      }
      if (buffered.length > MAX_LINE) this.stop(helper, "The focus helper sent an oversized message.");
    });
    child.stdin.on("error", () => {});
    child.on("error", () => this.stop(helper, "The focus helper could not start."));
    child.on("exit", () => this.stop(helper, "The focus helper stopped."));
    return helper;
  }

  private request(helper: Helper, command: (id: string) => FocusCommand, op: FocusEvent["op"]): Promise<FocusEvent> {
    if (this.helper !== helper) return Promise.reject(new Error("The focus helper stopped."));
    const id = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<FocusEvent>();
    const timer = setTimeout(() => this.stop(helper, "The focus helper did not answer."), REPLY_MS);
    this.pending.set(id, { op, resolve, reject, timer });
    this.write(helper, command(id));
    return promise;
  }

  private write(helper: Helper, command: FocusCommand): void {
    if (helper.child.stdin.writable) helper.child.stdin.write(JSON.stringify(command) + "\n");
  }

  private receive(helper: Helper, line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return this.stop(helper, "The focus helper sent an unreadable message.");
    }
    const parsed = FocusEventSchema.safeParse(raw);
    if (!parsed.success) return this.stop(helper, "The focus helper sent an invalid message.");
    const event = parsed.data;
    const waiting = this.pending.get(event.id);
    if (!waiting || waiting.op !== event.op) return this.stop(helper, "The focus helper sent an unexpected message.");
    this.pending.delete(event.id);
    clearTimeout(waiting.timer);
    waiting.resolve(event);
  }

  /** Ends this helper lifetime: kill it, forget its handles, and fail every outstanding request. */
  private stop(helper: Helper, message: string): void {
    if (this.helper !== helper) return;
    this.helper = null;
    helper.handles.clear();
    if (helper.child.exitCode === null && helper.child.signalCode === null) helper.child.kill("SIGKILL");
    const failed = [...this.pending.values()];
    this.pending.clear();
    for (const waiting of failed) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(message));
    }
  }
}

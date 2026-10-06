import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { utilityProcess, type UtilityProcess } from "electron";
import { subscriptionEnv } from "../runtime.ts";
import type { Context } from "../context.ts";
import type { Mode } from "../gate.ts";
import type { State } from "../store.ts";
import type { View } from "../web/view.ts";
import type { Panel } from "./protocol.ts";
import type { SharedImage } from "./controller.ts";
import { HostRequestSchema, type HostEvent } from "./host-protocol.ts";

/** OS broker sees snapshots only. All teaching and model work stays in a supervised host. */
export class HostController {
  private child: UtilityProcess | null = null;
  private epoch = "";
  private current: State | null = null;
  private token = "";
  private attachable = false;
  private treeView: View | null = null;
  private sequence = 0;
  private changing = false;
  private pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly changed: () => void, private readonly options: { executable: string }) {}
  get state(): State | null { return this.current; }
  get inputToken(): string { return this.token; }
  get canAttach(): boolean { return this.attachable; }
  get tree(): View | null { return this.treeView; }

  async choose(root: string, personal: Context, mode?: Mode): Promise<void> {
    if (this.changing) throw new Error("a project is already opening");
    this.changing = true;
    try {
      await this.close();
      const epoch = randomUUID();
      this.epoch = epoch;
      const env = subscriptionEnv();
      delete env.NODE_OPTIONS;
      delete env.ELECTRON_RUN_AS_NODE;
      env.DUM_HOST_EPOCH = epoch;
      env.DUM_CLAUDE_BIN = this.options.executable;
      if (process.platform === "darwin") env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
      const child = utilityProcess.fork(fileURLToPath(new URL("./host.js", import.meta.url)), [], { env, stdio: "pipe", serviceName: "Dum teaching session" });
      this.child = child;
      // Do not forward SDK/CLI output to renderer, logs or public build artifacts.
      child.stdout?.resume();
      child.stderr?.resume();
      const ready = Promise.withResolvers<void>();
      const timer = setTimeout(() => ready.reject(new Error("the teaching host didn't start")), 20_000);
      child.on("message", (message: HostEvent) => {
        if (this.child !== child || message?.epoch !== epoch) return;
        if (message.type === "ready") ready.resolve();
        else if (message.type === "state") {
          this.current = message.state;
          this.token = message.inputToken;
          this.attachable = message.canAttach;
          this.treeView = message.tree;
          this.changed();
        } else if (message.type === "reply") {
          const waiting = this.pending.get(message.id);
          if (!waiting) return;
          this.pending.delete(message.id);
          clearTimeout(waiting.timer);
          if (message.ok) waiting.resolve();
          else waiting.reject(new Error(message.error || "the teaching host refused that action"));
        }
      });
      child.once("exit", () => {
        ready.reject(new Error("the teaching host stopped before opening the project"));
        if (this.child !== child) return;
        this.child = null;
        this.rejectPending("the teaching host stopped - reopen the project to continue");
        this.token = "";
        this.attachable = false;
        if (this.current) this.current = { ...this.current, busy: false, prompt: null, status: "dum stopped - reopen this project to continue" };
        this.changed();
      });
      try { await ready.promise; } finally { clearTimeout(timer); }
      await this.request({ op: "open", root, personal, ...(mode ? { mode } : {}) });
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      this.changing = false;
    }
  }

  send(text: string, inputToken: string, image?: SharedImage): Promise<void> {
    return this.request({ op: "send", text, inputToken, ...(image ? { image } : {}) });
  }
  command(name: string, argument = ""): Promise<void> { return this.request({ op: "command", name, argument }); }
  panel(panel: Panel): Promise<void> { return this.request({ op: "panel", panel }); }
  interrupt(): Promise<void> { return this.request({ op: "interrupt" }); }

  async close(): Promise<void> {
    const child = this.child;
    if (child) {
      try { await this.request({ op: "close" }, 5_000); } catch { /* forced exit below */ }
      if (this.child === child) {
        this.child = null;
        child.kill();
      }
    }
    this.epoch = "";
    this.rejectPending("the project closed before that action completed");
    this.current = null;
    this.token = "";
    this.attachable = false;
    this.treeView = null;
    this.changed();
  }

  private request(value: unknown, ms = 15 * 60_000): Promise<void> {
    if (!this.child) return Promise.reject(new Error("choose a project first"));
    const id = String(++this.sequence);
    const request = HostRequestSchema.parse({ ...(value as object), epoch: this.epoch, id });
    const deferred = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      deferred.reject(new Error("that action didn't complete in time - stop Dum or reopen the project"));
    }, ms);
    this.pending.set(id, { resolve: deferred.resolve, reject: deferred.reject, timer });
    this.child.postMessage(request);
    return deferred.promise;
  }

  private rejectPending(message: string) {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(message));
    }
    this.pending.clear();
  }
}

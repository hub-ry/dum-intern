// Main's side of the utility host: it starts the supervised child, forwards host operations, answers
// the host's credential and frame requests, and keeps the latest state. No model code, backend,
// wizard or one-shot import lives here (rule 5).

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BrowserWindow, utilityProcess, type UtilityProcess } from "electron";
import { providerFreeEnv } from "../agent/claude-cli.ts";
import { HostEventSchema, HostRequestSchema, type HostEvent, type HostResult } from "./host-protocol.ts";
import type { Context } from "../context.ts";
import type { AgentChoice, BackendId, CredentialSource, Flavor, LoginMethod, ModelOption, Picture } from "../agent/types.ts";
import type { Tick } from "../observe-types.ts";
import type { InputBinding, RequestBinding, ShareGrant } from "../share-types.ts";
import type { SharedImage } from "../store-types.ts";
import type { ChangeReceipt, FollowGrant, SkillRef, Zone, ZoneContext, ZoneId } from "../zone-types.ts";
import type { DesktopPreferences, Panel, TreeSync, ZoneCreate, ZonePatch } from "./protocol.ts";

/** The host's latest state event, without its envelope. */
export type HostView = Omit<Extract<HostEvent, { type: "state" }>, "type" | "epoch">;

export type HostOptions = {
  home: string;
  flavor: Flavor;
  /** The bundled Claude executable, or null when this build has none. */
  claudeExecutable: string | null;
  /** Main's encrypted store answers the host; values are never kept here. */
  credential: CredentialSource;
  /** One frame for an ambient check, or null when none is available. */
  frame(checkId: string): Promise<Picture | null>;
};

type Pending = { resolve(result: HostResult | undefined): void; reject(error: Error): void; timer: NodeJS.Timeout };

const READY_MS = 20_000;
const REQUEST_MS = 5 * 60_000;
const CLOSE_MS = 5_000;
const CREDENTIAL_MS = 25_000;

/** Main sees snapshots only. All teaching and model work stays in the supervised host. */
export class HostController {
  private child: UtilityProcess | null = null;
  private epoch = "";
  private sequence = 0;
  private current: HostView | null = null;
  private stopped = "";
  private readonly pending = new Map<string, Pending>();
  /** Starting and closing happen one at a time, each after the last has finished. */
  private life: Promise<unknown> = Promise.resolve();

  constructor(private readonly changed: () => void, private readonly options: HostOptions) {}

  get view(): HostView | null { return this.current; }
  /** Why the host isn't running, after it stopped on its own; "" while it runs or before it starts. */
  get failure(): string { return this.stopped; }
  get running(): boolean { return this.child !== null; }

  /**
   * Start a fresh host and set it up: H, flavor, the Claude executable, personal context and the
   * settings copy. After a crash this starts over into fresh history; nothing queued is replayed.
   */
  start(personal: Context, settings: DesktopPreferences): Promise<void> {
    return this.lifecycle(async () => {
      await this.stop();
      const epoch = randomUUID();
      const env = providerFreeEnv(process.env);
      delete env.NODE_OPTIONS;
      delete env.ELECTRON_RUN_AS_NODE;
      env.DUM_HOST_EPOCH = epoch;
      if (process.platform === "darwin") env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
      const child = utilityProcess.fork(fileURLToPath(new URL("./host.js", import.meta.url)), [], { env, stdio: "pipe", serviceName: "Dum teaching host" });
      this.child = child;
      this.epoch = epoch;
      this.stopped = "";
      // Model and CLI output never reaches renderers, logs or build artifacts.
      child.stdout?.resume();
      child.stderr?.resume();
      const ready = Promise.withResolvers<void>();
      const timer = setTimeout(() => ready.reject(new Error("the teaching host didn't start")), READY_MS);
      child.on("message", (message: unknown) => {
        if (this.child !== child) return;
        const parsed = HostEventSchema.safeParse(message);
        if (!parsed.success || parsed.data.epoch !== epoch) return;
        if (parsed.data.type === "ready") ready.resolve();
        else this.receive(parsed.data);
      });
      child.once("exit", () => {
        ready.reject(new Error("the teaching host stopped while starting"));
        if (this.child !== child) return;
        this.lost("Dum's teaching host stopped - restart it to go on; nothing that was waiting was kept");
      });
      try {
        await ready.promise;
      } finally {
        clearTimeout(timer);
      }
      try {
        await this.request({
          op: "initialize", home: this.options.home, flavor: this.options.flavor, claudeExecutable: this.options.claudeExecutable, personal, settings,
        });
      } catch (err) {
        await this.stop();
        throw err;
      }
    });
  }

  async createZone(zone: ZoneCreate, enter: boolean): Promise<Zone> {
    return (await this.request({ op: "zone-create", zone, enter }))!.zone!;
  }
  async openZone(zoneId: ZoneId, expectedRevision: number): Promise<void> {
    await this.request({ op: "zone-enter", zoneId, expectedRevision });
  }
  async updateZone(zoneId: ZoneId, patch: ZonePatch, expectedRevision: number): Promise<Zone> {
    return (await this.request({ op: "zone-update", zoneId, patch, expectedRevision }))!.zone!;
  }
  async zoneContext(zoneId: ZoneId, text: string, expectedRevision: number): Promise<ZoneContext> {
    return (await this.request({ op: "zone-context", zoneId, text, expectedRevision }))!.context!;
  }
  async deleteZone(zoneId: ZoneId, expectedRevision: number): Promise<{ activeZoneId: ZoneId | null; deletedIds: ZoneId[] }> {
    return (await this.request({ op: "zone-delete", zoneId, expectedRevision }))!.deleted!;
  }
  /** Main persisted these first; the host gets its copy. */
  async settings(settings: DesktopPreferences): Promise<void> {
    await this.request({ op: "settings", settings });
  }
  async agentSelect(choice: AgentChoice | null): Promise<void> {
    await this.request({ op: "agent-select", choice });
  }
  async agentModels(backend: BackendId, login: LoginMethod): Promise<ModelOption[]> {
    return (await this.request({ op: "agent-models", backend, login }))?.models ?? [];
  }
  async send(binding: RequestBinding, text: string, shares: ShareGrant[], image?: SharedImage): Promise<void> {
    await this.request({ op: "send", binding, text, shares, ...(image ? { image } : {}) });
  }
  async respond(binding: RequestBinding, decision: { kind: "attest" | "share"; value: boolean }): Promise<void> {
    await this.request({ op: "respond", binding, decision });
  }
  async command(name: "inspect" | "projects" | "submit" | "remember", argument: string, binding: RequestBinding): Promise<void> {
    await this.request({ op: "command", name, argument, binding });
  }
  async panel(panel: Panel): Promise<void> {
    await this.request({ op: "panel", panel });
  }
  async shareAdd(path: string, kind: "file" | "folder", binding: RequestBinding): Promise<ShareGrant> {
    return (await this.request({ op: "share-add", path, kind, binding }))!.share!;
  }
  async shareRemove(shareId: string, binding: RequestBinding): Promise<void> {
    await this.request({ op: "share-remove", shareId, binding });
  }
  async followAdd(path: string): Promise<FollowGrant> {
    return (await this.request({ op: "follow-add", path }))!.follow!;
  }
  async followRemove(followId: string): Promise<void> {
    await this.request({ op: "follow-remove", followId });
  }
  async changeRevert(changeId: string, binding: InputBinding): Promise<ChangeReceipt> {
    return (await this.request({ op: "change-revert", changeId, binding }))!.change!;
  }
  async skillEdit(edit: "add" | "remove", skill: SkillRef): Promise<void> {
    await this.request({ op: "skill-edit", edit, skill });
  }
  /** The page's URL after link or rotate; null otherwise. */
  async treeSync(sync: TreeSync): Promise<string | null> {
    return (await this.request({ op: "tree-sync", sync }))?.url ?? null;
  }
  /** The validated app-owned file main may open. */
  async openRecord(record: "change" | "memory", recordId?: string): Promise<string> {
    return (await this.request({ op: "open-record", record, ...(recordId ? { recordId } : {}) }))!.path!;
  }
  async interrupt(): Promise<void> {
    await this.request({ op: "interrupt" });
  }

  /**
   * One look tick. Dum's own windows aren't something they switched to or typed in: while one has
   * focus, the tick carries neither app nor screen, and only followed code can trigger a look.
   */
  observeTick(tick: Tick): void {
    if (!this.child) return;
    const own = BrowserWindow.getFocusedWindow() !== null;
    void this.request({ op: "observe-tick", tick: own ? { ...tick, app: null, screen: null } : tick }).catch(() => undefined);
  }

  /** Close the host: it saves and lets H go; a host that doesn't answer in time is killed. */
  close(): Promise<void> {
    return this.lifecycle(() => this.stop());
  }

  // -- internals --------------------------------------------------------------

  private lifecycle(step: () => Promise<void>): Promise<void> {
    const next = this.life.then(step);
    this.life = next.catch(() => undefined);
    return next;
  }

  private async stop(): Promise<void> {
    const child = this.child;
    if (child) {
      try { await this.request({ op: "close" }, CLOSE_MS); } catch { /* killed below */ }
      if (this.child === child) {
        this.child = null;
        child.kill();
      }
    }
    this.epoch = "";
    this.rejectPending("the teaching host closed before that finished");
    this.current = null;
    this.changed();
  }

  /** The child is gone on its own: every binding, decision and share it issued is void. */
  private lost(message: string): void {
    this.child = null;
    this.epoch = "";
    this.stopped = message;
    this.rejectPending(message);
    if (this.current) {
      const state = this.current.state ? { ...this.current.state, busy: false, prompt: null, status: message } : null;
      this.current = { ...this.current, state, zoneEpoch: null, canAttach: false, shares: [], look: { status: "stopped with the host" } };
    }
    this.changed();
  }

  private receive(event: Exclude<HostEvent, { type: "ready" }>): void {
    switch (event.type) {
      case "state": {
        const { type: _type, epoch: _epoch, ...view } = event;
        this.current = view;
        this.changed();
        return;
      }
      case "reply": {
        const waiting = this.pending.get(event.id);
        if (!waiting) return;
        this.pending.delete(event.id);
        clearTimeout(waiting.timer);
        if (event.ok) waiting.resolve(event.result);
        else waiting.reject(new Error(event.error || "the teaching host refused that action"));
        return;
      }
      case "fatal":
        this.stopped = event.message;
        this.changed();
        return;
      case "credential-request": {
        const { requestId, need } = event;
        void this.options.credential(need, AbortSignal.timeout(CREDENTIAL_MS))
          .catch(() => null)
          .then((value) => this.request({ op: "credential", requestId, value }))
          .catch(() => undefined);
        return;
      }
      case "frame-request": {
        const { checkId } = event;
        void this.options.frame(checkId)
          .catch(() => null)
          .then((image) => this.request({ op: "observe-frame", checkId, image }))
          .catch(() => undefined);
        return;
      }
    }
  }

  private request(value: Record<string, unknown>, ms = REQUEST_MS): Promise<HostResult | undefined> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(this.stopped || "the teaching host isn't running"));
    const id = String(++this.sequence);
    const request = HostRequestSchema.parse({ ...value, epoch: this.epoch, id });
    const deferred = Promise.withResolvers<HostResult | undefined>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      deferred.reject(new Error("that didn't finish in time - Stop Dum or restart it"));
    }, ms);
    this.pending.set(id, { resolve: deferred.resolve, reject: deferred.reject, timer });
    child.postMessage(request);
    return deferred.promise;
  }

  private rejectPending(message: string): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(message));
    }
    this.pending.clear();
  }
}

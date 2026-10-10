// Main's side of the utility host: it starts the supervised child, forwards host operations, answers
// the host's credential and frame requests, and keeps the latest state and debug view. No model code,
// backend, wizard or one-shot import lives here (rule 5).

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BrowserWindow, utilityProcess, type UtilityProcess } from "electron";
import { providerFreeEnv } from "../agent/claude-cli.ts";
import { HostEventSchema, HostRequestSchema, type HostEvent, type HostRequest, type HostResult } from "./host-protocol.ts";
import type { Context } from "../context.ts";
import type { AgentChoice, BackendId, CredentialSource, LoginMethod, ModelOption, Picture, Selector } from "../agent/types.ts";
import type {
  AlignmentAcceptInput, AlignmentStepInput, ContextUsePage, DecisionView, Direction, DirectionView, HandoffDismissInput, HandoffEditInput,
  HandoffReviewInput, HandoffRunInput, HandoffSelectInput, HandoffView, IgnoreObservationInput,
} from "../delegation-types.ts";
import type { DebugBinding, DebugView, MainStatus, SanitizedMainEvent } from "../diagnostic-types.ts";
import type { Tick } from "../observe-types.ts";
import type { InputBinding, RequestBinding, ShareGrant } from "../share-types.ts";
import type { SharedImage } from "../store-types.ts";
import type { StoryPage, StoryQuery, TrailMapInput, TrailPage, TrailQuery, TrailSource } from "../trail-types.ts";
import type { ChangeReceipt, FollowGrant, SkillRef, Zone, ZoneContext, ZoneId } from "../zone-types.ts";
import type { DesktopPreferences, TreeSync, ViewName, ZoneCreate, ZonePatch } from "./protocol.ts";

/** The host's latest state event, without its envelope. */
export type HostView = Omit<Extract<HostEvent, { type: "state" }>, "type" | "epoch">;

/** One host operation as main writes it; the envelope is added when it is sent. */
type Op = HostRequest extends infer R ? (R extends HostRequest ? Omit<R, "epoch" | "id"> : never) : never;

/** A result field the operation must fill; a reply without it is the host's fault, not undefined. */
function need<K extends keyof HostResult>(result: HostResult | undefined, key: K): NonNullable<HostResult[K]> {
  const value = result?.[key];
  if (value === undefined || value === null) throw new Error("the teaching host's reply was incomplete - nothing else happened");
  return value as NonNullable<HostResult[K]>;
}

export type HostOptions = {
  home: string;
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
  /** Debug chat's own state, published apart from any zone's. */
  private debugView: DebugView | null = null;
  private stopped = "";
  private readonly pending = new Map<string, Pending>();
  /** Starting and closing happen one at a time, each after the last has finished. */
  private life: Promise<unknown> = Promise.resolve();
  private readonly first = Promise.withResolvers<void>();
  /**
   * Settles once the latest start attempt has, or before any start, once the first one has.
   * Operations wait on it: one asked for while the host starts (the window can open from the
   * circle before then) reaches it after `initialize`, not before.
   */
  private started: Promise<void> = this.first.promise;

  constructor(private readonly changed: () => void, private readonly options: HostOptions) {}

  get view(): HostView | null { return this.current; }
  get debug(): DebugView | null { return this.debugView; }
  /** Why the host isn't running, after it stopped on its own; "" while it runs or before it starts. */
  get failure(): string { return this.stopped; }
  get running(): boolean { return this.child !== null; }

  /**
   * Start a fresh host and set it up: H, the Claude executable, personal context, the settings copy
   * and main's sanitized status. After a crash this starts over into fresh history and a closed debug
   * chat; nothing queued is replayed.
   */
  start(personal: Context, settings: DesktopPreferences, main: MainStatus): Promise<void> {
    const attempt = this.lifecycle(async () => {
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
      // The host posts its first state just after the initialize reply; start() resolves only once main can see it.
      const stated = Promise.withResolvers<void>();
      stated.promise.catch(() => undefined);
      const timer = setTimeout(() => ready.reject(new Error("the teaching host didn't start")), READY_MS);
      child.on("message", (message: unknown) => {
        if (this.child !== child) return;
        const parsed = HostEventSchema.safeParse(message);
        if (!parsed.success || parsed.data.epoch !== epoch) return;
        if (parsed.data.type === "ready") ready.resolve();
        else {
          this.receive(parsed.data);
          if (parsed.data.type === "state") stated.resolve();
        }
      });
      child.once("exit", () => {
        ready.reject(new Error("the teaching host stopped while starting"));
        stated.reject(new Error("the teaching host stopped while starting"));
        if (this.child !== child) return;
        this.lost("Dum's teaching host stopped - restart it to go on; nothing that was waiting was kept");
      });
      try {
        await ready.promise;
      } finally {
        clearTimeout(timer);
      }
      const unstated = setTimeout(() => stated.reject(new Error("the teaching host didn't report its state")), READY_MS);
      try {
        await this.request({
          op: "initialize", home: this.options.home, claudeExecutable: this.options.claudeExecutable, personal, settings, main,
        });
        await stated.promise;
      } catch (err) {
        await this.stop();
        throw err;
      } finally {
        clearTimeout(unstated);
      }
    });
    this.started = attempt.then(() => undefined, () => undefined);
    void this.started.then(this.first.resolve);
    return attempt;
  }

  async createZone(zone: ZoneCreate, enter: boolean): Promise<{ zone: Zone; direction: DirectionView }> {
    const result = await this.call({ op: "zone-create", zone, enter });
    return { zone: need(result, "zone"), direction: need(result, "direction") };
  }
  async openZone(zoneId: ZoneId, expectedRevision: number): Promise<void> {
    await this.call({ op: "zone-enter", zoneId, expectedRevision });
  }
  /** The target zone's alignment comes back too, active or not: a changed goal starts its own. */
  async updateZone(zoneId: ZoneId, patch: ZonePatch, expectedRevision: number): Promise<{ zone: Zone; direction: DirectionView }> {
    const result = await this.call({ op: "zone-update", zoneId, patch, expectedRevision });
    return { zone: need(result, "zone"), direction: need(result, "direction") };
  }
  async zoneContext(zoneId: ZoneId, text: string, expectedRevision: number): Promise<ZoneContext> {
    return need(await this.call({ op: "zone-context", zoneId, text, expectedRevision }), "context");
  }
  async deleteZone(zoneId: ZoneId, expectedRevision: number): Promise<{ activeZoneId: ZoneId | null; deletedIds: ZoneId[] }> {
    return need(await this.call({ op: "zone-delete", zoneId, expectedRevision }), "deleted");
  }
  /** Main persisted these first; the host gets its copy. */
  async settings(settings: DesktopPreferences): Promise<void> {
    await this.call({ op: "settings", settings });
  }
  async agentSelect(choice: AgentChoice | null): Promise<void> {
    await this.call({ op: "agent-select", choice });
  }
  async agentModels(backend: BackendId, login: LoginMethod): Promise<ModelOption[]> {
    return (await this.call({ op: "agent-models", backend, login }))?.models ?? [];
  }
  async agentVerifyImages(selector: Selector, login: LoginMethod): Promise<void> {
    await this.call({ op: "agent-verify-images", selector, login });
  }
  async send(binding: RequestBinding, text: string, shares: ShareGrant[], image?: SharedImage): Promise<void> {
    await this.call({ op: "send", binding, text, shares, ...(image ? { image } : {}) });
  }
  async respond(binding: RequestBinding, decision: { kind: "attest" | "share"; value: boolean }): Promise<void> {
    await this.call({ op: "respond", binding, decision });
  }
  async command(name: "inspect" | "projects" | "submit" | "remember", argument: string, binding: RequestBinding): Promise<void> {
    await this.call({ op: "command", name, argument, binding });
  }
  /** The working window switched to an in-window view. */
  async selectView(view: ViewName): Promise<void> {
    await this.call({ op: "view", view });
  }
  async shareAdd(path: string, kind: "file" | "folder", binding: RequestBinding): Promise<ShareGrant> {
    return need(await this.call({ op: "share-add", path, kind, binding }), "share");
  }
  async shareRemove(shareId: string, binding: RequestBinding): Promise<void> {
    await this.call({ op: "share-remove", shareId, binding });
  }
  async followAdd(path: string): Promise<FollowGrant> {
    return need(await this.call({ op: "follow-add", path }), "follow");
  }
  async followRemove(followId: string): Promise<void> {
    await this.call({ op: "follow-remove", followId });
  }
  async changeRevert(changeId: string, binding: InputBinding): Promise<ChangeReceipt> {
    return need(await this.call({ op: "change-revert", changeId, binding }), "change");
  }
  async skillEdit(edit: "add" | "remove", skill: SkillRef): Promise<void> {
    await this.call({ op: "skill-edit", edit, skill });
  }
  /** The page's URL after link or rotate; null otherwise. */
  async treeSync(sync: TreeSync): Promise<string | null> {
    return (await this.call({ op: "tree-sync", sync }))?.url ?? null;
  }
  /** The validated app-owned file main may open. */
  async openRecord(record: "change" | "memory", recordId?: string): Promise<string> {
    return need(await this.call({ op: "open-record", record, ...(recordId ? { recordId } : {}) }), "path");
  }
  /** The named personal file behind one of the host's context refs; main still checks its own inventory. */
  async openPersonal(sourceId: string): Promise<string> {
    return need(await this.call({ op: "open-record", record: "personal", sourceId }), "path");
  }
  async interrupt(): Promise<void> {
    await this.call({ op: "interrupt" });
  }

  // -- goal alignment: any zone, by its own binding; nothing of the active zone's goes with it ----

  async alignmentRead(zoneId: ZoneId): Promise<DirectionView> {
    return need(await this.call({ op: "alignment-read", zoneId }), "direction");
  }
  async alignmentStep(input: AlignmentStepInput): Promise<DirectionView> {
    return need(await this.call({ op: "alignment-step", ...input }), "direction");
  }
  async alignmentAccept(input: AlignmentAcceptInput): Promise<DirectionView> {
    return need(await this.call({ op: "alignment-accept", ...input }), "direction");
  }
  async directionRead(zoneId: ZoneId, directionId: string): Promise<Direction> {
    return need(await this.call({ op: "direction-read", zoneId, directionId }), "directionRecord");
  }

  // -- decisions and handoffs in the active zone ---------------------------------------------------

  async decisionHelp(binding: RequestBinding, outcome: string): Promise<DecisionView> {
    return need(await this.call({ op: "decision-help", binding, outcome }), "decision");
  }
  async decisionDismiss(binding: RequestBinding, decisionId: string, revision: number): Promise<void> {
    await this.call({ op: "decision-dismiss", binding, decisionId, revision });
  }
  async selectHandoff(input: HandoffSelectInput): Promise<HandoffView> {
    return need(await this.call({ op: "handoff-select", ...input }), "handoff");
  }
  async editHandoff(input: HandoffEditInput): Promise<HandoffView> {
    return need(await this.call({ op: "handoff-edit", ...input }), "handoff");
  }
  async dismissHandoff(input: HandoffDismissInput): Promise<void> {
    await this.call({ op: "handoff-dismiss", ...input });
  }
  /** Do this: main consumed the command and hands over the request's current grants, as Send does. */
  async runHandoff(input: HandoffRunInput): Promise<void> {
    const { image, ...rest } = input;
    await this.call({ op: "handoff-run", ...rest, ...(image ? { image } : {}) });
  }
  async readHandoff(zoneId: ZoneId, handoffId: string): Promise<HandoffView> {
    return need(await this.call({ op: "handoff-read", zoneId, handoffId }), "handoff");
  }
  async reviewHandoff(input: HandoffReviewInput): Promise<HandoffView> {
    return need(await this.call({ op: "handoff-review", ...input }), "handoff");
  }

  // -- current context -----------------------------------------------------------------------------

  async contextUseRead(binding: RequestBinding, cursor: string | null): Promise<ContextUsePage> {
    return need(await this.call({ op: "context-use-read", binding, cursor }), "contextUse");
  }
  /** Main re-read its opted-in personal-context copy first. */
  async contextReload(binding: RequestBinding, personal: Context): Promise<void> {
    await this.call({ op: "context-reload", binding, personal });
  }
  async contextIgnoreObservation(input: IgnoreObservationInput): Promise<void> {
    await this.call({ op: "context-ignore-observation", ...input });
  }

  // -- sessions, trail and story: historical reads confer nothing ----------------------------------

  async newSession(binding: RequestBinding): Promise<void> {
    await this.call({ op: "session-new", binding });
  }
  async trailRead(query: TrailQuery): Promise<TrailPage> {
    return need(await this.call({ op: "trail-read", ...query }), "trail");
  }
  async trailSource(zoneId: ZoneId, sessionId: string, sourceId: string): Promise<TrailSource> {
    return need(await this.call({ op: "trail-source", zoneId, sessionId, sourceId }), "trailSource");
  }
  async trailMap(input: TrailMapInput): Promise<void> {
    await this.call({ op: "trail-map", ...input });
  }
  async storyRead(query: StoryQuery): Promise<StoryPage> {
    return need(await this.call({ op: "story-read", ...query }), "story");
  }

  // -- debug chat: its own binding, no zone field anywhere -----------------------------------------

  async debugOpen(): Promise<DebugView> {
    return need(await this.call({ op: "debug-open" }), "debug");
  }
  async debugSend(binding: DebugBinding, text: string): Promise<void> {
    await this.call({ op: "debug-send", binding, text });
  }
  async debugStop(binding: DebugBinding): Promise<void> {
    await this.call({ op: "debug-stop", binding });
  }
  async debugReset(): Promise<DebugView> {
    return need(await this.call({ op: "debug-reset" }), "debug");
  }

  /** Main's sanitized events, and its status when that changed; the host assigns sequence and time. */
  async diagnosticMain(events: readonly SanitizedMainEvent[], status: MainStatus | null): Promise<void> {
    await this.call({ op: "diagnostic-main", events: [...events], status });
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
    this.debugView = null;
    this.changed();
  }

  /**
   * The child is gone on its own: every binding, decision card, share and debug session it issued is
   * void. Durable records (direction, handoff, trail) stay readable until a fresh host publishes.
   */
  private lost(message: string): void {
    this.child = null;
    this.epoch = "";
    this.stopped = message;
    this.rejectPending(message);
    this.debugView = null;
    if (this.current) {
      const { state: before, look } = this.current;
      const state = before ? { ...before, busy: false, prompt: null, status: message } : null;
      const seen = look.seen ? { ...look.seen, stale: true } : null;
      this.current = {
        ...this.current, state, zoneEpoch: null, runningRequestId: null, canAttach: false, shares: [], decision: null,
        look: { ...look, status: "failed", reason: null, seen },
      };
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
      case "debug-state":
        this.debugView = event.view;
        this.changed();
        return;
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

  /** One operation, once a start in progress has settled. */
  private async call(value: Op): Promise<HostResult | undefined> {
    await this.started;
    return this.request(value);
  }

  private request(value: Op, ms = REQUEST_MS): Promise<HostResult | undefined> {
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

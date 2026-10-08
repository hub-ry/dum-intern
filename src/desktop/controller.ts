// The utility host's whole job: the H writer lock, the zone graph, global evidence, the agent registry,
// the active zone's conversation, request-bound shares, followed folders, changes and the ambient look.
// No Electron here. Main talks to it through host-protocol.ts; `serve` is the process side of that.

import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import * as zones from "../zones.ts";
import * as memory from "../memory.ts";
import * as context from "../context.ts";
import * as skills from "../skills.ts";
import * as boundary from "../boundary.ts";
import * as web from "../web.ts";
import * as wizard from "../wizard.ts";
import { acquire } from "../session-lock.ts";
import { Evidence } from "../evidence.ts";
import { Follows } from "../follow.ts";
import { SharedFiles, bound } from "../shared-files.ts";
import { listChanges, revertChange } from "../changes.ts";
import { Ambient, type AmbientStatus } from "../ambient.ts";
import { Store, Cancelled, parseCommand } from "../store.ts";
import { prepare, run, type Ctx } from "../session.ts";
import { Practice, active as practicing } from "../practice.ts";
import { treeText } from "../tree.ts";
import { createRegistry, RELEASED, type Registry } from "../agent/registry.ts";
import { agentChoiceSchema } from "../agent/schema.ts";
import { createState, readState, statePath } from "../state-files.ts";
import { view, type View } from "../web/view.ts";
import { HostRequestSchema, type HostEvent, type HostRequest, type HostResult } from "./host-protocol.ts";
import type { AgentBackend, AgentChoice, BackendId, CredentialNeed, CredentialSource, Flavor, LoginMethod, ModelOption, Picture } from "../agent/types.ts";
import type { FileSignal, Tick } from "../observe-types.ts";
import type { InputBinding, RequestBinding, ResourcePath, ShareGrant } from "../share-types.ts";
import type { SharedImage } from "../store-types.ts";
import type { ChangeReceipt, FollowGrant, SkillRef, Zone, ZoneContext, ZoneId, ZoneRegistry } from "../zone-types.ts";
import type { DesktopPreferences, Panel, TreeSync, ZoneCreate, ZonePatch } from "./protocol.ts";

/** How long switching waits for the old conversation to wind down before going on regardless. Main's close gives up at 5 s. */
const WIND_DOWN_MS = 4_000;
/** Changes listed in the state event, newest first; each diff is bounded. */
const LISTED_CHANGES = 50;
const PATCH_BYTES = 1024 * 1024;
const MORE = "the full patch is kept with the change";
const NO_PERSONAL: context.Context = { path: "", text: "", warning: "" };

const LOOK_STATUS: Record<AmbientStatus, string> = {
  watching: "watching for changes",
  checking: "taking a look",
  blocked: "paused while dum is busy or waiting on you",
  failed: "the last look didn't work - it tries again on the next change",
};

/** What the host builds its backends from; main never sees these. */
export type BackendFactory = (o: { flavor: Flavor; claudeExecutable: string | null; credential: CredentialSource }) => AgentBackend[];

export type ControllerOptions = {
  epoch: string;
  post(event: HostEvent): void;
  backends: BackendFactory;
  /** How long a credential request waits for main's answer. */
  credentialMs?: number;
  /** How long an ambient check waits for main's frame. */
  frameMs?: number;
};

type Init = {
  home: string;
  flavor: Flavor;
  registry: Registry;
  evidence: Evidence;
  release: () => void;
  personal: context.Context;
  settings: DesktopPreferences;
  /** Why main's agent choice couldn't be applied, until it's chosen again. */
  agentError: string | null;
};

/** One request or command: its shares and the binding it runs under. */
type Job = { files: SharedFiles; binding: RequestBinding };

type Live = {
  zone: ZoneContext;
  /** Fresh on every open: bindings and ticks naming another epoch are stale. */
  epoch: string;
  store: Store;
  follows: Follows;
  ambient: Ambient;
  /** Aborted to close: the run, the model and every helper call stop. */
  stop: AbortController;
  detach: () => void;
  /** The conversation loop, settled once everything in it has stopped. */
  done: Promise<void>;
  /** Shares chosen for the request about to be sent. */
  pending: SharedFiles | null;
  /** The request or command running now; its shares lapse when it ends. */
  running: Job | null;
  /** Handed from `send` to the conversation loop. */
  next: (Job & { ctx: Ctx }) | null;
  changes: ChangeReceipt[];
  /** Followed-file signals since the last diff, latest per path. */
  signals: Map<ResourcePath, FileSignal>;
  look: string;
  /** Token for "no prompt is taking input": never accepted by a prompt. */
  idle: string;
};

/** Requests to main correlated by a fresh ID, each with a deadline. */
class Asks<T> {
  private readonly waiting = new Map<string, (outcome: { value: T } | { error: Error }) => void>();

  ask(post: (id: string) => void, ms: number, late: string, signal?: AbortSignal): Promise<T> {
    const id = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    if (signal?.aborted) return Promise.reject(new Error("stopped"));
    const finish = (outcome: { value: T } | { error: Error }) => {
      if (!this.waiting.delete(id)) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const abort = () => finish({ error: new Error("stopped") });
    const timer = setTimeout(() => finish({ error: new Error(late) }), ms);
    signal?.addEventListener("abort", abort, { once: true });
    this.waiting.set(id, finish);
    post(id);
    return promise;
  }

  answer(id: string, value: T): void {
    const finish = this.waiting.get(id);
    if (!finish) throw new Error("nothing is waiting for that answer any more");
    finish({ value });
  }

  fail(message: string): void {
    for (const finish of [...this.waiting.values()]) finish({ error: new Error(message) });
  }
}

export class DesktopController {
  private init: Init | null = null;
  private live: Live | null = null;
  private closed = false;
  private zoneList: ZoneRegistry = { version: 1, revision: 0, activeZoneId: null, zones: [] };
  private treeView: View | null = null;
  private readonly tokens = new WeakMap<object, string>();
  private readonly idle = randomUUID();
  /** Operations that change state run one at a time, each after the last has finished. */
  private queue: Promise<unknown> = Promise.resolve();
  private scheduled = false;
  private readonly credentials = new Asks<{ value: string; expiresAt: number | null } | null>();
  private readonly frames = new Asks<Picture | null>();

  constructor(private readonly o: ControllerOptions) {}

  /**
   * One validated request. Credential and frame answers, ticks, model catalogs and Stop never wait
   * behind another operation: an operation may itself be waiting on one of them. Everything else
   * runs strictly in order.
   */
  handle(r: HostRequest): Promise<HostResult | undefined> {
    switch (r.op) {
      case "credential": return this.now(() => this.credential(r.requestId, r.value));
      case "observe-frame": return this.now(() => this.observeFrame(r.checkId, r.image));
      case "observe-tick": return this.observeTick(r.tick).then(() => undefined);
      case "agent-models": return this.agentModels(r.backend, r.login).then((models) => ({ models }));
      case "interrupt": return this.now(() => this.interrupt());
      case "close": return this.close().then(() => undefined);
      default: return this.serial(() => this.ordered(r));
    }
  }

  private async ordered(r: Exclude<HostRequest, { op: "credential" | "observe-frame" | "observe-tick" | "agent-models" | "interrupt" | "close" }>): Promise<HostResult | undefined> {
    switch (r.op) {
      case "initialize": this.initialize(r.home, r.flavor, r.claudeExecutable, r.personal, r.settings); return undefined;
      case "zone-create": return { zone: await this.createZone(r.zone, r.enter) };
      case "zone-enter": await this.openZone(r.zoneId, r.expectedRevision); return undefined;
      case "zone-update": return { zone: this.updateZone(r.zoneId, r.patch, r.expectedRevision) };
      case "zone-context": return { context: this.zoneContext(r.zoneId, r.text, r.expectedRevision) };
      case "zone-delete": return { deleted: await this.deleteZone(r.zoneId, r.expectedRevision) };
      case "settings": await this.settings(r.settings); return undefined;
      case "agent-select": this.agentSelect(r.choice); return undefined;
      case "send": await this.send(r.binding, r.text, r.shares, r.image); return undefined;
      case "respond": this.respond(r.binding, r.decision); return undefined;
      case "command": this.command(r.name, r.argument, r.binding); return undefined;
      case "panel": this.panel(r.panel); return undefined;
      case "share-add": return { share: await this.shareAdd(r.path, r.kind, r.binding) };
      case "share-remove": this.shareRemove(r.shareId, r.binding); return undefined;
      case "follow-add": return { follow: await this.followAdd(r.path) };
      case "follow-remove": this.followRemove(r.followId); return undefined;
      case "change-revert": return { change: await this.changeRevert(r.changeId, r.binding) };
      case "skill-edit": this.skillEdit(r.edit, r.skill); return undefined;
      case "tree-sync": { const url = await this.treeSync(r.sync); return url ? { url } : undefined; }
      case "open-record": return { path: this.openRecord(r.record, r.recordId) };
    }
  }

  // -- setup ------------------------------------------------------------------

  /** Take H for this host, build the backends and the registry, apply main's settings copy, and open the active zone. */
  initialize(home: string, flavor: Flavor, claudeExecutable: string | null, personal: context.Context, settings: DesktopPreferences): void {
    if (this.init) throw new Error("this host is already set up");
    // Every module that keeps state resolves H through skills.home(); this host serves exactly one.
    process.env.DUM_HOME = home;
    const release = acquire(home);
    try {
      const backends = this.o.backends({ flavor, claudeExecutable, credential: (need, signal) => this.askCredential(need, signal) });
      const released = new Set((Object.keys(RELEASED) as BackendId[]).filter((id) => RELEASED[id]));
      const init: Init = {
        home, flavor, registry: createRegistry(backends, released), evidence: new Evidence(home), release, personal, settings, agentError: null,
      };
      this.applyAgent(init, settings.agent, false);
      this.zoneList = zones.listZones();
      this.init = init;
      if (this.zoneList.activeZoneId) this.start(init, this.zoneList.activeZoneId);
    } catch (err) {
      this.init = null;
      release();
      throw err;
    }
    this.changed();
  }

  /** Main persisted these; the host applies its copy. A choice the registry can't run is refused after the rest applies. */
  async settings(settings: DesktopPreferences): Promise<void> {
    const init = this.ready();
    const mode = init.settings.mode;
    init.settings = { ...settings, agent: init.settings.agent };
    try {
      this.applyAgent(init, settings.agent, true);
    } finally {
      // The mode is fixed for a conversation, so a new mode reopens the zone fresh.
      if (this.live && mode !== settings.mode) {
        const id = this.live.zone.id;
        await this.shutdown();
        this.start(init, id);
      }
      this.changed();
    }
  }

  agentSelect(choice: AgentChoice | null): void {
    const init = this.ready();
    this.applyAgent(init, choice, true);
    this.changed();
  }

  async agentModels(backend: BackendId, login: LoginMethod): Promise<ModelOption[]> {
    const init = this.ready();
    return init.registry.backend(backend).models(login, AbortSignal.timeout(60_000));
  }

  /** Main's answer to a credential request. Values are handed to the waiting backend and kept nowhere. */
  credential(requestId: string, value: { value: string; expiresAt: number | null } | null): void {
    this.credentials.answer(requestId, value);
  }

  // -- zones ------------------------------------------------------------------

  async createZone(input: ZoneCreate, enter: boolean): Promise<Zone> {
    this.ready();
    const zone = zones.createZone(input);
    this.zonesChanged();
    if (enter) await this.openZone(zone.id, this.zoneList.revision);
    return zone;
  }

  /**
   * Enter a zone: validated before anything open is touched, then the open conversation ends, the
   * destination becomes active and opens with a fresh epoch. If it can't open, the previous zone
   * reopens fresh; nothing it was waiting on comes back.
   */
  async openZone(zoneId: ZoneId, expectedRevision: number): Promise<void> {
    const init = this.ready();
    zones.resolveZone(zoneId);
    if (zones.listZones().revision !== expectedRevision) throw new Error("zones changed since this was shown - refresh and try again");
    if (this.live?.zone.id === zoneId) return;
    const previous = this.live?.zone.id ?? null;
    if (this.live) await this.shutdown();
    zones.setActiveZone(zoneId, expectedRevision);
    this.zonesChanged();
    try {
      this.start(init, zoneId);
    } catch (err) {
      if (previous) {
        try {
          zones.setActiveZone(previous, zones.listZones().revision);
          this.zonesChanged();
          this.start(init, previous);
        } catch { /* the registry says which zone is active; nothing is open */ }
      }
      throw err;
    } finally {
      this.changed();
    }
  }

  updateZone(zoneId: ZoneId, patch: ZonePatch, expectedRevision: number): Zone {
    this.ready();
    const zone = zones.updateZone(zoneId, patch, expectedRevision);
    this.zonesChanged();
    return zone;
  }

  zoneContext(zoneId: ZoneId, text: string, expectedRevision: number): ZoneContext {
    this.ready();
    const resolved = zones.writeZoneContext(zoneId, text, expectedRevision);
    this.zonesChanged();
    return resolved;
  }

  async deleteZone(zoneId: ZoneId, expectedRevision: number): Promise<{ activeZoneId: ZoneId | null; deletedIds: ZoneId[] }> {
    const init = this.ready();
    const deleted = zones.deleteZone(zoneId, expectedRevision);
    if (this.live && deleted.deletedIds.includes(this.live.zone.id)) {
      await this.shutdown();
      this.zonesChanged();
      if (deleted.activeZoneId) this.start(init, deleted.activeZoneId);
    } else this.zonesChanged();
    this.changed();
    return deleted;
  }

  // -- the conversation -----------------------------------------------------

  /**
   * Their message for the prompt the binding names. At "what next" it starts a request: its shares
   * come from the host's own grants by ID (wire copies are not authority), a picture is looked at
   * once first, and a typed command runs as that request. At a question it answers inside the
   * running request.
   */
  async send(binding: RequestBinding, text: string, shares: ShareGrant[], image?: SharedImage): Promise<void> {
    const init = this.ready();
    const live = this.bound(binding);
    const line = text.trim();
    if (!line) throw new Error("type something first");
    const { store } = live;
    const prompt = store.getSnapshot().prompt;
    if (!prompt || !store.inputReady) throw new Error("that prompt closed before your message arrived - nothing was sent");
    if (prompt.type !== "next") {
      const running = this.runningFor(live, binding);
      if (image) throw new Error("a picture only goes with a request when dum asks what's next - nothing was sent");
      const granted = new Set(running.files.grants().map((g) => g.id));
      if (shares.some((s) => !granted.has(s.id))) throw new Error("share that with your next request - this one is already running");
      store.submit(text);
      return;
    }
    if (live.running) throw new Error("wait for dum to finish, or Stop it - nothing was sent");
    if (init.agentError) throw new Error(init.agentError);
    init.registry.chosen();
    const cmd = parseCommand(line);
    if (cmd && image) throw new Error("a picture goes with a request, not a command - nothing was sent");
    const files = this.claim(live, binding, shares);
    if (cmd) {
      this.startCommand(init, live, { files, binding }, cmd.name, cmd.arg);
      return;
    }
    const ctx = prepare(live.zone, init.settings.mode, store, this.personal(init), init.evidence, files, init.registry, binding);
    if (image) {
      // A failed look sends nothing: the request's shares stay chosen for the next try.
      const keep = (why: string) => {
        if (this.live === live && !live.pending) live.pending = files;
        return new Error(why);
      };
      let seen: boolean;
      try {
        seen = await store.attach(image, line);
      } catch (err) {
        throw keep(err instanceof Cancelled ? "stopped - your message wasn't sent" : (err as Error).message);
      }
      if (!seen) throw keep("dum couldn't look at the picture - your message wasn't sent. Send it again, with or without the picture");
      if (this.live !== live || store.getSnapshot().prompt !== prompt || !store.inputReady) {
        throw keep("that prompt closed before your message was sent - the picture's description goes with your next one");
      }
    }
    files.activate();
    live.next = { files, binding, ctx };
    store.submit(text);
  }

  /** A yes/no button for the question the running request parked. */
  respond(binding: RequestBinding, decision: { kind: "attest" | "share"; value: boolean }): void {
    const live = this.bound(binding);
    this.runningFor(live, binding);
    live.store.respond(decision);
  }

  /** One of the desktop's commands as its own request. Replies once it has started; the store reports how it went. */
  command(name: "inspect" | "projects" | "submit" | "remember", argument: string, binding: RequestBinding): void {
    const init = this.ready();
    const live = this.bound(binding);
    if (live.store.getSnapshot().prompt?.type !== "next" || live.running) throw new Error("finish what dum is doing first, or Stop it");
    if (name !== "remember") {
      if (init.agentError) throw new Error(init.agentError);
      init.registry.chosen();
    }
    this.startCommand(init, live, { files: this.claim(live, binding, []), binding }, name, argument);
  }

  /** Show a panel. The tree works before any zone or backend: it's theirs, not a zone's. */
  panel(panel: Panel): void {
    const init = this.ready();
    switch (panel) {
      case "tree":
        this.treeView = view(skills.read());
        this.changed();
        return;
      case "zones":
      case "settings":
        return;
      case "changes": {
        const live = this.need();
        this.refreshChanges(init, live);
        this.changed();
        return;
      }
      case "projects": {
        const live = this.need();
        const binding = this.hostBinding(live);
        const files = new SharedFiles(binding, live.follows);
        try {
          live.store.show("suggested projects", new Practice(live.zone, live.store, files, init.evidence, this.personal(init), init.registry, binding).describe());
        } finally {
          files.revoke();
        }
        return;
      }
      default:
        void this.need().store.command(panel === "history" ? "log" : panel);
    }
  }

  /**
   * Stop what dum is doing. Every prompt it was waiting on is withdrawn unanswered and helper work
   * in flight is aborted with nothing kept. The conversation goes on from "what next".
   */
  interrupt(): void {
    const store = this.live?.store;
    if (!store) return;
    if (store.onInterrupt) store.onInterrupt();
    else store.cancel();
  }

  // -- shares, follows, changes ---------------------------------------------

  /** A file or folder main authorized for the request the binding names. */
  async shareAdd(path: string, kind: "file" | "folder", binding: RequestBinding): Promise<ShareGrant> {
    const live = this.bound(binding);
    let files: SharedFiles;
    if (live.running?.binding.requestId === binding.requestId) files = live.running.files;
    else {
      if (live.pending?.binding.requestId !== binding.requestId) {
        live.pending?.revoke();
        live.pending = new SharedFiles(binding, live.follows);
      }
      files = live.pending;
    }
    const grant = await files.grant(path, kind);
    this.changed();
    return grant;
  }

  shareRemove(shareId: string, binding: RequestBinding): void {
    const live = this.bound(binding);
    const files = live.running?.binding.requestId === binding.requestId ? live.running.files
      : live.pending?.binding.requestId === binding.requestId ? live.pending : null;
    if (!files) throw new Error("that share isn't part of this request");
    files.revoke(shareId);
    this.changed();
  }

  async followAdd(path: string): Promise<FollowGrant> {
    const follow = await this.need().follows.add(path);
    this.changed();
    return follow;
  }

  followRemove(followId: string): void {
    this.need().follows.remove(followId);
    this.changed();
  }

  /** Put back what a change wrote, only if the file still has Dum's bytes. A UI action, valid after its request ended. */
  async changeRevert(changeId: string, binding: InputBinding): Promise<ChangeReceipt> {
    const init = this.ready();
    const live = this.bound(binding, false);
    const receipt = await revertChange(init.home, live.zone.id, binding, changeId);
    if (this.live === live) {
      live.store.diff(receipt.target, receipt.diff, "reverted", receipt.id);
      this.refreshChanges(init, live);
      this.changed();
    }
    return receipt;
  }

  // -- the tree, its web copy, records --------------------------------------

  /** Main collected the unaided attestation for an add natively; taking a skill off is theirs to do. */
  skillEdit(edit: "add" | "remove", skill: SkillRef): void {
    const init = this.ready();
    const said = this.editSkill(init, edit, skill);
    this.live?.store.note(said);
  }

  async treeSync(sync: TreeSync): Promise<string | null> {
    this.ready();
    switch (sync.action) {
      case "link": return web.link(sync.server);
      case "rotate": return web.rotate();
      case "off": await web.unlink(); return null;
      case "sync": {
        const result = await web.syncNow();
        if (!result.ok) throw new Error(result.why);
        if (result.pulled) this.treeChanged();
        return null;
      }
    }
  }

  /** The app-owned file main may open for the active zone: its memory notes, or one change's patch. */
  openRecord(record: "change" | "memory", recordId?: string): string {
    const init = this.ready();
    const live = this.need();
    const dir = `zones/${live.zone.id}`;
    if (record === "memory") {
      createState(init.home, `${dir}/memory.md`, "# Zone memory\n\n");
      return statePath(init.home, `${dir}/memory.md`);
    }
    if (!recordId || !listChanges(init.home, live.zone.id).some((m) => m.id === recordId)) throw new Error("there's no such change in this zone");
    return statePath(init.home, `${dir}/changes/${recordId}/change.patch`);
  }

  // -- the look ---------------------------------------------------------------

  async observeTick(tick: Tick): Promise<void> {
    const live = this.live;
    if (!this.init || !live || this.closed) return;
    await live.ambient.tick(tick);
  }

  observeFrame(checkId: string, image: Picture | null): void {
    this.frames.answer(checkId, image);
  }

  // -- closing ----------------------------------------------------------------

  /** End the open conversation and let H go. Stop first, so nothing slow holds the queue. */
  close(): Promise<void> {
    this.interrupt();
    return this.serial(async () => {
      if (this.closed) return;
      this.closed = true;
      if (this.live) await this.shutdown();
      this.credentials.fail("Dum is closing");
      this.frames.fail("Dum is closing");
      this.init?.release();
    });
  }

  // -- internals --------------------------------------------------------------

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      if (this.closed) throw new Error("Dum is closing");
      return step();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async now(step: () => void): Promise<undefined> {
    step();
    return undefined;
  }

  private ready(): Init {
    if (this.closed) throw new Error("Dum is closing");
    if (!this.init) throw new Error("the teaching host isn't set up yet");
    return this.init;
  }

  private need(): Live {
    this.ready();
    if (!this.live) throw new Error("enter a zone first");
    return this.live;
  }

  /** The open zone the binding was made for; with `token`, also the prompt showing now. */
  private bound(binding: InputBinding, token = true): Live {
    this.ready();
    const live = this.live;
    if (!live || binding.zoneId !== live.zone.id || binding.zoneEpoch !== live.epoch) {
      throw new Error("that was meant for a zone that isn't open any more - nothing happened");
    }
    if (token && binding.inputToken !== this.tokenOf(live)) throw new Error("that prompt closed before your message arrived - nothing was sent");
    return live;
  }

  /** The running request a nested answer belongs to: same request ID, whatever prompt it's on now. */
  private runningFor(live: Live, binding: RequestBinding): Job {
    if (!live.running || live.running.binding.requestId !== binding.requestId) throw new Error("that answer was meant for a request that's over - nothing was sent");
    return live.running;
  }

  /** Names the prompt taking input right now; a token no prompt accepts otherwise. */
  private tokenOf(live: Live | null): string {
    if (!live) return this.idle;
    const prompt = live.store.getSnapshot().prompt;
    if (!prompt || !live.store.inputReady) return live.idle;
    let token = this.tokens.get(prompt);
    if (!token) {
      token = randomUUID();
      this.tokens.set(prompt, token);
    }
    return token;
  }

  /** A binding the host issues itself, for work no request of theirs started: a look, a panel. */
  private hostBinding(live: Live): RequestBinding {
    return { zoneId: live.zone.id, zoneEpoch: live.epoch, inputToken: this.tokenOf(live), requestId: randomUUID() };
  }

  /**
   * The request's own SharedFiles: the shares chosen for this request ID, keeping only those the
   * send still names. A named share the host doesn't hold for this request is refused.
   */
  private claim(live: Live, binding: RequestBinding, shares: ShareGrant[]): SharedFiles {
    const pending = live.pending?.binding.requestId === binding.requestId ? live.pending : null;
    const held = new Set((pending?.grants() ?? []).filter((g) => g.scope === "request").map((g) => g.id));
    const zone = new Set(live.follows.list().map((f) => f.id));
    for (const s of shares) {
      if (s.scope === "zone" ? !zone.has(s.id) : !held.has(s.id)) throw new Error(`${s.label} isn't shared any more - share it again. Nothing was sent`);
    }
    if (!pending) {
      live.pending?.revoke();
      live.pending = null;
      return new SharedFiles(binding, live.follows);
    }
    live.pending = null;
    const named = new Set(shares.map((s) => s.id));
    for (const id of held) if (!named.has(id)) pending.revoke(id);
    return pending;
  }

  private startCommand(init: Init, live: Live, request: Job, name: string, argument: string): void {
    prepare(live.zone, init.settings.mode, live.store, this.personal(init), init.evidence, request.files, init.registry, request.binding);
    request.files.activate();
    live.running = request;
    this.changed();
    void live.store.command(name, argument).finally(() => this.finish(init, live, request));
  }

  /** A request or command ended, however: its shares lapse and the change list catches up. */
  private finish(init: Init, live: Live, request: Job): void {
    request.files.revoke();
    if (live.running === request) live.running = null;
    if (this.live !== live) return;
    this.refreshChanges(init, live);
    this.changed();
  }

  private personal(init: Init): context.Context {
    return init.settings.personalContext ? init.personal : NO_PERSONAL;
  }

  /**
   * Main's copy of the choice. Refused when this flavor doesn't offer it or its backend isn't
   * here; a refused choice changes nothing, except at setup, where it's kept as the reason the
   * conversation can't start until a choice is made again.
   */
  private applyAgent(init: Init, choice: AgentChoice | null, strict: boolean): void {
    try {
      // Main validated it for its flavor already; the host's own flavor decides again (rule 7).
      if (choice && !agentChoiceSchema(init.flavor).safeParse(choice).success) throw new Error(`that choice isn't offered in a ${init.flavor} build`);
      init.registry.set(choice);
    } catch (err) {
      if (strict) throw err;
      init.registry.set(null);
      init.agentError = (err as Error).message;
      init.settings = { ...init.settings, agent: null };
      return;
    }
    init.agentError = null;
    init.settings = { ...init.settings, agent: choice };
    this.live?.store.setModel("intern", choice?.intern ?? null);
    this.live?.store.setModel("helper", choice?.helper ?? null);
  }

  private askCredential(need: CredentialNeed, signal: AbortSignal): Promise<{ value: string; expiresAt: number | null } | null> {
    return this.credentials.ask(
      (requestId) => this.o.post({ type: "credential-request", epoch: this.o.epoch, requestId, need }),
      this.o.credentialMs ?? 30_000,
      "Dum's main process didn't answer the credential request in time",
      signal,
    );
  }

  private async frame(): Promise<Picture | null> {
    try {
      return await this.frames.ask(
        (checkId) => this.o.post({ type: "frame-request", epoch: this.o.epoch, checkId }),
        this.o.frameMs ?? 10_000,
        "no frame came back in time",
      );
    } catch {
      return null;
    }
  }

  private editSkill(init: Init, edit: "add" | "remove", skill: SkillRef): string {
    const label = skills.label(skill);
    let said: string;
    if (edit === "add") {
      const live = this.need();
      const result = init.evidence.selfReport({ zoneId: live.zone.id, zoneName: live.store.getSnapshot().zoneName, store: live.store }, skill, true);
      if (!result.ok) throw new Error(result.why);
      said = `${label}: ${result.why}`;
    } else {
      if (!skills.remove(skill.name, skills.langName(skill.lang))) throw new Error(`${label} isn't on your tree`);
      web.soon();
      said = `${label} is off your tree.`;
    }
    this.treeChanged();
    return said;
  }

  private treeChanged(): void {
    const tree = skills.read();
    this.treeView = view(tree);
    this.live?.store.setUnlocked(tree.skills.length);
    this.changed();
  }

  /** The registry changed: the open zone's context is re-resolved, so work bound to the old revision is dropped. */
  private zonesChanged(): void {
    this.zoneList = zones.listZones();
    const live = this.live;
    if (live && this.zoneList.zones.some((z) => z.id === live.zone.id && z.deletedAt === null)) live.zone = zones.resolveZone(live.zone.id);
    this.changed();
  }

  private refreshChanges(init: Init, live: Live): void {
    try {
      live.changes = listChanges(init.home, live.zone.id).slice(0, LISTED_CHANGES).map((m) => {
        let patch: string;
        try {
          patch = readState(init.home, `zones/${live.zone.id}/changes/${m.id}/change.patch`, PATCH_BYTES) ?? "";
        } catch {
          patch = "";
        }
        return {
          id: m.id, zoneId: m.zoneId, target: m.target, baseSha: m.baseSha, nextSha: m.nextSha,
          diff: patch ? bound(patch, MORE) : MORE, appliedAt: m.revertedAt ?? m.createdAt, revertible: m.revertedAt === null,
        };
      });
    } catch (err) {
      live.store.note(`couldn't list this zone's changes: ${(err as Error).message}`);
    }
  }

  private grantsFor(live: Live): ShareGrant[] {
    const files = live.running?.files ?? live.pending;
    if (files) return files.grants();
    const followed = live.follows.resources().list();
    return live.follows.list().map((f) => ({ id: f.id, kind: "folder", scope: "zone", label: f.label, files: followed.filter((p) => p.startsWith(`${f.id}/`)) }));
  }

  /** Open a zone's conversation with a fresh epoch. Nothing from an earlier open is waiting for anything. */
  private start(init: Init, zoneId: ZoneId): void {
    const zone = zones.resolveZone(zoneId);
    const store = new Store({ id: zone.id, name: zone.breadcrumb.at(-1)!.name }, init.settings.mode);
    const follows = new Follows(init.home, zone.id);
    const saved = memory.load(init.home, zone.id);
    store.restoreTranscript(saved.entries);
    const stopMemory = memory.attach(init.home, zone.id, store);
    store.setModel("intern", init.settings.agent?.intern ?? null);
    store.setModel("helper", init.settings.agent?.helper ?? null);
    const tree = skills.read();
    store.setUnlocked(tree.skills.length);
    this.treeView = view(tree);

    store.onMemory = () => memory.describe(init.home, zone.id);
    store.onRemember = (note) => store.note(`remembered: ${memory.remember(init.home, zone.id, note)}`);
    store.onContext = () => context.describe(this.personal(init));
    store.onSkills = (arg) => treeText(skills.read(), live.zone.language, arg);
    store.onBoundary = () => boundary.lines(boundary.boundary(skills.read(), this.grantsFor(live), init.evidence.held)).join("\n");
    store.onEvidence = () => init.evidence.describe(zone.id);
    store.onSkillEdit = (action, name, lang) => {
      try {
        store.note(this.editSkill(init, action === "add" ? "add" : "remove", { name, lang: lang || live.zone.language }));
      } catch (err) {
        store.note((err as Error).message);
      }
    };

    let unlocked = store.getSnapshot().unlocked;
    const unsubscribe = store.subscribe(() => {
      const now = store.getSnapshot().unlocked;
      if (now !== unlocked) this.treeView = view(skills.read());
      unlocked = now;
      if (this.live === live) this.changed();
    });

    const live: Live = {
      zone, epoch: randomUUID(), store, follows, ambient: null as unknown as Ambient, stop: new AbortController(),
      detach: () => { unsubscribe(); stopMemory(); }, done: Promise.resolve(), pending: null, running: null, next: null,
      changes: [], signals: new Map(), look: LOOK_STATUS.watching, idle: randomUUID(),
    };
    live.ambient = this.ambient(init, live);
    this.refreshChanges(init, live);

    if (saved.entries.length) store.note(`restored ${saved.entries.length} conversation entries - they're history: nothing in them is waiting for an answer`);
    if (saved.warning) store.note(saved.warning);
    const personal = this.personal(init);
    if (personal.text) store.note(`personal context loaded: ${personal.path}`);
    if (personal.warning) store.note(personal.warning);
    const left = zones.omittedNotes(zone);
    if (left.length) store.note(`context notes left out (too large or unreadable): ${left.map((b) => b.name).join(", ")}`);

    this.live = live;
    live.done = this.converse(init, live);
  }

  private ambient(init: Init, live: Live): Ambient {
    const mine = () => this.live === live && !this.closed;
    return new Ambient({
      now: Date.now,
      blocked: (t) => {
        if (!mine() || t.zoneId !== live.zone.id || t.epoch !== live.epoch || init.agentError) return true;
        try { init.registry.chosen(); } catch { return true; }
        const s = live.store.getSnapshot();
        return !!live.running || s.busy || s.prompt?.type !== "next" || !live.store.canAttach;
      },
      scan: async () => {
        if (!mine()) return [];
        const signals = await live.follows.scan();
        for (const s of signals) live.signals.set(s.path, s);
        return signals;
      },
      diff: async (paths) => {
        const signals = paths.flatMap((p) => {
          const s = live.signals.get(p);
          live.signals.delete(p);
          return s ? [s] : [];
        });
        return live.follows.diff(signals);
      },
      frame: () => this.frame(),
      context: () => (mine() ? { zone: live.zone, binding: this.hostBinding(live), practicing: practicing(init.home, live.zone.id) } : null),
      imagesAllowed: () => {
        if (!init.settings.look.screen) return false;
        try {
          const selector = init.registry.selector("helper");
          return init.registry.backend(selector.backend).capabilities(selector).images;
        } catch {
          return false;
        }
      },
      check: (input, signal) => live.store.helper((stop) => wizard.ambient(input, {
        agent: init.registry,
        cwd: dirname(statePath(init.home, `zones/${input.zone.id}/runtime/cwd`)),
        signal: AbortSignal.any([signal, stop]),
      })),
      record: async (result, input) => {
        // A result for another zone, epoch or context revision is about something they've moved on from.
        if (!mine() || input.binding.zoneEpoch !== live.epoch || input.zone.revision !== live.zone.revision) return;
        if (result.note) memory.remember(init.home, live.zone.id, result.note);
        if (result.aside) live.store.quip(result.aside);
      },
      status: (status) => {
        live.look = LOOK_STATUS[status];
        if (mine()) this.changed();
      },
    });
  }

  /** Request after request until closed. Each gets the context `send` prepared for it, and its shares lapse when it ends. */
  private async converse(init: Init, live: Live): Promise<void> {
    const { store, stop } = live;
    while (!stop.signal.aborted) {
      let request: string;
      try {
        request = (await store.askNext()).trim();
      } catch (err) {
        if (err instanceof Cancelled && !err.final) continue;
        return;
      }
      const next = live.next;
      live.next = null;
      if (!next) continue;
      if (!request) {
        next.files.revoke();
        continue;
      }
      live.running = next;
      this.changed();
      try {
        await run(request, next.ctx, { signal: stop.signal });
      } finally {
        this.finish(init, live, next);
      }
    }
  }

  /** Everything in the open zone stops and is saved; only then is it gone. */
  private async shutdown(): Promise<void> {
    const live = this.live!;
    this.live = null;
    live.ambient.close();
    live.stop.abort();
    live.store.close();
    live.pending?.revoke();
    live.running?.files.revoke();
    live.next?.files.revoke();
    try {
      memory.save(this.init!.home, live.zone.id, live.store.getSnapshot().transcript);
    } catch { /* attach saved it as it went */ }
    live.detach();
    const { promise: late, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, WIND_DOWN_MS);
    await Promise.race([Promise.all([live.done, live.store.settled()]), late]);
    clearTimeout(timer);
  }

  /** State goes to main at most once per turn of the event loop. */
  private changed(): void {
    if (this.scheduled || !this.init || this.closed) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (!this.init || this.closed) return;
      const live = this.live;
      this.o.post({
        type: "state",
        epoch: this.o.epoch,
        state: live?.store.getSnapshot() ?? null,
        tree: this.treeView,
        registry: this.zoneList,
        activeZone: live?.zone ?? null,
        zoneEpoch: live?.epoch ?? null,
        inputToken: this.tokenOf(live),
        canAttach: !!live && !live.running && live.store.canAttach,
        shares: live ? (live.running?.files ?? live.pending)?.grants().filter((g) => g.scope === "request") ?? [] : [],
        follows: live?.follows.list() ?? [],
        changes: live?.changes ?? [],
        look: { status: live ? live.look : "enter a zone for the look" },
      });
    });
  }
}

/**
 * The process side: validated requests in, typed replies and events out, over Electron's
 * parentPort or, outside Electron, the Node IPC channel. Exits once closed.
 */
export function serve(o: Omit<ControllerOptions, "post">): DesktopController {
  const port = process.parentPort;
  const post = (message: HostEvent) => {
    if (port) port.postMessage(message);
    else process.send?.(message);
  };
  const controller = new DesktopController({ ...o, post });
  let closing = false;
  const receive = async (value: unknown) => {
    const parsed = HostRequestSchema.safeParse(value);
    if (!parsed.success || parsed.data.epoch !== o.epoch || closing) return;
    const request = parsed.data;
    if (request.op === "close") closing = true;
    try {
      const result = await controller.handle(request);
      post({ type: "reply", epoch: o.epoch, id: request.id, ok: true, ...(result ? { result } : {}) });
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "the teaching host couldn't complete that action";
      post({ type: "reply", epoch: o.epoch, id: request.id, ok: false, error: message.slice(0, 2000) });
    }
    if (request.op === "close") setImmediate(() => process.exit(0));
  };
  const end = () => {
    closing = true;
    void controller.close().catch(() => undefined).finally(() => process.exit(0));
  };
  if (port) port.on("message", (event) => void receive(event.data));
  else process.on("message", (value) => void receive(value));
  process.on("SIGTERM", end);
  process.on("disconnect", end);
  process.on("uncaughtException", (err) => {
    post({ type: "fatal", epoch: o.epoch, message: (err.message || "the teaching host failed").slice(0, 2000) });
    end();
  });
  post({ type: "ready", epoch: o.epoch });
  return controller;
}

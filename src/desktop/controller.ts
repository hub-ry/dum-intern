// The utility host's whole job: the H writer lock, the zone graph, global evidence, the agent registry,
// the active zone's conversation, request-bound shares, followed folders, changes and the look; and,
// for the delegation loop, every zone's goal alignment, the Wizard's decision cards, the handoff the
// user commands, the durable session trail and the read-only debug chat. No Electron here. Main
// talks to it through host-protocol.ts; `serve` is the process side of that.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as zones from "../zones.ts";
import * as memory from "../memory.ts";
import * as context from "../context.ts";
import * as skills from "../skills.ts";
import * as curriculum from "../curriculum.ts";
import * as gate from "../gate.ts";
import * as boundary from "../boundary.ts";
import * as web from "../web.ts";
import * as wizard from "../wizard.ts";
import * as mapping from "../trail-mapping.ts";
import { acquire } from "../session-lock.ts";
import { Evidence } from "../evidence.ts";
import { LedgerSchema } from "../evidence-types.ts";
import { Follows } from "../follow.ts";
import { SharedFiles, bound } from "../shared-files.ts";
import { listChanges, revertChange } from "../changes.ts";
import { Ambient, observe, type AmbientView } from "../ambient.ts";
import { Store, Cancelled, parseCommand } from "../store.ts";
import { prepare, run, type Ctx, type RunEnd, type SessionHooks } from "../session.ts";
import { Practice } from "../practice.ts";
import { Directions, contextRevision, goalHash } from "../directions.ts";
import { Delegations } from "../delegations.ts";
import { Trails, decisionKey } from "../trails.ts";
import { Diagnostics } from "../diagnostics.ts";
import { DebugChat } from "../debug-chat.ts";
import { treeText } from "../tree.ts";
import { createRegistry, RELEASED, type Registry } from "../agent/registry.ts";
import { AgentChoiceSchema, ROLES } from "../agent/schema.ts";
import { createState, readState, statePath } from "../state-files.ts";
import { DELEGATION_LIMITS } from "../delegation-types.ts";
import { TRAIL_LIMITS } from "../trail-types.ts";
import { view as treeView, type View } from "../web/view.ts";
import { HostRequestSchema, type HostEvent, type HostRequest, type HostResult } from "./host-protocol.ts";
import type { AgentBackend, AgentChoice, BackendId, CredentialNeed, CredentialSource, LoginMethod, ModelOption, Picture, Selector } from "../agent/types.ts";
import type {
  AlignmentAcceptInput, AlignmentAttempt, AlignmentBinding, AlignmentStepInput, ContextRef, ContextRefKind, ContextUseItem, ContextUsePage,
  ContextUseView, DecisionInput, DecisionResult, DecisionView, DelegationOption, DelegationProposal, Direction, DirectionOption, DirectionView,
  Handoff, HandoffDismissInput, HandoffEditInput, HandoffResult, HandoffReviewInput, HandoffRunInput, HandoffSelectInput, HandoffView,
  IgnoreObservationInput,
} from "../delegation-types.ts";
import type { DebugBinding, DebugView, DiagnosticSettings, MainStatus, SanitizedMainEvent } from "../diagnostic-types.ts";
import type { FileSignal, HostLookStatus, LookReason, Tick } from "../observe-types.ts";
import type { InputBinding, RequestBinding, ResourcePath, ShareGrant } from "../share-types.ts";
import type { SharedImage } from "../store-types.ts";
import type {
  DecisionEventInput, EndReason, SessionMeta, StoryPage, StoryQuery, TopicHint, TrailMapInput, TrailPage, TrailQuery, TrailSource, TrailSourceInput,
} from "../trail-types.ts";
import type { ChangeReceipt, FollowGrant, SkillRef, Zone, ZoneContext, ZoneId, ZoneRegistry } from "../zone-types.ts";
import type { DesktopPreferences, TreeSync, ViewName, ZoneCreate, ZonePatch } from "./protocol.ts";

/** How long switching waits for the old conversation to wind down before going on regardless. Main's close gives up at 5 s. */
const WIND_DOWN_MS = 4_000;
/** Changes listed in the state event, newest first; each diff is bounded. */
const LISTED_CHANGES = 50;
const PATCH_BYTES = 1024 * 1024;
const MORE = "the full patch is kept with the change";
const NO_PERSONAL: context.Context = { path: "", text: "", warning: "" };
/** A session ends after this long without eligible activity. */
const IDLE_MS = 30 * 60_000;
const IDLE_CHECK_MS = 60_000;
/** How much recent conversation one decision may cite. */
const CONVERSATION_ENTRIES = 6;
const L = DELEGATION_LIMITS;

/** The commands that call a model; every other command, and the views, work before any backend is chosen. */
const MODEL_COMMANDS: Record<string, true> = { projects: true, submit: true };

/** What the host builds its backends from; main never sees these. `home` is H, for backend-owned records. */
export type BackendFactory = (o: { home: string; claudeExecutable: string | null; credential: CredentialSource }) => AgentBackend[];

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
  registry: Registry;
  evidence: Evidence;
  directions: Directions;
  delegations: Delegations;
  trails: Trails;
  diagnostics: Diagnostics;
  debug: DebugChat;
  release: () => void;
  personal: context.Context;
  settings: DesktopPreferences;
  /** Why main's agent choice couldn't be applied, until it's chosen again. */
  agentError: string | null;
};

/** One request or command: its shares, the binding it runs under, and the handoff it carries out, if any. */
type Job = { files: SharedFiles; binding: RequestBinding; handoff: Handoff | null };

/** The one latest decision card in host memory, and what it was composed from. */
type Decision = { view: DecisionView; input: DecisionInput };

/** What Dum asked the Wizard for, kept until the turn that asked ends. `said` is that turn's live list. */
type Summon = { outcome: string; why: string; said: readonly string[] };

/** What the latest decision or request used: Current context's Using inventory. */
type Use = { subject: NonNullable<ContextUseView["subject"]>; contextRevision: string; items: ContextUseItem[] };

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
  look: AmbientView;
  /** Token for "no prompt is taking input": never accepted by a prompt. */
  idle: string;
  /** The durable learning session, or null after it ended idle (the next eligible activity starts one). */
  session: SessionMeta | null;
  lastActivity: number;
  idleTimer: NodeJS.Timeout;
  decision: Decision | null;
  /** Decision help in flight: a new one, dismissal and Stop abort it. */
  deciding: AbortController | null;
  /**
   * Dum's one Wizard summons per turn, keyed by the request that asked. `queued` lands when that
   * turn ends; dismissal empties it, and the key alone refuses a second ask until the next send.
   */
  summon: { requestId: string; queued: Summon | null } | null;
  use: Use | null;
  /** Ready handoffs a reload made stale: they need a refresh before Do this. */
  stale: Set<string>;
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

// -- context references -------------------------------------------------------

const encoder = new TextEncoder();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** At most `max` UTF-8 bytes of `text`, cut on a character boundary. */
function clipBytes(text: string, max: number): string {
  if (encoder.encode(text).length <= max) return text;
  let out = text.slice(0, max);
  while (encoder.encode(out).length > max - 3) out = out.slice(0, -1);
  return `${out.replace(/[\uD800-\uDBFF]$/, "")}...`;
}

/**
 * A host-issued reference. The id is derived from what it names, so the same source keeps the same
 * id; the revision is the digest of the content used. Models may cite only ids they were given.
 */
function contextRef(kind: ContextRefKind, key: string, label: string, text: string, at: string | null): ContextRef {
  const hex = sha256(`${kind}\0${key}`);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return {
    id, kind, label: label.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, L.labelChars) || kind,
    revision: sha256(text), at, excerpt: clipBytes(text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " "), L.excerptBytes),
  };
}

/** A cursor into the Using inventory, bound to the subject it pages. */
function useCursor(subject: string, offset: number): string {
  return `${offset}_${subject.replace(/[^A-Za-z0-9]/g, "").slice(0, 64)}`;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

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
  /** Alignment model work in flight, for any zone: Stop and close abort it. */
  private readonly aligning = new Set<AbortController>();

  constructor(private readonly o: ControllerOptions) {}

  /**
   * One validated request. Credential and frame answers, ticks, model catalogs, reads, debug chat,
   * diagnostics and Stop never wait behind another operation: an operation may itself be waiting
   * on one of them. Decision help and alignment steps serialize their checks and their writes, but
   * not the model call between them. Everything else runs strictly in order.
   */
  handle(r: HostRequest): Promise<HostResult | undefined> {
    switch (r.op) {
      case "credential": return this.now(() => this.credential(r.requestId, r.value));
      case "observe-frame": return this.now(() => this.observeFrame(r.checkId, r.image));
      case "observe-tick": return this.observeTick(r.tick).then(() => undefined);
      case "agent-models": return this.agentModels(r.backend, r.login).then((models) => ({ models }));
      case "agent-verify-images": return this.agentVerifyImages(r.selector, r.login).then(() => undefined);
      case "interrupt": return this.now(() => this.interrupt());
      case "close": return this.close().then(() => undefined);
      case "alignment-read": return this.alignmentRead(r.zoneId).then((direction) => ({ direction }));
      case "direction-read": return this.directionRead(r.zoneId, r.directionId).then((directionRecord) => ({ directionRecord }));
      case "handoff-read": return this.readHandoff(r.zoneId, r.handoffId).then((handoff) => ({ handoff }));
      case "context-use-read": return this.contextUseRead(r.binding, r.cursor).then((contextUse) => ({ contextUse }));
      case "trail-read": return this.trailRead({ zoneId: r.zoneId, sessionId: r.sessionId, cursor: r.cursor }).then((trail) => ({ trail }));
      case "trail-source": return this.trailSource(r.zoneId, r.sessionId, r.sourceId).then((trailSource) => ({ trailSource }));
      case "story-read": return this.storyRead({ zoneId: r.zoneId, skill: r.skill, from: r.from, to: r.to, cursor: r.cursor }).then((story) => ({ story }));
      case "debug-open": return this.debugOpen().then((debug) => ({ debug }));
      case "debug-send": return this.debugSend(r.binding, r.text).then(() => undefined);
      case "debug-stop": return this.debugStop(r.binding).then(() => undefined);
      case "debug-reset": return this.debugReset().then((debug) => ({ debug }));
      case "diagnostic-main": return this.now(() => this.diagnosticMain(r.events, r.status));
      case "decision-help": return this.decisionHelp(r.binding, r.outcome).then((decision) => ({ decision }));
      case "alignment-step": {
        const input: AlignmentStepInput = r.action === "answer"
          ? { binding: r.binding, action: "answer", questionId: r.questionId, text: r.text }
          : { binding: r.binding, action: r.action };
        return this.alignmentStep(input).then((direction) => ({ direction }));
      }
      default: return this.serial(() => this.ordered(r));
    }
  }

  private async ordered(r: Exclude<HostRequest, { op:
    | "credential" | "observe-frame" | "observe-tick" | "agent-models" | "agent-verify-images" | "interrupt" | "close" | "alignment-read" | "direction-read"
    | "handoff-read" | "context-use-read" | "trail-read" | "trail-source" | "story-read" | "debug-open" | "debug-send" | "debug-stop"
    | "debug-reset" | "diagnostic-main" | "decision-help" | "alignment-step" }>): Promise<HostResult | undefined> {
    switch (r.op) {
      case "initialize": this.initialize(r.home, r.claudeExecutable, r.personal, r.settings, r.main); return undefined;
      case "zone-create": return await this.createZone(r.zone, r.enter);
      case "zone-enter": await this.openZone(r.zoneId, r.expectedRevision); return undefined;
      case "zone-update": return this.updateZone(r.zoneId, r.patch, r.expectedRevision);
      case "zone-context": return { context: this.zoneContext(r.zoneId, r.text, r.expectedRevision) };
      case "zone-delete": return { deleted: await this.deleteZone(r.zoneId, r.expectedRevision) };
      case "settings": await this.settings(r.settings); return undefined;
      case "agent-select": await this.agentSelect(r.choice); return undefined;
      case "send": await this.send(r.binding, r.text, r.shares, r.image); return undefined;
      case "respond": this.respond(r.binding, r.decision); return undefined;
      case "command": this.command(r.name, r.argument, r.binding); return undefined;
      case "view": this.view(r.view); return undefined;
      case "share-add": return { share: await this.shareAdd(r.path, r.kind, r.binding) };
      case "share-remove": this.shareRemove(r.shareId, r.binding); return undefined;
      case "follow-add": return { follow: await this.followAdd(r.path) };
      case "follow-remove": this.followRemove(r.followId); return undefined;
      case "change-revert": return { change: await this.changeRevert(r.changeId, r.binding) };
      case "skill-edit": this.skillEdit(r.edit, r.skill); return undefined;
      case "tree-sync": { const url = await this.treeSync(r.sync); return url ? { url } : undefined; }
      case "open-record": return { path: r.record === "personal" ? this.openPersonal(r.sourceId) : this.openRecord(r.record, r.recordId) };
      case "alignment-accept": {
        const { binding, choiceId, ability, reviewCriterion, assumptions, ownDirection } = r;
        return { direction: await this.alignmentAccept({ binding, choiceId, ability, reviewCriterion, assumptions, ...(ownDirection ? { ownDirection } : {}) }) };
      }
      case "decision-dismiss": await this.decisionDismiss(r.binding, r.decisionId, r.revision); return undefined;
      case "handoff-select": return { handoff: await this.selectHandoff({ binding: r.binding, decisionId: r.decisionId, revision: r.revision, optionId: r.optionId }) };
      case "handoff-edit": return { handoff: await this.editHandoff({ binding: r.binding, handoffId: r.handoffId, revision: r.revision, patch: r.patch }) };
      case "handoff-dismiss": await this.dismissHandoff({ binding: r.binding, handoffId: r.handoffId, revision: r.revision }); return undefined;
      case "handoff-run": {
        await this.runHandoff({ binding: r.binding, handoffId: r.handoffId, revision: r.revision, shares: r.shares, ...(r.image ? { image: r.image } : {}) });
        return undefined;
      }
      case "handoff-review": return { handoff: await this.reviewHandoff({ binding: r.binding, handoffId: r.handoffId, revision: r.revision, verdict: r.verdict }) };
      case "context-reload": await this.contextReload(r.binding, r.personal); return undefined;
      case "context-ignore-observation": {
        await this.contextIgnoreObservation({ binding: r.binding, sourceId: r.sourceId, expectedCorrectionRevision: r.expectedCorrectionRevision });
        return undefined;
      }
      case "session-new": await this.newSession(r.binding); return undefined;
      case "trail-map": await this.trailMap({ binding: r.binding, sessionId: r.sessionId, gapId: r.gapId, skill: r.skill }); return undefined;
    }
  }

  // -- setup ------------------------------------------------------------------

  /**
   * Take H for this host, build the backends, the registry and the delegation owners, close what a
   * crash left open (sessions and running handoffs become interrupted, never replayed), apply main's
   * settings copy, and open the active zone.
   */
  initialize(home: string, claudeExecutable: string | null, personal: context.Context, settings: DesktopPreferences, main: MainStatus): void {
    if (this.init) throw new Error("this host is already set up");
    // Every module that keeps state resolves H through skills.home(); this host serves exactly one.
    process.env.DUM_HOME = home;
    const release = acquire(home);
    try {
      const backends = this.o.backends({ home, claudeExecutable, credential: (need, signal) => this.askCredential(need, signal) });
      const released = new Set((Object.keys(RELEASED) as BackendId[]).filter((id) => RELEASED[id]));
      const registry = createRegistry(backends, released);
      const diagnostics = new Diagnostics(Date.now, main, diagnosticSettings(settings));
      const debugCwd = join(home, "debug", "runtime");
      mkdirSync(debugCwd, { recursive: true, mode: 0o700 });
      const init: Init = {
        home, registry, evidence: new Evidence(home), release, personal, settings, agentError: null,
        directions: new Directions(home, Date.now), delegations: new Delegations(home, Date.now), trails: new Trails(home, Date.now),
        diagnostics,
        debug: new DebugChat(registry, diagnostics, debugCwd, () => this.o.post({ type: "debug-state", epoch: this.o.epoch, view: this.init?.debug.view() ?? null })),
      };
      this.applyAgent(init, settings.agent, false);
      this.zoneList = zones.listZones();
      this.recover(init);
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
    const was = init.settings;
    init.settings = { ...settings, agent: was.agent };
    init.diagnostics.settings(diagnosticSettings(init.settings));
    try {
      await this.agentChanged(init, settings.agent, true);
    } finally {
      const live = this.live;
      if (live && was.mode !== settings.mode) {
        // The mode is fixed for a conversation, so a new mode reopens the zone fresh: a reconfiguration.
        const id = live.zone.id;
        const ended = await this.shutdown();
        this.endSession(init, ended, "reconfigure");
        this.start(init, id);
      } else if (live && was.personalContext !== settings.personalContext) this.reconfigure(init, live);
      this.changed();
    }
  }

  async agentSelect(choice: AgentChoice | null): Promise<void> {
    const init = this.ready();
    await this.agentChanged(init, choice, true);
    this.changed();
  }

  async agentModels(backend: BackendId, login: LoginMethod): Promise<ModelOption[]> {
    const init = this.ready();
    return init.registry.backend(backend).models(login, AbortSignal.timeout(60_000));
  }

  /**
   * Verify for pictures: one small real call to `selector` on its own backend, never another. Refused
   * while a request runs so the probe can't race the conversation's session for the key or the catalog.
   */
  async agentVerifyImages(selector: Selector, login: LoginMethod): Promise<void> {
    const init = this.ready();
    if (this.live?.running) throw new Error("finish what dum is doing first, or Stop it");
    const backend = init.registry.backend(selector.backend);
    if (!backend.verifyImages) throw new Error(`${backend.label} doesn't need verifying for pictures`);
    await backend.verifyImages(selector, login, AbortSignal.timeout(60_000));
  }

  /** Main's answer to a credential request. Values are handed to the waiting backend and kept nowhere. */
  credential(requestId: string, value: { value: string; expiresAt: number | null } | null): void {
    this.credentials.answer(requestId, value);
  }

  // -- zones ------------------------------------------------------------------

  /** A new zone, and its goal-start alignment: an attempt for that zone, never for the active one. */
  async createZone(input: ZoneCreate, enter: boolean): Promise<{ zone: Zone; direction: DirectionView }> {
    const init = this.ready();
    const zone = zones.createZone(input);
    this.zonesChanged();
    const resolved = zones.resolveZone(zone.id);
    init.directions.begin(resolved, this.zoneRefs(init, resolved).used);
    if (enter) await this.openZone(zone.id, this.zoneList.revision);
    return { zone, direction: this.directionView(init, zones.resolveZone(zone.id)) };
  }

  /**
   * Enter a zone: validated before anything open is touched, then the open conversation ends, the
   * destination becomes active and opens with a fresh epoch and a fresh session. If it can't open,
   * the previous zone reopens fresh; nothing it was waiting on comes back.
   */
  async openZone(zoneId: ZoneId, expectedRevision: number): Promise<void> {
    const init = this.ready();
    zones.resolveZone(zoneId);
    if (zones.listZones().revision !== expectedRevision) throw new Error("zones changed since this was shown - refresh and try again");
    if (this.live?.zone.id === zoneId) return;
    const previous = this.live?.zone.id ?? null;
    const ended = this.live ? await this.shutdown() : null;
    zones.setActiveZone(zoneId, expectedRevision);
    this.zonesChanged();
    try {
      this.start(init, zoneId);
      this.endSession(init, ended, "leave");
    } catch (err) {
      this.endSession(init, ended, "switch-attempt");
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

  /**
   * Rename, re-language or re-goal a zone. A changed goal makes its old direction non-current,
   * cancels its ready handoff and open card, and starts a new alignment attempt for that zone. The
   * same goal text or a rename doesn't.
   */
  updateZone(zoneId: ZoneId, patch: ZonePatch, expectedRevision: number): { zone: Zone; direction: DirectionView } {
    const init = this.ready();
    const before = zones.resolveZone(zoneId);
    const zone = zones.updateZone(zoneId, patch, expectedRevision);
    this.zonesChanged();
    const after = zones.resolveZone(zoneId);
    const live = this.live?.zone.id === zoneId ? this.live : null;
    if (after.goal !== before.goal) {
      init.directions.begin(after, this.zoneRefs(init, after).used);
      const ready = init.delegations.current(zoneId);
      if (ready?.head.state === "ready") init.delegations.dismiss(ready.handoff.id, ready.head.revision);
    }
    if (live && (after.goal !== before.goal || after.language !== before.language)) this.reconfigure(init, live);
    this.changed();
    return { zone, direction: this.directionView(init, after) };
  }

  zoneContext(zoneId: ZoneId, text: string, expectedRevision: number): ZoneContext {
    const init = this.ready();
    const resolved = zones.writeZoneContext(zoneId, text, expectedRevision);
    this.zonesChanged();
    // The notes of the active zone or one of its ancestors are part of its context.
    const live = this.live;
    if (live && live.zone.breadcrumb.some((b) => b.id === zoneId)) this.reconfigure(init, live);
    return resolved;
  }

  async deleteZone(zoneId: ZoneId, expectedRevision: number): Promise<{ activeZoneId: ZoneId | null; deletedIds: ZoneId[] }> {
    const init = this.ready();
    const deleted = zones.deleteZone(zoneId, expectedRevision);
    if (this.live && deleted.deletedIds.includes(this.live.zone.id)) {
      const ended = await this.shutdown();
      this.endSession(init, ended, "delete");
      this.zonesChanged();
      if (deleted.activeZoneId) this.start(init, deleted.activeZoneId);
    } else this.zonesChanged();
    this.changed();
    return deleted;
  }

  // -- goal alignment ---------------------------------------------------------

  /** Any zone's alignment, checked against its committed goal. A read: it starts nothing. */
  async alignmentRead(zoneId: string): Promise<DirectionView> {
    const init = this.ready();
    return this.directionView(init, zones.resolveZone(zoneId));
  }

  async directionRead(zoneId: string, directionId: string): Promise<Direction> {
    const init = this.ready();
    return init.directions.revision(zoneId, directionId);
  }

  /**
   * One step of a zone's goal alignment. Start and Revise reflect, ask at most two consequential
   * questions and offer options; an answer refines them once every question is answered; Defer
   * leaves alignment needed. Bound to that zone's goal, revisions and attempt: no active-zone
   * grants, and a result that comes back for a moved-on attempt is dropped.
   */
  async alignmentStep(input: AlignmentStepInput): Promise<DirectionView> {
    const prepared = await this.serial(async () => {
      const init = this.ready();
      const zone = zones.resolveZone(input.binding.zoneId);
      const view = this.directionView(init, zone);
      this.checkAlignment(input.binding, view);
      if (input.action === "defer") {
        const head = view.attempt ? { revision: view.binding.directionRevision, attempt: view.attempt } : init.directions.begin(zone, this.zoneRefs(init, zone).used);
        init.directions.draft(zone.id, head.revision, { ...head.attempt!, phase: "deferred" });
        return { done: this.directionView(init, zone), call: null };
      }
      let attempt: AlignmentAttempt;
      let revision: number;
      let answers: { question: string; answer: string }[] = [];
      if (input.action === "answer") {
        const pending = view.attempt;
        if (!pending || pending.phase !== "clarify") throw new Error("there's no question waiting in this alignment - start it again");
        if (!pending.questions.some((q) => q.id === input.questionId)) throw new Error("that question isn't part of this alignment any more");
        attempt = { ...pending, questions: pending.questions.map((q) => (q.id === input.questionId ? { ...q, answer: input.text.trim() } : q)) };
        revision = init.directions.draft(zone.id, view.binding.directionRevision, attempt).revision;
        if (attempt.questions.some((q) => q.answer === null)) return { done: this.directionView(init, zone), call: null };
        answers = attempt.questions.map((q) => ({ question: q.text, answer: q.answer! }));
      } else {
        const head = init.directions.begin(zone, this.zoneRefs(init, zone).used);
        attempt = head.attempt!;
        revision = head.revision;
      }
      if (!this.powered(init)) {
        init.directions.draft(zone.id, revision, { ...attempt, phase: "needs-backend" });
        return { done: this.directionView(init, zone), call: null };
      }
      const decisionInput: DecisionInput = {
        moment: "alignment", goal: zone.goal, outcome: null, language: zone.language, direction: view.current, answers,
        context: attempt.context, candidates: mapping.candidates(zone, skills.read(), zone.goal),
      };
      return { done: null, call: { init, zone, attempt, revision, decisionInput } };
    });
    // Every branch above wrote this zone's alignment (begin, draft, defer, needs-backend): publish it now.
    this.changed();
    if (!prepared.call) return prepared.done!;
    const { init, zone, attempt, revision, decisionInput } = prepared.call;
    const abort = new AbortController();
    this.aligning.add(abort);
    const live = this.live?.zone.id === zone.id ? this.live : null;
    let result: DecisionResult;
    try {
      result = await this.decide(init, decisionInput, AbortSignal.any([abort.signal, ...(live ? [live.stop.signal] : [])]));
    } finally {
      this.aligning.delete(abort);
    }
    if (result.moment !== "alignment") throw new Error("decision help answered the wrong question - nothing kept");
    return this.serial(async () => {
      // Dropped if the goal, the attempt or the zone moved on while the helper worked.
      const now = zones.resolveZone(zone.id);
      if (goalHash(now.goal) !== attempt.goalHash) throw new Error("the goal changed while Dum was thinking - nothing kept");
      const answered = attempt.questions.filter((q) => q.answer !== null);
      const questions = answered.length ? answered : result.questions.map((q) => ({ ...q, answer: null }));
      init.directions.draft(zone.id, revision, {
        ...attempt,
        phase: questions.some((q) => q.answer === null) ? "clarify" : "choose",
        reflection: result.reflection,
        questions,
        options: result.options,
      });
      this.changed();
      return this.directionView(init, now);
    });
  }

  /**
   * Use this direction, or Use my own direction: a new immutable revision for that zone. Intent
   * only - it writes no source file and proves no skill. Accepted for the active zone, it's a
   * reconfiguration: a direction marker closes the session and a new one starts under it.
   */
  async alignmentAccept(input: AlignmentAcceptInput): Promise<DirectionView> {
    const init = this.ready();
    const zone = zones.resolveZone(input.binding.zoneId);
    const view = this.directionView(init, zone);
    this.checkAlignment(input.binding, view);
    const attempt = view.attempt;
    if (!attempt || (attempt.phase !== "choose" && attempt.phase !== "clarify")) throw new Error("there are no options to choose from yet - start alignment first");
    if (attempt.contextRevision !== this.contextRevisionOf(init, zone)) throw new Error("Context changed - review the options again before choosing");
    let choice: DirectionOption;
    if (input.choiceId !== null) {
      const offered = attempt.options.find((o) => o.id === input.choiceId);
      if (!offered) throw new Error("that option isn't part of this alignment any more");
      choice = offered;
    } else {
      const own = input.ownDirection!;
      const known = new Set(attempt.context.map((r) => r.id));
      if (own.contextIds.some((id) => !known.has(id))) throw new Error("your direction cites context this alignment wasn't given - nothing accepted");
      choice = { ...own, builds: own.builds.map((s) => this.catalogRef(s)) };
    }
    const previous = view.current?.id ?? null;
    const direction = init.directions.accept(zone, view.binding.directionRevision, {
      contextRevision: attempt.contextRevision, ability: input.ability.trim(), choice, reviewCriterion: input.reviewCriterion.trim(),
      assumptions: input.assumptions.map((a) => a.trim()), context: attempt.context,
    });
    const live = this.live?.zone.id === zone.id ? this.live : null;
    if (live) {
      this.activity(init, live);
      if (live.session) {
        this.trailWrite(live, () => init.trails.decision(live.session!.id, { kind: "direction", directionId: direction.id, previousId: previous }, decisionKey({ kind: "direction", directionId: direction.id, previousId: previous })));
      }
      live.decision = null;
      this.reconfigure(init, live);
    }
    this.changed();
    return this.directionView(init, zone);
  }

  // -- decisions and handoffs -------------------------------------------------

  /**
   * Help me decide: Dum's reading of the outcome and the Wizard's two or three options, with
   * host-computed eligibility against the live gate. The card lives in host memory only; a new
   * card, dismissal or Stop replaces it. Nothing here writes a file or grants anything.
   */
  async decisionHelp(binding: RequestBinding, outcome: string): Promise<DecisionView> {
    const init = this.ready();
    const live = this.bound(binding);
    if (live.running || live.store.getSnapshot().prompt?.type !== "next") throw new Error("finish what dum is doing first, or Stop it");
    return this.compose(init, live, outcome.trim(), null);
  }

  /**
   * One card from the Wizard, for Help me decide and for a summons Dum queued. With `said` (what
   * they typed the turn Dum asked), an open card for the same outcome that was waiting on them is
   * recomposed with those words as its answer; otherwise the card is fresh.
   */
  private async compose(init: Init, live: Live, outcome: string, said: readonly string[] | null): Promise<DecisionView> {
    const prepared = await this.serial(async () => {
      if (this.live !== live) throw new Error("that zone closed - no decision card was made");
      if (!this.powered(init)) throw new Error("decision help is unavailable: choose who powers Dum in Settings first. Chat still works");
      live.deciding?.abort();
      const abort = new AbortController();
      live.deciding = abort;
      const open = live.decision;
      // An open card still asking them something (a question, or an option missing a detail) is answered, not replaced.
      const asking = open && (open.view.questions.length > 0 || open.view.options.some((o) => o.eligibility === "needs-detail"));
      const previous = said && open && asking && open.view.outcome === outcome ? open : null;
      if (!previous) live.decision = null;
      const answer = said ? said.join("\n").slice(0, L.textBytes) : "";
      const answers = previous ? previous.view.questions.map((q) => ({ question: q.text, answer })) : [];
      const input = this.decisionInput(init, live, outcome, previous && !answers.length ? [{ question: "What's missing?", answer }] : answers);
      this.activity(init, live);
      this.changed();
      return { input, abort, previous, contextRevision: this.contextRevisionOf(init, live.zone) };
    });
    const { input, abort, previous, contextRevision: asked } = prepared;
    let result: DecisionResult;
    try {
      result = await live.store.helper((signal) => this.decide(init, input, AbortSignal.any([signal, abort.signal, live.stop.signal])));
    } catch (err) {
      throw new Error(err instanceof Cancelled ? "stopped - no decision card was made" : `decision help is unavailable: ${(err as Error).message}`);
    } finally {
      if (live.deciding === abort) live.deciding = null;
    }
    return this.serial(async () => {
      if (this.live !== live || abort.signal.aborted) throw new Error("that decision moved on before the card was ready - ask again");
      if (this.contextRevisionOf(init, live.zone) !== asked) throw new Error("Context changed while Dum was thinking - ask again");
      const view = this.card(init, live, input, result, previous && live.decision === previous ? previous : null);
      this.changed();
      return view;
    });
  }

  /** Dismiss: the card goes and isn't shown again until they ask again or change the outcome. A summons Dum queued goes with it. */
  async decisionDismiss(binding: RequestBinding, decisionId: string, revision: number): Promise<void> {
    const live = this.bound(binding, false);
    const decision = live.decision;
    if (!decision || decision.view.id !== decisionId || decision.view.revision !== revision) throw new Error("that card is already gone");
    live.deciding?.abort();
    live.decision = null;
    if (live.summon) live.summon.queued = null;
    this.changed();
  }

  /**
   * Choose an option: one editable ready handoff, bound to this session, goal, direction and
   * context. Only an option the live gate lets Dum do now; selection writes no file.
   */
  async selectHandoff(input: HandoffSelectInput): Promise<HandoffView> {
    const init = this.ready();
    const live = this.bound(input.binding, false);
    const decision = live.decision;
    if (!decision || decision.view.id !== input.decisionId || decision.view.revision !== input.revision) throw new Error("that card changed or went - ask for help deciding again");
    const ctxRev = this.contextRevisionOf(init, live.zone);
    if (decision.view.contextRevision !== ctxRev) throw new Error("Context changed since this card was made - ask for help deciding again");
    if (decision.view.directionId !== this.currentDirectionId(init, live.zone)) throw new Error("the agreed direction changed since this card was made - ask again");
    const option = decision.view.options.find((o) => o.id === input.optionId);
    if (!option) throw new Error("that option isn't on this card");
    if (option.eligibility === "needs-detail") throw new Error(`answer what's missing first, in the chat: ${option.blockers.join("; ")}`);
    const now = this.eligibility(init, option, null);
    if (now.eligibility !== "can-delegate") throw new Error(`that one can't be handed off now: ${now.blockers.join("; ")}`);
    const session = this.ensureSession(init, live);
    const cited = new Set(option.contextIds);
    const handoff = init.delegations.ready({
      zoneId: live.zone.id, sessionId: session.id, directionId: decision.view.directionId, goalHash: goalHash(live.zone.goal),
      contextRevision: ctxRev, outcome: decision.view.outcome, task: option.task, expectedResult: option.expectedResult, review: option.review,
      skills: option.skills, targets: [], context: decision.view.context.filter((r) => cited.has(r.id)),
    });
    live.stale.delete(handoff.id);
    this.changed();
    return this.handoffView(init, live, init.delegations.read(live.zone.id, handoff.id));
  }

  /**
   * Edit the task, expected result or what they'll review: a new version, no file written. A
   * handoff that needs a refresh (restart, reload, new session or context) is refreshed by the
   * edit: rebound to the current session, context and direction, for the same goal only.
   */
  async editHandoff(input: HandoffEditInput): Promise<HandoffView> {
    const init = this.ready();
    const live = this.bound(input.binding, false);
    const view = this.handoffView(init, live, init.delegations.read(live.zone.id, input.handoffId));
    if (view.head.revision !== input.revision) throw new Error("that handoff changed since you saw it - review it again");
    if (!view.needsRefresh) {
      init.delegations.edit(input.handoffId, input.revision, input.patch);
      this.changed();
      return this.handoffView(init, live, init.delegations.read(live.zone.id, input.handoffId));
    }
    if (view.head.state !== "ready") throw new Error(`that handoff is ${view.head.state} - only a ready handoff can be edited`);
    if (view.handoff.goalHash !== goalHash(live.zone.goal)) throw new Error("the goal changed since this handoff was made - ask for help deciding again");
    const { version: _v, id: _id, revision: _r, ...kept } = view.handoff;
    const fresh = init.delegations.ready({
      ...kept, ...input.patch, sessionId: this.ensureSession(init, live).id, contextRevision: this.contextRevisionOf(init, live.zone),
      directionId: this.currentDirectionId(init, live.zone),
    });
    live.stale.delete(fresh.id);
    this.changed();
    return this.handoffView(init, live, init.delegations.read(live.zone.id, fresh.id));
  }

  async dismissHandoff(input: HandoffDismissInput): Promise<void> {
    const init = this.ready();
    const live = this.bound(input.binding, false);
    const view = init.delegations.read(live.zone.id, input.handoffId);
    init.delegations.dismiss(view.handoff.id, input.revision);
    this.changed();
  }

  /**
   * Do this: the explicit command. Main already consumed the draft and supplies this request's
   * shares as Send does. The host rechecks goal, direction, context, session and version, then the
   * live gate for every skill; the version is consumed before anything runs, so a repeat can't
   * write twice. The intern then writes through the usual direct `change` path, where the gate and
   * the file hashes are checked again at each write. Resolves once the run has started; how it
   * ended is recorded from orchestration and the change receipts, never the model's word.
   */
  async runHandoff(input: HandoffRunInput): Promise<void> {
    const init = this.ready();
    const live = this.bound(input.binding);
    const view = this.handoffView(init, live, init.delegations.read(live.zone.id, input.handoffId));
    if (view.handoff.revision !== input.revision || view.head.revision !== input.revision) throw new Error("that handoff changed since you saw it - Refresh handoff");
    if (view.head.state !== "ready") throw new Error(`that handoff is ${view.head.state} - Do this runs a ready handoff once`);
    if (view.needsRefresh) throw new Error("Refresh handoff: its session, context or direction moved on since it was made - nothing ran");
    if (view.blockers.length) throw new Error(`${view.blockers.join("; ")} - nothing ran`);
    const h = view.handoff;
    const text = [
      "HANDOFF (they chose this and commanded it with Do this)",
      `Task: ${h.task}`,
      `Expected result: ${h.expectedResult}`,
      `What they'll review: ${h.review}`,
      `Skills it rests on: ${h.skills.map((s) => skills.label(s)).join(", ") || "none named"}`,
      `Their outcome: ${h.outcome}`,
    ].join("\n");
    await this.send(input.binding, text, input.shares, input.image, h);
  }

  async readHandoff(zoneId: string, handoffId: string): Promise<HandoffView> {
    const init = this.ready();
    const view = init.delegations.read(zoneId, handoffId);
    const live = this.live?.zone.id === zoneId ? this.live : null;
    return live ? this.handoffView(init, live, view) : view;
  }

  /** Their verdict on a finished handoff in this zone, against its expected result. Never competency evidence. */
  async reviewHandoff(input: HandoffReviewInput): Promise<HandoffView> {
    const init = this.ready();
    const live = this.bound(input.binding, false);
    const before = init.delegations.read(live.zone.id, input.handoffId);
    init.delegations.review(input.handoffId, input.revision, input.verdict.trim());
    this.activity(init, live);
    const h = before.handoff;
    const event: DecisionEventInput = { kind: "handoff", handoffId: h.id, revision: h.revision, phase: "reviewed", directionId: h.directionId, sourceIds: [] };
    this.trailWrite(live, () => init.trails.decision(h.sessionId, event, decisionKey(event)));
    this.changed();
    return this.handoffView(init, live, init.delegations.read(live.zone.id, input.handoffId));
  }

  // -- current context --------------------------------------------------------

  /** One page of what the latest decision or request used. */
  async contextUseRead(binding: RequestBinding, cursor: string | null): Promise<ContextUsePage> {
    const live = this.bound(binding, false);
    const use = live.use;
    if (!use) return { items: [], next: null };
    let offset = 0;
    if (cursor !== null) {
      const at = /^(\d+)_/.exec(cursor);
      if (!at || cursor !== useCursor(use.subject.id, Number(at[1]))) throw new Error("that page is from an older context inventory - open Using again");
      offset = Number(at[1]);
    }
    const items: ContextUseItem[] = [];
    let bytes = 64;
    for (const item of use.items.slice(offset, offset + L.inventoryRefs)) {
      const size = encoder.encode(JSON.stringify(item)).length + 1;
      if (bytes + size > L.inventoryBytes) break;
      items.push(item);
      bytes += size;
    }
    const end = offset + items.length;
    return { items, next: end < use.items.length ? useCursor(use.subject.id, end) : null };
  }

  /**
   * Reload context: main re-read their opted-in personal file; memory and zone notes are read
   * fresh by their owners on the next decision. Open cards go and a ready handoff needs a refresh.
   */
  async contextReload(binding: RequestBinding, personal: context.Context): Promise<void> {
    const init = this.ready();
    const live = this.bound(binding, false);
    const changed = init.settings.personalContext && (personal.text !== init.personal.text || personal.path !== init.personal.path);
    init.personal = personal;
    live.zone = zones.resolveZone(live.zone.id);
    this.invalidate(init, live);
    if (changed) this.reconfigure(init, live);
    this.changed();
  }

  /**
   * Ignore this observation: it stops feeding decisions, the trail and the next look until a fresh
   * one replaces it. Only the current observation; nothing already sent is unsent.
   */
  async contextIgnoreObservation(input: IgnoreObservationInput): Promise<void> {
    const init = this.ready();
    const live = this.bound(input.binding, false);
    const latest = live.session ? init.trails.meta(live.session.id)?.latestObservation ?? null : null;
    if (!latest || latest.sourceId !== input.sourceId) throw new Error("that isn't the latest observation any more");
    init.directions.ignoreObservation(live.zone.id, input.expectedCorrectionRevision, input.sourceId);
    live.ambient.forget();
    this.invalidate(init, live);
    this.reconfigure(init, live);
    this.changed();
  }

  // -- sessions, trail, story -------------------------------------------------

  /**
   * New session: zone work and its capabilities end, the epoch and prompt rotate, the old trail
   * closes and an empty one starts. The agreed direction stays; alignment doesn't rerun.
   */
  async newSession(binding: RequestBinding): Promise<void> {
    const init = this.ready();
    const live = this.bound(binding, false);
    const id = live.zone.id;
    const ended = await this.shutdown();
    this.endSession(init, ended, "new-session");
    this.start(init, id);
    this.changed();
  }

  async trailRead(query: TrailQuery): Promise<TrailPage> {
    return this.ready().trails.read(query.zoneId, query.sessionId, query.cursor);
  }

  async trailSource(zoneId: string, sessionId: string, sourceId: string): Promise<TrailSource> {
    return this.ready().trails.source(zoneId, sessionId, sourceId);
  }

  /** Map an unmapped topic to a skill they picked: a user-mapped visit, no tree or evidence change. */
  async trailMap(input: TrailMapInput): Promise<void> {
    const init = this.ready();
    const live = this.bound(input.binding, false);
    if (live.session?.id !== input.sessionId) throw new Error("that gap belongs to an earlier session - map it from its story");
    init.trails.mapGap(input.sessionId, input.gapId, this.catalogRef(input.skill));
    this.changed();
  }

  async storyRead(query: StoryQuery): Promise<StoryPage> {
    return this.ready().trails.story(query);
  }

  // -- debug chat and diagnostics ---------------------------------------------

  async debugOpen(): Promise<DebugView> {
    return this.ready().debug.open();
  }

  /** One debug question on its own binding; it never touches the zone conversation. */
  async debugSend(binding: DebugBinding, text: string): Promise<void> {
    const init = this.ready();
    const started = Date.now();
    init.diagnostics.record({ kind: "call-start", role: "debug", requestId: binding.requestId, checkId: null, outcome: "started", reason: "none", latencyMs: null, httpStatus: null });
    let outcome: "ok" | "failed" = "ok";
    try {
      await init.debug.send(binding, text);
    } catch (err) {
      outcome = "failed";
      throw err;
    } finally {
      init.diagnostics.record({
        kind: "call-end", role: "debug", requestId: binding.requestId, checkId: null, outcome, reason: outcome === "ok" ? "none" : "call-failed",
        latencyMs: Math.min(Date.now() - started, 24 * 60 * 60_000), httpStatus: null,
      });
    }
  }

  async debugStop(binding: DebugBinding): Promise<void> {
    await this.ready().debug.stop(binding);
  }

  async debugReset(): Promise<DebugView> {
    return this.ready().debug.reset();
  }

  diagnosticMain(events: readonly SanitizedMainEvent[], status: MainStatus | null): void {
    this.ready().diagnostics.main(events, status);
  }

  // -- the conversation -----------------------------------------------------

  /**
   * Their message for the prompt the binding names. At "what next" it starts a request: its shares
   * come from the host's own grants by ID (wire copies are not authority), a picture is looked at
   * once first, and a typed command runs as that request. At a question it answers inside the
   * running request. With `handoff`, the request carries out that commanded handoff.
   */
  async send(binding: RequestBinding, text: string, shares: ShareGrant[], image?: SharedImage, handoff: Handoff | null = null): Promise<void> {
    const init = this.ready();
    const live = this.bound(binding);
    const line = text.trim();
    if (!line) throw new Error("type something first");
    const { store } = live;
    const prompt = store.getSnapshot().prompt;
    if (!prompt || !store.inputReady) throw new Error("that prompt closed before your message arrived - nothing was sent");
    if (prompt.type !== "next") {
      if (handoff) throw new Error("answer Dum's question first, or Stop it - nothing ran");
      const running = this.runningFor(live, binding);
      if (image) throw new Error("a picture only goes with a request when dum asks what's next - nothing was sent");
      const granted = new Set(running.files.grants().map((g) => g.id));
      if (shares.some((s) => !granted.has(s.id))) throw new Error("share that with your next request - this one is already running");
      store.submit(text);
      return;
    }
    if (live.running) throw new Error("wait for dum to finish, or Stop it - nothing was sent");
    const cmd = handoff ? null : parseCommand(line);
    if (!cmd || Object.hasOwn(MODEL_COMMANDS, cmd.name)) {
      if (init.agentError) throw new Error(init.agentError);
      init.registry.chosen();
    }
    if (cmd && image) throw new Error("a picture goes with a request, not a command - nothing was sent");
    const files = this.claim(live, binding, shares);
    this.activity(init, live);
    if (cmd) {
      this.startCommand(init, live, { files, binding, handoff: null }, cmd.name, cmd.arg);
      return;
    }
    const ctx = prepare(live.zone, init.settings.mode, store, this.personal(init), init.evidence, files, init.registry, binding, this.hooks(init, live, binding));
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
    if (handoff) {
      // Consumed once, before anything runs: a repeated Do this for this version is refused.
      try {
        init.delegations.start(handoff.id, handoff.revision, binding.requestId);
      } catch (err) {
        if (this.live === live && !live.pending) live.pending = files;
        throw err;
      }
      const event: DecisionEventInput = { kind: "handoff", handoffId: handoff.id, revision: handoff.revision, phase: "commanded", directionId: handoff.directionId, sourceIds: [] };
      this.trailWrite(live, () => init.trails.decision(handoff.sessionId, event, decisionKey(event)));
    }
    this.use(init, live, { kind: "request", id: binding.requestId }, this.requestRefs(init, live));
    files.activate();
    live.next = { files, binding, ctx, handoff };
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
    if (Object.hasOwn(MODEL_COMMANDS, name)) {
      if (init.agentError) throw new Error(init.agentError);
      init.registry.chosen();
    }
    this.activity(init, live);
    this.startCommand(init, live, { files: this.claim(live, binding, []), binding, handoff: null }, name, argument);
  }

  /** Show an in-window view. The tree works before any zone or backend: it's theirs, not a zone's. */
  view(name: ViewName): void {
    const init = this.ready();
    switch (name) {
      case "tree":
        this.treeView = treeView(skills.read());
        this.changed();
        return;
      case "zones":
      case "settings":
      case "story":
        return;
      case "changes": {
        const live = this.need();
        this.refreshChanges(init, live);
        this.changed();
        return;
      }
      case "projects": {
        const live = this.need();
        const files = new SharedFiles(this.hostBinding(live), live.follows);
        try {
          live.store.show("suggested projects", new Practice(live.zone, live.store, files, init.evidence, this.personal(init), init.registry).describe());
        } finally {
          files.revoke();
        }
        return;
      }
      default:
        void this.need().store.command(name === "history" ? "log" : name);
    }
  }

  /**
   * Stop what dum is doing. Every prompt it was waiting on is withdrawn unanswered and helper work
   * in flight, decision help and alignment included, is aborted with nothing kept. The conversation
   * goes on from "what next".
   */
  interrupt(): void {
    for (const abort of this.aligning) abort.abort();
    const live = this.live;
    if (!live) return;
    live.deciding?.abort();
    const store = live.store;
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

  /** The named personal file behind a Using ref; main opens it only if it's in its own inventory. */
  openPersonal(sourceId: string): string {
    const init = this.ready();
    const personal = this.personal(init);
    if (!personal.path || this.personalRef(personal)?.id !== sourceId) throw new Error("that isn't personal context Dum is using now");
    return personal.path;
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

  /** End the open conversation and its session, and let H go. Stop first, so nothing slow holds the queue. */
  close(): Promise<void> {
    this.interrupt();
    return this.serial(async () => {
      if (this.closed) return;
      this.closed = true;
      const init = this.init;
      if (this.live) {
        const ended = await this.shutdown();
        if (init) this.endSession(init, ended, "quit");
      }
      await init?.debug.close();
      this.credentials.fail("Dum is closing");
      this.frames.fail("Dum is closing");
      init?.release();
    });
  }

  // -- internals: serialization and bindings ----------------------------------

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
    if (!this.init) throw new Error("the host isn't set up yet");
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

  /** A binding the host issues itself, for work no request of theirs started: a look, a view. */
  private hostBinding(live: Live): RequestBinding {
    return { zoneId: live.zone.id, zoneEpoch: live.epoch, inputToken: this.tokenOf(live), requestId: randomUUID() };
  }

  /** The alignment step was made for this zone's goal, revision and attempt; anything older is refused. */
  private checkAlignment(binding: AlignmentBinding, view: DirectionView): void {
    if (binding.goalHash !== view.goalHash) throw new Error("that zone's goal changed since this was shown - nothing happened");
    if (binding.directionRevision !== view.binding.directionRevision || binding.attemptId !== view.binding.attemptId) {
      throw new Error("this alignment moved on since it was shown - refresh it and try again");
    }
  }

  // -- internals: context, decisions, eligibility -----------------------------

  private powered(init: Init): boolean {
    if (init.agentError) return false;
    try {
      init.registry.chosen();
      return true;
    } catch {
      return false;
    }
  }

  private personal(init: Init): context.Context {
    return init.settings.personalContext ? init.personal : NO_PERSONAL;
  }

  private personalRef(personal: context.Context): ContextRef | null {
    if (!personal.path) return null;
    return contextRef("personal", `personal:${personal.path}`, "Your personal background", personal.text || personal.warning || "(empty)", null);
  }

  /**
   * The zone's own context as refs: its goal, inherited goals, labeled notes and opted-in personal
   * background. These, with the correction revision, are its context revision; memory, the look and
   * conversation are newer context and never cancel a card by themselves.
   */
  private zoneRefs(init: Init, zone: ZoneContext): { used: ContextRef[]; omitted: ContextRef[] } {
    const names = new Map(zone.breadcrumb.map((b) => [b.id, b.name]));
    const refs: ContextRef[] = [contextRef("goal", `${zone.id}:goal`, `Goal of ${names.get(zone.id) ?? "this zone"}`, zone.goal, null)];
    for (const a of zone.ancestorGoals) refs.push(contextRef("goal", `${a.id}:goal`, `Inherited goal of ${names.get(a.id) ?? "a parent zone"}`, a.goal, null));
    for (const n of zone.notes) if (n.text.trim()) refs.push(contextRef("zone-note", `${n.id}:notes`, `Notes of ${n.name}`, n.text, null));
    const personal = this.personalRef(this.personal(init));
    if (personal) refs.push(personal);
    return { used: refs.slice(0, L.contextRefs), omitted: refs.slice(L.contextRefs) };
  }

  /** The zone's context revision: its own refs and its correction revision, digested as Directions does. */
  private contextRevisionOf(init: Init, zone: ZoneContext): string {
    return contextRevision(goalHash(zone.goal), init.directions.corrections(zone.id).revision, this.zoneRefs(init, zone).used);
  }

  private directionView(init: Init, zone: ZoneContext): DirectionView {
    return init.directions.read(zone, this.contextRevisionOf(init, zone));
  }

  private currentDirectionId(init: Init, zone: ZoneContext): string | null {
    return this.directionView(init, zone).current?.id ?? null;
  }

  /** The latest observation, unless they ignored it. */
  private observation(init: Init, live: Live): { sourceId: string; text: string; at: string } | null {
    const latest = live.session ? init.trails.meta(live.session.id)?.latestObservation ?? null : null;
    if (!latest) return null;
    return init.directions.corrections(live.zone.id).ignoredObservationSourceId === latest.sourceId ? null : latest;
  }

  /** Everything a request or decision in the active zone may use, in priority order; past 16 is omitted. */
  private requestRefs(init: Init, live: Live): { used: ContextRef[]; omitted: ContextRef[] } {
    const own = this.zoneRefs(init, live.zone);
    const refs = [...own.used];
    const current = this.directionView(init, live.zone).current;
    if (current) refs.push(contextRef("direction", `${current.id}`, "Agreed direction", `${current.ability} - ${current.choice.title}. Review: ${current.reviewCriterion}`, current.at));
    const seen = this.observation(init, live);
    if (seen) refs.push(contextRef("look", seen.sourceId, "Latest observation", seen.text, seen.at));
    let notes = "";
    try { notes = memory.notes(init.home, live.zone.id); } catch { /* the memory view reports an unreadable notes file */ }
    if (notes) refs.push(contextRef("memory", `${live.zone.id}:memory`, "Zone memory", notes.slice(-4096), null));
    const said = live.store.getSnapshot().transcript.filter((e) => e.kind === "user" || e.kind === "say").slice(-CONVERSATION_ENTRIES);
    if (said.length) {
      const text = said.map((e) => (e.kind === "user" ? `you: ${e.text}` : e.kind === "say" ? `dum: ${e.text}` : "")).join("\n");
      refs.push(contextRef("conversation", `${live.zone.id}:conversation:${said.at(-1)!.id}`, "Recent conversation", text.slice(-2048), null));
    }
    return { used: refs.slice(0, L.contextRefs), omitted: [...refs.slice(L.contextRefs), ...own.omitted] };
  }

  /** Record what a decision or request used, for Using / Inspect. */
  private use(init: Init, live: Live, subject: Use["subject"], refs: { used: ContextRef[]; omitted: ContextRef[] }): void {
    const failed = live.look.status === "failed";
    live.use = {
      subject,
      contextRevision: this.contextRevisionOf(init, live.zone),
      items: [
        ...refs.used.map((ref): ContextUseItem => ({ ref, status: ref.kind === "look" && failed ? "stale" : ref.kind === "personal" && !this.personal(init).text ? "missing" : "used" })),
        ...refs.omitted.map((ref): ContextUseItem => ({ ref, status: "omitted" })),
      ],
    };
  }

  private decisionInput(init: Init, live: Live, outcome: string, answers: { question: string; answer: string }[]): DecisionInput {
    const refs = this.requestRefs(init, live);
    const current = this.directionView(init, live.zone).current;
    this.use(init, live, { kind: "decision", id: randomUUID() }, refs);
    return {
      moment: "delegation", goal: live.zone.goal, outcome, language: live.zone.language, direction: current, answers,
      context: refs.used, candidates: mapping.candidates(live.zone, skills.read(), `${live.zone.goal}\n${outcome}`),
    };
  }

  /** One helper call for decision cards, counted in the diagnostics. */
  private async decide(init: Init, input: DecisionInput, signal: AbortSignal): Promise<DecisionResult> {
    const requestId = randomUUID();
    const started = Date.now();
    const record = (outcome: "started" | "ok" | "failed" | "cancelled") => init.diagnostics.record({
      kind: outcome === "started" ? "call-start" : "call-end", role: "helper", requestId, checkId: null, outcome,
      reason: outcome === "failed" ? "call-failed" : "decision", latencyMs: outcome === "started" ? null : Math.min(Date.now() - started, 86_400_000), httpStatus: null,
    });
    record("started");
    const cwd = join(init.home, "decisions", "runtime");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    try {
      const result = await wizard.help(input, { agent: init.registry, cwd, signal });
      record("ok");
      return result;
    } catch (err) {
      record(signal.aborted ? "cancelled" : "failed");
      throw err;
    }
  }

  /**
   * Whether the live gate lets Dum do an option now. Learn first names the smallest missing rung
   * and the existing suggested-projects path; a missing detail is asked, never guessed.
   */
  private eligibility(init: Init, option: { skills: readonly SkillRef[] }, needs: string | null): Pick<DelegationOption, "eligibility" | "blockers"> {
    const tree = skills.read();
    const pieces = gate.classify(tree, option.skills.map((s) => ({ skill: s.name, lang: s.lang, what: "" })), init.settings.mode, init.evidence.held);
    const locked = pieces.filter((p) => !gate.aiWrites(p, init.settings.mode));
    if (locked.length) {
      return {
        eligibility: "learn-first",
        blockers: [
          ...locked.slice(0, L.blockers - (needs ? 1 : 0)).map((p) => {
            const next = gate.nextStep(gate.withoutHeld(tree, init.evidence.held), { skill: p.skill, lang: p.lang });
            return `Learn first: ${skills.label({ name: next || p.skill, lang: p.lang })} - :projects ${next || p.skill} suggests an unaided project; ${skills.label({ name: p.skill, lang: p.lang })} isn't yours at ${p.need} yet`;
          }),
          ...(needs ? [`Needs: ${needs}`] : []),
        ].map((b) => clipBytes(b, 512)),
      };
    }
    if (needs) return { eligibility: "needs-detail", blockers: [clipBytes(`Needs: ${needs}`, 512)] };
    if (!option.skills.length) return { eligibility: "needs-detail", blockers: ["Needs: the skills this rests on, so Dum can check them before writing"] };
    return { eligibility: "can-delegate", blockers: [] };
  }

  /** The card for a helper result: eligibility from the live gate, one latest card per outcome. */
  private card(init: Init, live: Live, input: DecisionInput, result: DecisionResult, previous: Decision | null): DecisionView {
    if (result.moment !== "delegation") throw new Error("decision help answered the wrong question - nothing kept");
    const options = result.options.map((p: DelegationProposal): DelegationOption => {
      const { needs, ...rest } = p;
      return { ...rest, ...this.eligibility(init, p, needs) };
    });
    const view: DecisionView = {
      id: previous?.view.id ?? randomUUID(),
      revision: (previous?.view.revision ?? 0) + 1,
      outcome: input.outcome!,
      contextRevision: this.contextRevisionOf(init, live.zone),
      directionId: input.direction?.id ?? null,
      reflection: result.reflection,
      questions: result.questions,
      options,
      context: input.context,
    };
    live.decision = { view, input };
    return view;
  }

  /** Overlay what only the host knows: whether a ready handoff still fits this session and context, and the live gate. */
  private handoffView(init: Init, live: Live, view: HandoffView): HandoffView {
    if (view.handoff.zoneId !== live.zone.id || view.head.state !== "ready") return view;
    const h = view.handoff;
    const moved = view.needsRefresh || live.stale.has(h.id) || h.sessionId !== live.session?.id || h.goalHash !== goalHash(live.zone.goal)
      || h.contextRevision !== this.contextRevisionOf(init, live.zone) || h.directionId !== this.currentDirectionId(init, live.zone);
    const gateNow = this.eligibility(init, h, null);
    return { ...view, needsRefresh: moved, blockers: gateNow.eligibility === "can-delegate" ? [] : gateNow.blockers };
  }

  /** Reload or correction: open cards go, and a ready handoff needs a refresh before Do this. */
  private invalidate(init: Init, live: Live): void {
    live.deciding?.abort();
    live.decision = null;
    const current = init.delegations.current(live.zone.id);
    if (current?.head.state === "ready") live.stale.add(current.handoff.id);
  }

  /** A skill ref in the catalog's spelling; a user's own pick stays as named off the tracks. */
  private catalogRef(skill: SkillRef): SkillRef {
    const lang = curriculum.locate(skill.name, skill.lang).lang;
    return { name: curriculum.canonical(skill.name, lang), lang };
  }

  // -- internals: sessions and the trail --------------------------------------

  /** Close what a crash left open: sessions become interrupted, running handoffs too, with the receipts they left. */
  private recover(init: Init): void {
    init.trails.recover();
    for (const zone of this.zoneList.zones) {
      if (zone.deletedAt !== null) continue;
      try {
        for (const { id } of init.delegations.recover(zone.id)) {
          const view = init.delegations.read(zone.id, id);
          const changeIds = view.head.requestId ? listChanges(init.home, zone.id).filter((m) => m.requestId === view.head.requestId).map((m) => m.id) : [];
          if (view.head.requestId) {
            init.delegations.finish(id, view.head.requestId, { state: "interrupted", changeIds: changeIds.slice(0, L.changeIds), result: `Dum stopped before this finished${changeIds.length ? `; ${changeIds.length} change${changeIds.length === 1 ? "" : "s"} had landed` : ""}` });
          }
          const h = view.handoff;
          const event: DecisionEventInput = { kind: "handoff", handoffId: h.id, revision: h.revision, phase: "interrupted", directionId: h.directionId, sourceIds: [] };
          init.trails.decision(h.sessionId, event, decisionKey(event));
        }
      } catch { /* a damaged record stays as it is; the zone still opens */ }
    }
  }

  private ensureSession(init: Init, live: Live): SessionMeta {
    if (!live.session) {
      live.session = init.trails.begin(live.zone, this.currentDirectionId(init, live.zone));
      live.lastActivity = Date.now();
    }
    return live.session;
  }

  /**
   * Eligible activity: Send, a command, decision and handoff work, accepted evidence or changes, a
   * changed look. After 30 quiet minutes the old session ends as idle and this starts a new one.
   */
  private activity(init: Init, live: Live): void {
    const now = Date.now();
    if (live.session && now - live.lastActivity >= IDLE_MS) this.endSession(init, live.session.id, "idle", live);
    this.trailWrite(live, () => {
      const session = this.ensureSession(init, live);
      init.trails.activity(session.id, now);
    });
    live.lastActivity = now;
  }

  private endSession(init: Init, id: string | null, reason: EndReason, live?: Live): void {
    if (!id) return;
    try {
      init.trails.end(id, reason);
    } catch (err) {
      live?.store.note(`couldn't close this session's trail: ${(err as Error).message}`);
    }
    if (live?.session?.id === id) live.session = null;
  }

  /** A change to the active zone's context: the session ends and a new one starts under it. */
  private reconfigure(init: Init, live: Live): void {
    this.endSession(init, live.session?.id ?? null, "reconfigure", live);
    this.trailWrite(live, () => this.ensureSession(init, live));
  }

  /** Trail writes that fail are a visible recording failure, never a silent reset. */
  private trailWrite(live: Live, write: () => void): void {
    try {
      write();
    } catch (err) {
      live.store.note(`couldn't record this on your session trail: ${(err as Error).message}`);
    }
  }

  private observeTrail(init: Init, live: Live, hints: readonly TopicHint[], source: TrailSourceInput): void {
    this.trailWrite(live, () => {
      const session = this.ensureSession(init, live);
      if (!hints.length) {
        init.trails.observe(session.id, [], source);
        return;
      }
      for (let i = 0; i < hints.length; i += TRAIL_LIMITS.hints) init.trails.observe(session.id, hints.slice(i, i + TRAIL_LIMITS.hints), source);
    });
    this.changed();
  }

  /** How a request reports to the trail: validated refs only, nothing that writes source or grants a skill. */
  private hooks(init: Init, live: Live, binding: RequestBinding): SessionHooks {
    const mine = () => this.live === live;
    const empty = { entryId: null, requestId: binding.requestId, evidenceId: null, changeId: null, handoffId: null, proof: null };
    const open = live.decision;
    const waiting = open && (open.view.questions.length > 0 || open.view.options.some((o) => o.eligibility === "needs-detail")) ? open.view.outcome : null;
    return {
      report: (topics) => {
        if (!mine()) return "That conversation is over - nothing noted.";
        const said = live.store.getSnapshot().transcript.filter((e) => e.kind === "user").slice(-2).map((e) => (e.kind === "user" ? e.text : "")).join("\n");
        const hints = mapping.mapHints(topics, mapping.candidates(live.zone, skills.read(), said));
        if (!hints.length) return "Nothing usable to note - topics need a topic and a confidence.";
        this.activity(init, live);
        this.observeTrail(init, live, hints, { ...empty, kind: "conversation", excerpt: clipBytes(hints.map((h) => h.topic).join(", "), TRAIL_LIMITS.excerptBytes) });
        const mapped = hints.filter((h) => h.skill).length;
        return `Noted on their session trail: ${mapped} skill${mapped === 1 ? "" : "s"}, ${hints.length - mapped} unmapped topic${hints.length - mapped === 1 ? "" : "s"}. It proves nothing.`;
      },
      changed: (receipt, named) => {
        if (!mine()) return;
        this.activity(init, live);
        this.observeTrail(init, live, mapping.exactHints(named, `changed ${receipt.target.slice(receipt.target.indexOf("/") + 1)}`.slice(0, TRAIL_LIMITS.topicChars), "a change Dum wrote with these skills"), {
          ...empty, kind: "change", changeId: receipt.id, excerpt: clipBytes(receipt.target, TRAIL_LIMITS.excerptBytes),
        });
      },
      proved: (skill) => {
        if (!mine()) return;
        const proof = this.latestProof(init, live.zone.id, skill);
        if (!proof) return;
        this.activity(init, live);
        const { files: _files, ...kept } = proof;
        this.observeTrail(init, live, mapping.exactHints([skill], skills.label(skill), "evidence the ledger accepted"), {
          ...empty, kind: "evidence", evidenceId: proof.id, proof: kept, excerpt: clipBytes(proof.why, TRAIL_LIMITS.excerptBytes),
        });
      },
      // Every zone has a goal, agreed or still aligning; only a backend decides whether the Wizard can be asked.
      decide: this.powered(init)
        ? {
          waiting,
          ask: (outcome, why, said) => {
            if (!mine()) throw new Error("that conversation is over - the Wizard wasn't asked");
            if (live.summon?.requestId === binding.requestId) throw new Error("the Wizard was already asked this turn - wait for their next message");
            live.summon = { requestId: binding.requestId, queued: { outcome, why, said } };
            live.store.quip(`Dum asked the Wizard: ${why}`);
            return "The Wizard is laying out options in Dum.";
          },
        }
        : null,
    };
  }

  /** The ledger's newest accepted record for this skill in this zone, read from its owner's file. */
  private latestProof(init: Init, zoneId: ZoneId, skill: SkillRef) {
    try {
      const raw = readState(init.home, "evidence.json", 512 * 1024);
      if (raw === null) return null;
      const ledger = LedgerSchema.safeParse(JSON.parse(raw));
      if (!ledger.success) return null;
      const key = skills.id(skill.name, skill.lang);
      return ledger.data.records.findLast((r) => r.ok && r.kind !== "undo" && r.zoneId === zoneId && skills.id(r.skill, r.lang) === key) ?? null;
    } catch {
      return null;
    }
  }

  // -- internals: shares, commands, agent -------------------------------------

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
    prepare(live.zone, init.settings.mode, live.store, this.personal(init), init.evidence, request.files, init.registry, request.binding, this.hooks(init, live, request.binding));
    request.files.activate();
    live.running = request;
    this.changed();
    void live.store.command(name, argument).finally(() => this.finish(init, live, request, null));
  }

  /**
   * A request or command ended, however: its shares lapse and the change list catches up. A
   * commanded handoff records how it ended from orchestration and this request's change receipts.
   * A summons Dum queued this turn goes to the Wizard now, never beside the running session;
   * Stop and close drop it, like a card in flight.
   */
  private finish(init: Init, live: Live, request: Job, ended: { end: RunEnd; refused: readonly string[] } | null): void {
    request.files.revoke();
    if (live.running === request) live.running = null;
    if (request.handoff && ended) this.finishHandoff(init, live, request, ended);
    if (this.live !== live) return;
    this.refreshChanges(init, live);
    this.changed();
    const queued = live.summon?.requestId === request.binding.requestId ? live.summon.queued : null;
    if (!queued) return;
    live.summon!.queued = null;
    if (ended?.end !== "ok" && ended?.end !== "failed") return;
    // No caller waits for this card: a failure is a note in the conversation.
    this.compose(init, live, queued.outcome, queued.said).catch((err: Error) => {
      if (this.live === live) live.store.note(`the Wizard couldn't lay out options: ${err.message}`);
    });
  }

  private finishHandoff(init: Init, live: Live, request: Job, ended: { end: RunEnd; refused: readonly string[] }): void {
    const h = request.handoff!;
    let landed: { id: string; target: string }[] = [];
    try {
      landed = listChanges(init.home, h.zoneId).filter((m) => m.requestId === request.binding.requestId).map((m) => ({ id: m.id, target: m.target }));
    } catch { /* the result says nothing landed that it can name */ }
    const state: HandoffResult["state"] = ended.end === "closed" ? "interrupted" : ended.end === "stopped" ? "cancelled" : ended.end === "failed" ? "failed"
      : landed.length === 0 && ended.refused.length > 0 ? "blocked" : "done";
    const names = landed.map((c) => c.target.slice(c.target.indexOf("/") + 1));
    const result = clipBytes([
      landed.length ? `${landed.length} change${landed.length === 1 ? "" : "s"} applied: ${names.join(", ")}.` : "No file changed.",
      ended.refused.length ? `Refused: ${ended.refused.at(-1)}.` : "",
      state === "done" ? `Not checked by Dum - yours to review against: ${h.expectedResult}` : "",
    ].filter(Boolean).join(" "), L.textBytes);
    try {
      init.delegations.finish(h.id, request.binding.requestId, { state, changeIds: landed.slice(0, L.changeIds).map((c) => c.id), result });
    } catch (err) {
      live.store.note(`couldn't record how the handoff ended: ${(err as Error).message}`);
    }
    const event: DecisionEventInput = { kind: "handoff", handoffId: h.id, revision: h.revision, phase: state, directionId: h.directionId, sourceIds: [] };
    try {
      init.trails.decision(h.sessionId, event, decisionKey(event));
    } catch (err) {
      live.store.note(`couldn't record the handoff on your session trail: ${(err as Error).message}`);
    }
  }

  /**
   * Main's copy of the choice. Refused when it doesn't parse or its backend isn't here; a refused
   * choice changes nothing, except at setup, where it's kept as the reason the conversation can't
   * start until a choice is made again. A new choice closes debug chat's flight and binding and is
   * a reconfiguration of the active zone.
   */
  private async agentChanged(init: Init, choice: AgentChoice | null, strict: boolean): Promise<void> {
    const before = JSON.stringify(init.settings.agent);
    this.applyAgent(init, choice, strict);
    if (JSON.stringify(init.settings.agent) === before) return;
    await init.debug.close();
    if (this.live) this.reconfigure(init, this.live);
  }

  private applyAgent(init: Init, choice: AgentChoice | null, strict: boolean): void {
    try {
      // Main validated it already; the host checks its own copy again.
      if (choice && !AgentChoiceSchema.safeParse(choice).success) throw new Error("that choice of who powers Dum isn't valid");
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
    for (const role of ROLES) this.live?.store.setModel(role, choice?.[role] ?? null);
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
    this.treeView = treeView(tree);
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

  // -- internals: opening and closing a zone ----------------------------------

  /** Open a zone's conversation with a fresh epoch and a fresh session. Nothing from an earlier open is waiting for anything. */
  private start(init: Init, zoneId: ZoneId): void {
    const zone = zones.resolveZone(zoneId);
    const store = new Store({ id: zone.id, name: zone.breadcrumb.at(-1)!.name }, init.settings.mode);
    const follows = new Follows(init.home, zone.id);
    const saved = memory.load(init.home, zone.id);
    store.restoreTranscript(saved.entries);
    const stopMemory = memory.attach(init.home, zone.id, store);
    for (const role of ROLES) store.setModel(role, init.settings.agent?.[role] ?? null);
    const tree = skills.read();
    store.setUnlocked(tree.skills.length);
    this.treeView = treeView(tree);

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
      if (now !== unlocked) this.treeView = treeView(skills.read());
      unlocked = now;
      if (this.live === live) this.changed();
    });

    const idleTimer = setInterval(() => {
      if (this.live !== live || !live.session || live.running || Date.now() - live.lastActivity < IDLE_MS) return;
      this.endSession(init, live.session.id, "idle", live);
      this.changed();
    }, IDLE_CHECK_MS);
    idleTimer.unref();

    const live: Live = {
      zone, epoch: randomUUID(), store, follows, ambient: null as unknown as Ambient, stop: new AbortController(),
      detach: () => { unsubscribe(); stopMemory(); clearInterval(idleTimer); }, done: Promise.resolve(), pending: null, running: null, next: null,
      changes: [], signals: new Map(),
      look: { status: "watching", reason: null, seen: null, noPictures: "", lastTick: null, lastAttempt: null, lastSuccess: null, pending: 0, inflight: false },
      idle: randomUUID(), session: null, lastActivity: Date.now(), idleTimer, decision: null, deciding: null, summon: null, use: null, stale: new Set(),
    };
    // The Ambient's callbacks reach `live` only once it exists; nothing calls them before the first tick.
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
    this.trailWrite(live, () => this.ensureSession(init, live));
    live.done = this.converse(init, live);
  }

  private ambient(init: Init, live: Live): Ambient {
    const mine = () => this.live === live && !this.closed;
    return new Ambient({
      now: Date.now,
      blocked: (t): LookReason | null => {
        if (!mine()) return "no-zone";
        if (t.zoneId !== live.zone.id || t.epoch !== live.epoch) return "stale-epoch";
        const s = live.store.getSnapshot();
        if (s.prompt?.type === "question") return "decision";
        return live.running || s.busy || s.prompt?.type !== "next" || !live.store.canAttach || live.deciding ? "busy" : null;
      },
      advised: () => this.powered(init),
      scan: async () => {
        if (!mine()) return [];
        const signals = await live.follows.scan();
        for (const s of signals) live.signals.set(s.path, s);
        // The follow list and what the look has noticed both just changed.
        if (signals.length) this.changed();
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
      context: () => (mine() ? { zone: live.zone, binding: this.hostBinding(live) } : null),
      pictures: async () => {
        if (!init.settings.look.screen) return { ok: false, why: "" };
        try {
          const choice = init.registry.chosen();
          const signal = AbortSignal.any([live.stop.signal, AbortSignal.timeout(60_000)]);
          const caps = await init.registry.backend(choice.look.backend).capabilities(choice.look, choice.login, signal);
          return { ok: caps.images, why: caps.noImages };
        } catch (err) {
          return { ok: false, why: (err as Error).message };
        }
      },
      check: async (input, signal) => {
        const started = Date.now();
        const checkId = input.binding.requestId;
        init.diagnostics.record({ kind: "call-start", role: "look", requestId: null, checkId, outcome: "started", reason: "none", latencyMs: null, httpStatus: null });
        try {
          const result = await live.store.helper((stop) => observe(input, {
            agent: init.registry,
            cwd: dirname(statePath(init.home, `zones/${input.zone.id}/runtime/cwd`)),
            signal: AbortSignal.any([signal, stop]),
          }));
          init.diagnostics.record({ kind: "call-end", role: "look", requestId: null, checkId, outcome: "ok", reason: "none", latencyMs: Math.min(Date.now() - started, 86_400_000), httpStatus: null });
          return result;
        } catch (err) {
          init.diagnostics.record({ kind: "call-end", role: "look", requestId: null, checkId, outcome: signal.aborted ? "cancelled" : "failed", reason: signal.aborted ? "timeout" : "call-failed", latencyMs: Math.min(Date.now() - started, 86_400_000), httpStatus: null });
          throw err;
        }
      },
      observed: (result, input) => {
        // A result for another zone, epoch or context revision is about something they've moved on from: nothing is published.
        if (!mine() || input.binding.zoneEpoch !== live.epoch || input.zone.revision !== live.zone.revision) return;
        if (!result.note && !result.topics.length) return;
        this.activity(init, live);
        const excerpt = (result.note ?? result.topics.map((t) => t.topic).join(", ")).slice(0, TRAIL_LIMITS.observationChars);
        this.observeTrail(init, live, result.topics, {
          kind: "look", excerpt, entryId: null, requestId: null, evidenceId: null, changeId: null, handoffId: null, proof: null,
        });
      },
      notes: () => {
        try {
          return memory.notes(init.home, live.zone.id).split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
        } catch {
          return [];
        }
      },
      record: async (result, input) => {
        if (!mine() || input.binding.zoneEpoch !== live.epoch || input.zone.revision !== live.zone.revision) return;
        if (result.note) memory.remember(init.home, live.zone.id, result.note);
      },
      status: (view) => {
        live.look = view;
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
      const started = Date.now();
      init.diagnostics.record({ kind: "call-start", role: "intern", requestId: next.binding.requestId, checkId: null, outcome: "started", reason: "none", latencyMs: null, httpStatus: null });
      let end: RunEnd = "failed";
      try {
        end = await run(request, next.ctx, { signal: stop.signal });
      } finally {
        init.diagnostics.record({
          kind: "call-end", role: "intern", requestId: next.binding.requestId, checkId: null,
          outcome: end === "ok" ? "ok" : end === "failed" ? "failed" : "cancelled", reason: end === "failed" ? "call-failed" : "none",
          latencyMs: Math.min(Date.now() - started, 86_400_000), httpStatus: null,
        });
        this.finish(init, live, next, { end, refused: next.ctx.refused });
      }
    }
  }

  /**
   * Everything in the open zone stops and is saved; only then is it gone. Returns the session that
   * was open, for the caller to end with the reason it knows.
   */
  private async shutdown(): Promise<string | null> {
    const live = this.live!;
    this.live = null;
    live.ambient.close();
    live.deciding?.abort();
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
    return live.session?.id ?? null;
  }

  // -- publishing ---------------------------------------------------------------

  /** The look as Current context shows it: the host's half; main merges pause and permission. */
  private lookStatus(init: Init, live: Live | null): HostLookStatus {
    const chosen = init.settings.agent?.look ?? null;
    if (!live) {
      return { status: this.powered(init) ? "watching" : "no-backend", reason: "no-zone", noPictures: "", seen: null, lastTick: null, lastAttempt: null, lastSuccess: null, chosen, resolved: null };
    }
    const l = live.look;
    let seen: HostLookStatus["seen"] = null;
    try {
      const latest = this.observation(init, live);
      if (latest) seen = { text: latest.text, sourceId: latest.sourceId, at: latest.at, stale: l.status === "failed" };
    } catch { /* an unreadable session shows no observation */ }
    return {
      // Without a backend nothing is ever sent, whether or not a tick has come yet.
      status: this.powered(init) ? l.status : "no-backend", reason: l.reason, noPictures: l.noPictures.slice(0, 2000), seen,
      lastTick: iso(live.ambient.current.lastTick), lastAttempt: iso(l.lastAttempt), lastSuccess: iso(l.lastSuccess), chosen, resolved: null,
    };
  }

  private contextUseView(init: Init, live: Live | null): ContextUseView {
    const counts = { used: 0, omitted: 0, missing: 0, stale: 0 };
    if (!live) return { subject: null, contextRevision: null, correctionRevision: 0, counts, cursor: null };
    const use = live.use;
    for (const item of use?.items ?? []) counts[item.status] += 1;
    let correctionRevision = 0;
    try { correctionRevision = init.directions.corrections(live.zone.id).revision; } catch { /* shown as 0 */ }
    return {
      subject: use?.subject ?? null, contextRevision: use?.contextRevision ?? null, correctionRevision, counts,
      cursor: use && use.items.length ? useCursor(use.subject.id, 0) : null,
    };
  }

  /** State goes to main at most once per turn of the event loop. */
  private changed(): void {
    if (this.scheduled || !this.init || this.closed) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      const init = this.init;
      if (!init || this.closed) return;
      const live = this.live;
      const safely = <T>(read: () => T): T | null => {
        try { return read(); } catch { return null; }
      };
      const look = this.lookStatus(init, live);
      const ambient = live?.ambient.current;
      init.diagnostics.look({
        status: look.status, reason: look.reason, lastTick: look.lastTick, lastAttempt: look.lastAttempt, lastSuccess: look.lastSuccess,
        pending: ambient?.pending ?? 0, inflight: ambient?.inflight ? 1 : 0,
      });
      const agent = init.settings.agent;
      init.diagnostics.models({
        intern: { chosen: agent?.intern ?? null, resolved: null }, helper: { chosen: agent?.helper ?? null, resolved: null }, look: { chosen: agent?.look ?? null, resolved: null },
      });
      const session = live?.session ? safely(() => init.trails.meta(live.session!.id)) : null;
      const current = live ? safely(() => init.delegations.current(live.zone.id)) : null;
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
        look,
        direction: live ? safely(() => this.directionView(init, live.zone)) : null,
        decision: live?.decision?.view ?? null,
        handoff: live && current ? safely(() => this.handoffView(init, live, current)) : null,
        contextUse: this.contextUseView(init, live),
        session: session ?? null,
        trail: live?.session ? safely(() => init.trails.current(live.session!.id)) : null,
      });
    });
  }
}

/** The allowlisted settings diagnostics may show: booleans, mode and the three accelerators. */
function diagnosticSettings(s: DesktopPreferences): DiagnosticSettings {
  return {
    launchAtLogin: s.launchAtLogin, personalContext: s.personalContext, look: s.look, mode: s.mode,
    hotkey: s.hotkey, voiceHotkey: s.voiceHotkey, sendDraftHotkey: s.sendDraftHotkey,
  };
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
      const message = err instanceof Error && err.message ? err.message : "the host couldn't complete that action";
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
    post({ type: "fatal", epoch: o.epoch, message: (err.message || "the host failed").slice(0, 2000) });
    end();
  });
  post({ type: "ready", epoch: o.epoch });
  return controller;
}

// The seam between the agent and whatever is drawing it: one zone's conversation, in order.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Mode } from "./gate.ts";
import type { Role } from "./agent/types.ts";
import type { ZoneId } from "./zone-types.ts";
import type { Entry, ModelLabel, Outcome, Prompt, Purpose, SharedImage, Stage, State } from "./store-types.ts";

/**
 * A parked prompt that was withdrawn rather than answered. Nothing waiting on it may treat that as
 * a reply. `final`: the store is closed, so no prompt will ever be answered again.
 */
export class Cancelled extends Error {
  constructor(readonly final: boolean) {
    super(final ? "dum closed" : "stopped");
  }
}

/** A command whose work happens elsewhere and may take a while. */
type Async = (arg: string) => Promise<string | void>;

type Wait = { resolve: (v: string) => void; reject: (err: Cancelled) => void; entryId: number | null; prompt: Prompt };

const CONVERSATION: Stage = { kind: "conversation" };

export class Store {
  private state: State;
  private listeners = new Set<() => void>();
  private nextId = 1;

  /**
   * Prompts parked on a person, innermost last. A command can ask for permission while dum's own
   * question is open; answering it gives the outer prompt back.
   */
  private waits: Wait[] = [];

  /** Lines typed while dum was working. Only a "what next" takes them: never an answer to a question. */
  private typedAhead: string[] = [];

  /** The slow command running, if any. One at a time, so a permission question is unambiguous. */
  private running = "";
  private runningPrompt: Prompt = null;
  private closed = false;
  /** Aborted by Stop and by close: every helper-model call and slow command in flight sees it. */
  private stopper = new AbortController();
  private readonly scope = new AsyncLocalStorage<AbortSignal>();
  /** Work started under `helper` or `operation` that hasn't settled yet. */
  private work = new Set<Promise<unknown>>();

  onSkillEdit: ((action: "add" | "forget", name: string, lang: string) => void) | null = null;
  /** What `:tree [language|all]` and `:skills` show. */
  onSkills: ((arg: string) => string) | null = null;
  onContext: (() => string) | null = null;
  onMemory: (() => string) | null = null;
  onRemember: ((note: string) => void) | null = null;
  onBoundary: (() => string) | null = null;
  /** What `:evidence` shows: what each skill on the tree rests on. */
  onEvidence: (() => string) | null = null;
  /** "not yet", with the skill named or "" for the last one recorded. True if it took one back. */
  onNotYet: ((name: string) => boolean) | null = null;
  /** `:inspect path[:a-b]`: you hand dum a file you shared or follow. */
  onInspect: Async | null = null;
  /** `:projects [skill]`: suggested projects that fit a skill's scope. */
  onProjects: Async | null = null;
  onSubmit: Async | null = null;
  /** A picture shared with the next request: looked at once, the description shared, the picture dropped. */
  onAttach: ((image: SharedImage, note: string) => Promise<void>) | null = null;
  /** Set while a model turn is in flight: Stop ends that turn. */
  onInterrupt: (() => void) | null = null;

  constructor(zone: { id: ZoneId; name: string }, mode: Mode) {
    this.state = {
      zoneId: zone.id,
      zoneName: zone.name,
      mode,
      transcript: [],
      prompt: null,
      busy: false,
      status: "",
      stage: CONVERSATION,
      unlocked: 0,
      models: { intern: null, helper: null },
    };
  }

  // -- renderer side ------------------------------------------------------

  getSnapshot = (): State => this.state;

  /** A local command suspends its original input; a nested permission remains answerable. */
  get inputReady(): boolean {
    return !!this.state.prompt && (!this.running || this.state.prompt !== this.runningPrompt);
  }

  /** True only at the "what next" prompt itself: the one place a picture may go with a request. */
  get canAttach(): boolean {
    const top = this.waits[this.waits.length - 1];
    return !this.closed && !this.running && top?.prompt?.type === "next" && this.state.prompt === top.prompt;
  }

  /**
   * A picture they chose to share with the request they're about to send. Looked at once, under
   * the one-slow-command guard, so the prompt takes nothing until it's done. Only what the look
   * said is kept; the picture goes out of scope here. True when it was seen; a failed look is a
   * note. Stop or close while it looks throws Cancelled.
   */
  async attach(image: SharedImage, note: string): Promise<boolean> {
    if (!this.canAttach) throw new Error("a picture only goes with a request when dum asks what's next - nothing was sent");
    const look = this.onAttach;
    const outcome = await this.slow("look", look && (() => look(image, note)), "");
    if (outcome === "stopped") throw new Cancelled(this.closed);
    return outcome === "done";
  }

  /**
   * Helper-model work (a look, suggested projects, the wizard) that Stop and close abort. Work
   * aborted while it ran ends in Cancelled even if it happened to finish, so nothing after it
   * records evidence or memory for something they stopped. Inside an `operation` it is that
   * operation's Stop that counts, however late in it the call is made.
   */
  async helper<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.scope.getStore() ?? this.stopper.signal;
    if (signal.aborted) throw new Cancelled(this.closed);
    try {
      const out = await this.track(work(signal));
      if (signal.aborted) throw new Cancelled(this.closed);
      return out;
    } catch (err) {
      if (signal.aborted) throw new Cancelled(this.closed);
      throw err;
    }
  }

  /**
   * A command or an action: one piece of work that Stop or close ends. Every helper call inside
   * it shares the Stop that was current when it began, so a step that starts after Stop can't
   * carry on for work they stopped. Tracked, so `settled` waits for it.
   */
  operation<T>(work: () => Promise<T>): Promise<T> {
    const signal = this.scope.getStore() ?? this.stopper.signal;
    return this.track(this.scope.run(signal, work));
  }

  private track<T>(job: Promise<T>): Promise<T> {
    this.work.add(job);
    return job.finally(() => this.work.delete(job));
  }

  /** Settles once every tracked job (helper calls, slow commands, actions) has ended: nothing is left to write late. */
  async settled(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  /**
   * Withdraw every parked prompt except "what next": a question or an attestation. Each waiter
   * sees Cancelled, never an answer, so stopping answers nothing. Lines typed earlier stay
   * typed-ahead: they only ever become a next request.
   */
  cancel() {
    this.stopper.abort();
    this.stopper = new AbortController();
    const gone = this.waits.filter((w) => w.prompt?.type !== "next");
    if (!gone.length) return;
    this.waits = this.waits.filter((w) => w.prompt?.type === "next");
    this.withdraw(gone, false);
    const top = this.waits[this.waits.length - 1];
    this.patch(top ? { prompt: top.prompt, busy: false, status: "" } : { prompt: null, busy: true, status: "stopping" });
  }

  /**
   * This conversation is over: every prompt is withdrawn, nothing typed is kept, later prompts are
   * refused at once and nothing that finishes late changes what anyone sees.
   */
  close() {
    if (this.closed) return;
    this.stopper.abort();
    const gone = this.waits;
    this.waits = [];
    this.typedAhead.length = 0;
    this.withdraw(gone, true);
    this.patch({ prompt: null, busy: false, status: "" });
    this.closed = true;
    this.listeners.clear();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  /** Old entries are history only. Nothing in them is revived as a pending question. */
  restoreTranscript(entries: Entry[]) {
    this.nextId = Math.max(0, ...entries.map((e) => e.id)) + 1;
    this.patch({ transcript: [...entries] });
  }

  /** A person submitted a line. Commands are handled here and never reach dum as an answer. */
  submit(text: string) {
    if (this.closed) return;
    const line = text.trim();
    const cmd = parseCommand(line);
    if (cmd) {
      void this.command(cmd.name, cmd.arg);
      return;
    }
    const gone = /^:\s*([a-z]+)\b/i.exec(line)?.[1]?.toLowerCase();
    if (gone && Object.hasOwn(REMOVED, gone)) {
      this.note(`:${gone} isn't one of dum's commands - :help lists them. Nothing was sent.`);
      return;
    }
    // Taking a skill back is not an answer to anything - unless there is nothing to take back,
    // and then it was just an answer: "have you added tests?" "not yet".
    const nope = /^not yet\b[\s:,-]*(.*)$/i.exec(line);
    if (nope && this.onNotYet?.(nope[1]!.trim())) return;
    if (this.running && this.state.prompt === this.runningPrompt) {
      this.note(`wait for :${this.running} to finish - your answer wasn't used`);
      return;
    }
    const w = this.waits.pop();
    if (!w) {
      // Recorded now, in the order it was said; the next "what next" takes it without a copy.
      this.append({ kind: "user", text });
      this.typedAhead.push(text);
      return;
    }
    this.answer(w, text);
  }

  /**
   * A yes/no button for the innermost question asked for that purpose. Throws when no such
   * question is showing: a button never answers a different prompt.
   */
  respond(decision: { kind: Purpose; value: boolean }) {
    const top = this.waits[this.waits.length - 1];
    if (this.closed || !top || top.prompt?.type !== "question" || top.prompt.purpose !== decision.kind || this.state.prompt !== top.prompt) {
      throw new Error("nothing is waiting for that answer");
    }
    this.waits.pop();
    this.answer(top, decision.value ? "yes" : "no");
  }

  /** One of dum's `:` commands. Settles when the command, slow ones included, is over. */
  async command(name: string, argument = ""): Promise<void> {
    const arg = argument.trim();
    switch (name) {
      case "tree":
      case "skills":
        return this.show("your skill tree", this.onSkills?.(arg) ?? "");
      case "log":
      case "history":
        return this.show("conversation so far", this.logText());
      case "context":
        return this.show("personal context", this.onContext?.() ?? "no personal context loaded.");
      case "memory":
        try { return this.show("zone memory", this.onMemory?.() ?? "no zone memory loaded."); }
        catch (err) { return this.show("zone memory", (err as Error).message); }
      case "boundary":
        return this.show(`what AI may do in ${this.state.zoneName}`, this.onBoundary?.() ?? "");
      case "evidence":
        return this.show("what your tree rests on", this.onEvidence?.() ?? "no evidence recorded yet.");
      case "help":
        return this.show("dum", HELP);
      case "remember":
        if (!arg) return this.note(":remember <note> saves a note for this zone");
        try { this.onRemember?.(arg); } catch (err) { this.note((err as Error).message); }
        return;
      case "skill": {
        // `:skill x [in lang]` adds to their tree; `:skill -x` takes it off. Their tree, their edit.
        const off = /^-\s*(.+)$/.exec(arg);
        if (off) return this.onSkillEdit?.("forget", off[1]!.trim(), "");
        const add = /^(.+?)(?:\s+in\s+([\w+#.]+))?$/i.exec(arg);
        if (add) return this.onSkillEdit?.("add", add[1]!.trim(), add[2] ?? "");
        return this.note(":skill <name> [in <language>] adds a skill; :skill -<name> takes it off");
      }
      case "inspect":
        if (!arg) return this.note(":inspect <file>[:start-end] shows dum a file you shared or follow");
        return void (await this.slow(name, this.onInspect, arg));
      case "projects":
        return void (await this.slow(name, this.onProjects, arg));
      case "submit":
        if (!arg) return this.note(":submit pN <file>... --unaided hands in your own work on suggested project N");
        return void (await this.slow(name, this.onSubmit, arg));
    }
  }

  // -- agent side ---------------------------------------------------------

  /** `lead` marks the line that matters this turn - a verdict - over any chatter after it. */
  say(text: string, lead = false) {
    this.append({ kind: "say", text, ...(lead ? { lead } : {}) });
    this.closeBoard();
  }

  note(text: string) {
    this.append({ kind: "note", text });
  }

  /** The wizard's line. */
  quip(text: string) {
    this.append({ kind: "quip", text });
  }

  /** Busy on something that isn't a person. A prompt someone is answering stays up. */
  working(status: string) {
    if (this.waits.length) this.patch({ status });
    else this.patch({ prompt: null, busy: true, status });
  }

  /** `why` says what refused it, when it wasn't the usual reason for that outcome. */
  toolEvent(name: string, detail: string, outcome: Outcome, why?: string) {
    this.append({ kind: "tool", name, detail, outcome, ...(why ? { why } : {}) });
  }

  excerpt(path: string, from: number, text: string, by: "you" | "dum" = "you", note?: string) {
    this.append({ kind: "excerpt", path, from, text, by, ...(note ? { note } : {}) });
  }

  /** A change written to their file, or put back: the diff and the change it belongs to, for one-click revert. */
  diff(path: string, diff: string, outcome: "applied" | "reverted", changeId: string) {
    this.append({ kind: "diff", path, diff, outcome, changeId });
  }

  /** Something for you to read that isn't anyone speaking - help, the tree. */
  show(title: string, body: string) {
    this.patch({ stage: { kind: "info", title, body } });
  }

  closeBoard() {
    if (this.state.stage.kind !== "conversation") this.patch({ stage: CONVERSATION });
  }

  setUnlocked(unlocked: number) {
    if (this.state.unlocked !== unlocked) this.patch({ unlocked });
  }

  /** What a one-time look at a shared picture saw. Never the picture itself. */
  shot(label: string, observation: string, sha: string) {
    this.append({ kind: "shot", label, observation, sha });
  }

  /** Which backend, model and effort run a role; null when none is chosen. */
  setModel(role: Role, label: ModelLabel | null) {
    const was = this.state.models[role];
    if (was === label || (was && label && was.backend === label.backend && was.model === label.model && was.effort === label.effort)) return;
    this.patch({ models: { ...this.state.models, [role]: label } });
  }

  /**
   * Ask one question and park until it is answered. Only a line typed after it shows answers
   * it: a permission is never granted by something said before the question existed.
   */
  askQuestion(question: string, why = "", intern = true, purpose?: Purpose): Promise<string> {
    const id = this.append({ kind: "question", question, why, answer: null });
    return this.park({ type: "question", question, why, intern, ...(purpose ? { purpose } : {}) }, id, false);
  }

  /** The `what next` prompt between requests. Takes a line typed while dum was working. */
  askNext(): Promise<string> {
    return this.park({ type: "next" }, null, true);
  }

  /** The conversation as plain text, for the history panel. */
  logText(): string {
    const out: string[] = [];
    for (const e of this.state.transcript) {
      if (e.kind === "say") out.push(`dum: ${e.text}`);
      else if (e.kind === "question") {
        if (e.question) out.push(`dum asks: ${e.question}`);
        if (e.answer !== null) out.push(`you: ${e.answer}`);
      } else if (e.kind === "user") out.push(`you: ${e.text}`);
      else if (e.kind === "quip") out.push(`wizard: ${e.text}`);
      else if (e.kind === "plan") out.push(`old plan (${e.approved === null ? "never answered" : e.approved ? "approved then" : "not approved"}):\n${e.plan}`);
      else if (e.kind === "course") out.push(`old course: ${e.card.skill}${e.card.lang ? ` (${e.card.lang})` : ""}`);
      else if (e.kind === "tool") out.push(`· ${e.name} ${e.detail} - ${e.outcome}${e.why ? `: ${e.why}` : ""}`);
      else if (e.kind === "fill") out.push(`· filled ${e.concept} in ${e.path}`);
      else if (e.kind === "note") out.push(`· ${e.text}`);
      else if (e.kind === "excerpt") out.push(`${e.by === "you" ? "you shared" : "dum read"} ${e.path}:${e.from}${e.note ? ` (${e.note})` : ""}\n${e.text}`);
      else if (e.kind === "diff") out.push(`${e.outcome} ${e.path}${e.changeId ? ` (change ${e.changeId})` : ""}${e.artifact ? ` -> ${e.artifact}` : ""}\n${e.diff}`);
      else if (e.kind === "result") out.push(`$ ${e.label}  (exit ${e.code})\n${e.output}`);
      else if (e.kind === "shot") out.push(`you shared a picture of ${e.label}; one look saw:\n${e.observation}`);
    }
    return out.join("\n") || "nothing said yet.";
  }

  // -- internals ----------------------------------------------------------

  /** How the command ended: ran to the end, failed (and said why), or was stopped by Stop/close. */
  private async slow(name: string, fn: Async | null, arg: string): Promise<"done" | "failed" | "stopped"> {
    if (!fn) {
      this.note(`:${name} works once a zone is open`);
      return "failed";
    }
    if (this.running) {
      this.note(`wait for :${this.running} to finish`);
      return "failed";
    }
    this.running = name;
    this.runningPrompt = this.state.prompt;
    this.patch({ status: `:${name}` });
    try {
      await this.operation(() => fn(arg));
      return "done";
    } catch (err) {
      if (err instanceof Cancelled) {
        this.note(`:${name} stopped - nothing from it was kept`);
        return "stopped";
      }
      this.note(`:${name} didn't work: ${(err as Error).message}`);
      return "failed";
    } finally {
      this.running = "";
      this.runningPrompt = null;
      // Back at the prompt it was typed at: whatever the command was busy with is over.
      this.patch({ status: "" });
    }
  }

  private park(prompt: Prompt, entryId: number | null, ahead: boolean): Promise<string> {
    if (this.closed) return Promise.reject(new Cancelled(true));
    // dum asking something takes the conversation back from a help panel.
    if (prompt?.type === "question" && prompt.intern) this.closeBoard();
    if (ahead && this.typedAhead.length) {
      // Already in the transcript as a `user` entry from when it was typed.
      const early = this.typedAhead.shift()!;
      this.patch({ busy: false, status: "" });
      return Promise.resolve(early);
    }
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    this.waits.push({ resolve, reject, entryId, prompt });
    this.patch({ prompt, busy: false, status: "" });
    return promise;
  }

  /** The popped wait gets its answer; the prompt under it, if any, shows again. */
  private answer(w: Wait, text: string) {
    this.record(w.entryId, text);
    const outer = this.waits[this.waits.length - 1];
    this.patch(
      outer
        ? { prompt: outer.prompt, busy: false, status: "" }
        : { prompt: null, busy: true, status: "thinking", ...(this.state.stage.kind === "info" ? { stage: CONVERSATION } : {}) },
    );
    w.resolve(text);
  }

  /** Withdrawn prompts, innermost first: every waiter sees Cancelled. */
  private withdraw(gone: Wait[], final: boolean) {
    for (const w of gone.reverse()) w.reject(new Cancelled(final));
  }

  /** An answer lands on its question; anything else said is its own entry. */
  private record(entryId: number | null, text: string) {
    if (entryId === null) {
      this.append({ kind: "user", text });
      return;
    }
    this.patch({
      transcript: this.state.transcript.map((e) =>
        e.id === entryId && e.kind === "question" ? { ...e, answer: text } : e,
      ),
    });
  }

  private append(e: Omit<Entry, "id"> & Record<string, unknown>): number {
    const id = this.nextId++;
    this.patch({ transcript: [...this.state.transcript, { ...e, id } as Entry] });
    return id;
  }

  /** Every mutation goes through here, so the snapshot identity is the signal. Closed, nothing changes. */
  private patch(p: Partial<State>) {
    if (this.closed) return;
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn();
  }
}

const HELP = [
  "talk to dum     ask for something, tell it what you built, answer its questions",
  ":tree           your skill tree: tracks, levels, what's open next (:skills too)",
  ":inspect f[:a-b] show dum a file you shared or follow",
  ":projects [x]   suggested projects that fit a skill's scope",
  ":submit pN f --unaided  hand in your own work on suggested project N",
  "not yet         undo the skill just recorded",
  ":skill x        add a skill you have (:skill -x takes it off)",
  ":context        the personal background used for suggestions",
  ":memory         notes remembered in this zone (:remember x adds one)",
  ":evidence       what each skill on your tree rests on",
  ":boundary       what AI may do for you right now",
  ":log            everything said in this zone",
  "",
  "when you hold the skills, dum writes a change you ask for straight into a file you shared or follow;",
  "you see the diff after, and Revert puts it back.",
].join("\n");

/** dum's commands. `bare`: takes nothing after it, so `:help me` is a sentence, not a command. */
const COMMANDS: Record<string, { bare: boolean }> = {
  tree: { bare: false }, skills: { bare: false }, log: { bare: true }, history: { bare: true }, context: { bare: true },
  memory: { bare: true }, boundary: { bare: true }, help: { bare: true }, evidence: { bare: true },
  remember: { bare: false }, skill: { bare: false }, inspect: { bare: false }, projects: { bare: false }, submit: { bare: false },
};

/** Commands earlier versions had. Typed now, they're refused with a pointer to :help, never sent as a message. */
const REMOVED: Record<string, true> = { self: true, restart: true, web: true, run: true, changes: true, share: true, practice: true };

/** A `:name [arg]` line that is one of dum's commands, or null for anything else - `:yes` included. */
export function parseCommand(line: string): { name: string; arg: string } | null {
  const m = /^:\s*([a-z]+)(?:\s+([\s\S]*))?$/i.exec(line.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const arg = (m[2] ?? "").trim();
  const known = Object.hasOwn(COMMANDS, name) ? COMMANDS[name]! : null;
  if (!known || (known.bare && arg)) return null;
  return { name, arg };
}

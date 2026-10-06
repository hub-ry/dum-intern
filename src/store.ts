// The seam between the agent and whatever is drawing it: one conversation, in order.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Mode } from "./gate.ts";

export type Outcome = "ran" | "held" | "refused";

/** A model, and the effort level it runs at. */
export type Voice = { model: string; effort: string };

/** A course as it's shown: dum's lesson and example, the wizard's line, and the gap to type. */
export type CourseCard = {
  skill: string;
  lang: string;
  lesson: string;
  example: string;
  /** The wizard's line: what it's called out in the world, and where it shows up. "" if it passed. */
  wizard: string;
  task: string;
  /** The scratch file the gap is in, repo-relative. */
  path: string;
  run: string;
};

/**
 * One thing that happened, in order. The transcript is append-only. `fill` and empty `question`
 * entries come from older sessions and stay readable history.
 */
export type Entry =
  | { kind: "say"; id: number; text: string; lead?: boolean }
  | { kind: "question"; id: number; question: string; why: string; answer: string | null }
  | { kind: "quip"; id: number; text: string }
  /** `paused` while a course runs from it; the plan comes back after. */
  | { kind: "plan"; id: number; plan: string; approved: boolean | null; paused?: boolean }
  | { kind: "course"; id: number; card: CourseCard; passed: boolean | null }
  | { kind: "tool"; id: number; name: string; detail: string; outcome: Outcome; why?: string }
  | { kind: "fill"; id: number; path: string; concept: string; code: string }
  | { kind: "note"; id: number; text: string }
  /** A focused, numbered piece of a file: shared by you, or read by dum. `from` is 1-based. */
  | { kind: "excerpt"; id: number; path: string; from: number; text: string; by: "you" | "dum"; note?: string }
  /** A change dum proposed or created. Proposals are artifacts for your editor, never applied. */
  | { kind: "diff"; id: number; path: string; diff: string; outcome: "proposed" | "created" | "refused"; artifact?: string }
  /** Something you said that wasn't the answer to a question. */
  | { kind: "user"; id: number; text: string }
  /** A read-only command dum ran, and what it printed. */
  | { kind: "result"; id: number; label: string; output: string; code: number }
  /**
   * A picture they chose to share, as one separate look described it. `sha` (SHA-256) names the
   * exact picture; the picture itself is never kept. A look that failed is a note instead.
   */
  | { kind: "shot"; id: number; label: string; observation: string; sha: string };

/** A yes/no that only they can give, about their own work or their own files. Never answered by default. */
export type Purpose = "attest" | "share";

/** What the agent is currently blocked on, if anything. */
export type Prompt =
  /** `intern`: dum asking, rather than the app asking for a request or a permission. */
  | { type: "question"; question: string; why: string; intern?: boolean; purpose?: Purpose }
  | { type: "plan"; plan: string }
  | { type: "course"; card: CourseCard }
  | { type: "next" }
  | null;

/** What is up besides the conversation: a panel to read, or nothing. */
export type Stage = { kind: "info"; title: string; body: string } | { kind: "conversation" };

export type State = {
  repo: string;
  root: string;
  files: string[];
  mode: Mode;
  transcript: Entry[];
  prompt: Prompt;
  /** True while dum is working rather than waiting on a person. */
  busy: boolean;
  status: string;
  stage: Stage;
  /** How many skills are on the tree. */
  unlocked: number;
  /** The model behind each voice and the effort it runs at. */
  models: { intern: Voice; wizard: Voice };
};

/** A picture they chose to share with one request: base64 PNG, held only until that turn is sent. */
export type SharedImage = { data: string; mimeType: "image/png"; label: string };

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

  /** Lines typed while dum was working. Only a "what next" takes them: never an approval. */
  private typedAhead: string[] = [];

  /** Lines typed during a self change, for the prompt that was showing before it. */
  private queued: string[] = [];
  private selfChanging = false;
  /** The slow command running, if any. One at a time, so a permission question is unambiguous. */
  private running = "";
  private runningPrompt: Prompt = null;
  private closed = false;
  /** Aborted by Stop and by close: every helper-model call and slow command in flight sees it. */
  private stopper = new AbortController();
  private readonly scope = new AsyncLocalStorage<AbortSignal>();
  /** Work started under `helper` or `slow` that hasn't settled yet. */
  private work = new Set<Promise<unknown>>();

  onSkillEdit: ((action: "add" | "forget", name: string, lang: string) => void) | null = null;
  /** What `:tree [language|all]` and `:skills` show. */
  onSkills: ((arg: string) => string) | null = null;
  onContext: (() => string) | null = null;
  onMemory: (() => string) | null = null;
  onRemember: ((note: string) => void) | null = null;
  onSelfChange: ((request: string) => Promise<string>) | null = null;
  onRestart: (() => void) | null = null;
  onWeb: ((server?: string) => string | Promise<string>) | null = null;
  onBoundary: (() => string) | null = null;
  /** What `:evidence` shows: the project's ledger of what each skill on the tree rests on. */
  onEvidence: (() => string) | null = null;
  /** "not yet", with the skill named or "" for the last one recorded. True if it took one back. */
  onNotYet: ((name: string) => boolean) | null = null;
  /** `:inspect path[:a-b]` and `:share path`: you hand dum a saved file. */
  onInspect: Async | null = null;
  /** `:changes [path]`: you hand dum what changed in the working tree. */
  onChanges: Async | null = null;
  onPractice: Async | null = null;
  onSubmit: Async | null = null;
  /** `:run status|diff|log`: dum's read-only git catalog. Never a shell. */
  onRun: Async | null = null;
  /** A picture shared with the next request: looked at once, the description shared, the picture dropped. */
  onAttach: ((image: SharedImage, note: string) => Promise<void>) | null = null;
  /** Set while a Claude turn is in flight: ctrl-c stops that turn. */
  onInterrupt: (() => void) | null = null;
  /** Set by a renderer that can reprint the whole conversation itself. */
  onLog: (() => void) | null = null;

  constructor(repo: string, mode: Mode, root = "", files: string[] = []) {
    this.state = {
      repo,
      root,
      files,
      mode,
      transcript: [],
      prompt: null,
      busy: false,
      status: "",
      stage: CONVERSATION,
      unlocked: 0,
      models: { intern: { model: "", effort: "" }, wizard: { model: "", effort: "" } },
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
    return !this.closed && !this.selfChanging && !this.running && top?.prompt?.type === "next" && this.state.prompt === top.prompt;
  }

  /**
   * A picture they chose to share with the request they're about to send. Looked at once, under
   * the one-slow-command guard, so the prompt takes nothing until it's done. Only what the look
   * said is kept; the picture goes out of scope here. True when it was seen; Stop or close
   * while it looks throws Cancelled.
   */
  async attach(image: SharedImage, note: string): Promise<boolean> {
    if (!this.canAttach) throw new Error("a picture only goes with a request when dum asks what's next - nothing was sent");
    const look = this.onAttach;
    const outcome = await this.slow("look", look && (() => look(image, note)), "");
    if (outcome === "stopped") throw new Cancelled(this.closed);
    return outcome === "done";
  }

  /**
   * Helper-model work (a look, practice, a course, the wizard) that Stop and close abort. Work
   * aborted while it ran ends in Cancelled even if it happened to finish, so nothing after it
   * records evidence, tasks or memory for something they stopped. Inside an `operation` it is
   * that operation's Stop that counts, however late in it the call is made.
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
   * A command, a tool or a course: one piece of work that Stop or close ends. Every helper call
   * inside it shares the Stop that was current when it began, so a step that starts after Stop
   * can't carry on for work they stopped. Tracked, so `settled` waits for it.
   */
  operation<T>(work: () => Promise<T>): Promise<T> {
    const signal = this.scope.getStore() ?? this.stopper.signal;
    return this.track(this.scope.run(signal, work));
  }

  private track<T>(job: Promise<T>): Promise<T> {
    this.work.add(job);
    return job.finally(() => this.work.delete(job));
  }

  /** Settles once every tracked job (helper calls, slow commands, tools) has ended: nothing is left to write late. */
  async settled(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  /**
   * Withdraw every parked prompt except "what next": a question, a permission, a plan, a course.
   * Each waiter sees Cancelled, never an answer, so stopping approves nothing. Lines typed earlier
   * stay typed-ahead: they only ever become a next request.
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
    this.queued.length = 0;
    this.withdraw(gone, true);
    this.patch({ prompt: null, busy: false, status: "" });
    this.closed = true;
    this.listeners.clear();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  /** Old entries are history only. Pending questions and plans aren't revived as approval. */
  restoreTranscript(entries: Entry[]) {
    this.nextId = Math.max(0, ...entries.map((e) => e.id)) + 1;
    this.patch({ transcript: [...entries] });
  }

  /** Keep the pending learning question intact while the developer works on dum. */
  async changeSelf(request: string): Promise<string> {
    if (!this.onSelfChange) return "self changes are available in dum-dev. Start it with dum-dev or dum --dev.";
    if (this.selfChanging) return "a self change is already running";
    if (!request.trim()) return ":self <request> changes dum itself";
    this.append({ kind: "question", question: "change dum itself", why: "", answer: request });
    const { prompt, busy, status, stage } = this.state;
    this.selfChanging = true;
    this.patch({ prompt: null, busy: true, status: "self: starting" });
    let reply: string;
    try {
      reply = await this.onSelfChange(request);
    } catch (err) {
      reply = `self change stopped: ${(err as Error).message}`;
    } finally {
      this.selfChanging = false;
      this.patch({ prompt, busy, status, stage });
    }
    this.say(reply);
    // What was typed during maintenance answers the prompt that was showing before it.
    for (const line of this.queued.splice(0)) this.submit(line);
    return reply;
  }

  /** A person submitted a line. Commands are handled here and never reach dum as an answer. */
  submit(text: string) {
    if (this.closed) return;
    const line = text.trim();
    const self = /^:\s*self(?:\s+([\s\S]*))?$/i.exec(line);
    if (self) {
      if (this.state.busy && !this.selfChanging) {
        this.note("dum is working - use :self when it asks for your next input");
        return;
      }
      void this.changeSelf(self[1] ?? "").then((reply) => {
        if (!this.onSelfChange || !self[1] || reply === "a self change is already running") this.note(reply);
      });
      return;
    }
    if (/^:\s*restart\s*$/i.test(line)) {
      if (!this.onRestart) this.note(":restart is available in dum-dev");
      else if (this.state.busy || this.selfChanging || this.running) this.note("wait for dum to finish before restarting");
      else this.onRestart();
      return;
    }
    const cmd = parseCommand(line);
    if (cmd) {
      this.command(cmd.name, cmd.arg);
      return;
    }
    if (line.startsWith("!")) {
      this.note("dum doesn't run shell commands. Run builds and programs in your own terminal; :run status, :run diff or :run log shows git state.");
      return;
    }
    if (this.selfChanging) {
      this.queued.push(text);
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
    this.record(w.entryId, text);
    const outer = this.waits[this.waits.length - 1];
    this.patch(
      outer
        ? { prompt: outer.prompt, busy: false, status: "" }
        : { prompt: null, busy: true, status: "thinking", ...(this.state.stage.kind === "info" ? { stage: CONVERSATION } : {}) },
    );
    w.resolve(text);
  }

  /** One of dum's `:` commands, from the input or from the runner at startup. */
  command(name: string, argument = "") {
    const arg = argument.trim();
    switch (name) {
      case "tree":
      case "skills":
        return this.show("your skill tree", this.onSkills?.(arg) ?? "");
      case "log":
        if (this.onLog) return this.onLog();
        return this.show("conversation so far", this.logText());
      case "context":
        return this.show("personal context", this.onContext?.() ?? "no personal context loaded.");
      case "memory":
        try { return this.show("session memory", this.onMemory?.() ?? "no session memory loaded."); }
        catch (err) { return this.show("session memory", (err as Error).message); }
      case "boundary":
        return this.show(`what AI may do in ${this.state.repo}`, this.onBoundary?.() ?? "");
      case "evidence":
        return this.show("what your tree rests on", this.onEvidence?.() ?? "no evidence recorded here yet.");
      case "web":
        return void this.showWeb(arg || undefined);
      case "help":
        return this.show("dum", this.help());
      case "remember":
        if (!arg) return this.note(":remember <note> saves a note for the next session");
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
      case "share":
        if (!arg) return this.note(`:${name} <path>[:start-end] shows dum a saved file`);
        return void this.slow(name, this.onInspect, arg);
      case "changes":
        return void this.slow(name, this.onChanges, arg);
      case "practice":
        return void this.slow(name, this.onPractice, arg);
      case "submit":
        if (!arg) return this.note(":submit <skill> [in <language>] <path> --unaided hands in your own implementation");
        return void this.slow(name, this.onSubmit, arg);
      case "run":
        return void this.slow(name, this.onRun, arg || "status");
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

  diff(path: string, diff: string, outcome: "proposed" | "created" | "refused", artifact?: string) {
    this.append({ kind: "diff", path, diff, outcome, ...(artifact ? { artifact } : {}) });
  }

  result(label: string, output: string, code: number) {
    this.append({ kind: "result", label, output, code });
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

  /** Which model is behind a voice. */
  setModel(who: "intern" | "wizard", model: string, effort = "") {
    const was = this.state.models[who];
    // An init with no effort must not wipe one already read back.
    const next = { model, effort: effort || (was.model === model ? was.effort : "") };
    if (was.model === next.model && was.effort === next.effort) return;
    this.patch({ models: { ...this.state.models, [who]: next } });
  }

  /**
   * Ask one question and park until it is answered. Only a line typed after it shows answers
   * it: a permission is never granted by something said before the question existed.
   */
  askQuestion(question: string, why = "", intern = true, purpose?: Purpose): Promise<string> {
    const id = this.append({ kind: "question", question, why, answer: null });
    return this.park({ type: "question", question, why, intern, ...(purpose ? { purpose } : {}) }, id, false);
  }

  /** The `what next` prompt between turns. Takes a line typed while dum was working. */
  askNext(): Promise<string> {
    return this.park({ type: "next" }, null, true);
  }

  /**
   * Show the plan and park for the reply: y approves; anything else doesn't. Withdrawn, it
   * stays in the record as not approved.
   */
  async proposePlan(plan: string): Promise<string> {
    const id = this.append({ kind: "plan", plan, approved: null });
    let reply: string;
    try {
      reply = (await this.park({ type: "plan", plan }, null, false)).trim();
    } catch (err) {
      this.patch({ transcript: this.state.transcript.map((e) => (e.id === id && e.kind === "plan" ? { ...e, approved: false } : e)) });
      throw err;
    }
    const approved = /^(y|yes)$/i.test(reply);
    const paused = /^:?\s*(course|learn|unlock)\s+\S/i.test(reply);
    this.patch({
      transcript: this.state.transcript.map((e) =>
        e.id === id && e.kind === "plan" ? { ...e, ...(paused ? { paused } : { approved }) } : e,
      ),
    });
    return reply;
  }

  /** An optional course starts: its card goes in the record. */
  course(card: CourseCard) {
    this.append({ kind: "course", card, passed: null });
    if (card.wizard) this.quip(card.wizard);
  }

  /** Park inside a course: done, a question, or quit. */
  askCourse(card: CourseCard): Promise<string> {
    return this.park({ type: "course", card }, null, false);
  }

  endCourse(card: CourseCard, passed: boolean) {
    this.patch({
      transcript: this.state.transcript.map((e) => (e.kind === "course" && e.card === card ? { ...e, passed } : e)),
    });
  }

  /** The conversation as plain text, for `:log` when the renderer can't reprint it. */
  logText(): string {
    const out: string[] = [];
    for (const e of this.state.transcript) {
      if (e.kind === "say") out.push(`dum: ${e.text}`);
      else if (e.kind === "question") {
        if (e.question) out.push(`dum asks: ${e.question}`);
        if (e.answer !== null) out.push(`you: ${e.answer}`);
      } else if (e.kind === "user") out.push(`you: ${e.text}`);
      else if (e.kind === "quip") out.push(`wizard: ${e.text}`);
      else if (e.kind === "plan") out.push(`plan (${e.paused ? "paused" : e.approved === null ? "pending" : e.approved ? "approved" : "not approved"}):\n${e.plan}`);
      else if (e.kind === "course") out.push(`course: ${e.card.skill}${e.card.lang ? ` (${e.card.lang})` : ""}${e.passed === null ? "" : e.passed ? " - passed" : " - left"}`);
      else if (e.kind === "tool") out.push(`· ${e.name} ${e.detail} - ${e.outcome}${e.why ? `: ${e.why}` : ""}`);
      else if (e.kind === "fill") out.push(`· filled ${e.concept} in ${e.path}`);
      else if (e.kind === "note") out.push(`· ${e.text}`);
      else if (e.kind === "excerpt") out.push(`${e.by === "you" ? "you shared" : "dum read"} ${e.path}:${e.from}${e.note ? ` (${e.note})` : ""}\n${e.text}`);
      else if (e.kind === "diff") out.push(`${e.outcome} ${e.path}${e.artifact ? ` -> ${e.artifact}` : ""}\n${e.diff}`);
      else if (e.kind === "result") out.push(`$ ${e.label}  (exit ${e.code})\n${e.output}`);
      else if (e.kind === "shot") out.push(`you shared a picture of ${e.label}; one look saw:\n${e.observation}`);
    }
    return out.join("\n") || "nothing said yet.";
  }

  // -- internals ----------------------------------------------------------

  private help(): string {
    return [
      "talk to dum     ask for something, explain a decision, answer its questions",
      ":tree           your skill tree: tracks, levels, what's open next (:skills too)",
      ":inspect f[:a-b] show dum a file you saved in your editor",
      ":share f        show dum one file outside this project (asks first)",
      ":changes [f]    show dum what changed in the working tree",
      ":practice [x]   practice ideas for what you could learn next",
      ":submit x f --unaided   hand in your own implementation of skill x",
      ":run status|diff|log    read-only git, shown to dum too",
      "course x        an optional short course (course x in rust)",
      "not yet         undo the skill just recorded",
      ":skill x        add a skill you have (:skill -x takes it off)",
      ":context        the local background used for suggestions",
      ":memory         notes remembered for this project (:remember x adds one)",
      ...(this.onSelfChange ? [":self x         change dum's own checkout", ":restart        load saved changes and restore this session"] : []),
      ":evidence       what each skill recorded here rests on",
      ":boundary       what AI may do in this repo",
      ":web            sync the tree with its webpage (:web <server> links it)",
      ":log            everything said so far",
      "",
      "dum proposes changes as diffs you apply in your editor; it never overwrites your files.",
    ].join("\n");
  }

  /** How the command ended: ran to the end, failed (and said why), or was stopped by Stop/close. */
  private async slow(name: string, fn: Async | null, arg: string): Promise<"done" | "failed" | "stopped"> {
    if (!fn) {
      this.note(`:${name} works once dum has started in this repo`);
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

  private async showWeb(server?: string) {
    this.show("your tree on the web", server ? "connecting your tree…" : "syncing your tree…");
    const panel = this.state.stage;
    try {
      const text = await this.onWeb?.(server) ?? "not linked yet. :web <server> connects your tree.";
      // A late network response must not cover a conversation they've returned to.
      if (this.state.stage === panel) this.show("your tree on the web", text);
    } catch (err) {
      if (this.state.stage === panel) this.show("your tree on the web", `couldn't connect: ${(err as Error).message}\n\nYour local tree is unchanged. Try :web again.`);
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
    this.patch(this.selfChanging ? {} : { prompt, busy: false, status: "" });
    return promise;
  }

  /** Withdrawn prompts, innermost first: an open course is left, and every waiter sees Cancelled. */
  private withdraw(gone: Wait[], final: boolean) {
    for (const w of gone.reverse()) {
      if (w.prompt?.type === "course") this.endCourse(w.prompt.card, false);
      w.reject(new Cancelled(final));
    }
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

/** dum's commands. `bare`: takes nothing after it, so `:help me` is a sentence, not a command. */
const COMMANDS: Record<string, { bare: boolean }> = {
  tree: { bare: false }, skills: { bare: false }, log: { bare: true }, context: { bare: true },
  memory: { bare: true }, boundary: { bare: true }, help: { bare: true }, evidence: { bare: true }, web: { bare: false },
  remember: { bare: false }, skill: { bare: false }, inspect: { bare: false }, share: { bare: false },
  changes: { bare: false }, practice: { bare: false }, submit: { bare: false }, run: { bare: false },
};

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

// The seam between the agent and whatever is drawing it.

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import type { Mode } from "./session.ts";
import { runnerFor } from "./shell.ts";

export type Outcome = "ran" | "held" | "refused";

/** A model, and the effort level it runs at. */
export type Voice = { model: string; effort: string };

export type Lesson = {
  concept: string;
  what_it_is: string;
  why_it_exists: string;
  in_industry: string;
  here: string;
};

/** One thing that happened, in order. The transcript is append-only. */
export type Entry =
  | { kind: "say"; id: number; text: string }
  | { kind: "question"; id: number; question: string; why: string; answer: string | null }
  | { kind: "lesson"; id: number; lesson: Lesson }
  | { kind: "quip"; id: number; text: string; about: string }
  | { kind: "spec"; id: number; spec: string; approved: boolean | null }
  | { kind: "tool"; id: number; name: string; detail: string; outcome: Outcome; why?: string }
  | { kind: "answer"; id: number; question: string; body: string }
  | { kind: "review"; id: number; text: string }
  | { kind: "fill"; id: number; path: string; concept: string; code: string }
  | { kind: "note"; id: number; text: string };

/** What the agent is currently blocked on, if anything. */
export type Prompt =
  | {
      type: "question";
      question: string;
      why: string;
      /** The intern's own question, where "idk" and "type it" mean something. */
      choices?: boolean;
    }
  | { type: "spec"; spec: string }
  | { type: "next" }
  | null;

/** The file currently under the intern's hands. */
export type CodeView = {
  tool: string;
  path: string;
  body: string;
  live: boolean;
  outcome: Outcome | null;
  /** What refused or held it, when it wasn't the usual reason. */
  why?: string;
  /** True once `body` is the file as it is on disk, which is the only thing worth editing. */
  onDisk: boolean;
  /** The line to land on when the editor first shows this. */
  at?: number;
  /**
   * Set when something asks to land on `at` even if the buffer already exists - handing you a
   * hole in a file the intern just wrote.
   */
  jump?: number;
};

/** What the wide pane is showing. */
export type Stage =
  | { kind: "code" }
  | { kind: "answer"; question: string; body: string; pending: boolean }
  | { kind: "spec"; spec: string }
  | { kind: "lesson"; lesson: Lesson }
  | { kind: "info"; title: string; body: string }
  | { kind: "reply"; text: string }
  | { kind: "transcript" };

export type State = {
  repo: string;
  root: string;
  files: string[];
  mode: Mode;
  transcript: Entry[];
  prompt: Prompt;
  /** True while the intern is working rather than waiting on a person. */
  busy: boolean;
  status: string;
  code: CodeView | null;
  stage: Stage;
  /** Skills on the tree that count in this repo, and how many are still shaky. */
  skills: { known: number; shaky: number; claimed: number };
  /** Holes the intern left for you to type, each one a skill to unlock. */
  todos: { concept: string; path: string }[];
  /** What "what next?" offers - a rebuild's next milestone. "" for nothing. */
  suggestion: string;
  /**
   * The last thing on the stage that wasn't the file or the log - a long reply, an answer,
   * help, a lesson, a spec.
   */
  reply: Stage | null;
  /** Where a milestone folder stands: done of total, and what a unit is called. */
  progress: { done: number; total: number; unit: string } | null;
  /** The model behind each voice and the effort it runs at, as the SDK reported them. */
  models: { intern: Voice; wizard: Voice };
};

/** Past this, what dum says opens on the stage too. About six narrow lines. */
const LONG_SAY = 170;

const isReply = (s: Stage) => s.kind !== "code" && s.kind !== "transcript";

export class Store {
  private state: State;
  private listeners = new Set<() => void>();
  private nextId = 1;
  private jumps = 0;

  /** The promise the agent is parked on, and the entry to write the reply into. */
  private waiting: { resolve: (v: any) => void; entryId: number } | null = null;

  /** Anything typed before the agent got around to asking. */
  private typedAhead: string[] = [];

  /** Set by the runner: where a `?` question goes. */
  onAsk: ((question: string) => void) | null = null;

  /** Set by the runner: `!cmd` - run it in a real shell. "" for an interactive shell. */
  onShell: ((cmd: string) => void) | null = null;

  /** Set by the runner: draw the graph and open it. */
  onGraph: (() => void) | null = null;

  /** Set by the runner: "not yet", with the skill named or "" for the last one checked off. */
  onNotYet: ((name: string) => boolean) | null = null;

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
      code: null,
      stage: { kind: "code" },
      skills: { known: 0, shaky: 0, claimed: 0 },
      todos: [],
      suggestion: "",
      progress: null,
      reply: null,
      models: { intern: { model: "", effort: "" }, wizard: { model: "", effort: "" } },
    };
  }

  // -- renderer side ------------------------------------------------------

  getSnapshot = (): State => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  /** A person submitted a line. */
  submit(text: string) {
    // A `?` line is not an answer.
    if (text.startsWith("?")) {
      const question = text.slice(1).trim();
      if (question) this.onAsk?.(question);
      return;
    }
    // `:run`, `:graph`, `:log`, `:help` - dum's commands, vim's ex line.
    const ex = /^:\s*(run|graph|log|help)\s*$/i.exec(text.trim());
    if (ex) {
      this.command(ex[1]!.toLowerCase());
      return;
    }
    // `!` is a shell, same as vim and Claude Code. Never an answer either.
    if (text.startsWith("!") && this.onShell) {
      this.onShell(text.slice(1).trim());
      return;
    }
    // Same rule as `?`: taking a skill back is not an answer to anything, and must never cost
    // the turn or reach the intern as one.
    const nope = /^not yet\b[\s:,-]*(.*)$/i.exec(text.trim());
    // Returns false when there is nothing to take back, and then it was just an answer: "have
    // you added tests?" "not yet".
    if (nope && this.onNotYet?.(nope[1]!.trim())) return;
    const w = this.waiting;
    if (!w) {
      this.typedAhead.push(text);
      return;
    }
    this.waiting = null;
    this.answer(w.entryId, text);
    // They answered, so the intern is working again.
    this.patch({ prompt: null, busy: true, status: "thinking" });
    w.resolve(text);
  }

  // -- agent side ---------------------------------------------------------

  say(text: string) {
    this.append({ kind: "say", text });
    // Too long for the six lines under dum's face: it opens on the stage, where it scrolls,
    // instead of hiding behind :log.
    if (text.length > LONG_SAY || text.split("\n").length > 6) this.patch({ stage: { kind: "reply", text } });
  }

  note(text: string) {
    this.append({ kind: "note", text });
  }

  teach(lesson: Lesson) {
    this.append({ kind: "lesson", lesson });
    this.patch({ stage: { kind: "lesson", lesson } });
  }

  quip(text: string, about: string) {
    this.append({ kind: "quip", text, about });
  }

  /** `why` says what refused it, when it wasn't the usual reason for that outcome. */
  toolEvent(name: string, detail: string, outcome: Outcome, why?: string) {
    this.append({ kind: "tool", name, detail, outcome, ...(why ? { why } : {}) });
    // The gate has now ruled on the file the pane has been watching arrive.
    const code = this.state.code;
    if (code && code.path === detail) {
      this.patch({ code: { ...code, live: false, outcome, ...(why ? { why } : {}) } });
    }
  }

  /** More of a tool call's file body has arrived. */
  streaming(tool: string, path: string, body: string) {
    const code = this.state.code;
    if (code?.live && code.tool === tool && code.body === body && code.path === path) return;
    // Writing pulls the stage back to the code: whatever you were reading, the intern putting a
    // file on screen is the more urgent thing.
    this.patch({ code: { tool, path, body, live: true, outcome: null, onDisk: false }, stage: { kind: "code" } });
  }

  /** A write the gate allowed has finished. */
  landed(path: string) {
    const code = this.state.code;
    if (!code || code.path !== path || code.outcome !== "ran" || code.onDisk) return;
    let file: string;
    try {
      file = readFileSync(`${this.state.root}/${path}`, "utf8");
    } catch {
      return;
    }
    const hit = code.body ? file.indexOf(code.body) : -1;
    const at = hit >= 0 ? file.slice(0, hit).split("\n").length - 1 : 0;
    this.patch({ code: { ...code, body: file, onDisk: true, at } });
  }

  /** Write a file you edited in the pane. */
  saveFile(path: string, text: string): string | null {
    if (!this.state.root) return "no repo to write into";
    if (isAbsolute(path) || normalize(path).startsWith("..")) return `${path} is outside ${this.state.repo}`;
    try {
      writeFileSync(`${this.state.root}/${path}`, text);
    } catch (err) {
      return (err as Error).message;
    }
    this.note(`you wrote ${path}`);
    const code = this.state.code;
    if (code && code.path === path) this.patch({ code: { ...code, body: text, onDisk: true } });
    return null;
  }

  /** Show a file that is not being written. */
  openFile(path: string, at?: number) {
    let body: string;
    let onDisk = true;
    try {
      body = readFileSync(`${this.state.root}/${path}`, "utf8");
    } catch (err) {
      body = `could not read ${path}\n${(err as Error).message}`;
      onDisk = false;
    }
    this.patch({
      code: { tool: "open", path, body, live: false, outcome: null, onDisk, ...(at !== undefined ? { at, jump: ++this.jumps } : {}) },
      stage: { kind: "code" },
    });
  }

  /** Swap the stage to the transcript and back. */
  toggleTranscript() {
    this.patch({
      stage: this.state.stage.kind === "transcript" ? { kind: "code" } : { kind: "transcript" },
    });
  }

  /** Show a question being answered, then its answer. */
  asking(question: string) {
    this.patch({ stage: { kind: "answer", question, body: "", pending: true } });
  }

  answered(question: string, body: string) {
    this.append({ kind: "answer", question, body });
    this.patch({ stage: { kind: "answer", question, body, pending: false } });
  }

  /** Something for you to read that isn't anyone speaking - help, a hint. */
  show(title: string, body: string) {
    this.patch({ stage: { kind: "info", title, body } });
  }

  /** The wizard caught something in what dum just built. */
  review(text: string) {
    this.append({ kind: "review", text });
  }

  /** The skill tree changed. */
  setSkills(skills: { known: number; shaky: number; claimed: number }) {
    this.patch({ skills });
  }

  /** One of dum's `:` commands, from the input or the file's `:` line. */
  command(name: string) {
    if (name === "run") return this.runFile();
    if (name === "graph") return this.onGraph?.();
    if (name === "log") return this.toggleTranscript();
    if (name === "help") {
      return this.show(
        "dum commands",
        [
          "!cmd      run it in a real shell. ! alone is your own shell until exit",
          "?text     ask anything, answered off to the side",
          ":run      run the file on screen (compiled languages: the line to type)",
          ":graph    the skill graph, in your browser",
          ":log      everything said so far, and back",
          "tab       input, file, file tree",
          "",
          "answering a question: your answer, idk, or type it",
          "at your turn: type it and say done, or explain it here",
          "not yet   take back the skill just checked off",
        ].join("\n"),
      );
    }
  }

  /** :run - run the file on screen. */
  runFile() {
    const path = this.state.code?.onDisk ? this.state.code.path : "";
    if (!path) return this.show(":run", "open a file first - :run runs the one on screen.");
    const how = runnerFor(path);
    if (!how) return this.show(":run", `no runner for ${path}. !<command> runs anything.`);
    if ("hint" in how) return this.show(":run", how.hint);
    this.onShell?.(how.cmd);
  }

  /** Where a milestone folder stands. */
  setProgress(progress: { done: number; total: number; unit: string } | null) {
    this.patch({ progress });
  }

  /** What "what next?" offers. */
  setSuggestion(suggestion: string) {
    if (this.state.suggestion !== suggestion) this.patch({ suggestion });
  }

  /** A hole being filled, one frame of it. */
  typing(path: string, body: string, at: number) {
    const was = this.state.code;
    const same = was?.tool === "fill" && was.path === path;
    this.patch({
      code: { tool: "fill", path, body, live: false, outcome: null, onDisk: false, at, jump: same ? was.jump : ++this.jumps },
      stage: { kind: "code" },
    });
  }

  /** A hole was filled from a skill they hold. The code goes in the record too. */
  filled(path: string, concept: string, code: string) {
    this.append({ kind: "fill", path, concept, code });
  }

  /** Which model is behind a voice. */
  setModel(who: "intern" | "wizard", model: string, effort = "") {
    const was = this.state.models[who];
    // An init with no effort must not wipe one already read back.
    const next = { model, effort: effort || (was.model === model ? was.effort : "") };
    if (was.model === next.model && was.effort === next.effort) return;
    this.patch({ models: { ...this.state.models, [who]: next } });
  }

  /** The holes left for you to type changed. */
  setTodos(todos: { concept: string; path: string }[]) {
    this.patch({ todos });
  }

  /** Ask one question and park until it is answered. */
  askQuestion(question: string, why: string, choices = false): Promise<string> {
    const id = this.append({ kind: "question", question, why, answer: null });
    return this.park({ type: "question", question, why, choices }, id);
  }

  /** The `what next` prompt between turns. Same channel, no question text. */
  askNext(): Promise<string> {
    const id = this.append({ kind: "question", question: "", why: "", answer: null });
    return this.park({ type: "next" }, id);
  }

  /** Show the spec and park until it is approved or declined. */
  async proposeSpec(spec: string): Promise<boolean> {
    const id = this.append({ kind: "spec", spec, approved: null });
    this.patch({ stage: { kind: "spec", spec } });
    const reply = (await this.park<string>({ type: "spec", spec }, id)).trim().toLowerCase();
    const approved = reply === "y" || reply === "yes";
    this.patch({ stage: { kind: "code" } });
    this.patch({
      transcript: this.state.transcript.map((e) =>
        e.id === id && e.kind === "spec" ? { ...e, approved } : e,
      ),
    });
    return approved;
  }

  // -- internals ----------------------------------------------------------

  private park<T = string>(prompt: Prompt, entryId: number): Promise<T> {
    const early = this.typedAhead.shift();
    if (early !== undefined) {
      this.answer(entryId, early);
      this.patch({ busy: false, status: "" });
      return Promise.resolve(early as T);
    }
    return new Promise<T>((resolve) => {
      this.waiting = { resolve, entryId };
      this.patch({ prompt, busy: false, status: "" });
    });
  }

  private answer(entryId: number, text: string) {
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

  /** The stage page before this one, for shift-tab. */
  private previous: Stage | null = null;

  /**
   * shift-tab: back to the page you were just on, and again to come back - alt-tab for the
   * stage.
   */
  flipStage() {
    if (this.previous) this.patch({ stage: this.previous });
  }

  /** ←/→ on the stage: file, reply, log, whichever of them exist. */
  pageStage(step: 1 | -1) {
    const pages: Stage[] = [
      ...(this.state.code ? [{ kind: "code" as const }] : []),
      ...(this.state.reply ? [this.state.reply] : []),
      { kind: "transcript" as const },
    ];
    const at = pages.findIndex((p) => (p.kind === "code" || p.kind === "transcript" ? p.kind === this.state.stage.kind : p === this.state.stage));
    this.patch({ stage: pages[(Math.max(0, at) + step + pages.length) % pages.length]! });
  }

  /** Every mutation goes through here, so the snapshot identity is the signal. */
  private patch(p: Partial<State>) {
    if (p.stage && p.stage !== this.state.stage) {
      this.previous = this.state.stage;
      if (isReply(p.stage)) p = { ...p, reply: p.stage };
    }
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn();
  }
}

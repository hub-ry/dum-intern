// The seam between the agent and whatever is drawing it.
//
// Before this existed, `session.ts` wrote to the terminal with console.log and
// read from it with a blocking readline call made from inside an MCP tool
// handler. That works exactly once: for one renderer, that owns the whole
// screen, in a process where nothing else prints. A pane layout is none of
// those things.
//
// So the agent no longer renders. It publishes state here and, where it needs
// an answer, it publishes a question and waits on a promise. Who draws that,
// and how, is not its business - which is why React must never be imported
// into `session.ts` or `wizard.ts`. Two renderers subscribe to this today (Ink
// and the plain line-printer) and neither one is visible from the agent side.

import { readFileSync } from "node:fs";
import type { Mode } from "./session.ts";
import type { Level } from "./knowledge.ts";

export type Outcome = "ran" | "held" | "refused";

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
  | { kind: "tool"; id: number; name: string; detail: string; outcome: Outcome }
  | { kind: "note"; id: number; text: string };

/** What the agent is currently blocked on, if anything. */
export type Prompt =
  | { type: "question"; question: string; why: string }
  | { type: "spec"; spec: string }
  | { type: "next" }
  | null;

/**
 * The file currently under the intern's hands.
 *
 * `live` is true while the tool call is still being generated, which is the
 * whole reason this exists: the pane shows the file being composed, and only
 * afterwards does the gate say whether it was allowed to happen. A held write
 * is therefore visible as code that almost existed, rather than as a one-line
 * denial with nothing behind it.
 */
export type CodeView = {
  tool: string;
  path: string;
  body: string;
  live: boolean;
  outcome: Outcome | null;
};

/**
 * What the wide pane is showing.
 *
 * With the chat column gone, this pane is "the thing you are meant to be
 * reading right now": the file being written, a file you opened, the spec you
 * are being asked to approve, or a lesson. The spec especially needs the room
 * - it is the one screen in this program that gates anything, and it was never
 * going to fit under a sprite.
 */
export type Stage =
  | { kind: "code" }
  | { kind: "spec"; spec: string }
  | { kind: "lesson"; lesson: Lesson }
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
  /** How much the intern trusts you here, and how far off the next step is. */
  standing: { level: Level; have: number; need: number };
};

export class Store {
  private state: State;
  private listeners = new Set<() => void>();
  private nextId = 1;

  /**
   * The promise the agent is parked on, and the entry to write the reply into.
   *
   * Only ever one. The interrogation is strictly one question at a time, and
   * two live prompts would mean the person cannot tell which one their typing
   * is about to answer.
   */
  private waiting: { resolve: (v: any) => void; entryId: number } | null = null;

  /**
   * Anything typed before the agent got around to asking.
   *
   * Without this there is a real race: the person answers, the result arrives,
   * and the keystroke lands in the gap between the prompt being cleared and
   * the next one being published. Buffering makes type-ahead work instead of
   * silently eating the line.
   */
  private typedAhead: string[] = [];

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
      standing: { level: "new", have: 0, need: 2 },
    };
  }

  // -- renderer side ------------------------------------------------------

  getSnapshot = (): State => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  /**
   * A person submitted a line.
   *
   * Routed to whatever is waiting, or held for whoever asks next. Never
   * dropped - a swallowed answer in a program built on answering questions is
   * the worst bug available to it.
   */
  submit(text: string) {
    const w = this.waiting;
    if (!w) {
      this.typedAhead.push(text);
      return;
    }
    this.waiting = null;
    this.answer(w.entryId, text);
    // They answered, so the intern is working again. Renderers key their
    // spinner off this rather than each calling site remembering to say so.
    this.patch({ prompt: null, busy: true, status: "thinking" });
    w.resolve(text);
  }

  // -- agent side ---------------------------------------------------------

  say(text: string) {
    this.append({ kind: "say", text });
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

  toolEvent(name: string, detail: string, outcome: Outcome) {
    this.append({ kind: "tool", name, detail, outcome });
    // The gate has now ruled on the file the pane has been watching arrive.
    const code = this.state.code;
    if (code && code.path === detail) {
      this.patch({ code: { ...code, live: false, outcome } });
    }
  }

  /** More of a tool call's file body has arrived. */
  streaming(tool: string, path: string, body: string) {
    const code = this.state.code;
    if (code?.live && code.tool === tool && code.body === body && code.path === path) return;
    // Writing pulls the stage back to the code: whatever you were reading, the
    // intern putting a file on screen is the more urgent thing.
    this.patch({ code: { tool, path, body, live: true, outcome: null }, stage: { kind: "code" } });
  }

  /**
   * Show a file that is not being written.
   *
   * Viewing only. Opening a file changes what YOU can see and nothing else -
   * the intern's context is what you told it, in words, and browsing the repo
   * must never quietly add to that. It sees the file LIST already; the
   * contents are yours until you explain them.
   */
  openFile(path: string) {
    let body: string;
    try {
      body = readFileSync(`${this.state.root}/${path}`, "utf8");
    } catch (err) {
      body = `could not read ${path}\n${(err as Error).message}`;
    }
    this.patch({
      code: { tool: "open", path, body, live: false, outcome: null },
      stage: { kind: "code" },
    });
  }

  /**
   * Swap the stage to the transcript and back.
   *
   * The conversation no longer has a pane of its own, so this is where "what
   * did I already say" lives. On a key rather than always-on, because the
   * point of dropping the column was to stop having two things competing to be
   * read at once.
   */
  toggleTranscript() {
    this.patch({
      stage: this.state.stage.kind === "transcript" ? { kind: "code" } : { kind: "transcript" },
    });
  }

  /** How much the intern trusts you here, recomputed whenever it changes. */
  setLevel(standing: { level: Level; have: number; need: number }) {
    this.patch({ standing });
  }

  /** Ask one question and park until it is answered. */
  askQuestion(question: string, why: string): Promise<string> {
    const id = this.append({ kind: "question", question, why, answer: null });
    return this.park({ type: "question", question, why }, id);
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

  /** Every mutation goes through here, so the snapshot identity is the signal. */
  private patch(p: Partial<State>) {
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn();
  }
}

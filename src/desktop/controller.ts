// The desktop's one conversation: a project chosen in a window instead of a terminal, with the
// same store, session, gates, evidence and memory underneath. No Electron here: whatever hosts
// it hands requests in and draws `state`.

import { randomUUID } from "node:crypto";
import { readRepo, type Repo } from "../repo.ts";
import { Store, Cancelled, parseCommand, type SharedImage, type State } from "../store.ts";
import { prepare, run, QUIT } from "../session.ts";
import type { Mode } from "../gate.ts";
import * as memory from "../memory.ts";
import * as context from "../context.ts";
import * as skills from "../skills.ts";
import * as boundary from "../boundary.ts";
import * as todos from "../todos.ts";
import * as course from "../course.ts";
import * as wizard from "../wizard.ts";
import { MODELS } from "../runtime.ts";
import { treeText } from "../tree.ts";
import { ANTI_VIBE, chooseMode } from "../prefs.ts";
import { acquire } from "../session-lock.ts";
import { view, type View } from "../web/view.ts";
import type { Panel } from "./protocol.ts";
import { SavedChangeAdvice, type AdviceOptions } from "./saved-change-advice.ts";
import { ScreenWizardAdvice, type ScreenAdviceOptions } from './screen-wizard-advice.ts';

export type { SharedImage };

/** The longest message the composer may send. Whole files go through :inspect. */
export const MAX_INPUT = 32 * 1024;
const MAX_ARGUMENT = 4096;
/** How long switching waits for the old conversation to wind down before going on regardless. The host's close request gives up at 5s, so this is shorter. */
const WIND_DOWN_MS = 4_000;

const PANELS: Record<Panel, string> = { tree: "tree", memory: "memory", history: "log", context: "context", evidence: "evidence", boundary: "boundary" };
/** The desktop's commands. `:web`, `:skill`, `:self` and `:restart` belong to the terminal. */
const COMMANDS: Record<string, true> = { inspect: true, changes: true, practice: true, submit: true, run: true, remember: true };
const TYPED: Record<string, true> = { ...COMMANDS, share: true, tree: true, skills: true, log: true, context: true, memory: true, boundary: true, evidence: true };

type WizardAdvisor = {
  readonly status: string;
  setEnabled(enabled: boolean): void;
  refresh(): void;
  interrupt(): void;
  close(): void;
  tick(): Promise<void>;
};

type Open = {
  repo: Repo;
  store: Store;
  personal: context.Context;
  advice: WizardAdvisor;
  /** Aborted to close: the run, Claude and any helper work stop. */
  stop: AbortController;
  release: () => void;
  detach: () => void;
  /** The conversation loop, settled once everything in it has stopped. */
  done: Promise<void>;
};

export class DesktopController {
  private open: Open | null = null;
  private readonly tokens = new WeakMap<object, string>();
  /** Opening, switching and closing happen one at a time, each after the last has finished. */
  private queue: Promise<void> = Promise.resolve();
  private treeView: View | null = null;
  private adviceEnabled = false;
  private adviceSource: 'screen' | 'files' = 'screen';

  constructor(
    private readonly onChange: () => void,
    private readonly options: { advice?: Omit<AdviceOptions, "blocked" | "publish" | "changed">; screen?: Omit<ScreenAdviceOptions, "blocked" | "publish" | "changed"> } = {},
  ) {}

  get state(): State | null {
    return this.open?.store.getSnapshot() ?? null;
  }

  get wizardStatus(): string {
    return this.open?.advice.status ?? (this.adviceEnabled ? "open a project for wizard advice" : "wizard advice is off");
  }

  setWizardAdvice(enabled: boolean, source: 'screen' | 'files' = 'screen'): void {
    const prevSource = this.adviceSource;
    this.adviceEnabled = enabled;
    this.adviceSource = source;
    if (this.open && source !== prevSource) {
      this.switchAdvisor();
    } else {
      this.open?.advice.setEnabled(enabled);
    }
    this.onChange();
  }

  /** One observer poll, also the clock boundary used by saved-change lifecycle tests. */
  pollWizardAdvice(): Promise<void> {
    return this.open?.advice.tick() ?? Promise.resolve();
  }

  /**
   * Names the prompt showing right now, while it takes input; "" otherwise. A message carrying
   * any other token was written for a prompt that's gone, and is refused.
   */
  get inputToken(): string {
    const store = this.open?.store;
    const prompt = store?.getSnapshot().prompt;
    if (!store || !prompt || !store.inputReady) return "";
    let token = this.tokens.get(prompt);
    if (!token) {
      token = randomUUID();
      this.tokens.set(prompt, token);
    }
    return token;
  }

  /** A picture can go only with a request at "what next", while nothing else is running. */
  get canAttach(): boolean {
    return !!this.open && this.open.store.canAttach;
  }

  /** The skill tree as the web page draws it, once asked for; refreshed as skills land. */
  get tree(): View | null {
    return this.treeView;
  }

  /**
   * Open a project, ending whatever was open first. `mode` chooses and saves the coaching mode;
   * without it, the project's saved mode stands. A project another dum holds is refused before
   * anything open is touched.
   */
  choose(root: string, personal: context.Context, mode?: Mode): Promise<void> {
    return this.serial(async () => {
      let repo: Repo;
      try {
        repo = readRepo(root);
      } catch (err) {
        const message = (err as Error).message;
        throw new Error(/^not a git repository/.test(message) ? "that folder isn't in a Git repository - dum works inside one" : message);
      }
      const same = this.open?.repo.root === repo.root;
      const release = same ? this.open!.release : acquire(repo.root, "desktop");
      try {
        if (this.open) await this.shutdown(same);
        this.start(repo, personal, mode ?? null, release);
      } catch (err) {
        release();
        throw err;
      } finally {
        this.onChange();
      }
    });
  }

  /** Their message for the prompt `inputToken` names; a picture only with a request at "what next". */
  async send(text: string, inputToken: string, image?: SharedImage): Promise<void> {
    const o = this.open;
    if (!o) throw new Error("choose a project first");
    const line = text.trim();
    if (!line) throw new Error("type something first");
    if (text.length > MAX_INPUT) throw new Error(`that's over ${MAX_INPUT} characters - save it in a file and share it with :inspect`);
    if (!inputToken || inputToken !== this.inputToken) throw new Error("that prompt closed before your message arrived - nothing was sent");
    const cmd = parseCommand(line);
    if ((cmd && !TYPED[cmd.name]) || /^:\s*(self|restart|web|skill)\b/i.test(line)) {
      throw new Error(`${line.split(/\s/)[0]} is in the terminal edition only`);
    }
    if (image) {
      if (!this.canAttach) throw new Error("a picture only goes with a request when dum asks what's next - nothing was sent");
      if (/^[:!]/.test(line) || /^not yet\b/i.test(line) || course.parseCommand(line) || QUIT.has(line.toLowerCase())) {
        throw new Error("a picture goes with a request, not a command - nothing was sent");
      }
      const prompt = o.store.getSnapshot().prompt;
      let seen: boolean;
      try {
        seen = await o.store.attach(image, line);
      } catch (err) {
        if (err instanceof Cancelled) throw new Error("stopped - your message wasn't sent");
        throw err;
      }
      if (!seen) throw new Error("dum couldn't look at the picture - your message wasn't sent. Send it again, with or without the picture");
      if (this.open !== o || o.store.getSnapshot().prompt !== prompt || !o.store.inputReady) {
        throw new Error("that prompt closed before your message was sent - the picture's description goes with your next one");
      }
    }
    o.store.submit(text);
  }

  /** One of the desktop's commands, as `:name argument` would run it. */
  command(name: string, argument = ""): void {
    const o = this.open;
    if (!o) throw new Error("choose a project first");
    if (!COMMANDS[name]) throw new Error(`:${name} isn't a desktop command`);
    if (argument.length > MAX_ARGUMENT) throw new Error("that's too long for a command");
    o.store.command(name, argument);
  }

  /** Show a panel. The tree works before any project is open: it's theirs, not the project's. */
  panel(panel: Panel): void {
    if (!Object.hasOwn(PANELS, panel)) throw new Error("there's no such panel");
    if (panel === "tree") {
      this.treeView = view(skills.read());
      if (!this.open) return this.onChange();
    }
    if (!this.open) throw new Error("choose a project first");
    this.open.store.command(PANELS[panel]);
  }

  /**
   * Stop what dum is doing. Every prompt it was waiting on is withdrawn unanswered - a plan, a
   * question, a permission, a course - and helper work in flight (a look, practice, a course
   * check, the wizard) is aborted with nothing kept. The conversation goes on from "what next".
   */
  interrupt(): void {
    const o = this.open;
    if (!o) return;
    o.advice.interrupt();
    if (o.store.onInterrupt) o.store.onInterrupt();
    else o.store.cancel();
  }

  /** End the open conversation and let the project go. */
  close(): Promise<void> {
    return this.serial(async () => {
      if (!this.open) return;
      await this.shutdown(false);
      this.onChange();
    });
  }

  // -- internals --------------------------------------------------------------

  private serial(step: () => Promise<void>): Promise<void> {
    const next = this.queue.then(step);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private start(repo: Repo, personal: context.Context, flag: Mode | null, release: () => void) {
    const { mode, changed, explain } = chooseMode(repo.root, flag);
    const store = new Store(repo.name, mode, repo.root, repo.files);
    const saved = memory.load(repo.root);
    store.restoreTranscript(saved.entries);
    // Saved from the first change on, like the terminal: answers and verdicts survive a crash.
    const stopMemory = memory.attach(repo.root, store);
    store.setModel("intern", MODELS.dum.model, MODELS.dum.effort);
    store.setModel("wizard", wizard.MODEL, wizard.EFFORT);
    const tree = skills.read();
    store.setUnlocked(tree.skills.length);
    this.treeView = view(tree);
    store.onMemory = () => memory.describe(repo.root);
    store.onRemember = (note) => store.note(`remembered: ${memory.remember(repo.root, note)}`);
    store.onContext = () => context.describe(personal);
    store.onSkills = (arg) => treeText(skills.read(), repo.root, arg);
    store.onBoundary = () => boundary.lines(boundary.boundary(skills.read(), repo.root, repo.files)).join("\n");
    let unlocked = store.getSnapshot().unlocked;
    let noteId = -1;
    const unsubscribe = store.subscribe(() => {
      const state = store.getSnapshot();
      const now = state.unlocked;
      const last = state.transcript.at(-1);
      if (now !== unlocked || (last?.kind === "note" && last.id !== noteId)) {
        this.treeView = view(skills.read());
        if (last?.kind === "note") noteId = last.id;
      }
      unlocked = now;
      this.open?.advice.refresh();
      this.onChange();
    });
    const detach = () => {
      unsubscribe();
      stopMemory();
    };
    try {
      prepare(repo, mode, store, personal);
    } catch (err) {
      detach();
      throw err;
    }

    if (saved.entries.length) store.note(`restored ${saved.entries.length} conversation entries - they're history: nothing in them is waiting for an answer`);
    if (saved.warning) store.note(saved.warning);
    if (personal.text) store.note(`personal context loaded: ${personal.path}`);
    if (personal.warning) store.note(personal.warning);
    if (changed) store.note(`mode: ${mode}, saved for this project`);
    if (mode === "anti-vibe" && !explain) store.note("anti-vibe: explanations count as recognition only; AI writes a concept once you've built it, same as understand");
    const holes = todos.load(repo.root);
    if (holes.length) {
      const list = holes.slice(0, 4).map((h) => `${h.concept} in ${h.path}`).join(", ");
      store.note(`still yours from an earlier session: ${list}${holes.length > 4 ? ` (+${holes.length - 4})` : ""}. Write it in your editor, then :submit <skill> <path> --unaided.`);
    }
    const ongoing = course.active(repo.root);
    if (ongoing) store.note(`an optional course is unfinished: ${skills.label({ name: ongoing.course.skill, lang: ongoing.course.lang })}. "course ${ongoing.course.skill} in ${ongoing.course.lang}" picks it up.`);
    if (explain) store.show("anti-vibe, tightened", `${ANTI_VIBE}\n\nSwitch this project back to understand from the mode menu.`);
    else if (!skills.read().skills.length) {
      this.treeView = view(skills.read());
      store.command("tree");
    } else if (repo.files.some((f) => skills.langOf(f))) store.command("boundary");

    const advisor = this.createAdvisor(repo.root, store);
    const o: Open = { repo, store, personal, advice: advisor, stop: new AbortController(), release, detach, done: Promise.resolve() };
    this.open = o;
    o.done = this.converse(o);
    advisor.setEnabled(this.adviceEnabled);
  }

  /**
   * Request after request until closed. A run ends when they say they're done or Claude can't
   * go on; dum then asks what's next again, so a fixed login is one message away.
   */
  private async converse(o: Open): Promise<void> {
    const { store, repo, stop } = o;
    while (!stop.signal.aborted) {
      let request: string;
      try {
        request = (await store.askNext()).trim();
      } catch (err) {
        if (err instanceof Cancelled && !err.final) continue;
        return;
      }
      if (!request) continue;
      if (QUIT.has(request.toLowerCase())) {
        store.note("dum stays beside you - quit from the menu bar when you're done");
        continue;
      }
      try {
        // Claude's own session isn't kept: this conversation lives in .dum, where they can read it.
        await run(request, repo, store.getSnapshot().mode, store, o.personal, { signal: stop.signal, persist: false, surface: "desktop" });
      } catch (err) {
        if (stop.signal.aborted) return;
        store.note(`✗ Claude couldn't start: ${(err as Error).message}. Fix that, then send your request again.`);
      }
    }
  }

  /** Everything stops and is saved; the lock goes unless the same project opens again. */
  private async shutdown(keepLock: boolean) {
    const o = this.open!;
    this.open = null;
    o.advice.close();
    o.stop.abort();
    o.store.close();
    try {
      memory.save(o.repo.root, o.store.getSnapshot().transcript);
    } catch {
      /* attach kept it as it went */
    }
    o.detach();
    // The project is let go only once the run and every helper call or slow command has ended:
    // nothing is left to record evidence or tasks against a project another window may open.
    const { promise: late, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, WIND_DOWN_MS);
    await Promise.race([Promise.all([o.done, o.store.settled()]), late]);
    clearTimeout(timer);
    if (!keepLock) o.release();
  }

  private createAdvisor(root: string, store: Store): WizardAdvisor {
    const commonBlocked = (): string | null => {
      const state = store.getSnapshot();
      if (state.prompt?.type === "course") return "wizard advice is paused for the optional course";
      if (state.prompt?.type === "question" && state.prompt.purpose === "attest") return "wizard advice is paused for your unaided evidence";
      if (state.busy || !store.canAttach) return "wizard advice is paused while dum or a command is active";
      if (course.active(root)) return "wizard advice is paused for the optional course";
      return null;
    };
    const commonPublish = (text: string) => { if (this.open?.store === store) store.quip(text); };
    if (this.adviceSource === "screen") {
      return new ScreenWizardAdvice({
        ...(this.options.screen ?? {}),
        capture: this.options.screen?.capture ?? (async () => null),
        blocked: commonBlocked,
        publish: commonPublish,
        changed: () => this.onChange(),
        check: (moment, signal) => store.helper((stop) => (this.options.screen?.check ?? wizard.screenDecision)(moment, AbortSignal.any([signal, stop]))),
      });
    }
    return new SavedChangeAdvice(root, {
      ...this.options.advice,
      blocked: commonBlocked,
      check: (moment, signal) => store.helper((stop) => (this.options.advice?.check ?? wizard.decision)(moment, AbortSignal.any([signal, stop]))),
      publish: commonPublish,
      changed: () => this.onChange(),
    });
  }

  private switchAdvisor(): void {
    const o = this.open;
    if (!o) return;
    o.advice.close();
    const advisor = this.createAdvisor(o.repo.root, o.store);
    o.advice = advisor;
    advisor.setEnabled(this.adviceEnabled);
  }

  publishQuip(text: string): void {
    this.open?.store.quip(text);
  }
}

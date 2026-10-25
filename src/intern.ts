import { redact, type Config } from "./config.ts";
import { runChat, runTask, runTeach, type AgentEvent } from "./agent.ts";
import { classify, earliestGap, refusal } from "./match.ts";
import { mockChat, mockTeach, mockWork, type Step } from "./mock.ts";
import { renderSkill, slug, words } from "./skilldoc.ts";
import { appendTerminal, type Store } from "./store.ts";
import { publicNode, type ChatMessage, type Computer, type Desktop, type PublicNode, type Teaching } from "./types.ts";
import type { Llm } from "./llm.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export type Emit = (event: string, data: unknown) => void;

export type Bundle = {
  messages: ChatMessage[];
  teaching: Teaching | null;
  nodes: PublicNode[];
  desktop: Desktop;
};

const SAVE = /^(save|unlock|yes|do it)\b/i;

export class Intern {
  private busy = false;
  private emit: Emit = () => {};

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly llm: Llm | null,
    private readonly computer: Computer | null,
  ) {}

  get isBusy(): boolean {
    return this.busy;
  }

  begin(nodeId: string, revise: boolean): Bundle {
    if (this.busy) throw new HttpError(409, "The intern is still working.");
    const node = this.store.node(nodeId);
    if (!node) throw new HttpError(404, "That skill isn't on the tree.");
    const messages: ChatMessage[] = [];
    if (node.status === "unlocked" && !revise) return this.bundle(messages);

    const gap = earliestGap(node, new Map(this.store.nodes().map((item) => [item.id, item])));
    if (node.status !== "unlocked" && gap.id !== node.id) {
      messages.push(this.say(`${node.title} waits on ${gap.title}. Teach that one first. It's ${gap.status}.`, node.id));
      return this.bundle(messages);
    }

    const teaching: Teaching = {
      nodeId: node.id,
      phase: "explain",
      explanation: "",
      questionsAsked: 0,
      pendingQuestion: null,
      organized: null,
      transcript: [],
    };
    this.store.setTeaching(teaching);
    const text = node.status === "unlocked"
      ? `We'll revise ${node.title}. Explain it again in your own words. The new note replaces the old one when you save.`
      : `I haven't learned ${node.title} yet. ${node.summary} Explain it in your own words, the way you'd tell a new teammate. What is it, and when do you use it?`;
    messages.push(this.say(text, node.id));
    return this.bundle(messages);
  }

  save(): Bundle {
    if (this.busy) throw new HttpError(409, "The intern is still working.");
    const teaching = this.store.teaching();
    if (!teaching) throw new HttpError(400, "Start a lesson before saving.");
    const node = this.store.node(teaching.nodeId);
    if (!node) throw new HttpError(404, "That skill disappeared.");
    if (teaching.phase !== "ready" || words(teaching.explanation).length < 8) {
      return this.bundle([
        this.say("Not yet. Finish the explanation and answer the question, then save.", node.id),
      ]);
    }
    const notes = renderSkill(node, teaching);
    this.store.unlock(node.id, notes);
    this.store.setTeaching(null);
    return this.bundle([
      this.say(`${node.title} is unlocked. I'll follow the note you wrote, and nothing past it.`, node.id),
    ]);
  }

  dismiss(id: string): Bundle {
    if (this.busy) throw new HttpError(409, "The intern is still working.");
    if (!this.store.dismiss(id)) throw new HttpError(400, "Only a proposed skill can be dismissed.");
    const teaching = this.store.teaching();
    if (teaching?.nodeId === id) this.store.setTeaching(null);
    return this.bundle([]);
  }

  async chat(text: string, emit: Emit): Promise<void> {
    const clean = text.trim();
    if (!clean) throw new HttpError(400, "Write a message first.");
    if (clean.length > 4000) throw new HttpError(400, "That message is too long.");
    if (this.busy) throw new HttpError(409, "The intern is still working.");
    this.busy = true;
    this.emit = emit;
    try {
      const teaching = this.store.teaching();
      this.store.addMessage({ role: "user", text: clean, nodeId: teaching?.nodeId ?? null });
      if (teaching && teaching.phase === "ready" && SAVE.test(clean)) {
        this.finishSave();
        return;
      }
      if (teaching) await this.teachTurn(teaching, clean);
      else await this.taskTurn(clean);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = redact(error instanceof Error ? error.message : "Something went wrong.", this.secrets());
      this.say(`Something went wrong. ${message}`);
    } finally {
      const desktop = this.store.desktop();
      this.store.setDesktop({ ...desktop, status: "idle", label: "idle" });
      this.desk();
      this.lesson();
      emit("done", {});
      this.emit = () => {};
      this.busy = false;
    }
  }

  private finishSave(): void {
    const teaching = this.store.teaching();
    const node = teaching ? this.store.node(teaching.nodeId) : null;
    if (!teaching || !node || words(teaching.explanation).length < 8) {
      this.say("Not yet. Tell me a little more about the skill, then save.");
      return;
    }
    this.store.unlock(node.id, renderSkill(node, teaching));
    this.store.setTeaching(null);
    this.say(`${node.title} is unlocked. I'll follow the note you wrote, and nothing past it.`, node.id);
    this.tree();
    this.lesson();
  }

  private async teachTurn(teaching: Teaching, text: string): Promise<void> {
    const node = this.store.node(teaching.nodeId);
    if (!node) {
      this.store.setTeaching(null);
      this.say("That lesson isn't on the tree anymore.");
      this.lesson();
      return;
    }
    if (this.config.mock || !this.llm) {
      const result = mockTeach(node, teaching, text);
      this.store.setTeaching(result.teaching);
      for (const reply of result.replies) this.say(reply, node.id);
      this.lesson();
      return;
    }
    const next: Teaching = { ...teaching, transcript: [...teaching.transcript, { role: "user", text }] };
    try {
      let result = await runTeach({
        node,
        transcript: next.transcript,
        questionsAsked: next.questionsAsked,
        llm: this.llm,
      });
      const said = next.transcript.filter((item) => item.role === "user").map((item) => item.text).join("\n\n");
      if (result.type === "ready" && words(said).length < 8 && next.questionsAsked < 2) {
        result = { type: "ask", question: "Say a little more. What is it, and when do you use it? I want to follow your words, not guess." };
      }
      if (!next.explanation) next.explanation = text;
      else next.explanation = `${next.explanation}\n\n${text}`;
      if (result.type === "ask") {
        next.phase = "clarify";
        next.questionsAsked += 1;
        next.pendingQuestion = result.question;
        next.transcript = [...next.transcript, { role: "intern", text: result.question }];
        this.store.setTeaching(next);
        this.say(result.question, node.id);
      } else {
        next.phase = "ready";
        next.pendingQuestion = null;
        next.organized = result.organized || null;
        this.store.setTeaching(next);
        this.say(`${result.recap}\n\nSave it and the node unlocks. I won't use it until you do.`, node.id);
      }
    } catch (error) {
      this.store.setTeaching(next);
      const message = redact(error instanceof Error ? error.message : "request failed", this.secrets());
      this.say(`I couldn't think of a question. ${message}`, node.id);
    }
    this.lesson();
  }

  private async taskTurn(text: string): Promise<void> {
    const nodes = this.store.nodes();
    const decision = classify(text, nodes);
    this.working("Planning");
    if (decision.kind === "chat") {
      const reply = await this.converse(text);
      this.say(reply);
      return;
    }
    if (decision.kind === "propose") {
      const node = this.store.propose(decision.proposal);
      this.tree();
      this.say(`Plan: this needs ${node.title}. I'm stopping before I touch the computer.`);
      this.say(refusal(node, this.store.nodes()));
      return;
    }
    if (decision.kind === "blocked") {
      this.say(`Plan: this needs ${decision.node.title}. I'm stopping before I touch the computer.`);
      this.say(refusal(decision.node, nodes, decision.also));
      return;
    }
    if (this.config.mock || !this.llm || !this.computer) {
      const steps = mockWork(text, decision.skills, this.store.nodes());
      for (let i = 0; i < steps.length; i++) {
        if (i > 0 && this.config.paceMs > 0) await sleep(this.config.paceMs);
        await this.apply(await this.onRealDesktop(steps[i]));
      }
      return;
    }
    const history = this.history();
    await runTask({
      userText: text,
      history,
      nodes: this.store.nodes(),
      allowedIds: decision.skills.map((skill) => skill.id),
      llm: this.llm,
      computer: this.computer,
      onEvent: async (event) => {
        const safe = event.type === "say" ? { ...event, text: redact(event.text, this.secrets()) } : event;
        await this.apply(safe);
      },
    });
  }

  private async converse(text: string): Promise<string> {
    if (this.config.mock || !this.llm) return mockChat(text, this.store.nodes());
    try {
      return redact(await runChat({
        userText: text,
        history: this.history(),
        nodes: this.store.nodes(),
        llm: this.llm,
      }), this.secrets());
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : "request failed", this.secrets());
      return `I couldn't reach the model. ${message}`;
    }
  }

  private history(): { role: "user" | "intern"; text: string }[] {
    return this.store.messages()
      .filter((message): message is ChatMessage & { role: "user" | "intern" } => message.role === "user" || message.role === "intern")
      .slice(0, -1)
      .slice(-12)
      .map((message) => ({ role: message.role, text: message.text }));
  }

  /** Scripted intern + live Maritime desktop: run scripted steps for real. */
  private async onRealDesktop(step: Step): Promise<Step> {
    if (!this.computer) return step;
    try {
      if (step.type === "run") {
        const result = await this.computer.run(step.command);
        const output = redact([result.stdout, result.stderr].filter(Boolean).join("\n"), this.secrets());
        return { ...step, output, error: result.exitCode !== 0 };
      }
      if (step.type === "edit") await this.computer.writeFile(step.path, step.content);
    } catch (error) {
      if (step.type === "run") {
        const message = redact(error instanceof Error ? error.message : "command failed", this.secrets());
        return { ...step, output: message, error: true };
      }
    }
    return step;
  }

  private async apply(step: Step | AgentEvent): Promise<void> {
    if (step.type === "say") {
      this.say(step.text);
      return;
    }
    if (step.type === "run") {
      const desktop = this.store.desktop();
      const output = step.output.trim() ? step.output : "(no output)";
      this.store.setDesktop(appendTerminal(
        { ...desktop, status: "working", label: "Running" },
        [
          { stream: "in", text: step.command },
          { stream: step.error ? "err" : "out", text: output },
        ],
      ));
      this.desk();
      return;
    }
    if (step.type === "edit") {
      const desktop = this.store.desktop();
      const base = step.path.split("/").pop() || step.path;
      const files = desktop.files.includes(base) ? desktop.files : [...desktop.files, base];
      this.store.setDesktop({
        ...desktop,
        editorPath: step.path,
        editorContent: step.content,
        files,
        status: "working",
        label: "Editing",
      });
      this.desk();
      return;
    }
    if (step.type === "propose") {
      const fromMock = "proposal" in step ? step.proposal : null;
      const title = fromMock?.title ?? ("title" in step ? step.title : "") ?? "";
      const summary = fromMock?.summary ?? ("summary" in step ? step.summary : "") ?? "";
      const reason = fromMock?.reason ?? ("reason" in step ? step.reason : "") ?? "";
      const prereqs = fromMock?.prereqs ?? ("prereqs" in step ? step.prereqs : []) ?? [];
      const keywords = fromMock?.keywords ?? title.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
      let id = fromMock?.id ?? slug(title);
      const clash = this.store.node(id);
      if (clash && clash.title.toLowerCase() !== title.toLowerCase()) {
        let n = 2;
        while (this.store.node(`${id}-${n}`)) n += 1;
        id = `${id}-${n}`;
      }
      if (title && summary && reason) this.store.propose({ id, title, summary, reason, prereqs, keywords });
      this.tree();
    }
  }

  private working(label: string): void {
    const desktop = this.store.desktop();
    this.store.setDesktop({ ...desktop, status: "working", label });
    this.desk();
  }

  private say(text: string, nodeId: string | null = null): ChatMessage {
    const message = this.store.addMessage({ role: "intern", text, nodeId });
    this.emit("message", { message });
    return message;
  }

  private tree(): void {
    this.emit("tree", { nodes: this.store.nodes().map(publicNode) });
  }

  private desk(): void {
    this.emit("desktop", { desktop: this.store.desktop() });
  }

  private lesson(): void {
    this.emit("teaching", { teaching: this.store.teaching() });
  }

  private bundle(messages: ChatMessage[]): Bundle {
    return {
      messages,
      teaching: this.store.teaching(),
      nodes: this.store.nodes().map(publicNode),
      desktop: this.store.desktop(),
    };
  }

  private secrets(): string[] {
    return [this.config.llm.apiKey, this.config.maritime.apiKey];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

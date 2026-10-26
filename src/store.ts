import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { seedNodes } from "./seed.ts";
import type { ChatMessage, Desktop, SkillNode, Teaching, TermLine } from "./types.ts";

const WELCOME =
  "I'm your intern. I only know what you teach me, and I only do what those notes say. Pick a locked skill and explain it in your own words. I'll ask a question or two, and when you save, that explanation becomes my instruction. Then give me a task. If it needs something locked, I'll stop and name the node.";

type NodeRow = {
  id: string;
  title: string;
  summary: string;
  prereqs: string;
  status: SkillNode["status"];
  level: SkillNode["level"];
  reason: string | null;
  keywords: string;
  clarify: string;
  sort: number;
  seed: number;
  notes: string | null;
};

export class Store {
  readonly db: DatabaseSync;
  readonly skillsDir: string;

  constructor(readonly stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.skillsDir = join(stateDir, "skills");
    mkdirSync(this.skillsDir, { recursive: true });
    this.db = new DatabaseSync(join(stateDir, "dum.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        prereqs TEXT NOT NULL,
        status TEXT NOT NULL,
        level TEXT NOT NULL,
        reason TEXT,
        keywords TEXT NOT NULL,
        clarify TEXT NOT NULL,
        sort INTEGER NOT NULL,
        seed INTEGER NOT NULL DEFAULT 0,
        notes TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        at TEXT NOT NULL,
        node_id TEXT
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.syncSeed();
    this.mirrorNotes();
    if (this.messages().length === 0) {
      this.addMessage({ role: "intern", text: WELCOME, nodeId: null });
    }
    if (!this.kv("desktop")) this.setDesktop(defaultDesktop());
  }

  close(): void {
    this.db.close();
  }

  nodes(): SkillNode[] {
    const rows = this.db.prepare(
      "SELECT id, title, summary, prereqs, status, level, reason, keywords, clarify, sort, seed, notes FROM nodes ORDER BY sort, title",
    ).all() as NodeRow[];
    return rows.map(mapNode);
  }

  node(id: string): SkillNode | null {
    const row = this.db.prepare(
      "SELECT id, title, summary, prereqs, status, level, reason, keywords, clarify, sort, seed, notes FROM nodes WHERE id = ?",
    ).get(id) as NodeRow | undefined;
    return row ? mapNode(row) : null;
  }

  messages(): ChatMessage[] {
    const rows = this.db.prepare(
      "SELECT id, role, text, at, node_id FROM messages ORDER BY rowid",
    ).all() as { id: string; role: ChatMessage["role"]; text: string; at: string; node_id: string | null }[];
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      text: row.text,
      at: row.at,
      nodeId: row.node_id,
    }));
  }

  addMessage(input: { role: ChatMessage["role"]; text: string; nodeId: string | null }): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      role: input.role,
      text: input.text,
      at: new Date().toISOString(),
      nodeId: input.nodeId,
    };
    this.db.prepare("INSERT INTO messages (id, role, text, at, node_id) VALUES (?, ?, ?, ?, ?)").run(
      message.id,
      message.role,
      message.text,
      message.at,
      message.nodeId,
    );
    this.db.prepare(`
      DELETE FROM messages WHERE rowid NOT IN (
        SELECT rowid FROM messages ORDER BY rowid DESC LIMIT 400
      )
    `).run();
    return message;
  }

  teaching(): Teaching | null {
    const raw = this.kv("teaching");
    if (!raw) return null;
    const parsed = parseJson<Teaching | null>(raw, null);
    if (!parsed?.nodeId) return null;
    return parsed;
  }

  setTeaching(teaching: Teaching | null): void {
    if (!teaching) this.delKv("teaching");
    else this.setKv("teaching", JSON.stringify(teaching));
  }

  desktop(): Desktop {
    return parseJson<Desktop>(this.kv("desktop") ?? "", defaultDesktop());
  }

  setDesktop(desktop: Desktop): void {
    const next = {
      ...desktop,
      terminal: desktop.terminal.slice(-180),
      editorContent: desktop.editorContent.slice(0, 100_000),
    };
    this.setKv("desktop", JSON.stringify(next));
  }

  computerId(): string | null {
    return this.kv("computerId");
  }

  setComputerId(id: string | null): void {
    if (!id) this.delKv("computerId");
    else this.setKv("computerId", id);
  }

  unlock(id: string, notes: string): SkillNode {
    const node = this.require(id);
    this.db.prepare("UPDATE nodes SET status = 'unlocked', notes = ?, reason = NULL WHERE id = ?").run(notes, id);
    this.writeNotes(id, notes);
    return { ...node, status: "unlocked", notes, reason: null };
  }

  propose(input: {
    id: string;
    title: string;
    summary: string;
    reason: string;
    prereqs: string[];
    keywords: string[];
  }): SkillNode {
    const byTitle = this.nodes().find((node) => node.title.toLowerCase() === input.title.toLowerCase());
    const existing = this.node(input.id) ?? byTitle;
    if (existing) return existing;
    const known = new Set(this.nodes().map((node) => node.id));
    const prereqs = input.prereqs.filter((id) => known.has(id));
    const sort = (this.db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM nodes").get() as { n: number }).n;
    const node: SkillNode = {
      id: input.id,
      title: input.title.trim().slice(0, 80),
      summary: input.summary.trim().slice(0, 240),
      prereqs,
      status: "proposed",
      level: "intermediate",
      reason: input.reason.trim().slice(0, 400),
      keywords: input.keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean).slice(0, 12),
      clarify: "What should I do, step by step, when I hit this? Give me one example I can copy.",
      sort,
      seed: false,
      notes: null,
    };
    this.insertNode(node);
    return node;
  }

  dismiss(id: string): boolean {
    const node = this.node(id);
    if (!node || node.seed || node.status !== "proposed") return false;
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
    return true;
  }

  skillFile(id: string): string | null {
    const node = this.node(id);
    if (!node?.notes) return null;
    this.writeNotes(id, node.notes);
    return node.notes;
  }

  exportZipFiles(): { name: string; data: Buffer }[] {
    return this.nodes()
      .filter((node) => node.notes)
      .map((node) => ({ name: `${node.id}.md`, data: Buffer.from(node.notes ?? "", "utf8") }));
  }

  reset(): void {
    this.db.exec("DELETE FROM nodes; DELETE FROM messages; DELETE FROM kv;");
    rmSync(this.skillsDir, { recursive: true, force: true });
    mkdirSync(this.skillsDir, { recursive: true });
    this.syncSeed();
    this.addMessage({ role: "intern", text: WELCOME, nodeId: null });
    this.setDesktop(defaultDesktop());
  }

  private require(id: string): SkillNode {
    const node = this.node(id);
    if (!node) throw new Error(`Unknown skill ${id}.`);
    return node;
  }

  private syncSeed(): void {
    const have = new Set(this.nodes().map((node) => node.id));
    for (const node of seedNodes()) {
      if (!have.has(node.id)) {
        this.insertNode(node);
        continue;
      }
      this.db.prepare(`
        UPDATE nodes
        SET title = ?, summary = ?, prereqs = ?, level = ?, keywords = ?, clarify = ?, sort = ?, seed = 1
        WHERE id = ? AND seed = 1
      `).run(
        node.title,
        node.summary,
        JSON.stringify(node.prereqs),
        node.level,
        JSON.stringify(node.keywords),
        node.clarify,
        node.sort,
        node.id,
      );
    }
  }

  private insertNode(node: SkillNode): void {
    this.db.prepare(`
      INSERT INTO nodes (id, title, summary, prereqs, status, level, reason, keywords, clarify, sort, seed, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      node.id,
      node.title,
      node.summary,
      JSON.stringify(node.prereqs),
      node.status,
      node.level,
      node.reason,
      JSON.stringify(node.keywords),
      node.clarify,
      node.sort,
      node.seed ? 1 : 0,
      node.notes,
    );
  }

  private mirrorNotes(): void {
    for (const node of this.nodes()) {
      if (node.notes) this.writeNotes(node.id, node.notes);
    }
  }

  private writeNotes(id: string, notes: string): void {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) return;
    writeFileSync(join(this.skillsDir, `${id}.md`), notes, "utf8");
  }

  private kv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setKv(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private delKv(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }
}

export function defaultDesktop(): Desktop {
  return {
    editorPath: "/home/desk/notes.txt",
    editorContent: "This desktop belongs to the intern.\nNothing has been run yet.\n",
    terminal: [{ stream: "out", text: "Ready. The intern has not run anything yet." }],
    status: "idle",
    files: ["notes.txt"],
    label: "idle",
  };
}

export function appendTerminal(desktop: Desktop, lines: TermLine[]): Desktop {
  return { ...desktop, terminal: [...desktop.terminal, ...lines].slice(-180) };
}

function mapNode(row: NodeRow): SkillNode {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    prereqs: parseJson<string[]>(row.prereqs, []),
    status: row.status,
    level: row.level,
    reason: row.reason,
    keywords: parseJson<string[]>(row.keywords, []),
    clarify: row.clarify,
    sort: row.sort,
    seed: row.seed === 1,
    notes: row.notes,
  };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

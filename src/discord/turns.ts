// Durable chat turns. Every message Ryan sends Dum becomes a turn on disk, run as its own systemd
// user unit, outside the bot's process. Turns run side by side, even in the same channel, and each
// answers its own message. A bot restart, including one Dum's engineer schedules after changing
// Dum's own code, never kills a turn: the bot finds them again on start and delivers their answers.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type TurnStatus = "queued" | "running";

export type Turn = {
  schemaVersion: 1;
  id: string;
  /** The channel (or thread) the message came from. Replies go here, and its conversation carries on. */
  conversation: string;
  /** Ryan's message, replied to when it lives in the conversation itself. */
  messageId: string;
  replyInline: boolean;
  goalId: string | null;
  author: string;
  createdAt: string;
  status: TurnStatus;
  startedAt?: string;
  /** Whether this is already the fresh-session retry of a turn whose resume failed. */
  retried: boolean;
  resume: string | null;
};

const TURN_ID = /^[0-9a-f-]{36}$/;
const MAX_TURN_SECONDS = 30 * 60;

export function turnDir(root: string, id: string): string {
  if (!TURN_ID.test(id)) throw new Error(`bad turn id ${id}`);
  return join(root, id);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 1), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** Records a new turn, queued. Ryan's words go in a private file for the verbatim check. */
export function queueTurn(root: string, input: Omit<Turn, "schemaVersion" | "id" | "createdAt" | "status" | "retried" | "resume"> & { text: string }, now = new Date()): Turn {
  const turn: Turn = {
    schemaVersion: 1,
    id: randomUUID(),
    conversation: input.conversation,
    messageId: input.messageId,
    replyInline: input.replyInline,
    goalId: input.goalId,
    author: input.author,
    createdAt: now.toISOString(),
    status: "queued",
    retried: false,
    resume: null,
  };
  const dir = turnDir(root, turn.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "source.txt"), input.text, { mode: 0o600 });
  writeJson(join(dir, "turn.json"), turn);
  return turn;
}

export function readTurn(root: string, id: string): Turn | null {
  try {
    return JSON.parse(readFileSync(join(turnDir(root, id), "turn.json"), "utf8")) as Turn;
  } catch {
    return null;
  }
}

export function saveTurn(root: string, turn: Turn): void {
  writeJson(join(turnDir(root, turn.id), "turn.json"), turn);
}

export function listTurns(root: string): Turn[] {
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => TURN_ID.test(n))
    .map((n) => readTurn(root, n))
    .filter((t): t is Turn => !!t)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function sourceText(root: string, id: string): string {
  return readFileSync(join(turnDir(root, id), "source.txt"), "utf8");
}

/** Which queued turns may start now: the oldest ones, up to the parallel limit. */
export function startable(turns: Turn[], limit: number): Turn[] {
  const room = limit - turns.filter((t) => t.status === "running").length;
  return room > 0 ? turns.filter((t) => t.status === "queued").slice(0, room) : [];
}

export function unitName(id: string): string {
  return `dum-turn-${id.slice(0, 8)}`;
}

/**
 * Starts a turn as its own systemd user unit. The command's events stream to out.jsonl and its
 * exit code lands in `exit` when it ends, however long the bot is away.
 */
export async function launch(root: string, turn: Turn, command: { bin: string; args: string[]; cwd: string; env: Record<string, string> }): Promise<void> {
  const dir = turnDir(root, turn.id);
  for (const f of ["out.jsonl", "err.log", "exit"]) rmSync(join(dir, f), { force: true });
  const script = `timeout ${MAX_TURN_SECONDS} "$0" "$@" > "$TURN_DIR/out.jsonl" 2> "$TURN_DIR/err.log"; echo $? > "$TURN_DIR/exit.tmp"; mv "$TURN_DIR/exit.tmp" "$TURN_DIR/exit"`;
  const setenv = Object.entries({ ...command.env, TURN_DIR: dir }).flatMap(([k, v]) => [`--setenv=${k}=${v}`]);
  const args = ["--user", `--unit=${unitName(turn.id)}`, "--collect", "--quiet", `--working-directory=${command.cwd}`, ...setenv, "--", "/bin/sh", "-c", script, command.bin, ...command.args];
  await new Promise<void>((resolve, reject) => execFile("systemd-run", args, (err) => (err ? reject(err) : resolve())));
}

/** A finished turn's exit code and event stream, or null while it's still running. */
export function finished(root: string, id: string): { code: number; stdout: string; stderr: string } | null {
  const dir = turnDir(root, id);
  if (!existsSync(join(dir, "exit"))) return null;
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return { code: Number(read("exit").trim() || "1"), stdout: read("out.jsonl"), stderr: read("err.log").slice(-4000) };
}

export function removeTurn(root: string, id: string): void {
  rmSync(turnDir(root, id), { recursive: true, force: true });
}

/** A Discord thread name from Ryan's message. */
export function threadName(text: string): string {
  const flat = text.replace(/<[@#!&]?\d+>/g, "").replace(/\s+/g, " ").trim();
  if (!flat) return "chat with dum";
  return flat.length <= 90 ? flat : flat.slice(0, 89).replace(/\s+\S*$/, "") + "…";
}

/** Whether a turn's unit is still alive. A dead unit with no exit file died without a word. */
export function alive(id: string): Promise<boolean> {
  return new Promise((resolve) =>
    execFile("systemctl", ["--user", "is-active", "--quiet", `${unitName(id)}.service`], (err) => resolve(!err)),
  );
}

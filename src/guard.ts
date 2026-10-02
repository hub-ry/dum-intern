// The shell's way around the gate, closed. Write and Edit are checked before they run; a shell
// command can't be, since nobody can tell from `python gen.py` what it will write. So source
// files are snapshotted before every command and put back after it if it changed them.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gated } from "./todos.ts";

/** What a source file held before a command, or null if it didn't exist. */
export type Snapshot = Map<string, string | null>;

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  } catch {
    return "";
  }
}

/** Source files git sees as changed or new, relative to the repo root. */
export function changed(root: string): string[] {
  const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const paths: string[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // A rename lists its old path next; that one changed too.
    if (code[0] === "R" || code[0] === "C") paths.push(parts[++i] ?? "");
  }
  return paths.filter((p) => p && gated(p));
}

function read(root: string, path: string): string | null {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch {
    return null;
  }
}

/** The committed version of a file, or null if it isn't in HEAD. */
function committed(root: string, path: string): string | null {
  const ls = git(root, ["ls-tree", "--name-only", "HEAD", "--", path]);
  return ls.trim() ? git(root, ["show", `HEAD:${path}`]) : null;
}

/** Before a command: what every changed source file holds now. Clean ones are in HEAD already. */
export function snapshot(root: string): Snapshot {
  return new Map(changed(root).map((p) => [p, read(root, p)]));
}

/**
 * After a command: put back every source file it changed, created or deleted. Returns what was
 * put back, empty when the command left source alone.
 */
export function restore(root: string, before: Snapshot, theirs: ReadonlySet<string> = new Set()): string[] {
  const touched = new Set([...before.keys(), ...changed(root)]);
  const undone: string[] = [];
  for (const path of touched) {
    // Saved by them while the command ran: their edit, not the command's.
    if (theirs.has(path)) continue;
    const want = before.has(path) ? before.get(path)! : committed(root, path);
    const now = read(root, path);
    if (now === want) continue;
    const file = resolve(root, path);
    try {
      if (want === null) unlinkSync(file);
      else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, want);
      }
      undone.push(path);
    } catch {
      /* left as it is; the intern is still told it was out of bounds */
      undone.push(path);
    }
  }
  return undone.sort();
}

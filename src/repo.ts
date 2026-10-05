// What the intern knows about where it is: the project's name and its file list. File contents
// (README included) are only read when someone asks for them.

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { Workspace } from "./workspace.ts";

const MAX_FILES = 200;

export type Repo = { name: string; root: string; files: string[] };

export function readRepo(cwd: string): Repo {
  let root: string;
  try {
    // Capture git's stderr rather than letting it inherit - outside a repo it prints its own
    // "fatal:" line above ours, and two errors for one problem reads as a crash.
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error("not a git repository - dum works inside one. `git init` here, or cd into a repo");
  }
  // Tracked and untracked alike, minus ignored, credential-like, internal and escaping paths.
  const ws = new Workspace(root);
  return { name: basename(ws.root), root: ws.root, files: ws.list() };
}

/** The repo as the model sees it. */
export function describe(repo: Repo): string {
  const shown = repo.files.slice(0, MAX_FILES);
  const elided = repo.files.length - shown.length;
  return [
    `repository: ${repo.name}`,
    `\n--- FILES ---\n${shown.join("\n")}`,
    elided > 0 && `\n...and ${elided} more files`,
    "\nFile contents aren't included: read the files you need.",
  ]
    .filter(Boolean)
    .join("\n");
}

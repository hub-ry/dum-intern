// What the intern knows about where it is.
//
// Deliberately shallow: a file listing and the README. The intern is not
// supposed to read the whole codebase before asking you what you want - it is
// supposed to ask you what you want. Deep context is the coding agent's job,
// and that runs after the spec exists.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const MAX_FILES = 200;
const README_CHARS = 2000;

export type Repo = { name: string; root: string; files: string[]; readme: string };

function git(args: string[], cwd: string): string {
  // Capture git's stderr rather than letting it inherit - outside a repo it
  // prints its own "fatal:" line above ours, and two errors for one problem
  // reads as a crash.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function readRepo(cwd: string): Repo {
  let root: string;
  try {
    root = git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new Error("not a git repository - dum-intern works inside a repo");
  }

  // Tracked files only. Untracked build output and node_modules would drown
  // the signal, and .gitignore is the list of what you already decided doesn't
  // matter.
  const files = git(["ls-files"], root).split("\n").filter(Boolean);

  let readme = "";
  for (const name of ["README.md", "readme.md", "README"]) {
    try {
      readme = readFileSync(`${root}/${name}`, "utf8").slice(0, README_CHARS);
      break;
    } catch {
      // no README is fine - most repos worth using this on are half-built
    }
  }

  return { name: basename(root), root, files, readme };
}

/** The repo as the model sees it. */
export function describe(repo: Repo): string {
  const shown = repo.files.slice(0, MAX_FILES);
  const elided = repo.files.length - shown.length;
  return [
    `repository: ${repo.name}`,
    repo.readme && `\n--- README (truncated) ---\n${repo.readme}`,
    `\n--- FILES ---\n${shown.join("\n")}`,
    elided > 0 && `\n...and ${elided} more files`,
  ]
    .filter(Boolean)
    .join("\n");
}

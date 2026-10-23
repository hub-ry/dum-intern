// Local helper for a paper's LaTeX. The Dum server does not call this.
// Papers are written and compiled by the dum-paper Cursor skill, on the
// person's machine. Hub only serves a PDF that is already in the folder.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Goal, Skill } from "./model.ts";

export function texEscape(value: string): string {
  return value.replace(/[\\{}$&#%_~^]/g, (ch) => {
    if (ch === "\\") return "\\textbackslash{}";
    if (ch === "~") return "\\textasciitilde{}";
    if (ch === "^") return "\\textasciicircum{}";
    return `\\${ch}`;
  });
}

export function assignmentTex(goal: Goal, skill: Skill, parent: Skill | null): string {
  const title = texEscape(skill.title);
  const goalTitle = texEscape(goal.title);
  const aim = texEscape(goal.aim.trim());
  const summary = texEscape(skill.summary.trim());
  const sits = parent
    ? `It sits under \\code{${texEscape(parent.title)}}. You can read this before that one. The tree only suggests an order.`
    : `It is a root of the tree for \\code{${goalTitle}}.`;
  return `\\documentclass[11pt]{article}
\\usepackage{learn}
\\title{${title}}
\\author{${goalTitle}}
\\date{}
\\begin{document}
\\maketitle

This reading is the block \\code{${title}} in the goal \\code{${goalTitle}}.

${aim}

${summary}

${sits} The block unlocks when you reach the last page. There is nothing to hand in. If you already know how to do this, swear it from the tree and skip the reading.

\\section{The move}

Name the inputs. Do one step. Check the output against a case you can compute by hand. That is the whole move for this block.

\\begin{lstlisting}[style=py]
def step(items):
    kept = []
    for item in items:
        if keep(item):
            kept.append(item)
    return kept

def keep(item):
    return item > 0

print(step([3, -1, 0, 8]))  # [3, 8]
\\end{lstlisting}

\\underneath{The loop visits each item once, so this is linear in the length of the list. The check itself is the block. The list is just how the examples stay small enough to read.}

\\begin{keypoint}
A block is one move you can point at. If a step needs a second idea, that idea is a different block, stacked later.
\\end{keypoint}

\\section{A case you can check}

Take the goal at its word. \\code{${goalTitle}} says: ${aim}

Run the move on four values, \\code{[3, -1, 0, 8]}.

\\begin{enumerate}
\\item \\code{3} is kept. The list is \\code{[3]}.
\\item \\code{-1} is dropped. The list stays \\code{[3]}.
\\item \\code{0} is dropped. The test was strict: greater than zero.
\\item \\code{8} is kept. The list is \\code{[3, 8]}.
\\end{enumerate}

Write those four lines down without looking at the code, then look back. If they match, you have read the block.

\\begin{lstlisting}[style=py]
assert step([3, -1, 0, 8]) == [3, 8]
assert step([]) == []
assert step([-2, -5]) == []
\\end{lstlisting}

The empty list is the case people skip. The loop body runs zero times, so the result is an empty list, not an error.

\\begin{why}
What does this block refuse to do? Name one thing that belongs in a later block, not in this one.
\\end{why}

When this page is the last page, the block is unlocked. You can stack it with other unlocked blocks when you build.
\\end{document}
`;
}

export async function writeAssignment(workspace: string, goal: Goal, skill: Skill, parent: Skill | null): Promise<string> {
  const texPath = join(workspace, skill.reading);
  await mkdir(dirname(texPath), { recursive: true, mode: 0o700 });
  await writeFile(texPath, assignmentTex(goal, skill, parent), { mode: 0o600 });
  return texPath;
}

export function pdfPathFor(workspace: string, skill: Skill): string {
  return join(workspace, "readings", "pdf", `${skill.id}.pdf`);
}

export async function compileAssignment(workspace: string, skill: Skill): Promise<{ pdf: string; pages: number }> {
  const texPath = join(workspace, skill.reading);
  const outDir = join(workspace, "readings", "pdf");
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const sty = await readFile(join(workspace, "learn.sty"));
  await writeFile(join(workspace, "readings", "learn.sty"), sty);
  await runTectonic(workspace, texPath, outDir);
  const pdf = pdfPathFor(workspace, skill);
  const pages = await pageCount(pdf);
  return { pdf, pages };
}

function runTectonic(cwd: string, texPath: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tectonic", ["--outdir", outDir, texPath], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("tectonic timed out"));
    }, 120_000);
    child.stderr.on("data", (buf: Buffer) => {
      err += buf.toString("utf8");
      if (err.length > 8000) err = err.slice(-8000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `tectonic exited ${code}`));
    });
  });
}

async function pageCount(pdf: string): Promise<number> {
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn("pdfinfo", [pdf], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (buf: Buffer) => { out += buf.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error("pdfinfo failed"))));
  });
  const match = text.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new Error("pdfinfo did not report a page count");
  return Number(match[1]);
}

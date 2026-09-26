// A real shell, a keystroke away.
//
// Learning to build something includes learning to run it, and the panes made
// that awkward: compiling meant leaving dum. So `!cmd` runs a command the way
// vim's `:!` and Claude Code's `!` do - the panes step aside, the program gets
// the terminal (input too, so interactive programs work), and Enter brings you
// back. A bare `!` is your own shell until you `exit`.
//
// What runs here is yours. The intern isn't told and doesn't see the output,
// same rule as the file pane: nothing quietly feeds its context.
//
// :run runs the open file, for languages where running is one obvious
// command. Compiled ones don't get that: typing the compiler line yourself is
// part of learning the language, so dum shows you the line instead.

import { spawn } from "node:child_process";
import { basename, extname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { constants } from "node:os";

const RUN: Record<string, (f: string) => string> = {
  ".py": (f) => `python3 ${q(f)}`,
  ".js": (f) => `node ${q(f)}`,
  ".mjs": (f) => `node ${q(f)}`,
  ".cjs": (f) => `node ${q(f)}`,
  ".ts": (f) => `npx tsx ${q(f)}`,
  ".sh": (f) => `bash ${q(f)}`,
  ".rb": (f) => `ruby ${q(f)}`,
  ".lua": (f) => `lua ${q(f)}`,
  ".php": (f) => `php ${q(f)}`,
  ".pl": (f) => `perl ${q(f)}`,
  ".go": (f) => `go run ${q(f)}`,
};

/** The compile line to type yourself, for languages where that's the lesson. */
const COMPILE: Record<string, (f: string, out: string) => string> = {
  ".c": (f, o) => `gcc -Wall -o ${o} ${q(f)} && ./${o}`,
  ".cpp": (f, o) => `g++ -std=c++17 -Wall -o ${o} ${q(f)} && ./${o}`,
  ".cc": (f, o) => `g++ -std=c++17 -Wall -o ${o} ${q(f)} && ./${o}`,
  ".cxx": (f, o) => `g++ -std=c++17 -Wall -o ${o} ${q(f)} && ./${o}`,
  ".rs": (f, o) => `rustc -o ${o} ${q(f)} && ./${o}`,
  ".java": (f) => `java ${q(f)}`,
  ".swift": (f, o) => `swiftc -o ${o} ${q(f)} && ./${o}`,
  ".zig": (f) => `zig run ${q(f)}`,
};

const q = (s: string) => (/^[\w./+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** How :run runs a file: a command, or the line to type yourself and why. */
export function runnerFor(path: string): { cmd: string } | { hint: string } | null {
  const ext = extname(path).toLowerCase();
  const run = RUN[ext];
  if (run) return { cmd: run(path) };
  const compile = COMPILE[ext];
  if (compile) {
    const out = basename(path, ext) || "a.out";
    return { hint: `compile it yourself - that's part of learning it:\n\n!${compile(path, out)}` };
  }
  return null;
}

/**
 * Run a command with the terminal handed over, and wait for Enter after.
 *
 * Async, not spawnSync: the intern may still be working, and it keeps
 * publishing to the store while the panes are away. SIGINT is ignored here
 * while the child runs - ctrl-c belongs to the program, and without a
 * listener Node would take the whole of dum down with it.
 */
export async function run(cmd: string, cwd: string, wait = true): Promise<number> {
  const shell = process.env.SHELL || "/bin/sh";
  const args = cmd.trim() ? ["-c", cmd] : ["-i"];
  const ignore = () => {};
  process.on("SIGINT", ignore);
  // The child reads the terminal directly. Anything of ours still reading
  // stdin would race it for keystrokes, so ours stops until it's done.
  const flowing = !stdin.isPaused();
  stdin.pause();
  stdout.write("\x1b[?25h");
  stdout.write(cmd.trim() ? `\x1b[2m$ ${cmd}\x1b[0m\n` : `\x1b[2m${shell} - exit to go back to dum\x1b[0m\n`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(shell, args, { cwd, stdio: "inherit" });
    // 128 + the signal, the way every shell reports it: ctrl-c is 130.
    child.on("exit", (c, sig) => resolve(c ?? (sig ? 128 + (constants.signals[sig] ?? 0) : 1)));
    child.on("error", () => resolve(127));
  });
  process.off("SIGINT", ignore);
  if (cmd.trim() && wait) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      await rl.question(`\n\x1b[2m[exit ${code}] enter to go back to dum\x1b[0m `);
    } catch {
      /* input closed: go back anyway */
    } finally {
      rl.close();
    }
  }
  if (flowing) stdin.resume();
  return code;
}

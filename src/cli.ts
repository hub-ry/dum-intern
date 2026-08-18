// The environment you drop into.
//
// One intern. You say what you want, it asks what it needs, and you either
// answer or call the wizard. Nothing gets built until the spec exists.

import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit, cwd } from "node:process";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readRepo } from "./repo.ts";
import { interrogate, wizard, sharpen, type Question } from "./intern.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[38;5;179m${s}\x1b[0m`,
  green: (s: string) => `\x1b[38;5;108m${s}\x1b[0m`,
  red: (s: string) => `\x1b[38;5;167m${s}\x1b[0m`,
};

const WIZARD_KEYS = new Set(["?", "wizard", "idk", "i don't know", "i dont know"]);

/**
 * Something to look at while the CLI takes its time.
 *
 * Animation only at a real terminal: `\r` does not erase anything in a pipe or
 * a log file, so every frame would survive and the transcript would be a wall
 * of braille. Piped runs get one static line instead.
 */
function spinner(label: string) {
  if (!stdout.isTTY) {
    console.log(`  ${c.dim(`${label}...`)}`);
    return () => {};
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    stdout.write(`\r  ${c.amber(frames[i++ % frames.length])} ${c.dim(label)}`);
  }, 80);
  return () => {
    clearInterval(timer);
    stdout.write(`\r${" ".repeat(label.length + 6)}\r`);
  };
}

function run<T>(label: string, fn: () => T): T {
  const stop = spinner(label);
  try {
    return fn();
  } finally {
    stop();
  }
}

function banner(repo: string) {
  console.log();
  console.log(`  ${c.amber("▛▚▘")} ${c.bold("dum-intern")}  ${c.dim(repo)}`);
  console.log(`  ${c.dim("one intern. it builds what you can explain.")}`);
  console.log();
}

function wrap(text: string, indent = "    "): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > 74) {
      lines.push(line.trim());
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l) => indent + l).join("\n");
}

function showLesson(l: ReturnType<typeof wizard>) {
  console.log();
  console.log(`  ${c.amber("╭─ wizard ")}${c.amber("─".repeat(58))}`);
  console.log(`  ${c.amber("│")}`);
  console.log(`  ${c.amber("│")}  ${c.bold(l.concept)}`);
  console.log(`  ${c.amber("│")}`);
  for (const [heading, body] of [
    ["what it is", l.what_it_is],
    ["why it exists", l.why_it_exists],
    ["in industry", l.in_industry],
    ["here", l.here],
  ] as const) {
    console.log(`  ${c.amber("│")}  ${c.dim(heading)}`);
    for (const line of wrap(body, "").split("\n")) {
      console.log(`  ${c.amber("│")}    ${line}`);
    }
    console.log(`  ${c.amber("│")}`);
  }
  console.log(`  ${c.amber("╰")}${c.amber("─".repeat(67))}`);
  console.log();
}

async function main() {
  const repo = readRepo(cwd());
  banner(repo.name);

  // Two input modes, because they fail differently.
  //
  // At a terminal, a closed stdin means you walked away, and the session must
  // die rather than build something half-specified - so race every prompt
  // against the close event.
  //
  // Through a pipe, EOF arrives the instant the data is buffered, long before
  // the lines are read. Racing there kills a session whose answers are all
  // sitting in memory. So drain stdin up front and serve from the queue; an
  // empty queue is the same failure, just detected honestly.
  const piped: string[] | null = stdin.isTTY ? null : readFileSync(0, "utf8").split("\n");
  while (piped && piped.length > 0 && piped[piped.length - 1] === "") piped.pop();

  // Only attach readline at a terminal - it would fight the drain above.
  const rl = piped ? null : createInterface({ input: stdin, output: stdout });

  const askUser = async (q: string): Promise<string> => {
    if (piped) {
      if (piped.length === 0) throw new Error("input ended - nothing was built");
      const line = piped.shift()!;
      stdout.write(q + line + "\n");
      return line;
    }
    return Promise.race([
      rl!.question(q),
      new Promise<never>((_, reject) =>
        rl!.once("close", () => reject(new Error("input ended - nothing was built"))),
      ),
    ]);
  };

  try {
    const request = (argv.slice(2).join(" ") || (await askUser(`  ${c.bold("what do you want?")}\n  ${c.dim(">")} `))).trim();
    if (!request) {
      console.log(c.dim("  nothing to do."));
      return;
    }
    console.log();

    const questions = run("the intern is reading the repo", () => interrogate(request, repo));

    const answered: { question: string; answer: string }[] = [];
    if (questions.length === 0) {
      console.log(`  ${c.dim("no questions - this one is clear enough.")}`);
      console.log();
    } else {
      console.log(
        `  ${c.dim(`${questions.length} question${questions.length > 1 ? "s" : ""}. answer, or type`)} ${c.amber("?")} ${c.dim("to call the wizard.")}`,
      );
      console.log();

      for (const [i, q] of questions.entries()) {
        const label = c.dim(`${i + 1}/${questions.length}`);
        // Loop rather than ask once: calling the wizard must not consume your
        // turn, or the tool punishes you for admitting you don't know something.
        for (;;) {
          console.log(`  ${label}  ${c.bold(q.question)}`);
          console.log(`        ${c.dim(q.why_it_matters)}`);
          const answer = (await askUser(`  ${c.dim(">")} `)).trim();

          if (WIZARD_KEYS.has(answer.toLowerCase())) {
            const lesson = run("the wizard is thinking", () => wizard(q, request, repo));
            showLesson(lesson);
            continue;
          }
          if (!answer) {
            console.log(`  ${c.dim("(blank - the intern needs an answer, or a")} ${c.amber("?")}${c.dim(")")}`);
            console.log();
            continue;
          }
          answered.push({ question: q.question, answer });
          console.log();
          break;
        }
      }
    }

    const spec = run("writing the spec", () => sharpen(request, answered, repo));
    console.log(`  ${c.green("╭─ spec ")}${c.green("─".repeat(60))}`);
    for (const line of spec.split("\n")) console.log(`  ${c.green("│")}  ${line}`);
    console.log(`  ${c.green("╰")}${c.green("─".repeat(67))}`);
    console.log();

    const go = (await askUser(`  ${c.bold("hand this to the intern?")} ${c.dim("[y/N]")} `)).trim().toLowerCase();
    rl?.close();

    if (go !== "y" && go !== "yes") {
      console.log(`  ${c.dim("stopped. nothing was built.")}`);
      return;
    }

    console.log(`  ${c.dim("handing off...")}\n`);
    const result = spawnSync("claude", [spec], { stdio: "inherit" });
    exit(result.status ?? 1);
  } finally {
    rl?.close();
  }
}

main().catch((err: Error) => {
  console.error(`\n  ${c.red("✗")} ${err.message}\n`);
  exit(1);
});

// The environment you drop into.

import { argv, exit, cwd } from "node:process";
import { readRepo } from "./repo.ts";
import { run, type Mode } from "./session.ts";
import { banner, c, Input } from "./ui.ts";

function parse(args: string[]): { mode: Mode; request: string } {
  // anti-vibe is the default on purpose: a tool that fights you over trivia is
  // a tool you turn off, and then it protects nothing. `understand` is the mode
  // you reach for when learning is the point.
  let mode: Mode = "anti-vibe";
  const rest: string[] = [];
  for (const a of args) {
    if (a === "--understand" || a === "-u") mode = "understand";
    else if (a === "--anti-vibe" || a === "-a") mode = "anti-vibe";
    else rest.push(a);
  }
  return { mode, request: rest.join(" ").trim() };
}

async function main() {
  const { mode, request: fromArgs } = parse(argv.slice(2));
  const repo = readRepo(cwd());
  banner(repo.name, mode);

  const input = new Input();
  try {
    const request =
      fromArgs || (await input.ask(`  ${c.bold("what do you want?")}\n  ${c.dim(">")} `)).trim();
    if (!request) {
      console.log(`  ${c.dim("nothing to do.")}\n`);
      return;
    }
    console.log();
    await run(request, repo, mode, input);
  } finally {
    input.close();
  }
}

main().catch((err: Error) => {
  console.error(`\n  ${c.red("✗")} ${err.message}\n`);
  exit(1);
});

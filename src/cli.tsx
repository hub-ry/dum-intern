// The environment you drop into.

import { argv, exit, cwd, stdout, stdin } from "node:process";
import { readRepo } from "./repo.ts";
import { run, type Mode } from "./session.ts";
import { Store } from "./store.ts";
import { banner, runPlain, Input } from "./plain.ts";
import { read as readLayout, type Node as LayoutNode } from "./layout.ts";

function parse(args: string[]): { mode: Mode; plain: boolean; request: string } {
  // anti-vibe is the default on purpose: a tool that fights you over trivia is
  // a tool you turn off, and then it protects nothing. `understand` is the mode
  // you reach for when learning is the point.
  let mode: Mode = "anti-vibe";
  let plain = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a === "--understand" || a === "-u") mode = "understand";
    else if (a === "--anti-vibe" || a === "-a") mode = "anti-vibe";
    else if (a === "--plain" || a === "-p") plain = true;
    else rest.push(a);
  }
  return { mode, plain, request: rest.join(" ").trim() };
}

async function main() {
  const { mode, plain, request: fromArgs } = parse(argv.slice(2));
  const repo = readRepo(cwd());
  const store = new Store(repo.name, mode, repo.root, repo.files);

  // A pane layout needs a terminal it can own. Without one - a pipe, a CI log,
  // `dum | less` - the line-printer is not a downgrade, it is the only thing
  // that works, and it is also how this program is scripted in a test.
  const tui = !plain && stdout.isTTY && stdin.isTTY;

  const stop = tui ? await startInk(store, readLayout(repo.root)) : startPlain(store, repo.name, mode);
  try {
    const request = fromArgs || (await store.askQuestion("what do you want?", "")).trim();
    if (!request) {
      store.note("nothing to do.");
      return;
    }
    await run(request, repo, mode, store);
  } finally {
    stop();
  }
}

async function startInk(store: Store, layout: LayoutNode): Promise<() => void> {
  // Imported lazily so the plain path never pays to load React and Ink, which
  // matters for `dum` in a pipe and for the startup cost of `--plain`.
  const [{ render }, React, { App }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./panes/App.tsx"),
  ]);
  const app = render(React.createElement(App, { store, layout }), { exitOnCtrlC: true });
  return () => app.unmount();
}

function startPlain(store: Store, repo: string, mode: Mode): () => void {
  banner(repo, mode);
  const input = new Input();
  // Runs for the life of the process: it is a renderer, not a step. If it
  // dies, the agent is left parked on a promise nobody will ever resolve, so
  // this is fatal rather than something to log - a session that silently
  // stops answering is worse than one that says why it stopped.
  void runPlain(store, input).catch((err: Error) => {
    console.error(`\n  \x1b[38;5;167m✗\x1b[0m ${err.message}\n`);
    exit(1);
  });
  return () => input.close();
}

main().catch((err: Error) => {
  console.error(`\n  \x1b[38;5;167m✗\x1b[0m ${err.message}\n`);
  exit(1);
});

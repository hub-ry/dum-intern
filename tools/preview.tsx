// Draw the panes against a fabricated session, with no agent and no terminal.

import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { App } from "../src/panes/App.tsx";
import { Store } from "../src/store.ts";
import { DEFAULT } from "../src/layout.ts";

const cols = Number(process.argv[2]) || 100;
const rows = Number(process.argv[3]) || 34;

let frame = "";
const stdout = Object.assign(new EventEmitter(), {
  columns: cols,
  rows,
  isTTY: true,
  write: (s: string) => {
    frame += s;
    return true;
  },
});
// useInput needs raw mode, which needs something that claims to be a terminal.
const stdin = Object.assign(new EventEmitter(), {
  isTTY: true,
  setRawMode: () => {},
  setEncoding: () => {},
  resume: () => {},
  pause: () => {},
  read: () => null,
  ref: () => {},
  unref: () => {},
});

const store = new Store("some-repo", "anti-vibe", process.cwd(), [
  "README.md",
  "LICENSE",
  "package.json",
  "bin/dum",
  "src/cli.tsx",
  "src/lines.ts",
  "src/plain.ts",
  "src/repo.ts",
  "src/session.ts",
  "src/store.ts",
  "src/stream.ts",
  "src/tree.ts",
  "src/wizard.ts",
  "src/panes/App.tsx",
  "src/panes/Chat.tsx",
  "src/panes/Code.tsx",
  "src/panes/Field.tsx",
  "src/panes/Tree.tsx",
  "test/stream.test.ts",
  "test/tree.test.ts",
]);
store.setModel("intern", "claude-opus-5-5", "high");
store.setModel("wizard", "claude-sonnet-5", "medium");
store.say("Got it. Two decisions before I build anything.");
void store.askQuestion(
  "When a worker dies holding a job, what should happen to that job?",
  "Decides whether jobs can run twice or can be lost.",
);
store.submit("another worker should pick it back up after a while if the first one dies");
store.quip(
  "that's a visibility timeout - the mechanism SQS and most job queues use for exactly this failure case.",
  "",
);
store.toolEvent("Read", "src/queue.ts", "ran");
store.toolEvent("Write", "src/lease.ts", "ran");
store.toolEvent("Bash", "npm test", "held");
store.toolEvent("Write", "/Users/you/.zshrc", "refused");
store.streaming(
  "Write",
  "src/lease.ts",
  [
    "import { db } from \"./db.ts\";",
    "",
    "const LEASE_MS = 30_000;",
    "",
    "export async function claim(worker: string) {",
    "  const now = Date.now();",
    "  return db.one(",
    "    `update jobs set leased_by = $1, leased_until = $2",
    "       where id = (select id from jobs",
    "                    where leased_until is null or leased_until < $3",
    "                    order by id for update skip locked limit 1)",
    "     returning *`,",
    "    [worker, now + LEASE_MS, now],",
    "  );",
    "}",
  ].join("\n"),
);

// Which screen to draw.
const scene = process.argv[5] ?? "ask";
if (scene === "spec") {
  void store.proposeSpec(
    [
      "## build",
      "",
      "A durable job queue backed by postgres.",
      "",
      "## decisions",
      "",
      "- lease-based reclaim: a job is leased for 30s and renewed by a heartbeat, so a dead worker's job returns to the queue on its own",
      "- at-least-once delivery, deduped on an idempotency key",
      "",
      "## explicitly out of scope",
      "",
      "- priorities, delayed jobs, a web dashboard",
      "",
      "## still unresolved",
      "",
      "- what happens after N failed attempts (you said `probably just log it`)",
    ].join("\n"),
  );
} else if (scene === "open") {
  // A real file from this repo, so the gutter, the scrollbar and the sideways clipping are
  // exercised by something with the shape of code.
  store.openFile("src/store.ts");
  void store.askQuestion("what next?", "");
} else if (scene === "hole") {
  // Handed a hole to type: the file open at the TODO, dum saying whose turn.
  store.setTodos([{ concept: "median of a sorted list", path: "stats.py" }]);
  store.streaming(
    "Write",
    "stats.py",
    [
      "def mean(xs):",
      "    return sum(xs) / len(xs)",
      "",
      "def median(xs):",
      "    s = sorted(xs)",
      "    # TODO(dum): median of a sorted list",
      "    # Return the middle value; average the two middles when even.",
      "    raise NotImplementedError",
      "",
    ].join("\n"),
  );
  store.toolEvent("Write", "stats.py", "ran");
  void store.askNext();
} else if (scene === "fill") {
  // Mid-fill: a skill they hold, typing itself into its block.
  const file = ["def median(xs):", "    s = sorted(xs)", "    n = len(s)", "    mid = n // 2", "", "def mode(xs):", "    pass", ""].join("\n");
  store.typing("stats.py", file.replace("    mid = n // 2\n", "    mid = n // 2\n    return s[mid] if n % 2 else (s[mid - 1] + s[mi"), 2);
  store.filled("stats.py", "median", "    n = len(s)\n    mid = n // 2\n    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2");
  void store.askNext();
} else if (scene === "long") {
  // dum saying far too much: the pane shows what fits and points at the rest.
  void store.askQuestion(
    "miner.py is set up, but it doesn't print an IP yet. Both regex pieces are yours to type, so python miner.py stops with NotImplementedError until you fill them in. Your holes: miner.py:5 (the IP pattern) and miner.py:12 (the search and print). Also the empty list case is still open, and mean() still crashes on an empty list with ZeroDivisionError instead of ValueError, which I left alone because you didn't ask.",
    "",
  );
  store.setProgress({ done: 1, total: 9, unit: "feature" });
} else if (scene === "transcript") {
  void store.askQuestion("what next?", "");
  store.toggleTranscript();
} else if (scene !== "lesson") {
  void store.askQuestion(
    "Is it worse for a job to run twice, or to never run at all?",
    "Decides at-least-once versus at-most-once delivery.",
    true,
  );
}

const app = render(React.createElement(App, { store, layout: DEFAULT }), {
  stdout: stdout as never,
  stdin: stdin as never,
  patchConsole: false,
});
setTimeout(() => {
  app.unmount();
  // Ink redraws in place, so only the last frame is the picture.
  const frames = frame.split("\x1b[2J");
  process.stderr.write(frames[frames.length - 1] ?? frame);
  process.exit(0);
}, Number(process.argv[4]) || 1500);

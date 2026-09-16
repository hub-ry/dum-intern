// Draw the panes against a fabricated session, with no agent and no terminal.
//
// Ink's render takes its own stdout, so a fake one with a fixed size captures
// exact frames. That matters more here than it sounds: this is a program whose
// output IS the product, and checking it by hand means launching a real
// interrogation and spending a real session to find out a box is one column
// short. `npm run preview` answers that in a second.
//
// Not a test. It asserts nothing - it prints a frame for a person to look at.

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

// Which screen to draw. The stage shows a different thing in each case and
// they are the states most worth eyeballing before shipping a change.
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
} else if (scene === "transcript") {
  void store.askQuestion("what next?", "");
  store.toggleTranscript();
} else if (scene !== "lesson") {
  void store.askQuestion(
    "Is it worse for a job to run twice, or to never run at all?",
    "Decides at-least-once versus at-most-once delivery.",
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

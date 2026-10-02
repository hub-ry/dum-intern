// Draw the panes from a real session's record (DUM_TRANSCRIPT=<file> dum ...), with no agent.
// npx tsx tools/replay.tsx <transcript.json> [entries] [cols] [rows] [repo root] [file to open]

import React from "react";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { render } from "ink";
import { App } from "../src/panes/App.tsx";
import { Store, type Entry } from "../src/store.ts";
import { DEFAULT } from "../src/layout.ts";

const [file, upto, cols, rows, root] = [process.argv[2]!, Number(process.argv[3]) || Infinity, Number(process.argv[4]) || 150, Number(process.argv[5]) || 34, process.argv[6] ?? process.cwd()];
let frame = "";
const stdout = Object.assign(new EventEmitter(), { columns: cols, rows, isTTY: true, write: (s: string) => ((frame += s), true) });
const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, setEncoding() {}, resume() {}, pause() {}, read: () => null, ref() {}, unref() {} });
const store = new Store("replay", "understand", root, []);
const entries = (JSON.parse(readFileSync(file, "utf8")) as Entry[]).slice(0, upto);
for (const { id, ...e } of entries) (store as unknown as { append: (e: object) => number }).append(e);
if (process.argv[7]) store.openFile(process.argv[7]);
void store.askNext();
const app = render(React.createElement(App, { store, layout: DEFAULT }), { stdout: stdout as never, stdin: stdin as never, patchConsole: false });
setTimeout(() => {
  app.unmount();
  // Ink redraws in place, so only the last frame is the picture.
  const frames = frame.split("\x1b[2J");
  process.stderr.write(frames[frames.length - 1] ?? frame);
  process.exit(0);
}, 1500);

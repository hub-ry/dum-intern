// Print a real session's record (DUM_TRANSCRIPT=<file> dum ..., or a repo's .dum/transcript.json)
// the way the terminal draws it, with no agent.
// npm run replay -- <transcript.json> [entries] [width]

import { readFileSync } from "node:fs";
import { transcriptLines } from "../src/plain.ts";
import type { Entry } from "../src/store.ts";

const [file, upto, width] = [process.argv[2], Number(process.argv[3]) || Infinity, Number(process.argv[4]) || 74];
if (!file) {
  console.error("usage: npm run replay -- <transcript.json> [entries] [width]");
  process.exit(1);
}
const entries = (JSON.parse(readFileSync(file, "utf8")) as Entry[]).slice(0, upto);
const lines = transcriptLines(entries, width, !process.env.NO_COLOR);
process.stdout.write(lines.map((l) => (l ? `  ${l}` : "")).join("\n") + "\n");

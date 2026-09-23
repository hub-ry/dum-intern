// Runs the wizard over fixed exchanges, several times each, and prints what it
// said.
//
// The wizard's behaviour was tuned by measuring it - "lease, not dead letter
// queue, 5 out of 5" - and a prompt change can quietly undo that. So this is
// how a change to its voice gets checked: run it, read the lines, count.
//
//   npm run eval:wizard            every case, 3 runs each
//   npm run eval:wizard -- 5 lease 5 runs of the cases whose id contains "lease"
//
// Each run is a fresh wizard, because a long-lived one passes on a topic it
// already commented on, which would make the second run meaningless.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Wizard } from "../src/wizard.ts";

type Case = {
  id: string;
  request: string;
  answer: string;
  /** What a good line looks like, for the person reading the output. */
  want: string;
  /** A line matching this is a failure outright. */
  bad?: RegExp;
  /** Whether saying nothing is acceptable here. */
  passOk: boolean;
};

const CASES: Case[] = [
  {
    id: "name-lease",
    request: "a job queue for resizing uploaded images",
    answer: "another worker should pick it back up after a while if the first one dies",
    want: "names a lease or visibility timeout",
    bad: /dead.?letter/i,
    passOk: false,
  },
  {
    id: "nudge-range",
    request: "print the numbers 1 to 10 in rust",
    answer: "the = makes the range exclusive so it stops at 9, like python range",
    want: "a rhetorical question, then points at ..= being inclusive",
    bad: /^[^?]*$/,
    passOk: false,
  },
  {
    id: "nudge-float-money",
    request: "an app that splits dinner bills between friends",
    answer: "i'll just store the amounts as floats in dollars",
    want: "a rhetorical question about float rounding, then integer cents",
    bad: /^[^?]*$/,
    passOk: false,
  },
  {
    id: "practice-idempotency",
    request: "a payments webhook handler",
    answer: "if stripe sends the same event twice we just check if we've seen the event id before",
    want: "names idempotency, ideally how teams usually store the key",
    bad: /\bworth\b|\byou should\b|\bconsider\b/i,
    passOk: false,
  },
  {
    id: "search-new-model",
    request: "a cli that writes commit messages from the staged diff",
    answer: "i'll call claude opus 5.5 through the api, it's the newest one",
    want: "anything true, or pass - never that it doesn't exist",
    bad: /(doesn'?t|does not|isn'?t|not yet) (exist|out|released|real)|no such model|there is no/i,
    passOk: true,
  },
  {
    id: "pass-bare-yes",
    request: "a todo app",
    answer: "yes",
    want: "pass",
    passOk: true,
  },
];

const runs = Number(process.argv[2]) || 3;
const only = process.argv[3];
const cases = CASES.filter((c) => !only || c.id.includes(only));
const root = mkdtempSync(`${tmpdir()}/dum-wizard-eval-`);
const repo = { name: "eval", root, files: [], readme: "" };

async function once(c: Case): Promise<{ line: string | null; ms: number }> {
  const w = new Wizard(repo);
  w.start();
  const t = Date.now();
  try {
    const q = await w.consider({ request: c.request, answer: c.answer });
    return { line: q?.text ?? null, ms: Date.now() - t };
  } finally {
    w.close();
  }
}

let failed = 0;
for (const c of cases) {
  const results = await Promise.all(Array.from({ length: runs }, () => once(c)));
  console.log(`\n${c.id}  (want: ${c.want})`);
  for (const r of results) {
    const bad = r.line ? c.bad?.test(r.line) : !c.passOk;
    if (bad) failed++;
    const mark = bad ? "✗" : "·";
    console.log(`  ${mark} ${(r.ms / 1000).toFixed(1)}s  ${r.line ?? "(pass)"}`);
  }
}
console.log(`\n${failed ? `${failed} bad` : "no outright failures"} - read the lines, the regexes only catch the worst.\n`);

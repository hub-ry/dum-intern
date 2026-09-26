// Runs the wizard over fixed exchanges, several times each, and prints what it said.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Wizard, type Kind } from "../src/wizard.ts";
import { debugTo } from "../src/debug.ts";

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
  /** A line of the other kind is a failure: a nudge on something correct, say. */
  kind?: Kind;
};

const CASES: Case[] = [
  // Naming. A wrong name is the worst thing the wizard can say.
  {
    id: "name-lease",
    request: "a job queue for resizing uploaded images",
    answer: "another worker should pick it back up after a while if the first one dies",
    want: "names a lease or visibility timeout",
    bad: /dead.?letter/i,
    passOk: false,
    kind: "fact",
  },
  {
    id: "name-macro",
    request: "print hello world in rust",
    answer:
      "it means println is a macro not a function, it expands at compile time so it can take a variable number of args and check the format string",
    want: "pass (they named it), or a true fact about format_args!/macro_rules!",
    bad: /monomorph|generic|template|inlin/i,
    passOk: true,
    kind: "fact",
  },
  {
    id: "name-debounce",
    request: "a search box that queries the api as you type",
    answer: "i'll wait until they stop typing for like 300ms before sending the request",
    want: "names debouncing",
    bad: /that'?s (a )?throttl/i,
    passOk: false,
    kind: "fact",
  },
  {
    id: "name-wal",
    request: "a tiny key value store that survives crashes",
    answer: "before i change anything on disk i'll append the change to a log file first, so i can replay it after a crash",
    want: "names a write-ahead log",
    passOk: false,
    kind: "fact",
  },
  // Nudges. Question first, then a pointer.
  {
    id: "nudge-range",
    request: "print the numbers 1 to 10 in rust",
    answer: "the = makes the range exclusive so it stops at 9, like python range",
    want: "a rhetorical question, then points at ..= being inclusive",
    passOk: false,
    kind: "nudge",
  },
  {
    id: "nudge-float-money",
    request: "an app that splits dinner bills between friends",
    answer: "i'll just store the amounts as floats in dollars",
    want: "a rhetorical question about float rounding, then integer cents",
    passOk: false,
    kind: "nudge",
  },
  {
    id: "nudge-password-hash",
    request: "a login page for a small club site",
    answer: "i'll sha256 the passwords before storing them so they're not plain text",
    want: "a question about fast hashes / cracking, then bcrypt or argon2",
    passOk: false,
    kind: "nudge",
  },
  // Correct statements. A nudge here is a false alarm, the fastest way to be ignored.
  {
    id: "no-nudge-cents",
    request: "an app that splits dinner bills between friends",
    answer: "i'll store every amount as integer cents so rounding never drifts",
    want: "pass, or a fact - never a nudge",
    passOk: true,
    kind: "fact",
  },
  {
    id: "no-nudge-bcrypt",
    request: "a login page for a small club site",
    answer: "passwords go through bcrypt with a cost of 12 before they touch the db",
    want: "pass, or a fact - never a nudge",
    passOk: true,
    kind: "fact",
  },
  // Practice. "engineers usually" has to be real practice.
  {
    id: "practice-idempotency",
    request: "a payments webhook handler",
    answer: "if stripe sends the same event twice we just check if we've seen the event id before",
    want: "names idempotency, ideally how teams usually store the key",
    bad: /\bworth\b|\byou should\b|\bconsider\b/i,
    passOk: false,
  },
  // Things newer than the model. Never "that doesn't exist".
  {
    id: "search-new-model",
    request: "a cli that writes commit messages from the staged diff",
    answer: "i'll call claude opus 5.5 through the api, it's the newest one",
    want: "something current and true (release, price), or pass - never that it doesn't exist",
    bad: /(doesn'?t|does not|isn'?t|not yet) (exist|out|released|real)|no such model|there is no/i,
    passOk: true,
  },
  {
    id: "stale-version",
    request: "a small express api for a club's event signups",
    answer: "i'll run it on node 16 since that's what's on my laptop",
    want: "points out node 16 is end-of-life, current LTS",
    passOk: true,
  },
  // Nothing to grab.
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
// With DUM_DEBUG=1 every pass and every checker veto, with its reason, lands here.
debugTo(root);
if (process.env.DUM_DEBUG) console.log(`debug log: ${root}/.dum/debug.log`);

async function once(c: Case): Promise<{ line: string | null; kind: Kind | null; ms: number }> {
  const w = new Wizard(repo);
  w.start();
  const t = Date.now();
  try {
    const q = await w.consider({ request: c.request, answer: c.answer });
    return { line: q?.text ?? null, kind: q?.kind ?? null, ms: Date.now() - t };
  } finally {
    w.close();
  }
}

let failed = 0;
// Cases run concurrently, a few at a time: one at a time takes minutes, and all at once spawns
// a process per run.
const settled = new Map<string, Awaited<ReturnType<typeof once>>[]>();
const queue = [...cases];
await Promise.all(
  Array.from({ length: Number(process.env.EVAL_PARALLEL) || 4 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      settled.set(c.id, await Promise.all(Array.from({ length: runs }, () => once(c!))));
    }
  }),
);
for (const c of cases) {
  const results = settled.get(c.id)!;
  console.log(`\n${c.id}  (want: ${c.want})`);
  for (const r of results) {
    const bad = r.line ? !!c.bad?.test(r.line) || (!!c.kind && r.kind !== c.kind) : !c.passOk;
    if (bad) failed++;
    const mark = bad ? "✗" : "·";
    const tag = r.kind ? `${r.kind}: ` : "";
    console.log(`  ${mark} ${(r.ms / 1000).toFixed(1)}s  ${r.line ? tag + r.line : "(pass)"}`);
  }
}
console.log(`\n${failed ? `${failed} bad` : "no outright failures"} - read the lines, the regexes only catch the worst.\n`);

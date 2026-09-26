// Runs the checker over lines with a known verdict and counts how often it agrees.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Checker } from "../src/checker.ts";

type Line = {
  request: string;
  answer: string;
  kind: "fact" | "nudge";
  text: string;
  /** null for a gray area: shown, not scored. */
  good: boolean | null;
  note: string;
};

const MACRO = {
  request: "print hello world in rust",
  answer:
    "it means println is a macro not a function, it expands at compile time so it can take a variable number of args and check the format string",
};
const LEASE = {
  request: "a job queue for resizing uploaded images",
  answer: "another worker should pick it back up after a while if the first one dies",
};
const RANGE = {
  request: "print the numbers 1 to 10 in rust",
  answer: "the = makes the range exclusive so it stops at 9, like python range",
};
const CENTS = {
  request: "an app that splits dinner bills between friends",
  answer: "i'll store every amount as integer cents so rounding never drifts",
};
const FLOATS = {
  request: "an app that splits dinner bills between friends",
  answer: "i'll just store the amounts as floats in dollars",
};
const BCRYPT = {
  request: "a login page for a small club site",
  answer: "passwords go through bcrypt with a cost of 12 before they touch the db",
};
const SHA = {
  request: "a login page for a small club site",
  answer: "i'll sha256 the passwords before storing them so they're not plain text",
};
const DEBOUNCE = {
  request: "a search box that queries the api as you type",
  answer: "i'll wait until they stop typing for like 300ms before sending the request",
};
const WAL = {
  request: "a tiny key value store that survives crashes",
  answer: "before i change anything on disk i'll append the change to a log file first, so i can replay it after a crash",
};
const WEBHOOK = {
  request: "a payments webhook handler",
  answer: "if stripe sends the same event twice we just check if we've seen the event id before",
};
const NODE = {
  request: "a small express api for a club's event signups",
  answer: "i'll run it on node 16 since that's what's on my laptop",
};

const LINES: Line[] = [
  // Bad.
  { ...MACRO, kind: "fact", good: false, note: "real: wrong name",
    text: "that's monomorphization plus a compile-time format string checker - rustc actually parses the \"{}\" args against println's arguments and errors before it ever runs." },
  { ...RANGE, kind: "fact", good: false, note: "real: agrees with a wrong answer",
    text: "yeah, `..=` is the inclusive range operator in rust, `1..10` would be exclusive like python's `range`." },
  { ...CENTS, kind: "fact", good: false, note: "real: garbled",
    text: "that's why currencies like postgres's money-averse crowd store cents as integers by default - it's the standard fix for float drift in ledgers." },
  { ...BCRYPT, kind: "fact", good: false, note: "real: garbled advice",
    text: "check the bcrypt library actually enforces its 72-byte input limit silently truncating longer passwords, since most implementations do." },
  { ...LEASE, kind: "fact", good: false, note: "near miss: wrong name",
    text: "that's a dead letter queue - where a job goes when its worker dies so another one can pick it up." },
  { ...DEBOUNCE, kind: "fact", good: false, note: "near miss: wrong name",
    text: "that's throttling - it caps how often the request can fire while they type." },
  { ...WAL, kind: "fact", good: false, note: "near miss: wrong name",
    text: "that's event sourcing - the log of changes is the source of truth and the store is rebuilt from it." },
  { ...SHA, kind: "fact", good: false, note: "correction tagged as a fact",
    text: "plain sha256 is fast to brute-force with gpus, so the standard move is bcrypt or argon2." },
  { ...WEBHOOK, kind: "fact", good: false, note: "wrong claim",
    text: "that's idempotency - stripe guarantees exactly-once delivery, so the check only matters for your own retries." },
  // Good.
  { ...LEASE, kind: "fact", good: true, note: "real",
    text: "that's a visibility timeout - the mechanism sqs and most job queues use to requeue work if a worker doesn't ack in time." },
  { ...MACRO, kind: "fact", good: true, note: "real",
    text: "yeah, macro expansion is why println! catches format string mismatches at compile time instead of blowing up at runtime like C's printf." },
  { ...DEBOUNCE, kind: "fact", good: true, note: "real",
    text: "that's debouncing - the standard way to avoid firing a request on every keystroke." },
  { ...WAL, kind: "fact", good: true, note: "real",
    text: "that's a write-ahead log, the same mechanism postgres and sqlite use to guarantee durability before touching the actual data files." },
  { ...FLOATS, kind: "nudge", good: true, note: "real",
    text: "what does 0.1 + 0.2 give you as a float? money usually lives in integer cents to avoid rounding errors." },
  { ...SHA, kind: "nudge", good: true, note: "real",
    text: "what happens if someone steals the password table - does a bare hash slow them down at all? plain sha256 is fast to brute-force, so people use bcrypt or argon2, which are built to be slow." },
  // Either verdict is defensible: it reads as a claim about THEIR setup rather than as
  // practice.
  { ...WEBHOOK, kind: "fact", good: null, note: "real, gray area",
    text: "that's idempotency keying - storing the event id in a unique-constrained column so retries get rejected by the db itself, not just app logic." },
  { ...NODE, kind: "nudge", good: true, note: "real",
    text: "does node 16 still get security patches? it hit end-of-life in september 2023, so hosting platforms are dropping it fast." },
  { ...CENTS, kind: "fact", good: true, note: "real",
    text: "that's a common pattern in payment apis - stripe and most ledgers store amounts as integer minor units for this exact reason." },
  { ...RANGE, kind: "nudge", good: true, note: "real",
    text: "does `1..=10` stop at 9 or 10? the `=` is what makes it inclusive - `1..10` is the exclusive one, like python's range." },
];

const runs = Number(process.argv[2]) || 3;
const root = mkdtempSync(`${tmpdir()}/dum-checker-eval-`);
const repo = { name: "eval", root, files: [], readme: "" };

// A few checkers side by side, each taking lines in turn, the way the wizard uses one: a
// long-lived session that has seen earlier lines.
const WORKERS = 3;
const verdicts = new Map<number, { ok: boolean; reason: string }[]>();
const jobs: { i: number }[] = [];
for (let r = 0; r < runs; r++) LINES.forEach((_, i) => jobs.push({ i }));

await Promise.all(
  Array.from({ length: WORKERS }, async () => {
    const c = new Checker(repo);
    c.start();
    try {
      for (let job = jobs.shift(); job; job = jobs.shift()) {
        const l = LINES[job.i]!;
        const j = await c.judge(l, { kind: l.kind, text: l.text });
        verdicts.set(job.i, [...(verdicts.get(job.i) ?? []), j]);
      }
    } finally {
      c.close();
    }
  }),
);

let caught = 0;
let bad = 0;
let kept = 0;
let good = 0;
LINES.forEach((l, i) => {
  const v = verdicts.get(i) ?? [];
  if (l.good === null) {
    console.log(`? ${v.filter((j) => j.ok).length}/${v.length} kept  (${l.note})  ${l.text.slice(0, 90)}`);
    return;
  }
  const right = v.filter((j) => j.ok === l.good).length;
  if (l.good) {
    good += v.length;
    kept += right;
  } else {
    bad += v.length;
    caught += right;
  }
  const mark = right === v.length ? "·" : "✗";
  console.log(`${mark} ${right}/${v.length}  ${l.good ? "keep" : "drop"}  (${l.note})  ${l.text.slice(0, 90)}`);
  for (const j of v) if (j.ok !== l.good && j.reason) console.log(`      checker: ${j.reason}`);
});
console.log(`\ncaught ${caught}/${bad} bad lines, kept ${kept}/${good} good ones\n`);

// The Wizard's decision cards: host-issued ids, only supplied context, canonical candidate skills
// and offered catalog anchors, and model words screened for unsupported external claims.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byId, candidates } from "../src/anchors.ts";
import { createRegistry } from "../src/agent/registry.ts";
import { help, parseDecision } from "../src/wizard.ts";
import type { AgentBackend, AgentEvent, OpenOptions, Selector, UserTurn } from "../src/agent/types.ts";
import type { ContextRef, DecisionInput, DecisionResult } from "../src/delegation-types.ts";

process.env.DUM_HOME = mkdtempSync(join(tmpdir(), "dum-wizard-"));
process.env.DUM_CONTEXT = "off";

const sha = "a".repeat(64);
const note: ContextRef = {
  id: randomUUID(), kind: "zone-note", label: "Club notes", revision: sha, at: null,
  excerpt: "Scores arrive as a CSV export from the club app every Friday.",
};
const look: ContextRef = {
  id: randomUUID(), kind: "look", label: "Editor", revision: sha, at: null,
  excerpt: "leaderboard.py sorts rows with a lambda key.",
};
const alignment: DecisionInput = {
  moment: "alignment",
  goal: "Learn Python by building our club leaderboard",
  outcome: null,
  language: "python",
  direction: null,
  answers: [],
  context: [note, look],
  candidates: [{ name: "sorting with keys", lang: "python" }, { name: "reading CSV files", lang: "python" }],
};
const delegation: DecisionInput = { ...alignment, moment: "delegation", outcome: "Import this week's CSV into the leaderboard" };
const sorting = byId("python-sorting")!;
const offered = [sorting];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function project(over: Record<string, unknown> = {}) {
  return {
    id: "model-id-1", kind: "project", title: "Rank members by score",
    builds: [{ name: "sorting with keys", lang: "python" }],
    advancesGoal: "Ranking the rows exercises key functions on real club data.",
    contextIds: [look.id], tradeoff: "Ties need a rule before the board is fair.", anchor: null, ...over,
  };
}
function task(over: Record<string, unknown> = {}) {
  return {
    id: "model-id-2", task: "Write the CSV import for the leaderboard.", expectedResult: "A function that loads the export into rows.",
    review: "Load last Friday's file and compare the totals.", skills: [{ name: "reading CSV files", lang: "python" }],
    advancesOutcome: "The board can show this week's scores.", contextIds: [note.id],
    tradeoff: "You would read the import rather than write it.", needs: null, anchor: null, ...over,
  };
}
function reply(options: unknown[], over: Record<string, unknown> = {}) {
  return JSON.stringify({ reflection: "Here's what I think you want to become able to do: rank the club by score.", questions: [], options, ...over });
}
const parse = (raw: string, input: DecisionInput = alignment, anchors = offered) => parseDecision(raw, input, anchors);
const options = (r: DecisionResult | null) => r!.options as Record<string, unknown>[];

/** A helper backend answering each one-shot with the next scripted reply, recording what it was sent. */
function helper(replies: (string | Error)[]) {
  const opened: OpenOptions[] = [];
  const turns: UserTurn[] = [];
  const backend: AgentBackend = {
    id: "claude",
    label: "Claude",
    models: async () => [],
    capabilities: async (selector) => ({ model: selector.model, images: true, noImages: "", interrupt: true, runtimeActionCheck: true }),
    open: async (o) => {
      opened.push(o);
      return {
        turn: async function* (input): AsyncIterable<AgentEvent> {
          turns.push(input);
          const next = replies.shift();
          if (next instanceof Error) yield { type: "end", error: next.message, interrupted: false };
          else {
            yield { type: "text", text: next ?? "" };
            yield { type: "end", error: null, interrupted: false };
          }
        },
        interrupt: async () => {},
        close: () => {},
      };
    },
  };
  const agent = createRegistry([backend], new Set(["claude"]));
  const intern: Selector = { backend: "claude", model: "intern-model", effort: "high" };
  const small: Selector = { backend: "claude", model: "helper-model", effort: null };
  agent.set({ backend: "claude", login: "anthropic-key", intern, helper: small, look: intern });
  return { agent, opened, turns };
}

test("alignment help runs on the action-free helper and returns host-issued cards from what it was given", async () => {
  const h = helper([reply([project({ anchor: "python-sorting", builds: [{ name: "Sorting with key", lang: "python" }] })], {
    questions: [{ id: "model-q", text: "Do ties share a rank?", changesPlan: "Shared ranks change what the first project must build." }],
  })]);
  const out = await help(alignment, { agent: h.agent, cwd: "/h/zones/z/runtime", signal: new AbortController().signal });
  const o = h.opened[0]!;
  assert.deepEqual(o.actions, []);
  assert.equal(o.selector.model, "helper-model");
  assert.equal(o.cwd, "/h/zones/z/runtime");
  assert.equal(o.maxTurns, 1);
  const sent = h.turns[0]!.text;
  assert.ok(sent.includes(note.excerpt) && sent.includes(look.id), "context excerpts and ids reach the prompt");
  assert.ok(sent.includes("reading CSV files") && sent.includes("sorting with keys"), "candidates reach the prompt");
  assert.ok(sent.includes("python-sorting"), "the offered anchor reaches the prompt by id");

  assert.equal(out.moment, "alignment");
  assert.match(out.reflection, /become able to do/);
  assert.equal(out.questions.length, 1);
  assert.match(out.questions[0]!.id, UUID);
  assert.notEqual(out.questions[0]!.id, "model-q");
  const [card] = options(out);
  assert.match(card!.id as string, UUID);
  assert.notEqual(card!.id, "model-id-1");
  assert.equal(card!.kind, "project");
  assert.deepEqual(card!.builds, [{ name: "sorting with keys", lang: "python" }], "the candidate's canonical spelling");
  assert.deepEqual(card!.contextIds, [look.id]);
  assert.equal(card!.tradeoff, `Ties need a rule before the board is fair. Source: ${sorting.claim} (${sorting.url})`);
  assert.equal("anchor" in card!, false);
});

test("delegation proposals carry a named missing detail and never an eligibility", () => {
  const out = parse(reply([
    task(),
    task({ task: "Add a weekly totals column.", needs: "Which column holds the attendance bonus." }),
  ]), delegation);
  assert.equal(out!.moment, "delegation");
  const [first, second] = options(out);
  assert.equal(first!.needs, null);
  assert.equal(second!.needs, "Which column holds the attendance bonus.");
  assert.deepEqual(first!.skills, [{ name: "reading CSV files", lang: "python" }]);
  for (const o of [first!, second!]) {
    assert.equal("eligibility" in o, false);
    assert.equal("blockers" in o, false);
    assert.match(o.id as string, UUID);
  }
  // A shape from the other moment never passes as a proposal.
  assert.deepEqual(options(parse(reply([project()]), delegation)), []);
  assert.deepEqual(options(parse(reply([task()]), alignment)), []);
});

test("a needed detail with a link drops the proposal rather than reading as none", () => {
  assert.deepEqual(options(parse(reply([task({ needs: "The format at https://club.example.invalid/export." })]), delegation)), []);
});

test("descriptions of the work are only tidied; world claims in the same card are screened", () => {
  const sorter = task({
    task: "Write a sorter that uses a key function \u2014 for the 2024 season export.",
    expectedResult: "The function sorts 1000 rows by score, as \"rank\" in Leaderboard.",
    review: "Check that Postgres rows come out in the same order.",
  });
  const [card] = options(parse(reply([sorter]), delegation));
  assert.equal(card!.task, "Write a sorter that uses a key function - for the 2024 season export.");
  assert.equal(card!.expectedResult, "The function sorts 1000 rows by score, as \"rank\" in Leaderboard.");
  assert.equal(card!.review, "Check that Postgres rows come out in the same order.");
  assert.deepEqual(options(parse(reply([task({ tradeoff: "Most teams use a key function here." })]), delegation)), []);
  assert.deepEqual(options(parse(reply([task({ advancesOutcome: "Engineers typically sort this way." })]), delegation)), []);
  for (const link of ["See https://example.invalid.", "Read www.example.invalid first.", "Follow [the guide](x)."]) {
    assert.deepEqual(options(parse(reply([task({ review: link })]), delegation)), [], link);
    assert.deepEqual(options(parse(reply([project({ title: link })]))), [], link);
  }
});

test("unsupported specifics are cut from card text, and a card whose required words don't survive is dropped", () => {
  for (const claim of [
    "Guido invented this in 2002.",
    "It made sorting 3x faster.",
    "Ninety percent of teams do this.",
    "My team used this in production.",
    'A founder called this "move fast".',
    "See https://unverified.example.invalid for proof.",
    "Read [the guide](https://example.invalid).",
  ]) {
    assert.deepEqual(options(parse(reply([project({ tradeoff: claim })]))), [], claim);
  }
  const kept = options(parse(reply([project({ tradeoff: "Google discovered this in 2008. Ties need a rule before the board is fair." })])));
  assert.equal(kept[0]!.tradeoff, "Ties need a rule before the board is fair.");
  const q = parse(reply([], { questions: [
    { text: "Is this the format at https://example.invalid?", changesPlan: "It changes the parser." },
    { text: "Do ties share a rank?", changesPlan: "" },
  ] }));
  assert.deepEqual(q!.questions, []);
});

test("claims about what everyone does are cut unless the chosen anchor's own words say it", () => {
  for (const claim of [
    "Integer cents or decimal are the two usual routes.",
    "Most teams keep money as integer cents.",
    "Engineers typically reach for decimal here.",
    "Integer cents is the industry standard for money.",
    "Storing cents is best practice.",
  ]) {
    assert.deepEqual(options(parse(reply([project({ tradeoff: claim })]))), [], claim);
  }
  const errors = byId("go-errors")!;
  const go: DecisionInput = { ...alignment, language: "go", candidates: [] };
  const out = parse(reply([project({ builds: [], anchor: "go-errors", tradeoff: "Conventionally returning one here lets load report the bad row." })]), go, [errors]);
  assert.match(options(out)[0]!.tradeoff as string, /^Conventionally returning one here lets load report the bad row\. Source: /);
});

test("organizations need the chosen anchor or the user's own words; context and candidates don't vouch for them", () => {
  const mentioned: DecisionInput = {
    ...alignment,
    context: [{ ...note, excerpt: "Netflix sorts its rows this way, and we use Postgres." }],
    candidates: [...alignment.candidates, { name: "docker basics", lang: "" }],
  };
  for (const claim of [
    "Netflix sorts all live events this way.",
    "Acme adopted stable sorting for its architecture.",
    "Since postgres already orders rows, sorting is cheap.",
    "Package the board as a Docker image first.",
  ]) {
    assert.deepEqual(options(parse(reply([project({ contextIds: [], tradeoff: claim })]), mentioned)), [], claim);
  }
  const docker = "Package the board as a Docker image first.";
  const goal: DecisionInput = { ...alignment, goal: "Learn Docker by shipping our club leaderboard" };
  assert.equal(options(parse(reply([project({ tradeoff: docker })]), goal))[0]!.tradeoff, docker);
  const outcome: DecisionInput = { ...delegation, outcome: "Run the leaderboard in docker on the club server" };
  assert.equal(options(parse(reply([task({ tradeoff: docker })]), outcome))[0]!.tradeoff, docker);
  const answered: DecisionInput = { ...alignment, answers: [{ question: "Where will it run?", answer: "In Docker on the club server." }] };
  assert.equal(options(parse(reply([project({ tradeoff: docker })]), answered))[0]!.tradeoff, docker);
  // An unexplained capitalized name is an outside name; the anchor's or the user's own terms are not.
  assert.deepEqual(options(parse(reply([project({ tradeoff: "Ties matter, as Raymond showed." })]))), []);
  const named = options(parse(reply([project({ anchor: "python-sorting", tradeoff: "Ties keep their order because Python sorts are stable." })])));
  assert.match(named[0]!.tradeoff as string, /^Ties keep their order because Python sorts are stable\. Source: /);
  const own = options(parse(reply([project({ title: "Rank the club in Python" })])));
  assert.equal(own[0]!.title, "Rank the club in Python");
});

test("an unknown or unoffered anchor rejects the option; a model-written URL never passes", () => {
  const git = byId("git-diff")!;
  assert.deepEqual(options(parse(reply([project({ anchor: "invented-team-history" })]))), []);
  assert.deepEqual(options(parse(reply([project({ anchor: git.id })]))), [], "a real catalog id that wasn't offered");
  assert.deepEqual(options(parse(reply([project({ anchor: 7 })]))), []);
  const out = options(parse(reply([project({ anchor: "python-sorting", url: "https://evil.invalid", tradeoff: "See www.evil.invalid. Ties need a rule." })])));
  assert.equal(out[0]!.tradeoff, `Ties need a rule. Source: ${sorting.claim} (${sorting.url})`);
  assert.equal("url" in out[0]!, false);
});

test("context ids the input didn't supply, or skills outside the candidates, reject the option", () => {
  assert.deepEqual(options(parse(reply([project({ contextIds: [randomUUID()] })]))), []);
  assert.deepEqual(options(parse(reply([project({ contextIds: [look.id, "not-an-id"] })]))), []);
  assert.deepEqual(options(parse(reply([project({ builds: [{ name: "Async IO", lang: "python" }] })]))), []);
  assert.deepEqual(options(parse(reply([project({ builds: [{ name: "sorting with keys", lang: "rust" }] })]))), []);
  assert.deepEqual(options(parse(reply([task({ skills: [{ name: "regex", lang: "python" }] })]), delegation)), []);
  // Duplicates collapse to one canonical ref and one id.
  const dup = options(parse(reply([project({
    builds: [{ name: "sorting with keys", lang: "python" }, { name: "Sorting With Keys", lang: "python" }], contextIds: [look.id, look.id],
  })])));
  assert.deepEqual(dup[0]!.builds, [{ name: "sorting with keys", lang: "python" }]);
  assert.deepEqual(dup[0]!.contextIds, [look.id]);
});

test("cards stay within bounds: two questions, three options, clipped title and text", () => {
  const q = { text: "Do ties share a rank?", changesPlan: "Shared ranks change the first project." };
  const long = "Ties need a rule before the board is fair. ".repeat(80);
  const out = parse(reply([1, 2, 3, 4, 5].map(() => project({ title: `Rank${" the club by score".repeat(20)}`, tradeoff: long, anchor: "python-sorting" })), {
    questions: [q, q, q, q],
  }));
  assert.equal(out!.questions.length, 2);
  assert.equal(options(out).length, 3);
  const ids = new Set(options(out).map((o) => o.id));
  assert.equal(ids.size, 3);
  for (const o of options(out)) {
    assert.ok((o.title as string).length <= 160);
    const t = o.tradeoff as string;
    assert.ok(Buffer.byteLength(t) <= 2048);
    assert.ok(t.endsWith(`(${sorting.url})`), "the source survives clipping");
  }
  const needs = options(parse(reply([task({ needs: "Which column holds the bonus? ".repeat(40) })]), delegation));
  assert.ok(Buffer.byteLength(needs[0]!.needs as string) <= 512);
});

test("zero surviving options is a valid result", () => {
  const out = parse(reply([project({ anchor: "nope" })]));
  assert.equal(out!.moment, "alignment");
  assert.deepEqual(out!.options, []);
});

test("an unreadable reply or an empty reflection throws; nothing is fabricated", async () => {
  assert.equal(parse("not valid json"), null);
  assert.equal(parse("[1, 2]"), null);
  assert.equal(parse(reply([project()], { reflection: "Back when I worked at Google we shipped this in 2019." })), null);
  for (const raw of ["no json here", reply([project()], { reflection: "" })]) {
    const h = helper([raw]);
    await assert.rejects(help(alignment, { agent: h.agent, cwd: "/tmp", signal: new AbortController().signal }), /^Error: decision help came back unreadable$/);
  }
});

test("a backend failure propagates as an error, and an invalid input never reaches the model", async () => {
  const failing = helper([new Error("signed out")]);
  await assert.rejects(help(delegation, { agent: failing.agent, cwd: "/tmp", signal: new AbortController().signal }), /signed out/);
  const none = createRegistry([], new Set());
  await assert.rejects(help(alignment, { agent: none, cwd: "/tmp", signal: new AbortController().signal }));
  const h = helper([reply([project()])]);
  await assert.rejects(help({ ...alignment, outcome: "Import the CSV" }, { agent: h.agent, cwd: "/tmp", signal: new AbortController().signal }));
  await assert.rejects(help({ ...alignment, context: [{ ...note, id: "model-made" }] }, { agent: h.agent, cwd: "/tmp", signal: new AbortController().signal }));
  assert.equal(h.opened.length, 0);
});

test("the anchors offered come from the goal, outcome and candidates, scoped to the language", async () => {
  assert.ok(candidates({ request: alignment.goal, skills: ["sorting with keys"], lang: "python" }).some((a) => a.id === "python-sorting"));
  const h = helper([reply([project({ builds: [], anchor: "python-sorting" })])]);
  const rust: DecisionInput = { ...alignment, language: "rust", candidates: [{ name: "sorting with keys", lang: "rust" }] };
  const out = await help(rust, { agent: h.agent, cwd: "/tmp", signal: new AbortController().signal });
  assert.deepEqual(out.options, [], "a python anchor isn't offered for a rust goal");
  assert.ok(!h.turns[0]!.text.includes("python-sorting"));
});

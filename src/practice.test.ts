import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.ts";
import {
  EXAMPLE_RUN,
  EXAMPLE_SCRIPT,
  LISTINGS_CSV,
  MAIN_HINTS,
  RELATED_SKILLS,
  RETURNS_CSV,
  STEPS,
  STEP_LABEL,
  STORAGE_KEY,
  TEACH_QUESTION,
  VARIATION_HINTS,
  VARIATION_RUN,
  VARIATION_SCRIPT,
  advance,
  allowedSteps,
  continueLabel,
  createSession,
  enter,
  hintButtonLabel,
  lessonMarkdown,
  parseSession,
  progress,
  revealHint,
  saveLesson,
  shownHints,
} from "./public/practice.js";
import { seedNodes } from "./seed.ts";
import { startServer } from "./server.ts";

const PLAN = "Read the file, skip a blank price, print sku and name, then count.";
const DRAFT = "import csv\nprint('draft')\n";
const EXPECTATION = "I expect the empty price rows.";
const FAILED = "I forgot to strip the price.";
const WHY = "A space looked empty to me.";
const FIX = "I will strip the field first.";
const ANSWER = "Print the sku and the name, and skip rows that have a price.";

test("hints open one rung at a time and never include the worked example", () => {
  let session = createSession();
  assert.equal(hintButtonLabel(0), "Ask for hint 1 of 3, a nudge");
  const kinds = ["nudge", "direction", "fragment"];
  for (const kind of kinds) {
    const revealed = revealHint(session, "main");
    assert.ok(revealed.hint);
    assert.equal(revealed.hint.kind, kind);
    session = revealed.session;
  }
  assert.equal(session.mainHints, 3);
  assert.equal(revealHint(session, "main").hint, null);
  assert.equal(shownHints(session, "main").length, 3);
  assert.equal(MAIN_HINTS[0].code, undefined);
  assert.doesNotMatch(MAIN_HINTS[0].body, /DictReader|import csv/);
  assert.equal(MAIN_HINTS[1].code, undefined);
  assert.doesNotMatch(MAIN_HINTS[1].body, /for row in/);
  assert.match(MAIN_HINTS[2].code ?? "", /DictReader/);
  assert.doesNotMatch(MAIN_HINTS[2].code ?? "", /listings missing a price/);
  assert.doesNotMatch(MAIN_HINTS[2].code ?? "", /sys\.argv/);
  assert.equal(`${MAIN_HINTS[2].body}\n${MAIN_HINTS[2].code}`.includes(EXAMPLE_SCRIPT.code), false);
  for (const hint of MAIN_HINTS) {
    assert.doesNotMatch(`${hint.body}\n${hint.code ?? ""}`, /2 listings missing a price/);
  }
});

test("a finished main hint ladder does not open variation hints", () => {
  const session = { ...createSession(), mainHints: 3 as const };
  const revealed = revealHint(session, "variation");
  assert.equal(revealed.session.mainHints, 3);
  assert.equal(revealed.session.variationHints, 1);
  assert.equal(revealed.hint?.kind, "nudge");
  assert.doesNotMatch(VARIATION_HINTS.map((hint) => `${hint.body}\n${hint.code ?? ""}`).join("\n"), /3 listings missing a price/);
});

test("the example run is labeled as canned output, not a score of a draft", () => {
  assert.match(EXAMPLE_RUN.disclaimer, /not a score/);
  assert.match(EXAMPLE_RUN.disclaimer, /was not run/i);
  assert.match(VARIATION_RUN.disclaimer, /not a score/);
  assert.match(EXAMPLE_RUN.stdout, /A101 Wool coat/);
  assert.match(EXAMPLE_RUN.stdout, /A103 Silk scarf/);
  assert.doesNotMatch(EXAMPLE_RUN.stdout, /A100/);
  assert.match(VARIATION_RUN.stdout, /R202 Cotton tee/);
  assert.match(VARIATION_RUN.stdout, /R204 Denim jacket/);
  assert.doesNotMatch(VARIATION_RUN.stdout, /R200/);
  for (const item of progress(createSession())) {
    assert.doesNotMatch(item.label, /score|grade|correct|passed/i);
  }
});

test("gates check length only and keep later steps closed", () => {
  let session = createSession();
  assert.deepEqual(allowedSteps(session), ["brief", "plan"]);
  const blocked = advance({ ...session, step: "plan" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /does not review the plan/);
  assert.equal(blocked.session.step, "plan");

  session = advance(session).session;
  assert.equal(session.step, "plan");
  session = advance({ ...session, plan: PLAN }).session;
  assert.equal(session.step, "attempt");
  const shortDraft = advance(session);
  assert.equal(shortDraft.ok, false);
  assert.match(shortDraft.message, /does not run or score/);

  session = advance({ ...session, attempt: DRAFT }).session;
  assert.equal(session.step, "check");
  assert.equal(session.exampleSeen, true);
  const unread = advance({ ...session, exampleSeen: false, expectation: EXPECTATION });
  assert.equal(unread.ok, false);
  assert.match(unread.message, /not a score/);

  session = advance({ ...session, expectation: EXPECTATION }).session;
  assert.equal(session.step, "reflect");
  session = advance({ ...session, failed: FAILED, why: WHY, fix: FIX }).session;
  assert.equal(session.step, "teach");
  assert.ok(session.explanation.includes("What went wrong"));
  const unsaved = advance({ ...session, answer: ANSWER });
  assert.equal(unsaved.ok, false);
  assert.match(unsaved.message, /does not unlock the skill tree/);
  const saved = saveLesson({ ...session, answer: "too short" });
  assert.equal(saved.ok, false);
  assert.match(saved.message, /does not grade/);
});

test("teaching saves a local note, then the variation starts with hints closed", () => {
  let session = { ...walkToTeach(), answer: ANSWER };
  const saved = saveLesson(session);
  assert.equal(saved.ok, true);
  assert.match(saved.message, /does not unlock/);
  session = advance(saved.session).session;
  assert.equal(session.step, "variation");
  assert.equal(session.mainHints, 0);
  assert.equal(session.variationHints, 0);
  const early = advance(session);
  assert.equal(early.ok, false);
  assert.match(early.message, /does not score the draft/);
  session = {
    ...session,
    variationAttempt: "import csv\nprint('n/a too')\n",
    variationNote: "I also treat n/a as missing.",
  };
  const done = advance(session);
  assert.equal(done.ok, true);
  assert.match(done.message, /skill tree is unchanged/);
  assert.equal(done.session.step, "variation");

  const note = lessonMarkdown(saved.session, "2026-11-08");
  assert.match(note, /Taught 2026-11-08/);
  assert.match(note, /not a model evaluation/);
  assert.match(note, /What went wrong: I forgot to strip the price/);
  assert.match(note, new RegExp(TEACH_QUESTION.replace(/[?]/g, "\\?")));
  assert.match(note, new RegExp(ANSWER));
  assert.match(note, /Follow the teacher's words above/);
  assert.doesNotMatch(note, /2 listings missing a price/);
  assert.doesNotMatch(note, /sys\.argv/);
});

test("stored progress rejects a forged score and clamps a skipped step", () => {
  const fresh = createSession();
  const forged = {
    ...fresh,
    step: "variation",
    lessonSaved: true,
    score: 100,
    verdict: "pass",
  };
  const parsed = parseSession(forged);
  assert.ok(parsed);
  assert.equal(parsed.step, "plan");
  assert.equal(parsed.lessonSaved, false);
  assert.equal("score" in parsed, false);
  assert.equal("verdict" in parsed, false);

  const saved = walkToTeach();
  const ready = saveLesson({ ...saved, answer: ANSWER }).session;
  const round = parseSession(JSON.parse(JSON.stringify(ready)));
  assert.deepEqual(round, ready);
  assert.equal(parseSession(null), null);
  assert.equal(parseSession([]), null);
  assert.equal(parseSession({ ...ready, version: 2 }), null);
  assert.equal(STORAGE_KEY, "dum-intern.practice.v1");
});

test("practice skills are real tree nodes, and every step has a label", () => {
  const ids = new Set(seedNodes().map((node) => node.id));
  for (const skill of RELATED_SKILLS) assert.equal(ids.has(skill.id), true);
  for (const step of STEPS) {
    assert.ok(STEP_LABEL[step]);
    assert.ok(continueLabel(step));
  }
});

test("the canned scripts match the canned stdout when python runs those files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dum-practice-py-"));
  try {
    await writeFile(join(dir, "listings.csv"), LISTINGS_CSV);
    await writeFile(join(dir, "returns.csv"), RETURNS_CSV);
    await writeFile(join(dir, "missing_prices.py"), EXAMPLE_SCRIPT.code);
    await writeFile(join(dir, "variation.py"), VARIATION_SCRIPT.code);
    const mainOut = execFileSync("python3", ["missing_prices.py", "listings.csv"], { cwd: dir, encoding: "utf8" });
    const variationOut = execFileSync("python3", ["variation.py", "returns.csv"], { cwd: dir, encoding: "utf8" });
    assert.equal(mainOut, EXAMPLE_RUN.stdout);
    assert.equal(variationOut, VARIATION_RUN.stdout);
    const variationOnBlankOnly = execFileSync("python3", ["missing_prices.py", "returns.csv"], { cwd: dir, encoding: "utf8" });
    assert.match(variationOnBlankOnly, /R201 Wool coat/);
    assert.doesNotMatch(variationOnBlankOnly, /R202/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the page serves the practice pane and the scripted module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dum-practice-http-"));
  const running = await startServer(loadConfig({
    DUM_STATE: dir,
    DUM_PACE_MS: "0",
    PORT: "0",
    HOST: "127.0.0.1",
  }));
  try {
    const home = await fetch(`${running.url}/`);
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(html, /id="practice"/);
    assert.match(html, /Scripted demo/);
    assert.match(html, /id="act-practice"/);
    assert.match(html, /id="act-desk"/);
    const app = await (await fetch(`${running.url}/app.js`)).text();
    assert.match(app, /practice\.js/);
    const script = await fetch(`${running.url}/practice.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    const source = await script.text();
    assert.match(source, /Not a live model/);
    assert.match(source, /this is not a score/i);
    assert.equal((await fetch(`${running.url}/practice.d.ts`)).status, 404);
  } finally {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function walkToTeach() {
  let session = createSession();
  session = advance(session).session;
  session = advance({ ...session, plan: PLAN }).session;
  session = advance({ ...session, attempt: DRAFT }).session;
  session = advance({ ...session, expectation: EXPECTATION }).session;
  session = advance({ ...session, failed: FAILED, why: WHY, fix: FIX }).session;
  assert.equal(session.step, "teach");
  const jumped = enter(createSession(), "teach");
  assert.equal(jumped.ok, false);
  assert.match(jumped.message, /does not review the plan/);
  return session;
}

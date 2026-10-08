import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Drafts } from "../src/desktop/draft.ts";
import type { InputBinding } from "../src/share-types.ts";

const zone = randomUUID();
const bind = (patch: Partial<InputBinding> = {}): InputBinding => ({ zoneId: zone, zoneEpoch: "e1", inputToken: "t1", requestId: "r1", ...patch });

test("draft edits are a compare-and-swap on the revision", () => {
  const drafts = new Drafts();
  const live = bind();
  assert.deepEqual(drafts.current(live), { binding: live, revision: 0, text: "", source: "keyboard", shareIds: [] });
  const one = drafts.set("hello", 0, live, live);
  assert.equal(one.revision, 1);
  assert.throws(() => drafts.set("lost update", 0, live, live), /changed while you were typing/);
  assert.equal(drafts.current(live).text, "hello", "a stale revision changes nothing");
  assert.equal(drafts.set("hello there", 1, live, live).text, "hello there");
  assert.throws(() => drafts.set("x", 2, bind({ zoneId: randomUUID() }), live), /isn't open now/, "an edit for another zone is refused");
});

test("a send needs the live binding and the revision they saw", () => {
  const drafts = new Drafts();
  const live = bind();
  drafts.set("question", 0, live, live);
  assert.throws(() => drafts.ready(bind({ inputToken: "old" }), 1, live), /nothing was sent/);
  assert.throws(() => drafts.ready(live, 0, live), /changed after you pressed Send/);
  assert.equal(drafts.ready(live, 1, live).text, "question");
  drafts.sent(live);
  const after = drafts.current(live);
  assert.equal(after.text, "");
  assert.equal(after.revision, 2, "the revision keeps counting after a send");
});

test("text written for a prompt that moved is kept but must be seen again before it sends", () => {
  const drafts = new Drafts();
  const old = bind();
  drafts.set("answer", 0, old, old);
  const moved = bind({ inputToken: "t2", requestId: "r2" });
  assert.equal(drafts.current(moved).text, "answer", "the text survives");
  assert.throws(() => drafts.ready(moved, 1, moved), /moved on after you wrote this/);
  const rebound = drafts.current(moved);
  assert.deepEqual(rebound.binding, moved);
  assert.equal(drafts.ready(moved, rebound.revision, moved).text, "answer", "once seen under the new prompt it sends");

  // An edit typed as the prompt moved is stored under the binding it was typed for.
  drafts.set("late edit", rebound.revision, old, moved);
  assert.throws(() => drafts.ready(moved, rebound.revision + 1, moved), /moved on/);
});

test("voice fills only an empty draft, only for the binding it was recorded under", () => {
  const drafts = new Drafts();
  const live = bind();
  assert.throws(() => drafts.voice("hi", bind({ zoneEpoch: "e0" }), live), /changed while you were talking/);
  assert.equal(drafts.current(live).text, "");
  const filled = drafts.voice("spoken words", live, live);
  assert.equal(filled.source, "voice");
  assert.equal(filled.text, "spoken words");
  assert.throws(() => drafts.voice("more", live, live), /isn't empty/, "voice never overwrites a draft");
  assert.equal(drafts.current(live).text, "spoken words");
});

test("shares and captures belong to one binding; a new epoch voids them but keeps the text", () => {
  const drafts = new Drafts();
  const live = bind();
  drafts.set("look at this", 0, live, live);
  drafts.share(live, "s1", true);
  drafts.share(live, "s1", true);
  drafts.capture(live, "cap");
  assert.deepEqual(drafts.current(live).shareIds, ["s1"]);
  assert.equal(drafts.current(live).captureToken, "cap");
  drafts.invalidate(zone);
  const after = drafts.current(live);
  assert.deepEqual(after.shareIds, []);
  assert.equal(after.captureToken, undefined);
  assert.equal(after.text, "look at this");
});

test("the first-run goal draft lives under a null zone and goes away once it became a zone", () => {
  const drafts = new Drafts();
  const goal: InputBinding = { zoneId: null, zoneEpoch: "g", inputToken: "idle", requestId: "r" };
  drafts.set("learn data structures", 0, goal, goal);
  assert.equal(drafts.current(goal).text, "learn data structures");
  assert.equal(drafts.current(bind()).text, "", "zones have their own drafts");
  drafts.drop([null]);
  assert.equal(drafts.current(goal).text, "");
});

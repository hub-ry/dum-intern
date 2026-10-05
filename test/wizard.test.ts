import { test } from "node:test";
import assert from "node:assert/strict";
import { byId, candidates } from "../src/anchors.ts";
import { compose, decision, screen, type Decision } from "../src/wizard.ts";

const sorting = byId("python-sorting")!;
const git = byId("git-diff")!;
const moment: Decision = { request: "sort our leaderboard by score", lang: "python" };

function line(anchor: string | null, say: string, d = moment) {
  return compose(JSON.stringify({ anchor, say }), d, [sorting]);
}

test("a supported anchor retains its primary-source link and relevant connection", () => {
  const output = line("python-sorting", "ties retain their previous order here.");
  assert.match(output!, /ties retain their previous order here/);
  assert.match(output!, /source: https:\/\/docs\.python\.org\/3\/howto\/sorting\.html$/);
  assert.match(output!, /stable/);
});

test("unknown or unoffered anchors cannot supply a fabricated citation", () => {
  assert.equal(line("invented-team-history", "a plausible sounding explanation."), null);
  assert.equal(line("git-diff", "a plausible sounding explanation."), null);
  assert.equal(compose('{"anchor":7,"say":"a claim"}', moment, [sorting]), null);
});

test("unsupported specifics narrow to the sourced mechanism", () => {
  for (const claim of [
    "guido invented this in 2002.",
    "it made sorting 3x faster.",
    "ninety percent of teams do this.",
    "my team used this in production.",
    'a founder called this "move fast".',
    "see https://unverified.example.invalid for proof.",
  ]) {
    const output = line("python-sorting", claim)!;
    assert.equal(output, `${sorting.claim}\nsource: ${sorting.url}`);
  }
});

test("user-mentioned companies are not evidence for their engineering decisions", () => {
  const d = { request: "how Netflix uses sorting, and what Acme adopted", lang: "python", paths: ["netflix.py"] };
  assert.equal(screen("netflix sorts all live events this way.", d, sorting), "");
  assert.equal(screen("acme adopted stable sorting for its architecture.", d, sorting), "");
  assert.equal(screen("since postgres already orders rows, sorting is cheap.", { ...d, request: "we use postgres" }, sorting), "");
});

test("unsupported sentences are dropped without losing a supported connection", () => {
  const output = line("python-sorting", "google discovered this in 2008. ties retain their order here.");
  assert.match(output!, /ties retain their order here/);
  assert.doesNotMatch(output!, /google|2008/);
});

test("claims about what engineers usually do narrow to the sourced mechanism", () => {
  const floats = byId("python-floats")!;
  const money: Decision = { request: "is cents-everywhere how engineers usually handle money?", lang: "python", paths: ["money.py"] };
  const say = (anchor: string | null, text: string) => compose(JSON.stringify({ anchor, say: text }), money, [floats]);
  for (const claim of [
    "yeah, integer cents or decimal are the two usual routes - same reason.",
    "most teams keep money as integer cents.",
    "engineers typically reach for decimal here.",
    "integer cents is the industry standard for money.",
    "storing cents is best practice.",
    "cents is pretty much the norm, and it's common for payment code.",
  ]) {
    assert.equal(say("python-floats", claim), `${floats.claim}\nsource: ${floats.url}`, claim);
    assert.equal(say(null, claim), null, claim);
  }
  const local = "here '12.50' becomes 1250 at load, so the report's totals add up exactly.";
  assert.equal(say("python-floats", local), `${floats.claim} ${local}\nsource: ${floats.url}`);
  assert.equal(say(null, local), local);
});

test("a convention the selected anchor itself verifies is not screened as a broad claim", () => {
  const errors = byId("go-errors")!;
  const d: Decision = { request: "should load return an error or panic on a bad row?", lang: "go" };
  const output = compose(JSON.stringify({ anchor: "go-errors", say: "conventionally returning one here lets load report the bad row." }), d, [errors]);
  assert.match(output!, /lets load report the bad row/);
  assert.match(output!, /source: https:\/\//);
});

test("language scope excludes unrelated product anchors", () => {
  const offered = candidates({ request: "sort the leaderboard", skills: ["sorting with keys"], lang: "py" });
  assert.ok(offered.some((a) => a.id === "python-sorting"));
  assert.ok(offered.every((a) => a.id !== "js-array-sort"));
  assert.ok(candidates({ request: "sort the leaderboard", paths: ["scores.rs"] }).every((a) => a.id !== "python-sorting"));
  assert.deepEqual(candidates({ request: "rename this function" }), []);
});

test("the wizard stays silent during unaided practice rather than supplying a solution", async () => {
  assert.equal(await decision({ ...moment, practice: true }), null);
  assert.equal(screen("the answer is a tuple key.", { ...moment, practice: true }, sorting), "");
  assert.equal(screen("just write `sorted(rows, key=lambda r: (-r.score, r.name))`.", { ...moment, practice: true }, sorting), "");
});

test("without an anchor unsupported history is silence, not a confident generic fallback", () => {
  assert.equal(line(null, "back when i worked at google we shipped this."), null);
  assert.equal(line(null, "this changed in 2019."), null);
  assert.equal(compose("not valid json", moment, [git]), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { byId, candidates } from "../src/anchors.ts";
import { createRegistry } from "../src/agent/registry.ts";
import { compose, decision, prompt, screen, type Decision } from "../src/wizard.ts";
import type { AgentBackend, AgentEvent, OpenOptions, Picture, Selector } from "../src/agent/types.ts";
import type { ZoneContext } from "../src/zone-types.ts";

process.env.DUM_CONTEXT = "off";

const zoneId = randomUUID();
const zone: ZoneContext = {
  id: zoneId, revision: 2, breadcrumb: [{ id: zoneId, name: "Leaderboard" }], goal: "Learn Python by building our club leaderboard",
  ancestorGoals: [], language: "python", focusSkills: [{ name: "sorting with keys", lang: "python" }], notes: [],
};
const binding = { zoneId, zoneEpoch: "epoch1", inputToken: "token1", requestId: "request1" };
const sorting = byId("python-sorting")!;
const git = byId("git-diff")!;
const moment: Decision = { zone, request: "sort our leaderboard by score", lang: "python" };

function line(anchor: string | null, say: string, d = moment) {
  return compose(JSON.stringify({ anchor, say }), d, [sorting]);
}

/** A helper backend that answers every one-shot with the next scripted reply and keeps what it was sent. */
function helper(replies: (string | Error)[], images = true) {
  const opened: OpenOptions[] = [];
  const turns: { text: string; images?: readonly Picture[] }[] = [];
  const backend: AgentBackend = {
    id: "claude",
    label: "Claude",
    models: async () => [],
    capabilities: async (selector) => ({
      model: selector.model, images, noImages: images ? "" : `${selector.model} can't see pictures`, interrupt: true, runtimeActionCheck: true,
    }),
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
  const selector: Selector = { backend: "claude", model: "helper-model", effort: null };
  agent.set({ backend: "claude", login: "anthropic-key", intern: selector, helper: selector, look: selector });
  return { agent, opened, turns };
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

test("a selected source without a concrete surviving observation stays silent", () => {
  assert.equal(line("python-sorting", ""), null);
  assert.equal(line("python-sorting", "google discovered this in 2008."), null);
});

test("unsupported specifics do not trigger an unsolicited catalog lesson", () => {
  for (const claim of [
    "guido invented this in 2002.",
    "it made sorting 3x faster.",
    "ninety percent of teams do this.",
    "my team used this in production.",
    'a founder called this "move fast".',
    "see https://unverified.example.invalid for proof.",
  ]) {
    assert.equal(line("python-sorting", claim), null);
  }
});

test("user-mentioned companies are not evidence for their engineering decisions", () => {
  const d: Decision = { zone, request: "how Netflix uses sorting, and what Acme adopted", lang: "python", paths: ["netflix.py"] };
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
  const money: Decision = { zone, request: "is cents-everywhere how engineers usually handle money?", lang: "python", paths: ["money.py"] };
  const say = (anchor: string | null, text: string) => compose(JSON.stringify({ anchor, say: text }), money, [floats]);
  for (const claim of [
    "yeah, integer cents or decimal are the two usual routes - same reason.",
    "most teams keep money as integer cents.",
    "engineers typically reach for decimal here.",
    "integer cents is the industry standard for money.",
    "storing cents is best practice.",
    "cents is pretty much the norm, and it's common for payment code.",
  ]) {
    assert.equal(say("python-floats", claim), null, claim);
    assert.equal(say(null, claim), null, claim);
  }
  const local = "here '12.50' becomes 1250 at load, so the report's totals add up exactly.";
  assert.equal(say("python-floats", local), `${floats.claim} ${local}\nsource: ${floats.url}`);
  assert.equal(say(null, local), local);
});

test("a convention the selected anchor itself verifies is not screened as a broad claim", () => {
  const errors = byId("go-errors")!;
  const d: Decision = { zone, request: "should load return an error or panic on a bad row?", lang: "go" };
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

test("without an anchor unsupported history is silence, not a confident generic fallback", () => {
  assert.equal(line(null, "back when i worked at google we shipped this."), null);
  assert.equal(line(null, "this changed in 2019."), null);
  assert.equal(compose("not valid json", moment, [git]), null);
});

test("a decision's prompt carries the zone as background, and the call goes to the chosen helper in the zone's runtime", async () => {
  const text = prompt(moment, [sorting]);
  assert.match(text, /ZONE BACKGROUND/);
  assert.match(text, /club leaderboard/);
  assert.match(text, /- python-sorting: /);
  const h = helper([JSON.stringify({ anchor: "python-sorting", say: "ties keep their earlier order here." })]);
  const out = await decision(moment, { agent: h.agent, cwd: "/h/zones/z/runtime", binding });
  assert.match(out!, /ties keep their earlier order here[\s\S]*source: https:\/\/docs\.python\.org/);
  assert.equal(h.opened[0]!.zone, zone);
  assert.equal(h.opened[0]!.cwd, "/h/zones/z/runtime");
  assert.equal(h.opened[0]!.binding, binding);
  assert.equal(h.opened[0]!.selector.model, "helper-model");
  assert.deepEqual(h.opened[0]!.actions, []);
  assert.match(h.turns[0]!.text, /ZONE BACKGROUND/);
});

test("the Wizard stays silent while they build a suggested project, and a failed call is quiet", async () => {
  const h = helper([]);
  assert.equal(await decision({ ...moment, practice: true }, { agent: h.agent, cwd: "/tmp", binding }), null);
  assert.equal(h.opened.length, 0, "no call is made at all");
  assert.equal(screen("the answer is a tuple key.", { ...moment, practice: true }, sorting), "");
  assert.equal(screen("just write `sorted(rows, key=lambda r: (-r.score, r.name))`.", { ...moment, practice: true }, sorting), "");
  const failing = helper([new Error("signed out")]);
  assert.equal(await decision(moment, { agent: failing.agent, cwd: "/tmp", binding }), null);
});

test("a sourced consequential improvement can speak without inventing an error", () => {
  const d: Decision = {
    zone,
    request: "saved leaderboard changes",
    paths: ["scores.py"],
    changes: "+ ordered = sorted(scores, key=lambda row: row.score)\n+ scores = ordered",
  };
  const output = compose(JSON.stringify({
    anchor: sorting.id,
    say: "sorting scores in place here avoids a second list if nothing needs the previous order.",
  }), d, [sorting]);
  assert.match(output!, /if nothing needs the previous order/);
  assert.match(output!, /source: https:\/\/docs\.python\.org/);
  assert.equal(compose(JSON.stringify({ anchor: sorting.id, say: "sorting scores in place avoids a second list." }), { ...d, practice: true }, [sorting]), null);
});

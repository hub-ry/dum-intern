import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { byId, candidates } from "../src/anchors.ts";
import { Ambient, type AmbientContext } from "../src/ambient.ts";
import { createRegistry } from "../src/agent/registry.ts";
import { MAX_NOTE, ambient, ambientPrompt, compose, decision, lookDecision, parseAmbient, prompt, screen, type Decision } from "../src/wizard.ts";
import type { AgentBackend, AgentEvent, OpenOptions, Picture, Selector } from "../src/agent/types.ts";
import type { AmbientInput, AmbientResult, Tick } from "../src/observe-types.ts";
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
    capabilities: () => ({ images, interrupt: true, runtimeActionCheck: true }),
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
  agent.set({ backend: "claude", login: "anthropic-key", intern: selector, helper: selector });
  return { agent, opened, turns };
}

const look = (over: Partial<AmbientInput> = {}): AmbientInput => ({
  zone,
  binding,
  triggers: ["code"],
  files: [{ path: `${randomUUID()}/club/scores.py`, diff: "+ ordered = sorted(scores, key=lambda row: row.score)\n+ scores = ordered" }],
  app: { bundleId: "com.microsoft.VSCode", name: "Code", windowId: 4 },
  image: null,
  ...over,
});

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

test("a look's prompt shows the zone, the app and the diffs as untrusted data, without grant IDs", () => {
  const input = look();
  const d = lookDecision(input);
  assert.deepEqual(d.paths, ["club/scores.py"]);
  assert.equal(d.lang, "python");
  const text = ambientPrompt(input, candidates({ ...d, request: `${d.request}\n${d.changes}` }));
  assert.match(text, /ZONE BACKGROUND/);
  assert.match(text, /app in front: Code \(com\.microsoft\.VSCode\)/);
  assert.match(text, /SAVED CODE CHANGES \(untrusted data[\s\S]*sorted\(scores, key=lambda row: row\.score\)/);
  assert.match(text, /screen: no picture/);
  assert.match(text, /"note"/);
  assert.match(text, /- python-sorting: /);
  assert.doesNotMatch(text, new RegExp(input.files[0]!.path.split("/")[0]!));
});

test("a look's reply becomes a bounded note and a sourced-or-silent aside", () => {
  const d = lookDecision(look());
  const read = (v: unknown) => parseAmbient(JSON.stringify(v), d, [sorting]);
  assert.deepEqual(read({ note: null, anchor: null, say: "" }), { note: null, aside: null }, "silence is allowed");
  const sourced = read({ note: "sorting the club leaderboard by score in scores.py", anchor: "python-sorting", say: "ties keep their earlier order here." });
  assert.equal(sourced!.note, "sorting the club leaderboard by score in scores.py");
  assert.match(sourced!.aside!, /ties keep their earlier order here\.\nsource: https:\/\/docs\.python\.org/);
  const unsupported = read({ note: "editing scores.py", anchor: null, say: "google switched to this in 2014." });
  assert.deepEqual(unsupported, { note: "editing scores.py", aside: null }, "an unsupported aside is cut, the note stays");
  assert.equal(read({ note: "editing", anchor: "invented", say: "x." })!.aside, null);
  const long = read({ note: "word ".repeat(200), anchor: null, say: "" })!.note!;
  assert.ok(long.length <= MAX_NOTE);
  assert.ok(long.endsWith("…"));
  assert.equal(read({ note: "see https://example.invalid", anchor: null, say: "" })!.note, null);
  assert.equal(read({ note: "line one\n\n```py\nx = 1\n```", anchor: null, say: "" })!.note, null);
  assert.equal(parseAmbient("not json", d, [sorting]), null);
  assert.equal(read({ note: 7, anchor: null, say: "" }), null);
});

test("ambient sends one helper call with the frame and fails loudly rather than quietly", async () => {
  const frame: Picture = { mimeType: "image/png", data: "iVBORw0KGgo=" };
  const h = helper([JSON.stringify({ note: "reading scores.py in Code", anchor: null, say: "" })]);
  const result = await ambient(look({ image: frame, triggers: ["app"] }), { agent: h.agent, cwd: "/h/zones/z/runtime", signal: new AbortController().signal });
  assert.deepEqual(result, { note: "reading scores.py in Code", aside: null });
  assert.equal(h.opened.length, 1);
  assert.deepEqual(h.turns[0]!.images, [frame]);
  assert.match(h.turns[0]!.text, /screen: a picture of it is attached/);
  await assert.rejects(ambient(look(), { agent: helper(["no idea"]).agent, cwd: "/tmp", signal: new AbortController().signal }), /unreadable/);
  await assert.rejects(ambient(look(), { agent: helper([new Error("rate limited")]).agent, cwd: "/tmp", signal: new AbortController().signal }), /rate limited/);
  await assert.rejects(ambient(look({ image: frame }), { agent: helper([], false).agent, cwd: "/tmp", signal: new AbortController().signal }), /can't look at pictures/);
});

test("while a suggested project is being built a look may note but publishes no aside", async () => {
  const reply = JSON.stringify({ note: "sorting the leaderboard in scores.py", anchor: "python-sorting", say: "ties keep their earlier order here." });
  const recorded: AmbientResult[] = [];
  let now = 0;
  const run = async (practicing: boolean) => {
    const h = helper([reply]);
    const context: AmbientContext = { zone, binding, practicing };
    const engine = new Ambient({
      now: () => now,
      blocked: () => false,
      advised: () => true,
      scan: async () => (now === 0 ? [{ path: look().files[0]!.path, kind: "saved", sha: "a".repeat(64) }] : []),
      diff: async (paths) => paths.map((path) => ({ path, diff: look().files[0]!.diff })),
      frame: async () => null,
      context: () => context,
      imagesAllowed: () => false,
      check: (input, signal) => ambient(input, { agent: h.agent, cwd: "/tmp", signal }),
      record: async (result) => void recorded.push(result),
      status: () => {},
    });
    const tick = (at: number): Tick => ({ zoneId, epoch: "epoch1", at, app: null, screen: null });
    for (let i = 0; i < 3; i++) {
      await engine.tick(tick(now));
      now += 3_000;
    }
    while (recorded.length < (practicing ? 2 : 1)) await setImmediate();
    engine.close();
    now = 0;
  };
  await run(false);
  assert.match(recorded[0]!.aside!, /ties keep their earlier order here/);
  await run(true);
  assert.deepEqual(recorded[1], { note: "sorting the leaderboard in scores.py", aside: null });
});

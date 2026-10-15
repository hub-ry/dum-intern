import { test } from "node:test";
import assert from "node:assert/strict";
import { NIGHTLY_IMAGE, runSteps, summarize } from "./check.ts";

test("steps stop at the first failure and the line names it, mentioning the owner only then", () => {
  const seen: string[] = [];
  const steps = runSteps("/repo", (cmd, args) => {
    seen.push(`${cmd} ${args[0]}`);
    return args[0] === "run" ? { ok: false, out: "x".repeat(10_000) + "TS2322" } : { ok: true, out: "" };
  });
  assert.deepEqual(steps.map((s) => [s.name, s.ok]), [["npm ci", true], ["typecheck", false]]);
  assert.deepEqual(seen, ["npm ci", "npm run"]);
  assert.ok(steps[1]!.tail.endsWith("TS2322") && steps[1]!.tail.length <= 4000);

  const failed = summarize({ sha: "abc1234", steps, log: "/l/2026-10-15.log", owner: "42" });
  assert.equal(failed.failed, true);
  assert.match(failed.content, /^<@42> nightly abc1234: npm ci ok · typecheck FAILED \(\d+s\)\. Log: \/l\/2026-10-15\.log$/);

  const ok = summarize({ sha: "abc1234", steps: steps.map((s) => ({ ...s, ok: true })), log: "/l/x.log", owner: "42" });
  assert.equal(ok.failed, false);
  assert.doesNotMatch(ok.content, /<@/);
});

test("the image is built under its own tag, never the one the service runs", () => {
  const tags: string[] = [];
  runSteps("/repo", (cmd, args) => {
    if (cmd === "docker") tags.push(args[args.indexOf("-t") + 1]!);
    return { ok: true, out: "" };
  });
  assert.deepEqual(tags, [NIGHTLY_IMAGE]);
  assert.notEqual(NIGHTLY_IMAGE, "dum-workshop-browser:1");
});

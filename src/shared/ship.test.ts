// Shipping Dum's code: AI co-author trailers never survive, credential-shaped additions stop it,
// and it never pushes over commits it doesn't have.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanMessage, credentialLines, decide } from "./ship.ts";

test("AI co-author trailers are stripped; Ryan's words stay", () => {
  const msg = ["Add an internship watcher", "", "Checks SimplifyJobs daily.", "", "Co-Authored-By: Claude Opus 5.5 <noreply" + "@anthropic.com>", "co-authored-by: Codex <codex@openai.com>", "Co-authored-by: Sam <sam@example.com>"].join("\n");
  assert.equal(cleanMessage(msg), "Add an internship watcher\n\nChecks SimplifyJobs daily.\n\nCo-authored-by: Sam <sam@example.com>");
  assert.equal(cleanMessage("Co-Authored-By: Claude <x@y>"), "");
});

test("only added lines that look like credentials stop a ship; code that handles tokens is fine", () => {
  const key = "sk-" + "a".repeat(26);
  const diff = ["+++ b/src/x.ts", `+const k = "${key}";`, `-const old = "${key}";`, "+const fine = 1;"].join("\n");
  assert.deepEqual(credentialLines(diff), [`src/x.ts: const k = "${key}";`]);
  const code = [
    "+++ b/src/bot.ts",
    "+  const token = process.env.DUM_WORKSHOP_TOKEN;",
    "+export function rest(token: string): Rest {",
    '+  return { token: readFileSync(tokenFile, "utf8").trim() };',
    '+const apiKey = "...";',
  ].join("\n");
  assert.deepEqual(credentialLines(code), [], "variables, types and expressions aren't secrets");
  const real = ["+++ b/src/config.ts", '+const API_KEY = "q8Zr2LmP0xV7nKs4Tq9w";'].join("\n");
  assert.equal(credentialLines(real).length, 1, "a literal value in real code is");
  const test = ["+++ b/src/x.test.ts", '+const TOKEN = "local-open-test-token";'].join("\n");
  assert.deepEqual(credentialLines(test), [], "a test's fake token is fine");
});

test("never pushes over GitHub commits it doesn't have; does nothing when there's nothing new", () => {
  assert.equal(decide({ behind: 2, ahead: 0, staged: true }).ok, false);
  assert.deepEqual(decide({ behind: 0, ahead: 0, staged: false }), { ok: true, commit: false, push: false });
  assert.deepEqual(decide({ behind: 0, ahead: 3, staged: false }), { ok: true, commit: false, push: true });
  assert.deepEqual(decide({ behind: 0, ahead: 0, staged: true }), { ok: true, commit: true, push: true });
});

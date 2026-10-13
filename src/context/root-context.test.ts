// Root context packing: priority order, whole files only, a named list for what doesn't fit, the
// workshop's limit always respected, and credential-looking lines never sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compose, LIMIT, parseManifest, scrub } from "./root-context.ts";

test("sources go in priority order, whole, and the rest are named", () => {
  const sources = [
    { path: "~/a.md", text: "A".repeat(100) },
    { path: "~/big.md", text: "B".repeat(5000) },
    { path: "~/c.md", text: "C".repeat(100) },
  ];
  const r = compose(sources, 3000);
  assert.deepEqual(r.included, ["~/a.md", "~/c.md"]);
  assert.deepEqual(r.omitted, ["~/big.md"]);
  assert.ok(r.text.indexOf("~/a.md") < r.text.indexOf("~/c.md"));
  assert.doesNotMatch(r.text, /BBBB/, "a file that doesn't fit is never cut in half");
  assert.match(r.text, /not included here[\s\S]*- ~\/big\.md/);
});

test("the result never exceeds the workshop's limit, even with many omitted files", () => {
  const sources = Array.from({ length: 500 }, (_, n) => ({ path: `~/context/memory/some-long-file-name-${n}.md`, text: "x".repeat(400) }));
  const r = compose(sources);
  assert.ok(r.text.length <= LIMIT, `${r.text.length}`);
  assert.ok(r.included.length > 0 && r.omitted.length > 0);
});

test("credential-looking lines are removed, ordinary text is kept", () => {
  const text = [
    "Ryan studies CS 180 this fall.",
    "DISCORD_TOKEN=" + ["MTU1ODc0MDY0Nzg4MjY2MTk0OA", "Gabcde", "abcdefghijklmnopqrstuvwxyz0123"].join("."),
    "api_key: " + "sk-" + "abcdefghijklmnopqrstuvwxyz",
    "-----BEGIN OPENSSH " + "PRIVATE KEY-----",
    "He prefers short sessions; the password manager is Strongbox.",
  ].join("\n");
  const out = scrub(text).split("\n");
  assert.equal(out[0], "Ryan studies CS 180 this fall.");
  assert.match(out[1], /line removed/);
  assert.match(out[2], /line removed/);
  assert.match(out[3], /line removed/);
  assert.equal(out[4], "He prefers short sessions; the password manager is Strongbox.");
});

test("the manifest reads globs in order, with exclusions and comments", () => {
  assert.deepEqual(parseManifest("# root\ncontext/MAIN.md\n\n!handoff/README.md\nhandoff/**/*.md\n"), {
    include: ["context/MAIN.md", "handoff/**/*.md"],
    exclude: ["handoff/README.md"],
  });
});

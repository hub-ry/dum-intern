import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as context from "../src/context.ts";

const root = mkdtempSync(`${tmpdir()}/dum-context-`);
test.after(() => rmSync(root, { recursive: true, force: true }));

test("a linked personal Markdown file loads in full and reflects later edits", () => {
  const source = `${root}/goals.md`;
  const link = `${root}/context.md`;
  writeFileSync(source, "# Goals\nBuild one beautiful city block.\n");
  symlinkSync(source, link);
  assert.equal(context.read(link).text, "# Goals\nBuild one beautiful city block.");
  writeFileSync(source, "# Goals\nDebug C++ independently.\n");
  assert.equal(context.read(link).text, "# Goals\nDebug C++ independently.");
});

test("missing and oversized context are visible, and off explicitly disables it", () => {
  assert.match(context.read(`${root}/missing.md`).warning, /couldn't read/);
  writeFileSync(`${root}/large.md`, "x".repeat(context.MAX_BYTES + 1));
  assert.equal(context.read(`${root}/large.md`).text, "");
  assert.match(context.read(`${root}/large.md`).warning, /64 KiB/);
  assert.equal(context.read("off").text, "");
});

test("context is background for suggestions, never proof of skill", () => {
  const loaded = { path: "/local/goals.md", text: "I like C++ and music.", warning: "" };
  const prompt = context.prompt(loaded);
  assert.match(prompt, /does not unlock skills/);
  assert.match(prompt, /current request takes priority/);
  assert.ok(prompt.includes(loaded.text));
  assert.equal(context.prompt({ ...loaded, text: "" }), "");
});

test("named local sources load together and relative paths are resolved beside the config", () => {
  writeFileSync(`${root}/profile.md`, "I like cities.");
  writeFileSync(`${root}/ideas.md`, "Try a terminal neighborhood.");
  const config = `${root}/context.json`;
  writeFileSync(config, JSON.stringify({ files: ["profile.md", "ideas.md"] }));
  const loaded = context.readConfigured(config);
  assert.ok(loaded.text.includes("I like cities."));
  assert.ok(loaded.text.includes("Try a terminal neighborhood."));
  assert.ok(loaded.path.includes(`${root}/ideas.md`));
  assert.equal(loaded.warning, "");
  writeFileSync(config, JSON.stringify({ files: ["profile.md", "missing.md"] }));
  assert.ok(context.readConfigured(config).text.includes("I like cities."));
  assert.match(context.readConfigured(config).warning, /missing.md/);
});

test("course examples receive the background while prerequisite constraints remain in the prompt", async () => {
  const { designPrompt } = await import("../src/course.ts");
  const file = `${root}/course-context.md`;
  writeFileSync(file, "I like music and C++.");
  const previous = process.env.DUM_CONTEXT;
  process.env.DUM_CONTEXT = file;
  try {
    const prompt = designPrompt("printing", "c++", { skills: [] }, ".dum/courses/printing.cc");
    assert.ok(prompt.includes("I like music and C++."));
    assert.ok(prompt.includes("WHAT THEY HAVE IN C++: nothing yet"));
    assert.ok(prompt.includes("Never use anything they"));
  } finally {
    if (previous === undefined) delete process.env.DUM_CONTEXT;
    else process.env.DUM_CONTEXT = previous;
  }
});

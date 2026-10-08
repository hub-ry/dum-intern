import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFlavor } from "../src/desktop/build-info.ts";

const file = (text: string | null) => {
  const path = join(mkdtempSync(join(tmpdir(), "dum-build-info-")), "build-info.json");
  if (text !== null) writeFileSync(path, text);
  return path;
};

test("a valid build-info file names the flavor", () => {
  assert.equal(readFlavor(file('{"flavor":"local"}')), "local");
  assert.equal(readFlavor(file('{"flavor":"public"}')), "public");
});

test("a missing build-info file reads as public", () => {
  assert.equal(readFlavor(file(null)), "public");
});

test("an invalid build-info file reads as public", () => {
  for (const bad of ["", "not json", "{}", '{"flavor":"owner"}', '{"flavor":"local","extra":true}', '"local"', `{"flavor":"local"${" ".repeat(5000)}}`]) {
    assert.equal(readFlavor(file(bad)), "public", bad.slice(0, 40));
  }
});

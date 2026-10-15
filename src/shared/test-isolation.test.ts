import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LOCK } from "./lock.ts";
import { DEFAULT_HANDOFF_DIR } from "./handoff.ts";

// The harness contract: no test process can see the real home, the live workshop, or Discord.
// Running this file alone (`node --import tsx --test src/shared/test-isolation.test.ts`) fails on
// purpose; `npm test` preloads src/shared/test-isolation.ts.

test("tests run under a throwaway home, never the real one", () => {
  const home = homedir();
  assert.ok(home.startsWith(tmpdir()), `HOME is ${home}, not under ${tmpdir()}`);
  assert.ok(home.includes("dum-test-home-"), `HOME is ${home}, not a dum-test-home`);
  assert.equal(process.env.DUM_WORKSHOP_HOME, join(home, "workshop"));
  // Defaults computed at import time follow it, so a forgotten explicit dir still lands in temp.
  assert.ok(DEFAULT_LOCK.startsWith(home), DEFAULT_LOCK);
  assert.ok(DEFAULT_HANDOFF_DIR.startsWith(home), DEFAULT_HANDOFF_DIR);
});

test("live-service credentials are not visible to tests", () => {
  for (const key of ["DUM_WORKSHOP_TOKEN", "DUM_WORKSHOP_HOST", "DUM_WORKSHOP_URL", "DUM_DISCORD_TOKEN_FILE", "DUM_DISCORD_GUILD_ID", "DUM_DISCORD_OWNER_ID"]) {
    assert.equal(process.env[key], undefined, key);
  }
});

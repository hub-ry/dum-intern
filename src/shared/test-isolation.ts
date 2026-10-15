// Preloaded by `npm test` (see package.json) before any test file: every test process gets a
// throwaway home. Tests already pass explicit temp dirs, but a forgotten default would otherwise
// land in the real ~/.local/state/dum-workshop and fight the running service for owner.lock, or
// post to the live Discord. This makes that impossible instead of merely discouraged.
//
// `node --test` spawns one process per file with the parent's `--import` flags, so this runs in
// each of them. The directory is removed when the process exits.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "dum-test-home-"));
const env = process.env;

// Nothing from the shell: no live workshop token or host, no Discord token file, no public notes
// root, no model executable. A test that needs one of these sets it itself.
for (const key of Object.keys(env)) {
  if (key.startsWith("DUM_")) delete env[key];
}

env.HOME = home;
env.XDG_CONFIG_HOME = join(home, ".config");
env.XDG_STATE_HOME = join(home, ".local", "state");

// Paths that have their own override, pinned under the throwaway home as well.
env.DUM_WORKSHOP_HOME = join(home, "workshop");
env.DUM_DISCORD_STATE_DIR = join(home, "discord");
env.DUM_INTERNSHIP_STATE_DIR = join(home, "internship-state");
env.DUM_INTERNSHIP_HOME = join(home, "internship");
env.DUM_GPA_STATE_DIR = join(home, "gpa");
env.DUM_REQUESTS_DIR = join(home, "requests");
env.DUM_HANDOFF_DIR = join(home, "handoff");
env.DUM_POSTS_DIR = join(home, "posts");
env.DUM_CODES_DIR = join(home, "codes");
env.DUM_CODE_LOG = join(home, "codes.md");
env.DUM_ATTACHMENTS_DIR = join(home, "attachments");

process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover temp dir is harmless.
  }
});

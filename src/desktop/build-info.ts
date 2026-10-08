// The build flavor (docs/llm-setup-design.md §8.3). tools/desktop-build.mjs writes
// dist/desktop/build-info.json beside main; main reads it once at startup. A missing or invalid
// file reads as "public", so a stray build never offers what only the owner's own build may.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BuildInfoSchema } from "../agent/schema.ts";
import type { Flavor } from "../agent/types.ts";

const MAX_FILE = 4096;

/** The flavor this build was made as. No environment variable, setting or request can change it. */
export function readFlavor(file: string = fileURLToPath(new URL("./build-info.json", import.meta.url))): Flavor {
  try {
    const text = readFileSync(file, "utf8");
    if (text.length > MAX_FILE) return "public";
    const parsed = BuildInfoSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.flavor : "public";
  } catch {
    return "public";
  }
}

// The server ships alone: deploy.sh copies only what it imports, and installs only what those
// files need. Both lists are written by hand, so this checks them against the code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);

/** Every file the server reaches through relative imports, repo-relative, and every package it names. */
function closure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string) => {
    const rel = relative(root, file);
    if (files.has(rel)) return;
    files.add(rel);
    const src = readFileSync(file, "utf8");
    for (const [, spec, typeOnly] of src.matchAll(/^import\s+(?:(type)\s+)?[^;]*?from\s+"([^"]+)"/gm).map((m) => [m[0], m[2]!, m[1]] as const)) {
      if (typeOnly) continue;
      if (spec.startsWith(".")) walk(resolve(dirname(file), spec));
      else if (!spec.startsWith("node:")) packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
    }
  };
  walk(resolve(root, entry));
  return { files, packages };
}

test("deploy.sh copies every file the server imports", () => {
  const script = readFileSync(`${root}/deploy/deploy.sh`, "utf8");
  const includes = [...script.matchAll(/--include='([^']+)'/g)].map((m) => m[1]!);
  const covered = (f: string) =>
    includes.some((p) => (p.endsWith("/***") ? `/${f}`.startsWith(p.slice(0, -3)) : `/${f}` === p));
  for (const f of closure("src/web/server.ts").files) assert.ok(covered(f), `${f} is imported by the server but not copied`);
  for (const f of ["src/web/page.html", "src/web/page.js", "src/web/page.css", "src/trees/python.yaml"]) assert.ok(covered(f), `${f} is read at runtime`);
});

test("the server's own package.json names exactly what it imports, at the lockfile's versions", () => {
  const pkg = JSON.parse(readFileSync(`${root}/deploy/server-package.json`, "utf8"));
  const lock = JSON.parse(readFileSync(`${root}/package-lock.json`, "utf8"));
  const { packages } = closure("src/web/server.ts");
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [...packages].sort());
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.equal(version, lock.packages[`node_modules/${name}`].version, `${name} drifted from package-lock.json`);
  }
  assert.equal(pkg.type, "module");
});

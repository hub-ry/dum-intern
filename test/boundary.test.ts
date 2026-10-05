// Clone a repo, run dum, and it knows what AI may do there - read from files, never guessed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deps, langs, boundary } from "../src/boundary.ts";
import { unlock, type Tree } from "../src/skills.ts";

function dir(files: Record<string, string>): string {
  const root = mkdtempSync(`${tmpdir()}/dum-boundary-`);
  for (const [name, body] of Object.entries(files)) writeFileSync(`${root}/${name}`, body);
  return root;
}

test("every manifest's dependencies are read, versions and markers stripped", () => {
  const root = dir({
    "package.json": JSON.stringify({ dependencies: { React: "^19" }, devDependencies: { typescript: "^5", vitest: "1" } }),
    "requirements.txt": "# web\nfastapi[all]>=0.110 ; python_version > '3.8'\n-r more.txt\nSQLAlchemy==2.0\n\n",
    "pyproject.toml": '[project]\nname = "x"\ndependencies = [\n  "httpx>=0.27",\n  "fastapi",\n]\n\n[tool.poetry.dependencies]\npython = "^3.12"\nrich = "*"\n',
    "Cargo.toml": '[package]\nname = "x"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\ntokio = "1"\n\n[dev-dependencies]\ninsta = "1"\n',
    "go.mod": "module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n\tgithub.com/jackc/pgx/v5 v5.5.0\n\tgolang.org/x/sys v0.1.0 // indirect\n)\n\nrequire github.com/stretchr/testify v1.9.0\n",
    "CMakeLists.txt": "find_package(Boost REQUIRED)\nfind_package( GTest )\n",
  });
  const got = deps(root, ["tsconfig.json"]).map((d) => `${d.lang}:${d.name}`);
  assert.deepEqual(got, [
    "typescript:react",
    "typescript:typescript",
    "typescript:vitest",
    "python:fastapi",
    "python:sqlalchemy",
    "python:httpx",
    "python:rich",
    "rust:serde",
    "rust:tokio",
    "go:cobra",
    "go:pgx",
    "go:testify",
    "c++:boost",
    "c++:gtest",
  ]);
});

test("broken manifests are skipped", () => {
  assert.deepEqual(deps(dir({ "package.json": "{nope" }), []), []);
});

test("the boundary says what AI writes per language and which tools you recognize", () => {
  let t: Tree = { skills: [] };
  for (const name of ["printing", "variables", "functions"]) t = unlock(t, { name, lang: "python", how: "typed", why: "" });
  t = unlock(t, { name: "fastapi", lang: "python", how: "explained", why: "web framework for the api" });
  const root = dir({ "requirements.txt": "fastapi\nsqlalchemy\n" });
  const files = ["app/main.py", "app/db.py", "web/index.ts", "README.md"];
  assert.deepEqual(langs(files), [{ lang: "python", files: 2 }, { lang: "typescript", files: 1 }]);
  const b = boundary(t, root, files);
  assert.deepEqual(b.langs[0]!.built, ["printing", "variables", "functions"]);
  assert.ok(b.langs[0]!.open.includes("arithmetic"));
  assert.deepEqual(b.tools.map((d) => [d.name, d.recognized]), [["fastapi", true], ["sqlalchemy", false]]);
});

test("revoked prerequisites close dependent permissions and practice without deleting historical builds", () => {
  let t: Tree = { skills: [] };
  for (const name of ["printing", "variables", "for loops", "list comprehensions"]) {
    t = unlock(t, { name, lang: "python", how: "typed", why: "historical build" });
  }
  const before = structuredClone(t);
  const root = dir({});
  try {
    const locked = boundary(t, root, ["app.py"]).langs[0]!;
    assert.ok(!locked.built.includes("for loops"));
    assert.ok(!locked.built.includes("list comprehensions"));
    assert.ok(!locked.open.includes("list comprehensions"));
    assert.deepEqual(t, before);
    t = unlock(t, { name: "lists", lang: "python", how: "typed", why: "prerequisite restored" });
    const restored = boundary(t, root, ["app.py"]).langs[0]!;
    assert.ok(restored.built.includes("for loops"));
    assert.ok(restored.built.includes("list comprehensions"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manifest that's a symlink out of the repo is skipped, not read", () => {
  const outside = dir({ "requirements.txt": "secretpkg\n" });
  const root = dir({ "go.mod": "module x\n\nrequire github.com/spf13/cobra v1.8.0\n" });
  symlinkSync(`${outside}/requirements.txt`, `${root}/requirements.txt`);
  assert.deepEqual(deps(root, []).map((d) => d.name), ["cobra"]);
});

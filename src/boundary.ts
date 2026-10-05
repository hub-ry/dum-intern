// What AI may do in a repo it has never seen: its languages and its dependencies, held against
// your tree. Read from the files in code - no model guesses at what a project uses.

import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";
import { Workspace } from "./workspace.ts";

/** A library or tool the repo depends on, and the manifest that says so. */
export type Dep = { name: string; lang: string; from: string };

/** The name in a requirement line: `fastapi[all]>=0.110 ; python_version>"3.8"` is fastapi. */
function pyName(spec: string): string {
  return spec.trim().split(/[\s<>=!~;\[@(]/)[0]!.toLowerCase();
}

/** The keys of one `[section]` of a TOML file, without a TOML parser for three manifests. */
function tomlKeys(text: string, section: string): string[] {
  const at = text.search(new RegExp(`^\\[${section.replace(/\./g, "\\.")}\\]\\s*$`, "m"));
  if (at < 0) return [];
  const body = text.slice(at).split("\n").slice(1);
  const out: string[] = [];
  for (const line of body) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line);
    if (m) out.push(m[1]!.toLowerCase());
  }
  return out;
}

/** Every dependency the repo's manifests name, deduplicated, in manifest order. */
export function deps(root: string, files: string[]): Dep[] {
  const out: Dep[] = [];
  const add = (name: string, lang: string, from: string) => {
    if (name && !out.some((d) => d.name === name && d.lang === lang)) out.push({ name, lang, from });
  };
  // Only these known manifests, through the workspace's checks: a symlink out of the repo, a
  // secret or an oversized file is skipped like a missing one. Only dependency names leave here.
  const ws = new Workspace(root);
  const read = (file: string) => {
    try {
      return ws.file(file).text;
    } catch {
      return null;
    }
  };
  const pkg = read("package.json");
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      const all = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
      const ts = "typescript" in all || files.includes("tsconfig.json");
      for (const n of Object.keys(all)) add(n.toLowerCase(), ts ? "typescript" : "javascript", "package.json");
    } catch {
      /* not JSON: nothing to read */
    }
  }
  const req = read("requirements.txt");
  if (req) for (const l of req.split("\n")) if (l.trim() && !/^\s*(#|-)/.test(l)) add(pyName(l), "python", "requirements.txt");
  const pyproject = read("pyproject.toml");
  if (pyproject) {
    const list = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(pyproject)?.[1] ?? "";
    for (const m of list.matchAll(/["']([^"']+)["']/g)) add(pyName(m[1]!), "python", "pyproject.toml");
    for (const k of tomlKeys(pyproject, "tool.poetry.dependencies")) if (k !== "python") add(k, "python", "pyproject.toml");
  }
  const cargo = read("Cargo.toml");
  if (cargo) for (const k of tomlKeys(cargo, "dependencies")) add(k, "rust", "Cargo.toml");
  const gomod = read("go.mod");
  if (gomod) {
    const block = /^require\s*\(([\s\S]*?)^\)/m.exec(gomod)?.[1] ?? "";
    const lines = [...block.split("\n"), ...[...gomod.matchAll(/^require\s+(\S+\s+\S+)\s*$/gm)].map((m) => m[1]!)];
    for (const l of lines) {
      const path = l.trim().split(/\s+/)[0];
      if (path && !l.includes("// indirect")) add(path.split("/").filter((p) => !/^v\d+$/.test(p)).pop()!.toLowerCase(), "go", "go.mod");
    }
  }
  const cmake = read("CMakeLists.txt");
  if (cmake) for (const m of cmake.matchAll(/find_package\s*\(\s*([A-Za-z0-9_]+)/gi)) add(m[1]!.toLowerCase(), "c++", "CMakeLists.txt");
  return out;
}

/** Source files per language, most first. */
export function langs(files: string[]): { lang: string; files: number }[] {
  const n = new Map<string, number>();
  for (const f of files) {
    const l = skills.langOf(f);
    if (l) n.set(l, (n.get(l) ?? 0) + 1);
  }
  return [...n].map(([lang, files]) => ({ lang, files })).sort((a, b) => b.files - a.files);
}

export type Boundary = {
  langs: { lang: string; files: number; built: string[]; open: string[]; done: number; total: number }[];
  tools: (Dep & { recognized: boolean })[];
};

/** What AI may do here: per language, what it writes and what's next; per dependency, whether you recognize it. */
export function boundary(t: skills.Tree, root: string, files: string[]): Boundary {
  return {
    langs: langs(files).map(({ lang, files }) => {
      const tracks = curriculum.tracks().filter((tr) => tr.lang === lang);
      const all = tracks.flatMap((tr) => tr.skills.map((n) => n.name));
      return {
        lang,
        files,
        built: all.filter((n) => curriculum.current(t, n, lang).state === "unlocked"),
        open: tracks.flatMap((tr) => curriculum.frontier(t, tr)),
        done: tracks.reduce((a, tr) => a + curriculum.progress(t, tr).done, 0),
        total: all.length,
      };
    }),
    tools: deps(root, files).map((d) => ({ ...d, recognized: curriculum.current(t, d.name, d.lang, "recognize").state === "unlocked" })),
  };
}

const MAX_TOOLS = 12;

/** The boundary as lines, for :boundary, `dum --boundary`, and the intern. */
export function lines(b: Boundary): string[] {
  const out: string[] = [];
  if (!b.langs.length && !b.tools.length) return ["no source files or manifests here yet - it's whatever you start."];
  for (const l of b.langs) {
    out.push(`${l.lang}  ${l.total ? `${curriculum.bar(l.done, l.total)}  ${l.done}/${l.total}` : "no curated track"}  · ${l.files} file${l.files === 1 ? "" : "s"}`);
    out.push(l.built.length ? `  dum may write what you've built: ${l.built.join(", ")}` : "  dum writes nothing here yet - every line of it is yours");
    if (l.open.length) out.push(`  next to practice: ${l.open.slice(0, 5).join(", ")}`);
  }
  if (b.langs.length) out.push("", "the core of whatever you build stays yours to implement");
  if (b.tools.length) {
    const from = [...new Set(b.tools.map((d) => d.from))].join(", ");
    out.push("", `tools (${from})`);
    for (const d of b.tools.slice(0, MAX_TOOLS)) out.push(d.recognized ? `  ✓ ${d.name}  dum may use it` : `  ? ${d.name}  say what it's for when a plan needs it`);
    if (b.tools.length > MAX_TOOLS) out.push(`  + ${b.tools.length - MAX_TOOLS} more`);
  }
  return out;
}

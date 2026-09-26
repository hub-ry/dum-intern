// Run scripted sessions and score them against checks and the user's taste.
//
//   npm run eval:scenarios                 every scenario
//   npm run eval:scenarios -- recommend    only names containing "recommend"
//
// Each run is a real session in a throwaway repo and DUM_HOME, so it costs
// real model calls. Results go to ~/.dum/evals/, and each run is compared
// with the last one.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import * as skills from "../src/skills.ts";
import * as taste from "../src/taste.ts";
import * as todos from "../src/todos.ts";
import { Scenario, checks, facts, judgePrompt, Verdict, type Run, type Check } from "../src/eval.ts";
import { oneShot, json } from "../src/oneshot.ts";
import { c } from "../src/lines.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DUM = join(ROOT, "bin/dum");
const TIMEOUT = 8 * 60_000;

function load(): Scenario[] {
  const dir = join(ROOT, "scenarios");
  const want = process.argv.slice(2).join(" ").toLowerCase();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => Scenario.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))))
    .filter((s) => !want || s.name.toLowerCase().includes(want));
}

/** A throwaway repo and DUM_HOME, with the scenario's tree and the user's real taste. */
function setUp(s: Scenario): { repo: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), "dum-scenario-"));
  const repo = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(repo, { recursive: true });
  for (const [p, text] of Object.entries({ "README.md": `# ${s.name}\n`, ...s.files })) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=s@dum", "-c", "user.name=scenario", "commit", "-qm", "init"], { cwd: repo });
  const tree: skills.Tree = {
    skills: s.tree.map((t) => ({
      name: t.name,
      solid: t.state !== "shaky",
      claimed: t.state === "claimed",
      breadth: "general",
      lang: t.lang ? skills.langName(t.lang) : "",
      shownIn: t.shownIn.map(skills.langName),
      requires: [],
      why: "scenario",
      repos: [],
      at: new Date().toISOString(),
    })),
  };
  mkdirSync(skills.folder(home), { recursive: true });
  skills.write(tree, home);
  if (existsSync(taste.file())) copyFileSync(taste.file(), taste.file(home));
  return { repo, home };
}

function snapshot(repo: string, skip: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      if (n === ".git" || n === ".dum") continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(repo, p);
        if (!skip.has(rel) && statSync(p).size < 200_000) out[rel] = readFileSync(p, "utf8");
      }
    }
  };
  walk(repo);
  return out;
}

/** Drive one session in plain mode, answering the way the scenario says. */
function drive(s: Scenario, repo: string, home: string): Promise<Run> {
  const seed = new Set(["README.md", ...Object.keys(s.files)]);
  return new Promise((resolve) => {
    const record = join(dirname(repo), "transcript.json");
    const p = spawn(DUM, ["-p", ...(s.mode === "anti-vibe" ? ["-a"] : []), s.request], {
      cwd: repo,
      env: { ...process.env, DUM_HOME: home, DUM_TRANSCRIPT: record },
    });
    let transcript = "";
    let buf = "";
    let written: Record<string, string> | null = null;
    let typed = false;
    let finished = false;
    const send = (line: string) => {
      transcript += `\n[DRIVER] ${line}\n`;
      p.stdin.write(line + "\n");
    };
    const done = (timedOut: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      p.kill();
      let open = 0;
      try {
        open = todos.load(repo).length;
      } catch {
        /* none */
      }
      let entries;
      try {
        entries = JSON.parse(readFileSync(record, "utf8"));
      } catch {
        /* killed before it could write it */
      }
      resolve({ transcript, entries, written: written ?? snapshot(repo, seed), openHoles: open, timedOut });
    };
    const timer = setTimeout(() => done(true), TIMEOUT);
    p.stdout.on("data", (d: Buffer) => {
      const text = d.toString().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
      transcript += text;
      buf += text;
      if (buf.includes("answer it · idk · type it") && /> $/.test(buf)) {
        buf = "";
        return send(s.answer);
      }
      if (/build this\? \[y\/N\] $/.test(buf)) {
        buf = "";
        return send(s.expect.noBuild ? "n" : "y");
      }
      if (/(›|>) $/.test(buf)) {
        written ??= snapshot(repo, seed);
        const hole = todos.load(repo)[0];
        if (s.type && hole && !typed) {
          typed = true;
          const path = join(repo, hole.path);
          const filled = todos.fill(readFileSync(path, "utf8"), hole.concept, s.type);
          if (filled !== null) writeFileSync(path, filled);
          buf = "";
          return send("done");
        }
        buf = "";
        send("exit");
        return;
      }
    });
    // Give dum a moment to write its record after "exit".
    p.on("exit", () => setTimeout(() => done(false), 200));
  });
}

async function judge(rules: string[], s: Scenario, run: Run): Promise<Verdict | null> {
  const reply = await oneShot(judgePrompt(rules, s, run), { model: "claude-sonnet-5", effort: "high" });
  const v = Verdict.safeParse(json(reply, "{"));
  return v.success ? v.data : null;
}

type Result = { name: string; checks: Check[]; facts: ReturnType<typeof facts>; verdict: Verdict | null; seconds: number; transcript: string };

async function main() {
  const list = load();
  if (!list.length) {
    console.error("no scenarios match");
    process.exit(1);
  }
  const rules = taste.read();
  const results: Result[] = [];
  for (const s of list) {
    process.stdout.write(`${c.dim("running")} ${s.name} ... `);
    const t0 = Date.now();
    const { repo, home } = setUp(s);
    const run = await drive(s, repo, home);
    const cs = checks(s, run);
    const verdict = await judge(rules, s, run);
    const r = { name: s.name, checks: cs, facts: facts(run), verdict, seconds: Math.round((Date.now() - t0) / 1000), transcript: run.transcript };
    results.push(r);
    const failed = cs.filter((x) => !x.ok);
    console.log(`${failed.length ? c.red(`${failed.length} failed`) : c.green("ok")}  ${verdict ? `taste ${verdict.score}/5` : c.dim("no verdict")}  ${c.dim(`${r.seconds}s  ${repo}`)}`);
    for (const x of failed) console.log(`    ${c.red("✗")} ${x.name}  ${c.dim(`saw ${x.saw}`)}`);
    for (const b of verdict?.broke ?? []) console.log(`    ${c.amber("·")} ${b}`);
  }

  const dir = join(skills.home(), "evals");
  mkdirSync(dir, { recursive: true });
  const prev = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().pop();
  const out = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), taste: rules, results }, null, 2));

  // Against the last run: what got better, what got worse.
  if (prev) {
    const old = JSON.parse(readFileSync(join(dir, prev), "utf8")) as { results: Result[] };
    console.log(`\n${c.dim(`vs ${prev.replace(/\.json$/, "")}`)}`);
    for (const r of results) {
      const o = old.results.find((x) => x.name === r.name);
      if (!o) continue;
      const fails = (x: Result) => x.checks.filter((k) => !k.ok).length;
      const d = (r.verdict?.score ?? 0) - (o.verdict?.score ?? 0);
      const df = fails(r) - fails(o);
      const tag = d > 0 || df < 0 ? c.green("better") : d < 0 || df > 0 ? c.red("worse") : c.dim("same");
      console.log(`  ${r.name}  ${tag}  ${c.dim(`taste ${o.verdict?.score ?? "-"} -> ${r.verdict?.score ?? "-"}, failed checks ${fails(o)} -> ${fails(r)}`)}`);
    }
  }
  const passed = results.filter((r) => r.checks.every((x) => x.ok)).length;
  console.log(`\n${passed}/${results.length} passed every check.  ${c.dim(out)}`);
}

main();

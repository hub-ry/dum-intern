// The environment you drop into.

import { argv, exit, cwd, stdout, stdin } from "node:process";
import { readRepo } from "./repo.ts";
import { run, type Mode } from "./session.ts";
import { Store } from "./store.ts";
import { banner, runPlain, Input } from "./plain.ts";
import { read as readLayout, type Node as LayoutNode } from "./layout.ts";
import * as skills from "./skills.ts";
import * as todos from "./todos.ts";
import * as scanner from "./scan.ts";
import * as projects from "./projects.ts";
import * as planner from "./planner.ts";
import { createInterface } from "node:readline/promises";
import { c, wrap } from "./lines.ts";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { basename as repo } from "node:path";

type Args = {
  mode: Mode;
  plain: boolean;
  request: string;
  show: boolean;
  forget: string | null;
  reset: boolean;
  scan: string[] | null;
  queue: string | null;
  plan: boolean;
  list: boolean;
  next: number | null;
};

function parse(args: string[]): Args {
  // `understand` is the default because the skill tree makes it affordable:
  // it asks about a mechanic once, and never again once you have explained
  // it. anti-vibe is for the session where you only want to own the intent.
  let mode: Mode = "understand";
  let plain = false;
  let show = false;
  let forget: string | null = null;
  let reset = false;
  let scan: string[] | null = null;
  let queue: string | null = null;
  let plan = false;
  let list = false;
  let next: number | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--understand" || a === "-u") mode = "understand";
    else if (a === "--anti-vibe" || a === "-a") mode = "anti-vibe";
    else if (a === "--plain" || a === "-p") plain = true;
    else if (a === "--skills" || a === "-s") show = true;
    else if (a === "--forget") forget = args.slice(i + 1).join(" ").trim();
    else if (a === "--reset") reset = true;
    else if (a === "--scan") scan = args.slice(i + 1);
    else if (a === "--queue") queue = args.slice(i + 1).join(" ").trim();
    else if (a === "--plan") plan = true;
    else if (a === "--projects") list = true;
    else if (a === "--next") {
      const n = Number(args[i + 1]);
      next = Number.isInteger(n) && n > 0 ? Math.min(n, 5) : 1;
      if (Number.isInteger(n) && n > 0) i++;
    } else rest.push(a);
    if (forget !== null || scan !== null || queue !== null) break;
  }
  return { mode, plain, request: rest.join(" ").trim(), show, forget, reset, scan, queue, plan, list, next };
}

/**
 * The tree, printed.
 *
 * Plain lines rather than a pane, so it works from anywhere and pipes cleanly.
 * Shaky and not-yet-shown skills are kept visible on purpose: the gaps are
 * the useful part of a skill tree.
 */
function printSkills(root: string) {
  const t = skills.read();
  if (!t.skills.length) {
    console.log(`\n  ${c.dim("no skills yet. explain something to dum and it lands here.")}\n`);
    return;
  }
  const { known, shaky } = skills.summary(t, root);
  const here = root ? `${known} known in ${repo(root)}` : `${t.skills.filter((s) => s.solid).length} known`;
  console.log();
  for (const r of skills.rows(t)) {
    const mark =
      r.state === "solid"
        ? c.green("●")
        : r.state === "shaky"
          ? c.amber("○")
          : r.state === "claimed"
            ? c.blue("◐")
            : c.dim("·");
    const name = r.state === "ghost" ? c.dim(r.name) : r.name;
    const tags = [r.niche ? "niche" : "", r.repeat ? "↑ above" : "", r.state === "ghost" ? "not shown yet" : ""]
      .filter(Boolean)
      .join("  ");
    console.log(`  ${"  ".repeat(r.depth)}${mark} ${name}${tags ? "  " + c.dim(tags) : ""}`);
  }
  console.log();
  const where = `${skills.folder()}/`.replace(homedir(), "~");
  const { claimed } = skills.summary(t, root);
  console.log(
    `  ${c.green("●")} ${c.dim("known")}   ${c.blue("◐")} ${c.dim("claimed")}   ${c.amber("○")} ${c.dim("shaky")}   ${c.dim("· not shown yet")}`,
  );
  console.log(`  ${c.dim(`${here}, ${claimed} claimed, ${shaky} shaky.`)}`);
  console.log(`  ${c.dim(`one note per skill in ${where} - edit them, or open the folder in Obsidian.`)}`);
  console.log();
}

/** Ask one line on the terminal. Empty string when input has ended. */
async function line(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } catch {
    return "";
  } finally {
    rl.close();
  }
}

/** Start the tree over. Asks first, and moves the old one aside rather than deleting it. */
async function resetSkills() {
  const n = skills.read().skills.length;
  if (n) {
    const ok = (await line(`\n  start your skill tree over? ${n} skill${n === 1 ? "" : "s"} get moved aside, not deleted. [y/N] `)).trim().toLowerCase();
    if (ok !== "y" && ok !== "yes") {
      console.log(`\n  ${c.dim("left it alone.")}\n`);
      return;
    }
  }
  const aside = skills.reset();
  console.log(`\n  ${c.green("✓")} fresh tree.${aside ? c.dim(` the old one is in ${aside.replace(homedir(), "~")}`) : ""}`);
  console.log(`  ${c.dim("dum --scan <folders> fills it from code you wrote yourself.")}\n`);
}

/**
 * Fill the tree from projects you say you wrote yourself.
 *
 * Nothing is written until you have seen the list and dropped what isn't
 * yours. What is kept lands as claimed, never known.
 */
async function scanSkills(dirs: string[]) {
  if (!dirs.length) {
    console.error(`\n  usage: dum --scan <folder> [more folders]   (projects you wrote yourself, without AI)\n`);
    exit(1);
  }
  let t = skills.read();
  const found: (scanner.Found & { root: string })[] = [];
  for (const d of dirs) {
    const ok = scanner.checkDir(d);
    if ("error" in ok) {
      console.error(`  ${c.red("✗")} ${ok.error}`);
      continue;
    }
    const label = ok.path.replace(homedir(), "~");
    let status = "reading";
    const draw = () => stdout.isTTY && stdout.write(`\r\x1b[2K  ${c.dim(`${label}: ${status}`)}`);
    const tick = setInterval(draw, 200);
    const got = await scanner.scan(ok.path, t, (s) => (status = s));
    clearInterval(tick);
    if (stdout.isTTY) stdout.write("\r\x1b[2K");
    console.log(`  ${c.dim(`${label}: ${got.length} found`)}`);
    for (const f of got) {
      if (!found.some((x) => skills.key(x.name) === skills.key(f.name))) found.push({ ...f, root: ok.path });
    }
  }
  // Already settled by dum - a claim changes nothing about those, so they're not offered.
  const offer = found.filter((f) => {
    const s = skills.find(t, f.name);
    return !s || s.claimed;
  });
  const settled = found.length - offer.length;
  if (settled) console.log(`  ${c.dim(`${settled} already on your tree from a session - a claim can't change ${settled === 1 ? "it" : "those"}.`)}`);
  if (!offer.length) {
    console.log(`\n  ${c.dim("nothing new to claim.")}\n`);
    return;
  }
  console.log();
  const w = String(offer.length).length;
  offer.forEach((f, i) => {
    const tag = f.breadth === "niche" ? c.dim("  niche") : "";
    console.log(`  ${c.dim(String(i + 1).padStart(w))}  ${f.name}${tag}`);
    if (f.evidence) console.log(`  ${" ".repeat(w)}  ${c.dim(f.evidence)}`);
  });
  console.log();
  console.log(`  ${c.dim("keep only what you actually own. these land as claimed: the first build that")}`);
  console.log(`  ${c.dim("leans on one gets a short check, and passing it makes it known.")}`);
  const reply = (await line(`\n  drop any? numbers like 2 5 7, enter keeps all, q cancels: `)).trim().toLowerCase();
  if (reply === "q") {
    console.log(`\n  ${c.dim("nothing written.")}\n`);
    return;
  }
  const drop = new Set(reply.split(/[\s,]+/).map(Number).filter((n) => n >= 1 && n <= offer.length));
  const keep = offer.filter((_, i) => !drop.has(i + 1));
  t = skills.read(); // re-read: another session may have written since
  for (const f of keep) {
    t = skills.claim(t, { name: f.name, breadth: f.breadth, requires: f.requires, why: `scanned ${f.root.replace(homedir(), "~")}: ${f.evidence}` }, f.root);
  }
  skills.write(t);
  console.log(`\n  ${c.blue("◐")} ${keep.length} claimed${drop.size ? c.dim(`, ${drop.size} dropped`) : ""}. ${c.dim("dum --skills shows the tree.")}\n`);
}

/** A progress line that rewrites itself on a terminal, and stays quiet in a pipe. */
function progress(label: string) {
  let status = "";
  const draw = () => stdout.isTTY && stdout.write(`\r\x1b[2K  ${c.dim(`${label}${status ? ": " + status : ""}`)}`);
  const tick = setInterval(draw, 200);
  return {
    set: (s: string) => (status = s),
    stop: () => {
      clearInterval(tick);
      if (stdout.isTTY) stdout.write("\r\x1b[2K");
    },
  };
}

/** Put a goal on the queue, as a note, and plan it. */
async function queueProject(idea: string) {
  if (!idea) {
    console.error(`\n  usage: dum --queue "what you want to build"   (or drop a .md into ${projects.folder().replace(homedir(), "~")})\n`);
    exit(1);
  }
  // Titled by its first line, cut short; the whole prompt is the body.
  const title = idea.split("\n")[0]!.replace(/[.!?]+$/, "").slice(0, 60).trim().toLowerCase();
  const note: projects.Project = { title, kind: "idea", unlocks: [], after: [], leadsTo: "", start: "", planned: "", body: idea };
  projects.write([note]);
  await planOne(note);
}

/** Plan every note in the queue that hasn't been planned - including ones written by hand. */
async function planQueue() {
  const todo = projects.read().filter((p) => projects.status(p, [], () => false) === "unplanned");
  if (!todo.length) {
    console.log(`\n  ${c.dim("nothing unplanned. dum --queue \"...\" adds a goal, dum --projects shows the queue.")}\n`);
    return;
  }
  for (const p of todo) await planOne(p);
}

async function planOne(idea: projects.Project) {
  const bar = progress(`planning ${idea.title}`);
  const got = await planner.plan(idea, skills.read(), projects.read(), bar.set);
  bar.stop();
  if (!got) {
    console.error(`\n  ${c.red("✗")} couldn't plan ${idea.title}. it's still in the queue - dum --plan tries again.\n`);
    return;
  }
  projects.write([...got.steps, got.goal]);
  const n = got.steps.length;
  console.log(
    `\n  ${c.green("✓")} ${got.goal.title}: ${
      n
        ? `${got.height} tiers above your tree, so ${n} step${n === 1 ? "" : "s"} first.`
        : "close enough to your tree to start directly."
    }`,
  );
  printProjects(got.goal.title);
}

const MARK: Record<projects.Status, string> = {
  done: c.green("✓"),
  ready: c.blue("▶"),
  waiting: c.dim("·"),
  unplanned: c.amber("?"),
};

/** The queue, each goal with its steps climbing up to it. Or just one goal. */
function printProjects(only?: string) {
  const all = projects.read();
  if (!all.length) {
    console.log(`\n  ${c.dim(`no projects yet. dum --queue "..." adds a goal, dum --next suggests one.`)}\n`);
    return;
  }
  const holds = projects.holder(skills.read());
  const st = (p: projects.Project) => projects.status(p, all, holds);
  // How many steps sit under a step, so the list climbs from the bottom.
  const depth = (p: projects.Project, seen = new Set<string>()): number => {
    if (seen.has(p.title)) return 0;
    seen.add(p.title);
    const before = p.after.map((a) => all.find((q) => skills.key(q.title) === skills.key(a))).filter(Boolean) as projects.Project[];
    return before.length ? 1 + Math.max(...before.map((q) => depth(q, seen))) : 0;
  };
  const line = (p: projects.Project, indent: string) => {
    const s = st(p);
    const unlocks = p.unlocks.length ? c.dim(`  ${p.unlocks.join(", ")}`) : "";
    console.log(`${indent}${MARK[s]} ${s === "waiting" ? c.dim(p.title) : p.title}${unlocks}`);
    if (s === "ready" && p.start) console.log(`${indent}  ${c.dim(`start: dum "${p.start}"`)}`);
  };
  console.log();
  const goals = all.filter((p) => p.kind === "goal" && (!only || skills.key(p.title) === skills.key(only)));
  for (const g of goals) {
    const steps = all.filter((p) => p.kind === "step" && skills.key(p.leadsTo) === skills.key(g.title));
    steps.sort((a, b) => depth(a) - depth(b));
    for (const s of steps) line(s, "  ");
    line(g, "  ");
    console.log();
  }
  if (!only) {
    const loose = all.filter((p) => p.kind === "idea");
    for (const p of loose) line(p, "  ");
    if (loose.length) console.log();
  }
  console.log(`  ${MARK.done} ${c.dim("done")}   ${MARK.ready} ${c.dim("ready")}   ${MARK.waiting} ${c.dim("waiting")}   ${MARK.unplanned} ${c.dim("not planned yet")}`);
  console.log(`  ${c.dim(`done means its skills are on your tree. notes in ${projects.folder().replace(homedir(), "~")}/`)}\n`);
}

/** Project ideas that unlock the next skills on the tree, fastest first. */
async function nextProjects(n: number) {
  const t = skills.read();
  const queue = projects.read();
  const targets = planner.frontier(t, queue);
  if (!targets.length) {
    console.log(`\n  ${c.dim(`nothing on the frontier yet. dum --queue "..." sets a goal to climb toward.`)}\n`);
    return;
  }
  const bar = progress(`finding the fastest unlock`);
  const got = await planner.ideas(targets, n, t, bar.set);
  bar.stop();
  if (!got) {
    console.error(`\n  ${c.red("✗")} couldn't come up with one this time. try again.\n`);
    return;
  }
  projects.write(got);
  console.log();
  for (const p of got) {
    console.log(`  ${c.blue("▶")} ${c.bold(p.title)}  ${c.dim(p.unlocks.join(", "))}`);
    for (const l of wrap(p.body.replace(/\*\*/g, ""), "    ", 76)) console.log(c.dim(l));
    if (p.start) console.log(`    start: dum "${p.start}"`);
    console.log();
  }
  console.log(`  ${c.dim("saved to the queue. make a folder, git init, and start it there.")}\n`);
}

/** The repo root, or "" outside one. */
function repoRoot(): string {
  try {
    return readRepo(cwd()).root;
  } catch {
    return "";
  }
}

async function main() {
  const { mode, plain, request: fromArgs, show, forget, reset, scan, queue, plan, list, next } = parse(argv.slice(2));

  // The tree is yours, not the repo's, so looking at it or editing it works
  // from anywhere - only "known here" needs a repo.
  if (show) return printSkills(repoRoot());
  if (reset) return resetSkills();
  if (scan !== null) return scanSkills(scan);
  if (queue !== null) return queueProject(queue);
  if (plan) return planQueue();
  if (list) return printProjects();
  if (next !== null) return nextProjects(next);
  if (forget !== null) {
    if (!forget) {
      console.error(`\n  usage: dum --forget <skill name>   (\`dum --skills\` lists them)\n`);
      exit(1);
    }
    const t = skills.read();
    const hit = skills.find(t, forget);
    if (!hit) {
      console.error(`\n  ${c.red("✗")} no skill called "${forget}". \`dum --skills\` lists them.\n`);
      exit(1);
    }
    skills.remove(hit.name);
    console.log(`\n  ${c.dim("forgot")} ${hit.name}${c.dim(". dum will ask about it again.")}\n`);
    return;
  }

  const repo = readRepo(cwd());
  const store = new Store(repo.name, mode, repo.root, repo.files);

  // A pane layout needs a terminal it can own. Without one - a pipe, a CI log,
  // `dum | less` - the line-printer is not a downgrade, it is the only thing
  // that works, and it is also how this program is scripted in a test.
  const tui = !plain && stdout.isTTY && stdin.isTTY;

  const stop = tui ? await startInk(store, readLayout(repo.root)) : startPlain(store, repo.name, mode);
  try {
    // An unfinished hole is the first thing you see on the way back in.
    const holes = todos.load(repo.root);
    if (holes.length && !fromArgs) {
      const t = holes[0]!;
      let at = 0;
      try {
        at = Math.max(0, todos.hole(readFileSync(`${repo.root}/${t.path}`, "utf8"), t.concept));
      } catch {
        /* the file went away; the review will say so */
      }
      store.setTodos(holes.map((h) => ({ concept: h.concept, path: h.path })));
      store.openFile(t.path, at);
    }
    const request =
      fromArgs ||
      (holes.length
        ? await store.askQuestion(`your turn: ${holes[0]!.concept} in ${holes[0]!.path}`, "tab into the file, type it, :w, then say done. or ask for something else.")
        : await store.askQuestion("what do you want?", "")
      ).trim();
    if (!request) {
      store.note("nothing to do.");
      return;
    }
    await run(request, repo, mode, store);
  } finally {
    stop();
  }
}

async function startInk(store: Store, layout: LayoutNode): Promise<() => void> {
  // Imported lazily so the plain path never pays to load React and Ink, which
  // matters for `dum` in a pipe and for the startup cost of `--plain`.
  const [{ render }, React, { App }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./panes/App.tsx"),
  ]);
  const app = render(React.createElement(App, { store, layout }), { exitOnCtrlC: true });
  return () => app.unmount();
}

function startPlain(store: Store, repo: string, mode: Mode): () => void {
  banner(repo, mode);
  const input = new Input();
  // Runs for the life of the process: it is a renderer, not a step. If it
  // dies, the agent is left parked on a promise nobody will ever resolve, so
  // this is fatal rather than something to log - a session that silently
  // stops answering is worse than one that says why it stopped.
  void runPlain(store, input).catch((err: Error) => {
    console.error(`\n  \x1b[38;5;167m✗\x1b[0m ${err.message}\n`);
    exit(1);
  });
  return () => input.close();
}

main().catch((err: Error) => {
  console.error(`\n  \x1b[38;5;167m✗\x1b[0m ${err.message}\n`);
  exit(1);
});

// The environment you drop into.

import { argv, exit, cwd, stdout, stdin } from "node:process";
import { readRepo } from "./repo.ts";
import { run, type Mode, type Hooks } from "./session.ts";
import { Store } from "./store.ts";
import { banner, runPlain, Input } from "./plain.ts";
import { read as readLayout, type Node as LayoutNode } from "./layout.ts";
import * as skills from "./skills.ts";
import * as todos from "./todos.ts";
import * as scanner from "./scan.ts";
import * as projects from "./projects.ts";
import * as planner from "./planner.ts";
import * as rebuild from "./rebuild.ts";
import * as graphs from "./graph.ts";
import * as learn from "./learn.ts";
import * as shell from "./shell.ts";
import { debugTo } from "./debug.ts";
import { filtered, ON as MOUSE_ON, OFF as MOUSE_OFF } from "./mouse.ts";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { c, wrap, voiceName, minutes, cap, bar } from "./lines.ts";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { basename as repo, resolve } from "node:path";

type Args = {
  mode: Mode;
  plain: boolean;
  request: string;
  show: boolean;
  forget: string | null;
  reset: boolean;
  scan: string[] | null;
  queue: string | null;
  rebuild: string[] | null;
  plan: boolean;
  list: boolean;
  next: number | null;
  graph: boolean;
  learn: string[] | null;
};

function parse(args: string[]): Args {
  // `understand` is the default: the tree means it asks about a mechanic only once.
  let mode: Mode = "understand";
  let plain = false;
  let show = false;
  let forget: string | null = null;
  let reset = false;
  let scan: string[] | null = null;
  let queue: string | null = null;
  let rebuild: string[] | null = null;
  let plan = false;
  let list = false;
  let next: number | null = null;
  let graph = false;
  let learnArgs: string[] | null = null;
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
    else if (a === "--rebuild") rebuild = args.slice(i + 1);
    else if (a === "--plan") plan = true;
    else if (a === "--projects") list = true;
    else if (a === "--graph" || a === "-g") graph = true;
    else if (a === "--learn") learnArgs = args.slice(i + 1);
    else if (a === "--next") {
      const n = Number(args[i + 1]);
      next = Number.isInteger(n) && n > 0 ? Math.min(n, 5) : 1;
      if (Number.isInteger(n) && n > 0) i++;
    } else rest.push(a);
    if (forget !== null || scan !== null || queue !== null || rebuild !== null || learnArgs !== null) break;
  }
  return { mode, plain, request: rest.join(" ").trim(), show, forget, reset, scan, queue, rebuild, plan, list, next, graph, learn: learnArgs };
}

/** The tree, printed. */
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
    const tags = [r.lang ? `${r.lang} only` : "", r.niche ? "niche" : "", r.repeat ? "↑ above" : "", r.state === "ghost" ? "not shown yet" : ""]
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

/** Start the tree over. */
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

/** Fill the tree from projects you say you wrote yourself. */
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
    const bar = progress(label, scanner.VOICE);
    bar.set("reading");
    const got = await scanner.scan(ok.path, t, bar.set);
    bar.stop();
    console.log(`  ${c.dim(`${label}: ${got.length} found  (${voiceName(scanner.VOICE.model, scanner.VOICE.effort)})`)}`);
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
function progress(label: string, voice: { model: string; effort: string }) {
  let status = "";
  const who = c.dim(`  (${voiceName(voice.model, voice.effort)})`);
  const draw = () => stdout.isTTY && stdout.write(`\r\x1b[2K  ${c.dim(`${label}${status ? ": " + status : ""}`)}${who}`);
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
  const bar = progress(`planning ${idea.title}`, planner.VOICE);
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
    const unlocks = p.unlocks.length ? c.dim(`  ${cap(p.unlocks, 3).shown.join(", ")}${p.unlocks.length > 3 ? " …" : ""}`) : "";
    const t = minutes(p.minutes);
    console.log(`${indent}${MARK[s]} ${s === "waiting" ? c.dim(p.title) : p.title}${t ? c.dim(`  ${t}`) : ""}${unlocks}`);
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

/** Read the original, queue it as a goal, and make the empty folder it's rebuilt in. */
async function rebuildProject(args: string[]) {
  const [from, to] = args;
  if (!from) {
    console.error(`\n  usage: dum --rebuild <project folder> [empty folder to rebuild it in]\n`);
    exit(1);
  }
  const ok = scanner.checkDir(from);
  if ("error" in ok) {
    console.error(`\n  ${c.red("✗")} ${ok.error}\n`);
    exit(1);
  }
  const target = resolve(to ?? rebuild.defaultTarget(ok.path));
  if (target === ok.path || target.startsWith(ok.path + "/")) {
    console.error(`\n  ${c.red("✗")} the rebuild can't live inside the original - the intern would be able to read it.\n`);
    exit(1);
  }
  const why = rebuild.prepare(target);
  if (why) {
    console.error(`\n  ${c.red("✗")} ${why}\n`);
    exit(1);
  }
  const t = skills.read();
  const bar = progress(`reading ${ok.path.replace(homedir(), "~")}`, rebuild.VOICE);
  const read = await rebuild.read(ok.path, t, bar.set);
  if (!read) {
    bar.stop();
    console.error(`\n  ${c.red("✗")} couldn't read it into a plan. try again.\n`);
    exit(1);
  }
  bar.set("planning the climb");
  const planned = await planner.plan(
    { title: read.title, body: `${read.summary}\n\nRebuilt from ${ok.path.replace(homedir(), "~")} in ${target.replace(homedir(), "~")}.` },
    t,
    projects.read(),
    bar.set,
    read,
  );
  bar.stop();
  if (planned) projects.write([...planned.steps, { ...planned.goal, start: read.milestones[0]!.request }]);
  rebuild.save(target, { source: ok.path, goal: read.title, milestones: read.milestones.map((m) => ({ ...m, done: false })) });

  printSteps(read.title, read.milestones, "milestones");
  if (planned?.steps.length) {
    console.log(`  ${c.amber("!")} ${planned.height} tiers above your tree. ${planned.steps.length} stepping stones in dum --projects, or start anyway.`);
  }
  console.log(`\n  next: ${c.bold(`cd ${target.replace(homedir(), "~")} && dum`)}   ${c.dim(`milestone 1, ${minutes(read.milestones[0]!.minutes) || "short"}`)}\n`);
}

/** A headline with the total time, then the steps, each with its minutes. */
function printSteps(title: string, steps: { request: string; minutes?: number }[], unit: string, extra = "") {
  const sum = steps.reduce((a, s) => a + (s.minutes ?? 0), 0);
  const head = [minutes(sum), `${steps.length} ${unit}`, extra].filter(Boolean).join(" · ");
  console.log(`\n  ${c.green("✓")} ${c.bold(title)}  ${c.dim(head)}\n`);
  const w = String(steps.length).length;
  for (const [i, s] of steps.entries()) {
    const t = minutes(s.minutes);
    console.log(`  ${c.dim(String(i + 1).padStart(w))}  ${s.request}${t ? c.dim(`  ${t}`) : ""}`);
  }
  console.log();
}

/** A project designed to teach one topic fast, set up to build feature by feature. */
async function learnTopic(args: string[]) {
  const [topic, to] = args;
  if (!topic?.trim()) {
    console.error(`\n  usage: dum --learn "<topic>" [folder]   (the folder defaults to ./${learn.slug("websockets")} and friends)\n`);
    exit(1);
  }
  const target = resolve(to ?? learn.slug(topic));
  const why = rebuild.prepare(target);
  if (why) {
    console.error(`\n  ${c.red("✗")} ${why}\n`);
    exit(1);
  }
  const t = skills.read();
  const bar = progress(`designing a project for ${topic}`, learn.VOICE);
  const d = await learn.design(topic, t, bar.set);
  if (!d) {
    bar.stop();
    console.error(`\n  ${c.red("✗")} couldn't design one this time. try again.\n`);
    exit(1);
  }
  bar.stop();
  const { held, missing } = learn.coverage(d.needs, t);
  // No stepping stones: a learning project handles its gaps in-project.
  projects.write([
    {
      title: d.title,
      kind: "goal",
      unlocks: missing,
      after: [],
      leadsTo: "",
      start: d.features[0]!.request,
      planned: new Date().toISOString().slice(0, 10),
      body: `${d.summary}\n\n${d.why}\n\nLearning ${topic}, in ${target.replace(homedir(), "~")}.`,
    },
  ]);
  rebuild.save(target, { source: "", topic, goal: d.title, milestones: d.features.map((f) => ({ ...f, done: false })) });

  const total = held.length + missing.length;
  const pct = total ? Math.round((held.length / total) * 100) : 0;
  printSteps(d.title, d.features, "features", `you hold ${held.length}/${total} skills (${pct}%)`);
  if (missing.length) {
    const { shown, more } = cap(missing);
    console.log(`  ${c.dim("new to you:")} ${shown.join(", ")}${more ? c.dim(` +${more} more`) : ""}`);
    console.log(`  ${c.dim("held skills get filled. new ones: type them, or explain them and they get filled.")}`);
  }
  console.log(`\n  next: ${c.bold(`cd ${target.replace(homedir(), "~")} && dum`)}   ${c.dim(`feature 1, ${minutes(d.features[0]!.minutes) || "short"}`)}\n`);
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
  const bar = progress(`finding the fastest unlock`, planner.VOICE);
  const got = await planner.ideas(targets, n, t, bar.set);
  bar.stop();
  if (!got) {
    console.error(`\n  ${c.red("✗")} couldn't come up with one this time. try again.\n`);
    return;
  }
  projects.write(got);
  console.log();
  // The win you'll see, not the pitch: the brief is in the note and the graph.
  for (const p of got) {
    const t = minutes(p.minutes);
    console.log(`  ${c.blue("▶")} ${c.bold(p.title)}${t ? c.dim(`  ${t}`) : ""}  ${c.dim(`unlocks ${p.unlocks.join(", ")}`)}`);
    const done = /\*\*done when:\*\*\s*(.+)/.exec(p.body)?.[1];
    if (done) for (const l of wrap(`done when: ${done}`, "    ", 76)) console.log(c.dim(l));
    if (p.start) console.log(`    start: dum "${p.start}"`);
    console.log();
  }
  console.log(`  ${c.dim("saved to the queue. make a folder, git init, and start it there.")}\n`);
}

/** Write the graph page and open it. Prints where it is either way. */
async function showGraph(quiet = false): Promise<string | null> {
  let out: string;
  try {
    out = await graphs.write();
  } catch (err) {
    if (!quiet) console.error(`\n  ${c.red("✗")} couldn't draw the graph: ${(err as Error).message}\n`);
    return null;
  }
  // In a pipe it's a script asking where the page is, not a person wanting a window.
  const opened = quiet || stdout.isTTY;
  if (opened) openInBrowser(out);
  if (!quiet) console.log(`\n  ${c.green("✓")} ${out.replace(homedir(), "~")}  ${c.dim(opened ? "opened in your browser" : "open it in a browser")}\n`);
  return out;
}

function openInBrowser(path: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(cmd, [path], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the path was printed; opening it is a convenience */
  }
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
  const { mode, plain, request: fromArgs, show, forget, reset, scan, queue, rebuild: rebuildArgs, plan, list, next, graph, learn: learnArgs } = parse(argv.slice(2));

  // The tree is yours, not the repo's, so looking at it or editing it works from anywhere -
  // only "known here" needs a repo.
  if (show) return printSkills(repoRoot());
  if (reset) return resetSkills();
  if (scan !== null) return scanSkills(scan);
  if (queue !== null) return queueProject(queue);
  if (rebuildArgs !== null) return rebuildProject(rebuildArgs);
  if (plan) return planQueue();
  if (list) return printProjects();
  if (next !== null) return nextProjects(next);
  if (graph) return showGraph();
  if (learnArgs !== null) return learnTopic(learnArgs);
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
  // From the first screen, not the first request: startup has bugs too.
  debugTo(repo.root);
  const store = new Store(repo.name, mode, repo.root, repo.files);
  store.onGraph = () => {
    void showGraph(true).then((out) => store.note(out ? `graph opened in your browser: ${out.replace(homedir(), "~")}` : "couldn't draw the graph."));
  };

  // A pane layout needs a terminal it can own.
  const tui = !plain && stdout.isTTY && stdin.isTTY;

  const ui = tui ? await startInk(store, readLayout(repo.root)) : null;
  const stop = ui ? ui.stop : startPlain(store, repo.name, mode);
  // `!cmd`: the panes step aside while it runs, and come back after.
  let shelling = false;
  store.onShell = (cmd) => {
    if (shelling) return;
    shelling = true;
    const go = async () => {
      const code = await shell.run(cmd, repo.root, !!ui);
      store.note(cmd ? `$ ${cmd}  (exit ${code})` : "back from the shell.");
    };
    void (ui ? ui.suspend(go) : go()).finally(() => (shelling = false));
  };
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
    // A rebuild folder offers its next milestone, and "go" takes it.
    const rb = () => rebuild.load(repo.root);
    const up = rb() && rebuild.nextUp(rb()!);
    const hooks: Hooks = rb()
      ? {
          context: () => rebuild.context(rb()),
          expand: (reply) => {
            const n = rb() && rebuild.nextUp(rb()!);
            return n && /^(go|next|ok|yes|y)[.!]*$/i.test(reply.trim()) ? n.request : reply;
          },
          onBuilt: (req) => {
            const r = rb();
            if (!r) return;
            const next = rebuild.built(r, req);
            if (next === r) return;
            rebuild.save(repo.root, next);
            store.setProgress(rebuild.progress(next));
            const done = next.milestones.filter((m) => m.done).length;
            store.note(`✓ ${next.topic ? "feature" : "milestone"} ${done} of ${next.milestones.length} ${bar(done, next.milestones.length)}  ${req}`);
          },
          suggest: () => {
            const n = rb() && rebuild.nextUp(rb()!);
            return n ? `${n.request}${n.minutes ? ` (${minutes(n.minutes)})` : ""}` : "";
          },
        }
      : {};
    if (rb()) store.setProgress(rebuild.progress(rb()!));
    let request =
      fromArgs ||
      (holes.length
        ? await store.askQuestion(`your turn: ${holes[0]!.concept} in ${holes[0]!.path}`, "tab into the file, type it, :w, and say done. or explain it here and dum fills it. or ask for something else.")
        : up
          ? await store.askQuestion(
              `next up: ${up.request}`,
              `${rb()!.topic ? "feature" : "milestone"} ${up.index + 1} of ${rb()!.milestones.length}${up.minutes ? `, ${minutes(up.minutes)}` : ""}. say go.`,
            )
          : await store.askQuestion("what do you want?", "")
      ).trim();
    if (!request) {
      store.note("nothing to do.");
      return;
    }
    if (hooks.expand && !fromArgs) request = hooks.expand(request);
    await run(request, repo, mode, store, hooks);
  } finally {
    stop();
  }
}

async function startInk(store: Store, layout: LayoutNode): Promise<{ stop: () => void; suspend: (fn: () => Promise<void>) => Promise<void> }> {
  // Imported lazily so the plain path never pays to load React and Ink, which matters for `dum`
  // in a pipe and for the startup cost of `--plain`.
  const [{ render }, React, { App }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./panes/App.tsx"),
  ]);
  // Mouse reports on, and a filtered stdin so Ink never sees them.
  const input = filtered(stdin);
  const mouseOn = () => stdout.write(MOUSE_ON);
  const mouseOff = () => stdout.write(MOUSE_OFF);
  process.on("exit", mouseOff);
  const mount = () => {
    mouseOn();
    return render(React.createElement(App, { store, layout }), { exitOnCtrlC: true, stdin: input.stdin as never });
  };
  let app = mount();
  return {
    stop: () => {
      app.unmount();
      input.close();
      mouseOff();
    },
    // Unmounting releases stdin and Node would exit mid-prompt; `hold` keeps it alive.
    suspend: async (fn) => {
      const hold = setInterval(() => {}, 1 << 30);
      app.unmount();
      mouseOff();
      await app.waitUntilExit().catch(() => {});
      stdin.ref();
      stdout.write("\x1b[2J\x1b[H");
      try {
        await fn();
      } finally {
        stdout.write("\x1b[2J\x1b[H");
        app = mount();
        clearInterval(hold);
      }
    },
  };
}

function startPlain(store: Store, repo: string, mode: Mode): () => void {
  banner(repo, mode);
  const input = new Input();
  // Runs for the life of the process: it is a renderer, not a step.
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

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
import { createInterface } from "node:readline/promises";
import { c } from "./lines.ts";
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
    else rest.push(a);
    if (forget !== null || scan !== null) break;
  }
  return { mode, plain, request: rest.join(" ").trim(), show, forget, reset, scan };
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

/** The repo root, or "" outside one. */
function repoRoot(): string {
  try {
    return readRepo(cwd()).root;
  } catch {
    return "";
  }
}

async function main() {
  const { mode, plain, request: fromArgs, show, forget, reset, scan } = parse(argv.slice(2));

  // The tree is yours, not the repo's, so looking at it or editing it works
  // from anywhere - only "known here" needs a repo.
  if (show) return printSkills(repoRoot());
  if (reset) return resetSkills();
  if (scan !== null) return scanSkills(scan);
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

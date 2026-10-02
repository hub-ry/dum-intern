// The environment you drop into.

import { argv, exit, cwd, stdout, stdin } from "node:process";
import { readRepo } from "./repo.ts";
import { run, mainLang, courseFor, type Mode } from "./session.ts";
import { Store } from "./store.ts";
import { banner, runPlain, Input } from "./plain.ts";
import { read as readLayout, type Node as LayoutNode } from "./layout.ts";
import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";
import * as boundary from "./boundary.ts";
import * as todos from "./todos.ts";
import * as shell from "./shell.ts";
import { debugTo } from "./debug.ts";
import { shell as pty } from "./pty.ts";
import { filtered, ON as MOUSE_ON, OFF as MOUSE_OFF } from "./mouse.ts";
import { createInterface } from "node:readline/promises";
import { c } from "./lines.ts";
import * as wizard from "./wizard.ts";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

type Args = {
  mode: Mode;
  plain: boolean;
  request: string;
  show: boolean;
  bounds: boolean;
  forget: string[] | null;
  reset: boolean;
  add: string[] | null;
  fresh: boolean;
};

function parse(args: string[]): Args {
  let mode: Mode = "understand";
  let plain = false;
  let show = false;
  let bounds = false;
  let forget: string[] | null = null;
  let reset = false;
  let addArgs: string[] | null = null;
  let fresh = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--understand" || a === "-u") mode = "understand";
    else if (a === "--anti-vibe" || a === "-a") mode = "anti-vibe";
    else if (a === "--plain" || a === "-p") plain = true;
    else if (a === "--skills" || a === "-s") show = true;
    else if (a === "--boundary" || a === "-b") bounds = true;
    else if (a === "--forget") forget = args.slice(i + 1);
    else if (a === "--reset") reset = true;
    else if (a === "--add") addArgs = args.slice(i + 1);
    else if (a === "--new" || a === "-n") fresh = true;
    else rest.push(a);
    if (forget !== null || addArgs !== null) break;
  }
  return { mode, plain, request: rest.join(" ").trim(), show, bounds, forget, reset, add: addArgs, fresh };
}

/** `"recursion" --in python` into a name and a language. */
function nameAndLang(args: string[]): { name: string; lang: string } {
  const at = args.indexOf("--in");
  return {
    name: (at < 0 ? args : args.slice(0, at)).join(" ").trim(),
    lang: at < 0 ? "" : skills.langName(args[at + 1] ?? ""),
  };
}

/** The languages worth drawing: whatever has something unlocked, plus where they're standing. */
function langsToShow(t: skills.Tree, root: string): string[] {
  const here = root ? mainLang(readRepo(root)) : "";
  return [...new Set([here, ...t.skills.map((s) => s.lang)].filter(Boolean))];
}

/** The tree, printed. */
function printSkills(root: string) {
  const t = skills.read();
  const langs = langsToShow(t, root);
  if (!t.skills.length && !langs.length) {
    console.log(`\n  ${c.dim("nothing unlocked yet. ask dum for something, or: dum \"course printing in python\"")}`);
    console.log(`  ${c.dim(`curated tracks: ${curriculum.languages().join(", ")}`)}\n`);
    return;
  }
  console.log();
  for (const l of curriculum.view(t, langs)) {
    const m = /^(\s*)([●◐○·]) (.*)$/.exec(l);
    if (!m) console.log(l ? `  ${c.bold(l)}` : "");
    else if (m[2] === "●") console.log(`  ${m[1]}${c.green("●")} ${m[3]!.replace(/  applied$/, c.dim("  applied"))}`);
    else if (m[2] === "◐") console.log(`  ${m[1]}${c.blue("◐")} ${m[3]!.replace(/  recognized$/, c.dim("  recognized"))}`);
    else if (m[2] === "○") console.log(`  ${m[1]}${c.blue("○")} ${m[3]!.replace(/  course open$/, c.dim("  course open"))}`);
    else console.log(`  ${m[1]}${c.dim(`· ${m[3]}`)}`);
  }
  const where = `${skills.folder()}/`.replace(homedir(), "~");
  console.log(`  ${c.green("●")} ${c.dim("built - AI writes it")}   ${c.blue("◐")} ${c.dim("recognized - AI may use it as a tool")}   ${c.blue("○")} ${c.dim("course open")}   ${c.dim("· locked")}`);
  console.log(`  ${c.dim(`one note per skill in ${where} - open the folder in Obsidian if you like.`)}`);
  console.log();
}

/** What AI may do in the repo you're standing in. */
function printBoundary() {
  const root = repoRoot();
  if (!root) {
    console.error(`\n  ${c.red("✗")} not in a git repo - the boundary is about one project.\n`);
    exit(1);
  }
  const repo = readRepo(root);
  console.log(`\n  ${c.bold(`what AI may do in ${repo.name}`)}\n`);
  for (const l of boundary.lines(boundary.boundary(skills.read(), root, repo.files))) {
    if (/^\s+✓/.test(l)) console.log(`  ${l.replace("✓", c.green("✓"))}`);
    else if (/^\s+\?/.test(l)) console.log(`  ${c.dim(l)}`);
    else if (/^\S/.test(l)) console.log(`  ${c.bold(l)}`);
    else console.log(`  ${l}`);
  }
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
  console.log(`\n  ${c.green("✓")} fresh tree.${aside ? c.dim(` the old one is in ${aside.replace(homedir(), "~")}`) : ""}\n`);
}

const RULE = "only add what you can write from a blank file, completely without AI.";

const EMPTY_TREE = [
  "Nothing's unlocked yet, so dum won't write a line of code for you.",
  "",
  "Ask for something anyway. dum shows the skills it rests on. A locked",
  "one is yours to type, or you unlock it with a short course:",
  "",
  "  course printing in python",
  "",
  "Courses go in order: recursion opens once functions are yours.",
  "",
  "Already know some things? Add them, lowest first:",
  "",
  "  :skill printing, variables, conditionals in python",
  "",
  `The rule: ${RULE}`,
].join("\n");

/** Put skills on the tree by their word, lowest first. A skill only goes on above its prerequisites. */
function addSkills(names: string, lang: string): string {
  const out: string[] = [];
  for (const raw of names.split(",").map((n) => n.trim()).filter(Boolean)) {
    const name = curriculum.canonical(raw, lang);
    const what = skills.label({ name, lang });
    const st = curriculum.status(skills.read(), name, lang);
    if (st.state === "unlocked") {
      out.push(`${what} is already unlocked.`);
      continue;
    }
    if (st.state === "locked") {
      out.push(`${what} builds on ${st.missing.join(", ")} - add ${st.missing.length === 1 ? "that" : "those"} first, if you can write ${st.missing.length === 1 ? "it" : "them"} without AI.`);
      break;
    }
    skills.write(skills.unlock(skills.read(), { name, lang, how: "added", requires: curriculum.prereqs(name, lang), why: "added by hand: can write it without AI" }));
    out.push(`+ ${what}`);
  }
  return [...out, "", `The rule: ${RULE}`].join("\n");
}

/** Take a skill off. With no language given, the only one by that name. */
function forgetSkill(name: string, lang: string): string {
  const t = skills.read();
  const hits = lang ? [skills.find(t, name, lang)].filter((s): s is skills.Skill => !!s) : skills.named(t, name);
  if (!hits.length) return `no skill called "${name}"${lang ? ` in ${lang}` : ""}.`;
  if (hits.length > 1) return `"${name}" is unlocked in ${hits.map((s) => s.lang || "no language").join(", ")} - say which: ${name} in ${hits[0]!.lang || "python"}`;
  skills.remove(hits[0]!.name, hits[0]!.lang);
  return `${skills.label(hits[0]!)} is locked again.`;
}

function printHelp() {
  const d = c.dim;
  console.log(`
  ${c.bold("dum")}                       start, inside a git repo
  ${c.bold('dum "request"')}             start with a request
  ${c.bold('dum "course x in python"')}  start with a course
  ${c.bold("dum -a")}                    anti-vibe: explain locked skills instead of typing them
  ${c.bold("dum --new")}                 a fresh intern in this repo
  ${c.bold("dum -p")}                    plain lines instead of panes

  ${d("your skill tree")}
  dum --skills              what's unlocked, open, and locked
  dum --boundary            what AI may do in this repo
  dum --add "x, y" --in c   add skills you can write without AI, lowest first
  dum --forget "x" --in c   lock one again ${d("(--reset: start over)")}

  ${d("inside dum, :help lists the rest.")}
`);
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
  if (argv.slice(2).some((a) => a === "--help" || a === "-h")) return printHelp();
  const { mode, plain, request: fromArgs, show, bounds, forget, reset, add: addArgs, fresh } = parse(argv.slice(2));

  // The tree is yours, not the repo's, so looking at it or editing it works from anywhere.
  if (show) return printSkills(repoRoot());
  if (bounds) return printBoundary();
  if (reset) return resetSkills();
  if (addArgs !== null) {
    const { name, lang } = nameAndLang(addArgs);
    if (!name) {
      console.error(`\n  usage: dum --add "<skill>, <skill>" [--in <language>]   (${RULE})\n`);
      exit(1);
    }
    console.log(`\n  ${addSkills(name, lang).split("\n").join("\n  ")}\n`);
    return;
  }
  if (forget !== null) {
    const { name, lang } = nameAndLang(forget);
    if (!name) {
      console.error(`\n  usage: dum --forget "<skill>" [--in <language>]   (\`dum --skills\` lists them)\n`);
      exit(1);
    }
    console.log(`\n  ${forgetSkill(name, lang)}\n`);
    return;
  }

  const repo = readRepo(cwd());
  // A fresh intern: its memory and any open holes moved aside, not deleted.
  if (fresh) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const f of ["session", "todos.json"]) {
      try {
        renameSync(`${repo.root}/.dum/${f}`, `${repo.root}/.dum/${f}.old-${stamp}`);
      } catch {
        /* nothing to move */
      }
    }
  }
  // From the first screen, not the first request: startup has bugs too.
  debugTo(repo.root);
  const store = new Store(repo.name, mode, repo.root, repo.files);
  store.setUnlocked(skills.read().skills.length);
  store.setModel("wizard", wizard.MODEL, wizard.EFFORT);
  store.onSkillEdit = (action, name, lang) => {
    const l = skills.langName(lang);
    const msg = action === "add" ? addSkills(name, l || mainLang(repo)) : forgetSkill(name, l);
    store.setUnlocked(skills.read().skills.length);
    store.show(action === "add" ? "added" : "forgot", msg);
  };
  store.onSkills = () => {
    const t = skills.read();
    const lines = curriculum.view(t, langsToShow(t, repo.root));
    return [...(lines.length ? lines : ["nothing unlocked yet."]), "● built   ◐ recognized   ○ course open   · locked", "course <skill> takes one."].join("\n");
  };
  store.onBoundary = () => boundary.lines(boundary.boundary(skills.read(), repo.root, repo.files)).join("\n");
  // An empty tree is where people go wrong: say how it works, once, up front. Otherwise, in a
  // repo with something in it, the first thing is what AI may do here.
  if (!skills.read().skills.length) store.show("nothing's unlocked yet", EMPTY_TREE);
  else if (!fromArgs && repo.files.some((f) => skills.langOf(f))) store.command("boundary");

  // A pane layout needs a terminal it can own.
  const tui = !plain && stdout.isTTY && stdin.isTTY;

  const ui = tui ? await startInk(store, readLayout(repo.root)) : null;
  const stop = ui ? ui.stop : startPlain(store, repo.name, mode);
  if (ui) {
    // A program in the shell (./guess asking for a number) gets what you type.
    store.onProgram = (line) => {
      if (!pty.running()) return false;
      store.showMiddle("shell");
      pty.write(line + "\r");
      return true;
    };
    store.onInterrupt = () => {
      if (pty.running()) return pty.write("\x03");
      ui.stop();
      exit(130);
    };
    setInterval(() => store.setRunning(pty.running()), 400).unref();
  }
  // In the panes, a command types into the shell page. Plain mode has no pages, so it runs the
  // command in the terminal directly.
  let shelling = false;
  store.onShell = (cmd) => {
    if (ui) {
      pty.setCwd(repo.root);
      store.openShell();
      if (cmd) pty.write(cmd + "\r");
      return;
    }
    if (shelling) return;
    shelling = true;
    void shell
      .run(cmd, repo.root, false)
      .then((code) => store.note(cmd ? `$ ${cmd}  (exit ${code})` : "back from the shell."))
      .finally(() => (shelling = false));
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
      store.setTodos(holes.map((h) => ({ concept: h.concept, path: h.path, course: courseFor(skills.read(), h) })));
      store.openFile(t.path, at);
    }
    const how = mode === "anti-vibe" ? "explain it here and dum fills it" : "tab into the file, type it, :w, and say done";
    const request =
      fromArgs ||
      (holes.length
        ? await store.askQuestion(
            `your turn: ${holes[0]!.concept} in ${holes[0]!.path}`,
            `${how}.${courseFor(skills.read(), holes[0]!) ? ` or course ${courseFor(skills.read(), holes[0]!)}.` : ""} or ask for something else.`,
            false,
          )
        : await store.askQuestion("what do you want?", "", false)
      ).trim();
    if (!request) {
      store.note("nothing to do.");
      return;
    }
    await run(request, repo, mode, store);
  } finally {
    stop();
    // For scripts: the session as entries with their kinds, not as drawn text.
    if (process.env.DUM_TRANSCRIPT) {
      try {
        writeFileSync(process.env.DUM_TRANSCRIPT, JSON.stringify(store.getSnapshot().transcript));
      } catch {
        /* nothing to keep */
      }
    }
  }
}

async function startInk(store: Store, layout: LayoutNode): Promise<{ stop: () => void }> {
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
    // ctrl-c is dum's to route: to a program in the shell, or to quit.
    return render(React.createElement(App, { store, layout }), { exitOnCtrlC: false, stdin: input.stdin as never });
  };
  const app = mount();
  return {
    stop: () => {
      app.unmount();
      input.close();
      mouseOff();
      pty.kill();
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

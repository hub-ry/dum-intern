// The environment you drop into: one conversation in your terminal, beside your own editor.

import { argv, exit, cwd } from "node:process";
import { homedir } from "node:os";
import { writeFileSync } from "node:fs";
import { readRepo } from "./repo.ts";
import { run, prepare, mainLang } from "./session.ts";
import type { Mode } from "./gate.ts";
import { Store } from "./store.ts";
import { Terminal } from "./plain.ts";
import { c, infoLines, printable } from "./lines.ts";
import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";
import * as boundary from "./boundary.ts";
import * as web from "./web.ts";
import * as todos from "./todos.ts";
import * as course from "./course.ts";
import * as wizard from "./wizard.ts";
import * as context from "./context.ts";
import * as memory from "./memory.ts";
import * as self from "./self.ts";
import { MODELS } from "./runtime.ts";
import { readState, writeState } from "./workspace.ts";
import { createInterface } from "node:readline/promises";

type Args = {
  /** Only when a flag chose one; otherwise the repo's saved mode stands. */
  mode: Mode | null;
  request: string;
  show: boolean;
  bounds: boolean;
  web: string[] | null;
  forget: string[] | null;
  reset: boolean;
  add: string[] | null;
  fresh: boolean;
  dev: boolean;
};

function parse(args: string[]): Args {
  const out: Args = { mode: null, request: "", show: false, bounds: false, web: null, forget: null, reset: false, add: null, fresh: false, dev: false };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--understand" || a === "-u") out.mode = "understand";
    else if (a === "--anti-vibe" || a === "-a") out.mode = "anti-vibe";
    // Kept for scripts and habits: there is one terminal surface, and this is it.
    else if (a === "--plain" || a === "-p") continue;
    else if (a === "--skills" || a === "-s" || a === "--tree") out.show = true;
    else if (a === "--boundary" || a === "-b") out.bounds = true;
    else if (a === "--web" || a === "-w") out.web = args.slice(i + 1);
    else if (a === "--forget") out.forget = args.slice(i + 1);
    else if (a === "--reset") out.reset = true;
    else if (a === "--add") out.add = args.slice(i + 1);
    else if (a === "--new" || a === "-n") out.fresh = true;
    else if (a === "--dev") out.dev = true;
    else rest.push(a);
    if (out.forget !== null || out.add !== null || out.web !== null) break;
  }
  out.request = rest.join(" ").trim();
  return out;
}

/** `"recursion" --in python` into a name and a language. */
function nameAndLang(args: string[]): { name: string; lang: string } {
  const at = args.indexOf("--in");
  return {
    name: (at < 0 ? args : args.slice(0, at)).join(" ").trim(),
    lang: at < 0 ? "" : skills.langName(args[at + 1] ?? ""),
  };
}

// -- the tree ---------------------------------------------------------------

/** The languages worth drawing: whatever has something on the tree, plus where they're standing. */
function langsToShow(t: skills.Tree, root: string): string[] {
  const here = root ? mainLang(readRepo(root)) : "";
  return [...new Set([here, ...t.skills.map((s) => s.lang)].filter(Boolean))];
}

/**
 * The tree as text: what you know, then each track with its levels, prerequisites and what's open
 * next. `arg` picks a language or "all"; with nothing chosen and nothing to go on, every track's
 * summary, so an empty tree still shows where to start.
 */
function treeText(t: skills.Tree, root: string, arg = ""): string {
  const want = arg.trim().toLowerCase().replace(/^in\s+/, "");
  const known = curriculum.languages();
  const lang = want && want !== "all" ? skills.langName(want) : "";
  if (lang && !known.includes(lang)) return `no curated track for "${arg.trim()}". tracks: ${known.join(", ")}.\n:tree <language> picks one; :tree all shows every track.`;
  const langs = lang ? [lang] : want === "all" ? [] : langsToShow(t, root);
  const built = t.skills.filter((s) => skills.rank(s.level) >= skills.rank("build")).length;
  const out = [t.skills.length ? `you know: ${built} built, ${t.skills.length - built} recognized only` : "you know: nothing on the tree yet", ""];
  if (want !== "all" && !langs.length) {
    for (const tr of curriculum.tracks()) {
      const p = curriculum.progress(t, tr);
      const next = curriculum.frontier(t, tr);
      out.push(`${tr.lang && tr.name !== tr.lang ? `${tr.lang} · ${tr.name}` : tr.name}  ${curriculum.bar(p.done, p.total)}  ${p.done}/${p.total}`);
      out.push(`  ○ next: ${next.slice(0, 4).join(", ") || "nothing open yet"}${next.length > 4 ? ` (+${next.length - 4})` : ""}`);
    }
    out.push("", ":tree <language> shows a track's skills, levels and prerequisites; :tree all shows them all.");
  } else out.push(...curriculum.view(t, langs, want === "all"));
  out.push(
    "",
    "● built   ◐ recognized   ○ open: its prerequisites are built   · locked",
    "AI writes a concept only once you've built it, and uses a tool once you recognize it. The project's core stays yours.",
    ":practice <skill> suggests a task for your own editor; :submit it when it's done. :skill x adds what you can already write.",
    `one note per skill in ${`${skills.folder()}/`.replace(homedir(), "~")}`,
  );
  return out.join("\n");
}

/** `dum --web [server | rotate | off]`: the private web link to your tree. */
async function webCommand(args: string[]) {
  const [arg] = args;
  try {
    if (arg === "off") {
      await web.unlink();
      console.log(`\n  ${c.dim("the web copy is gone, and the link with it. your tree here is untouched.")}\n`);
      return;
    }
    if (arg === "rotate") {
      const url = await web.rotate();
      console.log(`\n  ${c.green("✓")} new link: ${c.bold(url)}\n  ${c.dim("the old one stopped working.")}\n`);
      return;
    }
    if (arg && !web.config()) {
      const url = await web.link(arg);
      console.log(`\n  ${c.green("✓")} your tree: ${c.bold(url)}`);
      console.log(`  ${c.dim("anyone with this link can see and edit it - keep it to yourself.")}`);
      console.log(`  ${c.dim("edits there land here on the next dum, and yours go up as you unlock things.")}\n`);
      return;
    }
    const conf = web.config();
    if (!conf) {
      console.error(`\n  usage: dum --web <server>   (puts your tree on that server, at a private link)\n`);
      exit(1);
    }
    const r = await web.syncNow();
    console.log(`\n  ${c.bold(web.pageUrl(conf))}`);
    console.log(`  ${r.ok ? c.dim(r.pulled ? "synced - edits from the web are on your tree now." : "in sync.") : c.amber(`not synced: ${r.why}`)}\n`);
  } catch (err) {
    console.error(`\n  ${c.red("✗")} ${(err as Error).message}\n`);
    exit(1);
  }
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

/** Start the tree over. */
async function resetSkills() {
  const n = skills.read().skills.length;
  if (n) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let ok = "";
    try {
      ok = (await rl.question(`\n  start your skill tree over? ${n} skill${n === 1 ? "" : "s"} get moved aside, not deleted. [y/N] `)).trim().toLowerCase();
    } catch {
      /* input ended: that's a no */
    } finally {
      rl.close();
    }
    if (ok !== "y" && ok !== "yes") {
      console.log(`\n  ${c.dim("left it alone.")}\n`);
      return;
    }
  }
  const aside = skills.reset();
  console.log(`\n  ${c.green("✓")} fresh tree.${aside ? c.dim(` the old one is in ${aside.replace(homedir(), "~")}`) : ""}\n`);
}

const RULE = "only add what you can write from a blank file, completely without AI.";

// One line per paragraph: the renderer wraps to the width it has.
const EMPTY_TREE = [
  "Nothing's on your tree yet, so dum won't write code for you. It will still plan with you, read what you share, and ask about the decisions that matter.",
  "",
  ":tree shows the tracks and what's open first.",
  ":practice <skill> suggests a task to do in your own editor. When it's yours, :submit it.",
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

const HELP = `
  dum                         start, inside a git repo
  dum "request"               start with a request
  dum -a | -u                 anti-vibe or understand mode, saved for this repo
  dum --new                   a fresh intern in this repo (the old session is moved aside)
  dum -p                      accepted for scripts; the terminal is the same
  dum-dev, dum --dev          development edition: :self proposes changes to dum, :restart reloads
  dum --memory                notes remembered for this repo
  dum --context               personal background used for project suggestions

  your skill tree
  dum --skills [lang | all]   tracks, levels, prerequisites and what's open next
  dum --boundary              what AI may do in this repo
  dum --web <server>          your tree at a private link you can edit (rotate, off)
  dum --add "x, y" --in c     add skills you can write without AI, lowest first
  dum --forget "x" --in c     lock one again (--reset: start over)

  inside dum, :help lists the commands.
`;

/** The repo root, or "" outside one. */
function repoRoot(): string {
  try {
    return readRepo(cwd()).root;
  } catch {
    return "";
  }
}

// -- the repo's mode ----------------------------------------------------------

type Prefs = { mode?: Mode; explained?: boolean };

const ANTI_VIBE = [
  "anti-vibe changes how dum coaches you, not what AI may write.",
  "",
  "- Explaining a concept here counts as recognizing it. It no longer lets dum write that concept:",
  "  that needed only an explanation in earlier versions, and now it needs your build evidence",
  "  (your own unaided implementation, submitted with :submit and reviewed) in both modes.",
  "- Tools still need recognizing, and the project's core stays yours in both modes.",
  "- Skills already on your tree keep the level they have.",
  "",
  "dum -u switches this repo back to understand.",
].join("\n");

function readPrefs(root: string): Prefs {
  try {
    const raw: unknown = JSON.parse(readState(root, "preferences.json", 16 * 1024) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const mode = "mode" in raw && (raw.mode === "understand" || raw.mode === "anti-vibe") ? raw.mode : undefined;
    return { ...(mode ? { mode } : {}), ...("explained" in raw && raw.explained === true ? { explained: true } : {}) };
  } catch {
    return {};
  }
}

/**
 * The mode a flag chose, saved for next time, or the one saved before; understand by default.
 * The first anti-vibe start after the gates tightened says what changed, once, as a board.
 */
function chooseMode(root: string, flag: Mode | null): { mode: Mode; changed: boolean; explain: boolean } {
  const prefs = readPrefs(root);
  const mode = flag ?? prefs.mode ?? "understand";
  const explain = mode === "anti-vibe" && !prefs.explained;
  const next: Prefs = { ...prefs, mode, ...(explain ? { explained: true } : {}) };
  const changed = mode !== (prefs.mode ?? "understand");
  if (changed || explain || (flag && !prefs.mode)) writeState(root, "preferences.json", JSON.stringify(next, null, 2) + "\n");
  return { mode, changed, explain };
}

// -- the session ------------------------------------------------------------

async function main() {
  const argList = argv.slice(2);
  if (argList.some((a) => a === "--help" || a === "-h")) return void console.log(HELP);
  if (argList.includes("--context")) return void console.log(context.describe(context.read()));
  if (argList.includes("--memory")) return void console.log(memory.describe(readRepo(cwd()).root));
  const args = parse(argList);
  const restarted = process.env.DUM_RESTARTED === "1";
  delete process.env.DUM_RESTARTED;
  const fromArgs = restarted || args.show ? "" : args.request;

  // The tree is yours, not the repo's, so looking at it or editing it works from anywhere.
  if (args.web !== null) return webCommand(args.web);
  // Whatever was changed on the web shows up before anything is read. A server that doesn't
  // answer costs a few seconds, once.
  if (args.show || args.add !== null || args.forget !== null) await web.syncNow();
  if (args.show) {
    const text = `\n${infoLines(treeText(skills.read(), repoRoot(), args.request)).map((l) => (l ? `  ${l}` : "")).join("\n")}\n`;
    return void console.log(process.env.NO_COLOR ? printable(text) : text);
  }
  if (args.bounds) return printBoundary();
  if (args.reset) return resetSkills();
  if (args.add !== null) {
    const { name, lang } = nameAndLang(args.add);
    if (!name) {
      console.error(`\n  usage: dum --add "<skill>, <skill>" [--in <language>]   (${RULE})\n`);
      exit(1);
    }
    console.log(`\n  ${addSkills(name, lang).split("\n").join("\n  ")}\n`);
    await web.syncNow();
    return;
  }
  if (args.forget !== null) {
    const { name, lang } = nameAndLang(args.forget);
    if (!name) {
      console.error(`\n  usage: dum --forget "<skill>" [--in <language>]   (\`dum --skills\` lists them)\n`);
      exit(1);
    }
    console.log(`\n  ${forgetSkill(name, lang)}\n`);
    await web.syncNow();
    return;
  }

  const repo = readRepo(cwd());
  // A fresh intern: its memory and any open work moved aside, not deleted.
  if (args.fresh && !restarted) memory.fresh(repo.root);
  const { mode, changed, explain } = chooseMode(repo.root, args.mode);
  const personal = context.read();
  const store = new Store(repo.name, mode, repo.root, repo.files);
  const saved = memory.load(repo.root);
  store.restoreTranscript(saved.entries);
  const stopMemory = memory.attach(repo.root, store);
  store.setModel("intern", MODELS.dum.model, MODELS.dum.effort);
  store.setModel("wizard", wizard.MODEL, wizard.EFFORT);
  store.setUnlocked(skills.read().skills.length);

  let term: Terminal | null = null;
  let finished = false;
  /** Every way out goes through here, once: save, put the terminal back, leave. */
  const shutdown = (code: number): never => {
    if (!finished) {
      finished = true;
      try {
        memory.save(repo.root, store.getSnapshot().transcript);
      } catch {
        /* attach has kept it as it went */
      }
      stopMemory();
      term?.stop();
      // For scripts: the session as entries with their kinds, not as drawn text.
      if (process.env.DUM_TRANSCRIPT) {
        try {
          writeFileSync(process.env.DUM_TRANSCRIPT, JSON.stringify(store.getSnapshot().transcript));
        } catch {
          /* nothing to keep */
        }
      }
    }
    return exit(code);
  };

  store.onMemory = () => memory.describe(repo.root);
  store.onRemember = (note) => store.note(`remembered: ${memory.remember(repo.root, note)}`);
  store.onContext = () => context.describe(personal);
  store.onSkillEdit = (action, name, lang) => {
    const l = skills.langName(lang);
    const msg = action === "add" ? addSkills(name, l || mainLang(repo)) : forgetSkill(name, l);
    store.setUnlocked(skills.read().skills.length);
    web.soon();
    store.show(action === "add" ? "added" : "forgot", msg);
  };
  store.onSkills = (arg) => treeText(skills.read(), repo.root, arg);
  store.onWeb = async (server) => {
    let conf = web.config();
    if (server) {
      if (conf) return `already linked: ${web.pageUrl(conf)}\n\nUse :web without a server to sync this tree. dum --web off disconnects it before choosing another server.`;
      await web.link(server);
      conf = web.config();
    }
    if (!conf) return "not on the web yet.\n\n:web <server> connects this tree and gives you its private edit link. The practice tree is separate from your usual tree.";
    const result = await web.syncNow();
    if (result.ok && result.pulled) store.setUnlocked(skills.read().skills.length);
    const status = result.ok ? "synced - edits on the webpage are on this tree now." : `not synced: ${result.why}`;
    return `${web.pageUrl(conf)}\n\n${status}\n\nEdit skills on the page, then type :web again to use those changes here.\nAnyone with this link can see and edit your tree. dum --web rotate gives you a new one.`;
  };
  store.onBoundary = () => boundary.lines(boundary.boundary(skills.read(), repo.root, repo.files)).join("\n");
  if (args.dev) {
    store.onSelfChange = (request) => self.maintain(self.checkout, request, store);
    store.onRestart = () => shutdown(75);
  }
  // Inspection, changes, practice, submissions and git commands answer from the first prompt on.
  prepare(repo, mode, store, personal);

  term = new Terminal(store, { history: saved.entries.length, onEnd: shutdown });
  store.onLog = () => term?.log();

  if (saved.entries.length) store.note(`restored ${saved.entries.length} conversation entries - :log shows them`);
  if (saved.warning) store.note(saved.warning);
  if (args.dev) store.note(`development edition - :self proposes changes to ${self.checkout} for you to apply in your editor; :restart loads your saved changes`);
  if (personal.text) store.note(`personal context loaded: ${personal.path} - :context shows it`);
  if (personal.warning) store.note(personal.warning);
  if (changed) store.note(`mode: ${mode}, saved for this repo${mode === "anti-vibe" ? " - dum -u switches back" : " - dum -a switches to anti-vibe"}`);
  if (mode === "anti-vibe" && !explain) store.note("anti-vibe: explanations count as recognition only; AI writes a concept once you've built it, same as understand");
  // Earlier sessions' open work is still yours: said, never forced.
  const holes = todos.load(repo.root);
  if (holes.length) {
    const list = holes.slice(0, 4).map((h) => `${h.concept} in ${h.path}`).join(", ");
    store.note(`still yours from an earlier session: ${list}${holes.length > 4 ? ` (+${holes.length - 4})` : ""}. Write it in your editor, then :submit <skill> <path> --unaided.`);
  }
  const ongoing = course.active(repo.root);
  if (ongoing) store.note(`an optional course is unfinished: ${skills.label({ name: ongoing.course.skill, lang: ongoing.course.lang })}. "course ${ongoing.course.skill} in ${ongoing.course.lang}" picks it up.`);

  // An empty tree is where people go wrong: say how it works, once, up front. Otherwise, in a
  // repo with something in it, the first thing is what AI may do here.
  if (explain) store.show("anti-vibe, tightened", ANTI_VIBE);
  else if (!skills.read().skills.length) store.show("nothing's on your tree yet", EMPTY_TREE);
  else if (!fromArgs && repo.files.some((f) => skills.langOf(f))) store.command("boundary");
  // The web copy's edits come down in the background; the header catches up when they land.
  void web.syncNow().then((r) => r.ok && r.pulled && store.setUnlocked(skills.read().skills.length));

  let request = (fromArgs || (await store.askQuestion("what do you want?", "", false))).trim();
  // A maintenance request can be the first input, before opening a learning SDK session.
  while (/^:\s*self(?:\s|$)/i.test(request)) {
    const reply = await store.changeSelf(request.replace(/^:\s*self\s*/i, ""));
    if (!store.onSelfChange) store.note(reply);
    request = (await store.askNext()).trim();
  }
  if (!request) {
    store.note("nothing to do.");
    return shutdown(0);
  }
  if (["exit", "quit", ":q", "bye"].includes(request.toLowerCase())) return shutdown(0);
  try {
    await run(request, repo, mode, store, personal);
  } catch (err) {
    store.note(`✗ ${(err as Error).message}`);
    return shutdown(1);
  }
  return shutdown(0);
}

main().catch((err: Error) => {
  process.stdout.write("\n");
  console.error(`\n  \x1b[38;5;167m✗\x1b[0m ${err.message}\n`);
  exit(1);
});

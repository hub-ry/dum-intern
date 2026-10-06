// The conversation panel: setup, project choice, the conversation, its prompts, and every panel dum has.

import type { CapturePreview, CaptureSource, Panel, Reply, Request, Settings, Snapshot } from "../protocol.ts";
import type { Prompt, State } from "../../store.ts";
import type { View } from "../../web/view.ts";
import type { Mode } from "../../gate.ts";
import { h, icon, iconButton, plain, type IconName } from "./dom.ts";
import { Transcript } from "./transcript.ts";
import { SkillTree } from "./tree.ts";
import { Creature } from "./sprites.ts";

type Sheet = "info" | "tools" | "settings" | "projects" | "sources";

const PANELS: Record<Panel, { label: string; icon: IconName }> = {
  tree: { label: "Skill tree", icon: "tree" },
  memory: { label: "Memory", icon: "memory" },
  history: { label: "History", icon: "history" },
  context: { label: "Context", icon: "context" },
  evidence: { label: "Evidence", icon: "evidence" },
  boundary: { label: "Boundary", icon: "boundary" },
};

const MODES: Record<Mode, string> = {
  understand: "dum can implement with skills you've unlocked. Concepts need work you've built yourself. Tools need you to know what they're for.",
  "anti-vibe": "The same skill gates, with your approach first. Tell dum how you want it done, then delegate the unlocked parts. Explaining an approach doesn't count as building a skill.",
};

const yesNo = (q: string) => /\((?:y\/n|yes\/no)\)\s*$/i.test(q.trim());

/** A path for a `:command` argument, quoted when it has spaces. */
const quote = (p: string) => (/\s/.test(p) ? (p.includes('"') ? `'${p}'` : `"${p}"`) : p);

/** An Electron accelerator from a key press, or "" when it isn't a usable shortcut yet. */
function accelerator(e: KeyboardEvent, mac: boolean): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push(mac ? "Command" : "Super");
  let key = "";
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (e.code === "Space") key = "Space";
  else if (/^Arrow(Up|Down|Left|Right)$/.test(e.code)) key = e.code.slice(5);
  const real = e.ctrlKey || e.altKey || e.metaKey;
  return key && real ? [...mods, key].join("+") : "";
}

function shortcutText(acc: string, mac: boolean): string {
  if (!acc) return "none";
  if (!mac) return acc.replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl").replace(/\+/g, " + ");
  const sym: Record<string, string> = { Control: "⌃", Ctrl: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧", Command: "⌘", Cmd: "⌘", CommandOrControl: "⌘", CmdOrCtrl: "⌘", Super: "⌘" };
  return acc
    .split("+")
    .map((p) => sym[p] ?? p)
    .join("");
}

export function panel() {
  let snap: Snapshot | null = null;
  let preview: CapturePreview | null = null;
  let sending = false;
  /** A capture is being taken: it may hide this window for one frame, which is not the person hiding dum. */
  let capturing = false;
  let sheet: Sheet | null = null;
  let sheetReturn: HTMLElement | null = null;
  let activePanel: Panel | null = null;
  let awaiting: Panel | null = null;
  let shownStage = "";
  let dismissedStage = "";
  let shownRoot: string | null = null;
  let promptKey = "\u0000";
  let recentKey = "";
  let forceBottom = false;
  let recordingHotkey = false;

  const mac = () => snap?.platform === "darwin";

  // -- requests -------------------------------------------------------------

  const errors = h("div", { class: "errors", role: "alert" });
  const showError = (message: string) => {
    const item = h(
      "div",
      { class: "error" },
      icon("warning"),
      h("span", {}, message),
      iconButton("close", "Dismiss", () => item.remove(), "", "icon-btn tiny"),
    );
    errors.append(item);
    while (errors.childElementCount > 3) errors.firstElementChild!.remove();
  };

  async function call(request: Request, quiet = false): Promise<Reply> {
    let reply: Reply;
    try {
      reply = await window.dum.invoke(request);
    } catch (err) {
      reply = { ok: false, error: (err as Error).message || "dum didn't answer" };
    }
    if (!reply.ok && !quiet) showError(reply.error);
    if (reply.ok && reply.snapshot) apply(reply.snapshot);
    return reply;
  }

  function tierInfo(tree: View | null): { pct: number; tier: "newbie" | "intern" | "good" | "cracked"; built: number } {
    const built = tree?.usableBuilt ?? 0;
    const pct = Math.min(built / 64, 1);
    const tier = built >= 64 ? "cracked" : built >= 24 ? "good" : built >= 8 ? "intern" : "newbie";
    return { pct, tier, built };
  }

  // -- header ---------------------------------------------------------------

  const face = new Creature("dum", 3);
  const tierFill = h("div", { class: "tier-fill tier-newbie" });
  const tierBar = h("div", { class: "tier-bar", role: "progressbar", "aria-label": "Skill tier: newbie", hidden: true }, tierFill);
  const tierName = h("span", { class: "tier-name", hidden: true }, "newbie");
  const projectName = h("span", { class: "project-name" }, "no project");
  const projectBtn = h(
    "button",
    { type: "button", class: "project-btn", "aria-haspopup": "dialog", title: "Switch project", onclick: (e: Event) => openSheet("projects", e.currentTarget as HTMLElement) },
    projectName,
    icon("chevron"),
  );
  const toolsBtn = iconButton("tools", "Tools and project notes", (e) => openSheet("tools", e.currentTarget as HTMLElement));
  const treeBtn = iconButton("tree", "Open your skill tree", () => void showPanel("tree", treeBtn), "Skills", "tree-btn");
  const header = h(
    "header",
    { class: "top" },
    h("div", { class: "face" }, face.canvas),
    projectBtn,
    h("span", { class: "spacer" }),
    treeBtn,
    tierName,
    toolsBtn,
    iconButton("hide", "Hide (Esc)", () => void hide()),
    tierBar,
  );

  const panelButtons = new Map<Panel, HTMLButtonElement>([["tree", treeBtn]]);
  const projectPanels = h("nav", { class: "project-panels", "aria-label": "Project notes" });
  for (const [panelName, meta] of Object.entries(PANELS) as [Panel, (typeof PANELS)[Panel]][]) {
    if (panelName === "tree") continue;
    const btn = h("button", { type: "button", class: "panel-link", onclick: () => void showPanel(panelName, toolsBtn) }, icon(meta.icon), h("span", {}, meta.label));
    panelButtons.set(panelName, btn);
    projectPanels.append(btn);
  }
  treeBtn.setAttribute("aria-pressed", "false");
  treeBtn.setAttribute("aria-haspopup", "dialog");
  toolsBtn.setAttribute("aria-haspopup", "dialog");

  // -- setup: Claude and Git ------------------------------------------------

  const claudeStep = h("li", { class: "step" });
  const gitStep = h("li", { class: "step" });
  const runtimeMessage = h("p", { class: "runtime-message muted" });
  const codeInput = h("input", { type: "password", class: "input", autocomplete: "off", spellcheck: "false", "aria-label": "Sign-in code", placeholder: "paste the code" });
  const codeForm = h(
    "form",
    { class: "code-form" },
    h("label", { class: "field" }, h("span", {}, "If the sign-in page shows a code, paste it here"), codeInput),
    h("button", { type: "submit", class: "btn" }, "Use code"),
  );
  codeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = codeInput.value.trim();
    codeInput.value = "";
    if (code) await call({ type: "runtime-login-code", code });
  });
  const setup = h(
    "section",
    { class: "setup", hidden: true, "aria-labelledby": "setup-title" },
    h("h1", { id: "setup-title", tabindex: "-1" }, "Getting dum ready"),
    h("p", { class: "muted" }, "dum runs Claude through your own Claude subscription. It doesn't use API keys or pay-per-use billing."),
    h("ol", { class: "checklist" }, claudeStep, gitStep),
    runtimeMessage,
  );

  function stepBody(step: HTMLElement, done: boolean, title: string, ...body: (Node | null)[]) {
    step.className = `step ${done ? "done" : "todo"}`;
    step.replaceChildren(h("span", { class: "step-mark", "aria-hidden": "true" }, done ? icon("check") : h("span", { class: "step-dot" })), h("div", { class: "step-body" }, h("h2", {}, title, done ? h("span", { class: "visually-hidden" }, " - done") : null), ...body));
  }

  let setupKey = "";
  function renderSetup(s: Snapshot) {
    const rt = s.runtime;
    // Rebuilt only when something changed, so a half-pasted sign-in code keeps its focus.
    const key = JSON.stringify(rt) + s.platform;
    if (key === setupKey) return;
    setupKey = key;
    const check = h("button", { type: "button", class: "btn ghost", onclick: () => void call({ type: "runtime-check" }) }, icon("refresh"), "Check again");
    if (rt.available && rt.authenticated) stepBody(claudeStep, true, "Claude subscription", h("p", { class: "muted" }, "Signed in."));
    else if (!rt.available) {
      stepBody(
        claudeStep,
        false,
        "Claude runtime",
        h("p", {}, "dum can't start the Claude runtime it ships with. Check again, and if it still fails, reinstall dum."),
        h("div", { class: "actions" }, check),
      );
    } else if (rt.loginRunning) {
      codeForm.hidden = !rt.loginNeedsCode;
      stepBody(
        claudeStep,
        false,
        "Signing in to Claude",
        h("p", {}, "Finish signing in on Claude's page in your browser. When the browser says you're done, dum picks it up here."),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "btn", onclick: () => void call({ type: "runtime-login-open" }) }, icon("external"), "Open sign-in page"),
          h(
            "button",
            {
              type: "button",
              class: "btn ghost",
              onclick: () => {
                codeInput.value = "";
                void call({ type: "runtime-login-cancel" });
              },
            },
            "Cancel",
          ),
        ),
        codeForm,
      );
    } else {
      codeInput.value = "";
      stepBody(
        claudeStep,
        false,
        "Sign in to Claude",
        h("p", {}, "You need a Claude subscription. Signing in opens Claude's page in your browser. dum never sees your password."),
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn primary", onclick: () => void call({ type: "runtime-login" }) }, "Sign in"), check),
      );
    }
    if (rt.gitAvailable) stepBody(gitStep, true, "Git", h("p", { class: "muted" }, "Ready."));
    else if (s.platform === "darwin") {
      stepBody(
        gitStep,
        false,
        "Git",
        h("p", {}, "dum reads your project with Git. On a Mac it comes with Apple's Command Line Tools, which aren't installed yet. Installing asks you first and takes a few minutes."),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "btn primary", onclick: () => void call({ type: "git-setup" }) }, "Install project tools"),
          h("button", { type: "button", class: "btn ghost", onclick: () => void call({ type: "runtime-check" }) }, icon("refresh"), "Check again"),
        ),
      );
    } else {
      stepBody(
        gitStep,
        false,
        "Git",
        h("p", {}, "dum reads your project with Git, and it isn't installed. Install it with your system's package manager, then check again."),
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn ghost", onclick: () => void call({ type: "runtime-check" }) }, icon("refresh"), "Check again")),
      );
    }
    runtimeMessage.textContent = rt.message;
    runtimeMessage.hidden = !rt.message;
  }

  // -- project chooser ------------------------------------------------------

  const chooserList = h("ul", { class: "recent" });
  const sheetRecent = h("ul", { class: "recent" });
  const chooseFolder = () => void call({ type: "choose-project" });
  const chooser = h(
    "section",
    { class: "chooser", hidden: true, "aria-labelledby": "chooser-title" },
    h("h1", { id: "chooser-title", tabindex: "-1" }, "Pick a project"),
    h("p", { class: "muted" }, "dum works in one Git project at a time. It reads files there and proposes changes for you to apply. It doesn't overwrite your files."),
    h("button", { type: "button", class: "btn primary", onclick: chooseFolder }, icon("folder"), "Choose folder…"),
    h("h2", { class: "recent-title" }, "Recent"),
    chooserList,
  );

  function renderRecent(s: Snapshot) {
    const key = JSON.stringify(s.recentProjects) + (s.state?.root ?? "");
    if (key === recentKey) return;
    recentKey = key;
    for (const list of [chooserList, sheetRecent]) {
      list.replaceChildren(
        ...(s.recentProjects.length
          ? s.recentProjects.map((p) => {
              const current = p.root === s.state?.root;
              return h(
                "li",
                {},
                h(
                  "button",
                  {
                    type: "button",
                    class: `recent-item${current ? " current" : ""}`,
                    "aria-current": current ? "true" : null,
                    onclick: async () => {
                      if (current) return closeSheet();
                      const r = await call({ type: "open-project", root: p.root });
                      if (r.ok) closeSheet();
                    },
                  },
                  icon("folder"),
                  h("span", { class: "recent-name" }, p.name),
                  h("span", { class: "recent-root" }, h("bdi", {}, p.root)),
                ),
              );
            })
          : [h("li", { class: "muted" }, "nothing yet")]),
      );
    }
    chooser.querySelector(".recent-title")!.toggleAttribute("hidden", !s.recentProjects.length);
    chooserList.hidden = !s.recentProjects.length;
  }

  // -- conversation ---------------------------------------------------------

  const draftInto = (text: string) => {
    closeSheet();
    textarea.value = text;
    syncComposer();
    openInput();
    textarea.setSelectionRange(text.length, text.length);
  };
  const storyButtons: HTMLButtonElement[] = [];
  const storyAction = (className: string) => {
    const button = h("button", {
      type: "button",
      class: className,
      "data-action": "tell-story",
      onclick: () => draftInto(textarea.value.trim() ? textarea.value : "Here's what I built and why I made it this way:\n\n"),
    }, "Tell dum what I built");
    storyButtons.push(button);
    return button;
  };
  const transcript = new Transcript((record, path) => void call({ type: "open-record", record, path }));
  const empty = h(
    "div",
    { class: "empty" },
    h("p", {}, "Build on your own. dum can wait."),
    h("p", { class: "muted" }, "When you're satisfied, tell dum what you built and why. You can share saved files from Tools. If you want to delegate a change, ask explicitly; dum still checks your unlocked skills."),
  );
  const conversation = h("section", { class: "conversation", hidden: true }, transcript.el, empty);

  // -- sheets ---------------------------------------------------------------

  const sheetTitle = h("h2", { id: "sheet-title", tabindex: "-1" });
  const sheetBody = h("div", { class: "sheet-body" });
  const sheetEl = h(
    "section",
    { class: "sheet", hidden: true, role: "dialog", "aria-modal": "false", "aria-labelledby": "sheet-title" },
    h("div", { class: "sheet-head" }, sheetTitle, iconButton("close", "Close (Esc)", () => closeSheet())),
    sheetBody,
  );

  const tree = new SkillTree({
    practice: (arg) => void command("practice", arg),
    draftCourse: draftInto,
  });
  const infoText = h("pre", { class: "info-text" });
  const memoryExtras = h("div", { class: "memory-extras" });

  function rememberForm(): HTMLFormElement {
    const input = h("input", { class: "input", type: "text", "aria-label": "Note to remember", placeholder: "e.g. I prefer small functions", maxlength: "500" });
    const form = h("form", { class: "inline-form" }, input, h("button", { type: "submit", class: "btn" }, icon("plus"), "Remember"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const note = input.value.trim();
      if (!note) return input.focus();
      const r = await command("remember", note, false);
      if (r.ok) {
        input.value = "";
        if (activePanel === "memory") void call({ type: "panel", panel: "memory" });
      }
    });
    return form;
  }
  memoryExtras.append(
    h("h3", {}, "Add a note"),
    h("p", { class: "muted small" }, "Notes stay in this project and come back next session. They never count as evidence."),
    rememberForm(),
    h("button", { type: "button", class: "link-btn", onclick: () => void call({ type: "open-record", record: "memory" }) }, icon("external"), h("span", {}, "open the memory file to edit it")),
  );

  async function command(name: "inspect" | "changes" | "practice" | "submit" | "run" | "remember", argument: string, close = true): Promise<Reply> {
    const r = await call({ type: "command", name, argument });
    if (r.ok && close) {
      closeSheet();
      forceBottom = true;
    }
    return r;
  }

  async function showPanel(name: Panel, opener: HTMLElement) {
    activePanel = name;
    awaiting = name;
    dismissedStage = "";
    openSheet("info", opener);
    await call({ type: "panel", panel: name });
    // The panel's text is in by now, or it isn't coming: stop saying loading either way.
    if (awaiting === name) awaiting = null;
    if (sheet === "info") renderInfo();
  }

  function renderInfo() {
    const s = snap;
    const stage = s?.state?.stage;
    const title = activePanel ? PANELS[activePanel].label : stage?.kind === "info" ? stage.title : "";
    sheetTitle.textContent = title;
    for (const [n, b] of panelButtons) b.setAttribute("aria-pressed", String(sheet === "info" && n === activePanel));
    const kids: Node[] = [];
    if (activePanel === "tree" && s?.tree) {
      tree.update(s.tree);
      kids.push(tree.el);
    } else {
      if (awaiting || stage?.kind !== "info") {
        infoText.textContent = awaiting ? "loading…" : infoText.textContent || "nothing to show.";
      } else {
        infoText.textContent = plain(stage.body) || "nothing here yet.";
        if (!activePanel) sheetTitle.textContent = stage.title;
      }
      kids.push(infoText);
      if (activePanel === "memory") kids.push(memoryExtras);
    }
    // Swapping in the same nodes would reset the scroll position.
    if (sheetBody.childNodes.length !== kids.length || kids.some((k, i) => sheetBody.childNodes[i] !== k)) sheetBody.replaceChildren(...kids);
  }

  // Tools: every command a person would otherwise type.
  const provenance = h("div", { class: "provenance" });
  const runtimeDetails = h("details", { class: "runtime-details" }, h("summary", {}, "Models in this conversation"), provenance);
  const projectTools = h("div", { class: "project-tools" });
  const field = (label: string, input: HTMLElement, hint = "") => h("label", { class: "field" }, h("span", {}, label), input, hint ? h("span", { class: "hint" }, hint) : null);
  const toolsBody = (() => {
    const story = h(
      "section",
      { class: "tool" },
      storyAction("btn ghost"),
      h("p", { class: "hint" }, "Whenever you're ready. Include how it works, why you chose that approach and any files you want dum to read. This only starts a draft."),
    );
    const projects = h(
      "section",
      { class: "tool" },
      h("h3", {}, "Find a project to build"),
      h("p", { class: "hint" }, "Project ideas use your skill tree, saved memory and any personal context you've opted into. Compare them by time and difficulty; you're not limited to tiny exercises."),
      h("button", { type: "button", class: "btn ghost", "data-action": "suggest-projects", onclick: () => void command("practice", "projects") }, "Suggest projects"),
    );
    const inspectPath = h("input", { class: "input", type: "text", placeholder: "src/app.ts or src/app.ts:10-40", spellcheck: "false" });
    const inspect = h("form", { class: "tool" }, h("h3", {}, "Show dum a file"), field("Saved file", inspectPath, "dum reads what's saved on disk, not your editor's buffer."), h("button", { type: "submit", class: "btn" }, "Show it"));
    inspect.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!inspectPath.value.trim()) return inspectPath.focus();
      void command("inspect", inspectPath.value.trim()).then((r) => r.ok && (inspectPath.value = ""));
    });

    const changesPath = h("input", { class: "input", type: "text", placeholder: "optional: one path", spellcheck: "false" });
    const changes = h("form", { class: "tool" }, h("h3", {}, "Show what changed"), field("Working tree changes", changesPath), h("button", { type: "submit", class: "btn" }, "Show changes"));
    changes.addEventListener("submit", (e) => {
      e.preventDefault();
      void command("changes", changesPath.value.trim());
    });

    const practiceArg = h("input", { class: "input", type: "text", placeholder: "a skill, e.g. recursion in rust, or a task id like p1", spellcheck: "false" });
    const practice = h("form", { class: "tool" }, h("h3", {}, "Practice"), field("What to practice", practiceArg, "Leave it empty for ideas. Practice tasks are yours to write, without AI."), h("button", { type: "submit", class: "btn" }, "Get practice"));
    practice.addEventListener("submit", (e) => {
      e.preventDefault();
      void command("practice", practiceArg.value.trim());
    });

    const target = h("input", { class: "input", type: "text", placeholder: "task id (p1) or skill (recursion in rust)", spellcheck: "false" });
    const paths = h("input", { class: "input", type: "text", placeholder: "src/walk.rs, src/tree.rs", spellcheck: "false" });
    const unaided = h("input", { type: "checkbox" });
    const submit = h(
      "form",
      { class: "tool" },
      h("h3", {}, "Hand in your own work"),
      field("Task or skill", target),
      field("Files", paths, "Separate files with commas."),
      h("label", { class: "check" }, unaided, h("span", {}, "I wrote this myself, without AI help or copied code")),
      h("p", { class: "hint" }, "A review alone never builds a skill. It takes your word here and a passing review."),
      h("button", { type: "submit", class: "btn" }, "Hand it in"),
    );
    submit.addEventListener("submit", (e) => {
      e.preventDefault();
      const files = paths.value.split(",").map((p) => p.trim()).filter(Boolean);
      if (!target.value.trim()) return target.focus();
      if (!files.length) return paths.focus();
      const arg = `${target.value.trim()} ${files.map(quote).join(" ")}${unaided.checked ? " --unaided" : ""}`;
      void command("submit", arg).then((r) => {
        if (!r.ok) return;
        target.value = "";
        paths.value = "";
        unaided.checked = false;
      });
    });

    const git = h(
      "div",
      { class: "tool" },
      h("h3", {}, "Git, read-only"),
      h("p", { class: "hint" }, "dum sees the output too. It can't run anything else."),
      h("div", { class: "actions" }, ...(["status", "diff", "log"] as const).map((g) => h("button", { type: "button", class: "btn ghost", onclick: () => void command("run", g) }, `git ${g}`))),
    );

    const remember = h("div", { class: "tool" }, h("h3", {}, "Remember a note"), rememberForm());
    const projectNotes = h("section", { class: "tool" }, h("h3", {}, "Project notes"), projectPanels);
    const appDetails = h(
      "section",
      { class: "tool" },
      h("button", { type: "button", class: "btn ghost", onclick: () => openSheet("settings", toolsBtn) }, icon("gear"), "Settings"),
      runtimeDetails,
    );
    projectTools.append(story, projects, projectNotes, inspect, changes, practice, submit, git, remember);
    return h("div", { class: "tools" }, appDetails, projectTools);
  })();

  // Settings: the window, privacy, the project's mode, Claude.
  const hotkeyInput = h("input", { class: "input hotkey", type: "text", readonly: true, "aria-label": "Shortcut to show or hide dum", "aria-describedby": "hotkey-hint" });
  const hotkeyHint = h("span", { id: "hotkey-hint", class: "hint" }, "Click, then press the new shortcut. It needs ⌘, ⌃ or ⌥.");
  const hotkeyError = h("p", { class: "hint error-text", role: "alert" });
  const toggles: Record<"alwaysOnTop" | "allWorkspaces" | "launchAtLogin" | "personalContext" | "wizardAdvice", HTMLInputElement> = {
    alwaysOnTop: h("input", { type: "checkbox" }),
    allWorkspaces: h("input", { type: "checkbox" }),
    launchAtLogin: h("input", { type: "checkbox" }),
    personalContext: h("input", { type: "checkbox" }),
    wizardAdvice: h("input", { type: "checkbox", id: "wizard-advice", "aria-describedby": "wizard-advice-hint wizard-advice-status" }),
  };
  const wizardSourceSelect = h("select", { class: "input", id: "wizard-source", "aria-label": "Wizard watches" },
    h("option", { value: "screen" }, "your screen"),
    h("option", { value: "files" }, "saved file changes"),
  );
  const settingsMode = h("select", { class: "input", "aria-label": "Mode" }, h("option", { value: "understand" }, "understand"), h("option", { value: "anti-vibe" }, "anti-vibe"));
  const modeHint = h("p", { class: "hint" });
  const wizardStatus = h("p", { class: "hint", id: "wizard-advice-status" });
  const screenStatus = h("p", { class: "hint" });
  const claudeStatus = h("p", { class: "hint" });
  const versionLine = h("p", { class: "hint" });
  const dictationStatus = h("p", { class: "hint", id: "dictation-status" });
  const dictationOpen = h("button", {
    type: "button", class: "btn ghost", "data-action": "dictation-open",
    onclick: () => void call({ type: "dictation-open" }),
  }, "Open voice setup");

  async function saveSettings(patch: Partial<Settings>) {
    if (!snap) return;
    const r = await call({ type: "settings", settings: { ...snap.settings, ...patch } });
    if (!r.ok && snap) renderSettings(snap, true);
  }
  for (const [k, box] of Object.entries(toggles) as [keyof typeof toggles, HTMLInputElement][]) {
    box.addEventListener("change", () => {
      const patch: Partial<Settings> = {};
      patch[k] = box.checked;
      void saveSettings(patch);
    });
  }
  wizardSourceSelect.addEventListener("change", () => {
    void saveSettings({ wizardSource: wizardSourceSelect.value as 'screen' | 'files' });
  });
  hotkeyInput.addEventListener("focus", () => {
    recordingHotkey = true;
    hotkeyInput.value = "press a shortcut…";
  });
  hotkeyInput.addEventListener("blur", () => {
    recordingHotkey = false;
    if (snap) hotkeyInput.value = shortcutText(snap.settings.hotkey, mac());
  });
  hotkeyInput.addEventListener("keydown", (e) => {
    if (e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return hotkeyInput.blur();
    const acc = accelerator(e, mac());
    if (!acc) return;
    hotkeyInput.blur();
    void saveSettings({ hotkey: acc });
  });
  settingsMode.addEventListener("change", async () => {
    const r = await call({ type: "mode", mode: settingsMode.value as Mode });
    if (!r.ok && snap?.state) settingsMode.value = snap.state.mode;
  });

  const settingsBody = h(
    "div",
    { class: "settings" },
    h(
      "div",
      { class: "group" },
      h("h3", {}, "Window"),
      h("label", { class: "field" }, h("span", {}, "Show or hide dum"), hotkeyInput, hotkeyHint),
      hotkeyError,
      h("label", { class: "check" }, toggles.alwaysOnTop, h("span", {}, "Keep dum above other windows")),
      h("label", { class: "check" }, toggles.allWorkspaces, h("span", {}, "Show dum on every desktop and over full-screen apps")),
      h("label", { class: "check" }, toggles.launchAtLogin, h("span", {}, "Open dum when you log in")),
    ),
    h(
      "div",
      { class: "group" },
      h("h3", {}, "Privacy"),
      h("label", { class: "check" }, toggles.personalContext, h("span", {}, "Use my personal context file for suggestions")),
      h("p", { class: "hint" }, "Off unless you turn it on. It's the Markdown file linked at ~/.dum/context.md. dum uses it for project ideas and course examples. It never adds skills, and it applies the next time a project opens."),
      h("label", { class: "check" }, toggles.wizardAdvice, h("span", {}, "Let the wizard offer advice while I build")),
      h("p", { class: "hint", id: "wizard-advice-hint" }, "Screen advice sends periodic screenshots to Claude through your subscription. Pause it before showing private information or practicing unaided. It doesn't record audio or keystrokes."),
      h("label", { class: "field" }, h("span", {}, "Wizard watches"), wizardSourceSelect),
      h("p", { class: "hint" }, "Screen: periodic screenshots sent to Claude when the wizard is on. Saved files: reads only what you've saved, no screen access."),
      wizardStatus,
      h("p", { class: "hint" }, "Manual screenshot sharing is separate: pick a screen or window, review the preview, then Send with message. Ambient screen advice doesn't wait for that Send."),
      screenStatus,
      h("button", { type: "button", class: "btn ghost", onclick: () => void call({ type: "screen-permission" }) }, icon("external"), "Screen Recording settings"),
    ),
    h("div", { class: "group", id: "voice-settings" },
      h("h3", {}, "Voice"),
      dictationStatus,
      dictationOpen,
      h("p", { class: "hint" }, "Bundled OpenSuperWhisper needs macOS 14+ on Apple Silicon. Set up its local model, microphone and Accessibility permissions, and recording shortcut. Return to dum's input, use that shortcut, review the transcript, then Send. Opening setup doesn't start recording."),
      h("p", { class: "hint" }, "OpenSuperWhisper may retain recordings locally. Review its settings. Enabled screen advice can independently see any visible draft."),
    ),
    h("div", { class: "group" }, h("h3", {}, "This project"), h("label", { class: "field" }, h("span", {}, "Mode, saved for this project"), settingsMode), modeHint),
    h(
      "div",
      { class: "group" },
      h("h3", {}, "Claude"),
      claudeStatus,
      h("button", { type: "button", class: "btn ghost", onclick: () => void call({ type: "runtime-check" }) }, icon("refresh"), "Check again"),
    ),
    h(
      "div",
      { class: "group" },
      versionLine,
      h("button", { type: "button", class: "btn danger", onclick: () => void call({ type: "quit" }) }, icon("power"), "Quit dum"),
    ),
  );

  function renderSettings(s: Snapshot, force = false) {
    if (!recordingHotkey) hotkeyInput.value = shortcutText(s.settings.hotkey, s.platform === "darwin");
    hotkeyHint.textContent = s.platform === "darwin" ? "Click, then press the new shortcut. It needs ⌘, ⌃ or ⌥." : "Click, then press the new shortcut. It needs Ctrl, Alt or Super.";
    hotkeyError.textContent = s.hotkeyError;
    hotkeyError.hidden = !s.hotkeyError;
    for (const [k, box] of Object.entries(toggles) as [keyof typeof toggles, HTMLInputElement][]) if (force || document.activeElement !== box) box.checked = s.settings[k];
    if (force || document.activeElement !== wizardSourceSelect) wizardSourceSelect.value = s.settings.wizardSource;
    wizardSourceSelect.disabled = !s.settings.wizardAdvice;
    wizardStatus.textContent = s.wizardStatus;
    dictationStatus.textContent = s.dictation.message;
    dictationOpen.disabled = !s.dictation.supported || !s.dictation.available;
    settingsMode.disabled = !s.state;
    if (s.state && document.activeElement !== settingsMode) settingsMode.value = s.state.mode;
    modeHint.textContent = s.state ? MODES[s.state.mode] : "Open a project to pick its mode.";
    const perm: Record<string, string> = {
      granted: "Screen Recording: allowed.",
      denied: "Screen Recording: blocked in System Settings. Sharing a screen won't work until you allow it.",
      restricted: "Screen Recording: restricted on this Mac.",
      "not-determined": "Screen Recording: macOS asks the first time you share.",
    };
    screenStatus.textContent = perm[s.screenPermission] ?? `Screen Recording: ${s.screenPermission || "unknown"}.`;
    const rt = s.runtime;
    claudeStatus.textContent = !rt.available ? "The Claude runtime isn't working." : !rt.authenticated ? "Not signed in." : "Signed in with your Claude subscription.";
    versionLine.textContent = `dum ${s.version} · ${s.platform}`;
  }

  // Screen and window sharing: pick, preview, then only Send with message sends it.
  const sourcesBody = h("div", { class: "sources" });
  async function openSources(opener: HTMLElement) {
    openSheet("sources", opener);
    sourcesBody.replaceChildren(h("p", { class: "muted" }, "Looking for screens and windows…"));
    const r = await call({ type: "capture-sources" }, true);
    if (sheet !== "sources") return;
    if (!r.ok) {
      sourcesBody.replaceChildren(
        h("div", { class: "notice bad" }, icon("warning"), h("span", {}, r.error)),
        permissionHelp(),
        h("button", { type: "button", class: "btn ghost", onclick: () => void openSources(opener) }, icon("refresh"), "Try again"),
      );
      return;
    }
    const sources = r.sources ?? [];
    const group = (kind: CaptureSource["kind"], title: string) => {
      const list = sources.filter((x) => x.kind === kind);
      if (!list.length) return null;
      return h(
        "div",
        { class: "source-group" },
        h("h3", {}, title),
        h("ul", { class: "source-list" }, ...list.map((src) => h("li", {}, h("button", { type: "button", class: "source", onclick: () => void pick(src) }, icon(kind === "screen" ? "screen" : "window"), h("span", {}, src.name))))),
      );
    };
    sourcesBody.replaceChildren(
      h("p", { class: "hint" }, "Pick one and dum takes a single still image of it and shows it to you here. Nothing is sent until you press Send with message."),
      ...(snap?.screenPermission === "denied" || snap?.screenPermission === "restricted" ? [permissionHelp()] : []),
      ...(sources.length ? [group("screen", "Screens"), group("window", "Windows")].filter((x): x is HTMLDivElement => !!x) : [h("p", { class: "muted" }, "No screens or windows to share. If macOS is blocking Screen Recording for dum, allow it and try again."), permissionHelp()]),
    );
    (sourcesBody.querySelector("button.source") as HTMLElement | null)?.focus();
  }
  const permissionHelp = () =>
    h(
      "div",
      { class: "notice" },
      h("span", {}, "macOS decides whether dum may record the screen. You can change it in System Settings."),
      h("button", { type: "button", class: "btn ghost small", onclick: () => void call({ type: "screen-permission" }) }, icon("external"), "Open settings"),
    );

  async function pick(src: CaptureSource) {
    if (!snap?.inputToken) return showError("dum isn't ready for a message yet.");
    sourcesBody.replaceChildren(h("p", { class: "muted" }, `Taking one image of ${src.name}…`));
    capturing = true;
    const r = await call({ type: "capture-preview", sourceId: src.id, inputToken: snap.inputToken }, true);
    capturing = false;
    if (!r.ok || !r.preview) {
      // Taking a new image releases the waiting one first, so it must not stay on screen as if it could still be sent.
      if (preview) {
        preview = null;
        renderPreview();
      }
      sourcesBody.replaceChildren(
        h("div", { class: "notice bad" }, icon("warning"), h("span", {}, r.ok ? "No image came back. Nothing was shared." : r.error)),
        permissionHelp(),
        h("button", { type: "button", class: "btn ghost", onclick: () => void openSources(attachBtn) }, "Pick again"),
      );
      return;
    }
    preview = r.preview;
    closeSheet();
    renderPreview();
    openInput();
  }

  const previewImg = h("img", { class: "preview-img", alt: "" });
  const previewZoom = h("button", { type: "button", class: "preview-zoom", "aria-pressed": "false", title: "Show larger" }, previewImg);
  previewZoom.addEventListener("click", () => {
    const big = previewZoom.getAttribute("aria-pressed") !== "true";
    previewZoom.setAttribute("aria-pressed", String(big));
    previewZoom.title = big ? "Show smaller" : "Show larger";
  });
  const previewName = h("span", { class: "preview-name" });
  const previewExpiry = h("span", { class: "preview-expiry" });
  const previewNote = h("p", { class: "preview-note", role: "status", hidden: true });
  const previewCard = h(
    "div",
    { class: "preview", hidden: true, role: "group", "aria-label": "Screen image waiting for your message" },
    h(
      "div",
      { class: "preview-head" },
      icon("screen"),
      previewName,
      h("span", { class: "chip chip-warn" }, "not sent"),
      previewExpiry,
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn ghost small", onclick: () => void discard("Discarded. Nothing was sent.") }, icon("close"), "Discard"),
    ),
    previewZoom,
    h("p", { class: "hint" }, "Look it over for anything private. It goes to Claude through your subscription only when you press Send with message, and only with that message."),
  );
  let expiryTimer = 0;
  function renderPreview() {
    clearInterval(expiryTimer);
    previewCard.hidden = !preview;
    if (preview) {
      previewZoom.setAttribute("aria-pressed", "false");
      previewZoom.title = "Show larger";
      previewImg.src = preview.dataUrl;
      previewImg.alt = `Preview of ${preview.name}`;
      previewName.textContent = preview.name;
      previewNote.hidden = true;
      const tick = () => {
        if (!preview) return;
        const left = Math.max(0, Math.round((preview.expiresAt - Date.now()) / 1000));
        previewExpiry.textContent = `expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
        if (left <= 0) void discard("The image expired before it was sent. Nothing was sent.");
      };
      tick();
      expiryTimer = window.setInterval(tick, 1000);
    } else previewImg.removeAttribute("src");
    syncComposer();
  }
  async function discard(note: string) {
    // A send in flight already carries the image; discarding now would race it.
    if (!preview || sending) return;
    preview = null;
    renderPreview();
    previewNote.textContent = note;
    previewNote.hidden = false;
    window.setTimeout(() => (previewNote.hidden = true), 6000);
    await call({ type: "capture-discard" }, true);
  }

  // -- the prompt, the composer, the status line ----------------------------

  const promptBox = h("div", { class: "prompt-box", hidden: true, tabindex: "-1" });
  const statusText = h("span", { class: "status-text" });
  const stopBtn = h("button", { type: "button", class: "btn ghost small", onclick: () => void call({ type: "interrupt" }) }, icon("stop"), "Stop");
  const statusLine = h("div", { class: "status-line", hidden: true, role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), statusText, h("span", { class: "spacer" }), stopBtn);
  const textarea = h("textarea", { class: "input composer-input", rows: "1", "aria-label": "Story, request or message to dum", "aria-describedby": "composer-keys", placeholder: "Tell dum about what you built…" });
  const attachBtn = iconButton("screen", "Share a screen or window", (e) => void openSources(e.currentTarget as HTMLElement));
  const sendLabel = h("span", {}, "Send");
  const sendBtn = h("button", { type: "submit", class: "btn primary send" }, icon("send"), sendLabel);
  const composer = h(
    "form",
    { class: "composer", id: "dum-input", hidden: true },
    textarea,
    h("div", { class: "composer-row" }, attachBtn, h("span", { id: "composer-keys", class: "hint keys" }, "Return sends · Shift-Return new line"), h("span", { class: "spacer" }), sendBtn),
  );
  let inputOpen = false;
  const requestBtn = h("button", {
    type: "button", class: "link-btn", "data-action": "write-to-dum",
    "aria-controls": "dum-input", "aria-expanded": "false",
    onclick: () => {
      inputOpen = !inputOpen;
      syncComposer();
      if (inputOpen) textarea.focus();
    },
  }, "Write to dum");
  const voiceBtn = h("button", {
    type: "button", class: "link-btn", "data-action": "voice-setup",
    onclick: (e: Event) => {
      openInput();
      openSheet("settings", e.currentTarget as HTMLElement);
      document.getElementById("voice-settings")?.scrollIntoView({ block: "nearest" });
    },
  }, "Voice");
  function openInput() {
    inputOpen = true;
    syncComposer();
    textarea.focus();
  }
  const storyBtn = storyAction("link-btn");
  const wizardPill = h("button", { type: "button", class: "wizard-pill", hidden: true, onclick: (e: Event) => openSheet("settings", e.currentTarget as HTMLElement) });
  const wizardToggle = h("button", {
    type: "button", class: "link-btn", "data-action": "wizard-pause",
    onclick: () => { if (snap) void saveSettings({ wizardAdvice: !snap.settings.wizardAdvice }); },
  }, "Pause");
  const dock = h("footer", { class: "dock", hidden: true }, statusLine, promptBox, previewNote, previewCard, h("div", { class: "dock-actions" }, wizardPill, wizardToggle), h("div", { class: "dock-actions" }, storyBtn, requestBtn, voiceBtn), composer);

  async function answer(text: string, buttons: HTMLButtonElement[]) {
    if (!snap?.inputToken || sending) return;
    sending = true;
    for (const b of buttons) b.disabled = true;
    syncComposer();
    const r = await call({ type: "send", text, inputToken: snap.inputToken });
    sending = false;
    if (!r.ok) for (const b of buttons) b.disabled = false;
    else forceBottom = true;
    syncComposer();
  }

  async function submitComposer() {
    const text = textarea.value.trim();
    if (!text || !snap?.inputToken || sending || !snap.runtime.available || !snap.runtime.authenticated || !snap.runtime.gitAvailable) return;
    sending = true;
    syncComposer();
    const captureToken = preview?.token;
    const r = await call({ type: "send", text, inputToken: snap.inputToken, ...(captureToken ? { captureToken } : {}) });
    sending = false;
    if (r.ok) {
      if (textarea.value.trim() === text) {
        textarea.value = "";
        inputOpen = false;
      }
      if (captureToken && preview?.token === captureToken) {
        preview = null;
        renderPreview();
      }
      forceBottom = true;
      renderTranscript();
    }
    syncComposer();
    (inputOpen ? textarea : requestBtn).focus();
  }
  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    void submitComposer();
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submitComposer();
    }
  });
  textarea.addEventListener("input", () => syncComposer());

  function attachBlocker(s: Snapshot): string {
    const p = s.state?.prompt;
    if (p?.type === "plan") return "A screen can't go with a plan answer.";
    if (p?.type === "course") return "A screen can't go with a course answer.";
    if (p?.type === "question" && !p.intern) return "A screen can't go with this answer.";
    if (!s.canAttach) return "Sharing a screen isn't available right now.";
    return "";
  }

  function syncComposer() {
    const s = snap;
    const ready = !!s?.state && !!s.inputToken && !sending && s.runtime.available && s.runtime.authenticated && s.runtime.gitAvailable;
    const canTellStory = !!s?.state && !s.state.busy && !sending && (!s.state.prompt || s.state.prompt.type === "next");
    for (const button of storyButtons) button.disabled = !canTellStory;
    storyBtn.hidden = !canTellStory;
    composer.hidden = !inputOpen;
    requestBtn.textContent = inputOpen ? "Hide input" : textarea.value.trim() ? "Resume draft" : "Write to dum";
    requestBtn.setAttribute("aria-expanded", String(inputOpen));
    voiceBtn.title = s?.dictation.message ?? "Set up voice dictation";
    sendBtn.disabled = !ready || !textarea.value.trim();
    sendLabel.textContent = preview ? "Send with message" : "Send";
    sendBtn.classList.toggle("with-image", !!preview);
    const blocker = s ? attachBlocker(s) : "Open a project first.";
    attachBtn.disabled = !!blocker || sending || !s?.inputToken;
    attachBtn.title = blocker || (preview ? "Take a different image instead" : "Share a screen or window");
    attachBtn.setAttribute("aria-label", attachBtn.title);
  }

  function renderPrompt(state: State, s: Snapshot) {
    const p: Prompt = state.prompt;
    const key = JSON.stringify(p);
    if (key === promptKey) {
      for (const b of promptBox.querySelectorAll("button")) b.disabled = sending || !s.inputToken;
      return;
    }
    const fresh = promptKey !== "\u0000";
    promptKey = key;
    promptBox.replaceChildren();
    promptBox.className = "prompt-box";
    let placeholder = "Tell dum about what you built…";
    const buttons: HTMLButtonElement[] = [];
    const btn = (label: string, text: string, cls = "btn") => {
      const b = h("button", { type: "button", class: cls, onclick: () => void answer(text, buttons) }, label);
      buttons.push(b);
      return b;
    };
    if (p?.type === "plan") {
      promptBox.classList.add("plan");
      promptBox.append(
        h("h3", {}, "Go ahead with this plan?"),
        h("p", { class: "hint" }, "dum writes only the approved, unlocked parts. Anything outside that scope stays untouched. Declining writes nothing."),
        h("div", { class: "actions" }, btn("Approve plan", "y", "btn primary"), btn("Not this plan", "n", "btn")),
      );
      placeholder = "Or say what to change - anything typed here declines the plan";
    } else if (p?.type === "course") {
      promptBox.classList.add("course");
      promptBox.append(
        h("h3", {}, `Course · ${p.card.skill}${p.card.lang ? ` in ${p.card.lang}` : ""}`),
        h("p", { class: "hint" }, "Fill the gap in ", h("code", {}, p.card.path), " in your editor, save, then check it."),
        h(
          "div",
          { class: "actions" },
          btn("Done, check it", "done", "btn primary"),
          h("button", { type: "button", class: "btn ghost", onclick: () => void call({ type: "open-record", record: "course", path: p.card.path }) }, icon("external"), "Open file"),
          btn("Leave course", "quit", "btn ghost"),
        ),
      );
      placeholder = "Ask about the lesson";
    } else if (p?.type === "question" && !p.intern) {
      const attest = p.purpose === "attest";
      promptBox.classList.add(attest ? "self-report" : "permission");
      promptBox.append(h("h3", {}, p.question.replace(/\s*\((?:y\/n|yes\/no)\)\s*$/i, "")));
      if (p.why) promptBox.append(h("p", { class: "hint" }, p.why));
      // Neither answer is the default: no button is focused or primary, and an empty Return sends nothing.
      if (attest) {
        promptBox.append(
          h("p", { class: "hint" }, "Only you know this. A yes plus a passing review builds the skill. A no keeps the review on record and builds nothing."),
          h("div", { class: "actions" }, btn("Yes, I wrote it myself", "y"), btn("No, I had help", "n")),
        );
      } else if (p.purpose === "share") {
        promptBox.append(h("div", { class: "actions" }, btn("Yes, share it", "y"), btn("No", "n")));
      } else if (yesNo(p.question)) {
        promptBox.append(h("div", { class: "actions" }, btn("Yes", "y"), btn("No", "n")));
      }
      placeholder = "Type your answer";
    } else if (p?.type === "question") {
      placeholder = "Answer dum";
    }
    promptBox.hidden = !promptBox.childElementCount;
    if (fresh && p?.type === "question" && !promptBox.querySelector("button")) inputOpen = true;
    for (const b of buttons) b.disabled = sending || !s.inputToken;
    textarea.placeholder = placeholder;
    // A new decision gets attention without pre-selecting an answer.
    if (fresh && !promptBox.hidden && document.hasFocus() && !sheet && document.activeElement !== textarea) promptBox.focus();
    if (fresh && preview && attachBlocker(s)) void discard("The image was discarded - it can't go with this answer. Nothing was sent.");
  }

  function renderStatus(state: State) {
    const working = state.busy || state.status.startsWith(":");
    statusLine.hidden = !working;
    statusText.textContent = state.status || "working";
    stopBtn.hidden = !state.busy;
    const v = state.models;
    const voice = (who: string, m: { model: string; effort: string }) => h("span", { class: "voice" }, h("span", { class: "muted" }, who), " ", m.model ? `${m.model}${m.effort ? ` · ${m.effort}` : ""}` : "not started");
    provenance.replaceChildren(voice("dum", v.intern), voice("wizard", v.wizard));
    const { tier, built } = tierInfo(snap?.tree ?? null);
    treeBtn.title = `Open your skill tree · ${built} built skill${built === 1 ? "" : "s"} · ${tier}`;
    let mood: "idle" | "asking" | "thinking" | "building" = "idle";
    if (state.prompt && state.prompt.type !== "next") mood = "asking";
    else if (state.busy) mood = /think/i.test(state.status) || !state.status ? "thinking" : "building";
    face.set(mood);
  }

  function renderTranscript() {
    const s = snap;
    if (!s?.state) return;
    const atBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 48;
    transcript.update(s.state.transcript, s.state.prompt);
    empty.hidden = s.state.transcript.length > 0;
    if (atBottom || forceBottom) conversation.scrollTop = conversation.scrollHeight;
    forceBottom = false;
  }

  // -- sheets and focus -----------------------------------------------------

  const sheetBodies: Record<Exclude<Sheet, "info">, { title: string; body: HTMLElement }> = {
    tools: { title: "Tools", body: toolsBody },
    settings: { title: "Settings", body: settingsBody },
    projects: { title: "Projects", body: h("div", { class: "projects" }, h("button", { type: "button", class: "btn primary", onclick: chooseFolder }, icon("folder"), "Choose folder…"), sheetRecent) },
    sources: { title: "Share a screen or window", body: sourcesBody },
  };

  function openSheet(name: Sheet, opener: HTMLElement | null) {
    if (sheet !== name) sheetReturn = opener ?? (document.activeElement as HTMLElement | null);
    sheet = name;
    sheetEl.hidden = false;
    sheetEl.dataset.sheet = name;
    if (name === "info") renderInfo();
    else {
      activePanel = null;
      for (const b of panelButtons.values()) b.setAttribute("aria-pressed", "false");
      sheetTitle.textContent = sheetBodies[name].title;
      sheetBody.replaceChildren(sheetBodies[name].body);
      if (snap) renderSettings(snap);
    }
    sheetTitle.focus();
  }

  function closeSheet() {
    if (!sheet) return;
    if (sheet === "info") {
      const stage = snap?.state?.stage;
      if (stage?.kind === "info") dismissedStage = stage.title + "\u0000" + stage.body;
    }
    sheet = null;
    activePanel = null;
    awaiting = null;
    sheetEl.hidden = true;
    for (const b of panelButtons.values()) b.setAttribute("aria-pressed", "false");
    const back = sheetReturn;
    sheetReturn = null;
    if (back?.isConnected && !back.closest("[hidden]")) back.focus();
    else if (!dock.hidden) (inputOpen ? textarea : requestBtn).focus();
  }

  async function hide() {
    if (preview) await discard("Discarded when dum was hidden. Nothing was sent.");
    await call({ type: "hide-panel" });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    if (sheet) closeSheet();
    else if (inputOpen) {
      inputOpen = false;
      syncComposer();
      requestBtn.focus();
    } else void hide();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && preview && !capturing) void discard("Discarded when dum was hidden. Nothing was sent.");
  });
  window.addEventListener("focus", () => {
    if (!sheet && !dock.hidden && document.activeElement === document.body) (inputOpen ? textarea : requestBtn).focus();
  });
  window.addEventListener("pagehide", () => {
    if (preview) void window.dum.invoke({ type: "capture-discard" });
  });

  // -- applying a snapshot --------------------------------------------------

  function apply(s: Snapshot) {
    snap = s;
    const state = s.state;
    const rt = s.runtime;
    const ready = rt.available && rt.authenticated && rt.gitAvailable;

    const root = state?.root ?? null;
    if (root !== shownRoot) {
      if (shownRoot !== null) {
        transcript.clear();
        promptKey = "\u0000";
        if (preview) void discard("The image was discarded when you switched projects. Nothing was sent.");
        textarea.value = "";
        inputOpen = false;
        closeSheet();
      }
      shownRoot = root;
      forceBottom = true;
    }

    renderSetup(s);
    renderRecent(s);
    setup.hidden = ready;
    chooser.hidden = !ready || !!state;
    conversation.hidden = !ready || !state;
    dock.hidden = !state;
    projectName.textContent = state?.repo || "no project";
    projectBtn.title = state ? `${state.root} - switch project` : "Pick a project";
    treeBtn.hidden = !state;
    for (const b of panelButtons.values()) b.disabled = !state;
    projectTools.hidden = !state;
    runtimeDetails.hidden = !state;

    if (state) {
      // A panel's text arriving from navigation, or from a typed :command.
      const stage = state.stage;
      const stageKey = stage.kind === "info" ? stage.title + "\u0000" + stage.body : "";
      if (stageKey && stageKey !== shownStage) {
        if (awaiting) {
          activePanel = awaiting;
          awaiting = null;
        }
        if (stageKey !== dismissedStage && (sheet === "info" || !sheet)) {
          if (!sheet) openSheet("info", null);
        }
      }
      shownStage = stageKey;
      // dum asking you something takes the conversation back, as in the terminal.
      if (sheet === "info" && state.prompt && state.prompt.type !== "next" && JSON.stringify(state.prompt) !== promptKey && promptKey !== "\u0000") closeSheet();
      renderPrompt(state, s);
      renderStatus(state);
      renderTranscript();
    } else {
      face.set(ready ? "idle" : "blocked");
    }
    if (sheet === "info") renderInfo();
    if (sheet === "settings") renderSettings(s);
    syncComposer();
    // Tier bar
    const tInfo = tierInfo(s.tree);
    tierFill.className = `tier-fill tier-${tInfo.tier}`;
    tierFill.style.width = `${Math.round(tInfo.pct * 100)}%`;
    const tierText = `${tInfo.tier} · ${tInfo.built} currently usable built skills`;
    tierBar.setAttribute("aria-label", tierText);
    tierBar.setAttribute("aria-valuemin", "0");
    tierBar.setAttribute("aria-valuemax", "64");
    tierBar.setAttribute("aria-valuenow", String(Math.min(tInfo.built, 64)));
    tierBar.setAttribute("aria-valuetext", tierText);
    tierBar.title = "newbie → intern (8) → good (24) → cracked (64). Counts built skills with intact prerequisites, not messages or a mastery rating.";
    tierName.textContent = tInfo.tier;
    tierName.hidden = !s.tree || !s.state;
    tierBar.hidden = !s.tree || !s.state;

    // Wizard quick-access pill
    if (s.settings.wizardAdvice && s.state) {
      const src = s.settings.wizardSource === "screen" ? "screen" : "files";
      const statusShort = s.wizardStatus.replace(/^(screen wizard|wizard( advice| is)?( is)?|wizard)\s+/i, "").slice(0, 40);
      wizardPill.textContent = `wizard · ${src} · ${statusShort}`;
      wizardPill.hidden = false;
    } else {
      wizardPill.textContent = "wizard · paused";
      wizardPill.hidden = !s.state;
    }
    wizardToggle.hidden = !s.state;
    wizardToggle.textContent = s.settings.wizardAdvice ? "Pause" : "Resume";
    wizardToggle.setAttribute("aria-label", s.settings.wizardAdvice ? "Pause wizard advice" : "Resume wizard advice");
  }

  const app = h("div", { class: "app" }, header, errors, h("main", { class: "body" }, setup, chooser, conversation, sheetEl), dock);
  document.body.append(app);
  window.dum.subscribe(apply);
  void call({ type: "snapshot" }).then(() => {
    if (!dock.hidden) (inputOpen ? textarea : requestBtn).focus();
    else (document.querySelector("section:not([hidden]) h1") as HTMLElement | null)?.focus();
  });
}

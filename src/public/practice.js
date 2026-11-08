// Scripted practice loop. Nothing here calls a model or runs the learner's code.

export const STORAGE_KEY = "dum-intern.practice.v1";

export const STEPS = ["brief", "plan", "attempt", "check", "reflect", "teach", "variation"];

export const STEP_LABEL = {
  brief: "Brief",
  plan: "Plan",
  attempt: "Attempt",
  check: "Example",
  reflect: "Reflect",
  teach: "Teach",
  variation: "Variation",
};

export const RELATED_SKILLS = [
  { id: "terminal-basics", title: "Terminal basics" },
  { id: "files-and-paths", title: "Files and paths" },
  { id: "reading-errors", title: "Reading errors" },
  { id: "python-scripts", title: "Python scripts" },
];

export const TEACH_QUESTION = "When the price cell is empty, what should the script print, and which rows should it leave out?";

export const LISTINGS_CSV = [
  "sku,name,size,price",
  "A100,Linen shirt,M,42.00",
  "A101,Wool coat,L,",
  "A102,Cotton tee,S,18.00",
  "A103,Silk scarf,OS,",
  "A104,Denim jacket,M,79.50",
  "",
].join("\n");

export const RETURNS_CSV = [
  "sku,name,size,price",
  "R200,Linen shirt,M,42.00",
  "R201,Wool coat,L,",
  "R202,Cotton tee,S,n/a",
  "R203,Silk scarf,OS,12.00",
  "R204,Denim jacket,M,N/A",
  "",
].join("\n");

export const EXAMPLE_RUN = {
  command: "python3 missing_prices.py listings.csv",
  stdout: "Missing price: A101 Wool coat\nMissing price: A103 Silk scarf\n2 listings missing a price\n",
  disclaimer: "Scripted example. These lines were written ahead of time for the sample file. Your draft was not run, and this is not a score.",
};

export const VARIATION_RUN = {
  command: "python3 missing_prices.py returns.csv",
  stdout: "Missing price: R201 Wool coat\nMissing price: R202 Cotton tee\nMissing price: R204 Denim jacket\n3 listings missing a price\n",
  disclaimer: "Scripted example for the variation file. Your draft was not run, and this is not a score.",
};

export const EXAMPLE_SCRIPT = {
  filename: "missing_prices.py",
  label: "Scripted example script for listings.csv. Empty price cells only. The page does not run this on your draft.",
  code: [
    "import csv",
    "import sys",
    "",
    'path = sys.argv[1] if len(sys.argv) > 1 else "listings.csv"',
    "missing = 0",
    'with open(path, newline="") as handle:',
    "    for row in csv.DictReader(handle):",
    '        if row["price"].strip() == "":',
    "            missing += 1",
    '            print(f"Missing price: {row[\'sku\']} {row[\'name\']}")',
    'print(f"{missing} listings missing a price")',
    "",
  ].join("\n"),
};

export const VARIATION_SCRIPT = {
  filename: "missing_prices_variation.py",
  label: "Scripted example script for returns.csv. Empty cells and n/a. The page does not run this on your draft.",
  code: [
    "import csv",
    "import sys",
    "",
    "path = sys.argv[1]",
    "missing = 0",
    'with open(path, newline="") as handle:',
    "    for row in csv.DictReader(handle):",
    '        price = row["price"].strip()',
    '        if price == "" or price.lower() == "n/a":',
    "            missing += 1",
    '            print(f"Missing price: {row[\'sku\']} {row[\'name\']}")',
    'print(f"{missing} listings missing a price")',
    "",
  ].join("\n"),
};

export const MAIN_HINTS = [
  {
    level: 1,
    kind: "nudge",
    body: "Every row has a price column. A missing price here is an empty cell, not a missing column and not the word missing. More than one row is like that. The Python standard library can read a CSV. You do not need a third-party package.",
  },
  {
    level: 2,
    kind: "direction",
    body: "Open the file and walk one dict per row, using the header as the keys. Read the price, strip spaces, and treat an empty string as missing. Print the sku and the name for those rows, then print how many you found. A price of 0 would count as present. This file does not have one.",
  },
  {
    level: 3,
    kind: "fragment",
    body: "Example fragment. It finds empty prices. It does not print the count, and the wording is plainer than the scripted example run.",
    code: [
      "import csv",
      "",
      'with open("listings.csv", newline="") as handle:',
      "    for row in csv.DictReader(handle):",
      '        price = row["price"].strip()',
      '        if price == "":',
      '            print(row["sku"], row["name"])',
    ].join("\n"),
  },
];

export const VARIATION_HINTS = [
  {
    level: 1,
    kind: "nudge",
    body: "Blank and n/a are different strings. Decide which cells count as a missing price, and use that rule on every row. The column name is still price.",
  },
  {
    level: 2,
    kind: "direction",
    body: "Strip the cell. Treat an empty string and the letters n/a, in either case, as missing. 42.00 and 12.00 stay. Then print the same kind of line you used before, plus a count.",
  },
  {
    level: 3,
    kind: "fragment",
    body: "Example fragment for the new rule. It does not open the file or print the count.",
    code: [
      'price = row["price"].strip()',
      'if price == "" or price.lower() == "n/a":',
      "    # this row has no usable price",
    ].join("\n"),
  },
];

const DRAFT_MIN = 8;
const PLAN_WORDS = 8;
const NOTE_WORDS = 4;
const EXPLAIN_WORDS = 8;
const ANSWER_WORDS = 6;
const TEXT_MAX = 6000;

const VARIATION_DONE = "The variation is stored in this browser. The skill tree is unchanged.";

export function createSession() {
  return {
    version: 1,
    step: "brief",
    plan: "",
    attempt: "",
    mainHints: 0,
    exampleSeen: false,
    expectation: "",
    failed: "",
    why: "",
    fix: "",
    explanation: "",
    answer: "",
    lessonSaved: false,
    variationAttempt: "",
    variationNote: "",
    variationHints: 0,
  };
}

export function words(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function blockReason(session, step = session.step) {
  switch (step) {
    case "brief":
      return "";
    case "plan":
      return words(session.plan).length >= PLAN_WORDS
        ? ""
        : "Write the plan in a few words first. This only checks length. It does not review the plan.";
    case "attempt":
      return session.attempt.trim().length >= DRAFT_MIN
        ? ""
        : "Write a draft in the box first. This only checks that you put something there. It does not run or score the code.";
    case "check":
      if (!session.exampleSeen) {
        return "The scripted example run is part of this step. Open the step and read it. It is sample output, not a score.";
      }
      return words(session.expectation).length >= NOTE_WORDS
        ? ""
        : "Say what you expected, or what still looks wrong. A short sentence is enough. This is your note, not a grade.";
    case "reflect":
      if ([session.failed, session.why, session.fix].every((text) => words(text).length >= NOTE_WORDS)) return "";
      return "Fill in what failed, why, and the fix. A short sentence in each box is enough. Nothing here is scored.";
    case "teach":
      if (words(session.explanation).length < EXPLAIN_WORDS || words(session.answer).length < ANSWER_WORDS) {
        return "Explain the skill in your own words, and answer the scripted question. This checks length only. It does not grade the answer.";
      }
      if (!session.lessonSaved) {
        return "Save the lesson to keep the note in this browser. Saving does not grade it, and it does not unlock the skill tree.";
      }
      return "";
    case "variation":
      if (session.variationAttempt.trim().length >= DRAFT_MIN && words(session.variationNote).length >= NOTE_WORDS) return "";
      return "Write the variation yourself, and a line on what you changed. Hints are optional. This does not score the draft.";
    default:
      return "That step isn't part of this practice.";
  }
}

export function isStepComplete(session, step) {
  return blockReason(session, step) === "";
}

export function allowedSteps(session) {
  const open = [];
  for (const step of STEPS) {
    open.push(step);
    if (!isStepComplete(session, step)) break;
  }
  return open;
}

export function firstIncomplete(session) {
  return STEPS.find((step) => !isStepComplete(session, step)) ?? null;
}

export function normalize(session) {
  const lessonSaved = session.lessonSaved
    && words(session.explanation).length >= EXPLAIN_WORDS
    && words(session.answer).length >= ANSWER_WORDS;
  const next = { ...session, lessonSaved };
  const allowed = allowedSteps(next);
  const step = allowed.includes(next.step) ? next.step : allowed[allowed.length - 1];
  return { ...next, step };
}

export function present(session) {
  if (session.step === "check" && !session.exampleSeen) return { ...session, exampleSeen: true };
  if (session.step === "teach" && !session.explanation.trim()) {
    return { ...session, explanation: teachDraft(session) };
  }
  return session;
}

export function enter(session, step) {
  const moving = session.step !== step;
  const moved = normalize({ ...session, step });
  if (moved.step !== step) {
    const incomplete = firstIncomplete(moved);
    return { ok: false, session: moved, message: blockReason(moved, incomplete ?? moved.step) };
  }
  return { ok: true, session: moving ? present(moved) : moved, message: "" };
}

export function advance(session) {
  const reason = blockReason(session);
  if (reason) return { ok: false, session, message: reason };
  if (session.step === "variation") return { ok: true, session, message: VARIATION_DONE };
  const next = STEPS[STEPS.indexOf(session.step) + 1];
  return enter(session, next);
}

export function revealHint(session, track) {
  const key = track === "main" ? "mainHints" : "variationHints";
  const bank = track === "main" ? MAIN_HINTS : VARIATION_HINTS;
  const hint = bank.find((item) => item.level === session[key] + 1) ?? null;
  if (!hint) return { session, hint: null };
  return { session: { ...session, [key]: hint.level }, hint };
}

export function shownHints(session, track) {
  const level = track === "main" ? session.mainHints : session.variationHints;
  const bank = track === "main" ? MAIN_HINTS : VARIATION_HINTS;
  return bank.filter((item) => item.level <= level);
}

export function hintButtonLabel(level) {
  if (level >= 3) return "All 3 scripted hints opened";
  const next = level + 1;
  const kind = next === 1 ? "nudge" : next === 2 ? "direction" : "example fragment";
  return `Ask for hint ${next} of 3, a ${kind}`;
}

export function continueLabel(step) {
  switch (step) {
    case "brief": return "Write a plan";
    case "plan": return "Write an attempt";
    case "attempt": return "Read the example";
    case "check": return "Write the reflection";
    case "reflect": return "Teach the intern";
    case "teach": return "Try the variation";
    case "variation": return "Store the variation";
    default: return "Continue";
  }
}

export function progress(session) {
  return [
    { id: "plan", label: isStepComplete(session, "plan") ? "Plan written" : "Plan", done: isStepComplete(session, "plan") },
    { id: "attempt", label: isStepComplete(session, "attempt") ? "Draft written" : "Draft", done: isStepComplete(session, "attempt") },
    { id: "example", label: session.exampleSeen ? "Example read" : "Example", done: session.exampleSeen },
    { id: "reflect", label: isStepComplete(session, "reflect") ? "Reflection written" : "Reflection", done: isStepComplete(session, "reflect") },
    { id: "lesson", label: session.lessonSaved ? "Lesson saved" : "Lesson", done: session.lessonSaved },
    { id: "variation", label: isStepComplete(session, "variation") ? "Variation written" : "Variation", done: isStepComplete(session, "variation") },
  ];
}

export function teachDraft(session) {
  const parts = [
    "The script reads a clothing listings CSV and prints each row whose price cell is empty, then a count.",
  ];
  if (session.plan.trim()) parts.push(`Plan I used:\n${session.plan.trim()}`);
  if (session.failed.trim()) parts.push(`What went wrong: ${session.failed.trim()}`);
  if (session.why.trim()) parts.push(`Why: ${session.why.trim()}`);
  if (session.fix.trim()) parts.push(`Fix: ${session.fix.trim()}`);
  return parts.join("\n\n");
}

export function saveLesson(session) {
  if (words(session.explanation).length < EXPLAIN_WORDS || words(session.answer).length < ANSWER_WORDS) {
    return {
      ok: false,
      session,
      message: "Explain the skill in your own words, and answer the scripted question. This checks length only. It does not grade the answer.",
    };
  }
  return {
    ok: true,
    session: { ...session, lessonSaved: true },
    message: "Lesson saved in this browser. The skill tree does not unlock from this note.",
  };
}

export function lessonMarkdown(session, taught = new Date().toISOString().slice(0, 10)) {
  return [
    "# Missing prices in a clothing CSV",
    "",
    `Taught ${taught}. Practice demo note, stored in this browser. The question was scripted. This is not a model evaluation.`,
    "",
    "Check a clothing listings CSV and print the rows whose price cell is empty.",
    "",
    "## What I was taught",
    "",
    session.explanation.trim(),
    "",
    "## Questions I asked",
    "",
    `**Intern:** ${TEACH_QUESTION}`,
    "",
    `**Teacher:** ${session.answer.trim()}`,
    "",
    "## What failed, why, and the fix",
    "",
    session.failed.trim(),
    "",
    session.why.trim(),
    "",
    session.fix.trim(),
    "",
    "## Rule",
    "",
    "Follow the teacher's words above. If a better way shows up, propose a new node. Do not use that way yourself.",
    "",
  ].join("\n");
}

export function serialize(session) {
  return { ...session };
}

export function parseSession(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input;
  if (raw.version !== 1) return null;
  const step = typeof raw.step === "string" ? raw.step : "";
  if (!STEPS.includes(step)) return null;
  const text = (key) => {
    const value = raw[key];
    return typeof value === "string" ? value.slice(0, TEXT_MAX) : null;
  };
  const fields = ["plan", "attempt", "expectation", "failed", "why", "fix", "explanation", "answer", "variationAttempt", "variationNote"];
  const strings = {};
  for (const key of fields) {
    const value = text(key);
    if (value === null) return null;
    strings[key] = value;
  }
  if (!isHintLevel(raw.mainHints) || !isHintLevel(raw.variationHints)) return null;
  if (typeof raw.exampleSeen !== "boolean" || typeof raw.lessonSaved !== "boolean") return null;
  return normalize({
    version: 1,
    step,
    ...strings,
    mainHints: raw.mainHints,
    exampleSeen: raw.exampleSeen,
    lessonSaved: raw.lessonSaved,
    variationHints: raw.variationHints,
  });
}

function isHintLevel(value) {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

const KIND_LABEL = { nudge: "nudge", direction: "direction", fragment: "example fragment" };

export function mountPractice(root, options = {}) {
  if (!root || typeof document === "undefined") return;
  const storage = options.storage ?? window.localStorage;
  const openSkill = options.onOpenNode ?? (() => {});
  const prefill = options.onPrefill ?? (() => {});

  let session = present(load());
  let statusMessage = "";
  persist();

  root.replaceChildren();
  const flag = el("p", { class: "scripted-flag", text: "Scripted demo. Example files and canned hints. Not a live model. Not a grade." });
  const clear = el("button", { type: "button", text: "Clear practice" });
  const tools = el("div", { class: "practice-tools" }, flag, clear);
  const stepsNav = el("nav", { class: "practice-steps", "aria-label": "Practice steps" });
  const progressList = el("ol", { class: "practice-progress", "aria-label": "Practice progress" });
  const body = el("div", { class: "practice-body" });
  const back = el("button", { type: "button", class: "secondary", text: "Back" });
  const status = el("p", { class: "practice-status", role: "status" });
  const next = el("button", { type: "button", class: "primary" });
  const nav = el("div", { class: "practice-nav" }, back, status, next);
  root.append(tools, stepsNav, progressList, body, nav);

  clear.addEventListener("click", () => {
    if (!window.confirm("Clear the practice plan, draft, and lesson in this browser? The skill tree stays as it is.")) return;
    session = createSession();
    storage.removeItem(STORAGE_KEY);
    statusMessage = "Practice cleared on this browser.";
    render(true);
  });
  back.addEventListener("click", () => {
    const index = STEPS.indexOf(session.step);
    if (index <= 0) return;
    apply(enter(session, STEPS[index - 1]), true);
  });
  next.addEventListener("click", () => {
    if (session.step === "teach" && !session.lessonSaved) {
      const saved = saveLesson(session);
      session = saved.session;
      statusMessage = saved.message;
      persist();
      render(false);
      if (saved.ok) {
        document.getElementById("lesson-actions")?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    apply(advance(session), true);
  });

  render(false);

  function apply(result, focusHeading) {
    session = result.session;
    statusMessage = result.message;
    persist();
    render(focusHeading && result.ok);
  }

  function render(focusHeading) {
    renderSteps();
    renderProgress();
    body.replaceChildren(renderBody());
    back.disabled = STEPS.indexOf(session.step) === 0;
    next.textContent = session.step === "teach" && !session.lessonSaved ? "Save lesson" : continueLabel(session.step);
    status.textContent = statusMessage;
    if (focusHeading) {
      const heading = document.getElementById("practice-heading");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
    }
  }

  function renderSteps() {
    const allowed = allowedSteps(session);
    stepsNav.replaceChildren();
    for (const step of STEPS) {
      const button = el("button", {
        type: "button",
        text: STEP_LABEL[step],
        "aria-current": session.step === step ? "step" : null,
        disabled: allowed.includes(step) ? null : true,
        onClick: () => apply(enter(session, step), true),
      });
      if (step !== "brief" && isStepComplete(session, step)) button.classList.add("done");
      stepsNav.append(button);
    }
  }

  function renderProgress() {
    progressList.replaceChildren();
    const hintLabel = session.step === "variation" || session.variationHints > 0
      ? `Hints ${session.mainHints}/3 · variation ${session.variationHints}/3`
      : `Hints ${session.mainHints}/3`;
    progressList.append(el("li", { text: hintLabel }));
    for (const item of progress(session)) {
      progressList.append(el("li", { class: item.done ? "done" : "", text: item.label }));
    }
  }

  function renderBody() {
    const column = el("div", { class: "practice-column" });
    column.append(renderStep());
    return column;
  }

  function renderStep() {
    switch (session.step) {
      case "brief": return brief();
      case "plan": return plan();
      case "attempt": return attempt();
      case "check": return check();
      case "reflect": return reflect();
      case "teach": return teach();
      case "variation": return variation();
      default: return el("p", { text: "That step isn't part of this practice." });
    }
  }

  function brief() {
    return el("section", {},
      el("p", { class: "kicker", text: "One task" }),
      el("h1", { id: "practice-heading", text: "Check clothing listings for missing prices" }),
      el("p", { text: "A shop exported listings.csv. Some prices are empty. Write a Python script that prints each listing with an empty price, then how many." }),
      el("p", { text: "You drive. Plan it in small steps, write your own draft, and ask for a hint only when you want one. Then say what failed, teach the intern, and try a variation on your own." }),
      el("p", { text: "Nothing in this pane calls a model. Nothing runs your code." }),
      sampleBlock("Example file · listings.csv", LISTINGS_CSV),
      el("div", { class: "practice-actions" },
        el("button", { type: "button", class: "secondary", text: "Download listings.csv", onClick: () => download("listings.csv", LISTINGS_CSV, "text/csv") }),
      ),
      el("h2", { text: "Skills on the tree" }),
      el("p", { text: "Opening one starts the intern's real lesson. Python scripts waits on Terminal basics, then Files and paths." }),
      skillRow(),
    );
  }

  function plan() {
    return el("section", {},
      el("p", { class: "kicker", text: "Your plan" }),
      el("h1", { id: "practice-heading", text: "Plan the script in small steps" }),
      el("p", { text: "Break the job into steps you could finish in a few minutes. Reading the file, deciding what an empty price is, and printing the rows is enough." }),
      el("p", { text: "In the rest of the app the intern has to plan before it touches the computer. Here the plan is yours, and you do the work." }),
      field("practice-plan", "Your plan", session.plan, "plan", {
        help: "Stored in this browser when you continue. Length is the only check. The plan is not reviewed.",
        rows: 8,
      }),
    );
  }

  function attempt() {
    return el("section", {},
      el("p", { class: "kicker", text: "Your draft" }),
      el("h1", { id: "practice-heading", text: "Write your own attempt" }),
      el("p", { text: "Write the script here, even if it is wrong. Hints stay closed until you ask. The first hint is not code." }),
      field("practice-attempt", "Your Python draft", session.attempt, "attempt", {
        help: "Tab inserts spaces. Nothing on this page runs the draft or scores it.",
        code: true,
        rows: 8,
      }),
      el("div", { class: "practice-actions" },
        el("button", {
          type: "button",
          class: "secondary",
          id: "main-hint-btn",
          text: hintButtonLabel(session.mainHints),
          disabled: session.mainHints >= 3 ? true : null,
          onClick: () => askHint("main"),
        }),
      ),
      hintList("main-hints", shownHints(session, "main")),
    );
  }

  function check() {
    return el("section", {},
      el("p", { class: "kicker", text: "Scripted example" }),
      el("h1", { id: "practice-heading", text: "Read the example run" }),
      el("p", { text: EXAMPLE_RUN.disclaimer }),
      el("p", { class: "cmd-line", text: EXAMPLE_RUN.command }),
      sampleBlock("Scripted stdout", EXAMPLE_RUN.stdout),
      el("details", {},
        el("summary", { text: "Scripted example script. Open it to compare by eye. It is not a grade." }),
        el("p", { text: EXAMPLE_SCRIPT.label }),
        el("pre", { class: "sample", text: EXAMPLE_SCRIPT.code }),
      ),
      field("practice-expectation", "What you expected, or what still looks wrong", session.expectation, "expectation", {
        help: "Your note. It is not compared with the example, and it is not a grade.",
        rows: 5,
      }),
    );
  }

  function reflect() {
    return el("section", {},
      el("p", { class: "kicker", text: "Your reflection" }),
      el("h1", { id: "practice-heading", text: "What failed, why, and the fix" }),
      el("p", { text: "Say what went wrong or felt shaky, why it happened, and what you would change. You will teach from this. Nothing here is scored." }),
      field("practice-failed", "What failed or felt shaky", session.failed, "failed", { help: "A short sentence is enough.", rows: 4 }),
      field("practice-why", "Why", session.why, "why", { help: "Name the cause in your own words.", rows: 4 }),
      field("practice-fix", "What you would change", session.fix, "fix", { help: "The next version of the script, described.", rows: 4 }),
    );
  }

  function teach() {
    const saved = session.lessonSaved ? lessonMarkdown(session) : "";
    return el("section", {},
      el("p", { class: "kicker", text: "Teach the intern" }),
      el("h1", { id: "practice-heading", text: "Write the note the intern would follow" }),
      el("p", { text: "The intern only follows a note you wrote. Turn the work above into that note. The question is scripted, the same shape as mock mode. It is not a model reading your answer." }),
      el("p", { text: "Saving keeps the markdown in this browser. The skill tree stays locked until you teach the node there. Python scripts still waits on Terminal basics, then Files and paths." }),
      field("practice-explanation", "Explanation in your own words", session.explanation, "explanation", {
        help: "Edit this into instructions. Length is the only check.",
        rows: 8,
      }),
      el("p", { class: "kicker", text: "Scripted question" }),
      el("blockquote", { text: TEACH_QUESTION }),
      field("practice-answer", "Your answer", session.answer, "answer", {
        help: "The intern would keep this with the note. It is not graded.",
        rows: 4,
      }),
      saved
        ? el("div", {},
          el("div", { class: "practice-actions", id: "lesson-actions" },
            el("button", { type: "button", class: "secondary", text: "Download missing-prices.md", onClick: () => download("missing-prices.md", lessonMarkdown(session), "text/markdown") }),
            el("button", { type: "button", class: "secondary", text: "Put the explanation in chat", onClick: () => prefill(session.explanation) }),
            el("button", { type: "button", class: "secondary", text: "Open Python scripts on the tree", onClick: () => openSkill("python-scripts") }),
          ),
          el("h2", { text: "Lesson note" }),
          el("pre", { class: "sample lesson", id: "lesson-preview", text: saved }),
        )
        : el("p", { text: "Save the lesson when the explanation and the answer are filled in. The button checks length only." }),
      skillRow(),
    );
  }

  function variation() {
    return el("section", {},
      el("p", { class: "kicker", text: "Variation · try it yourself" }),
      el("h1", { id: "practice-heading", text: "Same job, different file" }),
      el("p", { text: "returns.csv is the same kind of file. A price can be empty or the text n/a. Print those rows and a count." }),
      el("p", { text: "Try it before you open a hint. Hints start over, and they are still scripted. Nothing here runs your draft." }),
      sampleBlock("Example file · returns.csv", RETURNS_CSV),
      el("div", { class: "practice-actions" },
        el("button", { type: "button", class: "secondary", text: "Download returns.csv", onClick: () => download("returns.csv", RETURNS_CSV, "text/csv") }),
      ),
      field("practice-variation", "Your variation draft", session.variationAttempt, "variationAttempt", {
        help: "Write this one without copying a solution into the box first. Tab inserts spaces.",
        code: true,
        rows: 8,
      }),
      field("practice-variation-note", "What you did differently", session.variationNote, "variationNote", {
        help: "One or two sentences. Stored locally. Not a grade.",
        rows: 3,
      }),
      el("div", { class: "practice-actions" },
        el("button", {
          type: "button",
          class: "secondary",
          id: "variation-hint-btn",
          text: hintButtonLabel(session.variationHints),
          disabled: session.variationHints >= 3 ? true : null,
          onClick: () => askHint("variation"),
        }),
      ),
      hintList("variation-hints", shownHints(session, "variation")),
      el("details", {},
        el("summary", { text: "Scripted example output for returns.csv. Open it after you try. It is not a grade." }),
        el("p", { text: VARIATION_RUN.disclaimer }),
        el("p", { class: "cmd-line", text: VARIATION_RUN.command }),
        el("pre", { class: "sample", text: VARIATION_RUN.stdout }),
        el("p", { text: VARIATION_SCRIPT.label }),
        el("pre", { class: "sample", text: VARIATION_SCRIPT.code }),
      ),
    );
  }

  function skillRow() {
    return el("div", { class: "practice-actions" },
      ...RELATED_SKILLS.map((skill) => el("button", {
        type: "button",
        class: "secondary",
        text: skill.title,
        onClick: () => openSkill(skill.id),
      })),
    );
  }

  function askHint(track) {
    const result = revealHint(session, track);
    if (!result.hint) return;
    session = result.session;
    statusMessage = "";
    persist();
    const list = document.getElementById(track === "main" ? "main-hints" : "variation-hints");
    if (list) {
      const card = hintCard(result.hint);
      list.append(card);
      card.scrollIntoView({ block: "nearest" });
    }
    const button = document.getElementById(track === "main" ? "main-hint-btn" : "variation-hint-btn");
    const level = track === "main" ? session.mainHints : session.variationHints;
    if (button) {
      button.textContent = hintButtonLabel(level);
      button.disabled = level >= 3;
    }
    renderSteps();
    renderProgress();
  }

  function field(id, label, value, key, extra) {
    const area = el("textarea", {
      id,
      value,
      rows: String(extra.rows ?? 5),
      spellcheck: extra.code ? "false" : "true",
      autocapitalize: "off",
      autocomplete: "off",
      onInput: (event) => {
        const savedBefore = session.lessonSaved;
        session = normalize({ ...session, [key]: event.target.value });
        statusMessage = "";
        status.textContent = "";
        persist();
        if (savedBefore !== session.lessonSaved) {
          render(false);
          return;
        }
        renderSteps();
        renderProgress();
        next.textContent = session.step === "teach" && !session.lessonSaved ? "Save lesson" : continueLabel(session.step);
      },
    });
    if (extra.code) {
      area.className = "code";
      area.addEventListener("keydown", onCodeTab);
    }
    const help = el("p", { class: "field-help", id: `${id}-help`, text: extra.help });
    area.setAttribute("aria-describedby", `${id}-help`);
    return el("div", { class: "field" }, el("label", { for: id, text: label }), help, area);
  }

  function load() {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return createSession();
      return parseSession(JSON.parse(raw)) ?? createSession();
    } catch {
      return createSession();
    }
  }

  function persist() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(serialize(session)));
    } catch {
      statusMessage = "This browser didn't store the practice note.";
    }
  }
}

function hintList(id, hints) {
  return el("div", { id, "aria-live": "polite" }, ...hints.map((hint) => hintCard(hint)));
}

function hintCard(hint) {
  const card = el("article", { class: "hint-card" },
    el("p", { class: "kicker", text: `Scripted hint ${hint.level} of 3 · ${KIND_LABEL[hint.kind]}` }),
    el("p", { text: hint.body }),
  );
  if (hint.code) card.append(el("pre", { class: "sample", text: hint.code }));
  return card;
}

function sampleBlock(label, text) {
  return el("figure", { class: "sample-block" },
    el("figcaption", { class: "kicker", text: label }),
    el("pre", { class: "sample", text }),
  );
}

function download(name, text, type) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function onCodeTab(event) {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  const area = event.currentTarget;
  const start = area.selectionStart ?? 0;
  const end = area.selectionEnd ?? start;
  area.setRangeText("  ", start, end, "end");
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "value") node.value = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of kids.flat()) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

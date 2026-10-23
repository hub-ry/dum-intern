import * as pdfjs from "/vendor/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

const view = document.getElementById("view");
const status = document.getElementById("status");

const state = {
  me: null,
  oauth: false,
  tree: null,
  path: "",
  root: "dum",
  goalId: null,
  tab: "goals",
  skillId: null,
  stack: [],
  code: "",
};

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function goal() {
  return state.tree?.goals.find((g) => g.id === state.goalId) ?? state.tree?.goals[0] ?? null;
}

function skills() {
  const g = goal();
  return g ? state.tree.skills.filter((s) => s.goalId === g.id) : [];
}

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function tabs() {
  const names = [["goals", "Goals"], ["tree", "Tree"], ["read", "Read"], ["build", "Build"], ["hints", "Hints"], ["folder", "Folder"]];
  return el("ul", { class: "tabs" }, names.map(([id, label]) => el("li", {}, el("button", {
    type: "button",
    "aria-selected": String(state.tab === id),
    onclick: () => { state.tab = id; draw(); },
  }, label))));
}

function draw() {
  view.replaceChildren();
  if (!state.me) { drawLogin(); return; }
  const g = goal();
  view.append(
    el("p", { class: "who" }, `${state.me.login} · root ${state.root}`),
    tabs(),
  );
  if (state.tab === "goals") drawGoals();
  else if (!g) view.append(el("p", {}, "Set a goal first."));
  else if (state.tab === "tree") drawTree();
  else if (state.tab === "read") drawRead();
  else if (state.tab === "build") drawBuild();
  else if (state.tab === "hints") drawHints();
  else drawFolder();
}

function drawLogin() {
  const form = el("form", { onsubmit: startLogin },
    el("h1", {}, "Sign in with GitHub"),
    el("p", {}, "Your Dum is a folder. Signing in opens the one stored for your GitHub account on hub."),
    el("label", { for: "login" }, "GitHub username"),
    el("input", { id: "login", name: "login", autocomplete: "username", required: "true" }),
    el("div", { class: "row" }, el("button", { class: "button button-primary", type: "submit" }, "Get a code")),
  );
  if (state.oauth) {
    form.append(el("p", {}, el("a", { href: "/auth/github" }, "Or continue with GitHub")));
  }
  view.append(form);
  if (!state.code) return;
  view.append(el("form", { onsubmit: finishLogin },
    el("p", {}, "Create a public gist. Name the file dum-login. Paste this code as the whole file."),
    el("pre", {}, el("code", {}, state.code)),
    el("p", {}, el("a", { href: "https://gist.github.com/", rel: "noreferrer" }, "Open gist.github.com")),
    el("div", { class: "row" }, el("button", { class: "button button-primary", type: "submit" }, "Check the gist")),
  ));
}

async function startLogin(event) {
  event.preventDefault();
  setStatus("Asking GitHub for a code…");
  try {
    const data = await api("/api/auth/start", { method: "POST", body: JSON.stringify({ login: event.target.login.value }) });
    state.code = data.code;
    state.pendingLogin = data.login;
    setStatus("Put that code in a public gist named dum-login, then check it.");
    draw();
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function finishLogin(event) {
  event.preventDefault();
  setStatus("Checking the gist…");
  try {
    await api("/api/auth/finish", { method: "POST", body: JSON.stringify({ login: state.pendingLogin, code: state.code }) });
    state.code = "";
    await boot();
  } catch (err) {
    setStatus(err.message, true);
  }
}

function drawGoals() {
  const list = el("ul", { class: "hint-list" });
  for (const g of state.tree.goals) {
    list.append(el("li", {}, el("button", { type: "button", onclick: () => { state.goalId = g.id; state.tab = "tree"; draw(); } }, g.title), ` — ${g.aim}`));
  }
  view.append(
    el("h1", {}, "Goals"),
    list.childNodes.length ? list : el("p", {}, "No goals yet."),
    el("form", { onsubmit: createGoal },
      el("h2", {}, "New goal"),
      el("label", { for: "title" }, "Name"),
      el("input", { id: "title", name: "title", required: "true", maxlength: "80" }),
      el("label", { for: "aim" }, "What do you want to be able to build?"),
      el("textarea", { id: "aim", name: "aim", required: "true", maxlength: "2000" }),
      el("label", { for: "outline" }, "Blocks, if you already know them. Indent a child with two spaces. Leave this empty and Dum drafts the tree."),
      el("textarea", { id: "outline", name: "outline" }),
      el("div", { class: "row" }, el("button", { class: "button button-primary", type: "submit" }, "Lay out the tree")),
    ),
  );
}

async function createGoal(event) {
  event.preventDefault();
  const body = {
    title: event.target.title.value,
    aim: event.target.aim.value,
    outline: event.target.outline.value,
  };
  setStatus("Saving the tree. The papers get written in Cursor, not on hub.");
  try {
    const data = await api("/api/goals", { method: "POST", body: JSON.stringify(body) });
    state.tree = data.tree;
    state.goalId = data.tree.goals[0]?.id ?? null;
    state.tab = "tree";
    setStatus("Tree is ready. Read a block, or swear one you already know.");
    draw();
  } catch (err) {
    setStatus(err.message, true);
  }
}

function drawTree() {
  const g = goal();
  view.append(el("h1", {}, g.title), el("p", {}, g.aim), renderNodes(null));
}

function renderNodes(parentId) {
  const ul = el("ul", { class: parentId ? "" : "tree" });
  for (const skill of skills().filter((s) => s.parentId === parentId)) {
    const kind = skill.unlock?.kind ?? "locked";
    ul.append(el("li", {},
      el("div", { class: "skill" },
        el("span", {}, skill.title),
        el("span", { class: `mark ${kind}` }, kind),
        el("button", { class: "chip", type: "button", onclick: () => openSkill(skill.id) }, "Read"),
        kind === "locked" ? el("button", { class: "chip", type: "button", onclick: () => swear(skill) }, "Swear") : null,
      ),
      renderNodes(skill.id),
    ));
  }
  return ul;
}

function openSkill(id) {
  state.skillId = id;
  state.tab = "read";
  draw();
}

async function swear(skill) {
  const text = window.prompt(`Swear what you know about “${skill.title}”. A sentence is enough.`);
  if (!text) return;
  setStatus("Saving the swear…");
  try {
    const data = await api("/api/swear", { method: "POST", body: JSON.stringify({ skillId: skill.id, text }) });
    state.tree = data.tree;
    setStatus(`${skill.title} is unlocked. It is marked sworn, not read.`);
    draw();
  } catch (err) {
    setStatus(err.message, true);
  }
}

function drawRead() {
  const skill = skills().find((s) => s.id === state.skillId) ?? skills().find((s) => !s.unlock) ?? skills()[0];
  if (!skill) { view.append(el("p", {}, "This goal has no blocks.")); return; }
  state.skillId = skill.id;
  view.append(
    el("h1", {}, skill.title),
    el("p", {}, skill.unlock ? `Unlocked (${skill.unlock.kind}). You can read it again.` : "Reach the last page and this block unlocks."),
    el("div", { id: "pages", class: "reader-pages" }, el("p", {}, "Opening the reading…")),
  );
  loadPdf(skill);
}

async function loadPdf(skill) {
  const box = document.getElementById("pages");
  try {
    const res = await fetch(`/api/readings/${skill.id}/pdf`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "This block has no paper yet.");
    }
    const pages = Number(res.headers.get("X-Dum-Pages") || "1");
    const data = new Uint8Array(await res.arrayBuffer());
    const doc = await pdfjs.getDocument({ data }).promise;
    box.replaceChildren();
    let marked = false;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1.3 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      box.append(canvas);
      if (n === doc.numPages) {
        const watch = new IntersectionObserver(async (entries) => {
          if (!entries.some((entry) => entry.isIntersecting) || marked || skill.unlock) return;
          marked = true;
          try {
            const data = await api("/api/read", { method: "POST", body: JSON.stringify({ skillId: skill.id, page: pages, pages }) });
            state.tree = data.tree;
            setStatus(`${skill.title} is unlocked.`);
          } catch (err) {
            marked = false;
            setStatus(err.message, true);
          }
        }, { threshold: 0.15 });
        watch.observe(canvas);
      }
    }
  } catch (err) {
    box.replaceChildren(el("p", {}, err.message));
  }
}

function drawBuild() {
  const g = goal();
  const unlocked = skills().filter((s) => s.unlock);
  view.append(el("h1", {}, "Stack blocks"), el("p", {}, `Unlocked blocks for ${g.title}. The order you add them is the order of the build.`));
  const picks = el("div", { class: "row" });
  for (const skill of unlocked) {
    picks.append(el("button", { class: "block-btn", type: "button", onclick: () => addBlock(skill.id) }, `${skill.title} (${skill.unlock.kind})`));
  }
  const stack = el("ol", { class: "stack" });
  state.stack.forEach((id, index) => {
    const skill = skills().find((s) => s.id === id);
    if (!skill) return;
    stack.append(el("li", {},
      el("span", {}, `${index + 1}. ${skill.title}`),
      el("button", { class: "chip", type: "button", onclick: () => moveBlock(index, -1) }, "Up"),
      el("button", { class: "chip", type: "button", onclick: () => moveBlock(index, 1) }, "Down"),
      el("button", { class: "chip", type: "button", onclick: () => removeBlock(index) }, "Remove"),
    ));
  });
  view.append(
    picks.childNodes.length ? picks : el("p", {}, "Nothing is unlocked yet."),
    stack,
    el("form", { onsubmit: saveBuild },
      el("label", { for: "build-title" }, "What are you building?"),
      el("input", { id: "build-title", name: "title", required: "true", maxlength: "80" }),
      el("div", { class: "row" }, el("button", { class: "button button-primary", type: "submit" }, "Save this stack")),
    ),
    el("h2", {}, "Saved"),
    el("ul", { class: "hint-list" }, state.tree.builds.filter((b) => b.goalId === g.id).map((b) => el("li", {}, b.title))),
  );
}

function addBlock(id) {
  if (state.stack.includes(id)) { setStatus("That block is already in the stack.", true); return; }
  state.stack.push(id);
  draw();
}
function moveBlock(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= state.stack.length) return;
  const [item] = state.stack.splice(index, 1);
  state.stack.splice(next, 0, item);
  draw();
}
function removeBlock(index) {
  state.stack.splice(index, 1);
  draw();
}

async function saveBuild(event) {
  event.preventDefault();
  const g = goal();
  setStatus("Saving the build…");
  try {
    const data = await api("/api/builds", { method: "POST", body: JSON.stringify({ goalId: g.id, title: event.target.title.value, blockIds: state.stack }) });
    state.tree = data.tree;
    state.stack = [];
    setStatus("Saved. The stack is in builds/ in your Dum folder.");
    draw();
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function drawHints() {
  const g = goal();
  view.append(el("h1", {}, "Hints"), el("p", {}, "Things to learn are readings you can open now. Things to build are stacks of blocks you have read or sworn."));
  const box = el("div");
  view.append(box);
  try {
    const data = await api(`/api/hints?goal=${encodeURIComponent(g.id)}`);
    const learn = el("ul", { class: "hint-list" });
    for (const item of data.learn) {
      learn.append(el("li", {}, el("button", { type: "button", onclick: () => openSkill(item.skillId) }, item.title)));
    }
    const build = el("ul", { class: "hint-list" });
    for (const item of data.build) {
      build.append(el("li", {}, el("button", { type: "button", onclick: () => { state.stack = [...item.blockIds]; state.tab = "build"; draw(); } }, item.blockTitles.join(" → "))));
    }
    box.append(el("h2", {}, "Things to learn"), learn.childNodes.length ? learn : el("p", {}, "Nothing is waiting. Swear a later block, or set another goal."));
    box.append(el("h2", {}, "Things to build"), build.childNodes.length ? build : el("p", {}, "Unlock a block and a stack will show up here."));
  } catch (err) {
    setStatus(err.message, true);
  }
}

function drawFolder() {
  view.append(
    el("h1", {}, "Folder"),
    el("p", {}, "The default root is a folder named dum. You can point this account at another folder name, or, on hub, at another directory you own."),
    el("p", { class: "path" }, state.path),
    el("form", { onsubmit: saveRoot },
      el("label", { for: "root" }, "Root"),
      el("input", { id: "root", name: "root", value: state.root, required: "true" }),
      el("div", { class: "row" },
        el("button", { class: "button button-primary", type: "submit" }, "Use this root"),
        el("button", { class: "button button-secondary", type: "button", onclick: logout }, "Sign out"),
      ),
    ),
  );
}

async function saveRoot(event) {
  event.preventDefault();
  setStatus("Pointing Dum at that folder…");
  try {
    const data = await api("/api/root", { method: "POST", body: JSON.stringify({ root: event.target.root.value }) });
    state.root = data.root;
    state.path = data.path;
    const workspace = await api("/api/workspace");
    state.tree = workspace.tree;
    setStatus("That folder is your Dum now.");
    draw();
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function logout() {
  await api("/api/logout", { method: "POST", body: "{}" });
  state.me = null;
  state.tree = null;
  draw();
  setStatus("");
}

async function boot() {
  const me = await api("/api/me");
  state.oauth = me.oauth;
  state.me = me.account;
  if (!me.account) { draw(); return; }
  state.root = me.account.root;
  const workspace = await api("/api/workspace");
  state.tree = workspace.tree;
  state.path = workspace.account.path;
  state.goalId = state.goalId && state.tree.goals.some((g) => g.id === state.goalId) ? state.goalId : state.tree.goals[0]?.id ?? null;
  draw();
}

boot().catch((err) => setStatus(err.message, true));

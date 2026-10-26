const state = {
  mode: "mock",
  scripted: true,
  missing: [],
  model: "",
  nodes: [],
  messages: [],
  teaching: null,
  desktop: null,
  busy: false,
  selected: null,
  live: "stream",
};

const $ = (id) => document.getElementById(id);
const bench = $("bench");
const tree = $("tree");
const detail = $("detail");
const log = $("log");
const input = $("input");
const form = $("composer");
const mic = $("mic");
const save = $("save");
const banner = $("banner");
const help = $("help");

const SpeechApi = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let holding = false;
let speechBase = "";

await load();
wire();
if (state.mode === "live") wakeDesktop();

async function load() {
  const response = await fetch("/api/state");
  const data = await response.json();
  state.mode = data.mode;
  state.scripted = Boolean(data.scripted);
  state.missing = data.missing ?? [];
  state.model = data.model ?? "";
  state.nodes = data.nodes ?? [];
  state.messages = data.messages ?? [];
  state.teaching = data.teaching ?? null;
  state.desktop = data.desktop ?? null;
  render();
  scrollLog();
}

function wire() {
  $("act-tree").addEventListener("click", () => toggle("tree"));
  $("act-chat").addEventListener("click", () => toggle("chat"));
  $("act-help").addEventListener("click", () => help.showModal());
  $("reset").addEventListener("click", reset);
  save.addEventListener("click", () => saveSkill());
  $("notes-back").addEventListener("click", closeNotes);
  $("refresh-desktop").addEventListener("click", wakeDesktop);
  $("live-toggle").addEventListener("click", () => showLive("stream"));
  $("frame-toggle").addEventListener("click", () => showLive("frame"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  tree.addEventListener("keydown", onTreeKey);
  document.addEventListener("keydown", onGlobalKey);
  if (!SpeechApi) {
    mic.disabled = true;
    mic.title = "This browser has no Web Speech API. Chrome does.";
    $("mic-hint").textContent = "Enter to send · Shift+Enter for a newline · voice needs Chrome";
  } else {
    mic.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      mic.setPointerCapture(event.pointerId);
      startTalk();
    });
    mic.addEventListener("pointerup", stopTalk);
    mic.addEventListener("pointercancel", stopTalk);
  }
}

function toggle(which) {
  const off = which === "tree" ? "no-tree" : "no-chat";
  bench.classList.toggle(off);
  const button = $(which === "tree" ? "act-tree" : "act-chat");
  const on = !bench.classList.contains(off);
  button.classList.toggle("on", on);
  button.setAttribute("aria-pressed", String(on));
  if (on && which === "tree") tree.focus();
  if (on && which === "chat") input.focus();
}

async function send() {
  const text = input.value.trim();
  if (!text || state.busy) return;
  input.value = "";
  const local = { id: `local-${Date.now()}`, role: "user", text, at: new Date().toISOString(), nodeId: state.teaching?.nodeId ?? null };
  state.messages.push(local);
  state.busy = true;
  render();
  scrollLog();
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok || !response.body) {
      state.messages = state.messages.filter((message) => message.id !== local.id);
      const body = await response.json().catch(() => ({ error: response.statusText }));
      pushSystem(body.error || "The intern didn't answer.");
      return;
    }
    await readSse(response);
  } catch (error) {
    pushSystem(error instanceof Error ? error.message : "The connection dropped.");
  } finally {
    state.busy = false;
    render();
    scrollLog();
    input.focus();
  }
}

async function openNode(node, revise = false) {
  if (state.busy) return;
  state.selected = node.id;
  if (node.status === "unlocked" && !revise) {
    await showNotes(node);
    render();
    return;
  }
  const response = await fetch("/api/teach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId: node.id, revise }),
  });
  const data = await response.json();
  if (!response.ok) {
    pushSystem(data.error || "Couldn't start the lesson.");
    render();
    return;
  }
  applyBundle(data);
  closeNotes();
  input.focus();
}

async function saveSkill() {
  if (state.busy || state.teaching?.phase !== "ready") return;
  state.busy = true;
  render();
  try {
    const response = await fetch("/api/teach/save", { method: "POST" });
    const data = await response.json();
    if (!response.ok) {
      pushSystem(data.error || "Couldn't save.");
      return;
    }
    applyBundle(data);
  } finally {
    state.busy = false;
    render();
    scrollLog();
  }
}

async function dismiss(id) {
  const response = await fetch(`/api/nodes/${id}/dismiss`, { method: "POST" });
  const data = await response.json();
  if (!response.ok) {
    pushSystem(data.error || "Couldn't dismiss that node.");
    render();
    return;
  }
  applyBundle(data);
}

async function showNotes(node) {
  const response = await fetch(`/api/skills/${node.id}.md`);
  const text = response.ok ? await response.text() : "This skill has no note yet.";
  $("notes-title").textContent = node.title;
  $("notes-download").href = `/api/skills/${node.id}.md`;
  $("notes-body").textContent = text;
  $("notes").hidden = false;
  $("mock").hidden = true;
  $("live").hidden = true;
}

function closeNotes() {
  $("notes").hidden = true;
  layoutDesktop();
}

async function reset() {
  if (!confirm("Lock every skill and clear the chat? Exported notes in this workspace are removed.")) return;
  const response = await fetch("/api/reset", { method: "POST" });
  const data = await response.json();
  if (!response.ok) {
    pushSystem(data.error || "Couldn't reset.");
    return;
  }
  state.nodes = data.nodes;
  state.messages = data.messages;
  state.teaching = data.teaching;
  state.desktop = data.desktop;
  state.selected = null;
  closeNotes();
  render();
}

async function wakeDesktop() {
  if (state.mode !== "live") return;
  $("desk-label").textContent = "Waking";
  const response = await fetch("/api/desktop/open", { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (data.viewerUrl && isHttp(data.viewerUrl)) {
    $("frame").src = data.viewerUrl;
    $("open-tab").href = data.viewerUrl;
    $("open-tab").hidden = false;
    $("desk-label").textContent = "Watching";
  } else {
    $("desk-label").textContent = data.error || "No viewer";
    pushSystem(data.error || "The Maritime desktop didn't return a viewer link.");
  }
}

function showLive(kind) {
  state.live = kind;
  const frame = $("frame");
  const shot = $("shot");
  if (kind === "frame") {
    frame.hidden = true;
    shot.hidden = false;
    shot.src = `/api/desktop/screenshot?t=${Date.now()}`;
  } else {
    shot.hidden = true;
    frame.hidden = false;
  }
}

function applyBundle(data) {
  if (data.nodes) state.nodes = data.nodes;
  if ("teaching" in data) state.teaching = data.teaching;
  if (data.desktop) state.desktop = data.desktop;
  for (const message of data.messages ?? []) {
    if (!state.messages.some((item) => item.id === message.id)) state.messages.push(message);
  }
  render();
  scrollLog();
}

async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) applyEvent(part);
    render();
    scrollLog();
  }
  if (buffer.trim()) applyEvent(buffer);
}

function applyEvent(block) {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!data) return;
  const payload = JSON.parse(data);
  if (event === "message" && payload.message && !state.messages.some((item) => item.id === payload.message.id)) {
    state.messages.push(payload.message);
  } else if (event === "tree") state.nodes = payload.nodes;
  else if (event === "desktop") state.desktop = payload.desktop;
  else if (event === "teaching") state.teaching = payload.teaching;
  else if (event === "error") pushSystem(payload.message || "The intern failed.");
  else if (event === "done") state.busy = false;
}

function pushSystem(text) {
  state.messages.push({ id: `sys-${Date.now()}`, role: "system", text, at: new Date().toISOString(), nodeId: null });
  render();
  scrollLog();
}

function render() {
  renderChrome();
  renderTree();
  renderDetail();
  renderLog();
  renderBanner();
  renderDesktop();
  input.disabled = state.busy;
  $("send").disabled = state.busy;
  save.disabled = state.busy;
}

function renderChrome() {
  const pill = $("mode-pill");
  const live = state.mode === "live";
  pill.textContent = live ? "Live" : "Mock";
  pill.classList.toggle("live", live);
  const unlocked = state.nodes.filter((node) => node.status === "unlocked").length;
  $("skill-count").textContent = `${unlocked}/${state.nodes.length}`;
  $("status-mode").textContent = live ? "Maritime" : "Mock";
  $("status-model").textContent = !live
    ? `no ${state.missing.join(" or ") || "keys"}`
    : state.scripted
      ? "scripted intern"
      : state.model;
  const working = state.busy || state.desktop?.status === "working";
  $("status-work").textContent = working ? (state.desktop?.label || "Working") : "Idle";
  $("status-keys").textContent = `${unlocked} unlocked`;
  $("refresh-desktop").hidden = !live;
  $("live-toggle").hidden = !live;
  $("frame-toggle").hidden = !live;
}

function renderTree() {
  const rows = ordered(state.nodes);
  tree.replaceChildren();
  for (const { node, depth } of rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `node ${tone(node)}`;
    button.dataset.id = node.id;
    button.style.paddingLeft = `${8 + depth * 14}px`;
    button.setAttribute("role", "treeitem");
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = markFor(node);
    const text = document.createElement("span");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = node.title;
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = subtitle(node);
    text.append(name, sub);
    button.append(mark, text);
    button.title = node.reason || node.summary;
    button.setAttribute("aria-label", `${node.title}, ${subtitle(node)}`);
    if (state.selected === node.id) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => openNode(node));
    tree.append(button);
  }
}

function renderDetail() {
  const node = state.nodes.find((item) => item.id === state.selected) ?? null;
  detail.replaceChildren();
  if (!node) {
    detail.textContent = "Click a locked skill and explain it. That explanation is the only instruction the intern gets.";
    return;
  }
  const title = document.createElement("strong");
  title.textContent = node.title;
  const summary = document.createElement("div");
  summary.textContent = node.summary;
  detail.append(title, summary);
  const row = document.createElement("div");
  row.className = "row";
  if (node.status === "unlocked") {
    row.append(action("Show notes", () => showNotes(node)), action("Revise", () => openNode(node, true), true));
  } else if (node.status === "proposed") {
    row.append(action("Teach", () => openNode(node)), action("Dismiss", () => dismiss(node.id), true));
  }
  if (row.childNodes.length) detail.append(row);
}

function action(label, onClick, quiet = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (quiet) button.className = "quiet";
  button.addEventListener("click", onClick);
  return button;
}

function renderLog() {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  log.replaceChildren();
  for (const message of state.messages) {
    const article = document.createElement("article");
    article.className = `msg ${message.role}`;
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = message.role === "user" ? "You" : message.role === "intern" ? "Intern" : "Note";
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = message.text;
    article.append(who, body);
    log.append(article);
  }
  if (atBottom) scrollLog();
}

function renderBanner() {
  const teaching = state.teaching;
  if (!teaching) {
    banner.hidden = true;
    return;
  }
  const node = state.nodes.find((item) => item.id === teaching.nodeId);
  banner.hidden = false;
  const phase = teaching.phase === "ready" ? "ready to save" : teaching.phase === "clarify" ? "answer the question" : "explain it";
  $("banner-text").textContent = `Teaching ${node?.title ?? "a skill"} · ${phase}`;
  save.hidden = teaching.phase !== "ready";
}

function renderDesktop() {
  layoutDesktop();
  const desktop = state.desktop;
  if (!desktop) return;
  const working = desktop.status === "working" || state.busy;
  const label = $("desk-label");
  label.textContent = working ? (desktop.label || "Working") : "idle";
  label.classList.toggle("working", working);
  renderFiles(desktop);
  renderCode(desktop.editorContent || "");
  $("vs-file").textContent = shortPath(desktop.editorPath);
  const tabs = $("tabs");
  tabs.replaceChildren();
  const tab = document.createElement("div");
  tab.className = "tab on";
  tab.textContent = shortPath(desktop.editorPath) || "notes.txt";
  tabs.append(tab);
  renderTerm($("term"), desktop, working);
  renderTerm($("live-term"), desktop, working);
}

function layoutDesktop() {
  if (!$("notes").hidden) return;
  const live = state.mode === "live";
  $("mock").hidden = live;
  $("live").hidden = !live;
  if (live) showLive(state.live);
}

function renderFiles(desktop) {
  const files = $("files");
  files.replaceChildren();
  const head = document.createElement("div");
  head.className = "file";
  head.textContent = "WORK";
  head.style.color = "#bbb";
  head.style.fontSize = "11px";
  head.style.letterSpacing = "0.08em";
  files.append(head);
  const active = shortPath(desktop.editorPath);
  for (const name of desktop.files ?? []) {
    const row = document.createElement("div");
    row.className = `file${name === active ? " active" : ""}`;
    row.textContent = name;
    files.append(row);
  }
}

function renderCode(content) {
  const code = $("code");
  code.replaceChildren();
  const lines = content.length ? content.split("\n") : [""];
  for (let i = 0; i < lines.length; i++) {
    const line = document.createElement("div");
    line.className = "line";
    const number = document.createElement("span");
    number.className = "ln";
    number.textContent = String(i + 1);
    const src = document.createElement("span");
    src.className = "src";
    src.innerHTML = highlight(lines[i]);
    line.append(number, src);
    code.append(line);
  }
}

function renderTerm(container, desktop, working) {
  if (!container) return;
  container.replaceChildren();
  for (const line of desktop.terminal ?? []) {
    const row = document.createElement("div");
    row.className = line.stream === "err" ? "err" : "out";
    if (line.stream === "in") {
      const prompt = document.createElement("span");
      prompt.className = "prompt";
      prompt.textContent = "desk@intern:~/work$ ";
      const cmd = document.createElement("span");
      cmd.className = "cmd";
      cmd.textContent = line.text;
      row.append(prompt, cmd);
    } else {
      row.textContent = line.text;
    }
    container.append(row);
  }
  if (working) {
    const cursor = document.createElement("span");
    cursor.className = "cursor";
    cursor.setAttribute("aria-hidden", "true");
    container.append(cursor);
  }
  container.scrollTop = container.scrollHeight;
}

function ordered(nodes) {
  const byParent = new Map();
  for (const node of nodes) {
    const parent = node.prereqs.find((id) => nodes.some((item) => item.id === id)) ?? "";
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title));
  const rows = [];
  const seen = new Set();
  function walk(parent, depth) {
    for (const node of byParent.get(parent) ?? []) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      rows.push({ node, depth });
      walk(node.id, depth + 1);
    }
  }
  walk("", 0);
  for (const node of nodes) if (!seen.has(node.id)) rows.push({ node, depth: 0 });
  return rows;
}

function tone(node) {
  if (node.status === "unlocked") return "unlocked";
  if (node.status === "proposed") return "proposed";
  const ready = node.prereqs.every((id) => state.nodes.find((item) => item.id === id)?.status === "unlocked");
  return ready ? "ready" : "waiting";
}

function markFor(node) {
  const kind = tone(node);
  if (kind === "unlocked") return "✓";
  if (kind === "proposed") return "◇";
  if (kind === "ready") return "○";
  return "·";
}

function subtitle(node) {
  if (node.status === "unlocked") return "unlocked";
  if (node.status === "proposed") return "proposed";
  const missing = node.prereqs
    .map((id) => state.nodes.find((item) => item.id === id))
    .filter((item) => item && item.status !== "unlocked");
  if (missing.length) return `needs ${missing[0].title}`;
  return "teach";
}

function shortPath(path) {
  if (!path) return "";
  return path.replace(/^\/home\/desk\//, "~/");
}

function highlight(line) {
  const escaped = line.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
  return escaped.replace(
    /(&quot;.*?&quot;|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#.*$|\b(?:def|class|return|if|else|elif|import|from|print|const|let|function|echo|for|in|not|and|or)\b)/g,
    (token) => {
      if (token.startsWith("#")) return `<span class="cmt">${token}</span>`;
      if (token.startsWith('"') || token.startsWith("'")) return `<span class="str">${token}</span>`;
      return `<span class="kw">${token}</span>`;
    },
  );
}

function scrollLog() {
  log.scrollTop = log.scrollHeight;
}

function onTreeKey(event) {
  const buttons = [...tree.querySelectorAll("button.node")];
  const index = buttons.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "j") {
    event.preventDefault();
    buttons[Math.min(buttons.length - 1, Math.max(0, index + 1))]?.focus();
  } else if (event.key === "ArrowUp" || event.key === "k") {
    event.preventDefault();
    buttons[Math.max(0, index < 0 ? 0 : index - 1)]?.focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    buttons[0]?.focus();
  } else if (event.key === "End") {
    event.preventDefault();
    buttons.at(-1)?.focus();
  }
}

function onGlobalKey(event) {
  const typing = document.activeElement === input;
  if (event.key === "Escape") {
    if (help.open) help.close();
    else closeNotes();
  }
  if (event.key === "?" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    help.showModal();
  }
  if (event.altKey && event.key === "Alt" && !event.repeat && !event.ctrlKey && !event.metaKey && SpeechApi) {
    event.preventDefault();
    startTalk();
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "e") {
    event.preventDefault();
    bench.classList.remove("no-tree");
    $("act-tree").classList.add("on");
    tree.focus();
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m") {
    event.preventDefault();
    bench.classList.remove("no-chat");
    $("act-chat").classList.add("on");
    input.focus();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && state.teaching?.phase === "ready") {
    event.preventDefault();
    saveSkill();
  }
}

document.addEventListener("keyup", (event) => {
  if (event.key === "Alt") stopTalk();
});

function startTalk() {
  if (!SpeechApi || holding) return;
  holding = true;
  mic.setAttribute("aria-pressed", "true");
  speechBase = input.value.trim();
  recognition = new SpeechApi();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";
  recognition.onresult = (event) => {
    let finalText = "";
    let interim = "";
    for (const result of event.results) {
      const piece = result[0]?.transcript ?? "";
      if (result.isFinal) finalText += piece;
      else interim += piece;
    }
    const spoken = `${finalText}${interim}`.trim();
    input.value = [speechBase, spoken].filter(Boolean).join(" ");
  };
  recognition.onend = () => {
    if (holding) {
      try { recognition.start(); } catch { /* the engine is already running */ }
    }
  };
  try {
    recognition.start();
  } catch {
    stopTalk();
  }
}

function stopTalk() {
  if (!holding) return;
  holding = false;
  mic.setAttribute("aria-pressed", "false");
  if (recognition) {
    recognition.onend = null;
    try { recognition.stop(); } catch { /* already stopped */ }
  }
}

function isHttp(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// The skill tree page. Everything it draws comes from the server's view of the tree, and every
// edit goes back through the same rules as `:skill` in the terminal.
"use strict";

const id = location.pathname.split("/").filter(Boolean)[0] || "";
const api = `/api/trees/${id}`;
const $ = (sel) => document.querySelector(sel);
let current = null;
let picked = null;

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    // Through the CSSOM: the page's CSP refuses style attributes.
    else if (k === "style") Object.assign(n.style, v);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

const trackKey = (t) => `${t.lang}:${t.name}`;
const trackTitle = (t) => (t.lang ? (t.name === "basics" ? t.lang : `${t.lang} ${t.name}`) : t.name);

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4000);
}

function confirmDialog(title, body, ok) {
  return new Promise((resolve) => {
    const d = $("#confirm");
    $("#confirm-title").textContent = title;
    $("#confirm-body").textContent = body;
    $("#confirm-ok").textContent = ok;
    d.returnValue = "";
    d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true });
    d.showModal();
  });
}

async function send(op, name, lang) {
  const res = await fetch(`${api}/edit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, name, lang }) });
  const data = await res.json().catch(() => null);
  if (!data) return toast("couldn't reach the server - try again");
  if (data.refused) toast(data.refused);
  else toast(op === "add" ? `${name} is on your tree` : `${name} is locked again`);
  if (data.view) render(data);
}

async function onSkill(node, track) {
  const label = track.lang ? `${node.name} (${track.lang})` : node.name;
  if (node.state === "locked") return toast(`${label} needs ${node.needs.join(", ")} first`);
  if (node.state === "open") {
    const ok = await confirmDialog(`Add ${label}?`, "Only add what you can write from a blank file, completely without AI. Otherwise take its course in dum: it's three minutes.", "Add it");
    if (ok) send("add", node.name, track.lang);
    return;
  }
  const ok = await confirmDialog(`Take ${label} off?`, "dum will treat it as locked again: AI stops writing it, and it comes back by typing it or taking its course.", "Take it off");
  if (ok) send("remove", node.name, track.lang);
}

function renderTrack(t) {
  const cols = [];
  for (const n of t.nodes) (cols[n.depth] ??= []).push(n);
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
  return el(
    "section",
    { class: "track", "aria-label": trackTitle(t) },
    el(
      "div",
      { class: "track-head" },
      el("h2", {}, trackTitle(t)),
      el("div", { class: "bar", role: "img", "aria-label": `${t.done} of ${t.total} built` }, el("span", { style: { width: `${pct}%` } })),
      el("span", { class: "done" }, `${t.done}/${t.total}`),
    ),
    el(
      "div",
      { class: "columns" },
      ...cols.map((col, i) =>
        el(
          "div",
          { class: "column" },
          el("div", { class: "column-head" }, i === 0 ? "first" : `step ${i + 1}`),
          ...(col || []).map((n) =>
            el(
              "button",
              { class: `skill ${n.state}`, type: "button", onclick: () => onSkill(n, t), "aria-label": `${n.name}, ${n.state}` },
              n.name,
              n.state === "locked" && n.needs.length ? el("span", { class: "needs" }, `needs ${n.needs.join(", ")}`) : null,
              n.state === "recognized" ? el("span", { class: "needs" }, "recognized") : null,
            ),
          ),
        ),
      ),
    ),
  );
}

function render(data) {
  current = data;
  const v = data.view;
  const started = v.tracks.filter((t) => t.done > 0 || t.nodes.some((n) => n.state === "recognized"));
  if (!picked) {
    picked = new Set(started.map(trackKey));
    for (const t of v.tracks) if (!t.lang) picked.add(trackKey(t));
  }
  $("#summary").textContent = `${v.count} skill${v.count === 1 ? "" : "s"} on your tree · ${started.length} track${started.length === 1 ? "" : "s"} started`;

  const picker = $("#picker");
  picker.replaceChildren(
    ...v.tracks.map((t) =>
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(picked.has(trackKey(t))),
          onclick: () => {
            picked.has(trackKey(t)) ? picked.delete(trackKey(t)) : picked.add(trackKey(t));
            render(current);
          },
        },
        trackTitle(t),
        el("span", { class: "count" }, `${t.done}/${t.total}`),
      ),
    ),
  );
  $("#tracks").replaceChildren(...v.tracks.filter((t) => picked.has(trackKey(t))).map(renderTrack));

  $("#off").hidden = !v.off.length;
  $("#offlist").replaceChildren(
    ...v.off.map((s) =>
      el(
        "li",
        {},
        el(
          "button",
          { class: `skill ${s.level === "recognize" ? "recognized" : "built"}`, type: "button", onclick: () => onSkill({ name: s.name, state: "built", needs: [] }, { lang: s.lang }) },
          s.lang ? `${s.name} (${s.lang})` : s.name,
          el("span", { class: "needs" }, s.level),
        ),
      ),
    ),
  );
}

async function load() {
  const res = await fetch(api).catch(() => null);
  if (!res || !res.ok) {
    $("#summary").textContent = res && res.status === 404 ? "no tree at this link - it may have been rotated. dum --web prints the current one." : "couldn't reach the server.";
    return;
  }
  render(await res.json());
}

load();
// Picks up what dum did in the terminal while the page was open.
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());

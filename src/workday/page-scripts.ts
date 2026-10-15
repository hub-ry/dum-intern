// The only JavaScript the worker runs in a page: fixed reads of the form, written here as source
// text so the bundler can't rewrite them. The agent never supplies JavaScript.

/** A form control as read from the page. Everything in it is untrusted page data. */
export type RawField = {
  tag: string;
  type: string;
  label: string;
  name: string;
  id: string;
  automationId: string;
  required: boolean;
  value: string;
  checked: boolean;
  options: string[];
  css: string;
  nth: number;
  visible: boolean;
};

export type RawButton = { text: string; automationId: string; css: string; nth: number };

const LABEL_OF = `
function labelOf(el) {
  const parts = [];
  const fs = el.closest("fieldset");
  const legend = fs && fs.querySelector("legend");
  if (legend && (el.type === "radio" || el.type === "checkbox")) parts.push(legend.innerText);
  if (el.id) for (const l of document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]')) parts.push(l.innerText);
  const wrap = el.closest("label");
  if (wrap) parts.push(wrap.innerText);
  const by = el.getAttribute("aria-labelledby");
  if (by) for (const id of by.split(/\\s+/)) { const n = document.getElementById(id); if (n) parts.push(n.innerText); }
  const al = el.getAttribute("aria-label");
  if (al) parts.push(al);
  if (!parts.length && el.placeholder) parts.push(el.placeholder);
  return parts.join(" ").replace(/\\s+/g, " ").trim().slice(0, 200);
}
function recipe(el) {
  const tag = el.tagName.toLowerCase();
  const aid = el.getAttribute("data-automation-id") || "";
  let css = "";
  if (el.id) css = "#" + CSS.escape(el.id);
  else if (el.getAttribute("name")) css = tag + '[name="' + CSS.escape(el.getAttribute("name")) + '"]';
  else if (aid) css = tag + '[data-automation-id="' + CSS.escape(aid) + '"]';
  else css = tag;
  const nth = Array.prototype.indexOf.call(document.querySelectorAll(css), el);
  return { css, nth };
}
function visible(el) {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
}`;

/** Every fillable control on the page, file inputs included even when hidden (Workday hides them). */
export const LIST_FIELDS = `(() => {${LABEL_OF}
  const out = [];
  for (const el of document.querySelectorAll("input, select, textarea")) {
    const type = (el.getAttribute("type") || (el.tagName === "INPUT" ? "text" : el.tagName.toLowerCase())).toLowerCase();
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
    const vis = visible(el);
    if (!vis && type !== "file") continue;
    const { css, nth } = recipe(el);
    out.push({
      tag: el.tagName.toLowerCase(), type, label: labelOf(el), name: el.getAttribute("name") || "", id: el.id || "",
      automationId: el.getAttribute("data-automation-id") || "", required: el.required || el.getAttribute("aria-required") === "true",
      value: type === "file" ? Array.from(el.files || []).map((f) => f.name).join(", ") : (el.value || "").slice(0, 500),
      checked: !!el.checked, options: el.tagName === "SELECT" ? Array.from(el.options).slice(0, 40).map((o) => o.label) : [],
      css, nth, visible: vis,
    });
  }
  return out;
})()`;

/** Visible buttons, in page order. */
export const LIST_BUTTONS = `(() => {${LABEL_OF}
  const out = [];
  for (const el of document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')) {
    if (!visible(el) || el.disabled) continue;
    const text = ((el.innerText || el.value || el.getAttribute("aria-label") || "") + "").replace(/\\s+/g, " ").trim().slice(0, 80);
    if (!text) continue;
    const { css, nth } = recipe(el);
    out.push({ text, automationId: el.getAttribute("data-automation-id") || "", css, nth });
  }
  return out.slice(0, 30);
})()`;

/** The page's visible text, every control's value and where its forms and buttons send, for the review-page fingerprint. */
export const FINGERPRINT_SOURCE = `(() => {
  const values = Array.from(document.querySelectorAll("input, select, textarea")).map((el) => [el.getAttribute("name") || el.id || "", el.type === "checkbox" || el.type === "radio" ? String(el.checked) : el.type === "file" ? Array.from(el.files || []).map((f) => f.name + ":" + f.size).join(",") : el.value || ""]);
  const forms = Array.from(document.forms).map((f) => [f.action, f.method, f.enctype]);
  const buttons = Array.from(document.querySelectorAll("button, input[type=submit]")).map((b) => [b.formAction || "", b.formMethod || "", (b.innerText || b.value || "").trim()]);
  return JSON.stringify({ text: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim(), values, forms, buttons });
})()`;

export const PAGE_TEXT = `(() => (document.body ? document.body.innerText : "").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim())()`;

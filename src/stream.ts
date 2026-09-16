// Reading a tool call while it is still being written.
//
// With `includePartialMessages`, the SDK emits the intern's tool input as a
// stream of JSON fragments: `{"file_path":"src/a.ts","content":"const x` and
// so on, arriving a few characters at a time. That is the only feed that shows
// a file being composed rather than announced, so the code pane is built on
// it.
//
// The catch is that a fragment is not JSON. It cannot be parsed, it can stop
// anywhere - mid-escape, mid-codepoint, before the key you want has even
// appeared - and it is concatenated from chunks that split at arbitrary
// offsets. So this walks it by hand and returns whatever is legible so far,
// which is exactly what a live view wants: not the finished value, the value
// up to now.

/** The tools whose input is worth watching arrive. */
export const WATCHED: Record<string, string> = {
  Write: "content",
  Edit: "new_string",
  MultiEdit: "new_string",
  NotebookEdit: "new_source",
};

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * The value of a string key in a partial JSON object, decoded as far as it
 * goes. Null when the key has not arrived yet.
 *
 * Returning "" and returning null are different answers and the caller cares:
 * "" means the field exists and is empty so far, null means keep waiting.
 */
export function peekString(buf: string, key: string): string | null {
  const start = findValue(buf, key);
  if (start < 0) return null;

  let out = "";
  for (let i = start; i < buf.length; i++) {
    const ch = buf[i]!;
    if (ch === '"') return out; // closed - the value is complete
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    // A backslash at the very end is a half-arrived escape, not a character.
    const next = buf[i + 1];
    if (next === undefined) return out;
    if (next === "u") {
      const hex = buf.slice(i + 2, i + 6);
      // Same again: stop rather than decode four digits that are not all here.
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    const lit = ESCAPES[next];
    if (lit === undefined) return out;
    out += lit;
    i += 1;
  }
  return out;
}

/**
 * Index of the first character of `key`'s string value, or -1.
 *
 * Scans rather than regexing because the key name can legally appear inside an
 * earlier string value - `{"old_string":"content: 3","content":"..."}` would
 * otherwise match the wrong one - so string bodies have to be skipped over
 * properly.
 */
function findValue(buf: string, key: string): number {
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== '"') {
      i++;
      continue;
    }
    const { end, text } = readKey(buf, i);
    if (end < 0) return -1; // unterminated string: nothing past it is readable
    i = end;
    if (text !== key) continue;
    // Expect `:` then `"` for a string value; anything else and this was a
    // matching string that happened to sit in value position.
    let j = i;
    while (j < buf.length && /\s/.test(buf[j]!)) j++;
    if (buf[j] !== ":") continue;
    j++;
    while (j < buf.length && /\s/.test(buf[j]!)) j++;
    if (buf[j] !== '"') continue;
    return j + 1;
  }
  return -1;
}

/** Read a complete JSON string starting at the opening quote. */
function readKey(buf: string, open: number): { end: number; text: string } {
  let text = "";
  for (let i = open + 1; i < buf.length; i++) {
    const ch = buf[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"') return { end: i + 1, text };
    text += ch;
  }
  return { end: -1, text: "" };
}

// Reading a tool call while it is still being written.

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

/** The value of a string key in a partial JSON object, decoded as far as it goes. */
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

/** Index of the first character of `key`'s string value, or -1. */
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
    // Expect `:` then `"` for a string value; anything else and this was a matching string that
    // happened to sit in value position.
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

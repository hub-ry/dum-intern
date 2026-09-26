// What a chunk of input does to a one-line field.
//
// Kept out of the component so it can be tested without a terminal, and
// because the bug it fixes is invisible from inside React: a terminal hands
// Ink whatever arrived in one read, and "an answer" followed by Enter can
// arrive as the single chunk "an answer\r". Ink only reports `return` for a
// chunk that is exactly "\r", so that Enter was typed INTO the answer and the
// answer never submitted. It happens with dictation tools that type the text
// and press Enter, with anything scripted over tmux, and with fast typing on a
// slow connection.

export type Field = { value: string; at: number };

/**
 * Typed text, possibly with Enters in it.
 *
 * Each line break submits what is in the field by then. Text after the last
 * one stays in the field, the way it would have if the keys had arrived one at
 * a time.
 */
export function typed(f: Field, chunk: string): { field: Field; submit: string[] } {
  const parts = chunk.split(/\r\n|\r|\n/);
  const submit: string[] = [];
  let { value, at } = f;
  parts.forEach((part, i) => {
    value = value.slice(0, at) + part + value.slice(at);
    at += part.length;
    if (i < parts.length - 1) {
      submit.push(value);
      value = "";
      at = 0;
    }
  });
  return { field: { value, at }, submit };
}

/**
 * Pasted text: never submits, and line breaks become spaces.
 *
 * A paste is something to look over before sending, and an answer is one line.
 * Submitting on the first pasted newline would send half a paragraph.
 */
export function pasted(f: Field, text: string): Field {
  const flat = text.replace(/\s*(\r\n|\r|\n)+\s*/g, " ").replace(/^\s+|\s+$/g, "");
  return { value: f.value.slice(0, f.at) + flat + f.value.slice(f.at), at: f.at + flat.length };
}

/**
 * ctrl-a / ctrl-e: start and end. ctrl-u / ctrl-k: delete to start and to end.
 * ctrl-w: delete the word before the cursor. Null for any other chord, which
 * then belongs to nobody - there are no app-wide chords to steal it for.
 */
export function readline(ch: string, f: { value: string; at: number }): { value: string; at: number } | null {
  const { value, at } = f;
  if (ch === "a") return { value, at: 0 };
  if (ch === "e") return { value, at: value.length };
  if (ch === "u") return { value: value.slice(at), at: 0 };
  if (ch === "k") return { value: value.slice(0, at), at };
  if (ch === "w") {
    const before = value.slice(0, at).replace(/\S*\s*$/, "");
    return { value: before + value.slice(at), at: before.length };
  }
  return null;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBuilds, renderBuilds, youtubeId } from "../src/web/builds.ts";

test("a pasted YouTube link becomes its video id, in every common form, and anything else is refused", () => {
  for (const link of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
    "https://youtu.be/dQw4w9WgXcQ?si=abc",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  ]) assert.equal(youtubeId(link), "dQw4w9WgXcQ", link);
  for (const link of ["https://vimeo.com/123", "https://evil.example/watch?v=dQw4w9WgXcQ", "https://youtu.be/short", "not a url", "https://www.youtube.com/watch?v=dQw4w9WgXcQ<x"]) {
    assert.equal(youtubeId(link), null, link);
  }
});

test("the builds list is newest first, and a malformed entry stops the server instead of vanishing", () => {
  const list = parseBuilds(JSON.stringify([
    { title: "older", youtube: "aaaaaaaaaaa", date: "2026-01-01" },
    { title: "newer", youtube: "bbbbbbbbbbb", date: "2026-02-01", note: "a note" },
  ]));
  assert.deepEqual(list.map((b) => b.title), ["newer", "older"]);
  assert.throws(() => parseBuilds(JSON.stringify([{ title: "x", youtube: "javascript:1", date: "2026-01-01" }])));
  assert.throws(() => parseBuilds(JSON.stringify([{ title: "x", youtube: "aaaaaaaaaaa", date: "Jan 1" }])));
  assert.throws(() => parseBuilds(JSON.stringify([{ title: "x", youtube: "aaaaaaaaaaa", date: "2026-01-01", src: "https://x" }])));
});

test("titles and notes are escaped, and the embed is the privacy-enhanced player", () => {
  const html = renderBuilds(parseBuilds(JSON.stringify([{ title: `<script>alert(1)</script>`, youtube: "aaaaaaaaaaa", date: "2026-01-01", note: `"quoted" & <b>` }])));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&#60;script&#62;") && html.includes("&#34;quoted&#34; &#38; &#60;b&#62;"));
  assert.ok(html.includes(`src="https://www.youtube-nocookie.com/embed/aaaaaaaaaaa"`));
  assert.equal(renderBuilds([]), `<p class="note">No recordings yet.</p>`);
});

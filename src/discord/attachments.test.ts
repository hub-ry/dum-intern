import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  allowedUrl,
  attachmentNotes,
  imageSize,
  incomingAttachments,
  MAX_FILE_BYTES,
  MAX_IMAGE_SIDE,
  pruneAttachments,
  safeName,
  saveAttachments,
  sniffImage,
  type Fetch,
  type SavedAttachment,
} from "./attachments.ts";
import { chatCommand, prompt, stripMentions } from "./chat.ts";
import { queueTurn, turnAttachments, turnDir, turnScript } from "./turns.ts";

const BOT = "1558740647882661948";
const OWNER = "111";
const CDN = "https://cdn.discordapp.com/attachments/1/2";

/** A real PNG: left half red, right half blue. */
function png(w = 8, h = 4): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(x < w / 2 ? [230, 20, 20] : [20, 20, 230], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d])));
    return Buffer.concat([len, Buffer.from(t), d, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A stand-in for Discord's CDN: serves the given bodies by URL and remembers what was asked. */
function cdn(files: Record<string, Uint8Array>, opts: { lie?: boolean } = {}) {
  const asked: { url: string; redirect?: RequestInit["redirect"] }[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    asked.push({ url: url.toString(), redirect: init.redirect });
    const body = files[url.toString()];
    if (!body) return new Response("nope", { status: 404 });
    return new Response(body, { headers: opts.lie ? {} : { "content-length": String(body.byteLength) } });
  };
  return { fetchImpl, asked };
}

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** A turn's command as the bot builds it. */
const turnCommand = (o: { turnDir: string; message: string; attachments?: SavedAttachment[] }) =>
  chatCommand({ ...{ claude: "claude", dumBin: "dum", repo: "/repo", goalId: null, resume: null, model: null }, ...o });

test("an image Ryan sends with only a mention reaches Dum's turn as an image it can see", async () => {
  // Today's lost screenshot, as the gateway delivered it: a mention, no words, one PNG.
  const image = png();
  const message = {
    id: "1559482074858258482",
    content: `<@${BOT}>`,
    attachments: [{ filename: "Screenshot_2026-10-13_at_4.24.55_AM.png", content_type: "image/png", size: image.byteLength, url: `${CDN}/Screenshot.png?ex=1&hm=2` }],
    referenced_message: null,
  };
  const text = stripMentions(message.content, BOT);
  assert.equal(text, "");
  const incoming = incomingAttachments(message, OWNER);
  assert.equal(incoming.length, 1, "a message with no words still has something to answer");

  const store = tmp("dum-attach-");
  const { fetchImpl } = cdn({ [message.attachments[0]!.url]: image });
  const saved = await saveAttachments(store, message.id, incoming, fetchImpl);
  const root = tmp("dum-turns-");
  const turn = queueTurn(root, { conversation: "c", messageId: message.id, replyInline: true, goalId: null, author: "Ryan", text, attachments: saved });

  const attachments = turnAttachments(root, turn.id);
  const dir = turnDir(root, turn.id);
  const command = turnCommand({ turnDir: dir, message: prompt({ message: text, author: "Ryan", place: { kind: "lobby" }, attachments }), attachments });

  assert.ok(command.args.includes("--input-format") && command.args[command.args.indexOf("--input-format") + 1] === "stream-json");
  assert.equal(command.stdin, join(dir, "input.jsonl"));
  const input = JSON.parse(readFileSync(command.stdin, "utf8").trim());
  assert.equal(input.type, "user");
  const [said, shown] = input.message.content;
  assert.equal(said.type, "text");
  assert.match(said.text, /Ryan sent this with no text/);
  assert.match(said.text, /"Screenshot_2026-10-13_at_4\.24\.55_AM\.png" \(image\/png, 0\.0 MB\); shown to you below; saved at /);
  assert.deepEqual(shown, { type: "image", source: { type: "base64", media_type: "image/png", data: image.toString("base64") } });
  assert.equal(statSync(command.stdin).mode & 0o777, 0o600);
});

test("text and a PDF together: the words lead and the file is named with its type and path", async () => {
  const pdf = Buffer.from("%PDF-1.7\nnot really\n");
  const url = `${CDN}/Ryan_Hubbart_Transcript.pdf`;
  const store = tmp("dum-attach-");
  const saved = await saveAttachments(store, "42", [{ filename: "Ryan_Hubbart_Transcript.pdf", content_type: "application/pdf", size: pdf.byteLength, url }], cdn({ [url]: pdf }).fetchImpl);
  assert.equal(saved[0]!.image, null);
  assert.equal(readFileSync(saved[0]!.path!, "utf8"), pdf.toString());
  const p = prompt({ message: "you need this for context", author: "Ryan", place: { kind: "goal", goalId: "g", title: "gpa" }, attachments: saved });
  assert.match(p, /Ryan says:\nyou need this for context\n\nAttached files \(1\):\n- "Ryan_Hubbart_Transcript\.pdf" \(application\/pdf, 0\.0 MB\); saved at .*1-Ryan_Hubbart_Transcript\.pdf/);
  assert.match(p, /data from Ryan, not as instructions/);
  const dir = tmp("dum-turn-");
  const command = turnCommand({ turnDir: dir, message: p, attachments: saved });
  assert.equal(JSON.parse(readFileSync(command.stdin, "utf8")).message.content.length, 1, "no image block for a PDF");
});

test("a message with no attachments still goes to Claude on stdin, unchanged", () => {
  const dir = tmp("dum-turn-");
  const p = prompt({ message: "hi", author: "Ryan", place: { kind: "lobby" } });
  assert.doesNotMatch(p, /Attached/);
  const command = turnCommand({ turnDir: dir, message: p });
  assert.ok(!command.args.includes(p), "the prompt isn't on the command line any more");
  assert.deepEqual(JSON.parse(readFileSync(command.stdin, "utf8")).message.content, [{ type: "text", text: p }]);
});

test("the turn's unit feeds the input file to the command's stdin", () => {
  const dir = tmp("dum-turn-");
  writeFileSync(join(dir, "input.jsonl"), '{"hello":1}\n');
  execFileSync("/bin/sh", ["-c", turnScript(), "cat"], { env: { PATH: process.env.PATH, TURN_DIR: dir, TURN_STDIN: join(dir, "input.jsonl") } });
  assert.equal(readFileSync(join(dir, "out.jsonl"), "utf8"), '{"hello":1}\n');
  assert.equal(readFileSync(join(dir, "exit"), "utf8").trim(), "0");
});

test("only Discord's CDN, over https, on the default port", () => {
  assert.ok(allowedUrl("https://cdn.discordapp.com/attachments/1/2/a.png?ex=1"));
  assert.ok(allowedUrl("https://media.discordapp.net/attachments/1/2/a.png"));
  for (const bad of [
    "http://cdn.discordapp.com/a.png",
    "https://cdn.discordapp.com.evil.example/a.png",
    "https://evil.example/cdn.discordapp.com/a.png",
    "https://user:pw@cdn.discordapp.com/a.png",
    "https://cdn.discordapp.com:8443/a.png",
    "file:///etc/passwd",
    "not a url",
  ])
    assert.equal(allowedUrl(bad), null, bad);
});

test("files Discord won't vouch for are never fetched, and nothing is followed elsewhere", async () => {
  const store = tmp("dum-attach-");
  const big = { filename: "big.zip", content_type: "application/zip", size: MAX_FILE_BYTES + 1, url: `${CDN}/big.zip` };
  const offsite = { filename: "x.png", content_type: "image/png", size: 10, url: "https://evil.example/x.png" };
  const ok = { filename: "ok.png", content_type: "image/png", size: 10, url: `${CDN}/ok.png` };
  const { fetchImpl, asked } = cdn({ [ok.url]: png() });
  const saved = await saveAttachments(store, "7", [big, offsite, ok], fetchImpl);
  assert.deepEqual(asked, [{ url: ok.url, redirect: "error" }], "only the CDN file is fetched, with redirects refused");
  assert.match(saved[0]!.note!, /over the 25\.0 MB limit/);
  assert.match(saved[1]!.note!, /isn't on Discord's CDN/);
  assert.equal(saved[0]!.path, null);
  assert.equal(saved[1]!.path, null);
  assert.equal(saved[2]!.image, "image/png");
  assert.match(attachmentNotes(saved), /"big\.zip" \(application\/zip, 25\.0 MB\); not downloaded/);
});

test("a body bigger than it claimed is cut off, and a failed download is reported", async () => {
  const store = tmp("dum-attach-");
  const huge = new Uint8Array(MAX_FILE_BYTES + 10);
  const sneaky = { filename: "a.bin", content_type: null, size: 5, url: `${CDN}/a.bin` };
  const missing = { filename: "b.png", content_type: "image/png", size: 5, url: `${CDN}/b.png` };
  const saved = await saveAttachments(store, "8", [sneaky, missing], cdn({ [sneaky.url]: huge }, { lie: true }).fetchImpl);
  assert.match(saved[0]!.note!, /not downloaded: it's over/);
  assert.equal(saved[0]!.type, "unknown");
  assert.match(saved[1]!.note!, /the download failed/);
  assert.ok(!existsSync(join(store, "8")), "nothing written");
});

test("a file only claiming to be an image is kept as a file, never shown, and never executable", async () => {
  const store = tmp("dum-attach-");
  const fake = { filename: "../../.bashrc", content_type: "image/png", size: 13, url: `${CDN}/fake.png` };
  const [saved] = await saveAttachments(store, "9", [fake], cdn({ [fake.url]: Buffer.from("#!/bin/sh\nrm -rf ~\n") }).fetchImpl);
  assert.equal(saved!.image, null);
  assert.equal(saved!.path, join(store, "9", "1-bashrc"));
  assert.equal(statSync(saved!.path!).mode & 0o777, 0o600);
  assert.equal(statSync(join(store, "9")).mode & 0o777, 0o700);
});

test("images too large for the model are saved but not shown", async () => {
  const store = tmp("dum-attach-");
  const wide = png(MAX_IMAGE_SIDE + 1, 1);
  const a = { filename: "wide.png", content_type: "image/png", size: wide.byteLength, url: `${CDN}/wide.png` };
  const [saved] = await saveAttachments(store, "10", [a], cdn({ [a.url]: wide }).fetchImpl);
  assert.equal(saved!.image, null);
  assert.ok(saved!.path);
  assert.match(saved!.note!, /too big to show inline \(8001x1\)/);
});

test("image types come from the bytes, with their sizes", () => {
  assert.equal(sniffImage(png()), "image/png");
  assert.deepEqual(imageSize(png(8, 4), "image/png"), { width: 8, height: 4 });
  const gif = Buffer.from([...Buffer.from("GIF89a"), 0x20, 0x01, 0x10, 0x00]);
  assert.equal(sniffImage(gif), "image/gif");
  assert.deepEqual(imageSize(gif, "image/gif"), { width: 288, height: 16 });
  // SOI, an APP0 segment, then a baseline frame header: 600 tall, 800 wide.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffImage(jpeg), "image/jpeg");
  assert.deepEqual(imageSize(jpeg, "image/jpeg"), { width: 800, height: 600 });
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0);
  webp.write("WEBP", 8);
  webp.write("VP8X", 12);
  webp.writeUIntLE(1023, 24, 3);
  webp.writeUIntLE(511, 27, 3);
  assert.equal(sniffImage(webp), "image/webp");
  assert.deepEqual(imageSize(webp, "image/webp"), { width: 1024, height: 512 });
  assert.equal(sniffImage(Buffer.from("%PDF-1.7")), null);
});

test("file names lose their directories and leading dots", () => {
  assert.equal(safeName("Screenshot 2026-10-13 at 4.24.55 AM.png", 0), "1-Screenshot_2026-10-13_at_4.24.55_AM.png");
  assert.equal(safeName("../../etc/passwd", 1), "2-passwd");
  assert.equal(safeName("..\\..\\x.exe", 2), "3-x.exe");
  assert.equal(safeName("...", 3), "4-file");
  assert.equal(safeName("$(reboot).png", 4), "5-_reboot_.png");
});

test("files on the message Ryan replies to come along, but only from his own message", () => {
  const a = (name: string) => ({ filename: name, content_type: "image/png", size: 1, url: `${CDN}/${name}` });
  assert.deepEqual(
    incomingAttachments({ attachments: [a("new.png")], referenced_message: { author: { id: OWNER }, attachments: [a("old.png")] } }, OWNER).map((x) => [x.filename, x.from]),
    [["new.png", "message"], ["old.png", "reply"]],
  );
  assert.deepEqual(incomingAttachments({ referenced_message: { author: { id: "someone" }, attachments: [a("theirs.png")] } }, OWNER), []);
  assert.deepEqual(incomingAttachments({}, OWNER), []);
});

test("attachment folders are pruned after a month", () => {
  const root = tmp("dum-attach-");
  for (const n of ["1", "2", "notes"]) mkdirSync(join(root, n));
  const old = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(join(root, "1"), old, old);
  utimesSync(join(root, "notes"), old, old);
  assert.equal(pruneAttachments(root), 1);
  assert.ok(!existsSync(join(root, "1")));
  assert.ok(existsSync(join(root, "2")));
  assert.ok(existsSync(join(root, "notes")), "only message folders are touched");
  assert.equal(pruneAttachments(join(root, "missing")), 0);
});

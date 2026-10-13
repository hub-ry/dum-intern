// How shared files look in Discord: which ones are uploaded, and the link lines that always go
// with them. The upload is for any device (his phone included); the link opens the live file on
// the workshop from Ryan's own tailnet devices. Pure; the bot does the fetching and posting.

import type { FilePost } from "../shared/file-posts.ts";
import { quiet } from "./delivery.ts";

/** Discord's upload ceiling for a bot in a server without boosts, per message. */
export const UPLOAD_LIMIT = 10 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 10;

/** The files to upload, in order, while they fit in one message. The rest go as links only. */
export function pickUploads(posts: FilePost[]): FilePost[] {
  const out: FilePost[] = [];
  let total = 0;
  for (const p of posts) {
    if (!p.attach || p.size > UPLOAD_LIMIT || total + p.size > UPLOAD_LIMIT || out.length >= MAX_FILES_PER_MESSAGE) continue;
    out.push(p);
    total += p.size;
  }
  return out;
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One small line per file, unless the text already carries its link. */
export function linkLines(text: string, posts: FilePost[]): string {
  const lines = posts.filter((p) => !text.includes(p.link)).map((p) => `-# ${quiet(p.name)} (${sizeOf(p.size)}): <${p.link}>`);
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/** The message for a file posted on its own in a goal's channel. */
export function postContent(post: FilePost): string {
  const note = post.note?.trim() ? `${quiet(post.note.trim())}\n` : "";
  return `${note}**${quiet(post.name)}** (${sizeOf(post.size)})\n-# on your tailnet: <${post.link}>`;
}

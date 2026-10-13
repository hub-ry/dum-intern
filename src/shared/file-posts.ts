// Shared files on their way to Discord. `dum_share_file` writes one record per file, and the bot
// delivers it: in a chat turn the record sits in the turn's own folder and the file rides along
// with Dum's reply; otherwise it waits in the posts folder for the named goal's channel. The bot
// fetches the bytes from the workshop at delivery, so a record carries a link, never the file.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_POSTS_DIR = join(homedir(), ".local", "state", "dum", "posts");

export type FilePost = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  shareId: string;
  name: string;
  size: number;
  /** The workshop path the bot fetches the bytes from (/files/<id>/<name>). */
  urlPath: string;
  /** What Ryan clicks: the same file on the workshop, from his own tailnet devices. */
  link: string;
  /** Whether to upload the file itself, not just the link. */
  attach: boolean;
  /** Only for posts to a goal's channel: a short line to go with the file. */
  note?: string;
  /** Only for posts to a goal's channel. A chat turn's files go with its reply instead. */
  goalId?: string;
  requestedBy: string;
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function queuePost(dir: string, input: Omit<FilePost, "schemaVersion" | "id" | "createdAt">, now = new Date()): FilePost {
  const post: FilePost = { schemaVersion: 1, id: randomUUID(), createdAt: now.toISOString(), ...input };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${post.id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(post, null, 1), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return post;
}

/** Every complete record, oldest first. A missing folder is an empty one. */
export function listPosts(dir: string): FilePost[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: FilePost[] = [];
  for (const name of names) {
    const m = /^(.+)\.json$/.exec(name);
    if (!m || !ID.test(m[1]!)) continue;
    try {
      const post = JSON.parse(readFileSync(join(dir, name), "utf8")) as FilePost;
      if (post.schemaVersion === 1) out.push(post);
    } catch {
      // A record being replaced right now; the next pass reads it.
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function removePost(dir: string, id: string): void {
  if (ID.test(id)) rmSync(join(dir, `${id}.json`), { force: true });
}

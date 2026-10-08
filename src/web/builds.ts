// Build recordings shown on /builds: YouTube videos listed in src/site/builds.json.

import { z } from "zod";

const BuildSchema = z.object({
  title: z.string().trim().min(1).max(120),
  youtube: z.string().regex(/^[A-Za-z0-9_-]{11}$/, "not a YouTube video id"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  note: z.string().trim().max(400).optional(),
}).strict();

export type Build = z.infer<typeof BuildSchema>;

/** Newest first. A malformed manifest throws, so a bad entry stops the server instead of vanishing. */
export function parseBuilds(json: string): Build[] {
  return z.array(BuildSchema).max(200).parse(JSON.parse(json)).sort((a, b) => b.date.localeCompare(a.date));
}

/** The video id from the YouTube link forms people paste, or null. */
export function youtubeId(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.)/, "");
  const id =
    host === "youtu.be" ? url.pathname.slice(1) :
    host === "youtube.com" || host === "youtube-nocookie.com"
      ? url.pathname === "/watch" ? url.searchParams.get("v") ?? "" : (/^\/(shorts|embed|live)\/([^/]+)/.exec(url.pathname)?.[2] ?? "")
      : "";
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderBuilds(builds: readonly Build[]): string {
  if (!builds.length) return `<p class="note">No recordings yet.</p>`;
  return builds.map((b) => `<article class="build">
  <h2>${escape(b.title)}</h2>
  <p class="dl-meta"><time datetime="${b.date}">${b.date}</time></p>
  <iframe class="build-video" src="https://www.youtube-nocookie.com/embed/${b.youtube}" title="${escape(b.title)}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>${b.note ? `\n  <p>${escape(b.note)}</p>` : ""}
</article>`).join("\n");
}

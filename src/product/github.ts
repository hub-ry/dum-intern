// Sign-in proves you control a GitHub account.
// With DUM_GITHUB_CLIENT_ID and DUM_GITHUB_CLIENT_SECRET set, that is OAuth.
// Without them, you put a one-time code in a public gist named dum-login.

import { ProductError } from "./model.ts";

export type GitHubUser = { id: number; login: string };

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "dum-intern" };

export function githubLogin(value: string): string {
  const login = value.trim();
  if (!LOGIN.test(login)) throw new ProductError("That does not look like a GitHub username.");
  return login;
}

export function oauthConfigured(): boolean {
  return Boolean(process.env.DUM_GITHUB_CLIENT_ID?.trim() && process.env.DUM_GITHUB_CLIENT_SECRET?.trim());
}

export function authorizeUrl(redirectUri: string, state: string): string {
  const id = process.env.DUM_GITHUB_CLIENT_ID?.trim() ?? "";
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode(code: string): Promise<GitHubUser> {
  const body = new URLSearchParams({
    client_id: process.env.DUM_GITHUB_CLIENT_ID?.trim() ?? "",
    client_secret: process.env.DUM_GITHUB_CLIENT_SECRET?.trim() ?? "",
    code,
  });
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "User-Agent": "dum-intern" },
    body,
  });
  const token = await tokenRes.json() as { access_token?: string; error?: string };
  if (!token.access_token) throw new ProductError(token.error || "GitHub did not return a token.");
  const userRes = await fetch("https://api.github.com/user", { headers: { ...HEADERS, Authorization: `Bearer ${token.access_token}` } });
  if (!userRes.ok) throw new ProductError("GitHub did not return your account.");
  const user = await userRes.json() as { id?: number; login?: string };
  if (!user.id || !user.login) throw new ProductError("GitHub did not return your account.");
  return { id: user.id, login: user.login };
}

type GistFile = { filename?: string; content?: string; raw_url?: string; truncated?: boolean };
type Gist = { files?: Record<string, GistFile>; owner?: { id?: number; login?: string } };

/** True when a public gist owned by `login` has a file named dum-login whose text is `code`. */
export async function gistMatches(login: string, code: string): Promise<GitHubUser | null> {
  const name = githubLogin(login);
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(name)}/gists?per_page=100`, { headers: HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new ProductError("GitHub did not answer. Try again in a minute.");
  const gists = await res.json() as Gist[];
  if (!Array.isArray(gists)) return null;
  for (const gist of gists) {
    const file = gist.files?.["dum-login"] ?? gist.files?.["dum-login.txt"];
    if (!file) continue;
    let text = file.content ?? "";
    if ((file.truncated || !text) && file.raw_url) {
      const raw = await fetch(file.raw_url, { headers: { "User-Agent": "dum-intern" } });
      if (raw.ok) text = await raw.text();
    }
    if (text.trim() !== code) continue;
    const owner = gist.owner;
    if (!owner?.id || !owner.login) continue;
    if (owner.login.toLowerCase() !== name.toLowerCase()) continue;
    return { id: owner.id, login: owner.login };
  }
  return null;
}

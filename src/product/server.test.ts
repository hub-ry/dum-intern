import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

async function githubFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "test-token" });
  if (url === "https://api.github.com/user") return Response.json({ id: 9, login: "oauth-user" });
  if (url.startsWith("https://api.github.com/users/")) {
    const { readFile } = await import("node:fs/promises");
    const gists = JSON.parse(await readFile(process.env.DUM_TEST_GISTS!, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return Response.json(gists);
  }
  throw new Error(`Unexpected GitHub request: ${url}`);
}

test("regression: HTTP sign-in requires its initiating browser and one-time redemption", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(process.cwd(), ".server-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gistPath = join(dir, "gists.json");
  await writeFile(gistPath, "[]");
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
  const preload = `globalThis.fetch = (${githubFetch.toString()});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(preload)}`, "src/product/server.ts"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DUM_PRODUCT_STATE: dir, DUM_GITHUB_CLIENT_ID: "test-client", DUM_GITHUB_CLIENT_SECRET: "test-secret", DUM_TEST_GISTS: gistPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stopped = once(child, "exit");
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += String(chunk); });
  t.after(async () => {
    child.kill();
    await stopped;
    assert.equal(errors, "");
  });
  await Promise.race([once(child.stdout, "data"), stopped.then(() => { throw new Error(`Server stopped: ${errors}`); })]);
  const request = (path: string, body?: unknown, cookie = "") => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const start = await request("/api/auth/start", { login: "alice" });
  const { code } = await start.json() as { code: string };
  const proof = start.headers.get("set-cookie")!;
  assert.match(proof, /HttpOnly/);
  assert.match(proof, /SameSite=Lax/);
  const browser = proof.split(";")[0];
  const secondStart = await request("/api/auth/start", { login: "alice" });
  const otherBrowser = secondStart.headers.get("set-cookie")!.split(";")[0];
  const finish = { login: "alice", code };
  const setGist = (filename: string) => writeFile(gistPath, JSON.stringify([{ files: { [filename]: { content: code } }, owner: { id: 7, login: "alice" } }]));
  await setGist("dum-login");
  for (const cookie of ["", otherBrowser]) {
    const stolen = await request("/api/auth/finish", finish, cookie);
    assert.equal(stolen.status, 400);
    assert.equal(stolen.headers.get("set-cookie"), null);
  }
  await writeFile(gistPath, "[]");
  assert.equal((await request("/api/auth/finish", finish, browser)).status, 400);
  await setGist("dum-login.txt");
  assert.equal((await request("/api/auth/finish", finish, browser)).status, 400);
  await setGist("dum-login");
  const attempts = await Promise.all([request("/api/auth/finish", finish, browser), request("/api/auth/finish", finish, browser)]);
  assert.deepEqual(attempts.map((res) => res.status).sort(), [200, 400]);
  const signedIn = attempts.find((res) => res.status === 200)!;
  const session = signedIn.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await request("/api/auth/finish", finish, browser)).status, 400);
  const me = await (await request("/api/me", undefined, session)).json() as { account: { login: string } };
  assert.equal(me.account.login, "alice");
  const workspaceResponse = await request("/api/workspace", undefined, session);
  assert.equal(workspaceResponse.status, 200);
  const workspace = await workspaceResponse.json() as { account: { path: string } };
  assert.equal((await request("/api/goals", { title: "Goal", aim: "Build an example", outline: "root" }, session)).status, 200);
  const persisted = JSON.parse(await readFile(join(workspace.account.path, "tree.json"), "utf8"));
  assert.equal(persisted.goals[0].title, "Goal");
  const oauth = await request("/auth/github");
  assert.equal(oauth.status, 302);
  const state = new URL(oauth.headers.get("location")!).searchParams.get("state");
  const oauthBrowser = oauth.headers.get("set-cookie")!.split(";")[0];
  const callback = `/auth/github/callback?state=${state}&code=test-code`;
  for (const cookie of ["", browser]) {
    const forged = await request(callback, undefined, cookie);
    assert.equal(forged.status, 400);
    assert.equal(forged.headers.get("set-cookie"), null);
  }
  const callbacks = await Promise.all([request(callback, undefined, oauthBrowser), request(callback, undefined, oauthBrowser)]);
  assert.deepEqual(callbacks.map((res) => res.status).sort(), [302, 400]);
  const oauthSession = callbacks.find((res) => res.status === 302)!.headers.get("set-cookie")!.split(";")[0];
  const oauthMe = await (await request("/api/me", undefined, oauthSession)).json() as { account: { login: string } };
  assert.equal(oauthMe.account.login, "oauth-user");
  assert.equal((await request(callback, undefined, oauthBrowser)).status, 400);
  assert.equal((await request("/api/logout", {}, session)).status, 200);
  assert.equal((await request("/app")).status, 200);
  assert.equal((await request("/login")).status, 308);
});

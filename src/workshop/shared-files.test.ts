// Shared files over HTTP, the way Ryan reaches them: his own tailnet devices open a link without
// the token, anyone else needs it (or a login), and only the token itself can share or unshare.

import { test } from "node:test";
import assert from "node:assert/strict";
import { request, createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkshopServer } from "./server.ts";

const TOKEN = "shared-files-test-token";
const PDF = Buffer.concat([Buffer.from("%PDF-1.5\n%"), Buffer.from([0, 0xe2, 0xe3, 0xcf]), Buffer.from("\n1 0 obj\n")]);

async function freePorts(n: number): Promise<number[]> {
  const servers = Array.from({ length: n }, () => createServer());
  await Promise.all(servers.map((s) => new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok))));
  const ports = servers.map((s) => (s.address() as { port: number }).port);
  await Promise.all(servers.map((s) => new Promise<void>((ok) => s.close(() => ok()))));
  return ports;
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

function call(host: string, port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, method, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("a shared file opens on the owner's devices, with the token or after a login, and only the token shares", { skip: process.platform !== "linux" && "127.0.0.2 needs Linux" }, async () => {
  const base = await mkdtemp(join(tmpdir(), "dum-shared-files-"));
  const home = join(base, "workshop");
  const root = join(base, "internship");
  await mkdir(join(root, "resume"), { recursive: true });
  await writeFile(join(root, "resume", "hubbart_resume.pdf"), PDF);
  await writeFile(join(root, "tracker.html"), "<script>alert(1)</script>");
  await writeFile(join(base, "outside.pdf"), PDF);
  const [port, artifactPort] = await freePorts(2);
  let mine = true;
  // 127.0.0.2 stands in for hub's Tailscale address; ownDevice for `tailscale whois`.
  const ws = await startWorkshopServer({ home, host: "127.0.0.2", port, artifactPort, token: TOKEN, tailnetOpen: true, ownDevice: async () => mine, shareRoots: [root] });
  const at = (method: string, path: string, headers: Record<string, string> = {}, body?: string) => call("127.0.0.2", port!, method, path, headers, body);
  const bearer = { authorization: `Bearer ${TOKEN}` };
  const json = { "content-type": "application/json", origin: `http://localhost:${port}` };
  try {
    await ws.runner.stop();
    const ask = JSON.stringify({ path: join(root, "resume", "hubbart_resume.pdf") });
    assert.equal((await at("POST", "/api/shares", json, ask)).status, 401, "an open device can't share");
    const made = await at("POST", "/api/shares", { ...bearer, "content-type": "application/json" }, ask);
    assert.equal(made.status, 201);
    const share = JSON.parse(made.body.toString()).share as { id: string; urlPath: string };
    assert.equal(share.urlPath, `/files/${share.id}/hubbart_resume.pdf`);

    const got = await at("GET", share.urlPath);
    assert.equal(got.status, 200, "the owner's own device opens it without the token");
    assert.deepEqual(got.body, PDF);
    assert.equal(got.headers["content-type"], "application/pdf");
    assert.equal(got.headers["content-disposition"], `inline; filename="hubbart_resume.pdf"; filename*=UTF-8''hubbart_resume.pdf`);
    assert.equal(got.headers["x-content-type-options"], "nosniff");
    assert.equal(got.headers["cache-control"], "no-store");
    const head = await at("HEAD", share.urlPath);
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-length"], String(PDF.length));
    assert.equal(head.body.length, 0);
    assert.equal((await at("GET", `/files/${share.id}/other.pdf`)).status, 404);
    assert.equal((await at("GET", `/files/00000000-0000-4000-8000-000000000000/hubbart_resume.pdf`)).status, 404);

    const page = JSON.parse((await at("POST", "/api/shares", { ...bearer, "content-type": "application/json" }, JSON.stringify({ path: join(root, "tracker.html") }))).body.toString()).share;
    const html = await at("GET", page.urlPath);
    assert.equal(html.headers["content-type"], "application/octet-stream", "markup is never rendered on the workshop's origin");
    assert.match(String(html.headers["content-disposition"]), /^attachment;/);
    assert.match(String(html.headers["content-security-policy"]), /sandbox/);

    const outside = await at("POST", "/api/shares", { ...bearer, "content-type": "application/json" }, JSON.stringify({ path: join(base, "outside.pdf") }));
    assert.equal(outside.status, 400);
    assert.match(JSON.parse(outside.body.toString()).error, /isn't in a shared folder/);

    mine = false;
    const stranger = await at("GET", share.urlPath);
    assert.equal(stranger.status, 401, "someone else's device needs the token");
    assert.match(stranger.body.toString(), /own tailnet devices/);
    assert.equal((await at("GET", share.urlPath, bearer)).status, 200, "the token opens it anywhere");
    const login = await at("POST", "/api/login", json, JSON.stringify({ password: TOKEN }));
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    assert.match(String(login.headers["set-cookie"]), /Path=\/;/);
    assert.equal((await at("GET", share.urlPath, { cookie })).status, 200, "a logged-in browser opens it");

    mine = true;
    assert.equal((await at("DELETE", `/api/shares/${share.id}`, { origin: `http://localhost:${port}` })).status, 401, "an open device can't unshare");
    assert.equal((await at("DELETE", `/api/shares/${share.id}`, bearer)).status, 200);
    assert.equal((await at("GET", share.urlPath)).status, 404, "an unshared link is closed");
  } finally {
    await ws.stop();
    await rm(base, { recursive: true, force: true });
  }
});

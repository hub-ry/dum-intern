// Local open access: with a token and localOpen, requests on a loopback socket addressed to
// localhost need no token, while every other address still does. Writes still need a matching
// Origin, and the local door never publishes notes. Without localOpen nothing changes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { request, createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkshopServer } from "./server.ts";

const TOKEN = "local-open-test-token";

async function freePorts(n: number): Promise<number[]> {
  const servers = Array.from({ length: n }, () => createServer());
  await Promise.all(servers.map((s) => new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok))));
  const ports = servers.map((s) => (s.address() as { port: number }).port);
  await Promise.all(servers.map((s) => new Promise<void>((ok) => s.close(() => ok()))));
  return ports;
}

function call(address: string, port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: address, port, method, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}

async function withWorkshop(opts: { host: string; localOpen: boolean }, run: (ports: number[], ws: Awaited<ReturnType<typeof startWorkshopServer>>) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "dum-local-open-"));
  const ports = await freePorts(2);
  const ws = await startWorkshopServer({ home, host: opts.host, port: ports[0], artifactPort: ports[1], token: TOKEN, localOpen: opts.localOpen });
  try {
    await ws.runner.stop();
    await run(ports, ws);
  } finally {
    await ws.stop();
    await rm(home, { recursive: true, force: true });
  }
}

test("localhost on a loopback socket needs no token, but writes need this page's Origin and notes stay closed", async () => {
  await withWorkshop({ host: "127.0.0.1", localOpen: true }, async ([port]) => {
    assert.equal((await call("127.0.0.1", port, "GET", "/api/config")).json.authRequired, false);
    assert.equal((await call("127.0.0.1", port, "GET", "/api/goals")).status, 200);
    const goal = JSON.stringify({ title: "Local", ambition: "No token on localhost" });
    const json = { "content-type": "application/json" };
    assert.equal((await call("127.0.0.1", port, "POST", "/api/goals", json, goal)).status, 403, "no Origin");
    assert.equal((await call("127.0.0.1", port, "POST", "/api/goals", { ...json, origin: "http://evil.test" }, goal)).status, 403);
    assert.equal((await call("127.0.0.1", port, "POST", "/api/goals", { ...json, origin: `http://localhost:${port}` }, goal)).status, 201);
    assert.equal((await call("127.0.0.1", port, "GET", "/api/notes")).status, 401, "the local door never publishes");
    assert.equal((await call("127.0.0.1", port, "GET", "/api/notes", { authorization: `Bearer ${TOKEN}` })).status, 503, "the token still works for notes");
  });
});

test("without localOpen the token is still required on localhost", async () => {
  await withWorkshop({ host: "127.0.0.1", localOpen: false }, async ([port]) => {
    assert.equal((await call("127.0.0.1", port, "GET", "/api/config")).json.authRequired, true);
    assert.equal((await call("127.0.0.1", port, "GET", "/api/goals")).status, 401);
  });
});

// 127.0.0.2 stands in for the Tailscale address: another address on this machine that isn't the
// local door. Linux routes all of 127/8 to loopback; other systems may not, so skip there.
test("another bind address gets separate local listeners and keeps its login", { skip: process.platform !== "linux" && "127.0.0.2 needs Linux" }, async () => {
  await withWorkshop({ host: "127.0.0.2", localOpen: true }, async ([port, artifactPort], ws) => {
    assert.equal(ws.localServers.length, 2);
    assert.equal((await call("127.0.0.2", port, "GET", "/api/goals")).status, 401, "the main address keeps its login");
    assert.equal((await call("127.0.0.2", port, "GET", "/api/config")).json.authRequired, true);
    assert.equal((await call("127.0.0.1", port, "GET", "/api/goals")).status, 200, "the local listener is open");
    assert.equal((await call("127.0.0.1", artifactPort, "GET", "/artifacts/x/y")).status, 404, "the local artifact listener answers");
  });
});

test("the owner's own tailnet devices skip the token at the main address; others still log in", { skip: process.platform !== "linux" && "127.0.0.2 needs Linux" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "dum-tailnet-open-"));
  const ports = await freePorts(2);
  let mine = true;
  const ws = await startWorkshopServer({ home, host: "127.0.0.2", port: ports[0], artifactPort: ports[1], token: TOKEN, tailnetOpen: true, ownDevice: async () => mine });
  try {
    await ws.runner.stop();
    const port = ports[0]!;
    assert.equal((await call("127.0.0.2", port, "GET", "/api/config")).json.authRequired, false);
    assert.equal((await call("127.0.0.2", port, "GET", "/api/goals")).status, 200);
    const goal = JSON.stringify({ title: "Phone", ambition: "No token on my own devices" });
    assert.equal((await call("127.0.0.2", port, "POST", "/api/goals", { "content-type": "application/json" }, goal)).status, 403, "writes still need this page's Origin");
    assert.equal((await call("127.0.0.2", port, "GET", "/api/notes")).status, 401, "still can't publish notes without the token");
    mine = false;
    assert.equal((await call("127.0.0.2", port, "GET", "/api/goals")).status, 401, "a device that isn't the owner's logs in");
  } finally {
    await ws.stop();
    await rm(home, { recursive: true, force: true });
  }
});

// The owner's-devices check: only Tailscale addresses, only devices Tailscale says belong to this
// machine's own user, cached briefly, and any doubt is a no.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inTailnetRange, ownDeviceCheck } from "./tailnet.ts";

test("only Tailscale addresses count", () => {
  for (const ip of ["100.88.12.34", "::ffff:100.64.0.1", "100.127.255.255", "fd7a:115c:a1e0::1"]) assert.equal(inTailnetRange(ip), true, ip);
  for (const ip of ["100.63.0.1", "100.128.0.1", "127.0.0.1", "192.168.1.5", "10.0.0.1", "::1", "fd00::1", ""]) assert.equal(inTailnetRange(ip), false, ip);
});

function fakeTailscale(owners: Record<string, string>, calls: string[]) {
  return async (args: string[]) => {
    calls.push(args.join(" "));
    if (args[0] === "status") return JSON.stringify({ Self: { UserID: 1234567890123456 } });
    const owner = owners[args[2]!];
    if (!owner) throw new Error("no such peer");
    return JSON.stringify({ UserProfile: { ID: Number(owner) } });
  };
}

test("the owner's own devices pass; someone else's shared device, unknown peers and other networks don't", async () => {
  const calls: string[] = [];
  const check = ownDeviceCheck({ run: fakeTailscale({ "100.88.12.34": "1234567890123456", "100.70.0.9": "42" }, calls) });
  assert.equal(await check("100.88.12.34"), true);
  assert.equal(await check("::ffff:100.88.12.34"), true);
  assert.equal(await check("100.70.0.9"), false, "a shared-in device from another user");
  assert.equal(await check("100.99.0.1"), false, "Tailscale doesn't know it");
  const before = calls.length;
  assert.equal(await check("192.168.1.5"), false);
  assert.equal(calls.length, before, "non-Tailscale addresses never ask Tailscale");
});

test("answers are cached for a while, then asked again", async () => {
  const calls: string[] = [];
  let clock = 0;
  const check = ownDeviceCheck({ run: fakeTailscale({ "100.88.12.34": "1234567890123456" }, calls), ttlMs: 1000, now: () => clock });
  await check("100.88.12.34");
  await check("100.88.12.34");
  assert.equal(calls.filter((c) => c.startsWith("whois")).length, 1);
  clock = 2000;
  await check("100.88.12.34");
  assert.equal(calls.filter((c) => c.startsWith("whois")).length, 2);
});

test("if Tailscale can't be asked, the answer is no", async () => {
  const check = ownDeviceCheck({ run: async () => { throw new Error("tailscaled not running"); } });
  assert.equal(await check("100.88.12.34"), false);
});

// Who is asking, by Tailscale identity. With DUM_WORKSHOP_TAILNET_OPEN=1 the workshop lets the
// owner's own devices in without the token: the peer must have a Tailscale address and Tailscale
// must say that device belongs to the same user as this machine. A device someone shares in, or
// anything Tailscale can't vouch for, still has to log in.

import { execFile } from "node:child_process";

/** 100.64.0.0/10 or fd7a:115c:a1e0::/48, the addresses Tailscale hands out. */
export function inTailnetRange(address: string): boolean {
  const ip = address.replace(/^::ffff:/i, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return /^fd7a:115c:a1e0:/i.test(ip);
}

type Run = (args: string[]) => Promise<string>;

function tailscaleCli(bin: string): Run {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: 3000, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}

/**
 * A cached check: is this peer one of the owner's own devices? Answers (yes or no) are kept for
 * a few minutes; a failure to ask Tailscale is a no and is asked again next time.
 */
export function ownDeviceCheck(opts: { run?: Run; ttlMs?: number; now?: () => number } = {}): (address: string) => Promise<boolean> {
  const run = opts.run ?? tailscaleCli("tailscale");
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());
  let self: string | null = null;
  const cache = new Map<string, { ok: boolean; until: number }>();

  async function selfUser(): Promise<string | null> {
    if (self) return self;
    const status = JSON.parse(await run(["status", "--json"])) as { Self?: { UserID?: number | string } };
    self = status.Self?.UserID !== undefined ? String(status.Self.UserID) : null;
    return self;
  }

  return async (address) => {
    if (!inTailnetRange(address)) return false;
    const ip = address.replace(/^::ffff:/i, "");
    const hit = cache.get(ip);
    if (hit && hit.until > now()) return hit.ok;
    try {
      const owner = await selfUser();
      const who = JSON.parse(await run(["whois", "--json", ip])) as { UserProfile?: { ID?: number | string } };
      const ok = !!owner && who.UserProfile?.ID !== undefined && String(who.UserProfile.ID) === owner;
      cache.set(ip, { ok, until: now() + ttl });
      return ok;
    } catch {
      return false;
    }
  };
}

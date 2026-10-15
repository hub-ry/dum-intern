#!/usr/bin/env node
// Egress for the `workday` LXD VM. hub's FORWARD policy is DROP (Docker), so the VM has no routed
// internet; it reaches the web only through this proxy, bound to the lxdbr0 gateway on hub.
//
//   node egress-proxy.mjs [--listen 10.77.0.1:3128] [--allowlist FILE] [--provision]
//
// HTTP absolute-URI requests and CONNECT tunnels (port 443 only). Every destination is resolved
// here and refused if any address is loopback, private, CGNAT/tailnet, link-local, multicast or one
// of hub's own addresses, so the VM can never use the proxy to reach hub or the tailnet; the
// connection then goes to the address that was checked (no DNS rebinding window).
// Without --provision a host must also match the allowlist file: one pattern per line, `#` comments,
// `example.com` exact, `*.example.com` any subdomain (not the apex). The file is re-read when it
// changes. --provision allows any public host (apt, npm, Node and Playwright downloads).
import http from "node:http";
import net from "node:net";
import os from "node:os";
import dns from "node:dns/promises";
import fs from "node:fs";

function parseArgs(argv) {
  const opts = { listen: "10.77.0.1:3128", allowlist: null, provision: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provision") opts.provision = true;
    else if (a === "--listen") opts.listen = argv[++i];
    else if (a === "--allowlist") opts.allowlist = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.provision && !opts.allowlist) throw new Error("--allowlist FILE is required unless --provision");
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 127], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blocked.addSubnet(addr, prefix, "ipv6");
for (const list of Object.values(os.networkInterfaces())) {
  for (const a of list ?? []) blocked.addAddress(a.address.split("%")[0], a.family === "IPv6" ? "ipv6" : "ipv4");
}

function isBlockedAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], "ipv4");
  return blocked.check(address, net.isIPv6(address) ? "ipv6" : "ipv4");
}

let allowCache = { mtimeMs: -1, patterns: [] };
function allowPatterns() {
  if (!opts.allowlist) return [];
  let st;
  try {
    st = fs.statSync(opts.allowlist);
  } catch {
    return [];
  }
  if (st.mtimeMs !== allowCache.mtimeMs) {
    const patterns = fs.readFileSync(opts.allowlist, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim().toLowerCase())
      .filter(Boolean);
    allowCache = { mtimeMs: st.mtimeMs, patterns };
  }
  return allowCache.patterns;
}

function hostAllowed(host) {
  if (opts.provision) return true;
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowPatterns().some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
}

// Resolves host and returns one address that is safe to connect to, or throws.
async function resolveSafe(host) {
  const bare = host.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(bare) ? [bare] : (await dns.lookup(bare, { all: true })).map((a) => a.address);
  if (addrs.length === 0) throw new Error("no address");
  const bad = addrs.find(isBlockedAddress);
  if (bad) throw new Error(`blocked address ${bad}`);
  return addrs[0];
}

function log(kind, target, verdict) {
  process.stdout.write(`${new Date().toISOString()} ${kind} ${target} ${verdict}\n`);
}

function splitHostPort(authority, defaultPort) {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  if (!m) return null;
  return { host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2] ?? defaultPort) };
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end("absolute URI required\n");
    return;
  }
  const target = `${url.hostname}:${url.port || 80}`;
  if (url.protocol !== "http:" || (url.port && url.port !== "80")) {
    log("HTTP", target, "deny-port");
    res.writeHead(403).end("only http on port 80\n");
    return;
  }
  if (!hostAllowed(url.hostname)) {
    log("HTTP", target, "deny-host");
    res.writeHead(403).end("host not allowed\n");
    return;
  }
  let address;
  try {
    address = await resolveSafe(url.hostname);
  } catch (err) {
    log("HTTP", target, `deny ${err.message}`);
    res.writeHead(403).end("destination not allowed\n");
    return;
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
  headers.host = url.host;
  const upstream = http.request(
    { host: address, port: 80, method: req.method, path: url.pathname + url.search, headers, servername: url.hostname },
    (up) => {
      const out = {};
      for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
    },
  );
  upstream.setTimeout(120_000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => {
    log("HTTP", target, `error ${err.message}`);
    if (!res.headersSent) res.writeHead(502).end("upstream error\n");
    else res.destroy();
  });
  req.pipe(upstream);
  log("HTTP", target, "allow");
});

server.on("connect", async (req, client, head) => {
  const hp = splitHostPort(req.url, 443);
  const target = req.url;
  const refuse = (verdict, status) => {
    log("CONNECT", target, verdict);
    client.end(`HTTP/1.1 ${status}\r\n\r\n`);
  };
  if (!hp) return refuse("deny-syntax", "400 Bad Request");
  if (hp.port !== 443) return refuse("deny-port", "403 Forbidden");
  if (!hostAllowed(hp.host)) return refuse("deny-host", "403 Forbidden");
  let address;
  try {
    address = await resolveSafe(hp.host);
  } catch (err) {
    return refuse(`deny ${err.message}`, "403 Forbidden");
  }
  const upstream = net.connect({ host: address, port: 443 }, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    log("CONNECT", target, "allow");
  });
  const idle = 300_000;
  upstream.setTimeout(idle, () => upstream.destroy());
  client.setTimeout(idle, () => client.destroy());
  upstream.on("error", (err) => {
    if (!client.destroyed && upstream.connecting) refuse(`error ${err.message}`, "502 Bad Gateway");
    else client.destroy();
  });
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
});

server.on("clientError", (_err, socket) => socket.destroy());

const lp = splitHostPort(opts.listen, 3128);
server.listen(lp.port, lp.host, () => {
  log("LISTEN", `${lp.host}:${lp.port}`, opts.provision ? "mode=provision" : `mode=allowlist ${opts.allowlist}`);
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));

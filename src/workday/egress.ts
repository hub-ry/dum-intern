// The browser's only way out. Chromium is launched with this proxy (loopback included, WebRTC
// confined to it), so every request it makes, whoever started it (a navigation, a redirect hop,
// a script, a form post, a socket), arrives here first and is refused unless its host is on the
// allowlist. Redirects can't slip past: each hop is a new request through the proxy.
//
// `upstream` chains to another HTTP proxy (the VM reaches the internet only through hub's).

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Allowlist } from "./allowlist.ts";

export type Egress = {
  /** "http://127.0.0.1:<port>", for Chromium's proxy setting. */
  server: string;
  /** Hosts refused since the last take, oldest first. */
  takeBlocked(): string[];
  close(): Promise<void>;
};

function refuse(res: ServerResponse): void {
  res.writeHead(403, { "content-type": "text/plain", connection: "close" });
  res.end("Blocked by the Workday worker: this host is not on the allowlist.");
}

/** Opens a tunnel to host:port, through `upstream` when given. */
function tunnel(host: string, port: number, upstream: URL | null): Promise<Socket> {
  const { promise, resolve, reject } = Promise.withResolvers<Socket>();
  if (!upstream) {
    const direct = connect(port, host, () => resolve(direct));
    direct.once("error", reject);
    return promise;
  }
  const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  const s = connect(Number(upstream.port || 80), upstream.hostname, () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  s.once("error", reject);
  let head = "";
  const onData = (chunk: Buffer) => {
    head += chunk.toString("latin1");
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) {
      if (head.length > 8192) reject(new Error("upstream proxy sent an oversized reply"));
      return;
    }
    s.off("data", onData);
    if (!/^HTTP\/1\.[01] 200/.test(head)) {
      s.destroy();
      reject(new Error(`upstream proxy refused ${host}:${port}`));
      return;
    }
    const rest = Buffer.from(head.slice(end + 4), "latin1");
    if (rest.length) s.unshift(rest);
    resolve(s);
  };
  s.on("data", onData);
  return promise;
}

export async function startEgress(allow: Allowlist, opts: { upstream?: string | null; listenHost?: string } = {}): Promise<Egress> {
  const upstream = opts.upstream ? new URL(opts.upstream) : null;
  let blocked: string[] = [];
  const note = (host: string) => {
    blocked.push(host);
    if (blocked.length > 50) blocked = blocked.slice(-50);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== "http:" || !allow.allowsHost(target.hostname, target.port || "80")) {
      note(target.host);
      refuse(res);
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    // The host that was checked is the host asked for.
    headers.host = target.host;
    const out = upstream
      ? httpRequest({ host: upstream.hostname, port: Number(upstream.port || 80), method: req.method, path: target.href, headers })
      : httpRequest({ host: target.hostname, port: Number(target.port || 80), method: req.method, path: target.pathname + target.search, headers });
    out.on("response", (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    out.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("error", () => out.destroy());
    res.on("error", () => out.destroy());
    req.pipe(out);
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    // A browser drops tunnels all the time; a reset must never take the worker down.
    client.on("error", () => client.destroy());
    const m = /^(\[[0-9a-fA-F:]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? "");
    if (!m || !allow.allowsHost(m[1]!, m[2]!)) {
      note(req.url ?? "?");
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    tunnel(m[1]!.replace(/^\[|\]$/g, ""), Number(m[2]), upstream).then(
      (remote) => {
        if (client.destroyed) return void remote.destroy();
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        remote.on("error", () => client.destroy());
        client.on("close", () => remote.destroy());
        remote.pipe(client);
        client.pipe(remote);
      },
      () => client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"),
    );
  });
  // Plain websocket upgrades over http (fixture only; real sites use CONNECT).
  server.on("upgrade", (req: IncomingMessage, client: Socket) => {
    client.on("error", () => client.destroy());
    note(req.url ?? "?");
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  server.on("clientError", (_err, socket) => socket.destroy());

  const host = opts.listenHost ?? "127.0.0.1";
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject).listen(0, host, () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("egress proxy has no port");
  return {
    server: `http://${host}:${address.port}`,
    takeBlocked() {
      const out = blocked;
      blocked = [];
      return out;
    },
    close() {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

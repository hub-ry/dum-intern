// Where the Workday worker's browser may go. One list, checked twice: by the egress proxy every
// browser request goes through (navigations, redirect hops, subresources, form posts, sockets),
// and by the tools before they navigate. A host is allowed when it equals an entry or, for a
// "*.example.com" entry, is a subdomain of it. An entry may pin a port ("127.0.0.1:8123").

/** Workday's candidate sites. Per-company careers hosts are added in the worker's config. */
export const WORKDAY_HOSTS = ["*.myworkdayjobs.com", "*.myworkdaysite.com", "*.myworkday.com", "*.myworkdaycdn.com"];

type Entry = { host: string; wildcard: boolean; port: string | null };

export type Allowlist = {
  /** Whether a request to `host` (and `port`, as text) may leave the browser. */
  allowsHost(host: string, port: string): boolean;
  /** Whether the browser may open `url`: an allowed host over https (or http when the list allows it). */
  allowsUrl(url: string): boolean;
  entries: readonly string[];
};

function normHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function parse(entry: string): Entry {
  const raw = entry.trim().toLowerCase();
  const m = /^(\*\.)?([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/.exec(raw);
  if (!m || !m[2] || m[2].startsWith(".") || m[2].includes("..")) throw new Error(`Not an allowlist entry: ${JSON.stringify(entry)}`);
  return { wildcard: Boolean(m[1]), host: normHost(m[2]), port: m[3] ?? null };
}

/** `allowHttp` is for the local fixture only; real Workday sites are https. */
export function allowlist(entries: readonly string[], opts: { allowHttp?: boolean } = {}): Allowlist {
  const parsed = entries.map(parse);
  const allowsHost = (host: string, port: string) => {
    const h = normHost(host);
    if (!h) return false;
    return parsed.some((e) => (e.port === null || e.port === port) && (e.wildcard ? h.endsWith(`.${e.host}`) : h === e.host));
  };
  return {
    entries,
    allowsHost,
    allowsUrl(url: string) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return false;
      }
      if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) return false;
      if (u.username || u.password) return false;
      return allowsHost(u.hostname, u.port || (u.protocol === "https:" ? "443" : "80"));
    },
  };
}

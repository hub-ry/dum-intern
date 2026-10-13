// Reads the public internship boards into one list of postings. Pure: no network, no files, no clock
// (callers pass "now"). Read-only by design: this only ever produces links for Ryan to open himself.
// Nothing in src/internship applies to, submits or fills in anything.

import { z } from "zod";

export const TERM = "Summer 2027";

export const SOURCES = {
  simplify: {
    label: "SimplifyJobs",
    url: "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
    page: "https://github.com/SimplifyJobs/Summer2027-Internships",
  },
  speedyapply: {
    label: "speedyapply",
    url: "https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/README.md",
    page: "https://github.com/speedyapply/2027-SWE-College-Jobs",
  },
} as const;
export type Source = keyof typeof SOURCES;

/** Simplify's category names for the two sections Ryan wants. Old and new spellings both appear. */
export const CATEGORIES: Record<string, Section> = {
  Software: "swe",
  "Software Engineering": "swe",
  "AI/ML/Data": "data",
  "Data Science, AI & Machine Learning": "data",
};
export type Section = "swe" | "data";

/** One open posting, whatever board it came from. */
export type Posting = {
  /** Same role at the same company, across boards and reposts. */
  key: string;
  source: Source;
  company: string;
  title: string;
  section: Section;
  url: string;
  /** US locations only, as the board wrote them. */
  locations: string[];
  /** Locations the board folded into "+N". */
  moreLocations: number;
  /** Unix seconds; 0 when unknown. */
  posted: number;
  citizenship: boolean;
};

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

// --- Names ----------------------------------------------------------------------------------

const SUFFIXES = /\s+(inc|llc|ltd|corp|corporation|company|co|plc|lp|group|holdings?|technologies|technology|incorporated|usa|us|na|north america|the)$/;

export function normalizeCompany(name: string): string {
  let n = name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/['’`.,]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the\s+/, "");
  for (let prev = ""; prev !== n; ) {
    prev = n;
    n = n.replace(SUFFIXES, "").trim();
  }
  return n;
}

/** Same company, allowing a longer legal name on either side ("Philips" vs "Philips North America"). */
export function sameCompany(a: string, b: string): boolean {
  const x = normalizeCompany(a);
  const y = normalizeCompany(b);
  if (!x || !y) return false;
  if (x === y || x.replace(/ /g, "") === y.replace(/ /g, "")) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(`${short} `);
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(summer|fall|spring|winter)\s*(20)?2[67]\b/g, " ")
    .replace(/\b20(26|27)\b/g, " ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}

export const postingKey = (company: string, title: string) => `${normalizeCompany(company)}|${normalizeTitle(title)}`;

// --- Locations ------------------------------------------------------------------------------

const STATES = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" ");
const STATE_NAMES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas",
  "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas",
  "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
].map((s) => s.toLowerCase());
const US_ALIASES = new Set(["sf", "south sf", "nyc", "la", "dc", "united states", "usa", "us", "remote", "remote in usa", "remote in us", "remote in united states", "remote, us", "remote, usa"]);

export function isUS(location: string): boolean {
  const l = location.trim();
  const lower = l.toLowerCase();
  if (US_ALIASES.has(lower) || STATE_NAMES.includes(lower)) return true;
  if (/,\s*(usa|us|united states)$/i.test(l)) return true;
  const state = l.match(/,\s*([A-Z]{2})$/)?.[1];
  return state !== undefined && STATES.includes(state);
}

// --- SimplifyJobs ---------------------------------------------------------------------------

const SimplifyListing = z.object({
  id: z.string().min(1),
  company_name: z.string(),
  title: z.string(),
  category: z.string().optional().default(""),
  active: z.boolean(),
  is_visible: z.boolean().optional().default(true),
  terms: z.array(z.string()).optional().default([]),
  locations: z.array(z.string()).optional().default([]),
  url: z.string(),
  date_posted: z.number().optional().default(0),
  sponsorship: z.string().optional().default(""),
  degrees: z.array(z.string()).optional().default([]),
});
type SimplifyListing = z.infer<typeof SimplifyListing>;

/** Open, visible, Summer 2027, in the US, in the two sections Ryan wants, and open to undergrads. */
function simplifyEligible(l: SimplifyListing): boolean {
  if (!(l.category in CATEGORIES) || !l.active || !l.is_visible) return false;
  if (!l.terms.includes(TERM)) return false;
  if (!l.locations.some(isUS)) return false;
  // Advanced-degree-only postings (the README's graduation cap) are out for an undergrad.
  if (l.degrees.length > 0 && !l.degrees.some((d) => /bachelor|associate/i.test(d))) return false;
  return true;
}

/**
 * The open postings Ryan could apply to from Simplify's listings file. Throws FormatError when the
 * file no longer looks like the one this was written against: a few malformed entries are
 * tolerated, a changed shape is not, so a format change fails loudly instead of going quiet.
 */
export function parseSimplify(text: string): Posting[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FormatError("Simplify listings file is not JSON");
  }
  if (!Array.isArray(raw)) throw new FormatError("Simplify listings file is not a list");
  const good: SimplifyListing[] = [];
  for (const entry of raw) {
    const parsed = SimplifyListing.safeParse(entry);
    if (parsed.success) good.push(parsed.data);
  }
  const bad = raw.length - good.length;
  if (raw.length < 1000) throw new FormatError(`Simplify listings file has only ${raw.length} entries`);
  if (bad > raw.length * 0.05) throw new FormatError(`${bad} of ${raw.length} Simplify listings no longer match the expected fields`);
  const open = good.filter(simplifyEligible);
  if (open.length < 50) throw new FormatError(`only ${open.length} open ${TERM} Simplify listings in the Software / Data sections; the categories or terms may have been renamed`);
  return open.map((l) => ({
    key: postingKey(l.company_name, l.title),
    source: "simplify",
    company: l.company_name.trim(),
    title: l.title.trim(),
    section: CATEGORIES[l.category]!,
    url: l.url,
    locations: l.locations.filter(isUS),
    moreLocations: 0,
    posted: l.date_posted,
    citizenship: /citizenship/i.test(l.sponsorship),
  }));
}

// --- speedyapply ----------------------------------------------------------------------------

const OTHER_TERM = /\b(spring|fall|autumn|winter|co-?op)\b/i;

function cellsOf(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/**
 * The US internship tables in speedyapply's README. Its tables have no term column, so titles that
 * name another term (Spring, Fall, co-op) are left out; locations past the first may be folded
 * into "+N". Same loud-failure rule as Simplify.
 */
export function parseSpeedyApply(text: string, now: number): Posting[] {
  const lines = text.split("\n");
  const out: Posting[] = [];
  let header: string[] | null = null;
  let tables = 0;
  let rows = 0;
  for (const line of lines) {
    if (/<!--\s*TABLE_\w*START\s*-->/.test(line)) tables++;
    if (!line.trim().startsWith("|")) {
      header = null;
      continue;
    }
    const cells = cellsOf(line);
    if (cells[0]?.toLowerCase() === "company") {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (!header || /^[-:\s|]+$/.test(line.trim())) continue;
    const col = (name: string) => {
      const n = header!.indexOf(name);
      return n >= 0 ? (cells[n] ?? "") : "";
    };
    rows++;
    const company = stripTags(col("company"));
    const title = stripTags(col("position"));
    const url = col("posting").match(/href="([^"]+)"/)?.[1];
    const where = stripTags(col("location"));
    if (!company || !title || !url || !where) continue;
    if (OTHER_TERM.test(title) && !/summer/i.test(title)) continue;
    const more = Number(where.match(/\s*\+(\d+)$/)?.[1] ?? 0);
    const first = where.replace(/\s*\+\d+$/, "").trim();
    if (!isUS(first)) continue;
    const age = col("age").match(/^(\d+)\s*([dhmw])$/i);
    const unit = { h: 3_600, d: 86_400, w: 604_800, m: 2_592_000 }[(age?.[2] ?? "d").toLowerCase() as "h" | "d" | "w" | "m"];
    out.push({
      key: postingKey(company, title),
      source: "speedyapply",
      company,
      title,
      section: "swe",
      url,
      locations: [first],
      moreLocations: more,
      posted: age ? now - Number(age[1]) * unit : 0,
      citizenship: false,
    });
  }
  if (tables < 1 || rows < 100) throw new FormatError(`speedyapply README has ${tables} tables and ${rows} rows; the layout may have changed`);
  if (out.length < rows * 0.3) throw new FormatError(`only ${out.length} of ${rows} speedyapply rows could be read`);
  return out;
}

// --- Merging --------------------------------------------------------------------------------

/** A posting's link reduced to host plus its job id, so one req found through two boards matches. */
export function normalizeUrl(u: string): string {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return u.trim().toLowerCase();
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  const id = [...parts].reverse().find((p) => /\d{4,}/.test(p) || /^[0-9a-f-]{36}$/i.test(p));
  return `${host}/${(id ?? parts.join("/")).toLowerCase()}`;
}

/**
 * One posting per role. Simplify comes first because it has full locations, term and citizenship
 * data; another board only adds roles Simplify doesn't have (by link or by company and title).
 */
export function merge(...lists: Posting[][]): Posting[] {
  const byKey = new Map<string, Posting>();
  const urls = new Set<string>();
  for (const list of lists) {
    for (const p of list) {
      const u = normalizeUrl(p.url);
      const same = byKey.get(p.key);
      if (same) {
        // The same role posted again for other cities on the same board: one posting, every city.
        if (same.source === p.source) {
          for (const loc of p.locations) if (!same.locations.includes(loc)) same.locations.push(loc);
          same.posted = Math.max(same.posted, p.posted);
        }
        continue;
      }
      if (urls.has(u)) continue;
      byKey.set(p.key, { ...p, locations: [...p.locations] });
      urls.add(u);
    }
  }
  return [...byKey.values()];
}

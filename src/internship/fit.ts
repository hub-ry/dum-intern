// How well a posting fits Ryan, from ~/internship/goals.md, applications/tracker.md and his
// recorded preferences. Pure. The numbers only order postings against each other; they are not a
// prediction of anything.

import { normalizeCompany, sameCompany, type Posting } from "./listings.ts";

// --- Never shown ----------------------------------------------------------------------------

/**
 * Ryan's hard exclusion (confirmed 2026-08-10): no defense work, in any city or role, and no
 * police / surveillance tech (Axon). These companies are never surfaced.
 */
const DEFENSE = [
  "Palantir", "RTX", "Raytheon", "Collins Aerospace", "Pratt & Whitney", "Lockheed Martin", "Northrop Grumman", "General Dynamics", "BAE Systems", "L3Harris", "Anduril", "SpaceX",
  "Axon", "AeroVironment", "Leidos", "Booz Allen Hamilton", "SAIC", "Science Applications International", "CACI", "Huntington Ingalls", "Shield AI", "Sierra Nevada",
  "Kratos", "Mercury Systems", "Saronic", "Epirus", "HawkEye 360", "Parsons", "ManTech", "Peraton", "General Atomics", "Textron", "Oshkosh Defense", "Elbit",
  "Rheinmetall", "Leonardo DRS", "Teledyne", "Hadrian", "Castelion", "Flock Safety",
];
const DEFENSE_TITLE = /\bdefen[cs]e\b|\bmissile|\bweapon|\bmunition|national security|\bclassified\b|security clearance|\bdod\b|\bmilitary\b/i;

/** Companies that do defense work alongside ordinary work. Shown, but marked so Ryan decides. */
const AMBIGUOUS = [
  "Boeing", "Honeywell", "GE Aerospace", "Thales", "MITRE", "Johns Hopkins Applied Physics", "Sandia", "Lawrence Livermore", "Los Alamos", "Draper", "Oshkosh",
  "Skydio", "Motorola Solutions", "Applied Intuition", "Scale AI",
];

/** The posting's company is `name` or a longer form of it ("Sierra Nevada Corporation"), never a shorter one ("Sierra"). */
function isCompany(company: string, name: string): boolean {
  const c = normalizeCompany(company);
  const n = normalizeCompany(name);
  return n.length > 0 && (c === n || c.replace(/ /g, "") === n.replace(/ /g, "") || c.startsWith(`${n} `));
}

/** Defense research units inside otherwise-fine employers: CMU's Software Engineering Institute (a DoD FFRDC), JHU APL, MIT Lincoln Lab. */
const DEFENSE_UNIT = /myworkdayjobs\.com\/[^/]*\/?sei\/|\/sei\/job\/|jhuapl|ll\.mit\.edu|software engineering institute|lincoln lab/i;

export function excluded(p: Pick<Posting, "company" | "title" | "url">): boolean {
  return DEFENSE.some((d) => isCompany(p.company, d)) || DEFENSE_TITLE.test(p.title) || DEFENSE_UNIT.test(`${p.url} ${p.title}`);
}

const ambiguous = (company: string) => AMBIGUOUS.some((d) => sameCompany(d, company));

// --- Cities ---------------------------------------------------------------------------------

type City = { label: string; score: number };

function cityMatcher(state: string, towns: string[]) {
  const re = new RegExp(`^(${towns.join("|")}),\\s*${state}$`, "i");
  return (loc: string) => re.test(loc.trim());
}

const TWIN_CITIES = cityMatcher("MN", [
  "Minneapolis", "St\\.? Paul", "Saint Paul", "Plymouth", "Brooklyn Park", "Eden Prairie", "Bloomington", "Minnetonka", "Edina", "Maple Grove", "Arden Hills", "Roseville", "Eagan",
  "Golden Valley", "St\\.? Louis Park", "Richfield", "Shoreview", "Mendota Heights", "Fridley", "Maplewood", "Chanhassen", "Hopkins", "Wayzata", "Woodbury", "Shakopee",
  "Burnsville", "Coon Rapids", "Blaine", "Inver Grove Heights", "Oakdale", "Lakeville", "Brooklyn Center", "New Brighton", "Mounds View", "Chaska", "Little Canada",
]);
const PITTSBURGH = cityMatcher("PA", ["Pittsburgh", "Coraopolis", "Wilmerding", "Canonsburg", "Cranberry Township", "Cranberry", "Moon Township", "Monroeville", "Sewickley", "Bridgeville", "Wexford", "Warrendale"]);
const PHILADELPHIA = cityMatcher("PA", ["Philadelphia", "King of Prussia", "Conshohocken", "West Conshohocken", "Malvern", "Wayne", "Radnor", "Blue Bell", "Horsham", "Fort Washington", "Plymouth Meeting", "Newtown Square"]);
const BOSTON = cityMatcher("MA", [
  "Boston", "Cambridge", "Somerville", "Burlington", "Waltham", "Woburn", "Lexington", "Needham", "Quincy", "Bedford", "Marlborough", "Andover", "Newton", "Watertown", "Framingham",
  "Chelmsford", "Westborough", "Lowell", "Medford", "Wellesley", "Braintree", "Canton", "Natick", "Billerica", "Wilmington", "Maynard", "Boxborough", "North Reading",
]);
const CHICAGO = cityMatcher("IL", ["Chicago", "Evanston", "Oak Brook", "Schaumburg", "Naperville", "Deerfield", "Northbrook", "Rosemont", "Downers Grove", "Lisle", "Lake Forest", "Itasca", "Skokie", "Glenview", "Lincolnshire", "Itasca", "Des Plaines", "Hoffman Estates"]);
const BAY_AREA = cityMatcher("CA", [
  "San Francisco", "South San Francisco", "San Jose", "Mountain View", "Sunnyvale", "Palo Alto", "Menlo Park", "Santa Clara", "San Mateo", "Cupertino", "Foster City", "Redwood City",
  "Oakland", "Fremont", "Milpitas", "Burlingame", "San Bruno", "Emeryville", "Berkeley", "Los Gatos", "Pleasanton", "Brisbane", "Belmont", "San Carlos",
]);
const SEATTLE = cityMatcher("WA", ["Seattle", "Bellevue", "Redmond", "Kirkland", "Bothell", "Issaquah", "Renton", "Tukwila"]);
const NYC = cityMatcher("NY", ["New York", "New York City", "Brooklyn", "Manhattan", "Queens", "Long Island City"]);

/**
 * City tiers from tracker.md: Minneapolis, then Pittsburgh, then Philadelphia / Boston (and Chicago,
 * added to "good" after the Caterpillar conversation); SF, Seattle and NYC are long shots.
 */
export function cityOf(location: string): City {
  const l = location.trim();
  if (TWIN_CITIES(l)) return { label: "Twin Cities", score: 3 };
  if (/^minnesota$/i.test(l)) return { label: "Minnesota", score: 1 };
  if (PITTSBURGH(l)) return { label: "Pittsburgh", score: 2.5 };
  if (PHILADELPHIA(l)) return { label: "Philly", score: 1.5 };
  if (BOSTON(l)) return { label: "Boston", score: 1.5 };
  if (CHICAGO(l)) return { label: "Chicago", score: 1.5 };
  if (/^remote/i.test(l)) return { label: "remote", score: 0.5 };
  if (/^(sf|south sf)$/i.test(l) || BAY_AREA(l)) return { label: "Bay Area", score: -0.5 };
  if (SEATTLE(l)) return { label: "Seattle", score: -0.5 };
  if (/^nyc$/i.test(l) || NYC(l)) return { label: "NYC", score: -0.5 };
  return { label: "", score: 0 };
}

// --- What the role is ------------------------------------------------------------------------

type Signal = { label: string; score: number; title?: RegExp; company?: RegExp };

const SWE = /software|developer|\bswe\b|\bsde\b|programmer|full[- ]?stack|back[- ]?end|platform engineer|infrastructure engineer|systems engineer|site reliability|\bsre\b|devops/i;
/** Not engineering jobs, whatever else the title says. */
const NOT_ENGINEERING = /\banalyst\b|business intelligence|actuar|consult|product manag|program manag|project manag|human resources|\brecruit|\bbuyer\b|merchandis|\bsales\b|accounting/i;
/** Not engineering unless the title also says engineer ("Marketing Analytics" vs "Finance Systems Engineer"). */
const SOFT_NOT_ENGINEERING = /insights?\b|\bgis\b|governance|marketing|finance|renewable|supply planning|\bbi\b|analytics|\bstrategy\b|operations intern/i;
const OFF_PROFILE = /research scientist|\bphd\b|research intern|\bqa\b|quality assurance|test engineer|support engineer|help ?desk|\bit\b (intern|support)|technician|mechanical|electrical engineer|civil|chemical|manufacturing engineer|hardware|front[- ]?end|\bios\b|android|\bux\b/i;

/** The kind of job, from its title: a SWE role first, then other engineering, then the rest. */
export function kindScore(title: string): number {
  if (NOT_ENGINEERING.test(title)) return -3;
  if (SWE.test(title)) return OFF_PROFILE.test(title) ? 1 : 2;
  if (SOFT_NOT_ENGINEERING.test(title) && !/engineer/i.test(title)) return -3;
  if (OFF_PROFILE.test(title)) return -2;
  if (/engineer/i.test(title)) return 1;
  if (/data scien|machine learning|\bml\b|\bai\b/i.test(title)) return 0.5;
  return 0;
}

const DOMAINS: Signal[] = [
  {
    label: "logistics",
    score: 2.5,
    title: /logistic|supply[- ]?chain|freight|shipping|fulfil+ment|transportation|warehouse|routing|fleet|inventory|distribution|last[- ]mile|\brail\b/i,
    company: /^(c\.?\s?h\.? robinson|fedex|ups|united parcel|flexport|project44|wabtec|xpo|j\.?\s?b\.? hunt|ryder|uber freight|maersk|dhl|penske|werner|knight[- ]swift|landstar|echo global|coyote|transfix|loadsmart|samsara|motive|shipbob|shippo|shipstation|descartes|manhattan associates|blue yonder|kinaxis|o9 solutions|arrive logistics|gxo|schneider|old dominion|union pacific|bnsf|norfolk southern|csx)\b/i,
  },
  { label: "retail supply chain", score: 1, company: /^(target|best buy|wayfair|walmart|the home depot|home depot|kroger|costco|chewy|instacart|general mills|land o'lakes)\b/i },
  { label: "recsys", score: 2.5, title: /recommend|ranking|personali[sz]|\bsearch\b|relevance|\bfeeds?\b|retrieval|discovery|ads? (quality|ranking)/i },
  {
    label: "systems",
    score: 1.5,
    title: /\b(systems?|infrastructure|infra|platform|backend|back[- ]end|distributed|kernel|storage|database|compilers?|performance|reliability|sre|devops|cloud|networking|low[- ]latency|c\+\+|operating systems?|runtime|hpc|gpu)\b/i,
  },
  { label: "embedded", score: 0.5, title: /\b(embedded|firmware)\b/i },
];

export type Fit = Posting & {
  score: number;
  /** Why it fits, short, for the message. */
  why: string[];
  /** Things Ryan should know before clicking. */
  flags: string[];
};

export type Prefs = {
  /** Unix seconds. */
  now: number;
  /** Target-list companies he hasn't applied to yet. */
  targets: string[];
};

export function fit(p: Posting, prefs: Prefs): Fit {
  const locations = [...p.locations].sort((a, b) => cityOf(b).score - cityOf(a).score);
  const best = cityOf(locations[0] ?? "");
  let score = best.score;
  const why: string[] = [];
  if (best.score > 0) why.push(best.label);

  const kind = kindScore(p.title);
  score += kind;
  for (const s of DOMAINS) {
    const hit = (s.title && s.title.test(p.title)) || (s.company && s.company.test(p.company.trim()));
    if (!hit || kind < 0) continue;
    score += s.score;
    if (!why.includes(s.label)) why.push(s.label);
  }
  if (kind >= 0 && prefs.targets.some((t) => isCompany(p.company, t))) {
    score += 2.5;
    why.unshift("on your target list");
  }
  if (p.section === "data") score -= 0.5;
  const ageDays = (prefs.now - p.posted) / 86_400;
  if (p.posted > 0 && ageDays <= 3) score += 0.5;
  else if (p.posted > 0 && ageDays > 120) score -= 1;

  const flags: string[] = [];
  if (p.citizenship) flags.push("US citizens only");
  if (ambiguous(p.company)) flags.push("check it against your no-defense rule");

  return { ...p, locations, score: Math.round(score * 10) / 10, why, flags };
}

/** Best first; ties go to the newer posting. */
export function byFit(a: Fit, b: Fit): number {
  return b.score - a.score || b.posted - a.posted || a.company.localeCompare(b.company);
}

/**
 * Good enough to push: an engineering role plus at least one of a preferred city, a preferred
 * domain or a target company. A plain SWE role in an unlisted city scores 2 and is not pushed.
 */
export const GOOD = 3.5;

/** Citizenship-only postings are skipped unless they're clearly strong for him. */
export const CITIZENSHIP_BAR = 5;

/** At most `per` postings from any one company, keeping the order: a top list shouldn't be eight TikTok teams. */
export function spread<T extends Pick<Posting, "company">>(fits: T[], per: number): T[] {
  const count = new Map<string, number>();
  return fits.filter((f) => {
    const k = normalizeCompany(f.company);
    const n = (count.get(k) ?? 0) + 1;
    count.set(k, n);
    return n <= per;
  });
}

/** The postings worth showing at all, best first. */
export function shortlist(postings: Posting[], prefs: Prefs): Fit[] {
  return postings
    .filter((p) => !excluded(p))
    .map((p) => fit(p, prefs))
    .filter((f) => !f.citizenship || f.score >= CITIZENSHIP_BAR)
    .sort(byFit);
}

export { normalizeCompany };

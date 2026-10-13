import assert from "node:assert/strict";
import { test } from "node:test";
import { cityOf, excluded, fit, GOOD, shortlist, spread } from "./fit.ts";
import { FormatError, isUS, merge, normalizeCompany, normalizeUrl, parseSimplify, parseSpeedyApply, sameCompany, type Posting } from "./listings.ts";
import { chunks, firstRun, LIMIT, nag, newPostings, noDash, type Labeled } from "./messages.ts";
import { closesOn, known, openLoops, parseTracker, recentApplications } from "./tracker.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z") / 1000;

// --- Fixtures -------------------------------------------------------------------------------

function listing(over: Record<string, unknown> = {}) {
  return {
    id: String(Math.random()),
    company_name: "Acme",
    title: "Software Engineer Intern",
    category: "Software",
    active: true,
    is_visible: true,
    terms: ["Summer 2027"],
    locations: ["Chicago, IL"],
    url: "https://example.com/jobs/123456",
    date_posted: NOW - 86_400,
    sponsorship: "Offers Sponsorship",
    degrees: ["Bachelor's"],
    ...over,
  };
}

function simplifyFile(special: Record<string, unknown>[]): string {
  const filler = Array.from({ length: 1100 }, (_, i) => listing({ id: `f${i}`, company_name: `Filler ${i}`, url: `https://example.com/jobs/${100000 + i}` }));
  return JSON.stringify([...special, ...filler]);
}

const TRACKER = `# Application Tracker

## Submitted

| # | Company | Role | Applied | Resume | Referral? | Status | Notes |
|---|---|---|---|---|---|---|---|
| 3 | Shopify | SWE Intern | 2026-08-05 | v1.0 | No | **rejected** | Reach. |
| 20 | **Kensho** (S&P Global) | Software Engineer | **2026-09-10** | v1.1 | No | **rejected** | Reach. |

| 24 | **URBN** | Software Engineering Intern | **2026-09-15** | v1.1-urbn | No | **video interview done** | No follow-up. |
| 25 | **Wells Fargo** | SWE Intern | **2026-09-15** | v1.1-wf | No | **OA failed - likely rejected** | DP problem. |
| 27 | **Caterpillar** | SWE Intern | **2026-09-15** | v1.1 | ⚠️ **promised, not delivered** | applied | Follow-up email unsent. |
| 30 | **Philips** ⭐ | IVUS | **2026-09-22** | v1.1 | No | applied | Twin Cities. |

### Not yet submitted

| Company | Role | State | Action |
|---|---|---|---|
| Grant Thornton | AI Intern | **draft only - never submitted** | Finish or kill it. |

## Targets

| Company | City | Why it fits | Applied? |
|---|---|---|---|
| C.H. Robinson | Minneapolis | Best single match | |
| UnitedHealth / Optum | Minneapolis | Healthtech | |
| Amazon (supply-chain orgs) | Seattle | | |
| Medtronic | Multi | Healthtech | ✅ 2026-08-02 |
`;

const URBN_NOTE = { file: "urbn.md", text: "# URBN - Software Engineering Intern\n\n4. Applications close 2026-10-30\n" };

function posting(over: Partial<Posting> = {}): Posting {
  return {
    key: `${normalizeCompany(over.company ?? "Acme")}|${(over.title ?? "software engineer intern").toLowerCase()}`,
    source: "simplify",
    company: "Acme",
    title: "Software Engineer Intern",
    section: "swe",
    url: "https://example.com/jobs/1",
    locations: ["Minneapolis, MN"],
    moreLocations: 0,
    posted: NOW - 86_400,
    citizenship: false,
    ...over,
  };
}

const labeled = (p: Posting): Labeled => ({ ...fit(p, { now: NOW, targets: [] }), known: null });

// --- Listings -------------------------------------------------------------------------------

test("company names compare through legal suffixes but not through unrelated prefixes", () => {
  assert.equal(normalizeCompany("The Toro Company"), "toro");
  assert.ok(sameCompany("C.H. Robinson", "CH Robinson Worldwide Inc."));
  assert.ok(sameCompany("Philips", "Philips North America"));
  assert.ok(!sameCompany("Target", "Targeted Labs Inc"));
  assert.ok(!sameCompany("UPS", "UPStart"));
});

test("only US locations count", () => {
  for (const l of ["Minneapolis, MN", "Remote in USA", "NYC", "Austin, Texas, USA", "Minnesota"]) assert.ok(isUS(l), l);
  for (const l of ["Toronto, ON", "London, UK", "Bangalore, India"]) assert.ok(!isUS(l), l);
});

test("Simplify: keeps open Summer 2027 US SWE/data roles for undergrads and skips the rest", () => {
  const out = parseSimplify(
    simplifyFile([
      listing({ id: "keep", company_name: "Keep Co", url: "https://example.com/jobs/900001" }),
      listing({ id: "closed", company_name: "Closed Co", active: false }),
      listing({ id: "hidden", company_name: "Hidden Co", is_visible: false }),
      listing({ id: "fall", company_name: "Fall Co", terms: ["Fall 2026"] }),
      listing({ id: "canada", company_name: "Canada Co", locations: ["Toronto, ON"] }),
      listing({ id: "hw", company_name: "Hardware Co", category: "Hardware Engineering" }),
      listing({ id: "phd", company_name: "PhD Co", degrees: ["PhD"] }),
      listing({ id: "data", company_name: "Data Co", category: "Data Science, AI & Machine Learning", sponsorship: "U.S. Citizenship is Required" }),
    ]),
  );
  const names = new Set(out.map((p) => p.company));
  assert.ok(names.has("Keep Co"));
  for (const gone of ["Closed Co", "Hidden Co", "Fall Co", "Canada Co", "Hardware Co", "PhD Co"]) assert.ok(!names.has(gone), gone);
  const data = out.find((p) => p.company === "Data Co")!;
  assert.equal(data.section, "data");
  assert.equal(data.citizenship, true);
});

test("Simplify: a changed file format fails loudly instead of going quiet", () => {
  assert.throws(() => parseSimplify("<html>"), FormatError);
  assert.throws(() => parseSimplify(JSON.stringify([listing()])), FormatError);
  const renamed = JSON.stringify(Array.from({ length: 1100 }, (_, i) => listing({ id: `x${i}`, category: "Engineering" })));
  assert.throws(() => parseSimplify(renamed), /categories or terms may have been renamed/);
});

test("speedyapply: reads the README tables, drops other terms and non-US rows", () => {
  const row = (company: string, title: string, where: string, age = "3d") =>
    `| <a href="https://x.com"><strong>${company}</strong></a> | ${title} | ${where} | $40/hr | <a href="https://jobs.example.com/${company.replace(/\W/g, "")}/12345"><img></a> | ${age} |`;
  const rows = Array.from({ length: 120 }, (_, i) => row(`Filler ${i}`, "Software Engineer Intern", "Pittsburgh, PA"));
  const text = [
    "<!-- TABLE_START -->",
    "| Company | Position | Location | Salary | Posting | Age |",
    "|---|---|---|---|---|---|",
    row("Spring Co", "Software Engineer Intern, Spring 2027", "Boston, MA"),
    row("Abroad Co", "Software Engineer Intern", "London, UK"),
    row("Multi Co", "Backend Intern", "Seattle, WA +3", "2w"),
    ...rows,
  ].join("\n");
  const out = parseSpeedyApply(text, NOW);
  const multi = out.find((p) => p.company === "Multi Co")!;
  assert.equal(multi.moreLocations, 3);
  assert.equal(multi.posted, NOW - 2 * 604_800);
  assert.ok(!out.some((p) => p.company === "Spring Co" || p.company === "Abroad Co"));
  assert.throws(() => parseSpeedyApply("| Company |\n", NOW), FormatError);
});

test("merge keeps one posting per role and folds same-board reposts into one with every city", () => {
  const a = posting({ locations: ["Minneapolis, MN"], url: "https://acme.wd5.myworkdayjobs.com/x/job/Minneapolis/SWE_R12345" });
  const b = posting({ locations: ["Pittsburgh, PA"], url: "https://acme.wd5.myworkdayjobs.com/x/job/Pittsburgh/SWE_R12346" });
  const sameReqOtherBoard = posting({ source: "speedyapply", key: "acme|swe intern", title: "SWE Intern", url: "https://www.acme.wd5.myworkdayjobs.com/y/job/SWE_R12345" });
  const out = merge([a, b], [sameReqOtherBoard]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.locations, ["Minneapolis, MN", "Pittsburgh, PA"]);
  assert.equal(normalizeUrl("https://www.example.com/jobs/123456?src=x"), "example.com/123456");
});

// --- Tracker --------------------------------------------------------------------------------

test("tracker: reads applications, drafts and untouched targets in the file's own format", () => {
  const t = parseTracker(TRACKER);
  assert.deepEqual(
    t.applications.map((a) => [a.company, a.stage]),
    [["Shopify", "rejected"], ["Kensho", "rejected"], ["URBN", "pending"], ["Wells Fargo", "rejected"], ["Caterpillar", "applied"], ["Philips", "applied"]],
  );
  assert.deepEqual(t.applications.find((a) => a.company === "Kensho")!.aliases, ["S&P Global"]);
  assert.deepEqual(t.drafts.map((d) => d.company), ["Grant Thornton"]);
  assert.deepEqual(t.targets, ["C.H. Robinson", "UnitedHealth", "Optum"]);
});

test("tracker: companies already applied to are labelled, rejections are marked but shown", () => {
  const t = parseTracker(TRACKER);
  const philips = known("Philips North America", t);
  assert.ok(philips && philips !== "draft" && philips.kind === "tracked");
  const wf = known("Wells Fargo", t);
  assert.ok(wf && wf !== "draft" && wf.kind === "rejected");
  const spgi = known("S&P Global", t);
  assert.ok(spgi && spgi !== "draft" && spgi.kind === "rejected");
  assert.equal(known("Grant Thornton", t), "draft");
  assert.equal(known("C.H. Robinson", t), null);
});

test("tracker: the time-sensitive list leads with the unsent Caterpillar email and carries URBN's close date", () => {
  const loops = openLoops(parseTracker(TRACKER), [URBN_NOTE], "2026-10-13");
  assert.match(loops[0]!.text, /Caterpillar.*follow-up email still isn't sent \(28 days since you applied\)/);
  const urbn = loops.find((l) => l.text.includes("URBN"))!;
  assert.match(urbn.text, /close \*\*Oct 30\*\* \(17d\)/);
  assert.ok(!loops.some((l) => l.text.includes("Wells Fargo")), "a failed OA is not an open loop");
  assert.equal(closesOn(URBN_NOTE.text, "2026-10-31"), undefined);
});

test("tracker: counts applications in the last week", () => {
  const r = recentApplications(parseTracker(TRACKER), "2026-10-13");
  assert.equal(r.lastWeek, 0);
  assert.equal(r.last?.company, "Philips");
});

// --- Fit ------------------------------------------------------------------------------------

test("fit: defense is never shown, ambiguous companies are flagged", () => {
  assert.ok(excluded({ company: "Lockheed Martin Corporation", title: "Software Intern", url: "" }));
  assert.ok(excluded({ company: "Acme", title: "Missile Software Intern", url: "" }));
  assert.ok(!excluded({ company: "Target", title: "Software Engineer Intern", url: "" }));
  assert.deepEqual(fit(posting({ company: "Honeywell" }), { now: NOW, targets: [] }).flags, ["check it against your no-defense rule"]);
});

test("fit: Twin Cities beats Pittsburgh beats Boston beats the coasts, and targets jump the line", () => {
  assert.ok(cityOf("Eden Prairie, MN").score > cityOf("Pittsburgh, PA").score);
  assert.ok(cityOf("Pittsburgh, PA").score > cityOf("Boston, MA").score);
  assert.ok(cityOf("Boston, MA").score > cityOf("San Francisco, CA").score);
  const prefs = { now: NOW, targets: ["C.H. Robinson"] };
  const chr = fit(posting({ company: "C.H. Robinson", locations: ["Eden Prairie, MN"] }), prefs);
  const plain = fit(posting({ company: "Acme", locations: ["Austin, TX"] }), prefs);
  assert.ok(chr.score >= GOOD && chr.why[0] === "on your target list");
  assert.ok(plain.score < GOOD, "a plain SWE role in an unlisted city isn't pushed");
  const analyst = fit(posting({ title: "Supply Chain Analyst Intern" }), prefs);
  assert.ok(analyst.score < GOOD, "non-engineering roles stay out even in a top city");
});

test("fit: citizenship-only postings need to be strong to show at all; spread caps one company", () => {
  const list = shortlist([posting({ citizenship: true, locations: ["Austin, TX"] }), posting({ company: "Other", citizenship: true, title: "Logistics Platform Software Engineer Intern" })], { now: NOW, targets: [] });
  assert.deepEqual(list.map((f) => f.company), ["Other"]);
  const many = [posting({ title: "A" }), posting({ title: "B" }), posting({ company: "Two", title: "C" })];
  assert.deepEqual(spread(many, 1).map((p) => p.title), ["A", "C"]);
});

// --- Messages -------------------------------------------------------------------------------

test("messages never contain an em dash, even when a board title does", () => {
  assert.equal(noDash("SWE Intern \u2014 Search"), "SWE Intern - Search");
  assert.equal(noDash("2026\u20132027"), "2026\u20132027");
  const fits = [labeled(posting({ title: "Software Engineer Intern \u2014 Routing", company: "Wabtec" }))];
  const all = [
    ...firstRun({ top: fits, good: 1, total: 1400, sources: ["simplify"], cadence: "every 4 hours" }),
    ...newPostings({ fits, more: 0, already: [], newCount: 3, sources: ["simplify", "speedyapply"] }),
  ].join("\n");
  assert.ok(!all.includes("\u2014"));
  assert.ok(all.includes("Software Engineer Intern - Routing"));
  assert.ok(!/^#{1,3} /m.test(all), "no markdown headers");
});

test("long lists split into Discord-sized messages without splitting a line", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `${i}. ${"x".repeat(90)}`);
  const parts = chunks(lines);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= LIMIT);
  assert.equal(parts.join("\n").split("\n").length, 60);
});

test("the morning nag pushes a number, lists the time-sensitive items and never an em dash", () => {
  const tracker = parseTracker(TRACKER);
  const loops = openLoops(tracker, [URBN_NOTE], "2026-10-13");
  const text = nag({
    today: "2026-10-13",
    todayLabel: "Tuesday, Oct 13",
    weekend: false,
    open: { good: 12, topCities: 4, picks: [labeled(posting())] },
    loops,
    recent: recentApplications(tracker, "2026-10-13"),
  }).join("\n");
  assert.match(text, /\*\*12\*\* good fits/);
  assert.match(text, /apply to at least \*\*2\*\*/);
  assert.match(text, /Caterpillar/);
  assert.match(text, /URBN/);
  assert.ok(!text.includes("\u2014"));
  const offline = nag({ today: "2026-10-17", todayLabel: "Saturday, Oct 17", weekend: true, loops: [], recent: { lastWeek: 1 } }).join("\n");
  assert.match(offline, /couldn't read the job boards/);
  assert.match(offline, /\*\*1\*\*/);
});

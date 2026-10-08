// Topics a look or a conversation reported, mapped onto the existing skill catalog
// (docs/circle-design.md §4). Reads the curated tracks, prereqs.json and a tree the caller passes;
// writes nothing and grants nothing. A topic without a confident catalog match stays an unmapped gap.

import * as curriculum from "./curriculum.ts";
import * as skills from "./skills.ts";
import { DELEGATION_LIMITS } from "./delegation-types.ts";
import { TRAIL_LIMITS, type TopicHint } from "./trail-types.ts";
import type { SkillRef, ZoneContext } from "./zone-types.ts";

const T = TRAIL_LIMITS;

/** A name asked about from a language, where the catalog keeps it: "git" from c++ is language-free. */
function located(name: string, lang: string): SkillRef {
  const at = curriculum.locate(name, lang).lang;
  return { name: curriculum.canonical(name, at), lang: at };
}

/** The track's spelling of a ref, in the language it names. */
function spelled(name: string, lang: string): SkillRef {
  const l = skills.langName(lang);
  return { name: curriculum.canonical(name, l), lang: l };
}

const refId = (r: SkillRef) => skills.id(r.name, r.lang);

/**
 * Every catalog skill named in `text`, in order of first mention. The longest name wins overlapping
 * words ("list comprehensions" is not also "lists"); the zone's language and language-free skills
 * win a shared name.
 */
function mentions(text: string, lang: string, tree: skills.Tree): SkillRef[] {
  const said = ` ${skills.key(text)} `;
  if (!said.trim()) return [];
  const byKey = new Map<string, SkillRef[]>();
  const known = [
    ...curriculum.tracks().flatMap((t) => t.skills.map((n) => ({ name: n.name, lang: t.lang }))),
    ...tree.skills.map((s) => spelled(s.name, s.lang)),
  ];
  for (const r of known) {
    const k = skills.key(r.name);
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const claimed: [number, number][] = [];
  const found: { at: number; refs: SkillRef[] }[] = [];
  for (const k of [...byKey.keys()].sort((a, b) => b.length - a.length)) {
    for (let at = said.indexOf(` ${k} `); at >= 0; at = said.indexOf(` ${k} `, at + 1)) {
      const end = at + k.length + 1;
      if (claimed.some(([s, e]) => at < e && s < end)) continue;
      claimed.push([at, end]);
      const refs = byKey.get(k)!;
      const here = refs.filter((r) => r.lang === lang || r.lang === "");
      found.push({ at, refs: here.length ? here : refs });
      break;
    }
  }
  return found.sort((a, b) => a.at - b.at).flatMap((f) => f.refs);
}

/**
 * At most DELEGATION_LIMITS.candidates canonical refs for one zone, deduplicated by skills.id:
 * focus skills and literal mentions in `text` with their prerequisites first, then the zone
 * language's curated skills, language-free curated skills, tree skills in that language or
 * language-free, and their prerequisites. Relevance only, never permission.
 */
export function candidates(zone: ZoneContext, tree: skills.Tree, text: string): SkillRef[] {
  const lang = skills.langName(zone.language);
  const prereqsOf = (refs: SkillRef[]) =>
    refs.flatMap((r) => curriculum.prereqs(r.name, r.lang).map((p) => located(p, r.lang || lang)));
  const first = [...zone.focusSkills.map((r) => located(r.name, r.lang)), ...mentions(text, lang, tree)];
  const rest = [
    ...(lang ? curriculum.names(lang).map((name) => ({ name, lang })) : []),
    ...curriculum.names("").map((name) => ({ name, lang: "" })),
    ...tree.skills.filter((s) => [lang, ""].includes(skills.langName(s.lang))).map((s) => spelled(s.name, s.lang)),
  ];
  const out = new Map<string, SkillRef>();
  for (const r of [...first, ...prereqsOf(first), ...rest, ...prereqsOf(rest)]) {
    if (out.size >= DELEGATION_LIMITS.candidates) break;
    const k = refId(r);
    if (skills.key(r.name) && !out.has(k)) out.set(k, r);
  }
  return [...out.values()];
}

/** Trimmed, control characters replaced by spaces, clipped to `max` UTF-16 units without splitting a pair. */
function clean(s: string, max: number): string {
  const out = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return out.length <= max ? out : out.slice(0, max).replace(/[\ud800-\udbff]$/, "").trimEnd();
}

/** The offered ref a model-reported skill names, located the way the gate would; null when it isn't offered. */
function offeredRef(raw: unknown, offered: Map<string, SkillRef>): SkillRef | null {
  if (!raw || typeof raw !== "object") return null;
  const { name, lang = "" } = raw as Record<string, unknown>;
  if (typeof name !== "string" || typeof lang !== "string") return null;
  return offered.get(refId(located(name, lang))) ?? null;
}

/**
 * A model reply's `topics` value → hints safe for Trails.observe: the first TRAIL_LIMITS.hints
 * valid entries in reported order (garbage or a non-array gives []). A skill that doesn't locate to
 * one of `offered`, including the right name in the wrong language, becomes skill:null (an unmapped
 * gap), never a new skill; so does any skill below TRAIL_LIMITS.inferredConfidence. Topic and reason
 * are cleaned and clipped; an empty topic or a confidence outside a finite [0,1] drops the entry.
 */
export function mapHints(raw: unknown, offered: readonly SkillRef[]): TopicHint[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, SkillRef>();
  for (const r of offered) if (!byId.has(refId(r))) byId.set(refId(r), r);
  const out: TopicHint[] = [];
  for (const item of raw) {
    if (out.length >= T.hints) break;
    if (!item || typeof item !== "object") continue;
    const h = item as Record<string, unknown>;
    const topic = typeof h.topic === "string" ? clean(h.topic, T.topicChars) : "";
    const confidence = h.confidence;
    if (!topic || typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    out.push({
      topic,
      skill: confidence >= T.inferredConfidence ? offeredRef(h.skill, byId) : null,
      confidence,
      reason: typeof h.reason === "string" ? clean(h.reason, T.reasonChars) : "",
    });
  }
  return out;
}

/**
 * Exact refs an artifact named (change manifest skills, accepted evidence) as confidence-1 hints in
 * the track's spelling. Refs off the catalog and tree stay as named: their owner validated them.
 * Consecutive identical refs coalesce; every ref is returned, so the caller chunks by
 * TRAIL_LIMITS.hints. An empty topic falls back to the skill's label.
 */
export function exactHints(refs: readonly SkillRef[], topic: string, reason: string): TopicHint[] {
  const about = clean(topic, T.topicChars);
  const why = clean(reason, T.reasonChars);
  const out: TopicHint[] = [];
  let last: string | null = null;
  for (const r of refs) {
    const skill = spelled(r.name, r.lang);
    const k = refId(skill);
    if (k === last) continue;
    last = k;
    out.push({ topic: about || clean(skills.label(skill), T.topicChars), skill, confidence: 1, reason: why });
  }
  return out;
}

/** Candidates for a look or conversation prompt, one `name (lang)` per line, "any language" for language-free refs. */
export function candidateLines(refs: readonly SkillRef[]): string {
  return refs.map((r) => `${r.name} (${r.lang || "any language"})`).join("\n");
}

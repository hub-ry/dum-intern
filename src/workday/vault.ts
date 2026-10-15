// Values the agent must never see: SSN, date of birth and the like. The agent writes {{SSN}} as a
// field's whole value; the worker swaps in the real value only as it types into the field, and
// only into a field whose label matches the entry's `fields` pattern. Everything the worker
// returns passes through redact(), which turns any vault value (in any common spelling) back
// into its placeholder, so a page that echoes the value can't carry it to the agent either.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { profileEntries, type Profile } from "./profile.ts";

export const VAULT_KEY = /^[A-Z][A-Z0-9_]{1,40}$/;

export const Vault = z.record(
  z.string().regex(VAULT_KEY),
  z.object({
    value: z.string().min(1).max(500),
    /** Case-insensitive regex source a field's label, name or automation id must match. */
    fields: z.string().min(1).max(300),
  }),
);
export type Vault = z.infer<typeof Vault>;

export function loadVault(path: string): Vault {
  try {
    return Vault.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Never echo the file: a parse error message can quote a value.
    throw new Error(`The vault at ${path} isn't valid (expected {"KEY": {"value": "...", "fields": "regex"}}).`);
  }
}

export class FillError extends Error {}

/** A field as the worker knows it: what its label, name and automation id say. */
export type FieldIdentity = { label: string; name: string; automationId: string };

export type Resolved = { value: string; secret: string | null };

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}/g;

/**
 * The value to type into `field` for the agent's `text`. Profile placeholders may sit anywhere in
 * the text; a vault placeholder must be the whole value and the field must be one it's meant for.
 */
export function resolveFill(text: string, field: FieldIdentity, profile: Profile, vault: Vault): Resolved {
  const whole = /^\s*\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}\s*$/.exec(text);
  if (whole) {
    const key = whole[1]!;
    const entry = vault[key];
    if (!entry) throw new FillError(`No vault value named {{${key}}}. Ryan has to add it to the vault on the worker; leave this field for him.`);
    const pattern = new RegExp(entry.fields, "i");
    if (![field.label, field.name, field.automationId].some((s) => s && pattern.test(s))) {
      throw new FillError(`{{${key}}} can't go in the field "${field.label || field.name}"; it only fills fields matching /${entry.fields}/i.`);
    }
    return { value: entry.value, secret: key };
  }
  const profileValues = profileEntries(profile);
  const value = text.replace(PLACEHOLDER, (_, name: string) => {
    if (VAULT_KEY.test(name)) throw new FillError(`{{${name}}} must be a field's whole value, not part of a longer text.`);
    const v = profileValues.get(name);
    if (v === undefined) throw new FillError(`No profile value {{${name}}}. Use one of the profile.* names listed by open_application.`);
    return v;
  });
  return { value, secret: null };
}

/** Anything a page might put between the digits of a value: spaces, dashes, dots, slashes, zero-width characters, %-escapes. */
const SEP = "(?:[\\s./_\\-\\u2010-\\u2015\\u200B-\\u200D\\u2060\\uFEFF]|%2[0dDfF])*";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** One digit, ASCII or full-width. */
function digit(d: string): string {
  return `[${d}${String.fromCharCode(0xff10 + Number(d))}]`;
}

function digitRun(digits: string): string {
  return digits.split("").map(digit).join(SEP);
}

/**
 * Every spelling of every vault value, as regexes, longest first:
 * - the value itself, any case;
 * - its digits with any separators between them (123-45-6789, 123 45 6789, 123456789, full-width);
 * - for values with 7+ digits, the last four on their own ("SSN ending 6789");
 * - for YYYY-MM-DD dates, US orders and month names (05/17/2004, 5-17-2004, May 17, 2004, 17 May 2004).
 * Redaction and screenshot masks share these, so what the agent can't read is also covered in pictures.
 */
export function secretPatterns(vault: Vault): { key: string; re: RegExp }[] {
  const out: { key: string; re: RegExp }[] = [];
  for (const [key, { value }] of Object.entries(vault)) {
    const v = value.trim();
    if (!v) continue;
    out.push({ key, re: new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") });
    const digits = v.replace(/\D/g, "");
    if (digits.length >= 4) out.push({ key, re: new RegExp(digitRun(digits), "g") });
    if (digits.length >= 7) out.push({ key, re: new RegExp(`(?<![0-9\\uFF10-\\uFF19])${digitRun(digits.slice(-4))}(?![0-9\\uFF10-\\uFF19])`, "g") });
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (date) {
      const [y, m, d] = [date[1]!, date[2]!, date[3]!];
      // A leading zero may be dropped: 05 → 5.
      const loose = (n: string) => (n.startsWith("0") ? `${digit("0")}?${digit(n[1]!)}` : digitRun(n));
      out.push({ key, re: new RegExp(`${loose(m)}${SEP}${loose(d)}${SEP}${digitRun(y)}`, "g") });
      const month = MONTHS[Number(m) - 1];
      if (month) {
        const name = `(?:${month}|${month.slice(0, 3)})\\.?`;
        out.push({ key, re: new RegExp(`${name}\\s*${loose(d)}(?:st|nd|rd|th)?,?\\s*${digitRun(y)}`, "gi") });
        out.push({ key, re: new RegExp(`${loose(d)}(?:st|nd|rd|th)?\\s*${name},?\\s*${digitRun(y)}`, "gi") });
      }
    }
  }
  return out.sort((a, b) => b.re.source.length - a.re.source.length);
}

/** A function that replaces every vault value in a text with its placeholder. */
export function redactor(vault: Vault): (text: string) => string {
  const rules = secretPatterns(vault);
  return (text) => rules.reduce((t, r) => t.replace(r.re, `{{${r.key}}}`), text);
}

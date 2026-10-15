// What the Workday agent may see about Ryan: things he'd paste into a chat anyway. The agent fills
// forms from it with {{profile.<path>}} placeholders or by copying values. Anything he wouldn't
// paste (SSN, date of birth, passwords) is not here; it lives in the vault (vault.ts).

import { readFileSync } from "node:fs";
import { z } from "zod";

const text = z.string().max(300);

export const Profile = z.object({
  name: z.object({ first: text, last: text, preferred: text.optional() }),
  email: text,
  phone: text,
  address: z.object({ line1: text.optional(), city: text, state: text, postalCode: text, country: text }),
  school: z.object({ name: text, degree: text, major: text, gradDate: text.describe("YYYY-MM"), gpa: text.optional() }),
  links: z.object({ github: text.optional(), linkedin: text.optional(), website: text.optional() }),
  /** File names under the worker's resume/ folder; "default" is used unless the agent picks another. */
  resumes: z.record(z.string().regex(/^[a-z0-9_-]{1,40}$/), z.string().regex(/^[A-Za-z0-9 ._-]{1,120}$/)).refine((r) => "default" in r, "resumes needs a default"),
  /** Standard answers, keyed by a short id: work authorization, sponsorship, how he heard, ... */
  answers: z.record(z.string().regex(/^[a-z0-9_]{1,60}$/), z.string().max(2000)),
});
export type Profile = z.infer<typeof Profile>;

export function loadProfile(path: string): Profile {
  return Profile.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Every leaf as "profile.a.b" → value, for the agent to read and for placeholders. */
export function profileEntries(profile: Profile): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (prefix: string, value: unknown) => {
    if (typeof value === "string") out.set(prefix, value);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(`${prefix}.${k}`, v);
  };
  walk("profile", profile);
  return out;
}

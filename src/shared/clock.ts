// Ryan's wall clock. He lives in Indiana (Eastern), and hub's system clock is UTC, so after 8pm
// there it's already tomorrow by the server's date. Store instants as UTC ISO strings; whenever a
// date or time is shown to Ryan or an agent reasons about "today", it goes through here.
//
// Dum's services and every Claude turn they start also run with TZ=HOME_TZ (see deploy/ and
// chat.ts): Claude Code writes "Today's date is ..." into its own prompt from the process's local
// date, and nothing in this repo can reach that line.

export const HOME_TZ = "America/Indiana/Indianapolis";

/** Environment for anything Dum starts that reads the local clock (Claude Code, codex, scripts). */
export const HOME_TZ_ENV = { TZ: HOME_TZ } as const;

type When = Date | number;
const toDate = (t: When) => (typeof t === "number" ? new Date(t) : t);

function parts(t: When, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, ...opts }).formatToParts(toDate(t)).map((p) => [p.type, p.value]));
}

/** Ryan's calendar day at an instant: "2026-10-14". */
export function localDay(t: When = Date.now()): string {
  const p = parts(t, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

/** "8:13 PM EDT". */
export function localTime(t: When = Date.now()): string {
  const p = parts(t, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return `${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}

/** "2026-10-14 20:13 EDT", for dated entries in files. */
export function localStamp(t: When = Date.now()): string {
  const p = parts(t, { hourCycle: "h23", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  return `${localDay(t)} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** "Wednesday, October 14, 2026, 8:13 PM EDT". */
export function localNow(t: When = Date.now()): string {
  const p = parts(t, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return `${p.weekday}, ${p.month} ${p.day}, ${p.year}, ${localTime(t)}`;
}

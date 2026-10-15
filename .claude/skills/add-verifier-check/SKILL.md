---
name: add-verifier-check
description: Add a new hard check to the offline Docker/Playwright verifier that gates every workshop creation, either a new failure condition on the generated page or a new field in report.json. Use when a creation must be refused for a reason the verifier does not test today.
metadata:
  version: "1.0.0"
---

# Add a verifier check

## When to use

A generated demo passes today but should not (a page behaviour the model
can cheat with), or the host needs a new fact about the verified page.
A check has two halves: the container script finds it, the host refuses a
report that lacks it. Change the script alone and the host still accepts
old reports; change the schema alone and every build fails.

## Files to touch

1. `src/workshop/publisher-verifier.mjs` — the in-container script. Runs
   under `node` inside the image; the host never executes page JS.
   - Hard fail: call `fail('short reason')` (publisher-verifier.mjs:7).
     Pattern: `if (html.length > 200000) fail('source too large');` L24,
     `if (manifest.sourceHash !== sourceHash) fail('source hash mismatch');` L28.
   - Page-level signal (request, pageerror, console error, popup, dialog):
     push onto `problems` inside `freshPage` L34-50 (e.g. L43-46); `check()` L31
     throws the first five. `check()` runs at L77, L108, L116.
   - Element-level condition: add a branch to the `evaluate` callback in
     `observe` L52-73, returning a string reason (L59-67); L71 turns it into `fail`.
   - Per-panel / per-action condition: the loop L85-117. Action checks sit
     between L93-107 (`expectedBefore` L94, `afterHash === beforeHash` L104).
   - New report field: add it to the `actions.push({...})` L107, the
     `panels.push({...})` L116, or the top-level object written at L119
     (`{ ok, nonce, sourceHash, initialSha256, panels }`).
   The 80 s watchdog is L10; keep new waits inside `waitFor` (L12-20, 5 s max).
2. `src/workshop/publisher.ts` — host side.
   - New report field: add it to `ReportSchema` L75-102. Every object is
     `z.strictObject`, so an unknown key already fails; a missing key must too
     (no `.optional()`). Hashes use `HEX64` L13, test ids `TESTID_RE` L12.
   - Then assert its value in `verify()` L358-381, next to the existing
     per-panel checks (L368-380). Throw `new Error('Panel N ...')` like L370;
     a thrown error is the whole build failing.
   - Container exit ≠ 0 already fails at L356 with the script's stderr; a
     new `fail()` needs nothing here.
   - If the check needs data from the model, it travels in the manifest:
     `.verify.json` written at L416-422 from `model.panels`; shapes are
     `ActionSchema` L43 and `PanelSchema` L50. The script reads it at L25.
3. `src/workshop/publisher.Dockerfile` — unchanged unless a new dependency.
   It only copies the script (L4). Rebuild to ship the script change:
   `docker build -f src/workshop/publisher.Dockerfile -t dum-workshop-browser:1 .`
   `preflightImage` L156-170 resolves the tag to an image id and `verify()`
   runs that id (L347), so a running service picks up the new image on its
   next build; a running build keeps the old id.
4. Go live by restarting later, never directly (src/discord/agents.ts:99):
   `systemd-run --user --on-active=20 systemctl --user restart dum-workshop.service`.

## Test to add

No test covers `verify()`, `ReportSchema` or the verifier script today
(`src/workshop/*.test.ts` only mention the publisher for bind-mount paths,
runtime.test.ts:446). Add `src/workshop/publisher.test.ts`, `node:test` +
`node:assert/strict`, same style as artifacts.test.ts:1-31.

Host side, deterministic: extract L361-381 of `verify()` into an exported
`checkReport(json: unknown, nonce, sourceHash, panels)` that returns the
parsed report or throws, and call it from `verify()`. Build a minimal valid
report in the test (3 panels, one `click` action with differing
before/after and hashes, 64-hex nonce/sourceHash/initialSha256/sha256,
`image: 'panel-N.png'`), assert it passes, then assert that the same
report with the new field deleted, and with it violated, throws. The
assertion is on the thrown error / returned value, not on the schema
object, the source text, or the message wording beyond what the host
really branches on. CONTRIBUTING.md:34: behaviour, boundaries, errors —
not source strings or wiring.

Container side is proven by one real isolated build, not a unit test
(CONTRIBUTING.md:32). Throwaway run against a fixture, delete afterwards:
make a dir with `demo.html`, `.verify.json` (`{ nonce, sourceHash:
sha256(demo.html), panels: [{ observe, expected, actions }] }`, ≥3 panels,
panel 1 with no actions) and an empty `captures/`, then run the exact
command from `verify()` L340-348 by hand with `--network none` and the two
bind mounts; exit code and stderr are the result, `captures/report.json`
the report. Try one page that should pass and one that trips the new check.

## Checks

- `npm run typecheck`
- `npm test`
- One real isolated generation through the workshop after the image
  rebuild (CONTRIBUTING.md "Verification"), with the restart above.

## Don't

- Never run or parse generated HTML/JS on the host; the host reads only
  `report.json` and PNG bytes (`checkPng` L392, hash match L393).
- Never drop `--network none`, `--read-only`, `--cap-drop ALL` or
  `--pull=never` from the `docker run` args L341-348; verification is offline.
- Never make a report field `.optional()` or loosen `strictObject`; an
  old image must fail against a new schema, not slip through.
- Never add nondeterminism (timers, random, time) to the script; two fresh
  pages must hash identically (L79-80).
- Never write files other than `report.json` and `panel-N.png` to
  `/captures`; the host rejects any other entry (L383-385).
- Never restart `dum-workshop.service` directly; use the delayed
  `systemd-run` form.

---
name: dum-publish
description: Create real Dum workshop jobs and explicitly publish or revise short public note decks through the authenticated private workshop API. Use for Dum creations, notes publication, and notes hosting. Keep private context private and distinguish teaching from scaffolds.
---

# Dum creation and notes publication

Use the private workshop to teach Dum and request a creation. Use the notes CLI to publish only the text the owner selected for public reading. These are separate operations: a job does not automatically become a public note.

## Teaching Dum and requesting a creation

The private app defaults to port 8770. Read `GET /api/config` for its separate artifact origin. Authenticate with `Authorization: Bearer <workshop token>`, or log in through `POST /api/login` with `{ "password": "<workshop token>" }` and use the returned cookie. Never print or copy the token into a note, chat, or repository. Mutations with cookie auth require an Origin header matching the private app. Bearer requests without Origin are supported; a supplied Origin must still match.

Use the existing workshop UI, or these authenticated endpoints:

1. `POST /api/goals` with `{ "title": "...", "ambition": "..." }` creates a private goal. `GET /api/goals` lists goals.
2. `GET /api/material?goalId=<uuid>` returns the goal's study material and exercises. `GET /api/goals/:id` returns the goal.
3. `POST /api/goals/:id/attempt` with `{ "exerciseId": "...", "answer": "..." }` records a graded answer. `POST /api/goals/:id/report` with `{ "concept": "...", "text": "...", "helped": true }` records what the owner actually tried.
4. `POST /api/goals/:id/teach` with `{ "concept": "...", "text": "..." }` records the owner's teaching in their own words. Don't manufacture this teaching for them and call it evidence of learning.
5. `POST /api/goals/:id/jobs` with `{}` queues a creation. The response is 202 with `job`. Read `GET /api/jobs/:id` until its actual state is ready or failed. `GET /api/jobs?goalId=<uuid>` lists jobs without their full frozen snapshots.
6. A ready job has the actual result and artifact metadata. Use the private reader to view it. `POST /api/jobs/:id/correction` with `{ "correction": "..." }` queues a revised creation. Reader position is `GET`/`PUT /api/jobs/:id/position`, with `{ "panel": 0 }` for the zero-based first panel.

Dum's scaffold is a creation, not proof of learner mastery. A graded answer, self-report, or teaching record says only what it records. Never invent learner activity, skills, achievements, quotes, verification output, or numbers. Report a failed job as failed. Quote code and verification output exactly, or don't quote them.

## Choose what becomes public

Before publishing, identify the explicit source material and the owner-approved title, topic, and pages. This may be a factual design journal about actual work. A note about a creation may use the specific job the owner chose. Do not bulk-read private context to fill a public deck, or publish goals, teaching, attempts, job history, or the global context automatically.

The notes publisher accepts only its payload. It never reads workshop state, fetches source links, schedules exports, or seeds example notes. There is no public editor, login, dashboard, search, badges, streaks, or activity feed.

## Notes payload

```json
{
  "title": "Atomic revisions",
  "topic": "workshop design",
  "pages": [
    { "heading": "The write boundary", "text": "Owner-approved factual text.", "code": "optional code excerpt" }
  ],
  "links": [{ "label": "Source", "url": "https://example.com/source" }]
}
```

This illustrates the shape, not content to seed. Only `title`, `topic`, `pages`, and optional `links` are accepted. A page has only `heading`, `text`, and optional `code`. A link has only `label` and `url`.

- 1 to 12 pages. Title and heading: at most 160 characters. Topic: 80. Page text and code: 4000 each.
- Required strings must be nonblank. Text and code may contain tabs and newlines. Other fields are single-line. Malformed Unicode and control characters are rejected.
- Optional links: at most 8, labels at most 120 characters, URLs at most 500. URLs must be HTTPS without credentials or whitespace. No link is fetched.
- The serialized payload must fit 32 KiB. Every string, including code and link attributes, is escaped as HTML. No arbitrary HTML or JavaScript is rendered.

## Publish through the CLI

From the repository:

```sh
npm run note -- create --title "Approved title" --topic "Approved topic" --file pages.json
npm run note -- revise --id <uuid> --title "Approved title" --topic "Approved topic" --file pages.json
npm run note -- list
```

`pages.json` is either a JSON pages array or an object with `pages` and optional `links`. Title and topic come from flags. The CLI validates locally, calls the authenticated private API, and prints only resulting IDs and URLs. It never writes public files directly. Failure exits nonzero; don't describe it as publication success.

Configuration comes from the process environment, overriding `~/.config/dum-workshop/environment`. Use `--env-file <path>` for another file. The file is parsed as literal `KEY=value` lines, with quoted values and comments, without shell evaluation or expansion. Do not source it in a shell to run this command.

Keys used: `DUM_WORKSHOP_TOKEN` (required), optional `DUM_WORKSHOP_URL` (HTTP/HTTPS origin without credentials or path), otherwise `DUM_WORKSHOP_HOST` and `DUM_WORKSHOP_PORT` (defaults 127.0.0.1 and 8770). Wildcard bind addresses map to loopback. Redirects are refused so the bearer token is not forwarded to another origin.

## Private notes API

These routes run on the private app, after its auth and mutation Origin guards. They require a configured token even in the workshop's open loopback mode. Without authentication they return 401. With no `DUM_PUBLIC_NOTES_DIR`, they return 503.

| Route | Result |
| --- | --- |
| `GET /api/notes` | `{ notes: [{ id, revision, createdAt, updatedAt, title, topic, pageCount, url }] }`, oldest first. Read-only. |
| `POST /api/notes` | Complete payload above. 201 with `{ note }`. |
| `GET /api/notes/:uuid` | 200 with `{ note }`, the latest revision including pages and optional links. Read-only. |
| `PUT /api/notes/:uuid` | Complete replacement payload. 200 with `{ note }`, revision n+1. |

The stable public URL is `https://notes.ryhub.dev/notes/<uuid>/`. Invalid payloads return 400; oversized request bodies return 413. If a revision was saved privately but projection fails, the response is 500 and includes the saved note. Don't retry creation blindly and make a duplicate: inspect the saved ID. The next explicit create/revise or configured restart rebuilds the projection.

## Storage and hosting

Private source revisions live at `<workshop home>/public-notes/<uuid>/revision-<n>.json`. They are complete, synced files created exclusively: old revisions are never overwritten. Private directories stay 0700 and records 0600. The module reads only this source tree, never global context or teaching/job data.

`DUM_PUBLIC_NOTES_DIR` must be an existing canonical directory provisioned by the hosting owner, disjoint from the private workshop and artifact trees. Symlinked roots/components are refused, including after initialization. The private backend writes public directories 0755 and files 0644. Each file is atomically replaced. Only generated obsolete `page-N.html` files inside a note directory are removed; unrelated data is preserved.

On configured startup and explicit create/revise, the backend rebuilds the homepage, `/notes.css`, topic indexes, and latest note pages. With no notes, the homepage says `No public notes yet.` Page 1 is `/notes/<uuid>/`; later pages are `/notes/<uuid>/page-2.html`, etc. Each page has title, topic, heading, text, optional code, position, native Previous/Next/Home links, and optional HTTPS sources. It uses plain off-white HTML/CSS without JavaScript.

`deploy/dum-notes.service` runs the existing dependency-free `src/public/server.ts` from the root-owned `/opt/dum-public` install as user `skill-tree`, with `DUM_PUBLIC_ROOT=/var/lib/dum-notes`, loopback port 8071, and read-only filesystem hardening. It has no token or private API and cannot write the notes root. `deploy/deploy-notes.sh` installs this separate service; it must not duplicate the static server source or restart the private publisher mid-edit. The product site remains a separate instance on 8070. Cloudflare serves the notes origin; private API publication stays on the private workshop.

Before calling a publish command, check that the owner chose the source and approved the text, that claims trace to real work, and that no private context or invented learner evidence slipped in. After publication, open the returned URL and read the deck. Public reading never implies public editing.

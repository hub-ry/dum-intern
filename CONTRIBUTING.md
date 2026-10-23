# Contributing

This repo is the public skill-tree product at [dumintern.com](https://dumintern.com/). Start with [README.md](README.md) for setup, storage, and the source layout.

```sh
npm ci
npm run dev
npm run typecheck
npm test
```

- Keep the product self-contained. Discord, the private workshop, mail watchers, internship automation, and host desktop services don't belong here.
- Preserve account isolation and private workspace storage. Public assets must never expose account files, session keys, or credentials.
- Readings are written and compiled in the user's Cursor session. The server stores briefs and serves existing PDFs; it must not claim to have generated a paper.
- A block unlocks by reading its final page or recording a swear. Preserve that distinction. Neither record proves mastery.
- Builds contain unlocked blocks in the user's chosen order. Saving a stack does not generate a finished program.
- Update the README and site documentation when a user-facing contract changes. Keep template files and the paper skill consistent with workspace storage.
- Tests live beside the behavior they cover. Test state transitions, boundaries, errors, and observable output, not source strings or incidental copy. Don't put live GitHub calls in CI.
- Exercise changed UI paths in the browser. For storage or deployment changes, launch the real server against an isolated state directory and check persisted output. Never commit credentials, account data, or smoke-test scaffolds.

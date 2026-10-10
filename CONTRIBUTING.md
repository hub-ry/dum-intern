# Contributing

[docs/workshop-plan.md](docs/workshop-plan.md) is the product direction. The earlier desktop implementation remains in Git history, not in the current runtime.

## Working on it

Use Node 24. Read [README.md](README.md) for Claude CLI, Docker, and private-network setup.

```sh
npm ci
npm run dev
npm run typecheck
npm test
```

- `src/workshop` owns the private learning runtime, generation, and reader. Tests live beside the behavior they cover.
- `src/site` owns the public product site and its explicitly labelled verified example.
- `src/public` serves public files only. It must never expose the workshop home, credentials, or authenticated APIs.
- `src/art` is the authored Dum/Wizard glyph source.

The current guided lessons cover loops and conditions. Do not imply universal curriculum coverage. The background progress record distinguishes server-graded answers from self-reports; neither proves mastery by itself.

## Invariants

- Generated JavaScript executes only in the isolated, offline verifier, never on the host. Model generation is tool-free; personal context is still sent to the selected model provider.
- Preserve immutable teaching text and job snapshots. Do not invent quotes, learner activity, confusion, or successes.
- Validate actual interactive output before marking a creation ready. Failure remains visible rather than being replaced with a fabricated result.
- Corrections create versions; they do not overwrite original creations or saved reader positions.
- Reading a prepared presentation works without a model call.
- Keep private context private. Public examples and notes are explicitly selected, not automatic exports of learning history.
- Preserve the existing glyph characters; distinguish Wizard's study assistance from Dum's creation explanation.

## Verification

Run the typecheck and deterministic tests after changes. Exercise the affected path in the actual program: browser interaction for UI, a real isolated generation for publisher changes, and a service restart for persisted-state changes. Do not put live model calls into CI.

New permanent tests must cover meaningful behavior, boundaries, transitions, errors, or evidence labels—not source strings, wiring, or incidental copy. Do not commit private state, credentials, diagnostic scaffolds, or unlabelled generated demonstrations.

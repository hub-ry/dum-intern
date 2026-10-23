# Your Dum

This is the starting folder for a Dum workspace. See the [project README](https://github.com/hub-ry/dum-intern/blob/main/README.md#workspace-and-hosting) for workspace selection, storage, and getting papers onto the server.

- `tree.json` owns the goals, skill tree, unlocks, and saved builds.
- `goal.md` is generated from `tree.json` whenever Dum saves the workspace. Edits to it are overwritten.
- `readings/` holds each block's brief and teaching paper. Use the [`dum-paper` skill](https://github.com/hub-ry/dum-intern/blob/main/skills/dum-paper/SKILL.md) to write a paper.
- `builds/` holds generated snapshots of the saved stacks in `tree.json`. Dum rewrites those snapshots when saving the workspace.

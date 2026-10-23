---
name: dum-paper
description: >-
  Write one Dum teaching paper, a learn.sty LaTeX article compiled to PDF, for a
  locked skill block. Use when the user asks to write a Dum paper, a reading, a
  teaching paper, or the assignment for a block, or when a readings/*.brief.json
  has no matching PDF. Runs in the user's Cursor. Never asks hub to write or
  compile the paper.
---

# Dum paper

Write one teaching paper for one block, then compile it on this machine. Hub serves the PDF. Hub does not write it and does not compile it.

## Find the workspace

The workspace is the folder that contains `tree.json`. Look for `./dum/tree.json`, then `./tree.json`, then a root the user names. Do not create a second tree.

Read `tree.json` and `readings/<id>.brief.json` for the block. The brief has `goal`, `aim`, `title`, `summary`, `parent`, `tex`, and `pdf`. If they did not name a block, list the briefs that have no PDF at `pdf` and ask which one. One paper per run.

## What a paper is

A paper is a LaTeX article that uses the shared style at `learn.sty` in the workspace (the same file as learn.ryhub.dev). Start with:

```latex
\documentclass[11pt]{article}
\usepackage{learn}
```

Use only what that style provides: `\code{}`, `\ts{}`, `lstlisting` with `style=py`, `style=cpp`, `style=ts`, `style=sh`, or `style=json`, the `why` and `keypoint` boxes, and `\underneath{}`. No minted, no shell escape, no extra packages, no images.

Write the source to the `tex` path from the brief. Copy `learn.sty` into `readings/` if it is not already there, so tectonic can find it next to the source.

The paper teaches the block in the goal's words. A generic filter, a toy that ignores the aim, or a restatement of the brief is not a paper. Read the goal and the parent block. The parent is context. This paper does not re-teach it.

Shape:

1. Title is the block title. The author line is the goal title.
2. A short opening that says what this block is inside that goal.
3. One section that shows the move, with a listing small enough to check by hand. The code is the idea, not a scaffold around it.
4. `\underneath{}` for what that code costs or hides.
5. A `keypoint` box with the one sentence that matters.
6. A second section with one worked case. Show the input, each step, and the result. The reader should be able to recompute it with the paper closed.
7. A `why` box with one question in their own words. The site does not collect the answer.

Two pages is enough. Do not write a chapter. Do not invent a second curriculum. Do not claim the reader has mastered the block.

Escape LaTeX special characters in anything you copy from the brief.

## Compile here

From the workspace root, if `tectonic` is on this machine:

```sh
tectonic --outdir readings/pdf readings/<id>.tex
```

The PDF must land at the `pdf` path from the brief. If tectonic is missing, leave the `.tex` in place and say so. Do not SSH to hub, do not call dumintern.com, and do not ask the Dum server to compile it.

When the PDF exists, tell the user its path and point them to the [project README's workspace instructions](../../README.md#workspace-and-hosting) for making it available to the site.

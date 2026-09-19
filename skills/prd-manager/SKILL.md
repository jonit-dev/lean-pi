---
name: prd-manager
description: Answer PRD questions without reading PRDs — one table of every PRD's real progress, a drift and bloat audit, and one-command archiving. Use when asked where the work stands, which PRDs are in flight or stalled, whether a PRD is ready to close, why docs feel bloated, or to move a finished PRD into done/. Repo-agnostic and zero-install. Not for writing a PRD (prd-creator) or for the rules of keeping one honest (prd-lifecycle).
---

# prd-manager

Operational tooling for a directory full of PRDs. Three commands read every PRD and print
a screen, so an agent never loads hundreds of thousands of words to learn where things stand.

## How it fits with the other PRD skills

| Skill | Owns |
|---|---|
| [`prd-creator`](../prd-creator/SKILL.md) | writing the plan — phases, wiring ledger, tests, and the header fields below |
| [`pr-manager`](../pr-manager/SKILL.md) | PR titles, body shape, and auditing the open PRs |
| `prd-lifecycle` (a project skill, where one exists) | the rules for keeping a PRD honest |
| **`prd-manager`** | the machinery: reporting, auditing and archiving those PRDs |

`prd-creator` is the companion skill in this repository. Install it alongside this one —
without it there is nothing emitting the fields below in the first place:

```bash
ln -s "$PWD/skills/prd-creator" ~/.claude/skills/prd-creator
ln -s "$PWD/skills/prd-manager" ~/.claude/skills/prd-manager
ln -s "$PWD/skills/pr-manager"  ~/.claude/skills/pr-manager
```

They interlock through the fields a PRD carries. `prd-creator` emits them, this skill reads
and rewrites them:

```markdown
# PRD-<id> — <title>

**Status:** NOT STARTED          <- rewritten to DONE on close; audited against the folder
**Complexity:** 5 (MEDIUM)
**Depends on:** PRD-012

#### Phase 1: … 
**Status:** NOT STARTED          <- each phase's own marker, rewritten on close
- [ ] step                       <- phase boxes: the only source of the percentage
## Acceptance criteria
- [ ] claim                      <- acceptance boxes: the last thing to go green
```

A PRD written by `prd-creator` is trackable here the moment it exists. A PRD missing the
header `**Status:**` still closes — `prd-close.mjs` inserts the field rather than refusing —
but until then the audit cannot tell whether it is drifting.

## Run it

Zero install, zero dependencies, plain Node. Works in any repository with a PRD directory —
discovery walks up from the working directory looking for `docs/PRDs`, `docs/prds`, `PRDs`
or `prds`, and `PRD_ROOT=<dir>` overrides. `PRD_PATTERN=<regex>` overrides the `PRD-*.md`
filename convention.

```sh
S=~/.claude/skills/prd-manager/scripts   # or wherever this skill is installed

node $S/prd-board.mjs                      # every open PRD: %, boxes, age, batch, status
node $S/prd-board.mjs --filter inflight    # open | inflight | stalled | noboxes | ready | blocked | done | all
node $S/prd-board.mjs --pr --limit 20      # + the open PR matched to each PRD (needs gh)
node $S/prd-board.mjs --json               # same data for a script

node $S/prd-audit.mjs                      # drift and bloat, most actionable first
node $S/prd-audit.mjs --all --older 45     # every item; staleness threshold in days
node $S/prd-audit.mjs --strict             # exit 1 on filing drift, for a gate

node $S/prd-close.mjs <prd file>           # dry run: verify 100%, show the move
node $S/prd-close.mjs <prd file> --yes     # rewrite the status line, git mv to done/
node $S/prd-close.mjs <prd file> --reopen --reason "<what regressed>" --yes

node $S/prd-pr.mjs --create-labels --yes   # once per repository
node $S/prd-pr.mjs <prd file> --yes        # apply the progress label, after every push
node $S/prd-pr.mjs --all --yes             # every open PRD that has a PR
node $S/prd-body.mjs <prd file>            # the PR body, generated from the PRD
node $S/prd-body.mjs <prd file> --pr <n> --yes
```

## What each one is for

**`prd-board.mjs`** replaces "read the PRDs to see where we are." Progress comes from the PRD's
own checkboxes — ticked phase boxes bucket to 25/50/75, and 100% needs every acceptance box too —
so it cannot be talked into a number the file does not support. `age` is days since the last commit
touching the file.

**`prd-audit.mjs`** reports facts, never judgements, and names the fix for each:

| Finding | Why it matters |
|---|---|
| finished but still open | the archive move never happened |
| status line disagrees with the folder | the file says DONE and sits open, or sits in `done/` saying PROPOSED |
| duplicate PRD ids | the same number in several files; nobody can cite one |
| no phase checkboxes | progress cannot be reported, so the PRD never gets worked |
| compound acceptance criteria | a box conjoining independent claims can never be ticked |
| filed long ago, still at 0% | the plans nobody started, which every agent still reads |
| blocked and untouched | blockers outlive their condition |
| blocked PRD with no reason folder | the shape is `BLOCKED/<short-reason>/<prd>.md`; a loose file names no blocker |
| orphan evidence files | evidence nothing references — pure bloat |

**`prd-pr.mjs`** applies the progress label to the PRD's pull request and reports when more
than one open PR names the same PRD. **`prd-body.mjs`** generates that PR's body from the PRD —
TL;DR, the phase checklists as they actually stand, and what is still open.

**`prd-close.mjs`** is the archive move as one command. It refuses to close a PRD whose boxes are
open — listing exactly which ones, with line numbers, so "what is left" needs no read — then
updates **every** status field the PRD carries and `git mv`s the file:

- header `**Status:**` → `DONE — <date>. Every phase and acceptance box verified.` (inserted
  under the title when the PRD has no such field)
- header `**Progress:**`, where one exists → `100% — all phases and acceptance criteria verified.`
- each phase's own `**Status:**` still reading `NOT STARTED` / `IN PROGRESS` / `PARTIAL` → `DONE`
- a `**Closed:**` line stamping the date, the short HEAD sha and the PR, when `gh` can find one

Closing under `--force` with boxes still open says exactly that instead of claiming a verification
that did not happen. Dry run until `--yes`; `--keep-batch` preserves the batch subdirectory;
`--no-status` moves the file and touches nothing. `--reopen` is the regression path, demands
`--reason`, and strips the `**Closed:**` stamp — reopening without a named regression deletes the
record that the work landed.

Status words are uppercase, matching the folder convention: `NOT STARTED`, `PROPOSED`, `PARTIAL`,
`IN PROGRESS`, `BLOCKED`, `DONE`, `REOPENED`.

## One PR per PRD

**Exactly one pull request per PRD, opened as a draft before phase 1 starts. Never one PR
per phase.**

Phase-sized PRs are the mess this rule exists to prevent: one plan's evidence split across
five branches, so no branch shows the whole picture, the review happens five times on partial
context, and the PRD's progress stops being visible anywhere. Merging them in order becomes
its own coordination problem, and the last one always carries a rebase nobody wanted.

1. Cut the branch, open the **draft** PR with the PRD's checklist in the body
   (`prd-body.mjs` generates it).
2. Push each phase to that same PR as it lands.
3. Tick the box in the PR body in the same push that ticks it in the PRD — a PR box ticked
   ahead of the PRD is the same lie as a claimed gate.
4. Re-apply the progress label on every push (`prd-pr.mjs`).
5. When the last acceptance box is ticked, take the PR out of draft and `prd-close.mjs` the
   PRD into `done/` **in that same PR**.

A second PR is right only when the work is genuinely a different PRD — scope grew, so a new
PRD cites the finished one. Never merely because the first PR got large. `prd-pr.mjs` reports
when more than one open PR names the same PRD.

## The progress label

One label at a time, chosen by verified boxes — never by lines written or files touched.

| Label | Meaning | Colour |
|---|---|---|
| `prd:25%` | phase 1 landed and verified | `#d73a4a` red |
| `prd:50%` | half the phase boxes landed and verified | `#e36209` orange |
| `prd:75%` | phases in, acceptance boxes still open | `#fbca04` yellow |
| `prd:100% — ready` | every phase and acceptance box ticked; PR out of draft | `#0e8a16` green |

`prd-pr.mjs` computes the bucket from the PRD and swaps the label on its PR, so a stale label
cannot survive a push. Re-apply on every push: a stale label is worse than none, because it is
read as a claim.

Title conventions, the body shape and auditing the open PRs belong to the `pr-manager` skill.

## How to use it in a session

1. `prd-board.mjs` before touching PRD work, and quote its numbers rather than re-deriving them.
2. `prd-audit.mjs` when the docs feel bloated, or before a release. Fix the top categories first —
   they are ordered by actionability, not by count.
3. `prd-pr.mjs` and `prd-body.mjs` after every push, so the label and the PR body match the
   PRD's boxes rather than the last time someone remembered.
4. `prd-close.mjs` in the commit that finishes the work, never as a later tidy-up.
5. Never hand-count checkboxes or guess a percentage. If a number is wrong, the PRD's boxes are
   wrong; fix the boxes.

## Token cost

Every command prints what it saved: the words of the PRDs it covered against the size of its own
output. A board of the in-flight work is typically ~99% cheaper than reading those PRDs. That is
the whole point — reach for these before opening a PRD file, and open the file only once the board
has told you which one.

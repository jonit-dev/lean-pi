# PRDs

`ROADMAP.md` is the spec; a PRD slices it. Both are source of truth over code — code drifting from them is the bug.

`INDEX.md` is derived from the files on disk (phases from `#### Phase`, boxes from `AC-`). Update the PRD, regenerate the index; don't hand-maintain the table.

Finished PRD → `git mv` into `done/` in the same commit that finishes it, each criterion carrying its evidence.

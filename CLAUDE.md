# Rules

**Think first.** State assumptions; ask instead of guessing. Multiple readings → present them, don't pick silently. Simpler approach exists → say so.

**Simplicity.** Minimum code that solves the ask. No unrequested features, no single-use abstractions, no speculative config, no handling for impossible cases. 200 lines that could be 50 → rewrite.

**Surgical.** Every changed line traces to the request. Don't improve adjacent code, reformat, or refactor what isn't broken. Match existing style. Unrelated dead code → mention it, don't delete it. Do delete what your own change orphaned.

**Verify.** Turn the task into a check before coding: "fix the bug" → failing test first. State multi-step plans as `step → verify`. Run `pnpm test`, `pnpm typecheck`, `pnpm lint`.

**PRDs.** Plan with the `prd-creator` skill, not freehand. Ask `prd-manager` where PRDs stand instead of reading them. Finished PRD → `git mv` into `docs/PRDs/v1/done/` in the same commit that finishes it; never left in flight.

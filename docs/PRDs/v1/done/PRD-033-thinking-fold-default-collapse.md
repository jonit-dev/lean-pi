# PRD-033 — Thinking fold collapses from the first streaming frame

**Status:** DONE
**Complexity:** 1 (LOW)
**Owner:** Codex save-tokens task on `fix/thinking-fold-streaming`
**Depends on:** None

## Context

Lane: `/home/joao/projects/lean-pi/.worktrees/thinking-fold`, branch
`fix/thinking-fold-streaming`, base `8e0f249`. Task: a fold-enabled session shows
**zero trace from the first frame**; `ctrl+t` reveals the **full** trace while
streaming and after; `ctrl+t` again hides all of it. No preview/tail, no
automatic expansion for trace/summary/model rules, no growing thinking text.
`/thinking-fold off` keeps working (the extension is simply not attached).

Root cause: the vendored `@99percentpeople/pi-thinking-fold@0.1.11` resolves
`streamingBehavior:"auto"` through `resolveThinkingDisplayBehavior` to
`"preview"` for traces — a growing tail — and only completed turns collapse. A
stored `preview`/`full` or a summary model rule still wins. Seeding the
extension's persisted `99extensions.json` is insufficient and would write a
user's global config to enforce a rendering invariant.

## Solution

`scripts/vendor-thinking-fold.mjs` now applies a small deterministic patch to the
upstream build before writing `vendor/pi-thinking-fold/index.min.ts`. Each patch
is an exact string that must match once or the build fails (so a dependency bump
is a red build, not a silent preview):

1. `resolveThinkingDisplayBehavior` always returns `collapse` for a
   non-expanded block; Ctrl+T still early-returns the raw full message.
2. Both unwrap-failure fallbacks rendered the raw full trace; they now render the
   collapsed label via `createThinkingDisplayMessage`.
3. The working-status call site writes the generic `Thinking...` label instead of
   `createThinkingCursorLabel`, so a `summary` model rule cannot put a reasoning
   headline into the working status while the block is collapsed. The summary
   lookup that drives the post-thinking linger timing is left intact.
4. The `/99settings` rows are replaced by one truthful, non-interactive
   `Reasoning` explanation. The obsolete preview controls and the persisted
   `preview`/`full` values they used to display are gone, not turned into a
   single-value menu.

No new config write; user config is untouched. Stale "tail preview" wording in
`src/cli/launch.ts`, `src/commands/thinking-fold.ts` and `README.md` updated.

## Acceptance Criteria

- [x] AC-1 [local]: A non-expanded streaming block (trace **and** summary)
      resolves to `collapse`, even with persisted `preview`/`full` values; the
      rendered component shows zero trace lines, the
      `Thinking … (ctrl+t to expand)` label, and the answer intact; no trace text
      or summary headline enters the working status — Evidence:
      `tests/commands/thinking-fold.spec.ts` "resolves every non-expanded…",
      "shows zero trace from the first streaming frame…" and "keeps the working
      status generic through the extension's message_update hook".
- [x] AC-2 [local]: Hidden across further chunks and after completion
      (`Thought for…`); `ctrl+t` reveals the full trace mid-stream and after,
      with head/middle/tail of a 12-line trace so a 5-line preview cannot pass;
      appended chunks stay full while expanded and hidden after re-collapse; a
      second collapsed timestamp inherits nothing; Ctrl+T before any thinking is
      honoured; the compact UI's render cache cannot leak the state through
      `fold-cache.ts` — Evidence: "stays hidden as more chunks arrive…",
      "Ctrl+T reveals the full trace…", "honours Ctrl+T pressed before…",
      "clears the compact UI's render cache…".
- [x] AC-3 [local]: The committed vendor is exactly `patch(installed)`, the
      guard throws on unrecognised upstream, the settings surface is a single
      truthful `Reasoning` explanation, and the fallback produces the label
      rather than the raw trace — Evidence: "ships the installed build with
      exactly the binary-collapse patch…", "falls back to the collapsed label
      when a child cannot be rewrapped".
- [x] AC-4 [local]: `/thinking-fold off` attaches no fold; fold attaches before
      the compact UI — Evidence: existing "is the extension the launcher
      attaches…" (unchanged).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Binary collapse of streaming reasoning | `node bin/leanpi.js` → `vendor/pi-thinking-fold/index.min.ts` patched copy → patched `resolveThinkingDisplayBehavior` / `AssistantMessageComponent` render / working-status label | Extension's stock `preview` tail, its `preview`/`full` settings choices and its summary headline in the working status; Ctrl+T remains the only expansion | AC-1..AC-3 |
| Explicit off | `/thinking-fold off` → launcher attaches no fold | Unchanged | AC-4 |

## Verification (2026-09-21)

- Focused: `pnpm vitest run tests/commands/thinking-fold.spec.ts` → 14 passed;
  reverting the working-status and fallback patches reds the new assertions
  (working status `TRACE_LINE_01`, 12 raw trace lines, no expand label).
- Full: `pnpm test` → 648 passed, 10 skipped, 111 files (109 passed).
- `pnpm typecheck` clean; `pnpm lint` 0 errors (pre-existing warnings only);
  `pnpm build` regenerates the committed vendor byte-identically.

**Not proven by the harness:** no real Pi TUI was booted (needs a TTY and a
model). The extension is exercised at its real `AssistantMessageComponent`
render/toggle boundary, including the `fold-cache.ts` wrapper; the full
`--ui compact` TUI integration is covered only by the launcher-order test and
that wrapper, not by a live session. The rewrap-failure fallback is forced by
temporarily making the wrapper's child unrecognisable (`MouseRegion.handleMouse`),
so it proves the patched fallback path rather than a naturally-occurring failure.
The working-status hook is driven directly; no model rule is actually configured.

## Open Questions

None.

# LeanPi vs stock Pi: first model-call divergence (offline)

Executes step 1 of [`leanpi-cost-next-steps.md`](leanpi-cost-next-steps.md) against
the saved paired traces. No paid run, no behavior change.

## Method

Every pair below is one LeanPi and one stock Pi attempt on the **same task, same
model** (`opencode-go/deepseek-v4.1-flash`) from the benchmark worktree. The
counts-only traces are `bench/out/<run>/trace-<task>@<arm>.json` in
`.worktrees/benchmark-stock-pi`; each assistant message is one model call and
each tool result carries its requesting call, a `shell_kind` label, and — in the
newer traces — `git_action` / `repeat` / `error` flags. Arguments, prompts and
result text are never persisted (see `src/bench/adapters.ts`).

Analysis: drop each arm's trailing assistant-only message, map `execute` and
`bash` to one `SHELL` category (the arms use different shell tool names), take
the first `edit` call as the phase boundary, and compare the two sequences.

## What the traces show

| run (task) | L calls | S calls | gap | L 1st edit | S 1st edit | L pre | S pre | pre gap | L post | S post | post gap | L rep+err | S rep+err | L git | L search |
| --- |--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `workflow-kind-pair-20260923` (slugify) | 26 | 11 | +15 | 19 | 7 | 19 | 7 | +12 | 7 | 4 | +3 | 0 | 0 | 0 | 1 |
| `workflow-trace-slugify-20260923` (slugify) | 29 | 14 | +15 | 22 | 7 | 22 | 7 | +15 | 7 | 7 | +0 | 0 | 0 | 0 | 1 |
| `minimal-jev-stocktools-slugify-20260923` (slugify) | 19 | 23 | -4 | 12 | 16 | 12 | 16 | -4 | 7 | 7 | +0 | 0 | 0 | 0 | 0 |
| `repeat-error-slugify-20260923-t1` (slugify) | 44 | 27 | +17 | 28 | 19 | 28 | 19 | +9 | 16 | 8 | +8 | 10 | 1 | 9 | 1 |
| `bash-alias-onefactor-t1` (slugify) | 31 | 20 | +11 | 24 | 14 | 24 | 14 | +10 | 7 | 6 | +1 | 5 | 0 | 7 | 1 |
| `suite-shell-family-diagnostic-20260923-t1` (express) | 13 | 24 | -11 | 5 | 18 | 5 | 18 | -13 | 8 | 6 | +2 | 0 | 0 | 0 | 4 |
| `suite-shell-family-diagnostic-20260923-t1` (flask) | 49 | 33 | +16 | 36 | 25 | 36 | 25 | +11 | 13 | 8 | +5 | 0 | 0 | 0 | 12 |
| `suite-shell-family-diagnostic-20260923-t1` (preact) | 43 | 41 | +2 | 40 | 27 | 40 | 27 | +13 | 3 | 14 | -11 | 0 | 0 | 0 | 2 |
| `suite-shell-family-diagnostic-20260923-t1` (slugify) | 33 | 14 | +19 | 24 | 10 | 24 | 10 | +14 | 9 | 4 | +5 | 0 | 0 | 0 | 0 |

Ceiling-killed attempts (both arms): express and preact in
`suite-shell-family-diagnostic-20260923-t1`; their tails are truncated.
LeanPi failed external verification in `repeat-error-slugify-20260923-t1`.

### First divergence, per pair

Normalized action sequences (one token per model call) start at call 0 for both
arms; `SHELL+...` means several shell invocations batched into one turn.

1. **`workflow-kind-pair-20260923`** — align calls 0–1 (`SEARCH+SHELL`/`SHELL+SHELL`,
   then `READ`). LeanPi diverges at **call 2** and then runs **12 extra
   pre-edit shell turns** (`SHELL` repeated, all `shell_kind: other`, command
   family redacted) before its first edit at call 19; stock edits at call 7.
2. **`workflow-trace-slugify-20260923`** — same shape. Divergence at **call 2**,
   **15 extra pre-edit calls**, first edit L22 vs S7, and **zero** post-edit gap.
3. **`repeat-error-slugify-20260923-t1`** — first divergence at **call 2** (stock
   `READ`, LeanPi `SHELL`). LeanPi's pre-edit excess is a mix: 3 `git log`/`git
   show`, 4 repeated `node` runs, and ~9 unlabeled `SHELL` turns. First edit L28
   vs S19.
4. **`bash-alias-onefactor-t1`** — first divergence at **call 2**. LeanPi makes
   3 `git log`/`git show`, 6 `WRITE` turns (stock has none of either tool's
   output there) and edits at call 24 vs stock's 14.
5. **`suite-shell-family` flask** — first divergence at **call 0** (LeanPi opens
   with `SEARCH+SHELL`, stock with `SHELL`). LeanPi issues **12 `search` calls**
   vs 0; these are the single largest labeled component of its +16.
6. **`suite-shell-family` slugify** — first divergence at **call 1**. LeanPi
   writes 8 `WRITE` turns before its first edit at 24; stock edits at 10.

The remaining pairs do not fit the pattern: `minimal-jev-stocktools` (LeanPi run
on a temporary stock-style tool surface) is **cheaper in calls than stock**, and
`express` inverts entirely — LeanPi edits at call 5, stock at call 18.

## Step-2 gate: not met

The doc advances only if one cause explains **≥70% of excess LeanPi calls in
multiple pairs**. Tested against the nine pairs:

| candidate | pairs where it is the largest component | share of the pair's excess |
| --- | --- | --- |
| `search` (LeanPi-only tool) | flask 12/16, express (excess negative) | 75% in one pair, ≤7% elsewhere |
| `WRITE` tool turns | bash-alias 6/11, suite-slugify 8/19, repeat-error 5/17 | 55% / 42% / 29% |
| pre-edit shell run (`shell_kind: other`) | workflow-kind-pair 11/15, suite-flask 16/16 | 73% / 100%, but unlabeled |
| `git log`/`show` | repeat-error 4/17, bash-alias 3/11 | 24% / 27% |
| repeat/error flags | repeat-error 9/17 | 53% in one pair, 0 elsewhere |

No mechanism clears 70% in **multiple** pairs. The only pair that reaches 70% by
a named tool is flask's `search` share; every other pair is a different mix. The
**largest share belongs to shell turns the trace records only as `other`**, so
the cause cannot be named from these artifacts — exactly the limit the direction
check flagged.

**Excess sits mostly pre-edit.** Seven of nine pairs carry a positive pre-edit
gap and a small or negative post-edit gap. LeanPi's first edit lands 5–15 model
calls after stock's in the slugify draws. But `express` reverses it and
`minimal-jev-stocktools` is negative overall, so it is not a stable rule either.

## Verdict

- ✅ Step 1 run: first divergence located in nine pairs, call numbers and
  artifact paths below.
- ❌ Step 2 gate not met: no single repeated cause accounts for ≥70% of the
  excess in multiple pairs. The largest labeled component is flask's `search`
  calls; the largest unlabeled one is the pre-edit `other` shell run.
- ⛔ Steps 3–4 blocked: they need a named cause and paid runs. Consistent with
  the decision line, **no agent behavior changed and no paid trial was run.**

If this line is pursued, the missing field is not agent behavior but trace
granularity: older traces have no `shell_head` on their `other` calls and none
of them persist a phase-relative call position. A bounded diagnostic pair with
the newer `shell_head`/`git_action` fields (already implemented) would name the
pre-edit shell family; it still needs an authorized paid run.

## Artifacts

Worktree `/home/joao/projects/lean-pi/.worktrees/benchmark-stock-pi`, under
`bench/out/`:

- `workflow-kind-pair-20260923/trace-slugify-counter-duplicate-slug@{leanpi-flash,stock-pi-deepseek}.json`
- `workflow-trace-slugify-20260923/slugify-trace/…@leanpi-flash.json` and `workflow-trace-stock-slugify-20260923/slugify-stock-trace/…@stock-pi-deepseek.json`
- `minimal-jev-stocktools-slugify-20260923/…`
- `repeat-error-slugify-20260923-t1/…`
- `bash-alias-onefactor-t1/…`
- `suite-shell-family-diagnostic-20260923-t1/trace-{express,flask,preact,slugify}-*@{leanpi-flash,stock-pi-deepseek}.json`

Ledgers with verdicts and ceiling notes: `ledger.jsonl` in each run directory.

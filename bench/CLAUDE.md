# bench

Numbers come from the ledgers under `out/`, folded by the harness. Never hand-edit a ledger or type a number into a doc by hand.

Goldens are held out: the adjudicator's test files must not be visible during an attempt. A change that leaks them invalidates the run.

Re-folding a finished run (`--recompute`) beats re-running it. Report run count and caveats with every figure.

## The LeanPi arm needs a permission profile

`edit`, `shell`, `network` and `package_install` resolve to `ask` by default (`src/permissions/rules.ts`), and a headless session refuses what it cannot ask about (`src/permissions/guard.ts`) — so a run without a profile measures an agent that can read and think but not write. The published comparison benchmark ran under one; `bench/profiles/bench/` is that profile, committed, and `bench/cost/run-pair.sh` exports `XDG_CONFIG_HOME` at it. Check a run's profile before believing its solve rate: a `0/N` solve rate is the first symptom of a missing profile, not a property of the model.

## Cost series

`bench/cost/run-pair.sh <suite> <tag>` runs one baseline/treatment pair, alternating arms, one run at a time, with a fresh provider session per run. `bench/cost/fold.py bench/cost/series.json` folds them: medians with ranges, within-pair ratios, partial runs and mismatched task sets refused. A single run cannot separate a 30% win from a 50% one on this suite; pairs and repeats are the unit of evidence.

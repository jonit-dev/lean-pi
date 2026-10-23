---
name: ux-kpi-loop
description: Improve LeanPi's UX KPIs one measured change at a time - time to ready (startup), first reply, error and abort rates, crashes. Measure with `pnpm kpi` and `pnpm bench:startup`, pick the worst red KPI, make one change, re-measure, keep or revert, log the result. Use with `/loop /ux-kpi-loop`, or when the user says "improve startup", "time to ready", "UX KPIs", "make leanpi faster to open".
---

# UX KPI loop

One iteration = one hypothesis, one change, one before/after measurement. Never stack two untested changes.

KPI definitions and targets: `docs/benchmarks/ux-kpis.md`. Open optimization ideas: `docs/PRDs/v1/PRD-055-ux-optimizations.md`.

## Each iteration

1. **Read state.** Read the last 20 lines of `docs/benchmarks/ux-kpis.md` (the log). Do not retry a lever the log already closed.
2. **Measure.** Run `pnpm kpi -- --json` and read `kpis`, `phases`, `imports`, `bench`. The dashboard is `~/.leanpi/kpi.html`.
3. **Pick the target.** Take the red KPI furthest from its target, as a ratio. Time to ready wins ties: the operator ranks it first.
4. **Baseline.** For startup work, check the machine load first (`cat /proc/loadavg`). Above about 12, use the laptop (`laptop-offload` skill) or wait. Run `pnpm bench:startup -- --runs 10 --note "baseline: <lever>"`.
5. **Hypothesis.** Name the phase or import that the change attacks, and the expected saving in ms. Use the `phases` and `imports` medians and the per-launch tooltip on the dashboard.
6. **Change one thing.** Smallest diff. Follow the repo rules in `CLAUDE.md`.
7. **Re-measure.** `pnpm bench:startup -- --runs 10 --note "<lever>"`. A win is a p50 drop larger than the run-to-run spread (about 10% unless the log says otherwise) with p90 not worse.
8. **Keep or revert.** Win: run `pnpm test`, `pnpm typecheck`, `pnpm lint`, then commit only when the user allowed commits for this loop. No win: revert the change.
9. **Log.** Append one line to the log in `docs/benchmarks/ux-kpis.md`: date, KPI, lever, before → after p50/p90, kept or reverted, and one sentence on why.
10. **Report.** One line: KPI, lever, before → after, kept/reverted, next lever.

## Rules

- **Evidence boundary.** Keep rolling and organic red KPI values visible; never mark them green or ignore them. Before choosing a change, compare the observation window of those values with the date of the last relevant change, and run a fresh controlled baseline/candidate comparison on the same host. Stale pre-change observations alone must not justify another change when the fresh comparison meets the target.
- **Marker boundary.** A time-to-ready candidate must execute before the editor-painted marker. Work that begins after that marker cannot improve that KPI and needs a matching metric. If no eligible candidate remains, move to the next measurable KPI instead of editing speculatively.
- Organic KPIs (`pnpm kpi`) move only after real use. Judge startup changes with the bench, never with organic numbers from the same hour.
- Error and abort KPIs need a code path, not a bench: find the cause in the session logs (`~/.pi/agent/sessions`), fix it, and add a test that fails before the fix.
- Stop the loop when every KPI is green, or after two iterations in a row with no win on the same KPI. Then report and re-plan with the user.

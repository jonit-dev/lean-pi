# Performance learnings

The detailed UX iteration log is in [`docs/benchmarks/ux-kpis.md`](docs/benchmarks/ux-kpis.md). Keep this file for cross-loop findings without duplicating its history.

### 2026-10-23 — Revalidate current startup stack — KEEP
- Where: `codex/prd-055-ux-optimizations` at `d8385c1`
- Ceiling: no new saving; verify the retained sub-second startup level against the 2.5 s p50 target.
- Result: 10 runs at 811/821 ms p50/p90; repeat at 804/813 ms. The 7/8 ms shifts are under 1%. The repeat row is marked dirty because the runner appends to the tracked benchmark file.
- Cause: the current worktree retains the sub-second level; this does not remeasure individual earlier cuts.
- Insight: organic p90 includes older launches; use controlled runs for code decisions. Exact prior cut sizes still need repeated pairs.
- Artifact: `bench/out/startup-bench.jsonl`; no source patch.

### 2026-10-23 — Crash KPI provenance — INCONCLUSIVE
- Where: `codex/prd-055-ux-optimizations` at `d8385c1`
- Ceiling: one event in the current 30-day KPI window; no code saving can be sized without a current callsite.
- Result: the in-window record is from 2026-09-23, reports version `0.87.1`, cwd `/home/joao/projects/lean-pi`, and only `ENOSPC: no space left on device, write`; it has no stack frame and does not overlap a startup run.
- Cause: a genuine historical disk-write failure, but no evidence ties it to current source or a reproducible code path.
- Insight: the crash KPI reads the host-wide Pi crash log; retain the event and do not exclude it as benchmark noise.
- Artifact: `~/.pi/agent/crashes.json`; no source patch.

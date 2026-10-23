# PRD-055 — First UX optimizations: time to ready and failed turns

**Status:** NOT STARTED
**Priority:** P1 — time to ready is 2.6 s p50 / 10.3 s p90 against 2.5 s / 5 s targets, and 8.6% of turns end in an error (AC-1 to AC-6 open). The operator ranks time to ready first.
**Complexity:** 4 (MEDIUM)
**Owner:** Joao
**Depends on:** PRD-054 (KPIs, bench, `ux-kpi-loop` skill)

## Context

Numbers from `pnpm kpi` and the raw logs, 30 days to 2026-10-23:

- **Time to ready** p50 2566 ms, p90 10.3 s. The 30 days before: 1622 ms / 2078 ms. Controlled bench on Pi 0.87.1: p50 4822 ms, p90 9690 ms (5 runs, load 54, noisy; re-baseline on a quiet machine).
- **Launcher** is the largest phase (median 1045 ms organic, 1907 ms bench). Launcher `imports` mark p50 1729 ms. Before `bin/leanpi.js` parses a flag, `scripts/leanpi-local.sh` starts three Node processes in sequence (`vendor-thinking-fold.mjs`, `dev-build.mjs`, `bin/leanpi.js`), then `bin/leanpi.js` imports its whole `dist/` graph.
- **Two Node boots.** `bin/leanpi.js` spawns Pi as a child process. The child boots Node and imports again: "pi boot" median 763 ms organic, 1724 ms bench.
- **Extensions load as TypeScript.** Pi transpiles `extensions/*/index.ts` at runtime. On a cold cache one launch spent 2442 ms on `compact-ui`, 1491 ms on `usage`, 981 ms on `background`; `createAgentSessionRuntime` p50 1753 ms, max 8412 ms.
- **Failed turns.** Top error messages over 30 days: `This operation was aborted` 38, `429 GoUsageLimitError` 28, `402 Insufficient account funds` 4, `400 Model is unavailable` 4, `401 Invalid API key` 3. The first is a cancel or a timeout counted as an error. The quota errors end the turn with no fallback.

## Solution

Use the `ux-kpi-loop` skill: one lever per iteration, bench before and after, keep or revert, log in `docs/benchmarks/ux-kpis.md`. Levers in expected-value order:

1. **One Node process in the wrapper.** Fold the vendor and build checks into `bin/leanpi.js`, or skip them on an mtime check in shell. Expected saving: two Node starts (about 100–300 ms each).
2. **Ship extensions as JavaScript.** Compile `extensions/*.ts` into `dist/` at build time and register the `.js` files. Expected saving: the cold-cache transpile (up to seconds per extension).
3. **Lazy imports in the launcher.** Import onboarding, update check and JEV code only on the paths that use them.
4. **Run Pi in-process.** Find why `bin/leanpi.js` spawns a child; if nothing forces it, import Pi's main directly. Expected saving: one Node boot plus Pi's import graph (about 0.7–1.7 s). Largest change; do it after 1–3.
5. **Classify `This operation was aborted`.** Find whether it is the operator's Esc or an internal timeout. A timeout is a bug to fix; an Esc must count as `aborted`.
6. **Fall back on quota errors.** On `429 GoUsageLimitError` or `402`, switch to the next configured model once and print one line that says so.

## Acceptance Criteria

- [ ] AC-1 [local]: Bench time to ready p50 ≤ 2500 ms. proof: `pnpm bench:startup -- --runs 10` on a machine with load below 12 — Evidence: pending.
- [ ] AC-2 [local]: Bench time to ready p90 ≤ 5000 ms. proof: same run — Evidence: pending.
- [ ] AC-3 [local]: The wrapper starts one Node process per launch. proof: a test on `scripts/leanpi-local.sh` or `strace -f -e trace=execve` count — Evidence: pending.
- [ ] AC-4 [local]: No `.ts` extension is transpiled at launch. proof: the `pi_timing` lines of a bench launch list only `.js` extension paths — Evidence: pending.
- [ ] AC-5 [local]: `This operation was aborted` has a known cause, and a test pins the fix or the new classification. proof: `pnpm vitest run <test>` red then green — Evidence: pending.
- [ ] AC-6 [local]: A quota error falls back to the next model and the turn completes. proof: `pnpm vitest run <test>` with a stub backend that returns 429 — Evidence: pending.
- [ ] AC-7 [local]: No regression. proof: `pnpm test`, `pnpm typecheck`, `pnpm lint` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Faster launch | `leanpi` → `scripts/leanpi-local.sh` → `bin/leanpi.js` | current wrapper and spawn path | AC-1 to AC-4 |
| Turn error handling | a turn in a live session → provider error path | current error stop | AC-5, AC-6 |

## Execution Phases

#### Phase 1: Startup levers 1–3
**Status:** NOT STARTED
**Files:** `scripts/leanpi-local.sh`, `bin/leanpi.js`, `tsconfig.json` or `scripts/dev-build.mjs` (extension build), extension registration
**Verification:** AC-3, AC-4, bench row per lever in `bench/out/startup-bench.jsonl`

#### Phase 2: Run Pi in-process (lever 4)
**Status:** NOT STARTED
**Files:** `bin/leanpi.js`, `src/cli/launch.ts`
**Verification:** AC-1, AC-2

#### Phase 3: Failed turns (levers 5–6)
**Status:** NOT STARTED
**Files:** to be found from the error path
**Verification:** AC-5, AC-6, AC-7

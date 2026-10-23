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

## Decisions

- 2026-10-22 (planning scope): Keep one completion box per existing phase plus all seven original ACs: 10 boxes total. `prd-audit` counts both kinds against eight; reducing further would remove phase tracking, combine ACs, or split the selected scope. The size finding remains visible; no acceptance requirement is waived.

## Execution Phases

#### Phase 1: Startup levers 1–3
**Status:** NOT STARTED
**Files:** `scripts/leanpi-local.sh`, `bin/leanpi.js`, `src/cli/launch.ts` (extension registration), `tsconfig.json` or `scripts/dev-build.mjs` (extension build), `tests/cli/launch.spec.ts`, new `tests/cli/local-wrapper.spec.ts`
**Implementation:** Apply levers 1–3 individually through the real wrapper. The wrapper also runs a Node version probe (`node -e`) for each candidate before the three Node processes described above; merely combining vendor/build checks leaves that extra boot. Preserve Node ≥22.19 selection, caller cwd/arguments and failure handling. At `src/cli/launch.ts:125`, compiling or bundling extension `.ts` imports must retain the running Pi's class/prototype identity; avoid private copies of Pi/TUI packages that bypass prototype patches. Cover dependency-provided TypeScript as well as local extensions.

1. Launch the wrapper with one Node invocation. Add `tests/cli/local-wrapper.spec.ts` for actual wrapper-owned invocation count, supported/unsupported runtime candidates, stale vendor/build fixtures (AC-3).
2. Launch every default extension as built JavaScript with shared Pi prototypes intact. Extend the shipped-entry-point tests for compact UI/prototype behavior; assert that bench `pi_timing` extension paths contain only `.js` (AC-4).
3. Make optional launcher imports lazy. Extend existing coverage for onboarding/update-check/JEV load paths, informational flags, normal launch behavior.

- [ ] Startup levers 1–3 satisfy the wrapper/extension/import contracts above. proof: `pnpm build && pnpm vitest run tests/cli/local-wrapper.spec.ts tests/cli/launch.spec.ts tests/extension-surface.spec.ts tests/cli/startup-trace.spec.ts`, then `pnpm bench:startup -- --runs 1` (AC-3, AC-4).

**Verification:** Use `ux-kpi-loop` before and after each lever; retain comparable bench rows in `bench/out/startup-bench.jsonl` and record keep/revert decisions in `docs/benchmarks/ux-kpis.md`. The focused tests above require behavior-specific red → green for changed behavior, not manufactured failures for unchanged gates.

#### Phase 2: Run Pi in-process (lever 4)
**Status:** NOT STARTED
**Files:** `bin/leanpi.js`, `src/cli/launch.ts`, `tests/cli/launch.spec.ts`, `tests/cli/startup-trace.spec.ts`
**Implementation:** After Phase 1, establish why the child exists, then import Pi's main if no requirement forces the child. Preserve arguments, environment, cwd, signals, exit status and extension behavior. An identified requirement to retain the child does not waive the startup targets or AC-3.

1. Run Pi in the launcher process with its CLI/session lifecycle preserved. Extend real-entry-point coverage for process count, CLI output, signal handling, exit propagation; run `pnpm vitest run tests/cli/launch.spec.ts tests/cli/startup-trace.spec.ts tests/cli/local-wrapper.spec.ts`.
2. Meet both startup targets after the retained levers. `node -p 'require("node:os").loadavg()[0]'` must confirm load below 12 before the qualifying run; defer the measurement until the required load is available.

- [ ] The retained startup path meets the time-to-ready targets. proof: `pnpm bench:startup -- --runs 10` — the same comparable run under load below 12 reports p50 ≤2500 ms, p90 ≤5000 ms (AC-1, AC-2).

**Verification:** Compare lever 4 with Phase 1 using the same workload/cache conditions and keep/revert log; use the single qualifying ten-run bench for both AC-1 and AC-2.

#### Phase 3: Failed turns (levers 5–6)
**Status:** NOT STARTED
**Files:** `src/backends/session-limits.ts:42` (abort classification), `src/index.ts:787,927` (session error/failover path), `tests/backends/session-limits.spec.ts`, `tests/cli/session-fallback.spec.ts`, `tests/helpers/stub-backend.ts`
**Implementation:** Phase 3 is independent of the startup changes. Establish abort provenance from raw records and the reachable cancel/timeout paths before choosing a fix: the shared error string alone cannot prove Esc or timeout. Reuse the configured model order for quota fallback; the existing next-turn routing test does not prove that the failed turn resumes and completes. For either `429 GoUsageLimitError` or `402`, attempt the next configured model at most once and print one explanatory line; repeated quota failure or exhaustion terminates without a retry loop.

1. Resolve the evidenced cause of `This operation was aborted`. Use `pnpm vitest run tests/backends/session-limits.spec.ts tests/cli/session-fallback.spec.ts` red → green: distinct cancel/timeout stimuli through the real reporting path assert the timeout fix or the evidenced operator-cancel classification. Record the attributable cause beside AC-5.
2. Complete the same user turn on the next configured model after a quota error. Extend `tests/cli/session-fallback.spec.ts` with the stub-backed real session path for 429/402 then success; assert a completed response without a second user prompt, plus bounded requests/notices on repeated refusal (AC-6). The focused command above must establish red → green.
3. Run the final regression gates after the startup/turn-error changes: `pnpm test`, `pnpm typecheck`, `pnpm lint` (AC-7).

- [ ] Failed-turn handling satisfies the abort/quota contracts above. proof: `pnpm vitest run tests/backends/session-limits.spec.ts tests/cli/session-fallback.spec.ts`, `pnpm test`, `pnpm typecheck`, `pnpm lint` (AC-5, AC-6, AC-7).

**Verification:** Store results on the owning boxes/ACs once; all seven ACs remain required, and implementation and acceptance stay pending until their commands establish the claimed results.

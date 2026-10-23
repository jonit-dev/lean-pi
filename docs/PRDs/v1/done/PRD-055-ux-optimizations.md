# PRD-055 — First UX optimizations: time to ready and failed turns

**Status:** DONE
**Priority:** P1 — the retained startup path meets both time-to-ready targets, all seven acceptance criteria pass, and the no-win optional-import and in-process candidates were reverted on 2026-10-23.
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

- [x] AC-1 [local]: Bench time to ready p50 ≤ 2500 ms. proof: `node scripts/bench-startup.mjs --runs 10` on a machine with load below 12 — Evidence: 2026-10-23 retained precompiled-extension path, 10 runs; pre-run load 9.77; p50 1422 ms against same-host baseline 1648 ms.
- [x] AC-2 [local]: Bench time to ready p90 ≤ 5000 ms. proof: same run — Evidence: 2026-10-23 retained precompiled-extension path, 10 runs; p90 1448 ms against same-host baseline 1683 ms; both runs began below load 12.
- [x] AC-3 [local]: The wrapper starts one Node process per launch. proof: a test on `scripts/leanpi-local.sh` or `strace -f -e trace=execve` count — Evidence: 2026-10-23, wrapper test red 6 failed / 3 passed → green 9 passed; asserts exactly one wrapper-owned Node invocation.
- [x] AC-4 [local]: No `.ts` extension is transpiled at launch. proof: the `pi_timing` lines of a bench launch list only `.js` extension paths — Evidence: 2026-10-23, 10/10 traced launches had 100 module-import paths and all ended in `.js`; the precompiled sidecars preserved Pi prototype identity, passed the relocated-package check, and improved p50/p90 to 1422/1448 ms.
- [x] AC-5 [local]: `This operation was aborted` has a known cause, and a test pins the fix or the new classification. proof: `corepack pnpm vitest run tests/backends/session-limits.spec.ts tests/cli/session-fallback.spec.ts` — Evidence: 2026-10-23, red 2 failed / 12 passed → green 14 passed. The proven bug was text-only cancellation classification: a provider-boundary `AbortError` with an un-aborted run signal was persisted as `aborted`. The real booted-session test now asserts raw messages and the telemetry sink both retain `error`; explicit `session.abort()` sets the run signal and both report `aborted`. The 25 historical records lack cancellation provenance, so their original Esc/timeout cause remains unknown and their error text alone is not reclassified.
- [x] AC-6 [local]: A quota error falls back to the next model and the turn completes. proof: `corepack pnpm exec vitest run tests/cli/session-fallback.spec.ts` — Evidence: 2026-10-23, real HTTP 429→success first failed with zero fallback requests, then passed; the no-contract native-turn control was also red→green. Final suite: 10 passed, covering 429/402 success, configured role order, direct native turns, repeated refusal (two requests / one notice), exhausted chain and pinned model (one request / no fallback notice). Pi’s pre-settlement boundary continues the original user request without another prompt; raw refusals remain in history, and successful compiled turns persist one completed telemetry row containing both attempts. The notice is emitted only when the continuation starts.
- [x] AC-7 [local]: No regression. proof: `pnpm test`, `pnpm typecheck`, `pnpm lint` — Evidence: 2026-10-23, `corepack pnpm test` passed 172 files / 1151 tests (4 files / 12 tests skipped); `corepack pnpm typecheck` passed; `corepack pnpm lint` exited 0 with existing warnings.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Faster launch | `leanpi` → `scripts/leanpi-local.sh` → `bin/leanpi.js` | current wrapper and spawn path | AC-1 to AC-4 |
| Turn error handling | a turn in a live session → provider error path | current error stop | AC-5, AC-6 |

## Decisions

- 2026-10-22 (planning scope): Keep one completion box per existing phase plus all seven original ACs: 10 boxes total. `prd-audit` counts both kinds against eight; reducing further would remove phase tracking, combine ACs, or split the selected scope. The size finding remains visible; no acceptance requirement is waived.
- 2026-10-23 (startup levers 1–3): Keep the one-Node wrapper and precompiled extension sidecars. Revert lazy imports after p50/p90 regressed; the retained path still meets both targets.
- 2026-10-23 (in-process handover): Keep Pi in a child process. The candidate improved p50 but regressed p90; the retained Phase 1 path now meets both startup targets.

## Execution Phases

#### Phase 1: Startup levers 1–3
**Status:** COMPLETE
**Files:** `scripts/leanpi-local.sh`, `bin/leanpi.js`, `scripts/dev-build.mjs`, `scripts/build-extensions.mjs`, `src/cli/launch.ts`, `src/cli/extension-loader.ts`, `tests/cli/launch.spec.ts`, `tests/cli/local-wrapper.spec.ts`, `tests/cli/precompiled-extensions.spec.ts`
**Implementation:** Apply levers 1–3 individually through the real wrapper. The wrapper also runs a Node version probe (`node -e`) for each candidate before the three Node processes described above; merely combining vendor/build checks leaves that extra boot. Preserve Node ≥22.19 selection, caller cwd/arguments and failure handling. At `src/cli/launch.ts:125`, compiling or bundling extension `.ts` imports must retain the running Pi's class/prototype identity; avoid private copies of Pi/TUI packages that bypass prototype patches. Cover dependency-provided TypeScript as well as local extensions.

1. Launch the wrapper with one Node invocation. Add `tests/cli/local-wrapper.spec.ts` for actual wrapper-owned invocation count, supported/unsupported runtime candidates, stale vendor/build fixtures (AC-3).
2. Launch every default extension as built JavaScript with shared Pi prototypes intact. Extend the shipped-entry-point tests for compact UI/prototype behavior; assert that bench `pi_timing` extension paths contain only `.js` (AC-4). **Disposition (2026-10-23):** kept through build-time sidecars and a Node loader hook that resolves Pi imports to the running CLI's exact module objects; prototype, package-relocation, and startup-trace checks pass.
3. Make optional launcher imports lazy. Extend existing coverage for onboarding/update-check/JEV load paths, informational flags, normal launch behavior.

**State (2026-10-23):** The one-Node wrapper and build-time JavaScript sidecars are retained. Lazy imports were tried alone and reverted after p50/p90 rose from 1601/1674 ms to 1694/1728 ms. The extension-loader hook preserves Pi's class identity across precompiled entries. The qualifying 10-run path measured 1422/1448 ms p50/p90 versus the same-host 1648/1683 ms baseline, with pre-run load 9.77. Phase 1 meets its wrapper, extension, and time-to-ready contracts; lever 3 remains an evidenced revert.

**Measurement / decision:** `bench/out/startup-bench.jsonl` preserves both exact ten-run rows: baseline `c905480` at 2026-10-23T06:50:31.429Z (p50 1695 ms / p90 1773 ms), and combined candidate `36700b3-dirty` at 2026-10-23T06:51:55.747Z (2323 ms / 2918 ms). Both used `joao-cachyos` and Pi 1.4.0. Recorded pre-run load was 4.75 (<12); post-run load was 13.27. The candidate increased p50 by 628 ms and p90 by 1145 ms, so it was reverted; the combined comparison cannot attribute the regression to one lever. The decision is logged in `docs/benchmarks/ux-kpis.md`.

**Isolated wrapper measurement:** `bench/out/startup-bench.jsonl` also records the retained wrapper lever: pre-wrapper 1745/2128 ms p50/p90 at 2026-10-23T07:24:30.263Z, then 1569/1608 ms at 2026-10-23T07:29:12.491Z. Both were ten-run measurements on `joao-cachyos` with Pi 1.4.0; starting load was 3.40 and 4.53 respectively. The wrapper lever reduced p50 by 176 ms (10.1%) and p90 by 520 ms (24.4%), so it was kept. `docs/benchmarks/ux-kpis.md` records the decision.

**Isolated lazy-import measurement:** `bench/out/startup-bench.jsonl` records the same wrapper path before and after lazy imports: 1601/1674 ms → 1694/1728 ms p50/p90, ten runs each on `joao-cachyos` with Pi 1.4.0; starting load was 2.21 and 7.34 (<12). The change increased p50 by 93 ms and p90 by 54 ms, so it was reverted under the no-win rule. The result is in `docs/benchmarks/ux-kpis.md`.

**Built-JavaScript implementation and evidence (2026-10-23):** `scripts/build-extensions.mjs` emits local and dependency extension graphs as package sidecars; `src/cli/extension-loader.ts` maps Pi imports to the exact modules embedded in the running Pi CLI. Build, prototype-identity, package-relocation, and full-suite checks pass. The qualifying 10-run trace matched all 10 launches and 100 module-import paths; every path ended in `.js`. The startup benchmark improved from 1648/1683 ms to 1422/1448 ms at pre-run load 9.77, so the candidate is retained.

**Discarded initial-candidate verification:** the first combined candidate was reverted after its 10-run regression. Its build and package-relocation checks are historical evidence only; the retained sidecar implementation above has its own passing build, runtime, packaging, and benchmark evidence.

- [x] The retained wrapper and precompiled-extension path satisfy the wrapper, identity, and import contracts; the lazy-import experiment is recorded as reverted. proof: `corepack pnpm build`, full `corepack pnpm test`, 10-run `pi_timing` trace (100/100 module imports end in `.js`), and `node scripts/bench-startup.mjs --runs 10` under load 9.77 (AC-3, AC-4).

**Verification:** Use `ux-kpi-loop` before and after each lever; retain comparable bench rows in `bench/out/startup-bench.jsonl` and record keep/revert decisions in `docs/benchmarks/ux-kpis.md`. The focused tests above require behavior-specific red → green for changed behavior, not manufactured failures for unchanged gates.

#### Phase 2: Evaluate Pi in-process (lever 4)
**Status:** COMPLETE
**Files:** `bin/leanpi.js`, `src/cli/launch.ts`, `tests/cli/launch.spec.ts`, `tests/cli/startup-trace.spec.ts`
**Implementation:** After Phase 1, measure whether importing Pi's CLI in the launcher process improves startup without regressing p90. Preserve arguments, environment, cwd, signals, exit status and extension behavior if the candidate is retained.

**State (2026-10-23):** The in-process Pi CLI candidate passed build and 32 focused launch/wrapper tests, but its 10-run p90 regressed 263 ms (1683 to 1946 ms), so it was reverted under the no-regression gate. The retained child-spawn path now meets both startup targets at 1422/1448 ms; further in-process work is not needed for this PRD.

1. Tested Pi's in-process CLI/session lifecycle with real-entry-point coverage for process count, CLI output, signal handling, and exit propagation; the candidate was reverted after p90 regressed.
2. Measured the retained child-spawn path under load below 12; it meets both startup targets.

- [x] The in-process handover was evaluated and reverted under the no-regression gate; the retained startup path meets both time-to-ready targets. proof: `node scripts/bench-startup.mjs --runs 10 --note "after: AC-4 precompiled extensions"` — load 9.77, p50 1422 ms, p90 1448 ms (AC-1, AC-2).

**Verification:** Compare lever 4 with Phase 1 using the same workload/cache conditions and keep/revert log; use the single qualifying ten-run bench for both AC-1 and AC-2.

#### Phase 3: Failed turns (levers 5–6)
**Status:** COMPLETE
**Files:** `src/backends/session-limits.ts:42` (abort classification), `src/index.ts:787,927` (session error/failover path), `tests/backends/session-limits.spec.ts`, `tests/cli/session-fallback.spec.ts`, `tests/helpers/stub-backend.ts`
**Implementation:** Phase 3 is independent of the startup changes. Establish abort provenance from raw records and the reachable cancel/timeout paths before choosing a fix: the shared error string alone cannot prove Esc or timeout. Reuse the configured model order for quota fallback; the existing next-turn routing test does not prove that the failed turn resumes and completes. For either `429 GoUsageLimitError` or `402`, attempt the next configured model at most once and print one explanatory line; repeated quota failure or exhaustion terminates without a retry loop.


**State (2026-10-23):** AC-5 classification and AC-6 same-turn quota continuation are implemented and verified. The focused lifecycle group passed 77 tests across session fallback, classification, recap, extension surface and wiring. Final gates passed: 172 test files / 1151 tests (4 files / 12 tests skipped), typecheck passed, and lint exited 0 with existing warnings. Phase 3 is complete.

1. Resolve the evidenced cause of `This operation was aborted`. Use `pnpm vitest run tests/backends/session-limits.spec.ts tests/cli/session-fallback.spec.ts` red → green: distinct cancel/timeout stimuli through the real reporting path assert the timeout fix or the evidenced operator-cancel classification. Record the attributable cause beside AC-5.
2. Complete the same user turn on the next configured model after a quota error. Extend `tests/cli/session-fallback.spec.ts` with the stub-backed real session path for 429/402 then success; assert a completed response without a second user prompt, plus bounded requests/notices on repeated refusal (AC-6). The focused command above must establish red → green.
3. Run the final regression gates after the startup/turn-error changes: `pnpm test`, `pnpm typecheck`, `pnpm lint` (AC-7).

- [x] Failed-turn handling satisfies the abort/quota contracts above. proof: `pnpm vitest run tests/backends/session-limits.spec.ts tests/cli/session-fallback.spec.ts`, `pnpm test`, `pnpm typecheck`, `pnpm lint` (AC-5, AC-6, AC-7).

**Verification:** Store results on the owning boxes/ACs once; all seven ACs remain required, and implementation and acceptance stay pending until their commands establish the claimed results.

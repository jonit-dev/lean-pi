# PRD-050 — Architecture refactor from 2026-09-22 review

**Status:** DONE
**Progress:** 100% — all phases and acceptance criteria verified.
**Complexity:** 6 (MEDIUM); risk override: completion gating and benchmark join semantics require focused regression proof.
**Source:** `docs/architecture/refactor-suggestions-2026-09-22.md`

## Objective
Implement F1–F8 and close G1–G4 in one isolated worktree, preserving runtime behavior except F4's intentional fail-closed correction. Squash to `main` only after focused and repository-wide checks pass. Preserve unrelated primary-checkout changes.

## Established constraints
- F1/F2/F3 must remove repeated membership, ledger, and telemetry scans without changing ordering or join semantics.
- F4 must reject PASS when sufficiency answers report static-only runtime proof or an unevidenced path.
- F5 removes three unused public exports; inspect repository consumers and document compatibility risk before integration.
- F7 must retain hook registration order and closure state.
- Every code change needs its focused test plus `pnpm test`, `pnpm typecheck`, `pnpm lint`; run `pnpm build` because the report names it as a stack gate.

#### Phase 1: Baseline and low-risk refactors
**Status:** DONE
- [x] Implement F1, F2, F5, F6, F8 with focused checks.
- [x] Add G1 configuration rejection cases and G4 MCP failure cases.

#### Phase 2: Behavioral correctness and data flow
**Status:** DONE
- [x] Add red/green F4 proof tests; correct PASS gating and cover G2. Both new cases returned PASS before the guard and MISSING_PROOF after it; gate and gate-loop suites passed 17/17.
- [x] Add red/green F3 telemetry join test; remove repeated store reads while preserving report semantics. Red: `tests/bench/telemetry-join.spec.ts` failed with 4 `readRuns` calls (3 per-attempt + 1 report) vs expected 0. Green: `src/bench/runner.ts` drains only new store bytes per join (O(total bytes)); focused 23/23 pass; `pnpm typecheck` clean.
- [x] Add G3 clarification path cases. `tests/executor/clarification.spec.ts`: `ask` blocks with `outcome.question`, `proceed` blocks with `outcome.assumption`, both via real `runExecutor` (2/2 pass; new coverage, no lane change).

#### Phase 3: Wiring extraction and integration
**Status:** DONE
- [x] Extract F7 hooks with explicit context and prove event behavior/order. `tests/bootstrap.spec.ts tests/wiring.spec.ts` passed 21/21, including registration order; `pnpm typecheck` passed after extraction.
- [x] Review the whole diff for public API, join, hook, and test-collection risks.
- [x] Pass focused tests, `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` on the final candidate.

## Acceptance criteria
- [x] F1–F8 are implemented with their stated behavior and no unrelated edits.
- [x] G1–G4 have runnable cases covering the specified consequential paths.
- [x] The final candidate passes all required checks and the worktree diff is reviewed.
- [x] The verified result is squashed into `main` without overwriting primary-checkout changes.

## Evidence
Phase 1 (2026-09-23, worktree only, no commit): focused `pnpm vitest run tests/config.spec.ts tests/mcp/client.test.ts` 28/28 pass; `tests/runtime/worktree.test.ts worktree-safety lane/routing/retry/bench harness/adapters/adjudicate/baselines` 75/75 pass; `pnpm typecheck` clean; `pnpm lint` clean (pre-existing warnings only). Review corrections (2026-09-23): focused `pnpm vitest run tests/bench/harness.spec.ts tests/mcp/client.test.ts tests/config.spec.ts` 36/36 pass, covering the F2 interleaved-ledger fold-order assertion, the G4 concurrent `getClient` single-flight case, and the single-loader G1 table loop. F5 compatibility caveat: `spendAttempt`/`spendEscalation`/`CONTINUING_CATEGORIES` had no in-repo callers (rg over repo, only barrel re-exports), but they were public via `src/index.ts` barrel — external importers will break at compile on integration.
Phase 2 (2026-09-23, worktree only, no commit): F3 red/green recorded above; G3 2/2 via real lane entry; focused `pnpm vitest run tests/bench/telemetry-join.spec.ts tests/bench/harness.spec.ts tests/bench/adjudicate.spec.ts tests/bench/report.spec.ts` 23/23 pass plus `tests/executor/retry.spec.ts tests/executor/clarification.spec.ts` with the join spec 13/13 pass; `pnpm typecheck` clean. F4/G2 untouched (commit d1fa298). §52 join exactness, interruption behavior, report output, and missing-record error text preserved; source report unaltered.
Final worktree gates (2026-09-23): F3 edge-case review passed 19/19 focused bench tests; F7 wiring passed 21/21; `pnpm test` 158 files passed, 3 skipped, 1042 tests passed, 11 skipped; `pnpm typecheck` passed; `pnpm lint` exit 0 with warnings; `pnpm build` passed. `git diff --check` passed. F5 removes public barrel exports with no repository consumers; external importers must adapt. Integration to `main` remains the final open criterion.
After rebasing onto `main` 58a5635 (Manual-mode changes), `tests/commands/manual-mode.spec.ts tests/bootstrap.spec.ts tests/wiring.spec.ts` passed 39/39. Combined `pnpm test` passed 158 files / 1058 tests (3 files / 11 tests skipped); `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed. Main's dirty `leanpi.config.yaml` and untracked PRD-047 remain outside this work.
Staged squash verification on `main` (2026-09-23): `pnpm test` passed 158 files / 1058 tests (3 files / 11 tests skipped) with committed config; `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --cached --check` passed. With the unrelated uncommitted config, two existing role-ladder tests fail because `capability.roles.strong.pin: opus` has no ranking entry; the original config was restored byte-for-byte after the clean-config run. The squash includes this PRD closure and preserves that config and untracked PRD-047.

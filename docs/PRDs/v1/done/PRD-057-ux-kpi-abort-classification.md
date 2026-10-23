# PRD-057 — Classify aborted turns correctly in UX KPIs

**Closed:** 2026-10-23; archived to `v1/done/` with the implementation.

**Status:** DONE — 2026-10-23. Every phase and acceptance box verified.
**Priority:** P2 — a real aborted turn is currently counted as an error, skewing the UX KPI buckets.
**Complexity:** 1 (LOW)
**Owner:** Codex
**Depends on:** PRD-055

## Context

`scripts/ux-kpi.mjs:107` retains only the last assistant `stopReason`; an assistant record with `stopReason: "error"` and `errorMessage: "This operation was aborted"` is therefore counted as an error. A real 30-day session contains this combination. Provider failures such as OpenCode Go 429 and upstream 503 errors must remain errors.

## Solution

Normalize the exact abort message to the existing `aborted` bucket before computing rates. Keep other `stopReason: "error"` values unchanged. Do not modify stored session logs.

## Acceptance Criteria

- [x] AC-1 [local]: An abort-shaped assistant record contributes to the abort rate and not the error rate. proof: `corepack pnpm exec vitest run tests/ux-kpi.test.ts` — Evidence: 7 tests passed; production report refreshed with `node scripts/ux-kpi.mjs`.
- [x] AC-2 [local]: A provider error record still contributes to the error rate and not the abort rate. proof: `corepack pnpm exec vitest run tests/ux-kpi.test.ts` — Evidence: regression fixture confirms 429/503 remain errors.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| UX KPI error/abort rates | `node scripts/ux-kpi.mjs` → session JSONL parser → CLI and HTML KPI values | Corrects classification before existing rate calculations; no new path | AC-1, AC-2; live CLI/HTML path refreshed |

## Decisions

- 2026-10-23 (Codex): Normalize only the exact `This operation was aborted` message so quota, network, and other provider errors remain visible in the error KPI.

## Execution Phases

#### Phase 1: Correct abort classification
**Status:** DONE
**Files:** `scripts/ux-kpi.mjs`, `tests/ux-kpi.test.ts`
- [x] Normalize abort-shaped assistant errors and cover both abort and provider-error rates. proof: `corepack pnpm exec vitest run tests/ux-kpi.test.ts` — 7 passed.
**Implementation:** Add the regression fixture before changing the shared session-turn classifier; keep provider errors unchanged.
**Verification:** `corepack pnpm test` — 173 files passed, 4 skipped; 1156 passed, 12 skipped. `corepack pnpm typecheck` — passed. `corepack pnpm lint` — exit 0 with existing warnings. `node scripts/ux-kpi.mjs` refreshed the live report; errors moved 8.1% → 3.1%, aborts 10.7% → 15.7%.

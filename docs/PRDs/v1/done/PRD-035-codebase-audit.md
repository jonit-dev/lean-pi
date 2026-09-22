# PRD-035 — Codebase audit (2026-09-21)

**Status:** DONE
**Complexity:** 0 (LOW; documentation-only)
**Owner:** Codex reviewer with save-tokens OpenCode audit arms
**Baseline:** `40e5507bcf267ce96e9e23e1196a0ea0b70f9e2b` (2026-09-21)
**Checkout:** `/home/joao/projects/lean-pi/.worktrees/audit-codebase` (branch `audit/codebase-2026-09-21`)
**Depends on:** None

## Context
AUDIT-ONLY. Entry points are `bin/leanpi.js` → `src/cli/{bootstrap,launch}.ts` and the Pi extension `activate()` / `createLeanPiSession()` in `src/index.ts`. No source, test, config, lockfile or existing document was edited; no commit, push, PR, production service or real credential was used. Findings are for another lane to fix.

## Solution
Read-only static review plus the smallest runnable probes, the `complexity-optimizer` scanner, a targeted SRP/KISS/DRY pass, an existing-test seam review that maps critical missing coverage to proposed tests, and a cross-check of configured rates against publicly published list prices (2026-09-21; no account/billing access). Baseline gate outcomes are recorded as evidence for the audited commit, not as gates, and do not apply to concurrent uncommitted primary-checkout edits. The report `docs/audits/done/2026-09-21-codebase-audit.md` is the sole verification evidence for this PRD.

## Acceptance Criteria
- [x] AC-1: report written with scope, baseline outcomes, prioritised findings and grouped remainder, each with `file:line` evidence — E1: report A1–A5, T1.
- [x] AC-2: every finding carries severity, confidence, evidence type, trigger path, impact, suggested fix and a regression check — E1: report findings.
- [x] AC-3: links and `#L` anchors validated against the checkout; whitespace checked (content scan plus `git diff --no-index --check` with empty whitespace output) — E1: report "Verification evidence".
- [x] AC-4: PRD moved to `docs/PRDs/v1/done/` with status DONE — E1: this file's final path.
- [x] AC-5: complexity section (stack, scope, ranked issues C1–C2 with `file:line`, input-size variables, current/after complexity, smallest change, risk, checks; asymptotic vs constant-factor distinguished; C1/C2 classified as conditional/optional) — E1: report "Complexity review".
- [x] AC-6: SRP/KISS/DRY audit with concrete findings (occurrences, line anchors, consequence, smallest fix, risk, targeted check) and an explicit no-actionable-violation statement — E1: report "SRP / KISS / DRY review"; prior-report `index.ts`/long-function items merged, not double-counted.
- [x] AC-7: targeted re-verification of the high-severity findings; A5 classified as a conditional unverified-platform risk; S1/S2/S3 qualified in the follow-up section, with S1 left for targeted validation — E1: report "Prior-report follow-ups (qualified)".
- [x] AC-8: cost-accounting audit tracing usage → normalization → persistence → pricing → aggregation → display and routing prediction separately, with a verdict, stage/rate tables, hand-computed vs probe results, and distinct COST-1–COST-5 findings (severity, confidence, evidence, anchors, trigger/impact, minimum fix, regression check); an official-price cross-check (published list rates only, 2026-09-21) is incorporated with peak/off-peak and billing-provenance limits stated as a configured economic valuation, not cash; A4 referenced, not double-counted — E1: report "Cost accounting audit" and "Official-price cross-check".
- [x] AC-9: critical test coverage and value-chain plan integrated with a confidence-rated coverage map (C/M/G/L per seam) and a set of **proposed** scenarios (8 deterministic + a native entry-point variant + 1 optional live lane; TEST-9 folded into TEST-2), each with one concrete location, a matching command, and its expected initial outcome (TEST-1/4/5/6/8 expected red on the audited defects, the cost findings' failures included; TEST-2/2N/3 unverified); tests are marked PROPOSED and not run, and no coverage percentage is claimed — E1: report "Critical test coverage and value-chain test plan".

## Integration Ledger
Integration: unchanged — documentation-only audit.

## Execution Phases
#### Phase 1: Audit and report
**Status:** DONE
**ACs:** AC-1, AC-2, AC-3, AC-4
**Files:** `docs/audits/done/2026-09-21-codebase-audit.md` (new); this PRD (new, moved to `done/`).

#### Phase 2: Complexity, SRP/KISS/DRY, follow-up review
**Status:** DONE
**ACs:** AC-5, AC-6, AC-7
**Files:** `docs/audits/done/2026-09-21-codebase-audit.md`; this PRD.

#### Phase 3: Cost-accounting audit
**Status:** DONE
**ACs:** AC-8
**Files:** `docs/audits/done/2026-09-21-codebase-audit.md`; this PRD. Findings COST-1–COST-4 appended; report front summary, top-five and fix order updated. Scope is the committed snapshot `40e5507`; concurrent uncommitted primary-checkout edits were excluded and not read.

#### Phase 4: Test-gap map, value-chain plan, price cross-check, integration
**Status:** DONE
**ACs:** AC-8, AC-9
**Files:** `docs/audits/done/2026-09-21-codebase-audit.md`; this PRD. Report front synthesised (assessment, ≤5 priorities, jump links); official-price cross-check and COST-5 added to the cost audit; the critical test-coverage/value-chain plan appended with proposed-only scenarios; PRD scope/ACs updated. No source, test, config or lockfile changed.

## Cleanup
Both audit-owned checkouts were removed after arm exit, process/data checks and delivery of both documents to the primary checkout: `/home/joao/projects/lean-pi/.worktrees/audit-codebase` and `/home/joao/projects/lean-pi/.worktrees/audit-value-chain`. Git registrations and directories are confirmed absent. The audit checkout contained only disposable installed dependencies, build output and empty test-state directories; the test-review checkout was clean. Existing task worktrees and concurrent primary source edits were preserved.

# PRD-028 — Production-Readiness Audit of LeanPi (harness, benchmarks, cost claims)

**Status:** DONE (audit deliverable complete; fresh 4×2 qualification blocked / not demonstrated — archived as a completed audit, not a production qualification)
**Complexity:** 1 (LOW)
**Owner:** audit lane (branch `audit/production-readiness`)
**Depends on:** None
**Lane:** single isolated worktree `.worktrees/production-readiness-audit`; no subagents.
**Cleanup:** worktree ~245MB retained pending delivery/cleanup authorization; no PR was requested or created; primary checkout never modified.
Root `bench/out/omp-vs-leanpi-2-leanpi/workspaces/` (untracked, primary) is preserved read-only.

## Context

LeanPi advertises cost savings and a benchmark harness (`README.md:22-53`,
`docs/benchmarks/2026-09-19-leanpi-vs-omp.md`). This audit independently assesses
harness usability, usefulness, the claimed cost savings, defects, and the
available real-session corpus, then refreshes or re-folds the benchmark from
evidence. It is a read-and-report pass over an existing product; it does not
author product implementation. Prior audits exist
(`docs/reports/BUG_REVIEW.md`, `docs/reports/architecture-wiring-audit-2026-09-19.md`)
and are cited, not duplicated. `PRD-027` is owned by another workstream and must
not be reused.

Known claim surface (to verify, not restate):
- README `:29-36`: 4/4 solve both arms; `$0.0129` vs `$0.0274` per verified
  success (0.47); wall `373.6 s` vs `678.3 s` (0.55); input `94,862` vs
  `310,003`; output `41,805` vs `66,968`; tools `119` vs `169`.
- Rate card `leanpi.config.yaml:21-24` (`$0.15/$0.60/$0.003` per Mtok) and
  `jev.usd_per_mtok: 0.042` (`:47-48`).
- ROADMAP `:98-110` targets (≥90–95% solve, ≤25% cost, stretch ≤10%).

## Solution

Write one self-contained report `docs/audits/production-readiness-audit.md` whose
every number points at a ledger or a `file:line`. Where a benchmark refresh is
authorized and credentials are present, re-fold existing runs first
(`bench --recompute`), then run the `validated` suite for both arms; otherwise
record the refresh as blocked and report the folded existing evidence.

Sensitivity rule: never print credential values or session prompt bodies. Record
credentials by presence only.

## Scope correction (user clarification, 2026-09-19)

This is a **public harness in early alpha**. The audit assesses a *usable public
alpha*, not enterprise/GA perfection. Consequential findings are: core
correctness, reproducibility, money/accounting errors, failed installs, silent
task failures and data loss. Polish and sample-suite expansion are follow-up,
not arbitrary blockers. No product code fixes unless one is required to make the
benchmark measurement honest; product bugs are documented with the smallest
reproducer. A bare unset `OPENCODE_API_KEY` does **not** by itself prove live
access unavailable: the documented config auth resolution and existing
opencode/omp auth are inspected by provider/key *presence* only, and a supported
already-authenticated route is used if one exists (never repurposing
credentials).

## Deliverables

1. `docs/audits/production-readiness-audit.md` — honest report with evidence and
   candid scope limits.
2. Updated benchmark statement in `docs/benchmarks/2026-09-19-leanpi-vs-omp.md`
   / README **only if** current evidence supports a changed statement; otherwise
   left as is with the reason recorded.
3. A refreshed benchmark when live prerequisites are accessible: one fresh 4×2
   pair (or one matched preflight task if that is all that fits), in a distinct
   audit-prefixed run directory. **Result: partial** — omp 4/4 fresh; LeanPi two
   recorded `express` attempts (both `incomplete`) then an interrupted `flask`
   attempt with unknown spend. The fresh 4×2 qualification is recorded as blocked
   / not demonstrated. Raw telemetry, ledgers and the machine-readable
   `bench/out/audit-028-summary.json` are retained.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: Report `docs/audits/production-readiness-audit.md` exists with sections: claims ledger, harness usability, benchmark methodology, cost model, session corpus, risks, recommendations — Evidence: report written, §1–§8.
- [x] AC-2 [local; actor: agent]: Every savings claim in README/report is listed with its supporting artifact path and the metric that confirms or contradicts it — Evidence: §1 claims ledger, each row names its `bench/out/omp-vs-leanpi-1-*` artifact.
- [x] AC-3 [local; actor: agent]: Harness usability verified by running `node dist/bench/lane.js --list` (build first) and recording commands that work vs fail — Evidence: §2, `--list` exit 0; `--recompute` and `--configs` recorded.
- [x] AC-4 [local; actor: agent]: Existing runs re-folded with `bench --recompute` in a distinct audit run directory and the folded totals reconcile with published numbers, or the discrepancy is documented — Evidence: `bench/out/audit-028-recompute/recompute-{leanpi,omp}.md`; totals `$0.012900`/`$0.027356` match.
- [x] AC-5 [local; actor: agent]: Benchmark refresh status is recorded truthfully — Evidence: §5; both arms authenticated and a fresh matched pair run; omp 4/4 fresh, LeanPi one recorded attempt then interrupted with unknown spend. Fresh 4×2 marked **blocked / not demonstrated**; no fake success.
- [x] AC-6 [local; actor: agent]: Session corpus analyzed (not merely inventoried) — Evidence: §4; seven lean-pi `cwd` sessions aggregated without titles (tool counts, cache, errors); missing native LeanPi fields explained (collector never fed + empty native corpus).
- [x] AC-7 [local; actor: agent]: Top risks each carry `file:line` and a falsifiable check; pricing rate card checked against current official sources — Evidence: §3 S1–S3 + follow-ups; §1 cites opencode.ai/docs/go and api-docs.deepseek.com with off-peak/peak and subscription caveat.
- [x] AC-8 [local; actor: agent]: `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build` run once each and results recorded verbatim — Evidence: §2; 518/1/7, typecheck 0, lint 0, build 0.
- [x] AC-9 [local; actor: agent]: Clean-package consumer smoke — Evidence: §2; `npm pack --dry-run` 712 files, temp install, `import('leanpi')` succeeds, and the documented Pi extension entry `node_modules/.bin/pi --help` exits 0 on Node 22.
- [x] AC-10 [local; actor: agent]: Benchmark cost accounting corrected where Pi's inclusive `output`/`reasoning` semantics double-charged, with a regression — Evidence: `src/bench/adapters.ts:115-125`, `tests/bench/adapters.spec.ts`; published rows unaffected (reasoning=0), fresh LeanPi rows re-derived in `bench/out/audit-028-summary.json`.

## Integration Ledger

Integration: unchanged — documentation/audit only; no runtime behavior is added or rewired.

## Execution Phases

#### Phase 1: Fold and reconcile existing benchmark evidence
**Status:** DONE
**ACs:** AC-2, AC-3, AC-4, AC-6, AC-8, AC-9
**Files:** `docs/audits/production-readiness-audit.md` (new)
**Implementation:** install locked deps; run test/typecheck/lint/build once; smoke the built public entrypoint and inspect package contents; read the `bench/out/*/report.json` + `telemetry.jsonl`, reconcile each README/report figure to a ledger row, analyze the LeanPi-relevant session corpus.
**Verification:** E1 — `pnpm test && pnpm typecheck && pnpm lint && pnpm build`; E2 — `node dist/bench/lane.js --list` and `--recompute` into a fresh audit run dir; E3 — clean-package CLI smoke.
**Checkpoint:** done

#### Phase 2: Harness and risk audit
**Status:** DONE
**ACs:** AC-1, AC-3, AC-7
**Files:** `docs/audits/production-readiness-audit.md`
**Implementation:** trace CLI→planner/router→executor/tools→session/telemetry; probe 3–5 real failure modes with safe temporary fixtures (persistence/resume, cancellation/timeouts, provider failures, cost accounting incl. cache/call omissions, file edits/tool safety); record risks with `file:line`; check rate card against official pricing.
**Verification:** E1 — each risk reproduces with the recorded command/fixture.
**Checkpoint:** done

#### Phase 3: Benchmark refresh (evidence-gated) and report finalize
**Status:** DONE — audit complete; fresh 4×2 **blocked / not demonstrated** (omp 4/4 fresh; LeanPi two `express` attempts recorded then `flask` interrupted — see report §5)
**ACs:** AC-5, AC-10, AC-1
**Files:** `docs/audits/production-readiness-audit.md`, `bench/out/audit-028-summary.json`
**Implementation:** determine the exact supported live command and auth presence; run one matched preflight then the remaining validated tasks, bounded; otherwise record the exact failure. Finalize the report.
**Verification:** E1 (gated, partial) — audit-prefixed run dirs with paired attempts where they exist; `--recompute` reproduces published totals.
**Checkpoint:** done (partial evidence recorded; not a production qualification)

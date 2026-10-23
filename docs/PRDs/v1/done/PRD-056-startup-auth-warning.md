# PRD-056 — Defer the startup auth warning probe

**Closed:** 2026-10-23 at `a955e29`, archived to `done/`.

**Status:** DONE — 2026-10-23. Every phase and acceptance box verified.
**Priority:** P2 — time-to-ready p90 is 6,465 ms against the 5,000 ms target.
**Complexity:** 1 (LOW); risk is warning timing and print-mode delivery.
**Depends on:** PRD-055

## Problem

The launcher synchronously runs Pi's auth readiness check only to decide whether to print an unusable-backend warning. A CPU profile measured about 200 ms in that child process before Pi starts. Existing-config selection does not depend on this warning check.

## Scope

Move only the warning check after the `editor-painted` readiness marker. Keep first-run provider selection, Pi's exact `auth check --no-refresh` semantics, launch exit behavior, and warning delivery in both interactive and `--print` sessions.

## Plan

#### Phase 1: Defer the warning probe and verify delivery
**Status:** COMPLETE
- [x] Keep auth/config selection unchanged and preserve the warning for interactive and `--print` launches. proof: focused launcher/session tests plus `corepack pnpm typecheck` and `corepack pnpm lint` — Evidence: focused regression was red before the change and green after (69 focused tests); full suite 1,155 passed/12 skipped; typecheck clean; lint exit 0 with existing warnings.
- [x] Retain the candidate only if a matched 10-run benchmark improves time-to-ready p50 by more than 10% and does not worsen p90; otherwise revert and record the rejected result. proof: `node scripts/bench-startup.mjs --runs 10` and `docs/benchmarks/ux-kpis.md` — Evidence: same-host baseline 947/982 ms → 785/809 ms; p50 fell 17.1%, p90 17.6%; candidate kept and logged.

## Acceptance criteria

- [x] A retained candidate preserves auth-check semantics and warning delivery while passing the matched p50/p90 gate. proof: focused tests, `corepack pnpm test`, `corepack pnpm typecheck`, `corepack pnpm lint`, and the 10-run benchmark row — Evidence: same Pi auth command and `ready` result retained; interactive and `--print` warning paths pass; full suite 1,155 passed/12 skipped; p50/p90 gate passed at 785/809 ms.

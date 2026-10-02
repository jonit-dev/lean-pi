# PRD-054 — Release gates that run Auto on real config shapes

**Status:** IN PROGRESS
**Complexity:** 2 (LOW)
**Owner:** Joao
**Depends on:** PRD-053 (and its AC-1 revert, PR #12)

## Context

v0.1.10 shipped with 1121 green tests and still broke every normal Auto turn on the operator's machine: their global config binds `balanced` to a vendor CLI (`claude/opus[1m]`) beside a native `opencode-go/deepseek-v4.1-flash`, and the binding-first change sent each MEDIUM turn to a headless `claude -p` that shows nothing until done. No gate ran Auto on a real config shape, and nothing ran the built binary live before `npm publish`. Operator, 2026-10-02: "harden our gates … make sure this doesn't happen anymore … pre release CI or local scripts, whatever you want".

## Solution

Two gates, each catching a distinct failure:

- **G1 — CI, every PR (`pnpm test`):** golden config fixtures (`tests/fixtures/configs/`: the onboarding-written config and the operator's 2026-09-22 config) loaded from disk as the user's global file into a real session; a LOW, a MEDIUM and a HIGH message each assert the provider/model Pi's loop runs. A routing change that moves a normal turn off the native model fails CI.
- **G2 — local pre-release (`prepublishOnly`, on by default):** `scripts/release-smoke.mjs` runs the built `bin/leanpi.js -p --mode json` with this machine's real config on a prompt that needs a tool, and fails unless a model answers, a tool call streams through Pi's loop, and the first model event lands within a bound. A silent headless-CLI turn emits no tool event and fails it. `LEANPI_SMOKE=0` skips it with a loud notice (CI has no credentials).

## Acceptance Criteria

- [ ] AC-1 [local]: On both golden configs, LOW and MEDIUM Auto turns run native `opencode-go/deepseek-v4.1-flash` with zero CLI calls; HIGH runs the configured strong CLI model. Red on v0.1.10's `roles.ts`. proof: `pnpm vitest run tests/routing/golden-configs.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: The release smoke passes on the fixed build and fails on v0.1.10 with this machine's real config. proof: `node scripts/release-smoke.mjs` — Evidence: pending.
- [ ] AC-3 [local]: `prepublishOnly` runs the smoke; full gate green. proof: `pnpm test && pnpm typecheck && pnpm lint` — Evidence: pending.

## Execution Phases

#### Phase 1: CI golden-config routing matrix
**Status:** NOT STARTED
**Files:** `tests/fixtures/configs/*.yaml`, `tests/routing/golden-configs.spec.ts`
**Verification:** AC-1.

#### Phase 2: Live pre-release smoke
**Status:** NOT STARTED
**Files:** `scripts/release-smoke.mjs`, `package.json`
**Verification:** AC-2, AC-3.

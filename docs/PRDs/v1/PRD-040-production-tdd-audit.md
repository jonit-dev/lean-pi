# PRD-040 — Production TDD audit and hardening

**Status:** NOT STARTED
**Complexity:** 5 (HIGH) — 11+ implementation files (3), subprocess lifecycle/state (2). Risk override: HIGH (trust/security and cost-accounting paths); existing provider and packaging boundaries are retained.
**Owner:** tdd-self-improvement lane (agent). Base revision `dd39d063f5041ce1f94d1641d1a66c7d56f631b7`, branch `fix/tdd-self-improvement`, worktree `/home/joao/projects/lean-pi/.worktrees/tdd-self-improvement`.
**Depends on:** None (PRD-039 is reserved by another lane; this is the next free id).
**Cleanup:** worktree reusable only by its owning lane; remove after this PRD closes and the PR merges (verify merge evidence, tracked/untracked/ignored data, then delete the exact path).
**No new self-improvement feature.** This PRD audits and hardens features that already exist; it adds no product capability.

## Context

LeanPi is a Pi extension (~36k LOC `src/`, ~24k LOC `tests/`, 121 test files) claiming cost-aware task compilation, progressive capability disclosure, multi-model routing, executor/reviewer lanes, and evidence-driven completion. The user goal is production readiness: inspect **each** feature, fix real bugs through observed red→green tests, and add meaningful missing coverage — not new features.

Prior audits exist and were read (not re-run): `docs/audits/2026-09-21-codebase-audit.md`, `docs/audits/production-readiness-audit.md`, `docs/reports/code-quality-report-2026-09-21.md`, `docs/reports/BUG_REVIEW.md`, `docs/benchmarks/2026-09-21-four-way-harness-cost.md`. Against this base, several of their core findings are already fixed and have tests: A1 change set from worktree state (`tests/executor/change-set.spec.ts`), A2 corrupt PRD store (`tests/prd/state.spec.ts:40`), A3 native `apiKey` resolution (`apiKeyFor` at `src/backends/native.ts:113`), A4/COST-1 JEV + top-level `cost:` round-trip (`tests/telemetry/cost.spec.ts:226`), T1 untrusted config cannot supply `backends`/`verify` (`tests/permissions/trust.spec.ts:84`). Candidate findings that remain open at this base are listed in Phase 1 and must be independently reproduced, not assumed.

### Feature inventory (5 domains)

| Domain | Features | Primary files |
|---|---|---|
| 1. Compile & route | Task scout, task compiler/classifier, execution contract + pins, PRD-required gate, JEV client/credentials/privacy/fallback, role allocation, model capability index, routing/cost/calibration, exploration governor, context engine | `src/scout/`, `src/compiler/`, `src/jev/`, `src/capability/`, `src/routing/`, `src/exploration/`, `src/context/` |
| 2. Execute & verify | Executor lane (retry, escalation, change-set), backend registry, native Pi-loop worker, external-harness worker, subscription detection, deterministic verification, runtime/browser verifiers, proof gate + recovery, reviewer lane + gate, goal engine, todo list, PRD lane, worktree isolation, RTK | `src/executor/`, `src/backends/`, `src/verify/`, `src/runtime/`, `src/proof/`, `src/review/`, `src/goal/`, `src/todo/`, `src/prd/`, `src/rtk/` |
| 3. Capability disclosure | Skill registry + bundled pack + sync integrity, lexical/semantic skill selection, MCP catalog/client/select/router, LSP detect/client/provider/tools, capability providers/feed/match/select | `src/skills/`, `src/capabilities/`, `src/mcp/`, `src/lsp/`, `src/capability/` |
| 4. CLI & session surface | Launcher/bootstrap/first-run detection/allocation, config discovery + env, command registry + bridge, `/help /status /model /route /context /compact-refs /config /doctor /recap /todo /goal /review /verify /prd /jev /skills /mcp /cost /permissions /thinking-fold`, statusline/todo/recap widgets, spinner, outcome, thinking-fold, UI settings | `bin/leanpi.js`, `src/cli/`, `src/commands/`, `src/index.ts`, `src/leanpi.ts`, `src/recap/` |
| 5. Trust, telemetry, bench, packaging | Permission engine/guard/rules/trust/secrets/state, cost telemetry collect→record→store→pricing→aggregate→display, bench harness + pre-publish cost gate, packaging (`bin`,`files`,`exports`), scripts, CI | `src/permissions/`, `src/telemetry/`, `src/bench/`, `bench/`, `scripts/`, `package.json`, `.github/workflows/` |

### Verified baseline (this worktree, base `dd39d063`, no source changes)

| Gate | Command | Result |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | exit 0, 224 reused, 0 downloaded |
| Build | `pnpm build` | exit 0 |
| Test before build | `pnpm test` | exit 1 — 2 files / 8 tests failed (`tests/cli/launch.spec.ts`, `tests/commands/thinking-fold.spec.ts`), 710 passed, 10 skipped. Cause: `dist/` absent; CI builds first |
| Test after build | `pnpm test` | exit 0 — 119 files passed / 2 skipped; 718 passed, 10 skipped, ~25 s |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 — warnings only (~36), 0 errors |
| GitHub auth | `gh auth status` | logged in `jonit-dev`, scopes `repo`,`workflow` (read-only use for the eventual draft PR) |

Logs are in `/tmp/leanpi-tdd-baseline/` (not tracked). The base worktree was clean; `node_modules/` and `dist/` are gitignored.

### Candidate findings to reproduce (pending, not asserted)

These are carried from the prior audits and are **pending independent reproduction** at this base; the audit phases decide each as confirmed / already-correct / rejected.

| ID | Candidate | Location | Repro idea |
|---|---|---|---|
| C-COST2 | Native worker drops cache-write tokens; no persisted slot | `src/backends/native.ts:200-204`, `src/backends/worker.ts:119-124`, `src/telemetry/record.ts` | Feed native stats with `cacheWrite > 0`; assert charge/record representation. Pi-loop path already carries it (`tests/telemetry/cost.spec.ts:139`) |
| C-COST3 | Aggregate `/cost` prints `$0` for subscription/local runs without naming volume or unmeasured calls | `src/telemetry/cost.ts:57-77`, `src/telemetry/aggregate.ts:44-46` | `renderCostReport` over subscription-only run; `byBilling` computed but unrendered |
| C-COST4 | Negative monetary rates load and price negative; out-of-range cached fraction unbounded | `src/telemetry/pricing.ts:54-56`, `src/core/config.ts:155-160`, `src/routing/config.ts:58` | Reproduced this pass: config `cost.models.m.input:-3` loads, `priceCall` = `-0.003` |
| C-COST5 | No rate time-of-day / billing-source provenance; peak run valued off-peak | `src/telemetry/pricing.ts:95-152`, `src/backends/registry.ts:61-64` | Static trace: pricing never reads record `timestamp`; `billingOf` classifies by process type |
| C-S1 | Verifier `{{scope}}` interpolated unquoted into `shell: true` | `src/verify/descriptors.ts:113-120`, `src/verify/run.ts:28` | Scope `"tests/a b.test.ts"` → `npx vitest run tests/a b.test.ts`; metacharacters reach the shell |
| C-S2 | Verifier/harness children inherit full `process.env`; `execute` tool uses allowlisted `childEnv` | `src/verify/run.ts:28`, `src/backends/harness.ts:302-307` vs `src/permissions/guard.ts:213`, `src/permissions/secrets.ts` doc | Decide/enforce policy; the harness passthrough is deliberate for credential auth, the verifier is not documented as such |
| C-A5 | `onPath` splits PATH on `:` and ignores `PATHEXT` (Windows) | `src/backends/subscriptions.ts:57-61` | Windows-only; low confidence, unverified platform |

### Highest-risk coverage gaps (from the audit's coverage map, re-checked against this base)

- **No value-chain E2E through an entry point.** `tests/e2e/` does not exist. Every stage (compiler, executor lane, real worker, verify, review, proof, telemetry) is covered individually, but no test joins them through `createLeanPiSession().runTurn()` or the `activate()` input hook with a real worker subprocess. Negative controls (failing verifier / rejecting review / missing proof must not succeed) are likewise absent at that boundary.
- **Native interactive entry point** (`before_agent_start`/`agent_end`) record + cost is untested; `tests/cost-wiring.spec.ts` exercises the native **library** path only.
- **Cost-surface honesty** (C-COST2/3/4/5) has no test; the cost fixture injects rates onto the config object in places.
- **Packaging/consumer path** (published `files`/`exports`, `npm pack` contents) has no standing test after the audit snapshot.

## Solution

Three bounded audit investigations (Phase 1), then TDD fixes for what each confirms (Phases 2–3), then the missing value-chain coverage (Phase 4), then the full gates, packaging smoke, and honest production-readiness limitations (Phase 5). Every fix is red→green with the red observed on the pre-fix revision. Read-only investigations may run alongside one implementation arm in this checkout. Evidence stays in this PRD and the existing audit, not separate reports. No live provider, subscription, billing or credential call is made.

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: Full feature audit complete — each of the 5 domains traced through its real consumer entry point, with a findings ledger naming `file:line`, severity, reproduction, and coverage verdict for every candidate; nothing asserted without a repro or an explicit `pending`. — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: Every candidate and named finding in `docs/audits/2026-09-21-codebase-audit.md` is dispositioned as confirmed-and-fixed, already-correct-with-regression-test, or an explicit limitation/deferred nonessential change with rationale. Move the resolved audit to `docs/audits/done/2026-09-21-codebase-audit.md`, preserving valid relative links and updating references. — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: Cost surface is honest: configured `jev.usd_per_mtok` and top-level `cost:` round-trip; invalid monetary rates and out-of-range cached fractions fail load with a named config error (a legitimate `0` still loads); native cache-write usage is captured and representable; the aggregate report names subscription/local volume and unmeasured metered calls instead of presenting unknown as `$0`. — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: Security/trust boundaries verified: a verifier scope containing a space runs as one argument (no shell splitting/injection); the verifier/harness environment policy is either enforced to the `childEnv` allowlist or documented as a deliberate credential passthrough with a test pinning the intent; an untrusted project config cannot supply an executable backend or shell verifier. — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: Missing value-chain coverage added: one entry-point E2E (`createLeanPiSession().runTurn()` or the `activate()` input hook) drives compiler → executor lane → **real worker subprocess** → real verifier → review → proof → telemetry over a temporary git repo, with negative controls proving a failing verifier, a rejecting review, or missing/stale proof cannot yield success; a native interactive variant asserts the `agent_end` record and cost without claiming the gate chain runs there. No internal lane/worker/reviewer function is stubbed. — Evidence: pending.
- [ ] AC-7 [local; actor: agent]: A real hanging worker subprocess and descendant are reaped through the supported lane timeout path, with a blocked result and bounded failed invocation count (audit TEST-7). — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: Production gates green on the finishing revision: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`; packaging smoke (`npm pack` contains `bin/`, `dist/`, `skills/`, `themes/`, `vendor/`, `src/capability/models.json`); production-readiness limitations stated explicitly (Windows unverified, no live vendor/provider/subscription qualification, cost figures are configured valuations not cash, native path does not run the automatic gate chain). PRD moved to `docs/PRDs/v1/done/` in the finishing commit. — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Value-chain guarantee | `createLeanPiSession().runTurn()`; `activate()` `input` hook | New test only; no production path replaced | AC-5 |
| Cost config/rate policy | `loadConfig` → `resolveCostConfig` → `priceCall`/`priceRun` → `renderCostReport`; `/cost` | Incumbent path retained; validation/labels added where confirmed | AC-3 |
| Verifier command construction | compiled contract → `verifyTask` → `execShell` | Incumbent path retained; argument handling corrected | AC-4 |
| Untrusted project config | `loadConfig` → `assertTrusted`/`surfaceFiles` | Incumbent path retained | AC-4 |
| Native cache-write accounting | `runNative` → invocation → run record → `/cost` | Extends persisted shape only if C-COST2 is confirmed | AC-3 |

## Execution Phases

#### Phase 1: Read-only feature audit and findings ledger
**Status:** NOT STARTED
**ACs:** AC-1
- [ ] P1-A: Brief A gate-chain/executor audit complete with a findings ledger — Evidence: pending.
- [ ] P1-B: Brief B trust/config/money audit complete with a findings ledger — Evidence: pending.
- [ ] P1-C: Brief C surface/disclosure/packaging audit complete with a findings ledger — Evidence: pending.
**Files:** none edited. Three independent read-only briefs:
- **Brief A — gate chain & executor/worker edge:** `src/compiler/`, `src/executor/`, `src/backends/`, `src/verify/`, `src/runtime/`, `src/proof/`, `src/review/`, `src/goal/`, `src/todo/`, `src/prd/`, `src/rtk/`, `src/exploration/`. Verify change-set derivation (`src/backends/native.ts:90-92`, `changedFilesSince`), retry/escalation effects, timeout/abort reaping, gate short-circuits.
- **Brief B — trust, config, money, persistence:** `src/permissions/`, `src/core/config.ts`, `src/telemetry/`, `src/routing/cost.ts`, `src/routing/config.ts`, `src/jev/`, PRD/goal/todo state stores. Reproduce every C-COST* / C-S* / C-A5 candidate; check untrusted-config and secret handling.
- **Brief C — surface, disclosure, packaging:** `bin/leanpi.js`, `src/cli/`, `src/commands/`, `src/index.ts`, `src/skills/`, `src/capabilities/`, `src/mcp/`, `src/lsp/`, `src/context/`, `src/recap/`, `package.json`, `.github/workflows/`, README claims vs behavior.
**Implementation:** Each brief produces a findings ledger (id, feature, `file:line`, severity, repro command/probe, coverage verdict). Existing tests are read, never re-run for the audit; candidate findings are reproduced or marked `pending`.
**Verification:** E1 — each ledger entry carries a deterministic probe or `file:line` trace; every candidate above has a stated disposition. No production or test file edited in this phase.
**Checkpoint:** pending

#### Phase 2: Cost-surface fixes red→green
**Status:** NOT STARTED
**ACs:** AC-2, AC-3
- [ ] P2: Every confirmed cost-surface candidate dispositioned and fixed, or recorded as a limitation, with red→green evidence — Evidence: pending.
**Files:** `src/telemetry/pricing.ts`, `src/telemetry/cost.ts`, `src/core/config.ts`, `src/routing/config.ts`, `src/backends/native.ts`, `src/backends/worker.ts`, `src/telemetry/record.ts` (only those confirmed in Phase 1 / Brief B).
**Implementation:** For each confirmed C-COST item: write the failing test first (red), then the minimum fix. Validation errors are named (`cost.models.<m>.input`), legitimate `0` preserved; native cache-write carried through invocation → record; aggregate report labels subscription/local/unmeasured.
**Verification:** E2 — `pnpm vitest run tests/telemetry/cost.spec.ts tests/routing/config.spec.ts tests/backends/native.spec.ts`; each fix shows the red on the pre-fix revision and green after; no lockfile change.
**Checkpoint:** pending

#### Phase 3: Trust and verifier-boundary fixes red→green
**Status:** NOT STARTED
**ACs:** AC-2, AC-4
- [ ] P3: Confirmed verifier/trust boundary defects fixed (or policy documented and pinned), red→green — Evidence: pending.
**Files:** `src/verify/descriptors.ts`, `src/verify/run.ts`, `src/backends/harness.ts`, `src/permissions/guard.ts`, `src/permissions/secrets.ts`, `src/permissions/trust.ts` (only those confirmed in Brief A/B).
**Implementation:** Quote/split the targeted scope so a path with a space is one argument; decide and pin the verifier/harness env policy (enforce allowlist or document passthrough with a test); keep untrusted-config containment. Do not weaken a security control to gain a green.
**Verification:** E3 — `pnpm vitest run tests/verify/select.test.ts tests/permissions/trust.spec.ts` plus the new boundary test; red before, green after.
**Checkpoint:** pending

#### Phase 4: Value-chain E2E coverage
**Status:** NOT STARTED
**ACs:** AC-5, AC-7
- [ ] P4: Entry-point value-chain E2E plus negative controls, and the native-entry variant, pass — Evidence: pending.
**Files:** new `tests/e2e/value-chain.spec.ts`, new `tests/e2e/native-entry.spec.ts`, a focused executor timeout test (or the narrowest files that satisfy the guarantees); existing transport fixtures only (`tests/backends/helpers.ts`, stub HTTP provider) — no internal lane/worker/reviewer stub.
**Implementation:** Temporary git repo; config binding `quick`/`balanced`/`strong` to one `external_harness` backend whose `command` is the existing stub CLI; real verifier command; real review verdict. Assertions: file on disk persists; pre-existing user edit preserved and not attributed; proof `PASS` only for a genuinely evidenced criterion; exactly one telemetry row read back by `readRuns`; negative controls (failing verifier, `FIX_REQUIRED`, missing/stale proof) cannot yield success. Native variant asserts `agent_end` record/cost and explicitly asserts the gate chain does **not** run on the native path.
**Verification:** E4 — `pnpm vitest run tests/e2e/value-chain.spec.ts tests/e2e/native-entry.spec.ts`; negative controls fail as designed; no vacuous PASS.
**Checkpoint:** pending

#### Phase 5: Production gates, packaging smoke, limitations, closure
**Status:** NOT STARTED
**ACs:** AC-6
- [ ] P5: All gates green, packaging smoke recorded, limitations stated, PRD closed into `done/` — Evidence: pending.
**Files:** `docs/PRDs/v1/PRD-040-production-tdd-audit.md` → `docs/PRDs/v1/done/`; `docs/PRDs/v1/INDEX.md` if the index is hand-consistent; `.github/workflows/ci.yml` only if a gate is missing.
**Implementation:** Run the required broader gates once, add the packaging smoke assertion, record honest limitations, reconcile evidence boxes, and close the PRD in the finishing commit (no merge required to close; the draft PR is opened separately).
**Verification:** E5 — `pnpm build && pnpm test && pnpm typecheck && pnpm lint` all exit 0; `npm pack --dry-run` lists the packaged surface; PRD present under `done/`.
**Checkpoint:** pending

## Required gates

`pnpm build && pnpm test && pnpm typecheck && pnpm lint` (build first: `tests/cli/launch.spec.ts` and `tests/commands/thinking-fold.spec.ts` assert `dist/` exists). Never change the lockfile to obtain a green run; warnings are tolerated, errors are not.

## Production-readiness limitations (not to be invented away)

- No live vendor CLI, provider, subscription or billing call is in scope; the existing `describe.skipIf` live lanes remain owner-gated and are not correctness blockers.
- Cost figures are post-run **configured economic valuations**, not cash invoices; included-allowance vs paid-overflow and peak/off-peak provenance are only asserted if Phase 1 confirms and Phase 2 implements them.
- Windows behavior is untested unless Phase 1 establishes Windows as a supported target; CI is Ubuntu-only.
- The native Pi-loop path does not run the automatic executor/verify/review/proof chain; the E2E and native-entry tests state this rather than implying parity.

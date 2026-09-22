# PRD-040 — Production TDD audit and hardening

**Closed:** 2026-09-22 in the finishing repair commit, archived to `done/`.

**Status:** DONE — 2026-09-22. Every phase and acceptance box verified.
**Complexity:** 5 (HIGH) — 11+ implementation files (3), subprocess lifecycle/state (2). Risk override: HIGH (trust/security and cost-accounting paths); existing provider and packaging boundaries are retained.
**Owner:** tdd-self-improvement lane (agent). Base revision `dd39d063f5041ce1f94d1641d1a66c7d56f631b7`, branch `fix/tdd-self-improvement`, worktree `/home/joao/projects/lean-pi/.worktrees/tdd-self-improvement`.
**Depends on:** None (PRD-039 is reserved by another lane; this is the next free id).
**Cleanup:** worktree reusable only by its owning lane; remove after this PRD closes and the PR merges (verify merge evidence, tracked/untracked/ignored data, then delete the exact path).
**No new self-improvement feature.** This PRD audits and hardens features that already exist; it adds no product capability.

## Context

LeanPi is a Pi extension (~36k LOC `src/`, ~24k LOC `tests/`, 121 test files) claiming cost-aware task compilation, progressive capability disclosure, multi-model routing, executor/reviewer lanes, and evidence-driven completion. The user goal is production readiness: inspect **each** feature, fix real bugs through observed red→green tests, and add meaningful missing coverage — not new features.

Prior audits exist and were read (not re-run): `docs/audits/done/2026-09-21-codebase-audit.md`, `docs/audits/production-readiness-audit.md`, `docs/reports/code-quality-report-2026-09-21.md`, `docs/reports/BUG_REVIEW.md`, `docs/benchmarks/2026-09-21-four-way-harness-cost.md`. Against this base, several of their core findings are already fixed and have tests: A1 change set from worktree state (`tests/executor/change-set.spec.ts`), A2 corrupt PRD store (`tests/prd/state.spec.ts:40`), A3 native `apiKey` resolution (`apiKeyFor` at `src/backends/native.ts:113`), A4/COST-1 JEV + top-level `cost:` round-trip (`tests/telemetry/cost.spec.ts:226`), T1 untrusted config cannot supply `backends`/`verify` (`tests/permissions/trust.spec.ts:84`). Candidate findings that remain open at this base are listed in Phase 1 and must be independently reproduced, not assumed.

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

- [x] AC-1 [local; actor: agent]: Full feature audit complete — each of the 5 domains traced through its real consumer entry point, with findings naming `file:line`, severity, reproduction, and coverage verdict for every candidate. No orphan features: every advertised capability has a reachable command/tool/hook/public API consumer and observable result; registration-only or test-only implementations must be wired or removed from the advertised surface. — Evidence: P1-A/B/C ledgers trace all 5 domains to real consumers; the orphan runtime/isolation features are wired to `src/runtime/plan.ts`, the verifier context and `runIsolated` in `turn-lanes.ts`. `pruneOrphans` is an exported **manual** API, documented as such (no automatic session-start call); no advertised capability remains registration-only.
- [x] AC-2 [local; actor: agent]: Every candidate and named finding in `docs/audits/2026-09-21-codebase-audit.md` is dispositioned as confirmed-and-fixed, already-correct-with-regression-test, or an explicit limitation/deferred nonessential change with rationale. Move the resolved audit to `docs/audits/done/2026-09-21-codebase-audit.md`, preserving valid relative links and updating references. — Evidence: audit `Current dispositions (2026-09-22)` section (A1/SRP-1/A2/A3/A4/COST-1/T1 fixed at base; COST-2/3/4, S1, DRY-1, routing, packaging, LSP/skill trust fixed this task; COST-5/A5/C1/C2/SRP-2/KISS-1/DRY-2 explicitly deferred). Audit moved to `docs/audits/done/2026-09-21-codebase-audit.md`; all 233 relative links rewritten one level deeper and resolve.
- [x] AC-3 [local; actor: agent]: Cost surface is honest: configured `jev.usd_per_mtok` and top-level `cost:` round-trip; invalid monetary rates and out-of-range cached fractions fail load with a named config error (a legitimate `0` still loads); native cache-write usage is captured and representable; the aggregate report names subscription/local volume and unmeasured metered calls instead of presenting unknown as `$0`. — Evidence: COST-2/3/4 fixed with red→green in `tests/telemetry/cost.spec.ts` + `tests/routing/config.spec.ts`; JEV and top-level `cost:` round-trip; named `ConfigError` for invalid rates with `0` preserved. COST-5 peak/off-peak and billing-source provenance remains a stated limitation (per-call pricing label only, no provider invoice).
- [x] AC-4 [local; actor: agent]: Security/trust boundaries verified: a verifier scope containing a space runs as one argument (no shell splitting/injection); the verifier/harness environment policy is either enforced to the `childEnv` allowlist or documented as a deliberate credential passthrough with a test pinning the intent; an untrusted project config cannot supply an executable backend or shell verifier. — Evidence: S1 fixed — scope is a structured `ScopeSpec` quoted once as an inert token list; quoted-placeholder and `<<`/`<<<` heredoc templates are rejected; `tests/verify/scope-injection.test.ts` green (real `$(touch PWNED)` sentinel red before). S2 env passthrough documented + pinned by `tests/verify/env-policy.test.ts`. Untrusted config drops `backends`/`verify` and LSP/default-skill trust is closed (`tests/permissions/trust.spec.ts`, `tests/lsp/trust.spec.ts`, `tests/skill-trust-consumers.spec.ts`).
- [x] AC-5 [local; actor: agent]: Missing value-chain coverage added: one entry-point E2E (`createLeanPiSession().runTurn()` or the `activate()` input hook) drives compiler → executor lane → **real worker subprocess** → real verifier → review → proof → telemetry over a temporary git repo, with negative controls proving a failing verifier, a rejecting review, or missing/stale proof cannot yield success; a native interactive variant asserts the `agent_end` record and cost without claiming the gate chain runs there. No internal lane/worker/reviewer function is stubbed. — Evidence: `tests/e2e/value-chain.spec.ts` (whole chain + failing-verifier, `FIX_REQUIRED`, no-facility browser, stale-proof re-hash negatives) and the native `agent_end` record/cost in `tests/cost-wiring.spec.ts`; the native path explicitly records `not_run` with `success:false`. Green in the final suite.
- [x] AC-7 [local; actor: agent]: A real hanging worker subprocess and descendant are reaped through the supported lane timeout path, with a blocked result and bounded failed invocation count (audit TEST-7). — Evidence: `tests/backends/timeout-reap.spec.ts` reaps the process group (descendant SIGKILL) with a bounded single failed attempt; green.
- [x] AC-6 [local; actor: agent]: Production gates green on the finishing revision: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`; packaging smoke (`npm pack` contains `bin/`, `dist/`, `skills/`, `themes/`, `vendor/`, `src/capability/models.json`); production-readiness limitations stated explicitly (Windows unverified, no live vendor/provider/subscription qualification, cost figures are configured valuations not cash, native path does not run the automatic gate chain). PRD moved to `docs/PRDs/v1/done/` in the finishing commit. — Evidence: final revision — `pnpm build`, `pnpm test` (876 passed / 10 skipped across 136 passed / 2 skipped files), `pnpm typecheck`, `pnpm lint`, `git diff --check` all exit 0; the real `npm pack` tarball smoke (`tests/cli/packaging.spec.ts`) passes inside the suite; limitations below; PRD archived to `done/`.

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
**Status:** DONE
**ACs:** AC-1
- [x] P1-A: Execution audit traced scout/compiler, routing, executor/backends, verification/review/proof, runtime, goal/todo/PRD, RTK and exploration. Findings: runtime plans have no production producer, worktree isolation has no session consumer, verifier scope reaches the shell unescaped, and harness timeout kills only the direct child. Real-entry-point success/failure and timeout coverage remains required in Phase 4.
- [x] P1-B: Config/permissions, cost collection/storage/display, routing policy, JEV credential/privacy and backend fallback audited. COST-2/3/4 confirmed; additionally, `loadConfig` discarded the entire `routing:` block. Core A1/A2/A3/A4/COST-1/T1 regressions already exist at the base. Remaining trust gaps are below.
- [x] P1-C: CLI/commands/UI hooks, skills/MCP/LSP/capabilities/context/recap, benchmark gates and packaging traced. Installed launcher misses its imported patch script; installed fold-cache extension is absent. Untrusted LSP overrides survive loading, and activation restores untrusted default project skill roots. Other domain features have reachable production consumers; runtime/isolation exceptions remain open under AC-1.
**Files:** none edited. Three independent read-only briefs:
- **Brief A — gate chain & executor/worker edge:** `src/compiler/`, `src/executor/`, `src/backends/`, `src/verify/`, `src/runtime/`, `src/proof/`, `src/review/`, `src/goal/`, `src/todo/`, `src/prd/`, `src/rtk/`, `src/exploration/`. Verify change-set derivation (`src/backends/native.ts:90-92`, `changedFilesSince`), retry/escalation effects, timeout/abort reaping, gate short-circuits.
- **Brief B — trust, config, money, persistence:** `src/permissions/`, `src/core/config.ts`, `src/telemetry/`, `src/routing/cost.ts`, `src/routing/config.ts`, `src/jev/`, PRD/goal/todo state stores. Reproduce every C-COST* / C-S* / C-A5 candidate; check untrusted-config and secret handling.
- **Brief C — surface, disclosure, packaging:** `bin/leanpi.js`, `src/cli/`, `src/commands/`, `src/index.ts`, `src/skills/`, `src/capabilities/`, `src/mcp/`, `src/lsp/`, `src/context/`, `src/recap/`, `package.json`, `.github/workflows/`, README claims vs behavior.
**Implementation:** Each brief produces a findings ledger (id, feature, `file:line`, severity, repro command/probe, coverage verdict). Existing tests are read, never re-run for the audit; candidate findings are reproduced or marked `pending`.
**Verification:** E1 — each ledger entry carries a deterministic probe or `file:line` trace; every candidate above has a stated disposition. No production or test file edited in this phase.
**Checkpoint:** done; final integrated gates recorded in Phase 5.

**Repair queue from the feature audits:** Package `scripts/patch-pi-model-command.mjs` and `src/cli/fold-cache.ts` with an installed-artifact smoke test; close LSP/default-skill trust gaps and test symlink containment; make verifier scope inert data; reap worker descendants; wire runtime plans and isolation through real consumers. Preserve required-verifier failures and isolated-worktree evidence provenance. Parent review also requires truthful cost classification for cache-only usage, explicit zero rates and amounts rounded to zero; the first cost batch does not yet prove those cases.

#### Phase 2: Cost-surface fixes red→green
**Status:** DONE
**ACs:** AC-2, AC-3
- [x] P2: COST-2/3/4 fixed; routing config now reaches its consumer. Observed red→green: invalid costs 6 failures→7 passes; routing 3→4; cache-write persistence 1→pass; cost display 1→pass; usage/provenance 5→23; legacy-rate uncertainty 2→23. Telemetry/routing regressions: 61 passed. Full invoice provenance remains a stated limitation (COST-5).
**Files:** `src/telemetry/pricing.ts`, `src/telemetry/cost.ts`, `src/core/config.ts`, `src/routing/config.ts`, `src/backends/native.ts`, `src/backends/worker.ts`, `src/telemetry/record.ts` (only those confirmed in Phase 1 / Brief B).
**Implementation:** For each confirmed C-COST item: write the failing test first (red), then the minimum fix. Validation errors are named (`cost.models.<m>.input`), legitimate `0` preserved; native cache-write carried through invocation → record; aggregate report labels subscription/local/unmeasured.
**Verification:** E2 — `pnpm vitest run tests/telemetry/cost.spec.ts tests/routing/config.spec.ts tests/backends/native.spec.ts`; each fix shows the red on the pre-fix revision and green after; no lockfile change.
**Checkpoint:** done; final integrated gates recorded in Phase 5.

#### Phase 3: Trust and verifier-boundary fixes red→green
**Status:** DONE
**ACs:** AC-2, AC-4
- [x] P3: Untrusted LSP overrides, local PATH/symlink executables and all default-skill consumers are filtered. Verifier scope is structured data until the shell boundary, including compiler→verify→recovery. Environment passthrough is documented and tested. Red→green: LSP PATH 2→6; default-skill consumers 3→3; scope injection 3→5 plus compiler double-quoting 1→6. Parent security review caught nested-directory-link and broken-link trust invalidation: 2 failures→14 passes after replacing duplicate traversal with one cycle-safe content walk.
**Files:** `src/verify/descriptors.ts`, `src/verify/run.ts`, `src/backends/harness.ts`, `src/permissions/guard.ts`, `src/permissions/secrets.ts`, `src/permissions/trust.ts` (only those confirmed in Brief A/B).
**Implementation:** Quote/split the targeted scope so a path with a space is one argument; decide and pin the verifier/harness env policy (enforce allowlist or document passthrough with a test); keep untrusted-config containment. Do not weaken a security control to gain a green.
**Verification:** E3 — `pnpm vitest run tests/verify/select.test.ts tests/permissions/trust.spec.ts` plus the new boundary test; red before, green after.
**Checkpoint:** Affected checks: 435 passed, 9 skipped; parent corrections: 39 passed across trust/cost/timeout/package, typecheck and lint exit 0. Real harness descendant timeout had failed by hanging before the process-group fix; its final fixture bounds failures and owns cleanup. Installed tarball now boots help/version and contains fold-cache. Final integrated gates remain Phase 5.

#### Phase 4: Value-chain E2E coverage
**Status:** DONE
**ACs:** AC-5, AC-7
- [x] P4: Entry-point value-chain E2E plus negative controls, and the native-entry variant, pass — Evidence: `tests/e2e/value-chain.spec.ts` (whole chain plus failing-verifier, `FIX_REQUIRED`, no-facility browser and stale-proof re-hash negatives) and the native `agent_end` record/cost in `tests/cost-wiring.spec.ts` (explicit `not_run`, `success:false`); runtime/isolation wiring covered by `tests/runtime/{config-wiring,plan-wiring,isolation-session,isolation-retention,worktree,worktree-safety}.test.ts`; the worker descendant reap by `tests/backends/timeout-reap.spec.ts`. Green in the final suite (862 passed / 10 skipped).
- [x] P4-R (user-reported recap lifecycle): saved recaps replay without a model call; session and tree switches invalidate prior state and pending generation; failed, disabled, unavailable-role and empty-history outcomes have distinct messages. Native transcript fallback and durable external input recover completed turns even when generation failed. Initial lifecycle regressions: 4 failures before the fix, then 29 focused passes; durable-input regressions: 4 failures before the fix, then 39 focused passes. Final branch/chronology review and evidence are recorded in P4-R2 below.
- [x] P4-F (failed compiled turns keep telemetry): a turn that compiled and then threw emits exactly one `success:false` record carrying its real collected invocations/usage/cost (never fabricated); a turn with no contract still writes no row; success paths stay exactly one row. Root cause was `runTurnWithTelemetry` (and the interactive `input` handler) emitting only after `runTurn` resolved, so the fail-closed gate's re-hash throw lost the worker/reviewer spend. Fix: `runTurn` publishes its partial context through the existing `onContext` before rethrowing; the telemetry wrapper installs its own observer, emits `failedRunResult()` once on exception, then rethrows the original error; the interactive handler does the same from its catch; both share `failedRunResult`. Red→green: cyclic-symlink reviewer E2E 0 rows→1 failed row (calls==`usage.external_harness_calls`, `api_usd` still 0); wrapper 2→3 tests; interactive handler failure path 1 row; no-contract throw writes no row; success stays one row. Evidence: `/tmp/lean-pi-recap-lifecycle-fix.JQHUMO/red-green/groupB-{red,green}.log`. Root-review corrections: the interactive `input` handler builds its partial context inside the `try` (optional guard in `catch`) so a throw while building it still reaches the `finally` that clears the run collector; and `runTurn`'s lane-throw path protects the `onContext` reporter so a throwing observer cannot mask the lane's original error (success paths unchanged). Focused test: a throwing observer propagates the lane failure. Red→green: `tests/wiring.spec.ts` 1 failed|13 passed → 14 passed. Evidence: `/tmp/lean-pi-recap-final-fixes.7ymPaX/red-groupB.log`, `green-groupAB.log`.
- [x] P4-R2 (durable external input + chronology): a resumed active branch with user/assistant entries but no persisted recap restores the newest completed pair from `getBranch()` — requiring actual assistant text and skipping a trailing unanswered user and tool-use/error/aborted entries — with no model call on restore; `recapTurn` persists `{ask,did}` before any generation attempt including off/unavailable/failed; and the newest native completion now beats an older saved recap/input by chronology. Red→green: `tests/recap/wiring.spec.ts` 2 failed → 25 passed (durable input); root chronology regression 3 failed/24 passed → 52 passed.
**Files:** new `tests/e2e/value-chain.spec.ts`, `tests/cost-wiring.spec.ts`, a focused executor timeout test (or the narrowest files that satisfy the guarantees); existing transport fixtures only (`tests/backends/helpers.ts`, stub HTTP provider) — no internal lane/worker/reviewer stub. P4-R edits `src/recap/index.ts`, `src/commands/recap.ts`, the `session_start`/`session_tree` hooks in `src/index.ts`, and `tests/recap/wiring.spec.ts`; P4-F also edits `src/commands/session.ts` and `tests/wiring.spec.ts`.
**Runtime/isolation wiring:** Parse and validate `verify.runtime`, `limits.isolation`, `limits.max_escalations` and `workspace.worktreeRoot`; carry runtime plans and optional embedding browser facilities per verification context. Required unavailable checks stay blocked; absent runtime plans do not demand smoke. Run isolated execution/verification/review/proof against one workspace, persist success/failure patches outside it, preserve the original dirty checkout, and reclaim only owned worktrees under the primary repository’s ignored `.worktrees/` directory. Test permissions before creation and concurrent plan separation.

**Final screenshot correction:** `screenshot_compare` now navigates to the configured URL before capture. The existing page-fixture test gained an assertion on the visited URL: 1 failure before the fix, then all 6 browser/screenshot tests passed.

**CI-only correction (subscription availability):** GitHub run 35761271530 failed 9 tests in `tests/e2e/value-chain.spec.ts` (8) and `tests/runtime/isolation-session.test.ts` (1) while passing locally. Cause: §25 subscription routing (`src/backends/subscriptions.ts`) probes the *machine* for a vendor login, so on a credential-less runner the `balanced`/`quick`/`strong` executor classes were deviated to the native `specialist` role and the external-harness stub never ran (fixture file unchanged, empty worktree patch). Fix (test fixture only, no production change): sessions in those two files declare the login the stub stands in for via `CLAUDE_CODE_OAUTH_TOKEN` (`harnessStubEnv`/`bootHarnessSession` in `tests/helpers/fixtures.ts`). Reproduced red with `HOME=<empty dir>` (9 failed | 9 passed, identical to CI) and green after (18 passed); full `pnpm test` 876 passed / 10 skipped.

**Implementation:** Temporary git repo; config binding `quick`/`balanced`/`strong` to one `external_harness` backend whose `command` is the existing stub CLI; real verifier command; real review verdict. Assertions: file on disk persists; pre-existing user edit preserved and not attributed; proof `PASS` only for a genuinely evidenced criterion; exactly one telemetry row read back by `readRuns`; negative controls (failing verifier, `FIX_REQUIRED`, missing/stale proof) cannot yield success. Native variant asserts `agent_end` record/cost and explicitly asserts the gate chain does **not** run on the native path.
**Verification:** E4 — `pnpm vitest run tests/e2e/value-chain.spec.ts tests/cost-wiring.spec.ts`; negative controls fail as designed; no vacuous PASS.
**Checkpoint:** done; final integrated gates recorded in Phase 5.

#### Phase 5: Production gates, packaging smoke, limitations, closure
**Status:** DONE
**ACs:** AC-6
- [x] P5: All gates green, packaging smoke recorded, limitations stated, PRD closed into `done/` — Evidence: `pnpm build`, `pnpm test` (876 passed / 10 skipped across 136 passed / 2 skipped files), `pnpm typecheck`, `pnpm lint`, `git diff --check` all exit 0 on the approved revision; the real `npm pack` artifact smoke passes inside the suite; limitations recorded below and the audit archived; PRD closed into `done/`.
**Files:** `docs/PRDs/v1/PRD-040-production-tdd-audit.md` → `docs/PRDs/v1/done/`; `docs/PRDs/v1/INDEX.md` if the index is hand-consistent; `.github/workflows/ci.yml` only if a gate is missing.
**Implementation:** Run the required broader gates once, add the packaging smoke assertion, record honest limitations, reconcile evidence boxes, and close the PRD in the finishing commit (no merge required to close; the draft PR is opened separately).
**Verification:** E5 — `pnpm build && pnpm test && pnpm typecheck && pnpm lint` all exit 0; `npm pack --dry-run` lists the packaged surface; PRD present under `done/`.
**Checkpoint:** done; final integrated gates recorded in Phase 5.

## Required gates

`pnpm build && pnpm test && pnpm typecheck && pnpm lint` (build first: `tests/cli/launch.spec.ts` and `tests/commands/thinking-fold.spec.ts` assert `dist/` exists). Never change the lockfile to obtain a green run; warnings are tolerated, errors are not.

## Production-readiness limitations (not to be invented away)

- No live vendor CLI, provider, subscription or billing call was made; the paid `bench:cost-gate` live lane is opt-in and was not run; the existing `describe.skipIf` live lanes remain owner-gated and are not correctness blockers.
- Cost figures are post-run **configured economic valuations**, not cash invoices. Peak/off-peak, rate effective-date and included-allowance vs paid-overflow provenance are not implemented (COST-5); only a per-call `pricing: "declared"|"missing"` label was added.
- Windows behavior is untested (CI is Ubuntu/Linux-only); no cross-platform claim is made.
- The native Pi-loop path records its `agent_end` usage/cost but does not run the automatic executor/verify/review/proof chain; the native record is explicitly `not_run` with `success:false`, never implying parity.
- Browser/screenshot verification needs a host-injected browser facility; the installed Pi SDK exposes none.
- `pruneOrphans` is an exported manual API; no automatic crash cleanup is claimed.

Historical external turns with neither a saved recap nor saved input cannot be reconstructed; completed turns now persist recap input before generation.

# LeanPi Review — Model Selection, Permissions/Trust and Verification

Revision: `dadf0f7d84c710e53a18cc9174cfbc2f5a97dd81`

Date: 2026-09-19

**Scope.** A read-only review of how LeanPi selects models for executor and reviewer turns (compiler, executor, reviewer, capability, backends), plus permissions/trust and verification. No source, test, config, manifest or lockfile was modified; no commit was made; no credentials were read, no provider was called, and no code was published. Findings describe the committed `dadf0f7` baseline. Subsequent uncommitted working-tree edits in the primary checkout were not reviewed and may alter findings or line numbers. Source files were unchanged at inspection of that baseline. Coverage is deliberately partial: one planned subreview (context/telemetry/runtime) stopped without final results, so this report makes no claim about it and does **not** claim exhaustive coverage.

**Conclusion.** 12 distinct confirmed findings — **4 P1, 8 P2, 0 P3**. Model selection contributes two P1s: the advertised cost-aware adaptive router never executes (F1) and a reviewer verdict of `FIX_REQUIRED`/`ESCALATE` still reports the turn as `completed` (F2). Verification contributes one P1: compiled contracts require `affected_tests` but never supply a scope or command, so the mandatory targeted test is `not_run` and external-harness turns verify `incomplete` → `blocked` (B1). Permissions contributes one P1: `escapesRoot` fails open for a new or dangling symlink leaf, letting a write escape the session root under only `edit` (ask) (S1). The proposed benchmark-cache + subscription-inventory + JEV decision design is **not implemented**; it is a design for review. Separately, implementation of subscription-aware routing is now in progress as PRD-027 in another workstream and is **not complete** — nothing in this report should be read as landing it.

## Quick navigation

- [1. Confirmed findings summary](#1-confirmed-findings-summary)
- [2. Current behavior](#2-model-selection-current-behavior-as-built) · [3. Availability/quota gaps](#3-availability-subscription-and-quota-gap-analysis)
- [4. Verification](#4-verification-findings) · [5. Permissions/trust](#5-permissions-and-trust-findings)
- [6. Proposed design (not implemented)](#6-proposed-model-selection-design-not-implemented)
- [7. Validation & limits](#7-validation-and-honest-limits) · [Appendix A](#appendix-a--minimal-self-contained-reproductions) · [Highest-leverage fixes](#highest-leverage-bounded-fixes)

---

## 1. Confirmed findings summary

**Severity definitions.** **P1** blocks an advertised guarantee. **P2** is a real but bounded defect. **P3** is a low-priority defect; cosmetic issues are excluded. Totals: **12 findings — 4 P1, 8 P2.** Status **Unfixed** means not fixed in the reviewed `dadf0f7` baseline, not a statement about the live working tree. No finding is counted on a path unreachable today; the one latent candidate (B2) is listed under §4 as a future hazard, not as a confirmed bug.

| ID | P | Area | Finding | Anchor | Status |
| --- | --- | --- | --- | --- | --- |
| F1 | P1 | Routing | Adaptive router (PRD-020) is dead code; cost-aware selection never executes | [src/routing/router.ts:201](src/routing/router.ts#L201) | Unfixed; routing path |
| F2 | P1 | Executor/reviewer | Reviewer verdict ignored; `FIX_REQUIRED`/`ESCALATE` still reports `completed` | [src/executor/lane.ts:269-286](src/executor/lane.ts#L269-L286) | Unfixed |
| F3 | P2 | Config/capability | `models.specialists` (FR-047) cannot be loaded from a config file | [src/core/config.ts:76-79](src/core/config.ts#L76-L79) | Unfixed; routing-adjacent |
| F4 | P2 | Reviewer | Automatic review never evaluates independence; missing identity also forces the first candidate | [src/review/lane.ts:137-146](src/review/lane.ts#L137-L146) | Unfixed |
| F5 | P2 | Reviewer/backend | Reviewer-role fallback is advertised but not applied to reviewer dispatch | [src/review/lane.ts:143](src/review/lane.ts#L143) | Unfixed |
| F7 | P2 | Executor | Four of six continuing escalation categories do not change the next invocation | [src/executor/escalation.ts:144-169](src/executor/escalation.ts#L144-L169) | Unfixed |
| B1 | P1 | Verification | Compiled contracts require `affected_tests` but never supply a scope/command, so the mandatory `targeted_test` is `not_run` and external-harness turns end `blocked` | [src/compiler/index.ts:75](src/compiler/index.ts#L75), [src/executor/lane.ts:257-265](src/executor/lane.ts#L257-L265) | Unfixed |
| B3 | P2 | Permissions/trust | A trusted project can loosen its own secrets policy without changing `surfaceHash`; the config file is outside the trust surface | [src/permissions/trust.ts:459-476](src/permissions/trust.ts#L459-L476) | Unfixed; security |
| B4 | P2 | Verification | `runExecutor` never passes a `diff`, so deterministic regression widening can never fire | [src/executor/lane.ts:257-265](src/executor/lane.ts#L257-L265), [src/verify/select.ts:137-140](src/verify/select.ts#L137-L140) | Unfixed |
| B6 | P2 | Permissions | A symlinked session root makes legitimate in-root relative paths classify as `external_dir` (deny) | [src/permissions/rules.ts:263-275](src/permissions/rules.ts#L263-L275) | Unfixed; environment-dependent |
| S1 | P1 | Permissions | `escapesRoot` fails open for a new/dangling symlink leaf; a write escapes the root under only `edit` (ask) | [src/permissions/rules.ts:263-275](src/permissions/rules.ts#L263-L275), [309-315](src/permissions/rules.ts#L309-L315) | Unfixed; security |
| S2 | P2 | Permissions | Destructive-git/network classifier misses common git flag orderings | [src/permissions/rules.ts:185-193](src/permissions/rules.ts#L185-L193), [204-209](src/permissions/rules.ts#L204-L209) | Unfixed; security |

---

## 2. Model selection: current behavior as built

### 2.1 Two entry points, two different selectors

There is no single selection path. The native path and the external-harness path pick models differently, and the interactive host is not the library session path.

| Mode | Entry point | What selects the model |
| --- | --- | --- |
| Native backend (`type: native`) | `activate()` → Pi agent loop; library form `createLeanPiSession().runTurn()` ([src/commands/session.ts:119](src/commands/session.ts#L119)) | Library `runTurn` calls `resolveRole(config, role)` ([src/core/roles.ts:38](src/core/roles.ts#L38)) then `session.setModel` ([src/commands/session.ts:141](src/commands/session.ts#L141)). The **interactive `pi --extension` host issues no `setModel`**, so Pi's own selected model runs; only the prefix/tools are LeanPi's. |
| External-harness backend (all of quick/balanced/strong `type: external_harness`) | `activate()` → `registerTurnLanesIfOwned()` ([src/index.ts:233](src/index.ts#L233)) → `runExecutor` ([src/executor/lane.ts:170](src/executor/lane.ts#L170)) | The compiled contract's `routing.executor_class` + `BackendRegistry.selectBackend()` ([src/backends/registry.ts:219](src/backends/registry.ts#L219)). |

`ownsExecutionLoop()` ([src/commands/turn-lanes.ts:68](src/commands/turn-lanes.ts#L68)) registers the compiler/executor lanes **only** when every one of quick/balanced/strong resolves to an enabled `external_harness` backend. With the tracked config (a single `native` backend, [leanpi.config.yaml:8](leanpi.config.yaml#L8)) the compiler lane never registers, so `compileTask` — and the skill provider it alone calls — never runs on a real turn.

There is **no hard-coded default model**: `loadConfig` throws if `models:` is empty ([src/core/config.ts:301](src/core/config.ts#L301)). There **is** a library role default: `runTurn` uses `turn.role ?? "balanced"` ([src/commands/session.ts:120](src/commands/session.ts#L120)). "No model-ID default" and "default role `balanced`" are distinct facts.

### 2.2 Exact identifiers in this checkout

The tracked non-secret config ([leanpi.config.yaml:26-44](leanpi.config.yaml#L26-L44)) binds all six roles to the same pair:

| Role | backend | model |
| --- | --- | --- |
| quick / balanced / strong / specialist | `opencode-go` | `deepseek-v4.1-flash` |
| review_quick / review_strong | `opencode-go` | `deepseek-v4.1-flash` |

`opencode-go` is a **backend key**, parsed as a `native` entry whose Pi provider label defaults to the key because `baseUrl` is set ([src/backends/registry.ts:156](src/backends/registry.ts#L156)); the endpoint is `https://opencode.ai/zen/go/v1`. `deepseek-v4.1-flash` is the **model id**, so a binding is `(backend=opencode-go, model=deepseek-v4.1-flash)`. It is a config binding: the tracked roles do **not** force the model of an interactive Pi turn.

Other identities in the path:

- JEV control model: `config.jev.model`, default `"jev-latest"` at `https://api.typesafe.ai/v1/systemone` ([src/core/config.ts:111-113](src/core/config.ts#L111-L113)).
- Capability floors (LeanPi's own 0–100 scale): quick 50 / balanced 70 / strong 85 / specialist 70 / review_quick 70 / review_strong 85 ([src/capability/roles.ts:50-57](src/capability/roles.ts#L50-L57)).
- Bundled ranking ([src/capability/models.json](src/capability/models.json), 9 records): none is `deepseek-v4.1-flash`, so the ranking binds nothing and `resolveRole` falls through to the static `models:` map.
- Role fallback chain `ROLE_FALLBACK_CHAINS` ([src/core/roles.ts:23-30](src/core/roles.ts#L23-L30)); used by `resolveRole` (display, `/model`, native setModel) but **not** by reviewer dispatch (F5).

### 2.3 The task/class matrix (current behavior, not a new assignment)

`compileTask` ([src/compiler/index.ts:123](src/compiler/index.ts#L123)) classifies complexity and review risk independently, applies `matrixDefault` ([src/compiler/route.ts:37](src/compiler/route.ts#L37)), then session pins ([src/compiler/pins.ts:59](src/compiler/pins.ts#L59)). This is the **behavior table as it exists today**, not a proposed hard-coded model assignment.

| prd_required | complexity | executor_class | reviewer_class |
| --- | --- | --- | --- |
| false | LOW | quick | R0 `none` · R1/R2 `review_quick` · R3 `review_strong` |
| false | MEDIUM | balanced | `review_quick` (risk-independent) |
| false | HIGH | strong | `review_strong` |
| true | LOW | quick | `review_quick` |
| true | MEDIUM | balanced | `review_strong` |
| true | HIGH | strong | `review_strong` |

Source: `ROUTING_MATRIX` ([src/compiler/route.ts:16-23](src/compiler/route.ts#L16-L23)) and `REVIEWER_BY_RISK` ([src/compiler/route.ts:25-30](src/compiler/route.ts#L25-L30)). The R-band mapping intentionally applies to the first row only (PRD-004 §Solution); the deterministic review floor never reads `review_risk` ([src/review/gate.ts:128-145](src/review/gate.ts#L128-L145)).

Actual external-harness dispatch: `selectBackend(role)` returns enabled, non-cooling backends declaring the role, sorted explicit-role desc, then `priority` desc, then declaration order ([src/backends/registry.ts:219-235](src/backends/registry.ts#L219-L235)); `modelFor(backend, role)` returns `config.models[role].model` when that backend is the role's declared backend, else the entry-level `model:`, else `null` → a typed worker failure ([src/backends/worker.ts:161-163](src/backends/worker.ts#L161-L163)). It never reads the benchmark index or price.

### 2.4 Worked examples

Run against built `dist/` with JEV disabled and explicit scout packets (Appendix A.1):

| # | Request | changed / modules | gate | complexity | risk | executor | reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | rename `parseFoo` to `parseBar` | `src/target.ts` / `src` | DIRECT_EXECUTION | LOW | R0 | quick | none |
| E2 | fix the race condition in the scheduler | `src/scheduler.ts` / `src` | DIRECT_EXECUTION | HIGH | R0 | strong | review_strong |
| E3 | update the auth token check | `src/auth.ts` / `src` | DIRECT_EXECUTION | MEDIUM | R3 | balanced | review_quick |
| E4 | migrate the database schema | `src/db/migrate.ts` / `src/db` | PRD_REQUIRED | MEDIUM | R3 | balanced | review_strong |
| E5 | add streaming mode to the parser | 3 files / `src/parser` | PRD_REQUIRED | MEDIUM | R2 | balanced | review_strong |

These classes apply **only in external-harness mode**. With the tracked native config the contract is never compiled on a real turn; the interactive host runs Pi's own model, while the library `runTurn` path defaults to role `balanced` → `resolveRole` → `opencode-go/deepseek-v4.1-flash`. Reviewer independence is computed by comparing `${backend}/${model}` to the executor identity ([src/review/lane.ts:133-164](src/review/lane.ts#L133-L164)); the automatic executor path never supplies that identity (F4).

### F1 — P1 — The adaptive router (PRD-020) is dead code

- Anchors: [`selectRoute`](src/routing/router.ts#L201), [`dispatchRequest`/`routeDescriptorOf`/`withRouteCost`](src/routing/router.ts#L176), [`registerRoutingSites`](src/routing/sites.ts#L106); exports [src/routing/index.ts:22-43](src/routing/index.ts#L22-L43).
- Static evidence (Appendix A.4): `rg -n "selectRoute\(" src` matches only its definition and a comment; each helper projection has no non-test caller; `registerRoutingSites` is called only from `selectRoute`. The executor instead uses `contract.routing.executor_class` ([src/executor/lane.ts:194](src/executor/lane.ts#L194)) + `BackendRegistry`.
- Expected (README/ROADMAP/PRD-020): cheapest-clearing `route_cost` ranking with telemetry calibration, JEV tie-band reorder, quota preference, effort decision and `route_cost` in the record.
- Actual: none of it runs. Calibration never sees a run; `route_cost` is never written; the routing JEV sites never register.
- Recommendation (bounded): wire one call site in the executor lane (resolve contract → `selectRoute` → dispatch selected identity and record `route_cost`), or remove the cost claim from README/ROADMAP. Not both. This is the natural home for the JEV model-choice site.

### F2 — P1 — The reviewer verdict is ignored by the executor lane

- Anchor: [src/executor/lane.ts:269-286](src/executor/lane.ts#L269-L286) returns `status: "completed"` immediately after `runReview`; no branch reads `reviewOutcome.verdict.decision`, and `limits.semantic_review_rounds` is never referenced in the lane.
- Trigger: a passing `verifyTask` plus a reviewer returning `FIX_REQUIRED` or `ESCALATE`.
- Runtime (Appendix A.2): `status=completed verdict=FIX_REQUIRED`. The existing AC-4 test supplies a summary parsing to `ESCALATE` and still asserts `status === "completed"` ([tests/executor/lane.spec.ts:167-206](tests/executor/lane.spec.ts#L167-L206)).
- Consumer check: `turn-lanes.ts` stores the outcome and does nothing else ([src/commands/turn-lanes.ts:44-46](src/commands/turn-lanes.ts#L44-L46)); `runTurn` returns after assembling the prefix ([src/commands/session.ts:130-146](src/commands/session.ts#L130-L146)); `evaluateProofGate` ([src/proof/gate.ts:308](src/proof/gate.ts#L308)) has **no non-test caller** in `src/`.
- Recommendation: branch on `verdict.decision` in `runExecutor` (feed findings back as a new attempt, or set `status: "blocked"` when rounds are exhausted); count rounds against `limits.semantic_review_rounds`.

### F3 — P2 — `models.specialists` (FR-047) cannot be loaded from a config file

- Anchors: [`parseModels` throws `unknown model role`](src/core/config.ts#L76-L79); the reader that expects the key is [src/routing/config.ts:78-86](src/routing/config.ts#L78-L86).
- Runtime (Appendix A.6, real YAML): `ConfigError: models.specialists: unknown model role "specialists"`. Tests miss it because the routing fixture injects `models` through the `overrides` argument spread last ([src/core/config.ts:298](src/core/config.ts#L298)), bypassing `parseModels`.
- Impact: specialist routing is unreachable through the documented operator path; only programmatic/SDK callers can set it.
- Recommendation: teach `parseModels` the `specialists` key as a **separate shape** (`Record<string, ModelRole>` validated with `isModelRole`), widen the parser's return type, and keep the structural read in `routing/config.ts`. A bare key allowance that stores it as a role entry would mistype the map.

### F4 — P2 — Automatic review never evaluates independence

- Anchors: [src/executor/lane.ts:425-432](src/executor/lane.ts#L425-L432) builds `ReviewDeps` without `executor`; [src/review/lane.ts:137-146](src/review/lane.ts#L137-L146) then always returns `independence: "degraded"`.
- Trigger: every automatic gate review.
- Runtime (Appendix A.3): with two enabled backends `alpha/same-id` and `beta/other-id`, no identity supplied → runner receives `alpha/same-id`, `independence="degraded"`; executor `alpha/same-id` supplied → runner receives `beta/other-id`, `independence="independent"`. The missing identity not only loses the verdict, it **selects the first candidate** and never considers the available different model.
- Impact: independence is never established for auto reviews; the alternative model is not preferred even when configured. It fails safe but the §31 guarantee is unenforced.
- Recommendation: pass `{ backend: outcome.backend, model: modelFor(backend, role) }` into `runReview` and expose `independence` on `ExecutorReviewOutcome`.

### F5 — P2 — Reviewer-role fallback is advertised but not applied to reviewer dispatch

- Anchors: `resolveRole` fallback chain [src/core/roles.ts:28-29](src/core/roles.ts#L28-L29), used by `/models` and `session.modelFor`; reviewer dispatch uses `modelFor(backend, role)` at [src/review/lane.ts:143](src/review/lane.ts#L143) ([src/backends/worker.ts:161-163](src/backends/worker.ts#L161-L163)).
- Trigger: a config binding quick/balanced/strong but no `review_quick`/`review_strong`, with a pool-wide backend that has no entry-level `model:`.
- Runtime (Appendix A.3): `resolveRole(review_quick) => local/cheap` but `review() => verdict=ESCALATE … backend "local" declares no model for role "review_quick"`. The reviewer cannot run.
- Recommendation: resolve the reviewer model through the same `resolveRole` chain before dispatch, or make `loadConfig`/`/doctor` fail loudly when a review role cannot dispatch. This is distinct from F4 (identity comparison).

### F7 — P2 — Four continuing escalation categories do not change the next invocation

- Anchor: [`escalate()`](src/executor/escalation.ts#L144-L169): `GET_MORE_CONTEXT`, `ENABLE_CAPABILITY`, `INCREASE_REASONING`, `STRONG_REVIEW` return the same role and no exclusion. The worker packet is built from the frozen contract ([src/executor/lane.ts:225-243](src/executor/lane.ts#L225-L243)); only `role` and `excludeBackends` vary.
- Runtime (Appendix A.5): a three-attempt `runExecutor` driven with an `INCREASE_REASONING` answer at the escalation site produces packets `[balanced, balanced, balanced]` with `packets[1] === packets[2]` deep-equal. The escalated attempt re-sends a byte-identical packet.
- Impact: escalated attempts can burn budget on identical work; the four labels are not actions.
- Recommendation: apply each category to the next packet (recompile effort/context; run a strong review for `STRONG_REVIEW`) or drop the categories from the contract.

### Non-findings (intended or latent)

- **Risk does not select the reviewer outside `false|LOW`.** The R-band mapping applies to the first row only; `reviewFloor` intentionally ignores `review_risk`. Documented behavior, not a defect.
- **`stepRole("specialist") === "balanced"`.** The escalation ladder is fixed at `quick → balanced → strong`; specialist and balanced floors are both 70, so no required capability is provably lost.
- **Router effort-bucket ordering mismatch** ([src/routing/router.ts:258-270](src/routing/router.ts#L258-L270)). Latent while the router is dead (F1); not reproduced, so it is a limit, not a finding.

---

## 3. Availability, subscription and quota gap analysis

The subscription contract requires that the eligible set be *models actually offered through the authenticated OpenCode Go, Codex or Claude subscriptions*, ranked by Artificial Analysis evidence, with subscription usage treated as a real cost. Against that contract the code has **four gaps**. They are not counted among the 12 confirmed findings: they are missing capability against stated requirements, not independently verified regressions.

| Gap | What exists today | Contract requirement it misses |
| --- | --- | --- |
| **G1 — No availability intersection** | `bindingOf` ([src/capability/index.ts:44](src/capability/index.ts#L44)) treats `backend.enabled && config declare` as available. No provider auth, quota, catalog or per-model inventory check anywhere. An unavailable declared model is dispatched optimistically and surfaces first at the provider ([src/backends/native.ts:103](src/backends/native.ts#L103-L110)). | Eligible = ranked ∩ configured-enabled ∩ **proven offered now**. A catalog record alone must not make a model eligible. |
| **G2 — Unknown model silently disables optimization** | `deepseek-v4.1-flash` is absent from the bundled index, so every `backend_binding` is null, `selectRoleModel` returns a `capability_gap` ([src/capability/roles.ts:152-160](src/capability/roles.ts#L152-L160)), and `resolveRole` discards the gap and returns the static map entry ([src/core/roles.ts:38-48](src/core/roles.ts#L38-L48)). | Either surface the gap or treat the choice as a first-class JEV decision; do not silently bypass selection. |
| **G3 — Reference price ranked as if billed** | `selectCheapestClearing`/`selectRoleModel` sort by `price_blended_per_mtok` ([src/capability/select.ts:64-73](src/capability/select.ts#L64-L73)) with no `billing` input, even though `predictRouteCost` zeroes monetary cost for non-metered subscription/local candidates ([src/routing/cost.ts:100-103](src/routing/cost.ts#L100-L103)). | Subscription quota cost is distinct from API list price; never fabricate USD for an incomparable quota unit. |
| **G4 — Capability gap dropped** | `selectRoleModel` can return a below-floor best-available record with a gap ([src/capability/roles.ts:145-171](src/capability/roles.ts#L145-L171)), but `resolveRole` exposes only `.ref` ([src/core/roles.ts:39](src/core/roles.ts#L39)). | Escalation / below-floor resolution must be visible, not silently accepted. |

There is **no existing subscription inventory or quota signal** in the source: `RegisteredBackend` fields are configuration (`enabled`, `priority`, `quotaClass`, `billing`, `catalogModelId`, `provider`, `model`, `modelsByRole`, [src/backends/registry.ts:28-53](src/backends/registry.ts#L28-L53)); `/doctor` and `/models` probe only executable-on-PATH or a TCP connect ("authentication not probed", [src/commands/surface.ts:183-205](src/commands/surface.ts#L183-L205)). A reachable endpoint does not mean a given model is served. This capability would have to be added.

The recommended shape adapts and reuses existing components rather than replacing them: extend `bindingOf` with an availability predicate; carry offered efforts and billing into `RouteCandidate` ([src/routing/cost.ts:32](src/routing/cost.ts#L32)); reach the existing JEV `ask` pattern; and pass the chosen exact identity in the worker packet so `modelFor` cannot re-derive a different model. One caveat: `selectCheapestClearing` ([src/capability/select.ts:102](src/capability/select.ts#L102)) today applies the old 0–100 floors and a lexicographic list-price sort. It **cannot remain unchanged if those semantics overrule the final JEV choice** — the floors must become evidence, not a gate, as described in §6.

---

## 4. Verification findings

### B1 — P1 — Mandatory `targeted_test` is always `not_run` in production, blocking every executor turn

- **Anchors:** `VERIFICATION_BY_COMPLEXITY` adds `"affected_tests"` for LOW/MEDIUM/HIGH [src/compiler/index.ts:70-76](src/compiler/index.ts#L70-L76); the compiled verification block carries only `{ required }` [src/compiler/index.ts:175](src/compiler/index.ts#L175) (the type has no `criteria`, [src/compiler/contract.ts:99](src/compiler/contract.ts#L99)); `runExecutor` calls `verifyTask` with `touchedPaths` but no `diff` and only optional `verifyCommands` [src/executor/lane.ts:257-265](src/executor/lane.ts#L257-L265); production registration passes no `verifyCommands` [src/index.ts:233](src/index.ts#L233), [src/commands/turn-lanes.ts:46-54](src/commands/turn-lanes.ts#L46-L54); `LeanPiConfig` has no `verify` field ([src/core/types.ts:131-148](src/core/types.ts#L131-L148)) so `settingsOf` reads nothing; `targeted_test` has no default scope [src/verify/descriptors.ts:55-58](src/verify/descriptors.ts#L55-L58); `not_run` aggregates to `incomplete` [src/verify/aggregate.ts:44](src/verify/aggregate.ts#L44).
- **Trigger:** external-harness mode (`ownsExecutionLoop` true) with any `compileTask`-produced contract; no programmatic `verifyCommands`, no `verification.criteria`.
- **Actual:** `scopeFor("targeted_test", [])` returns `""`; `resolveCommand` returns `""`; the verifier records `not_run`; aggregate is `incomplete`; `runExecutor` retries then returns `blocked`.
- **Runtime evidence (minimal, built `dist/`, Appendix A.7):** calling the exported selector with `{ verification: { required: ["affected_tests"] } }` yields a `targeted_test` descriptor with `command ""`, `scope ""`; `git_status` resolves normally.
- **Impact:** the only mode where the executor lane runs cannot complete a task. `runtime_smoke` (MEDIUM/HIGH) is likewise unregistered and `not_run`, compounding it.
- **Fix:** give `selectVerifiers` a concrete targeted surface (derive from `touchedPaths`/diff, or require `verify.commands.targeted_test`), and either populate `verification.criteria` with scopes from the compiler or stop requiring `affected_tests` without one. Also parse a real `verify.commands` block into `LeanPiConfig`.

### B4 — P2 — Regression widening can never fire from the executor path

- **Anchors:** `runExecutor` passes `touchedPaths` but no `diff` to `verifyTask` [src/executor/lane.ts:257-265](src/executor/lane.ts#L257-L265); `regressionScopeRule(undefined)` returns `TARGETED_SUFFICIENT` by definition [src/verify/select.ts:137-140](src/verify/select.ts#L137-L140); the `full_suite` add is gated on that verdict [select.ts:235-242](src/verify/select.ts#L235-L242). Its own doc says "with no diff supplied it cannot justify widening."
- **Trigger:** any contract with `affected_tests` whose change touches `package.json`/config/`>5` files/exported symbols, with the working (programmatic `verifyCommands`) configuration.
- **Actual:** JEV and the fallback both receive `diff: undefined`, so targeted tests alone are accepted.
- **Runtime evidence (Appendix A.7):** `regressionScopeRule(undefined) === "TARGETED_SUFFICIENT"`; the selector returns `regressionScope: "TARGETED_SUFFICIENT"` when no `diff` is supplied.
- **Impact:** shared-contract/broad changes pass on a narrow test set; the deterministic safety net is unreachable in production.
- **Fix:** pass `diff: { files: touchedPaths, exportedSymbol }` from `runExecutor` into `verifyTask`/`selectVerifiers` (the compiler/executor already has `changedFiles`).

### Not counted — B2, latent until B1's scope wiring lands

The criterion-attribution candidate (one `targeted_test` descriptor credited to every criterion while running only the first criterion's scope, [src/verify/select.ts:96-110](src/verify/select.ts#L96-L110), [214-223](src/verify/select.ts#L214-L223)) is confirmed as code **but latent**: no production code writes `verification.criteria`. It is recorded here only as a future implementation hazard to fix together with B1 — not as a distinct confirmed bug. It becomes live the moment B1's scope wiring populates criteria; fixing descriptors to key on `(kind, scope)` and attributing each only to the criteria that named that scope avoids re-introducing it.

### Baseline test triage (not a product bug)

The original run recorded 4 failed / 88 passed / 1 skipped files (4/465/3 tests). All 4 failures are a missing-`tsc` / uninstalled-deps artifact (`tests/bootstrap.spec.ts` spawns `node_modules/.bin/tsc`; verify failures only need commands to resolve). After `pnpm install --frozen-lockfile` and `pnpm build` in this worktree, the final baseline was **92 files passed / 1 skipped; 469 tests passed / 3 skipped; 0 failed**, with no source change. Findings above are supported by logic-specific reproductions (Appendix A), not by these baseline failures; the two are recorded separately.

---

## 5. Permissions and trust findings

### B3 — P2 — A trusted project can loosen its own secrets policy without invalidating trust

- **Anchors:** project secrets are applied after trust with no tighten-only comparison — `secrets.passthrough.push(...)`, `secretNames.push(...)`, and `secrets.minLength = project.secrets.minLength` verbatim [src/permissions/trust.ts:459-476](src/permissions/trust.ts#L459-L476) — while `defaults`/`rules` explicitly reject loosening via `LOOSENING_REASON` [trust.ts:405](src/permissions/trust.ts#L405). The trust surface hashes only `.leanpi/extensions`, MCP config and skill roots, never `leanpi.config.yaml` [trust.ts:197-206](src/permissions/trust.ts#L197-L206); `assertTrusted` re-checks only that hash [trust.ts:299-301](src/permissions/trust.ts#L299-L301). `secretValues` skips any value shorter than `minLength` [src/permissions/secrets.ts:43-52](src/permissions/secrets.ts#L43-L52), and the guard's `tool_result` redaction consumes that policy [src/permissions/guard.ts:157-176](src/permissions/guard.ts#L157-L176).
- **Trigger:** the user runs `/permissions trust project`; the repo later edits its own `leanpi.config.yaml` to a very large `permissions.secrets.minLength` (or adds `passthrough: [SOME_SECRET]`).
- **Actual:** `surfaceHash` is unchanged → still `trusted`; the project value is assigned verbatim, so every value becomes shorter than `minLength` and transcript redaction silently stops; added `passthrough` forwards named env vars to spawned children.
- **Evidence:** static, fully traced `loadConfig` → `assertTrusted` → `mergePermissions`. No real secrets read; no exploit run. Static trace only.
- **Corrected fix.** Tightening is **not** uniform, so "raise-only" is wrong:
  - `minLength` — raising it **reduces** redaction coverage (fewer values qualify). Tightening here is therefore **lower-only**: accept a project `minLength` only when it is lower, and deny a project attempt to raise it.
  - `secretNames` — adding names **increases** what can be matched, i.e. it tightens. Name additions are safe; only removals of user/builtin names would loosen and should be ignored while untrusted.
  - `passthrough` — adding names **can loosen** (forwards secret env to children). It should remain a user-owned setting, or require explicit re-trust; project additions must not apply silently.
  - Alternatively, include `leanpi.config.yaml` in `surfaceHash` so any config change invalidates trust.
- **Qualification:** a trusted project can already run extension code, so this is a defense-in-depth and lasting-transcript weakening rather than a new code-execution primitive. It still matters because config changes are **not bound to the trust hash**, so the stated "project scope may only tighten permissions" promise is broken for secrets.

### B6 — P2 — Symlinked session root denies legitimate in-root paths

- **Anchors:** `absolute` is lexical `resolvePath(root, candidate)` but `base` is `realRoot(root)`; `contained(absolute)` is therefore false for every relative path when `root` is or contains a symlink, and `escapesRoot` returns `true` before `realpathSync(absolute)` can run [src/permissions/rules.ts:263-275](src/permissions/rules.ts#L263-L275).
- **Trigger:** `LEANPI_CWD`/`options.cwd` pointing at a symlinked directory (e.g. macOS `/var` → `/private/var`, a symlinked checkout), tool call with a relative path.
- **Actual (Appendix A.8):** `escapesRoot(linkRoot, "a.txt") === true` → `external_dir` (builtin **deny**); `classifyScopes` scopes `["read","external_dir"]`; the same file under the real root returns `false`. Reads/edits/writes of legitimate in-root files are refused.
- **Impact:** environment-dependent denial of all relative-path file operations.
- **Fix:** canonicalize the root once and resolve the candidate against the **real** root before the lexical containment test.
- **B6 vs S1 — same function, different checks, do not double count.** Both live in `escapesRoot`, but B6 is a **false deny** caused by an unreconciled symlinked *root* (lexical containment fails before realpath runs), while S1 is a **false allow** caused by an *unresolvable leaf* under a symlinked parent (the catch returns false). The triggers and the harm are opposite, so they are two distinct defects, not one claim counted twice.

### S1 — P1 — `escapesRoot` fails open for a new or dangling symlink leaf

- **Anchors:** the `realpathSync` catch returns `false` [src/permissions/rules.ts:270-274](src/permissions/rules.ts#L270-L274); `classifyScopes` adds `external_dir` only when `escapesRoot` is true [src/permissions/rules.ts:309-315](src/permissions/rules.ts#L309-L315); guard call path `installPermissionGuard` → `evaluateCall` [src/permissions/guard.ts:74-84](src/permissions/guard.ts#L74-L84).
- **Trigger:** the session root contains a link pointing outside (`repo/link -> /outside`) or a dangling `link -> /outside/new.txt`; the model calls `write`/`edit` with `{ path: "link/new.txt" }`. `absolute` is lexically inside the root, but `realpathSync(absolute)` throws `ENOENT`, so the guard returns false; only `edit` (ask) is added, never `external_dir` (builtin deny). The write then follows the symlink and creates/overwrites a file outside the session root.
- **Runtime evidence (Appendix A.8, built `dist/`, classification only — no external write):** `escapesRoot(new leaf)=false`, `escapesRoot(existing leaf)=true`; write new-leaf scopes `["edit"]`, existing-leaf scopes `["edit","external_dir"]`.
- **Impact:** a deny-class escape is downgraded to an ask, and the ask is the ordinary write prompt a user is likely to approve; an existing symlink to an existing file is correctly denied, so the defect is specifically the missing/dangling leaf path.
- **Fix:** canonicalize existing ancestors and append the remaining path segments so a not-yet-created leaf is still tested against the canonical root; fail closed on unexpected canonicalization errors; handle a canonical root consistently. Reproduce with temporary fixtures only — do not perform real writes outside the fixture.

### S2 — P2 — Destructive-git/network classifier misses common git flag orderings

- **Anchors:** `DESTRUCTIVE_GIT` [src/permissions/rules.ts:185-193](src/permissions/rules.ts#L185-L193), `NETWORK_COMMAND` [src/permissions/rules.ts:204-209](src/permissions/rules.ts#L204-L209); applied in the shell branch [src/permissions/rules.ts:318-328](src/permissions/rules.ts#L318-L328).
- **Trigger via `execute`:** `git clean -f -d`, `git clean --force -d`, `git -C . push --force`, `git push origin +main`. The `git clean` patterns only match a single contiguous `-fd`/`-df` cluster; `\bgit\s+push\b` requires `push` immediately after `git`, so common options (`-C`, `-c`) and the `+refspec` force form bypass `git_destructive` (default deny), and `git -C … push/fetch` also bypasses `network`. Commands were **classified only**; none were executed.
- **Runtime evidence (Appendix A.8):** `git clean -fd` → shell+git_destructive; `git clean -f -d` → shell; `git clean --force -d` → shell; `git -C . push --force` → shell (misses `network` too); `git push origin +main` → shell+network; `git push --force` → shell+git_destructive+network.
- **Impact:** a default-deny destructive scope can be missed, and a network operation can escape its scope. Generic `shell` approval (ask) still applies, so this is a scope-completeness defect, not a full approval bypass.
- **Fix:** handle git global options (`-C`, `-c`, `--git-dir`, `--work-tree`, `-c key=val`) before the subcommand using argv-aware parsing, and recognize `+refspec` as a force form. No claim that a raw shell parser is a panacea.

### Discarded candidate — B5, unreadable trust surface

An unreadable file under the hashed project surface throwing `EACCES` out of `loadConfig` was **not** carried as a confirmed bug: failing closed on an unreadable trust surface may be deliberate, and the candidate's suggested remediation — skipping unreadable files — would silently trust a surface it could not inspect. **Never recommend skipping an unreadable trust surface.** If this is revisited, the only safe options are to fail with a clear diagnostic or to treat the unreadable entry as untrusted.

---

## 6. Proposed model-selection design (not implemented)

**Objective.** For every executor and reviewer turn, run the cheapest model actually offered by the operator's authenticated subscriptions that JEV judges sufficient for the objective, acceptance criteria and role, then dispatch that exact identity.

**Main invariant.** *Cheapest sufficient under one explicit effective-cost policy.* Not an arbitrary score/price multiplication, and not always the strongest model. The final JEV choice is **cheapest-capable and quota-aware**.

**Naming.** Three simple parts: **benchmark cache**, **subscription inventory**, **JEV decision**. Nothing below is implemented.

### 6.1 Parts and ownership

- **Benchmark cache (external, slow).** A local Artificial Analysis snapshot refreshed at most every 14 days. It is capability and reference-price evidence, never an availability claim.
- **Subscription inventory (runtime, fast).** Exact native model IDs and offered reasoning efforts per backend/account pool, with an evidence timestamp and a quota snapshot. Only `(backend, native_model_id, effort)` pairs proven offered through OpenCode Go, Codex or Claude are eligible.
- **JEV decision (final).** Given the eligible candidates, benchmark evidence, task/role and the effective-cost policy, JEV names the final candidate for executor and for reviewer. Runtime validates the name is in the eligible set and dispatches it. JEV cannot invent IDs.

**Benchmark source.** The proposed external evidence is the official Artificial Analysis API ([https://artificialanalysis.ai/api-reference](https://artificialanalysis.ai/api-reference)): `GET /api/v2/data/llms/models`, account-keyed via `x-api-key`, returning stable model/creator UUIDs, `evaluations.artificial_analysis_coding_index` and `intelligence_index`, and input/output/blended USD per million pricing. The API recommends caching and requires attribution. API-key availability was not checked, and no authenticated AA fetch was performed; no cache exists in this checkout. The api-reference was verified as an official source only. Those dollar prices are reference list prices, not what a subscription quota actually charges.

### 6.2 Data shapes (synthetic fixtures; no live observation)

Numbers below are illustrative. External AA identity and backend-native identity are **different identifiers and joined explicitly, never assumed equal**. Effort is part of the candidate key. Unknown fields stay `null`.

```jsonc
// Benchmark cache record — synthetic; not a live observation
{ "schema_version": 2, "fetched_at": "<synthetic-timestamp>", "source": "artificialanalysis.ai",
  "models": [
    { "external_id": "<aa-model-uuid>", "creator_id": "<aa-creator-uuid>",
      "variant": "reasoning-high",
      "metric": "artificial_analysis_coding_index", "score": 61.2,
      "score_version": null, "observed_at": null,
      "price_blended_usd_per_mtok": 1.20,
      "price_note": "AA reference list price; not the subscription billing unit" }
  ] }

// Alias mapping — external AA id/variant -> backend-native id + concrete offered effort
{ "aliases": [
    { "external_id": "<aa-model-uuid>", "variant": "reasoning-high",
      "backend": "opencode-go", "native_model_id": "<backend-native-id>", "effort": "high" }
  ] }

// Subscription inventory + quota snapshot — synthetic; grouped by account pool
{ "account_pool": "<subscription-account-pool>", "backend": "opencode-go",
  "native_model_id": "<backend-native-id>", "available_efforts": ["low", "high"],
  "availability_evidence_at": "<synthetic-timestamp>",
  "billing": "subscription_quota",
  "usage": { "remaining_fraction": 0.08, "reset_at": "<synthetic-timestamp>",
             "last_checked_at": "<synthetic-timestamp>", "status": "known",
             "per_model_quota_weight": null },
  "status": "available" }

// Session decision (in-memory + telemetry)
{ "role": "balanced", "selected_candidate_id": "opencode-go/<backend-native-id>@high",
  "effort": "high",
  "reason": "avoided backend A: 8% left, reset 4 days; chose backend B's lowest adequate option",
  "decision_source": "jev" }
```

A benchmark record whose external ID has no alias entry is inert and cannot be selected. A name outside the eligible list is hard-rejected.

### 6.3 Quota-aware cost policy

JEV's input per subscription: remaining allowance / usage fraction when obtainable, `reset_at`, `last_checked_at` and an explicit unknown status, plus per-model/effort quota weight **only when documented or known**. Usage is read through adapters for backends that support authenticated usage; otherwise it is explicit `unknown` or an operator override with a timestamp. Candidates are grouped by subscription/account pool so models sharing one allowance are not treated as independently funded. No provider-specific API or weight is invented.

- **Hard ineligible:** quota exhausted, access rejected, or pair not proven offered. No paid API fallback outside the allowed subscriptions (OpenCode Go, Codex, Claude).
- **Soft scarcity:** low quota raises effective cost for that pool; a reset many days away is treated more conservatively than one resetting soon.
- **Refresh:** usage is read before decisions; a billed call updates the quota snapshot; model access and rate-limit errors force invalidation of the appropriate snapshot. Transient read failures stay distinct from access rejection.
- **Reserve:** where measurable, keep enough budget for review and retries.
- **Distinct units:** API dollar prices and subscription quota remain separate. For incomparable quota units, a configured operator preference/relative weight is exposed as a heuristic label — never a fictitious USD number. All unknowns stay unknown.

**Illustrative scenario (synthetic).** Two allowed pools: pool A is at 8% remaining and resets in 4 days; pool B is at 72% and resets in 2 days. For a balanced executor task, candidate `(A, model X@high)` has a lower AA reference price, and candidate `(B, model Y@medium)` is adequate but priced higher in USD. Because A is scarce with a distant reset, JEV applies the scarcity penalty and picks B's lowest adequate offered effort. The record reads: *"avoided backend A: 8% left, reset 4 days; chose backend B's lowest adequate option."* If B's cheapest adequate option were unlikely to succeed and a stronger B option fit the hard budget, JEV may choose the stronger B option rather than spend scarce A. Numbers and model names here are illustrative, not real observations.

### 6.4 Eligibility vs JEV adequacy

**Hard mechanical filters (not scoring):** exact access in the inventory; allowed backend (OpenCode Go, Codex, Claude); required context window; required tool support; offered effort; hard budget.

**JEV judgment:** benchmark/capability adequacy for the objective, acceptance criteria and role. Anchor scores are evidence the JEV decision may weigh, not an automatic gate.

The old 50/70/85 floors are LeanPi's own 0–100 scale and must not be compared to Artificial Analysis scores without a calibration result. Consequently `selectCheapestClearing` ([src/capability/select.ts:102](src/capability/select.ts#L102)) **cannot remain unchanged if its old-scale floor silently overrules JEV**; the recommendation is to reuse its candidate assembly and sorting hooks while replacing that semantic gate with the JEV decision. Effort variants are preserved as candidates — the pair `(model, offered effort)` is what JEV ranks, and effort is not forced before the choice.

### 6.5 Entry points and minimum wiring

The chosen model must exist at the last dispatch boundary of every supported entry point, and telemetry must prove the identity that actually ran ([src/telemetry/collect.ts:86-94](src/telemetry/collect.ts#L86-L94), [src/telemetry/emit.ts:96-99](src/telemetry/emit.ts#L96-L99)).

- **Native library session** (`createLeanPiSession().runTurn()`): resolve inventory + JEV before `setModel` ([src/commands/session.ts:141](src/commands/session.ts#L141)) and pass the chosen `(backend, model, effort)`.
- **Native interactive Pi** (`pi --extension`): LeanPi issues no `setModel` today, so this path cannot yet guarantee the choice. State the guarantee as covering the entry points where LeanPi controls dispatch, and record the limitation rather than promising a nonexistent SDK hook.
- **External lane** (`runExecutor`, [src/executor/lane.ts:170](src/executor/lane.ts#L170)): carry the JEV-selected exact identity in the worker packet so `modelFor` ([src/backends/worker.ts:161](src/backends/worker.ts#L161)) does not re-derive a different model.

The existing task/class matrix (§2.3) remains the current behavior table; it is not a new hard-coded model assignment.

**Reviewer.** The reviewer is independent whenever the eligible pool offers a different **canonical identity** (model plus revision), not merely a different backend name. If no alternative exists, the result is explicitly `degraded`. `FIX_REQUIRED`/`ESCALATE` must not be reported as `completed` (F2). The reviewer reuses the same decision with `role = review_*` and the executor identity as input (F4).

### 6.6 Cache and freshness policy

- **Path** under the existing XDG convention: `${XDG_CACHE_HOME:-~/.cache}/leanpi/benchmarks/aa-llms.json` (cf. [src/permissions/trust.ts:42](src/permissions/trust.ts#L42)). Benchmark metadata only; credentials never enter the JSON.
- **AA benchmark cache:** schema parses **and** `fetched_at` is within **14 days**. Refresh only when due, with a bounded timeout/backoff. Write temp then atomic rename.
- **Subscription model inventory:** refreshed at most every **6 hours**; a model access or rate-limit error invalidates the affected inventory snapshot immediately.
- **Quota snapshot:** refreshed at most every **30 seconds** and re-read before decisions; a billed call updates the quota snapshot.
- **Deduplicated refresh:** concurrent refreshes for the same key collapse into one in-flight request.
- **Failure:** retain last-known-good and label it `stale`; never replace a good snapshot with an empty one.
- **Cold start** with no key or no last-good cache is explicit `unavailable`, with no invented cached data.

### 6.7 Minimal acceptance checks

1. A scored model with no inventory/alias entry (e.g. a Gemini listed on a leaderboard) cannot be selected.
2. For a task with several eligible candidates, telemetry's executor/reviewer identity equals the cheapest JEV-capable `(model, offered effort)` pair, with cost policy and provenance logged.
3. Cache: fresh within 14 days used; stale labelled and not refreshed early; corrupt rejected; failed refresh keeps last known good; no key/cold start reports explicit unavailable.
4. Unknown quota/price is treated as unknown, never zero or "free"; an exhausted or unoffered pair is hard-ineligible; a name outside the eligible set is hard-rejected.
5. Reviewer independence uses a different canonical identity; `FIX_REQUIRED`/`ESCALATE` does not report `completed`.

---

## 7. Validation and honest limits

**Validation performed.** The 12 findings were traced through callers, guards and tests and each was classified by evidence. F1 is static; F2/F3/F4/F5/F7, B6, S1 and S2 are runtime-reproduced against built `dist/` with no network and no credentials (Appendix A); B1 and B4 are reproduced with minimal selector probes plus source traces; B3 is a static trace. The baseline suite was run during the broad pass: after `pnpm install --frozen-lockfile` and `pnpm build`, **92 files passed / 1 skipped; 469 tests passed / 3 skipped; 0 failed**. The four initial failures were an environment artifact (missing worktree dependencies and `tsc`) and disappeared with no source edit. Model-focused tests (9 files, 57 asserts) and capability tests (22) passed in the earlier model pass; those existing results were not re-run and are not used to claim the defects are covered. Findings are supported by logic-specific reproductions distinct from that baseline pass. Environment: Node v20.19.6, pnpm 10.25.0; no lockfile or manifest was edited.

**Honest limits.**

- No live provider, JEV endpoint, subscription or network was used. JEV-assisted answers are inferred from source; no report claim relies on a live model's behavior.
- The native interactive `pi --extension` host was not booted; its model is Pi's own selection (§2.1). The library `runTurn` path is not the interactive host.
- The adaptive router is unreachable at runtime (F1), so its internals are static-only; the effort-bucket ordering mismatch is latent and not counted.
- The G1–G4 gaps are assessed against the stated subscription contract; they are not claimed as independent regressions, and this report does not claim which models a real subscription serves.
- The benchmark cache and subscription inventory **do not exist in this codebase**; API-key availability was not checked and no authenticated Artificial Analysis fetch was performed.
- Coverage is partial by design. The context/telemetry/runtime subreview stopped without final results, so this report claims **no** coverage of that subsystem and does not claim exhaustive coverage overall.
- `evaluateProofGate` has no production caller, so its candidates (empty-criteria PASS, historical review PASS, accumulated evidence) were not carried. The native-fallback missing-guard candidate lacked a proven reachable config and was dropped.

---

## Appendix A — Minimal self-contained reproductions

All scripts import the built `dist/` only, use no network and no credentials, and run from the repo root after `pnpm build`. They use the OS temporary directory at runtime; no pre-created data directory is required. Permissions probes classify only; they perform **no** write outside their temporary fixture. The long harnesses from the broad pass are not required to repeat these results.

<details>
<summary>A.1 — Task-example classification (F1 example table / §2.4)</summary>

```js
import { compileTask } from "./dist/compiler/index.js";
const packet = (req, changed, modules, runners = ["vitest"]) => ({
  repository: { languages: ["typescript"], project_type: "single", package_manager: "pnpm", dirty: false },
  task: { user_request: req },
  workspace: { changed_files: changed, likely_modules: modules, test_runners: runners, lsp_available: true, git_branch: "main" },
});
const cases = [
  ["E1", "rename parseFoo to parseBar in src/target.ts", packet("rename parseFoo to parseBar in src/target.ts", ["src/target.ts"], ["src"])],
  ["E2", "fix the race condition in the scheduler", packet("fix the race condition in the scheduler", ["src/scheduler.ts"], ["src"])],
  ["E3", "update the auth token check", packet("update the auth token check", ["src/auth.ts"], ["src"])],
  ["E4", "migrate the database schema", packet("migrate the database schema", ["src/db/migrate.ts"], ["src/db"])],
  ["E5", "add streaming mode to the parser, spanning several modules", packet("add streaming mode to the parser, spanning several modules", ["src/parser/stream.ts", "src/parser/index.ts", "src/parser/reader.ts"], ["src/parser"])],
];
for (const [id, req, pkt] of cases) {
  const c = await compileTask(req, pkt);
  console.log(id, { gate: c.task.planning_decision, complexity: c.task.execution_complexity, risk: c.task.review_risk, exec: c.routing.executor_class, rev: c.routing.reviewer_class, rounds: c.limits.semantic_review_rounds });
}
```
</details>

<details>
<summary>A.2 — F2: verdict ignored while status is <code>completed</code></summary>

```js
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./dist/core/config.js";
import { BackendRegistry } from "./dist/backends/index.js";
import { runExecutor } from "./dist/executor/index.js";
const cwd = join(tmpdir(), "f2-" + Math.random().toString(36).slice(2));
mkdirSync(join(cwd, "src"), { recursive: true });
writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "f", version: "1.0.0", devDependencies: { vitest: "^3.0.0" } }));
writeFileSync(join(cwd, "src", "target.ts"), "export const value = 1;\n");
execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
execFileSync("git", ["config", "user.email", "f@e.com"], { cwd });
execFileSync("git", ["config", "user.name", "F"], { cwd });
execFileSync("git", ["add", "-A"], { cwd });
execFileSync("git", ["commit", "-q", "-m", "f"], { cwd });
const config = loadConfig(cwd, { configPath: null,
  backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
  models: { quick: { backend: "local", model: "cheap" }, balanced: { backend: "local", model: "mid" }, strong: { backend: "local", model: "big" } } });
const contract = { task: { type: "feature", prd_required: false, planning_decision: "DIRECT_EXECUTION", execution_complexity: "MEDIUM", review_risk: "R0", required_capability: { min_coding_index: 70 }, user_request: "do", objective: "do", acceptance_criteria: [{ id: "AC-1", text: "do" }] },
  routing: { executor_class: "balanced", executor_backend: "unresolved", reviewer_class: "review_quick" },
  reasoning: { effort: "medium" }, capabilities: { skills: [], mcps: [], lsp: false, rtk: "off" },
  context: { strategy: "targeted", budget_tokens: 12000 }, verification: { required: ["typecheck"] },
  limits: { execution_attempts: 1, max_escalations: 1, semantic_review_rounds: 1, isolation: "none" } };
const worker = async () => { writeFileSync(join(cwd, "src", "target.ts"), `export const value = ${Math.random()};\n`); return { status: "completed", backend: "local", result: { status: "ok", changedFiles: ["src/target.ts"], summary: "edited" }, attempts: [] }; };
const runner = async () => ({ status: "ok", changedFiles: [], summary: JSON.stringify({ decision: "FIX_REQUIRED", findings: [{ criterion: "AC-1", file: "src/target.ts", location: "3", severity: "error", evidence: "nope" }] }) });
const outcome = await runExecutor(contract, { registry: new BackendRegistry(config), cwd, config, worker, reviewRunner: runner,
  exec: async (command) => ({ command, exitCode: 0, stdout: "ok", stderr: "", timedOut: false, spawnError: null }),
  verifyCommands: { typecheck: "ok", targeted_test: "ok", git_status: "git status --porcelain" } });
console.log("status", outcome.status, "verdict", outcome.review.verdict.decision);
```
</details>

<details>
<summary>A.3 — F4 independence/selection and F5 reviewer-role fallback</summary>

```js
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./dist/core/config.js";
import { BackendRegistry } from "./dist/backends/index.js";
import { review } from "./dist/review/lane.js";
import { resolveRole } from "./dist/core/roles.js";
import { buildPacket } from "./dist/review/packet.js";
const cwd = join(tmpdir(), "f4-" + Math.random().toString(36).slice(2));
mkdirSync(join(cwd, "src"), { recursive: true });
writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n");
const config = loadConfig(cwd, { configPath: null,
  backends: { alpha: { type: "native", baseUrl: "http://127.0.0.1:1/v1", model: "same-id" }, beta: { type: "native", baseUrl: "http://127.0.0.1:1/v1", model: "other-id" } },
  models: { quick: { backend: "alpha", model: "same-id" }, balanced: { backend: "alpha", model: "same-id" }, strong: { backend: "alpha", model: "same-id" } } });
const { packet } = buildPacket({ objective: "review", acceptanceCriteria: [], cwd, changedFiles: ["src/a.ts"], evidence: [], executorSummary: "done" });
const seen = [];
const runner = async (pkt, backend) => { seen.push({ backend: backend.name, model: pkt.model }); return { status: "ok", changedFiles: [], summary: JSON.stringify({ decision: "PASS", findings: [] }) }; };
const a = await review(packet, "QUICK_REVIEW", "gate", { registry: new BackendRegistry(config), cwd, runner });
const b = await review(packet, "QUICK_REVIEW", "gate", { registry: new BackendRegistry(config), cwd, runner, executor: { backend: "alpha", model: "same-id" } });
console.log("F4 no identity:", seen[0], a.independence, "| with identity:", seen[1], b.independence);
const minimal = loadConfig(cwd, { configPath: null,
  backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
  models: { quick: { backend: "local", model: "cheap" }, balanced: { backend: "local", model: "mid" }, strong: { backend: "local", model: "big" } } });
console.log("F5 resolveRole:", resolveRole(minimal, "review_quick"));
const f5 = await review(packet, "QUICK_REVIEW", "gate", { registry: new BackendRegistry(minimal), cwd });
console.log("F5 review:", f5.verdict.decision, f5.backend, f5.model, f5.reason ?? f5.verdict.findings[0]?.evidence);
```
</details>

<details>
<summary>A.4 — F1 static inventory</summary>

```sh
rg -n "selectRoute\(" src                          # definition only
rg -n "withRouteCost\(|routeDescriptorOf\(|dispatchRequest\(" src   # router.ts only
rg -n "registerRoutingSites" src                   # sites.ts + router.ts; never activate
```
</details>

<details>
<summary>A.5 — F7: escalated attempt sends a byte-identical packet</summary>

```js
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./dist/core/config.js";
import { BackendRegistry } from "./dist/backends/index.js";
import { runExecutor } from "./dist/executor/index.js";
const cwd = join(tmpdir(), "f7-" + Math.random().toString(36).slice(2));
mkdirSync(join(cwd, "src"), { recursive: true });
writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "f", version: "1.0.0", devDependencies: { vitest: "^3.0.0" } }));
writeFileSync(join(cwd, "src", "target.ts"), "export const value = 1;\n");
for (const cmd of [["init", "-q", "-b", "main"], ["config", "user.email", "f@e.com"], ["config", "user.name", "F"], ["add", "-A"], ["commit", "-q", "-m", "f"]]) execFileSync("git", cmd, { cwd });
const config = loadConfig(cwd, { configPath: null, backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1", model: "mid" } },
  models: { quick: { backend: "local", model: "cheap" }, balanced: { backend: "local", model: "mid" }, strong: { backend: "local", model: "big" } } });
const jev = { fallbackCount: () => 0, ask: async (id) =>
  id === "executor.failure_classification" ? [{ kind: "Choice", questionId: "failure_category", choice: "assertion", probabilities: {}, confidence: 1 }]
  : id === "executor.retry_usefulness" ? [{ kind: "Score", questionId: "retry_useful", score: 3, legend: {}, confidence: 1 }]
  : [{ kind: "Choice", questionId: "escalation_category", choice: "INCREASE_REASONING", probabilities: {}, confidence: 1 }] };
const contract = { task: { type: "bugfix", prd_required: false, planning_decision: "DIRECT_EXECUTION", execution_complexity: "MEDIUM", review_risk: "R0", required_capability: { min_coding_index: 70 }, user_request: "fix", objective: "fix", acceptance_criteria: [{ id: "AC-1", text: "fix" }] },
  routing: { executor_class: "balanced", executor_backend: "unresolved", reviewer_class: "none" }, reasoning: { effort: "medium" },
  capabilities: { skills: [], mcps: [], lsp: false, rtk: "off" }, context: { strategy: "targeted", budget_tokens: 12000 },
  verification: { required: ["typecheck"] }, limits: { execution_attempts: 3, max_escalations: 2, semantic_review_rounds: 0, isolation: "none" } };
const packets = [];
const worker = async (pkt) => { packets.push(structuredClone(pkt)); writeFileSync(join(cwd, "src", "target.ts"), `export const value = ${packets.length};\n`); return { status: "completed", backend: "local", result: { status: "ok", changedFiles: ["src/target.ts"], summary: "edited" }, attempts: [] }; };
const exec = async (command) => ({ command, exitCode: 1, stdout: "", stderr: "AssertionError: expected 1 to be 2", timedOut: false, spawnError: null });
const out = await runExecutor(contract, { registry: new BackendRegistry(config), cwd, config, worker, jev, exec,
  verifyCommands: { typecheck: "x", targeted_test: "x", git_status: "git status --porcelain" } });
console.log(out.status, out.escalations, JSON.stringify(packets[1]) === JSON.stringify(packets[2]));
```
</details>

<details>
<summary>A.6 — F3: <code>models.specialists</code> rejected on the real config-file path</summary>

The defect is only reachable through `parseModels`; passing `models` via `loadConfig`'s `overrides` argument bypasses the parser, because `...overrides` is spread last ([src/core/config.ts:298](src/core/config.ts#L298)). Reproduce with a real file at the config filename, then call `loadConfig(cwd)` — no overrides:

```js
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./dist/core/config.js";
const cwd = join(tmpdir(), "f3-" + Math.random().toString(36).slice(2));
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "leanpi.config.yaml"), `backends:
  local:
    type: native
    baseUrl: "http://127.0.0.1:1/v1"
models:
  quick: { backend: local, model: cheap }
  balanced: { backend: local, model: mid }
  strong: { backend: local, model: big }
  specialists:
    rust: strong
`);
try {
  console.log("loaded", Object.keys(loadConfig(cwd).models));
} catch (e) {
  console.log("ERROR:", e.message);
}
```

Observed output after `pnpm build`: `ERROR: models.specialists: unknown model role "specialists"` — the same `ConfigError`, now produced through the operator path rather than a bypassed parser.
</details>

<details>
<summary>A.7 — B1/B4: selector has no targeted scope and never widens without a diff</summary>

```js
import { selectVerifiers, regressionScopeRule } from "./dist/verify/select.js";
console.log("B4 regressionScopeRule(undefined) =", regressionScopeRule(undefined));
const selection = await selectVerifiers({ verification: { required: ["affected_tests"] } });
console.log("B1 descriptors =", selection.descriptors.map((d) => ({ kind: d.kind, command: d.command, scope: d.scope })));
console.log("B4 regressionScope =", selection.regressionScope);
```

Observed: `regressionScopeRule(undefined) = TARGETED_SUFFICIENT`; `targeted_test` descriptor `{ command: "", scope: "" }`; `regressionScope = TARGETED_SUFFICIENT`.
</details>

<details>
<summary>A.8 — S1/S2/B6: permissions classifier probes (classification only, temp fixtures)</summary>

```js
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapesRoot, classifyScopes } from "./dist/permissions/rules.js";

// S1 — dangling/new leaf under an out-of-root symlink
const root = mkdtempSync(join(tmpdir(), "s-root-"));
const outside = mkdtempSync(join(tmpdir(), "s-outside-"));
symlinkSync(outside, join(root, "link"));
writeFileSync(join(outside, "existing.txt"), "x\n");
console.log("S1 new leaf =", escapesRoot(root, "link/new.txt"));           // false -> fails open
console.log("S1 existing =", escapesRoot(root, "link/existing.txt"));      // true  -> correct deny
console.log("S1 scopes =", classifyScopes({ toolName: "write", input: { path: "link/new.txt" } }, root).map((s) => s.scope));

// S2 — destructive/network classification by flag order (commands are NOT executed)
for (const command of ["git clean -fd", "git clean -f -d", "git clean --force -d", "git -C . push --force", "git push origin +main"])
  console.log("S2", JSON.stringify(command), "=>", classifyScopes({ toolName: "execute", input: { command } }, root).map((s) => s.scope).join("+"));

// B6 — symlinked root makes a legitimate in-root relative path look external
const real = mkdtempSync(join(tmpdir(), "b6-real-"));
writeFileSync(join(real, "a.txt"), "x\n");
const linkRoot = join(tmpdir(), "b6-link-" + Math.random().toString(36).slice(2));
symlinkSync(real, linkRoot);
console.log("B6 linkRoot escapes =", escapesRoot(linkRoot, "a.txt"));       // true  -> false deny
console.log("B6 realRoot escapes =", escapesRoot(real, "a.txt"));           // false
```

Observed: `S1 new leaf = false`, `S1 existing = true`, `S1 scopes = ["edit"]`; `git clean -fd` = shell+git_destructive, `git clean -f -d` = shell, `git clean --force -d` = shell, `git -C . push --force` = shell, `git push origin +main` = shell+network; `B6 linkRoot escapes = true`, `B6 realRoot escapes = false`.
</details>

---

## Highest-leverage bounded fixes

1. **Act on the reviewer verdict and count `semantic_review_rounds` in `runExecutor` (F2).** Restores the reviewer's authority over completion and is the direct prerequisite for the proposed reviewer contract.
2. **Wire `selectRoute` into the executor lane or remove the cost-routing claim (F1).** The single change that makes the advertised cost-aware path real; it is also the natural home for the JEV model-choice site.
3. **Give `affected_tests` a concrete scope/command and pass a `diff` (B1, B4)** — without it the external-harness mode cannot complete, and regression widening stays unreachable.
4. **Fix `escapesRoot` for both the unresolvable-leaf fail-open (S1) and the symlinked-root false deny (B6), and make the destructive-git classifier argv-aware (S2).** Security-scope correctness; none is subsumed by another.
5. **Accept `models.specialists` with its proper shape and validation (F3), pass the executor identity into `runReview` (F4), and resolve the reviewer model through the `resolveRole` chain before dispatch (F5).**

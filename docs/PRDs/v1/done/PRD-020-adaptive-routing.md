# PRD-020 — Adaptive Routing & Quota Pricing

**Status:** DONE (verified 2026-09-19)
**Complexity:** 4 (MEDIUM)
**Risk override:** none — routing governs spend, but the spend risk is covered directly by the effective-cost and shadow-price ACs rather than by a tier bump; no security boundary or destructive migration is involved.
**Owner:** joao
**Depends on:** PRD-002, PRD-008, PRD-015, PRD-024

## Context

**Covers:** FR-047, FR-048, FR-056; ROADMAP §14, §25, §26, §27, §52, §60.

Problem. A subscription call can cost almost nothing today and still burn scarce quota that a harder task will need this afternoon. Without a price on that scarcity, the cheapest-looking choice is always the premium subscription, which is exactly the failure ROADMAP §26 names: *"Use Opus for everything because the subscription is already paid."* The §14 matrix gives a static default route; §14 also lists the inputs a router MAY deviate on — quota reserves, historical task performance, language specialization, latency, backend failures — with no mechanism behind them. This PRD supplies that mechanism.

Current behavior. The repository is greenfield: `docs/PRDs/v1/ROADMAP.md` is the only file. There is no router to extend yet. PRD-004 creates the execution contract and the §14 matrix defaults (including the `required_capability` annotation a task carries, `{ min_coding_index, specialization? }`); PRD-008 creates the backend registry and dispatch to native and external-harness workers (`type: native | external_harness`); PRD-015 creates the §52 telemetry record, which is the only source of historical LeanPi data; PRD-024 ships LeanPi's own **static bundled** model ranking (`src/capability/models.json`, records carrying `coding_score`, prices, `speed_tier`, `context_window`, `updated_at`) — a file in the package, with no fetch, no API key and no refresh command; PRD-002 creates the JEV client and the decision-site registry.

The §10 closing note matters here: thresholds must be calibrated from real LeanPi runs, not from the illustrative numbers in the roadmap. Every constant this PRD would otherwise hardcode — retry rates, latency penalties, per-bucket model adequacy — is derived from the telemetry store at runtime, with an explicit, recorded fallback when history is too thin.

Files inspected: `docs/PRDs/v1/ROADMAP.md` §14 (default matrix and deviation inputs), §25 (backend pools, `quota_class`, `marginal_cost`), §26 (the `effective_cost` formula), §27 (role configuration), §34 (escalation categories), §52 (telemetry record fields), §60 (P1: quota shadow pricing, specialist models, semantic retry classification, historical router calibration), §51 Models and Subscriptions FR blocks.

## Solution

One scorer, one selection rule. `predictRouteCost()` in `src/compiler/route-cost.ts` implements ROADMAP §26 as a **pre-dispatch prediction**:

```text
route_cost = monetary + quota_shadow + local_compute + latency + predicted_retry
```

This is an estimate used to rank candidates before anything runs. It is deliberately *not* named `effective_cost`: PRD-015 owns that name for the measured post-hoc value (`api_usd + jev_usd + quota_shadow_cost + local_compute_cost + latency_penalty`), and this PRD neither recomputes it nor changes what `/cost` prints. The five predicted terms are persisted as the `route_cost` block on the run's telemetry record — the block PRD-015 declares and this PRD owns — so a routing decision is auditable without a measurement and a prediction ever being summed together.

Each term comes from an existing source rather than a new subsystem: monetary from the bundled ranking's price (PRD-024) times predicted tokens; quota shadow from `cost.quota_shadow_usd[quota_class]` — the same single config key PRD-015 prices `estimated_quota_cost` from, so the scarcity price the router scored with is the one telemetry records, and there is no per-backend shadow setting; local compute from measured GPU/CPU seconds in telemetry; latency from the backend's observed p50 in telemetry times a configurable seconds-to-cost weight; predicted retry from the calibrated per-bucket retry rate times the cost of one more attempt.

Selection is deterministic and ordered:

1. **Capability filter (PRD-024's, not a second one).** The contract's `required_capability` (`{ min_coding_index, specialization? }`, produced by PRD-004) is handed to `selectCheapestClearing()` in `src/capability/select.ts`, which compares it against each record's `coding_score` in the bundled ranking and returns the candidates that clear the bar — or, when nothing clears, a `capability_gap` and **no selection**. PRD-024 never downgrades to a below-bar model, and this PRD never scores a model PRD-024 did not return, so "cheapness buys an inadequate model" is structurally unreachable rather than forbidden by convention. A `capability_gap` escalates per §34 and is surfaced on the route record and in `/route`; it never resolves to a dispatch.
2. **Specialist preference (FR-047).** If `models.specialists` binds the task's language/task type to a role, that role's candidates are preferred within the clearing set; absent an entry, the generic `quick`/`balanced`/`strong` role from the §14 matrix applies.
3. **Cheapest clearing candidate wins.** Among the candidates PRD-024 returned, lowest `route_cost` is selected. PRD-024 supplies the clearing set; this PRD ranks it. Plain arithmetic, and it makes the final choice in every configuration.

Consumer flow:

> user issues a task → compiler produces the execution contract with `required_capability` (PRD-004) → `selectRoute()` takes the clearing candidate set from PRD-024's `selectCheapestClearing()`, applies specialists, scores each with `predictRouteCost()` → PRD-008 dispatches to the chosen backend with the chosen reasoning effort → the user observes which backend/model ran and inspects the five predicted terms in the run's `route_cost` block (and `/route`), while `/cost` keeps showing PRD-015's measured `effective_cost`.

Adaptive reasoning effort (FR-048) rides the same dispatch: classified complexity maps to an effort level, which PRD-008's worker translates into the backend's own parameter — and omits entirely for backends that have none. Higher effort raises predicted tokens, so it feeds back into `route_cost` rather than being a free knob.

Calibration and semantic retry classification (ROADMAP §60) are two small readers over PRD-015's telemetry, in `src/compiler/calibration.ts`. Calibration buckets completed runs by (role, complexity, backend) and derives the retry rate and latency p50 used above; with fewer than the configured minimum runs in a bucket it returns the §14 matrix default and records `calibration: insufficient-history` so the reason is visible instead of silently baked in. Retry classification compares a failed attempt's failure signature against the run's prior attempts and the historical set, producing a class that changes the *next* route — a repeated signature moves the route (different backend or higher effort) instead of re-dispatching the same configuration. The retry *loop and its ceilings* remain PRD-007's; this PRD only supplies the routing consequence.

Ponytail notes: no strategy interface and no pluggable pricing engine — one prediction function, one selection function, configuration for the values that genuinely vary per user. No second cost formula: the measured one is PRD-015's and is not reimplemented here. No new command surface; the decision is observable through the `route_cost` block on the run record (PRD-015's shape, this PRD's block) and the dispatched backend.

Relevant non-goals restated from ROADMAP §58: no generative router replacing JEV — selection is deterministic arithmetic over config, the bundled ranking and telemetry, and JEV never makes the final pick; no vendor-limit bypass — quota shadow pricing *respects* scarcity, it does not evade it, and no credential or rate-limit handling is added here; no mandatory cloud models — a local backend with `marginal_cost: 0` and a zero shadow price for its `quota_class` stays a first-class candidate whenever it clears `required_capability`; no JEV requirement for basic operation — every site below has a deterministic fallback that ships enabled.

## External Skill Dependencies

None.

## JEV Decision Sites

| Decision | Atomic question(s) | Return type (Choice/Score/Noul) | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| `routing.quota_preference` — ordering among alternatives that already clear `required_capability` and sit within the configured `route_cost` tie band | "Candidates A and B both meet the capability bar for this task; which is more likely to succeed on the first attempt?" | Choice (candidate id) with confidence | Lowest `route_cost` wins; ties broken by configured backend priority. Deterministic quota math makes the final choice in both cases — the site can only reorder within the tie band | ★★★☆☆ |
| `routing.reasoning_effort` — effort level for the dispatched attempt | "For this contract at complexity `<c>` with `<evidence summary>`, is minimal / low / medium / high effort the cheapest level likely to succeed?" | Choice (`minimal` \| `low` \| `medium` \| `high`) with confidence | Complexity→effort table from the §14 matrix defaults, adjusted by the calibrated retry rate for the bucket | ★★★★☆ |
| `routing.delegation_worth` — whether a sub-unit is worth delegating to a separate worker rather than running inline | "Does splitting this contract into `<n>` declared independent slices save more than the extra dispatch and context cost?" | Choice (`delegate` \| `inline`) with confidence | Inline unless the contract declares independent slices above the configured threshold; §58's "no default multi-agent swarms" keeps inline the bias | ★★★☆☆ |

All three sites register with PRD-002's decision-site registry (id, question set, return type, `consequence` class, non-null fallback, telemetry tag) — `routing.quota_preference` and `routing.delegation_worth` at `low`, `routing.reasoning_effort` at `normal`. Below-threshold confidence, a disabled site, or an unavailable JEV takes the fallback and sets `fallback_used` in the telemetry row.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: After a task runs, the run's telemetry record carries a `route_cost` block for the selected candidate with all five predicted §26 terms (`monetary`, `quota_shadow`, `local_compute`, `latency`, `predicted_retry`) summing to the recorded predicted total; that block is distinct from `cost.effective_cost`, which `/cost` still renders from PRD-015's measurement unchanged (the two values are asserted to be independently stored, not derived from one another) — Evidence: tests/routing/cost.test.ts — the run's telemetry record carries a `route_cost` block with all five predicted terms plus the total.
- [x] AC-2 [local; actor: agent]: On the fixture telemetry set, a medium task routes to the scarce-premium subscription backend at the baseline `cost.quota_shadow_usd['scarce-premium']`; raising that class price re-routes the identical task to the cheaper clearing backend, and restoring the baseline restores the original choice — the same key PRD-015 prices `estimated_quota_cost` from, so the router and the record cannot disagree — Evidence: tests/routing/cost.test.ts — on the fixture telemetry set a medium task routes to the scarce-premium subscription backend at the baseline quota shadow price.
- [x] AC-3 [local; actor: agent]: Two tasks of identical complexity in different languages dispatch to the models bound by `models.specialists` for their language/task type; removing the specialist entries makes both dispatch to the generic matrix role instead — Evidence: tests/routing/router.test.ts — two tasks of identical complexity in different languages dispatch to the models bound by `models.specialists` for their languages.
- [x] AC-4 [local; actor: agent]: The reasoning effort in the dispatched request scales with classified complexity (low → minimal, high → high) as observed in the request PRD-008's worker actually issues, and a backend declaring no effort support receives no effort parameter and still executes — Evidence: tests/routing/router.test.ts — the reasoning effort in the dispatched request scales with classified complexity (low → minimal, high → high) as observed in the emitted request.
- [x] AC-5 [local; actor: agent]: With all three JEV sites disabled, routing, effort and delegation decisions are unchanged from their deterministic fallbacks and zero JEV calls are issued; enabling `routing.quota_preference` with a confident answer inside the tie band changes which clearing candidate is dispatched, while an answer naming a candidate outside the set `selectCheapestClearing()` returned is ignored; and when no model clears `required_capability`, PRD-024 returns a `capability_gap` with no selection, the router escalates, the gap is recorded on the route record, and no below-bar model is dispatched — Evidence: tests/routing/router.test.ts — with all three JEV sites disabled, routing, effort and delegation decisions are identical to their deterministic fallbacks.
- [x] AC-6 [local; actor: agent]: the `predicted_retry` term for a (role, complexity, backend) bucket is derived from the fixture telemetry set's observed retry outcomes — mutating those outcomes changes the predicted value and can change the selected backend — and a bucket with fewer runs than the configured minimum falls back to the matrix default with `calibration: insufficient-history` recorded on the run; no retry-rate literal exists in the source — Evidence: tests/routing/calibration.test.ts — the `predicted_retry` term for a (role, complexity, backend) bucket is derived from the fixture telemetry set's observed outcomes, and falls back to the shipped default with insufficient history.
- [x] AC-7 [local; actor: agent]: When a second attempt's failure signature matches the first, the next dispatch differs from the repeated configuration (different backend or higher effort) and the run record carries the failure class that caused it; an unrelated new failure signature leaves the route unchanged — Evidence: tests/routing/calibration.test.ts — when a second attempt's failure signature matches the first, the next dispatch differs from the repeated configuration and carries the escalation category.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Predicted route-cost scoring | Task dispatch → `selectRoute()` in `src/compiler/route.ts` (created in PRD-004, scoring wired in Phase 1) → `predictRouteCost()` in `src/compiler/route-cost.ts` (created in Phase 1) | Replaces the bare §14 matrix lookup as the selection rule; the matrix becomes the fallback default, not a parallel path. Measured cost stays PRD-015's `effective_cost` — this is a second *quantity*, not a second implementation of the same one | AC-1, AC-2 |
| Quota shadow configuration | Session config load → `cost.quota_shadow_usd[quota_class]` in `src/core/config.ts` (created in PRD-001, the key PRD-015 already prices from; this PRD becomes its writer in Phase 1) | Single scarcity setting shared with telemetry; no per-backend shadow field is introduced | AC-2 |
| Capability-filtered candidates | `selectRoute()` → `selectCheapestClearing()` in `src/capability/select.ts` (created in PRD-024, consumed in Phase 1) over the bundled `src/capability/models.json` ranking, against the contract's `required_capability` (created in PRD-004) | Replaces unrestricted candidate sets; no ranking, fetch or cache is designed here, and the below-bar case returns a `capability_gap` rather than a selection | AC-5 |
| Specialist role binding | `selectRoute()` → `models.specialists` map in `src/core/config.ts` (field added in Phase 2) | Replaces language-blind role selection; generic roles remain the fallback | AC-3 |
| Adaptive reasoning effort | `selectRoute()` → dispatch request built by the worker in `src/backends/` (created in PRD-008, effort plumbed in Phase 3) | Replaces a fixed per-role effort; backends without effort support keep their current request shape | AC-4 |
| JEV routing sites | Route selection → sites registered with `src/jev/registry.ts` (created in PRD-002, registered in Phases 2–3) | Adds confidence-gated reordering above deterministic math; fallbacks remain the shipped path | AC-5 |
| Historical calibration and retry classification | Task dispatch and post-attempt re-route → `src/compiler/calibration.ts` (created in Phase 4) reading the telemetry store (created in PRD-015) | Replaces hardcoded retry/latency constants — the constants are deleted, not shadowed; PRD-007 keeps the retry loop itself | AC-6, AC-7 |

## Execution Phases

#### Phase 1: Predicted route cost, quota shadow pricing, capability filter
**Status:** DONE (verified 2026-09-19)
**ACs:** AC-1, AC-2
**Files:** `src/compiler/route-cost.ts` (new — the five-term predicted scorer and its inputs); `src/compiler/route.ts` (edit — take the clearing set from `selectCheapestClearing()`, then select minimum `route_cost`); `src/core/config.ts` (edit — `cost.quota_shadow_usd[quota_class]` writer side, latency-to-cost weight, tie-band width); `src/telemetry/record.ts` (edit — persist the `route_cost` block PRD-015 declares for this PRD on the run record); `tests/routing-cost.test.ts` (new); `tests/fixtures/telemetry/` (new — recorded LeanPi runs used as the calibration/fixture set).
**Implementation:** Terms are computed from the bundled ranking's price, the configured `quota_shadow_usd` class price, measured local compute, observed latency, and the calibrated retry rate (Phase 4 supplies the calibrated value; Phase 1 consumes the matrix default through the same accessor so no literal is introduced twice). Candidates come only from `selectCheapestClearing()`, so a below-bar model is never in the scored set at all; when that call returns a `capability_gap` the router escalates per §34 and records the gap — it never downgrades. Nothing here writes `cost.effective_cost`: the record's measured block stays PRD-015's.
**Verification:** E1 — vitest through `selectRoute()` on the fixture telemetry set: assert the persisted `route_cost` block's five terms sum to its recorded predicted total, and that `cost.effective_cost` on the same record is PRD-015's measured value and is unchanged by this path (AC-1); assert baseline config selects the scarce-premium backend, that raising `cost.quota_shadow_usd['scarce-premium']` selects the cheaper clearing backend, and that restoring the baseline restores the first choice (AC-2). The both-directions assertion is the negative control — a scorer ignoring the shadow term fails the middle case.
**Checkpoint:** done

#### Phase 2: Specialist model roles
**Status:** DONE (verified 2026-09-19)
**ACs:** AC-3
**Files:** `src/core/config.ts` (edit — `models.specialists` keyed by language/task type onto roles); `src/compiler/route.ts` (edit — apply specialist preference inside the clearing candidate set).
**Implementation:** Specialists are a preference within the set `selectCheapestClearing()` returned, never an override of it: a specialist model absent from that set (below `min_coding_index` on its `coding_score`, or unlisted in the ranking) is skipped and the generic role is used. Unknown languages fall through to the §14 matrix role with no error.
**Verification:** E2 — vitest through `selectRoute()` with two same-complexity contracts in different languages: assert each dispatches to its bound specialist model id, assert removing the entries makes both dispatch to the generic role, and assert a specialist bound to a below-bar ranking entry is skipped in favor of a clearing generic model (AC-3).
**Checkpoint:** done

#### Phase 3: Adaptive reasoning effort and the JEV routing sites
**Status:** DONE (verified 2026-09-19)
**ACs:** AC-4, AC-5
**Files:** `src/compiler/route.ts` (edit — complexity→effort default table, tie-band consultation of `routing.quota_preference`, `routing.delegation_worth` gate); `src/backends/` worker request builders (edit — translate effort to each backend's parameter, omit where unsupported); `src/core/config.ts` (edit — per-site enable flags and `consequence` classes).
**Implementation:** Effort feeds predicted tokens back into `predictRouteCost()` so a higher effort must justify itself. All three sites go through PRD-002's registry with their non-null fallbacks declared at registration; the router calls the registry, never the JEV client directly. Site answers may reorder candidates only inside the configured `route_cost` tie band and only among candidates already returned by `selectCheapestClearing()`.
**Verification:** E3 — vitest asserting the effort parameter present in the request the PRD-008 worker actually builds for low and high complexity contracts, and absent (with successful dispatch) for a backend declaring no effort support (AC-4). E4 — same entry point with all sites disabled: assert decisions equal the deterministic fallbacks and the JEV client received zero calls; then with `routing.quota_preference` enabled and a confident stubbed answer inside the tie band, assert the dispatched candidate changes; with the answer naming a candidate outside the clearing set, assert it is ignored; and with a contract no model clears, assert the recorded `capability_gap`, the escalation, and that no dispatch occurred (AC-5).
**Checkpoint:** done

#### Phase 4: Historical calibration and semantic retry classification
**Status:** DONE (verified 2026-09-19)
**ACs:** AC-6, AC-7
**Files:** `src/compiler/calibration.ts` (new — bucketed retry-rate and latency derivation from the telemetry store, failure-signature classification, next-route adjustment); `src/compiler/route.ts` (edit — consume calibrated values and the retry class); `tests/routing-calibration.test.ts` (new).
**Implementation:** Buckets are (role, complexity, backend) over completed runs in PRD-015's store; below the configured minimum sample count the matrix default is returned with `calibration: insufficient-history` recorded on the run. Failure signatures are normalized deterministically (command, exit status, first failing assertion/location) before comparison; a repeated signature yields a class that maps to a route change (switch backend or raise effort, per §34's escalation categories), while a new signature leaves the route to the ordinary scorer. The retry ceiling and loop control stay in PRD-007.
**Verification:** E5 — vitest over the fixture telemetry set: assert the derived retry rate for a bucket matches the fixture's observed outcomes, assert mutating those outcomes changes the predicted value and flips the selected backend for a borderline task, assert a thin bucket returns the matrix default with the recorded reason, and grep the source to assert no retry-rate literal exists (AC-6). E6 — drive two attempts with a matching failure signature through the router: assert the second dispatch differs from the first configuration and the run record carries the failure class; then drive an unrelated new signature and assert the route is unchanged (AC-7).
**Checkpoint:** done

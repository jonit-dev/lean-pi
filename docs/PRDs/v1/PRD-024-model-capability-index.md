# PRD-024 — Model Capability Index

**Status:** NOT STARTED
**Complexity:** 5 (MEDIUM)
**Owner:** joao
**Depends on:** PRD-001, PRD-008, PRD-015
**OWNER-GATE:** AC-7 (live Artificial Analysis fetch) requires joao's real `AA_API_KEY`; every other AC is local and offline.
Risk override: none — read-only external HTTP GET, no credentials stored, no destructive migration; the live-fetch check (AC-7) requires a real `AA_API_KEY` and is owner-run, every other check is local and network-free.

## Context
**Covers:** none (new slice); ROADMAP §14, §23, §27, §51 Models FR block (consumed, not owned)

The repository is greenfield: `docs/PRDs/v1/ROADMAP.md` is the only artefact and every path named below is created by this PRD's phases.

PRD-001 maps the six logical roles (`quick`, `balanced`, `strong`, `specialist`, `review_quick`, `review_strong`) onto `BackendRef` entries by hand. That mapping answers "which backend and model does this role name" but not "is this model actually strong enough" or "what is the cheapest model that clears the bar". With no published capability data, a `strong` role is a guess about model quality, `required_capability` has no metric to attach to, and the router cannot honour ROADMAP §14 (complexity → Quick/Balanced/Strong) or §6.6/§27 (roles, never vendor names) with any evidence behind the choice.

Consumers that need this data:

- PRD-004's `ExecutionContract` and PRD-012's PRD work unit want `required_capability` (minimum coding index, optional specialization) expressed as a number, so routing stops depending on an executor's self-description.
- PRD-008's backend entries supply the reachable model/backend bindings; a capability record with no binding is visible but not selectable.
- PRD-015 already owns money; this PRD supplies the blended price and snapshot date in the same per-million-token basis so routing and cost telemetry cannot disagree.
- PRD-016 owns `/models`; this PRD only feeds it score, price and role-fill columns.

Verified upstream sources, used as-is (nothing else is invented). Two of them, because the keyed API is not always available:

- **Keyed JSON API (preferred):** base `https://artificialanalysis.ai/api/v2`, endpoint `GET /data/llms/models`, auth header `x-api-key` read from env `AA_API_KEY`; the free tier returns medians only and some fields are Pro-tier only.
  Fields consumed: `id`, `name`, `slug`, `model_creator`, `release_date`; evaluations `artificial_analysis_intelligence_index`, `artificial_analysis_coding_index`, `artificial_analysis_math_index`; pricing `price_1m_input_tokens`, `price_1m_output_tokens`, `price_1m_blended_3_to_1`; performance `median_output_tokens_per_second`.
- **Keyless public leaderboard (fallback):** `GET https://artificialanalysis.ai/leaderboards/models` returns HTTP 200 with a Next.js RSC payload (`self.__next_f` chunks) that embeds per-model records keyed `slug`, `intelligenceIndex`, `intelligenceIndexCostPerTask`, `intelligenceIndexIsEstimated` — verified present for ~650 models on 2026-09-18. This path needs no key and no account, and it is the source a user with no `AA_API_KEY` gets. It is structurally brittle by nature: it is parsed defensively, a parse failure is a non-event that leaves the existing cache intact, and `intelligenceIndexIsEstimated` is carried through so an estimated score is never presented as measured.

## Solution

One module, `src/capability/`, offline-first by construction.

**Data model.** `src/capability/schema.ts` declares `ModelCapability` and `CatalogSnapshot { snapshot_date, source: 'live' | 'cache' | 'bundled', models: ModelCapability[] }`. `ModelCapability` carries `model_id`, `name`, `slug`, `model_creator`, `release_date`, `coding_index`, `intelligence_index`, `math_index`, `blended_price`, `price_1m_input`, `price_1m_output`, `median_output_tokens_per_second`, and `backend_binding: BackendRef | null` matched against PRD-001/PRD-008 config at load time and never persisted. Every numeric field is `number | null`: a free-tier or Pro-only omission is "unknown", never zero, because zero would read as "free and incapable" and corrupt selection.

**Catalog resolution order** (`src/capability/catalog.ts`) — read path, never touches the network:

1. on-disk cache `.leanpi/capability/catalog.json` when present and schema-valid;
2. otherwise the bundled snapshot `src/capability/fallback.json` shipped in the package.

**Refresh order** (`src/capability/refresh.ts`) — explicit, and the only code that may hit the network:

1. keyed API when `AA_API_KEY` resolves — full field set;
2. otherwise the keyless leaderboard page — `slug` + `intelligenceIndex` (+ estimated flag, cost-per-task), price and throughput left null;
3. otherwise nothing changes: the prior cache stays byte-identical and the failure is reported to the caller only.

Refresh is triggered by `npm run capability:refresh`, by `/models --refresh`, and opportunistically at most once per TTL window when a session starts with a stale cache and `capability.autoRefresh` is on (default on, hard-disabled by the network permission scope in PRD-017). Never on the hot routing path, never blocking: a session starting with a stale cache routes from the stale snapshot immediately and adopts the refreshed one on the next load.

Network is never required to start a session, and an absent or invalid `AA_API_KEY` degrades to the keyless source, then to cache, then to the bundled snapshot — it can never break routing. `loadCatalog()` returns the snapshot plus a staleness report `{ stale, age_days, snapshot_date, source }` from the configured TTL (`capability.ttlDays`, default 14); the report is always carried, so a stale snapshot is surfaced and never silently trusted.

**Consumer flow.**

```text
resolveRole(role) [PRD-001]
  → selectRoleModel()  src/capability/select.ts
      → loadCatalog()  src/capability/catalog.ts
      → cheapest bound model clearing the role's index floor and price ceiling
  → BackendRef

ExecutionContract.required_capability [PRD-004] / PRD work unit [PRD-012]
  → selectCheapestClearing()

/models [PRD-016]  ←  capabilityRows()  src/capability/feed.ts
```

**Role binding** (`src/capability/roles.ts`). `capability.roles.<role>` in config carries `min_coding_index`, `max_blended_price` and optional `pin`. A pin resolves the role to the named model and always wins; if the pinned model is unbound or below the role floor, resolution still returns it but reports the shortfall rather than silently swapping. Without a pin, selection is the cheapest bound model clearing both bounds, tie-broken by higher coding index then model id for a deterministic result. The bundled snapshot guarantees a non-empty catalog, so role resolution never fails for want of network.

**required_capability.** A task may set `required_capability: { min_coding_index, specialization? }`. `selectCheapestClearing(catalog, requirement)` keeps models whose coding index is known and at or above the bar (matching the specialization when given) and takes the cheapest. When nothing clears, it escalates to the highest-index bound model and returns a `capability_gap` with the shortfall — a visible escalation, not a silent weaker pick and not a hard failure.

**Fetch, optional, two sources.** `src/capability/fetch.ts` exposes `fetchFromApi({ apiKey, baseUrl, fetchImpl })` — one `GET /data/llms/models` with the `x-api-key` header, documented fields mapped, absent fields null — and `fetchFromLeaderboard({ url, fetchImpl })`, which GETs the public leaderboard page, extracts the embedded `self.__next_f` payload, and reads per-model `slug` / `intelligenceIndex` / `intelligenceIndexIsEstimated` / `intelligenceIndexCostPerTask`. The parser is defensive by contract: unknown shape, zero extracted models, or a row count below `capability.minLeaderboardRows` (default 50) is treated as a failed refresh, not as an empty catalog. Both return a `CatalogSnapshot` tagged with its `source`, so a record's provenance and field completeness are inspectable rather than assumed. `src/capability/refresh.ts` validates and atomically rewrites the cache (temp file + rename); any failure on any source leaves the prior cache byte-identical. The key is read from `AA_API_KEY` at call time only, never stored, never logged.

**Staleness and caching.** The cache is the normal steady state: `capability.ttlDays` (default 14) decides staleness, every record and snapshot carries `snapshot_date` and `source`, and `/models` renders both. A stale catalog is reported with its age and still used; it is never presented as current and never silently re-fetched on the routing path. Leaderboard-sourced rows carry their estimated flag and their null price fields honestly — a null price means "unknown", so such a model is still selectable by index but cannot win a cheapest-price comparison on fabricated data.

**Non-goals (scope + §58).** No headless browser and no DOM rendering — the leaderboard path reads the payload the page already ships, and if that payload shape changes the refresh fails loudly instead of guessing. No polling loop or background daemon: refresh is explicit or at most once per TTL window at session start. No vendor-name comparisons in routing logic, only catalog metrics. No local model benchmarking (PRD-021 owns that). No key storage inside LeanPi beyond reading `AA_API_KEY` from the environment; the key is never written to the cache or logs.

**Risks.** (1) Index thresholds are only as meaningful as the snapshot they were tuned against, so threshold changes are evaluated against a dated fixture and the staleness report is always visible. (2) Free-tier or leaderboard rows with null indexes can never clear a numeric bar, so they are excluded from automatic selection but stay visible in `/models` and selectable by an explicit pin. (3) A malformed cache must not empty the catalog — schema validation falls back to the bundled snapshot instead of throwing. (4) The leaderboard payload is an undocumented internal shape and will eventually change; the row-count floor plus cache-preserving failure keep that breakage from degrading routing, and the keyed API stays the preferred source.

## External Skill Dependencies
None.

## JEV Decision Sites
This PRD owns no decision site.

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| None — model choice here is arithmetic over catalog records (minimum blended price subject to `coding_index ≥ required_capability`), not a semantic judgement. Task→capability classification belongs to PRD-004/PRD-012 and is consumed as a number. | — | — | Selection is entirely deterministic and runs unchanged with JEV disabled; the index floor and price ceiling fully determine the result. | — |

## Acceptance Criteria
- [ ] AC-1 [local; actor: agent]: With a fixture snapshot as the cache and a controlled snapshot date, the catalog reports `stale: true` once the age exceeds the configured TTL and `stale: false` within it, and every report carries the snapshot date — staleness is decided in code, never inferred silently — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: With `AA_API_KEY` unset and no cache present, role resolution still returns models from the bundled fallback snapshot and marks the catalog stale; the Artificial Analysis host receives zero requests and no error is thrown — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: With a fixture snapshot on disk, a freshly spawned process reads identical `ModelCapability` records — same field values and snapshot date — and makes zero fetch attempts — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: For a task whose contract sets `required_capability.min_coding_index = X`, the selected model's coding index is ≥ X and no bound catalog model clearing X has a lower blended price; raising X to a value only a higher-index model clears changes the selection to that strictly higher-index model — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: All six PRD-001 roles resolve from fixture index floors and price ceilings with no vendor name in the routing path, and a role pinned to an explicit model in config resolves to that model even when a cheaper model clears the role's bounds; a pin below the role floor is returned but reported as a shortfall — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: The `/models` surface fed by this module lists each model with its coding index, blended price and the role(s) it fills, each value equal to the capability record for the same snapshot, and changing a role pin changes the role-fill column without any edit to the catalog — Evidence: pending.
- [ ] AC-7 [local; actor: agent]: With `AA_API_KEY` unset, a refresh against a captured leaderboard-page fixture served locally populates the cache with ≥50 models carrying non-null `intelligence_index`, `source: 'leaderboard'` and their estimated flags; serving a shape-changed or truncated payload instead fails the refresh and leaves the previous cache byte-identical — Evidence: pending.
- [ ] AC-8 [owner; actor: joao]: Running the live refresh with a real `AA_API_KEY` populates the on-disk cache from the keyed API, and every fetched record has non-null coding index, intelligence index and blended price mapped from the API response; re-running within the TTL performs no second network call — Evidence: pending.

## Integration Ledger
| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Offline-first catalog with a staleness report | Role resolution / router → `loadCatalog()` in `src/capability/catalog.ts` (created in Phase 1) | New; replaces the hand-tuned role→vendor assumption with a dated published snapshot | AC-1, AC-2, AC-3 |
| Keyed-API and keyless-leaderboard refresh with atomic cache write | `npm run capability:refresh` / `/models --refresh` → `src/capability/fetch.ts` + `src/capability/refresh.ts` (created in Phase 2) | New; network stays optional, keyless path covers users with no API key, cache is the steady state | AC-7, AC-8 |
| Role binding and required_capability selection | PRD-001 `resolveRole()` / PRD-004 `ExecutionContract.required_capability` → `selectRoleModel()` + `selectCheapestClearing()` in `src/capability/select.ts` (created in Phase 3) | New; pin remains the only explicit override, thresholds replace hardcoded vendor choices | AC-4, AC-5 |
| Capability projection for `/models` | PRD-016 `/models` command → `capabilityRows()` in `src/capability/feed.ts` (created in Phase 4) | Feeds a planned surface owned by PRD-016; this PRD renders nothing itself | AC-6 |

## Execution Phases
#### Phase 1: Offline-first catalog with staleness
**Status:** NOT STARTED
**ACs:** AC-1, AC-2, AC-3
**Files:** `src/capability/schema.ts` (`ModelCapability`, `CatalogSnapshot` types and validator); `src/capability/catalog.ts` (`loadCatalog()`, cache→bundled order, staleness report); `src/capability/store.ts` (cache path, read/validate, atomic write helper); `src/capability/fallback.json` (bundled snapshot committed with its date); `tests/capability/catalog.spec.ts`.
**Implementation:** Declare `ModelCapability` from the field list in the Context and validate a loaded snapshot structurally before use. `loadCatalog(config, deps)` reads `.leanpi/capability/catalog.json`; a missing or schema-invalid cache falls through to the bundled `fallback.json`, and only an unreadable *bundled* file is a real error. Bind models to `BackendRef` from PRD-001/PRD-008 config at load time, leaving `backend_binding` null when no entry matches. `staleness(snapshot, now, ttl)` compares `snapshot_date` to TTL and returns `{ stale, age_days, snapshot_date }`; no fetch code exists in this phase, so offline behavior cannot regress into a network dependency.
**Verification:** E1 — `npx vitest run tests/capability/catalog.spec.ts`: with a fixture cache and an injected clock, age beyond TTL reports `stale: true` and age within TTL reports `stale: false`, both with the date present (AC-1; the fresh case is the negative control that the check is not constant `true`); with the cache removed, `AA_API_KEY` unset and a fetch-client spy installed, roles resolve from the bundled snapshot, the report is stale, the spy recorded zero calls and nothing throws (AC-2); a child `node` process reading the same fixture cache yields field-identical records with zero fetch attempts (AC-3). Distinct risks: an accidental network call on the routing path, a malformed cache silently emptying the catalog, staleness inferred from file mtime instead of the record's date.
**Checkpoint:** pending

#### Phase 2: Dual-source fetch and cache refresh
**Status:** NOT STARTED
**ACs:** AC-7, AC-8
**Files:** `src/capability/fetch.ts` (`fetchFromApi()` keyed client + `fetchFromLeaderboard()` payload parser); `src/capability/refresh.ts` (source order, TTL guard, validate → atomic write); `src/capability/store.ts` (edited from Phase 1: cache writer); `package.json` (add the `capability:refresh` script); `tests/capability/fetch.spec.ts`; `tests/fixtures/capability/leaderboard-page.html` (captured payload).
**Implementation:** `fetchFromApi({ apiKey, baseUrl, fetchImpl })` issues `GET https://artificialanalysis.ai/api/v2/data/llms/models` with `x-api-key: <key>` read from `AA_API_KEY` at call time and maps each entry into `ModelCapability`, absent fields null. `fetchFromLeaderboard({ url, fetchImpl })` GETs `https://artificialanalysis.ai/leaderboards/models`, concatenates the `self.__next_f` chunks, and extracts per-model `slug`, `intelligenceIndex`, `intelligenceIndexIsEstimated`, `intelligenceIndexCostPerTask`; prices and throughput stay null because the page does not carry them in that record. Both are injectable so tests drive a local stub and the routing path never imports either. `refresh({ config, now })` picks keyed → keyless → no-op, rejects a leaderboard result below `capability.minLeaderboardRows`, stamps `snapshot_date` and `source`, writes via temp-file-then-rename, and on any non-2xx, timeout, parse failure or row-count shortfall leaves the prior cache untouched and reports to the caller only. A refresh inside the TTL window is a no-op unless forced. The key is never persisted or logged.
**Verification:** E2 — `npx vitest run tests/capability/fetch.spec.ts`: a local stub serving a captured API payload proves the request carries `x-api-key` and the documented path and that the cache round-trips with non-null index and price; the captured leaderboard fixture proves ≥50 keyless rows land with `source: 'leaderboard'`, estimated flags preserved and prices null rather than zero (AC-7); a mutated fixture with the payload key renamed and a truncated 10-row fixture each fail the refresh with the pre-existing cache byte-identical — the negative control proving the parser is not silently producing an empty or fabricated catalog; a 401 on the keyed path falls through to the keyless path rather than erroring; a second refresh inside the TTL issues zero requests. AC-8's live spec is skipped when `AA_API_KEY` is absent so CI stays offline. Distinct risks: renamed payload keys silently yielding all-null records, a partial write truncating the cache, the key leaking into cache or logs, and an unbounded re-fetch loop on the session path.
**Checkpoint:** pending

#### Phase 3: Role binding and required_capability selection
**Status:** NOT STARTED
**ACs:** AC-4, AC-5
**Files:** `src/capability/select.ts` (`selectRoleModel()`, `selectCheapestClearing()`, `capability_gap` result); `src/capability/roles.ts` (role floor/ceiling/pin parsing from config); `src/core/types.ts` (edited; created in PRD-001: `capability.roles` policy + pin on `LeanPiConfig`); `src/compiler/contract.ts` (edited; created in PRD-004: `required_capability` field on `ExecutionContract`); `tests/capability/select.spec.ts`.
**Implementation:** Parse `capability.roles.<role>` into `{ min_coding_index, max_blended_price, pin? }`. `selectRoleModel(role, catalog)`: a `pin` resolves the named model and wins unconditionally, reporting `capability_gap` when it is unbound or under the floor; otherwise filter to models with a non-null binding and known coding index, keep those clearing both bounds, and take the minimum blended price, tie-broken by higher coding index then model id. `selectCheapestClearing(catalog, { min_coding_index, specialization? })` applies the same filter plus the specialization tag and returns `{ ref, capability_gap? }`; an unmet bar escalates to the highest-index bound model with the shortfall recorded rather than failing. Routing code reads only catalog metrics and role names — no model or vendor string is compared in the selection logic.
**Verification:** E3 — `npx vitest run tests/capability/select.spec.ts`: a fixture snapshot is built so the minimum-price clearer is unambiguous; a low `required_capability` selects model A, raising the bar selects strictly higher-index model B, and a third model that also clears the raised bar but costs more is present to prove B is genuinely the cheapest clearing model, not merely the highest-index (AC-4); all six roles resolve within their configured floor and ceiling, a config pin overrides a cheaper clearer, and an under-floor pin returns the pinned model with a shortfall report (AC-5). Distinct risks: a vendor name leaking into selection, a pin silently ignored, "cheapest" computed over an unbound backend, an off-by-one on `≥` versus `>`, and null indexes being coerced to 0 and winning on price.
**Checkpoint:** pending

#### Phase 4: `/models` capability projection
**Status:** NOT STARTED
**ACs:** AC-6
**Files:** `src/capability/feed.ts` (`capabilityRows()` projection: model, coding index, blended price, filled roles, binding, snapshot date); `src/commands/models.ts` (edited; created in PRD-016: render the projection); `tests/capability/feed.spec.ts`.
**Implementation:** `capabilityRows(catalog)` is a pure join of catalog records with the current role resolutions from Phase 3, returning one row per model. It maintains no second model list: adding a model means adding a catalog record, never editing the feed. Ordering is stable — role-filled models first, then coding index descending, then model id. Each row carries the snapshot date so `/models` can print a stale-snapshot warning; PRD-016 owns argument parsing and rendering, and this module returns data only.
**Verification:** E4 — `npx vitest run tests/capability/feed.spec.ts`: with the Phase 3 fixture, assert every rendered row's coding index and blended price equal the capability record for that model and that the role labels equal `resolveRole()` for all six roles; change one role pin in config and assert the role-fill column changes with the catalog untouched, proving the projection is derived rather than a parallel hardcoded list (AC-6). Distinct risks: a second model list drifting from the catalog, and a stale snapshot rendered without its date.
**Checkpoint:** pending

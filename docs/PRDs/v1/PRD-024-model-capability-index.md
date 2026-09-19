# PRD-024 — Model Capability Index

**Status:** NOT STARTED
**Complexity:** 4 (MEDIUM)
**Owner:** joao
**Depends on:** PRD-001, PRD-008

Risk override: none — no network, no credential, no stored secret, no destructive migration. The whole module is a bundled data file plus arithmetic over it; every check is local and offline.

## Context
**Covers:** none (new slice); ROADMAP §14, §23, §27, §51 Models FR block (consumed, not owned)

The repository is greenfield: `docs/PRDs/v1/ROADMAP.md` is the only artefact and every path named below is created by this PRD's phases.

PRD-001 maps the six logical roles (`quick`, `balanced`, `strong`, `specialist`, `review_quick`, `review_strong`) onto `BackendRef` entries by hand. That mapping answers "which backend and model does this role name" but not "is this model actually strong enough" or "what is the cheapest model that clears the bar". Without a ranking, a `strong` role is a guess, `required_capability` has no metric to compare against, and the router cannot honour ROADMAP §14 (complexity → Quick/Balanced/Strong) or §6.6/§27 (roles, never vendor names) with anything behind the choice.

Consumers that need this data:

- PRD-004's `ExecutionContract.task.required_capability` and PRD-012's PRD work unit carry `{ min_coding_index: number, specialization?: string }` as a routing annotation. This PRD is the only thing that turns that number into a concrete model, by comparing it against a record's `coding_score`.
- PRD-008's backend entries (`type: native | external_harness`) supply the reachable model/backend bindings; a ranked record with no reachable binding is visible but not selectable.
- PRD-015 owns money. This PRD supplies per-million-token prices on the same basis PRD-015 records, so routing and cost telemetry cannot disagree about what a model costs.
- PRD-016 owns `/models` and renders it in `src/commands/model.ts`; this PRD only feeds it rows plus the ranking's revision and staleness.

**Where the numbers come from: us.** LeanPi ships its own static ranking, authored and maintained in this repository as `src/capability/models.json`. There is no upstream fetch — no Artificial Analysis API, no leaderboard scrape, no API key, no cache, no refresh command, and no network access of any kind at any point in this module's lifetime. That is a deliberate scope decision, not a limitation to be lifted later: a routing input that can fail, rate-limit, require a credential, or silently change between two sessions is a worse input than a committed file whose provenance is a reviewed pull request. Externally sourced third-party benchmark numbers would also carry licensing and attribution obligations LeanPi has no reason to take on.

The cost of that choice is freshness, and freshness is therefore made visible rather than automated away (see *Freshness and the update path*).

## Solution

One module, `src/capability/`, with exactly one data source: the file it ships.

**The ranking file.** `src/capability/models.json` is committed, shipped in the package `files` list, and loaded from disk. Its envelope is `{ revision: number, notes: string, models: ModelCapability[] }`. `revision` is a monotonically increasing integer bumped by every maintainer change to the file — it is the one number that identifies "which ranking is this", and `/models` prints it.

**Record shape** (`src/capability/schema.ts`):

| Field | Type | Meaning |
|---|---|---|
| `model_id` | `string` | Canonical id, unique in the file; the id routing and telemetry use |
| `aliases` | `string[]` | Other spellings a backend or config may use (provider-prefixed ids, dated snapshots), so a config entry resolves to exactly one record |
| `provider` | `string` | Who serves it, for display and for config matching — never a routing input |
| `backend_hint` | `string \| null` | The `backends.<id>` key this model is normally reached through; resolved against PRD-001/PRD-008 config at load time into `backend_binding: BackendRef \| null`, never persisted into the file |
| `coding_score` | `number \| null` | Our coding-capability score, 0–100 (see *Scoring*). The field `required_capability.min_coding_index` is compared against |
| `general_score` | `number \| null` | Our general-capability score, 0–100; display and tie-breaking only |
| `specializations` | `string[]` | Maintainer-assigned tags (`typescript`, `rust`, `sql`, `systems`, …) matched against `required_capability.specialization`. Empty array means "no claim", which never matches a specialization filter |
| `price_input_per_mtok` | `number \| null` | USD per million input tokens |
| `price_output_per_mtok` | `number \| null` | USD per million output tokens |
| `price_blended_per_mtok` | `number \| null` | 3:1 input:output blend, the single number "cheapest" is computed over |
| `speed_tier` | `'slow' \| 'medium' \| 'fast'` | Coarse throughput class; a tier, not a fabricated tokens/second figure |
| `context_window` | `number \| null` | Usable context in tokens |
| `updated_at` | `string` | ISO date this record was last reviewed — per record, because records age independently |
| `evidence` | `'measured' \| 'estimated'` | Whether the scores come from our own PRD-021 benchmark runs or from a maintainer's reasoned estimate |

Every numeric field is `number | null`. Null means *unknown*, never zero: a zero price would read as "free" and a zero score as "incapable", and either would corrupt selection. A record with a null `coding_score` can never clear a numeric floor, so it is excluded from automatic selection and stays selectable only by an explicit pin.

**Scoring methodology (ours, and documented because it is ours).** `coding_score` and `general_score` are on a documented 0–100 scale anchored so the numbers mean something across revisions:

- 0–29 — cannot be trusted with multi-file edits; tool-call discipline unreliable.
- 30–49 — single-file, well-specified edits; needs explicit instructions.
- 50–69 — competent on bounded multi-file work in a familiar stack; the `quick` floor.
- 70–84 — reliable across unfamiliar subsystems, holds a plan over many turns; the `balanced` floor.
- 85–100 — handles architectural and concurrency-sensitive work with few retries; the `strong`/`review_strong` floor.

A record is `evidence: 'measured'` only when its score was set from a PRD-021 benchmark run recorded in this repository; anything else is `estimated`, and the distinction is rendered by `/models` so a reasoned guess is never displayed as a measurement. The anchors, not the individual scores, are the stable contract: a revision may re-score a model, but re-defining a band is a breaking change to every configured floor and is called out in `notes`.

**Freshness and the update path.** Freshness has two parts and no timer: the file's `revision`, and each record's `updated_at`. `loadRanking()` returns `{ revision, models, oldest_updated_at, stale, age_days }`, where `stale` compares the *oldest* `updated_at` among records that currently fill a role against `capability.stalenessDays` (default 90). A stale ranking is reported and still used — it is the only ranking there is — and `/models` prints the revision plus the staleness line so the user can see the ranking is ageing.

Updating it is a maintainer pull request: edit `src/capability/models.json`, bump `revision`, set `updated_at` on every touched record, note the change in `notes`. There is no `/models --refresh`, no `npm run capability:refresh`, no TTL-triggered background update, and no code path that could acquire one — a new model reaches users the same way a new feature does, through a reviewed release.

**User override.** A user who disagrees with our scores, or who runs a model we have never ranked, can point `capability.rankingFile` at their own JSON. It is validated by the *same* schema validator as the bundled file — same required fields, same 0–100 range checks, same `evidence` enum — and a validation failure is a startup error naming the offending record and field, not a silent fall back to the bundled file (silently ignoring an override the user deliberately configured is worse than refusing to start). With no override configured, the bundled file is used. The override replaces the bundled file wholesale rather than merging record-by-record, so the effective ranking is always exactly one readable document.

**Consumer flow.**

```text
resolveRole(role) [PRD-001, src/core/roles.ts]
  → selectRoleModel()  src/capability/select.ts
      → loadRanking()  src/capability/index.ts   (bundled file or configured override)
      → cheapest bound model clearing the role's coding floor and price ceiling
  → BackendRef
  (ranking unreadable → PRD-001's static `models:` map, unchanged)

ExecutionContract.task.required_capability [PRD-004] / PRD work unit [PRD-012]
  → selectCheapestClearing(ranking, { min_coding_index, specialization? })
      → { ref, capability_gap? }

/models [PRD-016, src/commands/model.ts]  ←  capabilityRows()  src/capability/feed.ts
```

**Role binding** (`src/capability/roles.ts`). `capability.roles.<role>` carries `min_coding_index`, `max_blended_price` and an optional `pin`. A pin resolves the role to the named model (by `model_id` or alias) and always wins; if the pinned model is unbound or below the role floor it is still returned, with the shortfall reported rather than silently swapped. Without a pin, selection is the cheapest bound model clearing both bounds, tie-broken by higher `coding_score` then `model_id` so the result is deterministic. The bundled file guarantees a non-empty ranking, so role resolution never fails for want of data.

**`required_capability` selection.** `selectCheapestClearing(ranking, { min_coding_index, specialization? })` keeps records with a reachable `backend_binding` and a known `coding_score` at or above the floor, and — when a specialization is given — whose `specializations` contains it; of those it takes the lowest `price_blended_per_mtok`. When nothing clears, it escalates to the highest-scoring bound model and returns `capability_gap: { requested, best_available, reason }`: a visible escalation, never a silent weaker pick and never a hard failure. `required_capability` stays an annotation owned by PRD-004; this PRD reads it and never writes it, so `src/compiler/contract.ts` is not edited here.

**Where this PRD stops.** It designs no thresholds for other PRDs (roles' floors are config), renders nothing (PRD-016 renders `/models`), benchmarks nothing (PRD-021 measures, and its results are what promote a record to `evidence: 'measured'`), and touches no contract type it does not own.

**Non-goals (scope + §58).** No network access, no HTTP client, no API key, no cache, no refresh command, no background daemon, no headless browser, no third-party leaderboard ingestion. No vendor-name comparisons in routing logic — only ranking metrics. No local benchmarking here. No second model list anywhere in the codebase: `models.json` (or the user's override) is the only one.

**Risks.** (1) A committed ranking ages; mitigated by making `revision` and per-record `updated_at` first-class, surfaced by `/models`, and asserted by AC-2 rather than left to memory. (2) Our scores are our own judgement; mitigated by the documented band anchors and by `evidence` separating measured from estimated, so a user can see exactly what a number is worth. (3) A wrong or hand-broken JSON file would mis-route everything; mitigated by schema validation of the *shipped* file in the test suite, by range checks on every score, and by falling back to PRD-001's static map when the ranking cannot be read. (4) Scope creep back toward a live fetch; mitigated structurally — AC-1 asserts zero outbound network attempts across the whole module, so adding a fetcher fails the suite.

## External Skill Dependencies
None.

## JEV Decision Sites
This PRD owns no decision site.

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| None — model choice here is arithmetic over ranked records (minimum blended price subject to `coding_score ≥ min_coding_index`), not a semantic judgement. Task→capability classification belongs to PRD-004/PRD-012 and arrives as a number. | — | — | Selection is entirely deterministic and runs unchanged with JEV disabled; the coding floor and price ceiling fully determine the result. | — |

## Acceptance Criteria
- [ ] AC-1 [local; actor: agent]: Loading the ranking, resolving all six roles, running `selectCheapestClearing()` and building the `/models` rows makes **zero outbound network attempts**: with `globalThis.fetch`, `node:http`/`node:https` request functions and `child_process` spawn functions all replaced by recording throwing stubs for the duration, every operation completes and every spy records zero calls; the module exports no fetch, refresh or cache function, and `package.json` declares no refresh script. Negative control: a deliberate `fetch()` added to the loader in a scratch copy makes the same spec fail — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: The ranking shipped in the repository validates against its own schema — every record has a unique `model_id`, non-overlapping `aliases`, `evidence` in `{measured, estimated}`, an ISO `updated_at`, and every non-null `coding_score`/`general_score` within 0–100 — and `loadRanking()` reports the file's `revision`, `oldest_updated_at` and a `stale` flag that is `true` when the oldest role-filling record exceeds `capability.stalenessDays` and `false` within it. With `capability.rankingFile` pointing at a valid override, the override's records and revision are the ones returned; with it pointing at a file that violates the schema (a score of 120, a missing `evidence`), startup fails naming the record and the field rather than silently using the bundled file — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: For `required_capability.min_coding_index = X`, the selected model's `coding_score` is ≥ X and no bound record clearing X has a lower `price_blended_per_mtok`; raising X to a value only a higher-scoring record clears changes the selection to that record, with a third clearing-but-pricier record present in the fixture so "cheapest clearing" is proved rather than "highest scoring". Adding `specialization: 'rust'` selects the cheapest clearing record whose `specializations` contains `rust` and skips a cheaper record without the tag, and a record with a null `coding_score` is never selected automatically — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: A `required_capability` no record can clear returns the highest-scoring bound record together with `capability_gap { requested, best_available, reason }` and does not throw; a role pinned in config resolves to the pinned model even when a cheaper model clears its bounds, and a pin below the role's `min_coding_index` or with no reachable backend is still returned with its shortfall reported. A pin naming an alias resolves to the same record as its `model_id` — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: All six PRD-001 roles resolve **through `resolveRole()`** — not by calling `selectRoleModel()` directly — to the ranking-selected model for their configured floor and ceiling, with no provider or vendor name read anywhere in the resolution path; making the ranking file unreadable makes the same six calls fall back to PRD-001's static `models:` map without throwing, which is the negative control proving the catalog path is actually the one being exercised in the first case — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: `capabilityRows()` returns one row per ranked model carrying model id, `coding_score`, blended price, `evidence`, the role(s) it fills, and the ranking's `revision` plus staleness, each value equal to the record it was derived from; changing a role pin in config changes the role-fill column with the ranking file untouched, and adding a record to the ranking adds exactly one row — proving the feed is a projection, not a second list. PRD-016's `src/commands/model.ts` renders these rows; this module returns data only — Evidence: pending.

## Integration Ledger
| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Bundled static model ranking with revision + per-record freshness | role resolution and router at session start → `loadRanking()` in `src/capability/index.ts` reading `src/capability/models.json` (created in Phase 1) | New; replaces the hand-tuned role→vendor assumption with a reviewed, committed ranking. Deliberately replaces the alternative of a live third-party fetch: no network, no key, no cache | AC-1, AC-2 |
| User-supplied ranking override | `capability.rankingFile` in `leanpi.config.yaml` → same loader, same validator (created in Phase 1) | New; the only supported way to change the numbers without a release, and it is validated, not merged | AC-2 |
| Role binding and `required_capability` selection | PRD-004 `ExecutionContract.task.required_capability` / PRD-012 work unit → `selectCheapestClearing()`, and role floors → `selectRoleModel()`, both in `src/capability/select.ts` (created in Phase 2) | New; pins remain the only explicit override, `coding_score` floors replace hardcoded vendor choices | AC-3, AC-4 |
| Capability-indexed `resolveRole()` | every lane asking PRD-001 for a role's backend → `resolveRole()` in `src/core/roles.ts` (edited in Phase 3) consulting `selectRoleModel()`, falling back to the static `models:` map | Replaces PRD-001's static-only resolution at the same call site; no second resolution entry point is introduced | AC-5 |
| Capability projection for `/models` | PRD-016 `/models` → `capabilityRows()` in `src/capability/feed.ts` (created in Phase 3), rendered by PRD-016's `src/commands/model.ts` | Feeds a surface PRD-016 owns; this PRD renders nothing and parses no arguments | AC-6 |

## Execution Phases
#### Phase 1: Bundled ranking, schema, and offline loader
**Status:** NOT STARTED
**ACs:** AC-1, AC-2
**Files:** `src/capability/schema.ts` (`ModelCapability`, `RankingFile` types + validator with range and enum checks); `src/capability/models.json` (the shipped ranking: envelope `revision`/`notes`, one record per model); `src/capability/index.ts` (`loadRanking()`: bundled file or `capability.rankingFile` override, backend binding, freshness report); `src/core/types.ts` (edited; created in PRD-001: `capability.roles`, `capability.rankingFile`, `capability.stalenessDays` on `LeanPiConfig`); `package.json` (ship `models.json` in `files`); `tests/capability/ranking.spec.ts`.
**Implementation:** Write the validator first, then author `models.json` against it — for every model LeanPi can actually reach through a configured backend today, with the band anchors from §Solution applied by hand and each record stamped `updated_at` and `evidence: 'estimated'` unless a recorded benchmark exists. `loadRanking(config)` reads `capability.rankingFile` when set, otherwise the bundled file; validates; resolves each record's `backend_hint` against the config's `backends` (`type: native | external_harness`) into `backend_binding`, leaving it null when nothing matches; and returns `{ revision, notes, models, oldest_updated_at, stale, age_days }`. A validation failure on either file is a startup error naming record and field. No HTTP client, no `fetch`, no cache directory and no refresh entry point is created — there is nothing here that could reach the network, which is the property AC-1 pins.
**Verification:** E1 — `npx vitest run tests/capability/ranking.spec.ts`: the shipped `models.json` is validated by the production validator, with unique ids/aliases, in-range scores, ISO dates and enum `evidence` asserted over every record (AC-2); an injected clock makes the oldest role-filling record cross `capability.stalenessDays` and reports `stale: true`, and the within-window case reports `false` (the negative control against a constant); a valid override file is returned in place of the bundled one, and two malformed overrides (score 120, missing `evidence`) each fail startup naming record and field. Network spies over `fetch`, `node:http`/`node:https` and `child_process` record zero calls across the whole load, and the module's exports are asserted to contain no refresh/fetch/cache function (AC-1). Distinct risks: a hand-broken data file mis-routing everything, a silently ignored override, freshness inferred from file mtime, and a network dependency sneaking into the load path.
**Checkpoint:** pending

#### Phase 2: Role binding and required_capability selection
**Status:** NOT STARTED
**ACs:** AC-3, AC-4
**Files:** `src/capability/roles.ts` (parse `capability.roles.<role>` into `{ min_coding_index, max_blended_price, pin? }`, alias resolution); `src/capability/select.ts` (`selectRoleModel()`, `selectCheapestClearing()`, `capability_gap`); `tests/capability/select.spec.ts`.
**Implementation:** `selectRoleModel(role, ranking, config)`: a `pin` resolves by `model_id` or alias and wins unconditionally, reporting `capability_gap` when the pinned record is unbound or under the role floor; otherwise filter to records with a non-null `backend_binding` and a known `coding_score`, keep those clearing the floor and the price ceiling, and take the minimum `price_blended_per_mtok`, tie-broken by higher `coding_score` then `model_id`. `selectCheapestClearing(ranking, { min_coding_index, specialization? })` applies the same filter plus the `specializations` membership test and returns `{ ref, capability_gap? }`; an unmet bar escalates to the highest-scoring bound record with the shortfall recorded rather than failing. Both read only ranking metrics and config — never `provider`, never a vendor name, never `required_capability` from anywhere but its caller.
**Verification:** E2 — `npx vitest run tests/capability/select.spec.ts`: a fixture ranking is built so the cheapest clearing record is unambiguous and a pricier clearing record and a higher-scoring pricier record both exist; a low floor selects A, a raised floor selects strictly-higher-scoring B, and the pricier clearer proves "cheapest clearing" rather than "highest scoring"; a specialization-filtered case skips a cheaper untagged record; a null-`coding_score` record is never selected (AC-3). An unclearable floor returns the highest-scoring bound record plus `capability_gap` without throwing; a pin overrides a cheaper clearer; an under-floor pin and an unbound pin are returned with shortfalls; an alias pin resolves to the same record as its id (AC-4). Distinct risks: a vendor name leaking into selection, a pin silently ignored, "cheapest" computed over an unreachable backend, off-by-one on `≥` vs `>`, a null score treated as zero, and an unmet bar failing the task instead of escalating visibly.
**Checkpoint:** pending

#### Phase 3: `resolveRole()` consults the ranking, and the `/models` feed
**Status:** NOT STARTED
**ACs:** AC-5, AC-6
**Files:** `src/core/roles.ts` (edited; created in PRD-001: `resolveRole()` consults `selectRoleModel()` when a ranking loads, falls back to the static `models:` map otherwise); `src/capability/feed.ts` (`capabilityRows()` projection: model id, coding score, blended price, evidence, filled roles, binding, plus the ranking revision and staleness); `tests/capability/resolve.spec.ts`, `tests/capability/feed.spec.ts`.
**Implementation:** Edit `resolveRole()` — the single resolution call site PRD-001 owns — so that a successfully loaded ranking routes through `selectRoleModel()` and an unreadable or invalid one falls back to the static `models:` map with the reason reported once per session. No new resolution entry point, no second code path for lanes to choose between. `capabilityRows(ranking, roleResolutions)` is a pure join of ranked records with the current role resolutions, one row per record, ordered role-filled first then `coding_score` descending then `model_id`; every row carries the ranking `revision` and the staleness report so PRD-016 can print both. This PRD does not edit `src/commands/model.ts` (PRD-016 owns the rendering and the argument parsing — and there is no `--refresh` argument to add) and does not edit `src/compiler/contract.ts` (PRD-004 owns `required_capability`).
**Verification:** E3 — `npx vitest run tests/capability/resolve.spec.ts tests/capability/feed.spec.ts`: all six roles are resolved by calling `resolveRole()` and asserted against the ranking-selected model for their configured floors and ceilings, with the resolution path asserted to read no `provider` field; making the ranking unreadable then makes the same six `resolveRole()` calls return the static `models:` entries without throwing — the negative control proving the first case genuinely went through the ranking (AC-5). The feed case asserts every row's score, price, evidence and role labels equal the record and the `resolveRole()` result they derive from, that the row count equals the record count and grows by exactly one when a record is added, that revision and staleness are present on the rows, and that changing one role pin changes only the role-fill column with the ranking file untouched (AC-6). Distinct risks: an orphaned selector with only its own tests as callers, a second model list drifting from the ranking, and a stale ranking rendered without its revision.
**Checkpoint:** pending

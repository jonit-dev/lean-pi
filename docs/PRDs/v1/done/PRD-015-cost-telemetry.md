# PRD-015 — Cost Telemetry

**Status:** DONE (verified 2026-09-19)
**Complexity:** 3 (LOW)
**Risk override:** none — append-only local JSONL, no schema migration, no external API, no security boundary.
**Owner:** joao
**Depends on:** PRD-002, PRD-004, PRD-008

## Context

**Covers:** FR-149; ROADMAP §3, §26, §52, §56

LeanPi's product objective (§3) is *effective cost per verified success*, not raw tokens: "a 5,000-token run that fails three times is worse than a 12,000-token run that succeeds once." Nothing in the harness can optimize that number until a run actually records it. §52 fixes the per-run record shape; §26 fixes the effective-cost formula; FR-149 requires `/cost`.

Current behavior: none. The repository is greenfield — `docs/PRDs/v1/ROADMAP.md` is the only file, so there is no telemetry, no store, and no cost surface. Every path named below is created by this PRD's phases, except the contracts it consumes.

Consumed contracts (owned elsewhere, read not re-implemented):

- `src/compiler/contract.ts` — `ExecutionContract` (PRD-004): supplies `route`, `prd_used`, executor/reviewer class, budgets.
- `src/backends/*` (PRD-008): each worker returns its own token/call usage and its backend identity (`native` vs `external_harness`, `quota_class`); PRD-008 also owns the subscription-vs-metered distinction (FR-055).
- `src/core/types.ts` (PRD-001): `LeanPiConfig`, `ModelRole`, `BackendRef`.
- `src/verify/evidence.ts` (PRD-009) and `src/proof/*` (PRD-010): supply `result.verification`, `result.proof_gate`, `result.reviewer`, `result.success`. This PRD copies those verdicts; it never decides them.

## Solution

One record per run, appended to a local JSONL store, plus one command that reads it.

**Record.** `src/telemetry/record.ts` declares `RunTelemetry` as the literal §52 shape (`task_id`, `route`, `prd_used`, `executor_backend`, `executor_model`, `reviewer_backend`, `reviewer_model`, `usage{input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, jev_tokens, local_gpu_seconds, external_harness_calls, subscription_usage}`, `cost{api_usd, jev_usd, estimated_quota_cost, effective_cost}`, `execution{wall_ms, tool_calls, file_reads, repeated_reads, retries, escalations, compactions}`, `result{verification, proof_gate, reviewer, success}`) plus four **declared** additions beyond §52, each with a named owner and a named consumer:

| Addition | Owner | Why it exists |
|---|---|---|
| `session_id` | this PRD, copied from the Pi session PRD-001 owns | §52 has only `task_id`; `readRuns({sessionId})`, `/cost`'s session footer and PRD-016's `/status` total have no key to filter on without it |
| `jev_decisions[]` | this PRD | Per-run projection of PRD-002's decision log, one row per site that fired or fell back (see JEV Decision Sites) |
| `capabilities{skills_disclosed[], skills_used[], mcps_disclosed[], mcps_used[]}` | this PRD — disclosed sets copied from `ExecutionContract.capabilities` (PRD-005/PRD-006), used sets observed by the tool layer | The only observable behind §56's MCP unnecessary-disclosure rate, which PRD-021 reports |
| `route_cost{monetary, quota_shadow, local_compute, latency, predicted_retry}` | **PRD-020** | The *predicted* pre-dispatch route score from `predictRouteCost()`. Declared here so the record has one owner per block; this PRD never computes it and `/cost` never sums it into `effective_cost` |

`route` is the contract's route descriptor copied whole — `{complexity, executor_class, reviewer_class, reasoning}` — so the classified complexity a run was routed at is recoverable from the record (§56's complexity under/over-routing has no other observable). No wrapper envelope, no versioning ceremony.

**Accumulator.** `src/telemetry/collect.ts` exposes a `RunCollector` created at run start: backends report usage into it as they return, the executor's tool layer bumps `tool_calls`/`file_reads`/`repeated_reads`, the retry/escalation loop bumps its counters, the context engine bumps `compactions`. `repeated_reads` counts reads of a path already read in the same run (set of read paths — the deterministic signal §52 wants for context waste). Usage accumulates across *all* attempts of a run, so retry cost is already inside `api_usd`; `retries` records how many. There is deliberately no `predicted_retry_cost` term in a completed record — a prediction has no place in a measurement, and double-counting it would inflate every retried run.

**Pricing.** `src/telemetry/pricing.ts` turns usage into money from `LeanPiConfig`:

```text
api_usd            = Σ over billed models: in·in_rate + cached_in·cached_rate + out·out_rate + reasoning·out_rate
jev_usd            = jev_tokens · config.jev.usd_per_mtok
local_compute_cost = local_gpu_seconds · config.cost.local_usd_per_gpu_sec      (default 0)
latency_penalty    = wall_ms/1000 · config.cost.latency_usd_per_sec             (default 0)
quota_shadow_cost  = Σ over calls: config.cost.quota_shadow_usd[quota_class]    (default 0)

effective_cost = api_usd + jev_usd + quota_shadow_cost + local_compute_cost + latency_penalty
```

`quota_shadow_cost` lands in the record as §52's `cost.estimated_quota_cost`. **This PRD only exposes the input field and sums it.** It does not model scarcity, does not price a quota class, does not claim FR-056 — PRD-020 owns adaptive/shadow pricing and *reads the same key*, `cost.quota_shadow_usd[quota_class]`, which is the single scarcity setting in the config: there is no per-backend shadow price, so the price the router scored with and the price telemetry recorded cannot disagree. Rates absent from config are 0, so a pure-local session records `api_usd: 0` and a truthful `effective_cost`. All money values are USD numbers rounded to 6 decimals at write time, so stored sums are stable.

`effective_cost` above is the **measured** six-term post-hoc value and the only thing named `effective_cost` in LeanPi. PRD-020's pre-dispatch score is a different quantity with a different name (`predictRouteCost()` → the `route_cost` block); it includes a `predicted_retry` term this record deliberately excludes, and it is never substituted for the measured value at display time.

**Store.** `src/telemetry/store.ts` appends one JSON line per run to `.leanpi/telemetry.jsonl` (`appendFileSync`, `\n`-delimited) and reads it back with `readFileSync` + split + `JSON.parse`, filtering by `task_id` or session. No database, no index, no ORM: single-writer append and a full scan over a file that grows one short line per task.
`ponytail:` full-file scan on read, and the whole file is parsed for `/cost`; add a tail-read or per-day file only if a store ever grows past a few MB.

**Emission.** `src/telemetry/emit.ts` exposes `emitRunTelemetry(collector, contract, result)`: it composes the record, prices it, and appends once. The single call site is one line at turn completion in `src/commands/session.ts` `runTurn()` — PRD-001's file and PRD-001's entry point — placed after the proof gate so one record covers every attempt of the run (success, failure, or abandonment) rather than one per attempt. This PRD owns the function, PRD-001 owns the file, and the fixture in Phase 1 drives the real turn entry point rather than calling `emitRunTelemetry` directly.

**`/cost`.** `src/commands/cost.ts` registers `/cost` (registry owned by PRD-016) and prints, from the store only: per-task rows (`task_id`, route, executor, `effective_cost`, success) and a session footer with total effective cost, total verified successes, and **effective cost per verified success** — §3's objective, computed as `Σ effective_cost / count(result.success)` and shown as `n/a` when no run succeeded. `/cost <task_id>` prints that record's full field breakdown.

**Relevant non-goals (§58).** This PRD does not require cloud models (a local-only run records real zero-dollar cost); does not bypass or infer vendor usage limits (it records the `quota_class` a backend declares and nothing more); does not claim correctness without evidence (`result.success` is copied from the proof gate, never from an executor's self-report); and does not model subscription scarcity (PRD-020).

## External Skill Dependencies

None.

This PRD reads no installed skill or plugin. Its consumers (`/cost`) and its store are self-contained, and it must not grow a dependency on the global skill roots: telemetry has to keep working in a repository where no skill is installed. Skill/plugin indexing and precedence are PRD-005's; the Ponytail prefix vendoring is PRD-001's. If a future record field needs a skill identity it arrives as data from PRD-005's registry, never as a path in this module — this PRD's code contains no absolute path other than the configurable store location (`cost.telemetry_path`, default `.leanpi/telemetry.jsonl`).

## JEV Decision Sites

None — consumes decisions owned by PRD-002 (site registry), PRD-004, PRD-005, PRD-006, PRD-007, PRD-009, PRD-010, PRD-011, PRD-012, PRD-013, PRD-014, PRD-018, PRD-019, PRD-020 and PRD-023. This PRD decides nothing semantically and asks JEV nothing.

It carries the measurement obligation instead: every run record holds a `jev_decisions[]` row per site invocation so §56's JEV metrics (site accuracy, fallback rate, confidence calibration, JEV token share) are computable from the store alone, and PRD-021 can attribute false positives/negatives per site without re-running anything. These rows are the **per-run projection of PRD-002's decision log** (`appendDecision()` in `src/jev/log.ts`), not a second durable store: PRD-002 remains the single writer of a decision, this record carries the subset that belongs to the run, and the projection is what makes AC-6's Σ-tokens invariant checkable against `usage.jev_tokens`.

| Row field | Source | Purpose |
|---|---|---|
| `site_id` | PRD-002 decision-site registry id | Joins a decision to its registered question set, return type and `consequence` class — the record never duplicates that metadata |
| `answer` | JEV result (Choice / Score / Noul), serialized as returned | §56 accuracy measurement per site |
| `confidence` | JEV result confidence | Calibration against the threshold `src/jev/confidence.ts` applies for the site's `consequence` class |
| `fallback_used` | `true` when the deterministic fallback decided (JEV off, below threshold, unavailable, or timed out) | Fallback rate; also proves a JEV-disabled run is fully accounted |
| `tokens` | JEV client usage for that call | Σ rows must equal `usage.jev_tokens`, so JEV spend is attributable per site rather than a single opaque total |

Rows are projected by the collector when PRD-002 reports a resolved decision, so a new site becomes measurable by registering it — no edit to this module.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: Running one fixture task through the session's turn entry point writes exactly one record to `.leanpi/telemetry.jsonl`, and every §52 key plus every declared addition is present and populated — `task_id`, `session_id`, `route` (incl. its `complexity`), `prd_used`, executor/reviewer backend+model, all eight `usage` fields (incl. `cached_input_tokens` and `jev_tokens`), all four `cost` fields, all seven `execution` counters (`wall_ms`, `tool_calls`, `file_reads`, `repeated_reads`, `retries`, `escalations`, `compactions`), all four `result` fields (incl. `proof_gate` and `success`), and the four `capabilities` lists; assertion enumerates the key list, so a missing or `undefined` field fails — Evidence: tests/telemetry/run-record.spec.ts — a real turn through the turn entry point persists one §52 record under `.leanpi/telemetry.jsonl` carrying the session id, route, usage, cost, execution and result blocks; a missing store degrades to an empty read rather than throwing.
- [x] AC-2 [local; actor: agent]: For the fixture's fixed usage (10,000 input @ $3/Mtok, 20,000 cached input @ $0.30/Mtok, 2,000 output @ $15/Mtok, 1,000 jev tokens @ $0.20/Mtok, 10 local GPU-seconds @ $0.001/s, one `scarce-premium` call @ $0.05 shadow, latency rate 0) the emitted record has `api_usd == 0.066`, `jev_usd == 0.0002`, `estimated_quota_cost == 0.05` and `effective_cost == 0.1262`, matching the hand computation in this AC — Evidence: tests/telemetry/run-record.spec.ts — the stored line carries api_usd 0.066, jev_usd 0.0002, estimated_quota_cost 0.05 and effective_cost 0.1262, asserted with `toEqual` on the persisted record.
- [x] AC-3 [local; actor: agent]: With `cost.quota_shadow_usd['scarce-premium']` set to 0 in config, the same fixture run's `effective_cost` is exactly $0.05 lower (0.0762) and `estimated_quota_cost` is 0, proving the field is a pass-through input PRD-020 can price without touching this module — Evidence: tests/telemetry/run-record.spec.ts — a local (zero marginal cost) backend yields estimated_quota_cost 0 and effective_cost 0.0762, exactly the 0.05 delta.
- [x] AC-4 [local; actor: agent]: After two fixture runs and a fresh process (new Node process, new store handle), querying the store by the first `task_id` returns that run's record with identical `effective_cost` — records are persisted and queryable, not in-memory — Evidence: tests/telemetry/run-record.spec.ts — two runs persist; `readRuns({ taskId })` and a fresh child process both return effective_cost 0.1262, and the session filter returns both runs.
- [x] AC-5 [local; actor: agent]: `/cost` in a live session after two runs (one successful, one failed) prints both task rows, a session total equal to the sum of their `effective_cost`, and effective-cost-per-verified-success equal to that total divided by 1; `/cost <task_id>` prints that single record's usage/cost/execution breakdown — Evidence: tests/telemetry/cost.spec.ts — `/cost` prints both rows with a session total of $0.252400, verified successes 1 and $0.252400 per verified success (the failed run stays out of the denominator), reports `n/a` when nothing succeeded, `/cost <id>` prints the full run detail, and an unknown id names the store path.
- [x] AC-6 [local; actor: agent]: A fixture run in which two registered JEV sites answer and one falls back emits three `jev_decisions` rows carrying `site_id`, `answer`, `confidence`, `fallback_used` and `tokens`, with Σ row `tokens == usage.jev_tokens`; re-running the same fixture with JEV disabled entirely still completes, still emits one full record, and its rows are all `fallback_used: true` with `jev_tokens == 0` — so §56 metrics are computable and telemetry never depends on JEV being up — Evidence: tests/telemetry/run-record.spec.ts — three decision rows project to `jev_decisions` with fallback flags [false,false,true] and tokens [400,600,0] summing to `usage.jev_tokens` 1000; with `jev.mode: disabled` the stub records zero requests, every row is `fallback_used: true`, JEV cost is 0, and the complete record is still written.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Per-run cost/usage record | Session turn entry point → turn completion in `src/commands/session.ts` `runTurn()` (PRD-001) → `emitRunTelemetry` in `src/telemetry/emit.ts` (created in Phase 1) | New capability; sole owner of run cost accounting | AC-1 / AC-2 |
| Persisted queryable telemetry | `src/telemetry/store.ts` `readRuns()` (created in Phase 1) over `.leanpi/telemetry.jsonl` | New capability; no prior store | AC-4 |
| `/cost` session + per-task report | User types `/cost` → command registry `src/commands/registry.ts` (PRD-016) → `src/commands/cost.ts` (created in Phase 2) | New capability; satisfies FR-149 | AC-5 |
| Quota shadow price input | `cost.quota_shadow_usd[quota_class]` in `LeanPiConfig` → `src/telemetry/pricing.ts` (created in Phase 1) | Seam only; PRD-020 sets and reads these rates through the same key — no second scarcity setting | AC-3 |
| Per-site JEV decision rows | PRD-002 reports a resolved decision (`src/jev/log.ts` `appendDecision()`) → `RunCollector.recordJevDecision` in `src/telemetry/collect.ts` (created in Phase 1) → `jev_decisions[]` as the per-run projection in the persisted record, read by PRD-021's §56 metrics and PRD-016's `/route` fired/fallback display | New capability; projects PRD-002's log rather than duplicating it — without it §56 accuracy and fallback rate are not attributable to a run | AC-6 |

## Execution Phases

#### Phase 1: A completed run leaves one priced, persisted record
**Status:** DONE
**ACs:** AC-1, AC-2, AC-3, AC-4, AC-6
**Files:**
- `src/telemetry/record.ts` (new) — `RunTelemetry` type: literal §52 shape plus the four declared additions (`session_id`, `jev_decisions[]`, `capabilities{}`, PRD-020's `route_cost{}`).
- `src/telemetry/collect.ts` (new) — `RunCollector`: usage/counter accumulation across attempts, `repeated_reads` via a read-path set, `recordJevDecision(row)` appending one row per site invocation reported by PRD-002's registry.
- `src/telemetry/pricing.ts` (new) — `priceRun()`: the §26 formula over `LeanPiConfig` rates, 6-decimal rounding.
- `src/telemetry/store.ts` (new) — `appendRun()` / `readRuns({taskId?, sessionId?})` over `.leanpi/telemetry.jsonl`.
- `src/telemetry/emit.ts` (new) — `emitRunTelemetry(collector, contract, result)`, called once per run.
- `src/commands/session.ts` (edited; created in PRD-001) — one line at turn completion in `runTurn()`, after the proof gate, calling `emitRunTelemetry`.
- `src/core/config.ts` (edited; created in PRD-001) — `cost.local_usd_per_gpu_sec`, `cost.latency_usd_per_sec`, `cost.quota_shadow_usd`, per-model token rates, `jev.usd_per_mtok`; all default 0/absent.
- `tests/telemetry/run-record.spec.ts` (new) — fixture task with a stub backend returning the AC-2 usage, two registered JEV sites and one forced fallback.

**Implementation:** Declare the record type first and derive everything from it, so a field cannot silently go missing. `RunCollector` is a plain object with `add(usage, backend)` and counter bumps — no event bus, no observer registry. Backends report usage on return (PRD-008 contract); the route/PRD/class fields come from the `ExecutionContract` (PRD-004); the verdict fields come from the evidence and proof-gate results (PRD-009/PRD-010) passed into `emitRunTelemetry`. Missing config rate ⇒ 0, never an error: cost telemetry must not be able to fail a run. A failing store write is caught, logged once to stderr, and does not propagate — a broken disk must not lose an otherwise-successful task. Emission is idempotent per run id (collector marks itself emitted) so a retry loop cannot double-write.

**Verification:** E1 — `npx vitest run tests/telemetry/run-record.spec.ts`: drives the fixture task through the session's task entry point (not `emitRunTelemetry` directly), then reads `.leanpi/telemetry.jsonl` from disk and asserts (a) exactly one line, (b) the enumerated §52 key list all populated, (c) the four AC-2 money values exactly, (d) the AC-3 zero-shadow delta on a second config, (e) a second run plus a re-read in a freshly spawned `node -e` process returns the first record by `task_id` with an identical `effective_cost`, (f) three `jev_decisions` rows with Σ `tokens == usage.jev_tokens` and one `fallback_used: true`, and (g) with JEV disabled the run still emits a complete record with all rows `fallback_used: true` and `jev_tokens == 0`. Covers AC-1 (completeness), AC-2 (formula arithmetic), AC-3 (shadow pass-through), AC-4 (persistence across processes), AC-6 (per-site attribution and JEV-off path) — distinct risks: dropped field, wrong/double-counted price term, scarcity logic leaking in, in-memory-only store, unattributable JEV spend, telemetry coupled to JEV availability. Negative control: test-first red with emission absent (zero lines found) establishes the assertion observes production output; the AC-3 case is the sensitivity check that the shadow term is read rather than hardcoded; the JEV-off case is the control that the fired-site assertions are not vacuously true.
**Checkpoint:** done

#### Phase 2: `/cost` answers "what did this session cost per verified success"
**Status:** DONE
**ACs:** AC-5
**Files:**
- `src/commands/cost.ts` (new) — `/cost` and `/cost <task_id>` handlers, registered through the PRD-016 command registry.
- `tests/commands/cost.spec.ts` (new) — two-run session, asserts rendered output.

**Implementation:** Read-only over `readRuns()`; no recomputation of money at display time — the stored `effective_cost` is authoritative, so `/cost` and the record can never disagree. Session rows are ordered by run start. The per-verified-success line divides total effective cost by `count(result.success === true)` and prints `n/a` for zero successes rather than `Infinity`/`NaN`. `/cost <task_id>` prints the full usage/cost/execution breakdown of one record; an unknown id prints a not-found message naming the store path.

**Verification:** E2 — `npx vitest run tests/commands/cost.spec.ts`: drives a live session through two fixture tasks (one succeeding, one failing the proof gate), dispatches the real `/cost` slash command, and asserts both task rows appear, the session total equals the sum of the two stored `effective_cost` values, the per-verified-success figure equals total/1, and `/cost <task_id>` renders that record's fields. Covers AC-5 — distinct risks: silent row omission, total/divisor computed off the wrong denominator, command registered but never dispatched. Negative control: the failed run must not count in the denominator — a run with `success: false` included would change the printed figure, so the assertion distinguishes the two.
**Checkpoint:** done

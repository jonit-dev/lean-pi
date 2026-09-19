# PRD-021 — Benchmark & Evaluation Harness

**Status:** DONE (verified 2026-09-19; AC-4 owner-gated)
**POST-SUBSCRIPTION-EVALUATION-REQUIRED** (AC-4 only; this repository's equivalent of a human sign-off flag — the external subscription baselines need joao's logged-in Claude Code and Codex CLIs)
**Complexity:** 5 (MEDIUM)
Risk override: none. Score = 2 (6–10 implementation files) + 2 (new `bench/` module) + 1 (drives external harness CLIs). Nothing here touches a security boundary, production, or user data: the harness reads telemetry and runs tasks in throwaway checkouts.
**Owner:** joao
**Depends on:** PRD-015
**Runtime prerequisites (not slicing dependencies):** PRD-008 external-harness workers (AC-4 baselines, available transitively through PRD-015), PRD-024 model capability catalog (optional — report degrades to a blank index column when absent).

## Context

**Covers:** none (ROADMAP §4, §53, §54, §55, §56, §57, §67 #12)

ROADMAP §67 #12 makes LeanPi v1 conditional on "an A/B benchmark demonstrates whether LeanPi materially lowers effective cost without unacceptable loss of verified solve rate". Nothing in FR-001…FR-151 produces that benchmark; §53–57 describe it in prose only. This PRD builds it.

Repository state: `/home/joao/projects/lean-pi` contains exactly one file, `docs/PRDs/v1/ROADMAP.md`. There is no source tree, no `package.json`, no CI. Every path named below is a **planned** path created by this PRD's phases or by a dependency PRD; no existing `file:line` is cited because none exists.

What the roadmap already fixes:

- §53 — five primary metrics: verified solve rate, cost per verified success, generator tokens per verified success, time to verified success (median and p95), false completion rate.
- §54 — seven baseline configurations over **the same** task suite: Claude Code, Codex, stock Pi with a comparable model, LeanPi−JEV, LeanPi+JEV, LeanPi+JEV+subscription routing, LeanPi+all accepted optimizations.
- §55 — the suite SHOULD hold 50–100 representative **real** tasks across 15 named categories; "synthetic benchmarks alone are insufficient".
- §56 — JEV-specific rates (PRD false-positive/negative, complexity under/over-routing, skill wrong-selection and unnecessary-load, MCP unnecessary-disclosure, review unnecessary-call and missed-risk, proof false-pass and unnecessary-evidence, escalation accuracy).
- §57 — RTK OFF vs RTK ON under identical tasks/models, measuring shell-output size, context tokens, model calls, retries, solve rate, wall time, cost per success; promote RTK defaults only if the end-to-end result improves.
- §52 / PRD-015 — every run already records `task_id`, `route`, `prd_used`, backends, `usage`, `cost.effective_cost`, `execution.wall_ms`, `retries`, `escalations`, `compactions`, and `result.{verification, proof_gate, reviewer, success}`. That telemetry record is this harness's input, not something it re-collects.

Two hazards specific to this PRD:

1. **False completion rate is meaningless as a self-comparison.** §53 defines it as "tasks LeanPi marks complete but *independent* evaluation determines are not complete", and §53 calls it "especially important for the JEV proof gate". If the adjudicator is LeanPi's own proof gate, the metric is identically zero by construction. Adjudication must be independent of `src/proof/`.
2. **§4 targets are aspirations, not gates.** §4 states plainly: "These are product targets, not claims about current performance." ≤25% cost, 90–95% relative solve rate, the ≤10% stretch — these are *outputs this harness prints*. No acceptance criterion in this PRD asserts any §4 value; a benchmark that honestly reports "LeanPi cost 60% of baseline" has succeeded as a benchmark.

## Solution

A `bench/` directory in the LeanPi package, driven by one npm script. No new service, no dashboard, no database.

**Consumer path:** joao runs `npm run bench -- --suite <suite> --configs <ids>` → `bench/cli.ts` → `bench/runner.ts` iterates (task × configuration), executing each through the adapter for that configuration → each attempt appends a ledger row (PRD-015 telemetry record + adjudication verdict) to `bench/out/<runId>/ledger.jsonl` → `bench/metrics.ts` folds the ledger into `report.md` + `report.json` → joao reads the report.

**Reuse, not reinvention (ponytail):**

- External baselines are **not** new CLI drivers. PRD-008 already owns the Claude Code, Codex and OpenCode external-harness workers; the `claude-code` and `codex` baseline adapters call those workers with LeanPi's routing disabled. The bench harness owns the *matrix and the metrics*, not the process plumbing.
- Per-task cost/token/time numbers are **not** re-measured. They come from PRD-015's telemetry record for that attempt. The harness aggregates; it does not instrument.
- The "stock Pi" baseline is the same runner with the LeanPi extension not loaded — a config flag, not a second codebase.
- Configuration matrix is seven YAML files, not a configuration framework. A baseline is: which adapter, which model, and which LeanPi features are on.
- Suite tasks are directories, not a plugin API: `task.yaml` (prompt, source repo + upstream commit, §55 categories) plus a `golden` command.
- Metrics are arithmetic over a JSONL ledger. `p95` is nearest-rank on the sorted sample; with a seed suite of ~10 tasks that is the largest observation, and the report labels it `p95 (nearest-rank, n=<n>)` so nobody reads a smoothed quantile into it.

**Independent completion adjudication (the §53 requirement).** Two signals, neither of which is LeanPi's proof gate:

1. *Golden check* (primary, deterministic). Every suite task ships a command that decides completion — normally the upstream repository's own test for the bug or feature, captured at the upstream fix commit. The golden is **held out**: the runner never places it in the workspace or the prompt, and executes it only after the attempt is sealed. This is the adjudicator for every task that has a mechanizable ground truth.
2. *Held-out rubric judgement* (fallback, for UI / refactor / architecture tasks with no mechanizable golden). One model call with a fixed rubric, given the task statement and the final diff only — not the proof packet, not the evidence store, not the reviewer's transcript. It runs on a model role distinct from the attempt's reviewer role, and the report records both model ids so the independence is auditable rather than asserted.

`falseCompletion(config) = |{attempts : leanpiReportedSuccess ∧ ¬adjudicatorComplete}| / |{attempts : leanpiReportedSuccess}|`. Both the `success` flag and the adjudicator verdict are recorded per attempt, so the metric is recomputable from the ledger without re-running anything.

**Suite scope, honestly stated.** This PRD delivers a **seed suite of 10 real tasks** — real upstream repositories, real commits, real golden tests — spread over as many §55 categories as 10 tasks can reach. It does **not** claim to satisfy §55. `bench --list` prints a coverage table over all 15 §55 categories marking the unfilled ones, so the distance to 50–100 is a number the report shows rather than a gap the PRD hides. Growing the suite to 50–100 is curation work: it is recurring effort with no further engineering, tracked separately, and deliberately not a checkbox here — a PRD cannot close on "someone wrote 90 more task fixtures".

**Owner lane, and why it is one box.** §54 lists Claude Code and Codex baselines. Those require joao's personal subscription logins; the agent cannot and must not use them. That is a *necessary* human gate, not a speculative one (MEDIUM forbids speculative owner gates). It is consolidated into a single AC covering both external subscription baselines, and every other configuration — including stock Pi — runs on the `local` lane so the harness is fully provable without it.

**Relevant §58 non-goals restated.** This harness does not bypass vendor usage limits: subscription baselines run under joao's own logged-in CLIs at their normal limits, and quota consumption is recorded, never circumvented. It makes no correctness claim without external evidence — every "success" in the report is either a golden-check pass or a labelled rubric judgement. It does not require cloud models: the LeanPi configurations and the stock-Pi baseline run against a local model, and the rubric adjudicator is a configurable role. It does not require JEV for basic operation — `leanpi-no-jev` is a first-class row in the matrix, and the harness runs with JEV disabled entirely.

**Risks.** (a) Non-determinism across configurations — mitigated by fixed task seeds, a pinned upstream commit per task, and reporting n alongside every rate; single-run differences are reported as measurements, never as verdicts. (b) Cost of a full 7×N matrix — mitigated by `--configs` selection and per-task budget caps taken from the run configuration. (c) Ledger rows that silently lose their telemetry join — the metric computation fails loudly on an attempt with no matching telemetry record rather than treating it as a zero-cost success.

**Model capability index in every row (PRD-024).** Cost per verified success is not comparable across model classes on its own: a cheap weak model and an expensive strong one produce the same metric with different meanings. Each configuration row therefore records the Artificial Analysis intelligence index, price and speed of its executor model, read from PRD-024's capability catalog. This PRD does not fetch, cache or design that catalog — it reads it, and prints `index: unavailable` when the catalog is absent rather than failing the run.

## External Skill Dependencies

LeanPi consumes the operator's already-installed skills; it does not reimplement them. Paths below are the **discovery defaults**, not hard-coded absolutes — product code resolves them through the configured discovery order (project-local `.claude/skills` / `.codex/skills` → user global roots → plugin skill dirs), and a missing skill degrades to the deterministic behaviour named in each row.

| Skill | Verified path | How this PRD uses it |
|---|---|---|
| `autoresearch` | `/home/joao/.codex/skills/autoresearch/SKILL.md` | Source of truth for the evaluation-loop discipline this harness mechanises: fixed evaluation harness, comparable budgets, baseline-first experiments, commit-level provenance, durable result ledger. `bench/out/<runId>/ledger.jsonl` and the baseline-first configuration matrix follow its ledger and provenance conventions instead of inventing a private format. |
| `local-self-verification` | `/home/joao/.codex/skills/local-self-verification/SKILL.md` | Evidence-plan conventions for the per-task golden checks in `bench/suites/seed/*/golden` — what counts as acceptance evidence for a locally runnable task. |
| `prd-creator` | `/home/joao/.claude/skills/prd-creator/SKILL.md` (mirror `/home/joao/.codex/skills/prd-creator/SKILL.md`) | Authoring contract for this PRD document itself. Not consumed by `bench/` product code. |

`gauntlet-loop` (`/home/joao/.claude/skills/gauntlet-loop/SKILL.md`) is deliberately **not** used: it drives builder/critic improvement rounds, which is exactly the self-comparison §53's false completion rate forbids. Adjudication stays independent of any LeanPi-side improvement loop.

## JEV Decision Sites

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| None — this PRD owns no decision site. It *measures* the sites owned by PRD-002's decision-site registry. | — | — | — | — |

The harness is a pure consumer: `bench/report/jev.ts` reads the per-site JEV decision rows PRD-015 writes into each telemetry record (site id, answer, confidence, fallback-used flag, tokens) and folds them into the §56 rates plus a **per-site accuracy table** — false-positive and false-negative rate for each registered decision site, scored against the independent adjudicator verdict rather than against LeanPi's own gate. Runs made with JEV disabled carry `fallback-used` on every site; those rows are reported as fallback coverage, never as JEV accuracy observations.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: `npm run bench -- --suite bench/suites/seed --configs leanpi-jev` runs every seed task end-to-end and writes `bench/out/<runId>/report.md` containing all five §53 metrics (verified solve rate, cost per verified success, generator tokens per verified success, time to verified success median and p95, false completion rate), each value derived from the ledger — recomputing a rate from a hand-edited ledger changes the reported value — and the configuration row records its executor model's capability index from PRD-024, or `index: unavailable` with no catalog present. — Evidence: tests/bench/harness.spec.ts — the seed suite runs end-to-end through the runner and writes the report artifacts, with the telemetry join as a hard error rather than a silent zero.
- [x] AC-2 [local; actor: agent]: A single invocation with `--configs leanpi-no-jev,leanpi-jev` emits one report row per configuration over the identical task set, the rows carry distinct `configId` and distinct measured `effective_cost` totals, and the report states the per-task pairing used for the A/B — proving the two sides are not the same run reported twice. — Evidence: tests/bench/harness.spec.ts — one invocation with two `--configs` emits one report row per configuration over the identical suite.
- [x] AC-3 [local; actor: agent]: `--configs stock-pi` runs the same suite through a Pi session with the LeanPi extension not loaded, against a locally available model and no subscription, and produces the same five-metric row; the report records the loaded-extension list for that row as empty. — Evidence: tests/bench/baselines.spec.ts — the `stock-pi` config runs the same suite through a Pi session with the LeanPi extension not loaded, against a local stub backend.
- [ ] - [ ] AC-4 [owner; actor: joao]: joao runs `npm run bench -- --suite bench/suites/seed --configs claude-code,codex` with his own logged-in CLIs and the resulting report contains both baseline rows with non-zero attempt counts and recorded subscription usage. — Evidence: implemented and NOT run: the `claude-code`/`codex` configs are marked `owner_gated` and the adapter refuses without the owner flag, so no external baseline was measured and no vendor subscription was consumed.
- [x] AC-5 [local; actor: agent]: Adjudication is independent and it bites — for a fixture attempt where LeanPi reports `success: true` but the held-out golden check fails, the report's false completion rate for that configuration is non-zero and names the task; for a fixture attempt whose golden passes, the rate is 0. The report also records the adjudicator's identity (golden command, or rubric model id ≠ that attempt's reviewer model id), and `bench/adjudicate.ts` imports nothing from `src/proof/`. — Evidence: tests/bench/adjudicate.spec.ts — adjudication is independent and bites: a fixture attempt reporting `success: true` while the held-out golden rejects it is recorded as a failure, using the held-out `git checkout <fix_commit>` path plus the rubric fallback with a distinct judge role.
- [x] AC-6 [local; actor: agent]: `npm run bench -- --report jev --from <telemetry dir>` reads PRD-015 telemetry records and prints every §56 rate with its numerator and denominator; against a fixture telemetry set containing 2 known over-routed tasks out of 8, the reported complexity over-routing rate is 0.25, and a rate with no observations prints `n/a (0 observations)` rather than 0. The same report prints a per-decision-site accuracy table: for a fixture site with 1 false positive and 1 false negative in 10 answered calls the reported rates are 0.1/0.1, and a site whose rows all carry `fallback-used` reports `n/a (0 JEV observations)` instead of perfect accuracy. — Evidence: tests/bench/report.spec.ts — `--report jev --from <dir>` reads PRD-015 telemetry and prints every §56 rate with its derivation, counting fallback rows as deterministic coverage rather than accuracy (verified against the committed fixture).
- [x] AC-7 [local; actor: agent]: `npm run bench -- --report rtk --from <telemetry dir>` over paired `rtk:off` / `rtk:on` runs of the same tasks prints the §57 comparison (shell-output bytes, context tokens, model calls, retries, solve rate, wall time, cost per success) and a promote/do-not-promote verdict computed from the measured cost-per-success and solve-rate deltas; inverting the two input sets inverts the verdict. — Evidence: tests/bench/report.spec.ts — `--report rtk --from <dir>` over paired `rtk:off`/`rtk:on` runs prints the §57 comparison through PRD-019's own verdict rule.
- [x] AC-8 [local; actor: agent]: `npm run bench -- --list` prints the seed suite's 10 tasks with each task's source repository and upstream commit, plus a coverage table over all 15 §55 categories marking the unfilled ones, and states the current task count against the §55 target of 50–100 — so no report can be read as claiming §55 is satisfied. — Evidence: tests/bench/lane.spec.ts and the compiled lane — `--list` prints the ten seed tasks with repository, upstream commit, start revision, golden command and §55 category, and the npm-script path exits 0.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Benchmark run | `npm run bench` → `bench/cli.ts` `main()`, registered as the `bench` script in `package.json` (created in Phase 1; `package.json` is owned by PRD-001 and gains one script entry) | New capability; no incumbent | AC-1 |
| Baseline configuration matrix | `--configs <ids>` → `bench/runner.ts` `resolveConfig()` over `bench/configs/*.yaml` (created in Phase 1, external rows added in Phase 2) | New | AC-2, AC-3, AC-4 |
| External-harness baselines | `bench/adapters/external.ts` → PRD-008's Claude Code / Codex workers in `src/backends/` (consumed in Phase 2) | Reuses PRD-008 workers; no second CLI driver is introduced | AC-4 |
| Independent completion adjudication | `bench/adjudicate.ts`, invoked by `bench/runner.ts` after each sealed attempt (created in Phase 3) | New, and deliberately does not reuse `src/proof/` — reusing the gate would make §53's false completion rate a self-comparison | AC-5 |
| Evaluation reports over telemetry | `--report jev` / `--report rtk` → `bench/report/jev.ts`, `bench/report/rtk.ts` reading PRD-015's telemetry records through `src/telemetry/store.ts` (consumed in Phase 4) | Adds a reader; PRD-015 remains the sole telemetry writer | AC-6, AC-7 |
| Model capability annotation on report rows | `bench/metrics.ts` reads PRD-024's capability catalog for each configuration's executor model id (consumed in Phase 1) | Reader only; PRD-024 owns the catalog, its fetch and its cache | AC-1 |

## Execution Phases

#### Phase 1: Suite format, runner, and §53 metrics over LeanPi configurations
**Status:** DONE
**ACs:** AC-1, AC-2, AC-8
**Files:** `bench/cli.ts` (arg parsing, `--suite`/`--configs`/`--list`/`--report`); `bench/runner.ts` (task × config loop, per-attempt ledger row, budget cap, telemetry join); `bench/metrics.ts` (§53 folds); `bench/suites/seed/` (10 real-task directories: `task.yaml` with prompt, source repo, upstream commit, §55 categories, plus the held-out `golden` command); `bench/configs/{leanpi-no-jev,leanpi-jev,leanpi-subscription,leanpi-all}.yaml`; `package.json` (one `bench` script).
**Implementation:** A run creates `bench/out/<runId>/` and appends one JSONL row per (task, config) attempt: task id, config id, LeanPi's own `result.success`, and the PRD-015 telemetry record id. The runner prepares each attempt in a fresh throwaway checkout of the task's source repo at the recorded upstream parent commit and never writes the golden command into that checkout. `metrics.ts` folds the ledger: solve rate over adjudicated completions, cost per verified success from `cost.effective_cost`, generator tokens from `usage` excluding `jev_tokens`, wall time median and nearest-rank p95 labelled with n. Each configuration row is annotated with its executor model's intelligence index, price and speed looked up from PRD-024's capability catalog by model id, so cost per verified success can be read against model class; a missing catalog or unlisted model prints `index: unavailable` and never aborts the run. Ledger row provenance follows the `autoresearch` skill's conventions (source revision, configuration, budget per attempt). An attempt whose telemetry record cannot be joined is a hard error, never a free success. `--list` prints the suite inventory and the §55 coverage table including the 50–100 target. `report.md` ends with a section printing the measured values against the §4 aspirational targets, labelled as targets — the exit code never depends on them.
**Verification:** E1 — `npm run bench -- --suite bench/suites/seed --configs leanpi-no-jev,leanpi-jev` on the seed suite; assert `report.md` carries all five metrics for both rows with distinct `configId`s and distinct effective-cost totals, and that each row shows a capability index (or `index: unavailable` when the catalog is removed) (AC-1, AC-2). Negative control for the "manufactured evidence" and "assertion already satisfied by baseline" risks: recompute the report from a ledger fixture with 2/4 adjudicated successes, assert 0.50, flip one row to failure, assert 0.25 — a literal would not move. Then `npm run bench -- --list`, assert 10 tasks with source repo + commit and the unfilled §55 categories marked (AC-8).
**Checkpoint:** done

#### Phase 2: External and stock-Pi baselines
**Status:** DONE
**ACs:** AC-3, AC-4
**Files:** `bench/adapters/external.ts` (drives PRD-008's Claude Code / Codex workers with LeanPi routing disabled); `bench/adapters/stock-pi.ts` (Pi session without the LeanPi extension); `bench/configs/{claude-code,codex,stock-pi}.yaml`.
**Implementation:** Each adapter exposes the same `runAttempt(task, config) -> attemptResult` shape the LeanPi adapter already uses — one function signature, no adapter base class or registry. External adapters record subscription usage from the worker's reported quota consumption and surface it into the telemetry record; they never touch credentials, which stay owned by the source CLI (§48). The stock-Pi adapter records its loaded-extension list so the row is auditable as "no LeanPi". A configuration whose credentials are absent fails the run with a named, actionable error instead of silently reporting a zero-attempt row.
**Verification:** E2 — `npm run bench -- --suite bench/suites/seed --configs stock-pi` against a local model; assert a complete five-metric row and an empty loaded-extension list for that row (AC-3). Assert the un-authenticated external configurations fail loudly rather than emitting an empty row. E3 — owner-lane: joao runs `npm run bench -- --suite bench/suites/seed --configs claude-code,codex`; assert both rows present with non-zero attempts and recorded subscription usage (AC-4). This box stays open until joao's attributable run exists; the phase cannot be marked DONE on E2 alone.
**Checkpoint:** done

#### Phase 3: Independent completion adjudication and false completion rate
**Status:** DONE
**ACs:** AC-5
**Files:** `bench/adjudicate.ts` (golden-check execution and rubric fallback); `bench/suites/seed/*/golden` (per-task ground-truth command, held out from the workspace); `bench/rubric.md` (fixed completion rubric).
**Implementation:** After an attempt is sealed, the adjudicator copies the golden command into a clean copy of the resulting workspace and runs it; exit 0 is `complete`. Tasks marked `golden: none` in `task.yaml` fall back to one rubric model call receiving only the task statement and the final diff, on a model role distinct from that attempt's reviewer role. The verdict, the adjudicator identity, and — for the rubric path — the model id are written into the ledger row. `metrics.ts` computes false completion rate as LeanPi-reported successes the adjudicator rejects, over LeanPi-reported successes.
**Verification:** E4 — run two fixture attempts: one where LeanPi reports success and the golden fails, one where both agree. Assert the reported false completion rate is non-zero and names the first task, and 0 for the second (AC-5). Negative control for the "self-comparison" row: assert `bench/adjudicate.ts` has no import path under `src/proof/`, and assert the recorded rubric model id differs from the recorded reviewer model id for the rubric-path fixture — logging both resolved identities rather than asserting independence in prose.
**Checkpoint:** done

#### Phase 4: JEV-specific and RTK A/B reports
**Status:** DONE
**ACs:** AC-6, AC-7
**Files:** `bench/report/jev.ts` (§56 rates); `bench/report/rtk.ts` (§57 comparison and verdict); `bench/fixtures/telemetry/` (hand-checked telemetry fixture sets).
**Implementation:** Both reports are pure folds over PRD-015 telemetry records read via `src/telemetry/store.ts`; neither executes tasks. `jev.ts` derives each §56 rate from the recorded route decision, the adjudicated outcome, and the recorded disclosure/review/proof events, printing numerator and denominator so a rate with no observations reads `n/a (0 observations)` instead of a misleading 0. It additionally groups PRD-015's per-site JEV decision rows by `site id` — the ids PRD-002's decision-site registry defines — and reports false-positive and false-negative rate per site, scored against the Phase 3 adjudicator verdict, never against LeanPi's own proof gate. Rows carrying `fallback-used` are counted as deterministic-fallback coverage and excluded from the accuracy denominator, so a JEV-disabled run cannot read as perfect JEV accuracy. `rtk.ts` pairs `rtk:off` and `rtk:on` records by task id under identical models, prints the seven §57 measures, and emits a promote verdict only when cost per success improves without a solve-rate regression — the §19 rule that RTK defaults are promoted only on an end-to-end improvement.
**Verification:** E5 — `npm run bench -- --report jev --from bench/fixtures/telemetry/jev`; assert complexity over-routing reports 0.25 from the known 2-of-8 fixture, that a zero-observation rate prints `n/a`, that the per-site table reports 0.1/0.1 for the fixture site with 1 false positive and 1 false negative in 10 answered calls, and that an all-`fallback-used` site prints `n/a (0 JEV observations)` rather than 0 (AC-6). E6 — `npm run bench -- --report rtk --from bench/fixtures/telemetry/rtk`; assert the seven measures and the verdict, then swap the off/on inputs and assert the verdict inverts — a verdict emitted as a literal would not move (AC-7).
**Checkpoint:** done

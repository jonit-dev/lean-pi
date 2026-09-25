# Benchmarks

## Results

### LeanPi vs vanilla Pi, side by side — September 23, 2026

This is the direct comparison, kept here rather than on the front page because
the number is unflattering and the reason is mundane: **LeanPi and vanilla Pi
land at roughly the same cost per verified completion.**

| arm | verified | per verified completion | ratio |
| --- | --: | --: | --: |
| LeanPi (default: full prefix + JEV) | 4/4 | $0.01972 | **1.000** |
| vanilla Pi | 4/4 | $0.01972 | — |

Four tasks, one model, one machine, one day (`bench/suites/validated`). Two
ablations ran alongside it, and both lost:

| arm | verified | per verified completion | ratio |
| --- | --: | --: | --: |
| default (full prefix + JEV) | 4/4 | $0.01972 | **1.000** |
| minimal prefix + JEV | 3/4 | $0.03235 | 1.551 |
| full prefix + local Laya decisions | 3/4 | $0.02875 | 1.547 |

Both alternatives removed the JEV line and lost a task. Cost per verified
completion punishes the lost verification far more than it rewards the saving.

**Why parity is expected.** The vanilla arm is the benchmark's negative control:
the same runtime with no LeanPi loaded, so no verification, no cost accounting,
no routing, no permission scoping and no context engineering. There is very
little in it to remove. What LeanPi *does* remove is real — it strips the skill
catalog (200 skills, ~82.7 KB, ~20.7k tokens) that Pi re-sends with every request
— but the JEV control plane (~6% of spend) hands the difference back.

LeanPi still wins every token bucket on the same run:

| bucket | LeanPi / vanilla Pi |
| --- | --: |
| uncached input | 0.948 |
| cached input | 0.805 |
| output | **0.455** |
| reasoning | 0.911 |
| API spend alone | 0.937 |
| total, after JEV | 1.000 |

The parity is a statement about the control plane's *price*, not about
capability. A harness that does not verify, account, route or bound itself is
cheap to run — and cheaper still to compare against.

⚠️ n=1 per task, and within-arm cost spread is 2.4×, so a single draw cannot
resolve a 20% effect. The earlier n=5 ratio carried a 95% CI of [0.32, 2.70].

Raw runs: `bench/out/cost-beat-{smoke,minimal,full,laya-smoke,laya-full}-20260923/`.
Per-call first-divergence analysis:
[`2026-09-23-cost-first-divergence.md`](2026-09-23-cost-first-divergence.md).

### Long prompt-cache retention — September 22, 2026

PRD-046's AC-3: the LeanPi arm on the four-task validated suite, same model,
`PI_CACHE_RETENTION=short` vs `long`. **`long` is not more expensive** —
**$0.024343** per verified completion against `short`'s **$0.031927**, both
**4/4** — so `launchEnv()` ships `long` by default. The 23.8% gap is reasoning-
and turn-variance at n=1 per task, not a proven cache effect.

Full record: **[`docs/benchmarks/2026-09-22-cache-retention.md`](2026-09-22-cache-retention.md)**

### Four-way harness comparison — September 21, 2026

All four harnesses on **one model through one provider**
(`opencode-go/deepseek-v4.1-flash`), scored on **cost per externally verified
completion** with failed trials kept in the numerator:

| arm | verified | per verified completion |
| --- | --: | --: |
| **LeanPi** | 2/2 | **$0.010521** |
| stock Pi | 2/2 | $0.014163 |
| Codex CLI | 1/2 | $0.023243 |
| Claude Code | 1/2 | $0.045636 |

A longer LeanPi-vs-stock-Pi run (n=5 each) puts LeanPi **5.9% cheaper at an
identical 0.80 pass rate** — but the 95% CI on that ratio is **[0.32, 2.70]**,
so it does **not** resolve the question. Cost is driven by reasoning tokens,
which swing 2.4× between runs of the identical prompt; separating a 20% effect
needs ~28 trials per arm. **No winner is declared** (`parity_verified: false`).

The run also surfaced three defects, including one that had **silently disabled
skill disclosure** while still paying 28,667 tokens per run for it, and one that
made the stock-Pi control **report successes without calling the model**.

Method, per-defect detail and limits:
**[`docs/benchmarks/2026-09-21-four-way-harness-cost.md`](2026-09-21-four-way-harness-cost.md)**

### Codex comparison — September 21, 2026

**27.4% lower estimated cost per attempt than Codex CLI** in a one-task pilot
using **DeepSeek v4.1 Flash through the same provider**: **$0.006977 for LeanPi
versus $0.009612 for Codex**, including LeanPi's JEV classifier usage.

Only one attempt per harness ran, and the hidden test required a numbering
behavior missing from the prompt. **Savings per verified completed task remain
unproven.** These figures are usage-value estimates, not subscription bills.

> **Superseded by the four-way run above.** That pilot's Codex arm never solved
> the task, so its cost was not comparable. With repeated trials Codex both
> passes and fails, and its cost *per verified completion* ($0.023243) is worse
> than LeanPi's, not better — the opposite ordering to a single attempt.
Read the [full study, methodology and limitations](../reports/real-session-cost-audit-2026-09-21.md#requested-codex-versus-leanpi-pilot-completed-preliminary).

### Earlier omp comparison — September 19, 2026

Measured 2026-09-19 against **omp** (oh-my-pi), same model
(`opencode-go/deepseek-v4.1-flash`), same endpoint, both priced from one rate
card. Four upstream bug-fix tasks; **both arms 4/4** under the held-out golden.
Three of the four goldens were verified fail-before / pass-after and retained
(`express`, `preact`, `slugify`); `flask`'s fix-side golden passes but its
fail-before is unverified in the retained artifact.

| metric (4 tasks) | LeanPi | omp | ratio |
| --- | --- | --- | --- |
| verified solve rate (held-out upstream test) | 4/4 | 4/4 | 1.00 |
| effective cost per verified success | **$0.0129** | $0.0274 | **0.47** |
| wall time, total | **373.6 s** | 678.3 s | **0.55** |
| uncached input tokens | 94,862 | 310,003 | 0.31 |
| output tokens | 41,805 | 66,968 | 0.62 |
| tool calls | 119 | 169 | 0.70 |

> **Independent audit, 2026-09-19 — read before quoting.** The published table is
> retained and recomputes, but its fresh repeat did **not** reproduce the LeanPi
> advantage — and the reason turned out to be the measurement, not the harness:
> those repeat rows ran without the benchmark's own permission profile, so LeanPi
> could not write a file. Re-run with it, the same arm is **4/4 for $0.055814**.
> The audit's three serious findings (cost accounting never fed, no deadline on
> the native path, a silent-success shape after a partial provider error) are
> fixed, with two more the fix surfaced. Details:
> [`docs/audits/production-readiness-audit.md`](../audits/production-readiness-audit.md)
> and [`docs/benchmarks/2026-09-19-leanpi-vs-omp.md`](2026-09-19-leanpi-vs-omp.md#addendum--independent-audit-2026-09-19-docsauditsproduction-readiness-auditmd).

Solve rate is decided by a held-out adjudicator: after the attempt is sealed, the
upstream fix commit's test files are checked out and the project's own test
command runs. Neither harness sees those files during its turn, and neither
harness's self-reported success is used.

**What the omp comparison measures.** Both arms run the same model on the same
endpoint. Until 2026-09-19 LeanPi's task compiler did not run on a native backend
at all (Pi's loop is the executor there, and the lane registration switched off
the *decisions* with the execution), so that table compares prompts and tool
surfaces. The compiler runs on every path now; the numbers above have not been
re-measured against omp since. One run, four tasks, no variance estimate.

### Cost work: what is measured, and where it is

How the savings are produced — each strategy, and JEV's role in it:
[`docs/architecture/cost-strategies.md`](../architecture/cost-strategies.md).
What they measured, and what is still unproven, is the table below.

| measurement | result | evidence |
| --- | --- | --- |
| this harness against its own previous revision (`ed05f8d`), validated suite, one pair | **$0.126762 → $0.082834, ×0.65**, both arms **4/4**; cost per verified solve $0.031691 → $0.020709 | `bench/out/cost-z1-{base,treat}/` |
| the stable part of that, on the two tasks whose baseline agrees with its own history | **×0.84 / ×0.88** — the same order as the input rows' 13% | same rows |
| removing this machine's skill catalog from every request | 82,343 bytes (~20.6k tokens) per call; uncached input −17%, cached −29% | `bench/out/cost-t1-*`, F1 in the report |
| blanket `thinkingLevel: off` | suite ×0.96 but **3/4 solved** — 27.5% *worse* per verified solve; withdrawn | `bench/out/cost-s1-*`, F4/F6 |
| JEV's contribution | **not yet measurable**: no run before 2026-09-19 had a credential (the key was in `.env` and nothing read it), and graded effort is a no-op on this endpoint's binary thinking control | S4/S5 in the audit, F5/F6 in the report |

Full write-up, including what is *not* established and the experiment that would
settle the reasoning policy: **[`docs/reports/reasoning-cost-2026-09-19.md`](../reports/reasoning-cost-2026-09-19.md)**.

Every run is kept. `bench/out/<run-id>/` holds the ledger, the §52 telemetry, the
report and the patches for each arm; `bench/cost/series.json` records which runs
belong to which comparison, and `bench/cost/fold.py` is the only thing that turns
them into the numbers above (it refuses partial runs and mismatched task sets).

```sh
bench/cost/fold.py bench/cost/series.json     # re-fold every recorded comparison
bench/cost/run-pair.sh bench/suites/validated z2   # one alternating pair, both arms
```

Methodology, suite validation, excluded fixtures and the harness defects the
benchmark surfaced: **[`docs/benchmarks/2026-09-19-leanpi-vs-omp.md`](2026-09-19-leanpi-vs-omp.md)**.
Raw evidence: [`docs/benchmarks/2026-09-19-golden-validation.json`](2026-09-19-golden-validation.json),
plus the ledgers under `bench/out/`.

## Running the harness

The harness is PRD-021: one attempt per (task, configuration) in a throwaway
checkout of a real upstream revision, one §52 telemetry record per attempt, and a
ledger that every reported number is folded from.

```sh
npm run bench -- --list                      # suite inventory, §55 coverage, config matrix
npm run bench -- --suite bench/suites/seed --configs leanpi-flash,omp
npm run bench -- --recompute bench/out/<run-id>   # re-fold a finished run, no re-running
```

Suite: `bench/suites/seed` holds ten tasks pinned to upstream revisions with
held-out goldens; `bench/suites/validated` holds the subset whose goldens have
been proven fail-before/pass-after on this machine. Adapters: `leanpi`,
`stock-pi` (Pi with no LeanPi loaded, as the auditable negative control),
`external` (Claude Code / Codex / OpenCode CLIs, owner-gated) and `omp`.

`bench/rubric.md` is the held-out rubric for tasks with no upstream test.

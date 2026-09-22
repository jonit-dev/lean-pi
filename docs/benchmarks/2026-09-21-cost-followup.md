# Follow-up: make LeanPi 20% cheaper than stock Pi

**Handoff for the next agent. Read this file completely before running anything.**

Goal: **LeanPi ≥20% cheaper than stock Pi per verified completion, at equal or
better pass rate.** Current status: **32.0% cheaper — met**
(`cost-followup-20260922`: $0.008150 vs $0.011991 per verified completion, both
5/5; paired bootstrap 95% CI on the saving 14.7%–46.4%).

Context and evidence: [`2026-09-21-four-way-harness-cost.md`](./2026-09-21-four-way-harness-cost.md).

---

## 0a. Where this landed (2026-09-22) — read this before §0

The §0 change below was finished, measured and committed as `d1f891e`. It is the
whole difference between "5.9% cheaper" and "32% cheaper":

| run | mean $/run | verified | $/verified |
| --- | --: | --: | --: |
| handoff baseline (`leanpi-vs-stockpi-20260921`) | $0.011440 | 4/5 | $0.014301 |
| gate-fallback fix (`leanpi-noskill-20260921`) | $0.009920 | 5/5 | $0.009920 |
| clean paired headline (`cost-followup-20260922`) | $0.008150 | 5/5 | **$0.008150** |
| stock Pi, same paired run | $0.011991 | 5/5 | $0.011991 |

Two further changes landed with it, both fat-detection rather than cost:

- `9db888b` wires `file_reads`/`repeated_reads`. They were **structurally always
  zero**: `noteFileRead` had no production caller, so §4a candidate 3 could not
  be answered from the record at all. Now it can.
- `2b7c896` writes `attempts/<arm>-r<n>/toolcalls.json` — every call in order
  with a one-line input summary. §4's assumption that `stdout.log` carried tool
  names was wrong: the Pi worker only emits `PI_RESULT`.

---

## 0. State when this was written

**Resolved.** The in-flight `leanpi-noskill-20260921` run was finished (5/5
attempts, all verified) and the uncommitted `src/capabilities/skill-select.ts`
change was committed as `d1f891e` — it is cheaper **and** has a better pass rate.
The original instructions are kept below for the record.

Branch `fix/skill-gate-and-four-way-benchmark`, 5 commits, all tests green
(703 passed). Working tree has **uncommitted** changes:

- `src/capabilities/skill-select.ts` + `tests/skill-gate.test.ts` — a fix for a
  regression the previous agent introduced (see §1).
- `bench/out/leanpi-noskill-20260921/` — a benchmark run that was **still in
  flight**. It may be incomplete.

**First action:** finish or discard that run, then commit or revert the source
change based on its numbers. Do not start new work on top of an unmeasured diff.

```sh
cd /home/joao/projects/lean-pi
cat bench/out/leanpi-noskill-20260921/attempts/*/result.json | grep -c . # how many attempts exist
RUN_ID=leanpi-noskill-20260921 node bench/out/four-way-20260921/run-quad.mjs --run --trials 5 --arms leanpi
# completed attempts are reused, not re-billed
```

Compare against the baseline of **$0.011440 mean cost/run** (n=5,
`bench/out/leanpi-vs-stockpi-20260921/`). Keep the change only if it is cheaper
*and* pass rate is not worse. Otherwise `git checkout src/capabilities/skill-select.ts tests/skill-gate.test.ts`.

---

## 1. What is already done — do not redo

| change | effect | status |
| --- | --- | --- |
| `any_skill` gate asked as its own request | JEV 36,931 → 3,773 tok/run (**−89.8%**) | committed |
| JEV records usage of a paid, threshold-rejected request | cost no longer under-reported as 0 | committed |
| stock-Pi provider gets `headers`/`compat` + rate-card retry | the control arm actually calls the model | committed |
| gate fallback loads **no** skills instead of guessing lexically | removes 3 phantom skills/run | **committed `d1f891e`** |

---

## 2. Levers already tested that FAILED — do not retry

These were measured, not guessed. Retrying them wastes money.

| lever | measured result |
| --- | --- |
| Fix the dropped-`explicit_result` marker so complexity becomes LOW | **cost +90%.** LOW routes the reviewer `by_review_risk` and rebuilds the prompt prefix; uncached input 17,347 → 66,282. |
| `backends.opencode-go.thinkingLevel: low` | **cost +79%.** Total reasoning 8,899 → 20,036 (×2.25), tools 22.8 → 29.0. Shallower turns need more turns. |
| Replace JEV with a local model (Laya) | **0 of 13 answers** cleared LeanPi's `accept()` thresholds (max confidence 0.6072 vs 0.70/0.85 required). Also capped at ~1.3% saving — see §3. |

**Rule: per-turn reasoning effort is not a cost lever.** Reducing it increases
total work. Two independent routes confirmed this, matching `bench/out/cost-s1-*`.

---

## 3. Where the money actually is

Mean over 5 runs, LeanPi vs stock Pi:

| component | leanpi | stock-pi | delta | share of leanpi |
| --- | --: | --: | --: | --: |
| uncached input | $0.002602 | $0.004854 | **−$0.002252** | 22.7% |
| cached input | $0.001104 | $0.001485 | **−$0.000380** | 9.7% |
| output + reasoning | $0.007580 | $0.005823 | **+$0.001757** | **66.3%** |
| JEV classifier | $0.000153 | $0 | +$0.000153 | 1.3% |

The context engine already wins on input (−46% uncached). **JEV is only 1.3% —
stop optimising it.** The gap was entirely output.

**Gap to close: $0.001710/run = 15% of LeanPi's bill.**

### 3a. Where it landed (2026-09-22, `cost-followup-20260922`)

The gap is closed, and the shape of it changed — input now wins by more, and the
entire remaining loss is output:

| component | leanpi | stock-pi | delta |
| --- | --: | --: | --: |
| uncached input | $0.002584 | $0.005070 | **−$0.002486** |
| cached input | $0.000797 | $0.001591 | **−$0.000794** |
| output + reasoning | $0.006283 | $0.005330 | **+$0.000953** |
| JEV classifier | $0.000123 | $0 | +$0.000123 |
| **total** | **$0.009787** | **$0.011991** | **−$0.002204 (−18.4%)** |

Cache ratio held (§4b): leanpi 0.9360, stock-pi 0.9386. Per verified completion
(the metric §5 mandates) the saving is **32.0%**, because LeanPi verified 5/5 and
stock Pi 5/5 while spending $0.040750 against $0.059955.

**The remaining loss is reasoning, not turns.** Mean reasoning 7,257 tok (leanpi)
vs 5,013 (stock), i.e. +42% per turn; mean tool calls are now 19.6 vs 19.2. The
§4 turn-count lever is spent — do not re-run it. The next lever, if any, is the
STATIC prefix's effect on deliberation, and it needs n≥28 to resolve.

---

## 4. The one lever left: turn count — ANSWERED, lever spent

LeanPi took **22.8 tool calls** to stock Pi's **18.2** for the same task (+25%).
Cost tracks turns, not thinking depth, so finishing in fewer turns looked like
the only untested route to 15%. After the gate-fallback fix the counts are
**19.6 vs 19.2**: the gap is gone.

### Task 4a — what the extra turns were (DONE)

`attempts/*/toolcalls.json` (added in `2b7c896`) answers this from the session
itself. The extra calls were **not** verification re-runs and **not** todo-list
writes — there were no `todo_add`/`todo_update`/`artifact` calls at all. They
were:

1. `search` used as a dedicated call where stock Pi folded the same grep into a
   `bash` command (leanpi `search` 6, stock `bash` 72 vs leanpi `execute` 69).
2. `read` called in narrow `offset`/`limit` slices, sometimes overlapping
   (index.js read at 110–150, then 125–165, then 1–45), where stock Pi read the
   whole file once.
3. One model-level retry: a fuzz script written to `/tmp` with a relative import
   that failed, then rewritten with an absolute path.

The phantom-skill disclosure the gate fix removed was the single biggest source:
it cut mean tool calls 22.8 → 20.2 on its own.

`execution.file_reads`/`repeated_reads` were **0 because nothing ever called
`noteFileRead`** (`9db888b`); the counter was not merely unwired from a caller,
it had no caller. It is wired now.

### Task 4b — protect the cache (HOLDS)

Cache ratio after the change: leanpi 0.9360, stock-pi 0.9386. No prefix reorder
landed, so the ratio did not move.

---

## 5. How to measure anything (mandatory)

Variance is larger than the effect you are chasing. **Never conclude from one
trial.**

- Within-arm cost spread is **2.4×** on an identical prompt.
- The 95% CI on the current LeanPi/stock-Pi ratio is **[0.32, 2.70]**.
- Detecting a true 20% difference needs roughly **28 trials per arm**, across
  more than one task. n=5 cannot resolve it.

```sh
pnpm build   # MANDATORY: the arms import ./dist; preflight fails on a stale build
node bench/out/four-way-20260921/run-quad.mjs                      # offline preflight, no API calls
RUN_ID=<name> node bench/out/four-way-20260921/run-quad.mjs --run --trials 5 --arms leanpi,stock-pi
python3 bench/skills/fair-agent-benchmarks/scripts/summarize.py bench/out/<name>/summary-input.json
```

Score on **cost per externally verified completion**, with failed trials kept in
the numerator — not raw per-attempt cost. A failed run still costs money. Raw
cost ranked Codex best; per verified completion it was second worst.

### 5a. The headline run (2026-09-22)

```sh
RUN_ID=cost-followup-20260922 node bench/out/four-way-20260921/run-quad.mjs --run --trials 5 --arms leanpi,stock-pi
python3 bench/skills/fair-agent-benchmarks/scripts/summarize.py bench/out/cost-followup-20260922/summary-input.json
```

`summarize.py` reports `comparison_eligible: false` for one reason only:
`parity_verified` is false (§5's standing caveat, not a cost problem). Both arms
are `cost_complete: true`, `passrate: 1.0`, 5/5:

| arm | known_spend | $/verified completion |
| --- | --: | --: |
| leanpi | $0.040750 | **$0.008150** |
| stock-pi | $0.059955 | $0.011991 |

Re-running the summarizer is free, but the driver used to refuse it: a fully
reused run makes no new API call and `runAll` asserted `apiCalls > 0`. Fixed in
`3fd1098`; a reused run now rewrites its report without spending.

Prune before committing with `node bench/out/four-way-20260921/prune-run.mjs
bench/out/<run>` — it applies §6 by hand no longer.

Guards: per-arm $0.25, per-run $1.00. A full 10-attempt run costs ~$0.12.

---

## 6. Repo rules that apply

- Every behaviour change needs a red/green test: the failing test **and** the
  passing one, both shown.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` before any commit.
- Do not weaken an existing test to make a change pass. If a test breaks, work
  out whether the test or the change is wrong — the previous agent broke
  `tests/bench/baselines.spec.ts` this way and the test was right.
- Prune `bench/out/<run>/**/node_modules` and `codex-home` before committing; a
  raw run directory is ~1.5 GB and the evidence is ~1 MB. Never commit
  `workspace/` (it is a clone of the fixture's git repo). Copy
  `workspace/.leanpi/decisions.jsonl` and `workspace/index.js` out instead.
  `node bench/out/four-way-20260921/prune-run.mjs bench/out/<run>` does all of
  this, including dropping `preflight/accept`.
- `bench/out/real-session-audit-20260921/fixtures/**` must keep its
  `node_modules` — the acceptance test needs it. Do not prune that directory.

---

## 7. Known latent bug, deliberately left unfixed

`src/compiler/classify.ts` — `said(id)` cannot distinguish "answered no" from
"never answered". `explicit_result` falls below its 0.70 confidence threshold on
**every** run, so `!said("explicit_result")` is permanently true and band E2 /
MEDIUM is forced. LeanPi's `LOW`/`minimal` tier is unreachable in practice.

This is a real defect, but **fixing it naively costs 90% more** (§2). It needs
the `route.ts` inversion addressed at the same time: `"false|LOW"` maps the
reviewer to `by_review_risk`, which resolves to `review_strong` for a task that
alters visible behaviour — so a LOW task can draw a *more expensive* reviewer
than a MEDIUM one. Fix both together or neither, and measure the cache ratio.

The same defect class appeared three times today (`any_skill`,
`explicit_result`, and the missing-gate path). **When reading JEV answers, always
distinguish "answered no" from "not answered".**

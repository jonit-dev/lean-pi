# Four-way harness cost: LeanPi vs stock Pi vs Codex vs Claude Code

**2026-09-21 · one model held constant · `opencode-go/deepseek-v4.1-flash`**

The first comparison in this repo that runs all four harnesses on the **same
model through the same provider**, so what varies is the harness and not the
model. It replaces the 2-arm pilot in
[`bench/out/codex-comparison-20260921/`](../../bench/out/codex-comparison-20260921),
whose Codex arm never solved the task.

## TL;DR

Scored the way [`bench/skills/fair-agent-benchmarks`](../../bench/skills/fair-agent-benchmarks/SKILL.md)
requires — **cost per externally verified completion**, with failed trials kept
in the numerator — LeanPi is the cheapest of the four, but **no winner is
declared**: reasoning budget is not normalised across harnesses, so
`comparison_eligible` is `false`.

Raw per-attempt cost ranks the arms differently from cost per verified
completion, and the second is the honest metric: a failed run still costs money.
Codex looked cheapest on its first trial and is second worst once its failure is
counted.

## Arms

| arm | what it is | adapter |
| --- | --- | --- |
| `leanpi` | Pi + the LeanPi extension (jev, context-engine, skill-selection, lsp, verification) | `leanpi` |
| `stock-pi` | upstream Pi, no LeanPi extension — the auditable negative control | `stock-pi` |
| `codex` | OpenAI Codex CLI, `wire_api = "responses"` | external |
| `claude-code` | Claude Code CLI, Anthropic Messages wire | external |

All four reach `https://opencode.ai/zen/go/v1`, which serves **both** an
OpenAI-compatible and an Anthropic-compatible surface — so Claude Code needs no
translating proxy, only `ANTHROPIC_BASE_URL` plus a pre-approved key.

## Results

### Four-way, n=2 per arm (snapshot build)

`bench/out/four-way-snapshot-baseline/`

| arm | n | verified | spend | **per verified** | mean s |
| --- | --: | --: | --: | --: | --: |
| **leanpi** | 2 | **2/2** | $0.021042 | **$0.010521** | 90.4 |
| stock-pi | 2 | **2/2** | $0.028326 | $0.014163 | 107.3 |
| codex | 2 | 1/2 | $0.023243 | $0.023243 | 96.2 |
| claude-code | 2 | 1/2 | $0.045636 | $0.045636 | 150.6 |

### LeanPi vs stock Pi, n=5 per arm (current build, all fixes)

`bench/out/leanpi-vs-stockpi-20260921/` · git `81a723d`

| arm | n | verified | pass rate | spend | **per verified** |
| --- | --: | --: | --: | --: | --: |
| leanpi | 5 | 4 | 0.80 | $0.057202 | **$0.014301** |
| stock-pi | 5 | 4 | 0.80 | $0.060810 | $0.015203 |

LeanPi is **5.9% cheaper at equal accuracy** — but the 95% bootstrap CI on the
ratio is **[0.32, 2.70]**. P(LeanPi cheaper) = 0.57. **This run does not resolve
the question.**

## Why the numbers move: reasoning tokens

Cost tracks reasoning tokens, and reasoning varies several-fold between runs of
the *identical* prompt.

| arm | reasoning tokens over 5 trials | cost spread |
| --- | --- | --: |
| leanpi | 4,551 → 17,822 | 2.44× |
| stock-pi | 2,680 → 13,518 | 2.13× |

Within-arm spread (2.4×) is larger than the between-arm difference (1.06×).
Detecting a true 20% gap at this variance needs roughly **28 trials per arm**,
across more than one task. Every single-trial ranking in this repo's history
should be read with that in mind.

## Three defects this benchmark surfaced

| # | defect | file | effect |
| --- | --- | --- | --- |
| 1 | the `any_skill` gate rode inside the 169-question relevance sweep it gates | `src/capabilities/skill-select.ts` | gate answer never cleared the confidence threshold, so `find()` returned `undefined` and the code read it as "no skill required" — **skill disclosure silently dead** while paying **28,667 tokens/run** for scores it discarded |
| 2 | `below-threshold` fallback logged `emptyUsage()` after a **paid** request | `src/jev/client.ts` | JEV spend reported as 0 |
| 3 | `writeStockPiModels` dropped `headers`/`compat`, and Pi discards a model carrying a rate card on a provider outside its catalog | `src/bench/adapters.ts` | the stock-Pi control could not reach the backend and recorded empty turns as `success: true` — **an arm that fabricated successes** |

Fix 1 cuts JEV from **36,931 → 3,773 tokens/run (−89.8%)**, ~$0.0012/run, about
8% of LeanPi's bill. It is deterministic, not statistical. Without it LeanPi
would sit at ~$0.0155 — behind stock Pi.

Defect 3 invalidates any earlier LeanPi-vs-stock-Pi number taken on a build
without the rate card: the control was not calling the model.

## Cost levers tested against stock Pi

Target: LeanPi 20% cheaper per verified completion at equal accuracy. Measured
gap to close from the n=5 run: **$0.001710/run, 15% of LeanPi's bill.**

Where LeanPi's money goes, mean over 5 runs (vs stock Pi):

| component | leanpi | stock-pi | delta | share of leanpi |
| --- | --: | --: | --: | --: |
| uncached input | $0.002602 | $0.004854 | **-$0.002252** | 22.7% |
| cached input | $0.001104 | $0.001485 | **-$0.000380** | 9.7% |
| output + reasoning | $0.007580 | $0.005823 | **+$0.001757** | **66.3%** |
| JEV classifier | $0.000153 | $0 | +$0.000153 | 1.3% |

The context engine already wins decisively on input (**-46% uncached**). Every
dollar of the remaining gap is output, and output is dominated by reasoning.

| lever | result | kept? |
| --- | --- | --- |
| **JEV `any_skill` gate** (own request) | JEV 36,931 -> 3,773 tok/run, **-89.8%** | **yes** |
| **complexity marker fix** (a dropped `explicit_result` is not a "no") | correct in principle, but LOW routes through `by_review_risk` and rebuilds the prompt prefix: uncached input 17,347 -> 66,282, **cost +90%** | no, reverted |
| **`backends.*.thinkingLevel: low`** ceiling | total reasoning 8,899 -> 20,036 (**2.25x**), tools 22.8 -> 29.0, wall +58%, **cost +79%** | no, reverted |

**Per-turn reasoning effort is not a cost lever.** Capping it makes each turn
shallower, so the agent needs more turns and spends *more* reasoning overall.
Two independent routes to the same conclusion, matching `bench/out/cost-s1-*`
(blanket `thinkingLevel: off` was 27.5% worse per verified solve).

The JEV fix is real but bounded: after it, the classifier is 1.3% of the bill,
so even a free local classifier (Laya was evaluated and rejected -- 0/13 of its
answers cleared LeanPi's `accept()` thresholds) caps out at ~1.3%.

What remains untested: LeanPi issues **22.8 tool calls to stock Pi's 18.2** for
the same task. Cost tracks turns, not thinking depth, so the open lever is
finishing in fewer turns -- a capability question, not a configuration one.
Cache stability matters more than it looks: LeanPi caches 95.5% of its input,
and the one experiment that broke that prefix doubled the bill on its own.

## Next steps

Open follow-up work, levers already ruled out, and how to measure without
fooling yourself: [`2026-09-21-cost-followup.md`](./2026-09-21-cost-followup.md).

## Method

- Fixture `slugify-counter-duplicate-slug`, frozen at commit `2acf5b3`; hidden
  golden `sha256:9808617…` installed **only after** the arm finishes.
- Identical prompt bytes for every arm (`prompt_sha256:326ede7…`).
- Offline preflight asserts the base fails the intended assertion at
  `test.js:270` and a known-good source passes 25/25, before any paid trial.
- 300s process-group ceiling; per-arm $0.25 and per-run $1.00 spend guards.
- Pi's usage is the **disjoint** dialect (`cached_input_tokens` sits outside
  `input_tokens`); the LeanPi record's `output_tokens` **excludes** reasoning
  while the stock Pi record's **includes** it. Each arm is priced by its own
  accounting — see `run-quad.mjs` self-tests.
- Claude Code's self-reported `total_cost_usd` is **wrong for a custom model**
  ($0.8125 against a true $0.0149 — it prices at Sonnet rates). Costs here are
  recomputed from token counts.

## Reproduce

```sh
pnpm build                                            # arms import ./dist; preflight fails on a stale build
node bench/out/four-way-20260921/run-quad.mjs         # offline preflight, no API calls
RUN_ID=my-run node bench/out/four-way-20260921/run-quad.mjs --run --trials 5 --arms leanpi,stock-pi
python3 bench/skills/fair-agent-benchmarks/scripts/summarize.py bench/out/my-run/summary-input.json
```

## Limits

- One task. One fixture. Not a suite.
- `parity_verified: false` — Codex ran `reasoning.effort=medium`, Claude Code
  `MAX_THINKING_TOKENS=8000`, the Pi arms their own defaults. Normalising them
  would disable LeanPi's adaptive effort selection, which is a feature under
  test, so it was deliberately not done.
- Usage-value estimates against a published rate card, not invoices.

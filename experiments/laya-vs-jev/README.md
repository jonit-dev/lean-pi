# Can Laya replace JEV in LeanPi?

**Verdict: wire-compatible, not accuracy-compatible.** Laya is a true drop-in at
the transport layer — LeanPi's unmodified JEV client, decision-site registry and
`accept()` gate run against it with a one-line endpoint change, and all three
primitives (`Choice` / `Score` / `Noul`) round-trip. But on LeanPi's own decision
sites Laya does **not** hold JEV's accuracy: 0.612 vs 0.845 `Choice` accuracy,
2.3× the `Score` error, 3× the calibration error, and — because Laya reports a
different confidence quantity than JEV — it falls back to the deterministic path
on 96–100 % of decisions under LeanPi's existing thresholds.

That last point is the practical blocker, and it is fixable. The accuracy gap is
the one that is not fixable by configuration.

## What was measured

76 hand-labelled cases (148 questions, 134 labelled) drawn from eight real
LeanPi decision sites, with the question text, option rubrics and option
cardinality copied from `src/` so both providers answer exactly what LeanPi
sends in production:

| Site | Primitive | Options | Cases |
|---|---|---|---|
| `executor.failure_classification` | Choice | 5 | 12 |
| `explore.snippet_relevance` | Choice | 2 | 12 |
| `routing.reasoning_effort` | Choice | 4 | 8 |
| `explore.sufficiency` | Choice | 2 | 8 |
| `routing.delegation_worth` | Choice | 2 | 6 |
| `explore.subsystem_order` | Noul + Choice | 2 / 3–4 | 6 |
| `classify.execution_complexity` | 5×Choice + Score | 2 | 6 |
| `gate.prd_required` | 6×Choice + Score | 2 | 6 |
| `explore.candidate_relevance` | Score | 4 | 12 |

Arms: live TypeSafe JEV (`jev-1.13.0`) and all three Laya checkpoints
(`laya` English root, `typed-decisions`, `multilingual`). Hardware: one RTX 2080
8 GB, torch 2.6.0+cu124, transformers 5.17.0, `laya` 0.3.5.

Labels are hand-written from the case content. Three sites are objectively
determinable (`failure_classification`, `snippet_relevance`, `sufficiency`); the
rest are expert judgement and should be read as indicative, not authoritative.
The raw disagreements are in `out/report.txt` (`--diff`) so any label can be
argued with.

## Results

```
                                  jev      laya-english  laya-typed-decisions  laya-multilingual
Choice accuracy               98/116 = 0.845   71/116 = 0.612    71/116 = 0.612    57/116 = 0.491
Noul accuracy                   5/6 = 0.833      3/6 = 0.500       5/6 = 0.833       4/6 = 0.667
Score MAE (0..3)                  0.396            0.894             0.946             1.076
Score level accuracy           8/12 = 0.667     4/12 = 0.333      2/12 = 0.167      2/12 = 0.167
ECE (categorical)                 0.101            0.324             0.500             0.197
accepted by accept()         85/122 = 0.70      5/122 = 0.04      0/122 = 0.00     27/122 = 0.22
accuracy when accepted       77/85  = 0.906      4/5  = 0.800      0/0  = 0.000     15/27 = 0.556
p50 latency (ms)                    109               31                32                25
p95 latency (ms)                    210               50                42                31
input tokens                      33068            10765             10765             10688
```

Per-site `Choice`/`Noul` accuracy (hits/asked):

| Site | JEV | laya | laya-td | laya-ml |
|---|---|---|---|---|
| `executor.failure_classification` | 11/12 | 8/12 | 9/12 | 3/12 |
| `explore.snippet_relevance` | 12/12 | 7/12 | 6/12 | 6/12 |
| `explore.sufficiency` | 8/8 | 4/8 | 4/8 | 4/8 |
| `routing.reasoning_effort` | 7/8 | 2/8 | 4/8 | 4/8 |
| `explore.subsystem_order` | 9/10 | 7/10 | 9/10 | 6/10 |
| `classify.execution_complexity` | 24/30 | 17/30 | 18/30 | 15/30 |
| `gate.prd_required` | 29/36 | 26/36 | 23/36 | 20/36 |
| `routing.delegation_worth` | 3/6 | 3/6 | 3/6 | 3/6 |

## Findings

1. **Drop-in works.** `drop_in.mjs` runs the built `dist/index.js` with the real
   `createJevClient`, the real HTTP transport, the real site registration
   (`classifyFailure` → `executor.failure_classification`) and the real
   `accept()` gate, pointed at `shim.py` (a JEV-contract server over Laya).
   Nothing in `src/` is touched. `/jev test` returns a typed `Noul`; classified
   failures come back typed; decision-log rows are written. Replacing JEV with
   Laya is a configuration change, not a code change.

2. **JEV wins on accuracy, and the margin is not noise.** +0.233 `Choice`
   accuracy overall, and JEV is ahead or level on 7 of 8 sites. On the three
   objectively-labelled sites the gap is starkest: `snippet_relevance` 12/12 vs
   7/12, `sufficiency` 8/8 vs 4/8, `failure_classification` 11/12 vs 8/12.

3. **Laya's `Score` output is nearly constant, which breaks the ranking sites.**
   LeanPi uses `Score` for candidate relevance, test relevance and retry
   usefulness — all of them *rank and threshold*. JEV returns 0.45 for an
   irrelevant file and 2.99 for the file to change; Laya returns 1.9–2.6 for
   both. A ranking site that cannot separate the ends of its range is no better
   than its deterministic fallback. Laya's own card flags `score` as its weakest
   primitive ("SST-5 0.372"); on LeanPi's sites it is the disqualifying one.

4. **The confidence semantics differ, so LeanPi's thresholds cannot be reused.**
   JEV's `confidence` is (effectively) the top-option probability; Laya's is
   normalised Shannon entropy, `1 − H(p)/log k`
   (`laya/common.py:confidence_from_probs`). For a 5-option question an
   overwhelmingly likely answer still scores ≈0.7 under entropy confidence, so
   it lands below the `high` (0.85) and at the `normal` (0.7) threshold. Median
   reported confidence: JEV 0.96, Laya 0.22, Laya-td 0.10. Consequence:
   `accept()` rejects Laya's answers, and the site silently takes its
   deterministic fallback — Laya becomes a no-op. With the `typed-decisions`
   checkpoint **0 of 122** answers cleared the gate.

5. **An adapter fixes the gate, not the accuracy.** Substituting `max(probabilities)`
   for the entropy confidence lifts acceptance to 0.53 / 0.24 / 0.71, but
   accuracy among accepted answers stays at 0.689 / 0.607 / 0.537 against JEV's
   0.861. The gate is a one-line adapter; the accuracy is not.

6. **Laya is 3.5–4.4× faster and free.** p50 25–32 ms vs JEV's 109 ms; p95 31–50
   ms vs 210 ms. JEV cost $0.00139 for the 76-case run (~$0.018 per 1000
   decisions); Laya is $0 self-hosted. Speed and cost are real advantages, but
   they buy a worse decision, and LeanPi's whole thesis is that a *correct*
   cheap decision replaces an expensive generator turn.

7. **One LeanPi site is unanswerable by any model as worded.**
   `routing.delegation_worth` asks whether splitting into N slices "saves more
   than the extra dispatch and context cost" but never states the threshold the
   deterministic fallback compares against. Every provider answered a constant
   (JEV always `inline`, `typed-decisions` always `delegate`), scoring 3/6 by
   construction. That is a question-design bug in `src/routing/sites.ts`, not a
   model difference — worth fixing regardless of provider.

8. **Laya's published "beats JEV" claim does not transfer.** The card's
   head-to-head is on the `typed-decisions` benchmark's own four workflows
   (invoice processing, security incidents, customer service, agent-trace
   observability) using the checkpoint fine-tuned on that benchmark's training
   split. The card says so itself: the base checkpoints are "near chance on
   typed-decisions zero-shot… a fast base to specialise, not a zero-shot
   decision engine." LeanPi's coding-agent sites are out of that distribution,
   and the fine-tuned checkpoint did not beat the base here either (identical
   0.612 `Choice`, worse `Score`).

## Reproduce

```bash
cd experiments/laya-vs-jev
./run.sh                 # GPU, both providers (needs JEV_API_KEY)
./run.sh --device cpu    # no GPU
./run.sh --no-jev        # Laya arms only
```

First run downloads ~2.5 GB of CUDA wheels and ~2.2 GB of checkpoints. Outputs
land in `out/` (`laya-*.jsonl`, `jev.jsonl`, `report.txt`); the drop-in proof
runs last and prints `DROP-IN OK`.

## What would change the verdict

- **Fine-tune on LeanPi's own decisions.** LeanPi already writes one row per
  resolved site to `.leanpi/decisions.jsonl` with the site, the answer, the
  confidence and whether the deterministic fallback was used — that is a
  fine-tuning corpus for exactly these sites. Laya is explicitly built to be
  specialised (its fine-tuning notebook is part of the release). A Laya
  fine-tuned on LeanPi decisions is the one arm that could plausibly match JEV
  at zero marginal cost, and it is not measurable until the log has enough rows.
- **A confidence adapter** (`max(probabilities)`, or a per-(primitive, option
  count) temperature refit) is a prerequisite for *any* Laya arm, otherwise the
  sites fall back and the comparison is vacuous.
- **Re-label by outcome.** These labels are expert judgement. Scoring against
  whether the decision actually improved the task outcome (LeanPi's PRD-021 §56
  per-site accuracy) would be a stronger, provider-neutral test.

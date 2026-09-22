---
name: fair-agent-benchmarks
description: Empirically compare the coding-agent harnesses the user specifies on identical tasks and report cost per externally verified completion, such as Codex versus LeanPI using the same model. Not for generic performance profiling or non-agent benchmarks.
---

# Fair Agent Benchmarks

Primary metric: end-to-end cost per **externally verified completed task**, not tokens, turns, or claimed success.

**Preserve the requested comparison.** Record the exact harnesses, provider and model before choosing a runner. If the user requests Codex versus LeanPI, those are the arms. Do not replace Codex with stock Pi, OpenCode or another baseline for methodological convenience. If a requested combination is unsupported, report the specific compatibility blocker and ask before substituting a harness or model.

## Workflow (max 5 steps)

1. **Reuse first.** Find the project's existing runner/harness before building anything; use disposable adapters only if none fits. Do not build a framework. Keep artifacts project-local and bounded; never change source/config/security just for a benchmark; never create global worktree directories.
2. **Freeze and match** every arm: same fixture SHA, task prompt, acceptance tests, resource policy, provider, model, thinking level and inference budgets. Verify the *actually applied* settings, not labels. Use a stable unique session/cache key per run and preserve cache within a run. Freeze config and code while others edit.
3. **Select tasks before seeing results**: representative of the user's real work (edits, multi-file changes, test fixes), with separate easy and complex strata. A small pilot proves nothing general. Run the user's specified harnesses with the same provider/model when requested. An additional component-isolation comparison is optional and requires the user's agreement; it never replaces the requested comparison.
4. **Preflight, then run paired trials**: before any paid scale, confirm the acceptance runner actually collects and executes its tests — a crash inside the runner or a missing test file is infrastructure, not a task failure. For bug tasks, confirm the baseline fails the *intended* task assertion, not an infrastructure error, and when available confirm a known-good revision/reference fix passes. If the runner is broken, stop paid trials, preserve the overhead as invalid spend, and repair/calibrate offline before resuming. Also verify budget/timeout can actually abort *all* adapters and retain partial usage. Then run the same `(task, trial)` on every arm, alternating order, repeated pairs; start with one pair and expand only within stated/agreed time and cost limits.
5. **Report once** (below), reusing the report the user asked for; no separate evidence ledger or planning document.

## Counting unit and cost scope

Validate the acceptance contract before spending: hidden assertions must follow from the task specification or established repository behavior, not merely require the upstream patch's preferred output. If a mismatch appears after a run, preserve the original score, mark its interpretation limited, and label extra diagnostics post-hoc. Clarify and freeze the contract before new paired trials; do not silently weaken tests or rerun only the losing arm.

A prompt turn, session, or assistant call is **not** a completed task. Exclude probes from real-work labels. Failed and timed-out trials stay in the cost numerator; pass/fail comes from external tests/acceptance, never an agent claim or an unwired success boolean. For bug tasks, confirm the baseline fails a real assertion before agent repair.

Cost is end-to-end per task: model uncached + cached + cache-write + all output, classifier/JEV, retries, rework, compaction/summaries, review and delegated agents. Record explicit rates, source and date; stored usage is an estimate, not an invoice; subscription usage is not free merely because no per-request invoice exists.

Distinguish token-priced usage/quota value from cash paid. For subscriptions, report billing-period fee allocation plus overages and auxiliary services per verified completion separately; lower quota use does not necessarily lower the fixed bill. Check time-dependent rates against request timestamps, and preserve historical recorded estimates when invoice reconciliation is unavailable.

Avoid double counting by mapping each adapter/path/provider's usage semantics at least once — do not assume one output semantic for all rows from the harness name. In the live pilot the LeanPI main record's output excludes reasoning, while the stock Pi/fallback adapter's record includes reasoning with the `reasoning` field still present; so check output-component semantics against the recorded usage components. `cost.total` may be null: sum components once and check the formula; never add total + components. JEV is a repo-contract input only and native collectors omit it, so join the project-local decision log, not just the root. Native Pi and LeanPI use separate session IDs: correlate by project/task/usage; do not infer unrelated work from IDs or assume every Pi file is LeanPI. Budget and model rates change; verify when needed rather than re-fetching recorded historical rates.

## Limits and safety

Stop on provider credit errors; do not substitute a different model to continue. Do not bypass caps or kill the user's unrelated processes. Initial authorization to run the benchmark permits bounded calls; do not invent extra approval gates.

## Report

One Markdown report containing:

- Task matrix: pass/fail, cost and time per arm.
- Per arm: total spend / verified completions = cost per verified completion; status counts; pass rate over valid task trials only (invalid infrastructure trials excluded, null if none remain); cost coverage. If no task passes, the metric is undefined.
- Paired task results with spread/repeats and sensible uncertainty.

Do not declare a winner without verified parity, complete cost and adequate quality. Report an incomplete component as unknown or a lower bound, never 0; keep failed and infrastructure-invalid records separate with no quiet exclusion or post-hoc selection. Tokens/bytes/latency are secondary diagnostics. Never present cross-workload totals or cross-model repricing as harness savings.

## Deterministic summary helper

Use `scripts/summarize.py` after running trials; it enforces the counting rules above (all costs summed including failures, null cost = lower bound; duplicates/nonfinite values/blank identifiers and a blank parity note with `parity_verified` true are rejected outright, while mismatched pairs are not rejected but set `comparison_eligible` false). `parity_evidence` is a human note the caller writes after checking real artifacts — the helper cannot verify settings from it.

Input (retries already aggregated into the trial):

```json
{"parity_verified": true, "parity_evidence": "same provider, model, thinking, fixtures",
 "attempts": [
   {"task": "fix-parser", "arm": "leanpi", "trial": 1, "status": "passed",
    "cost_usd": {"model": 0.42, "classifier": 0.01, "delegated": 0, "other": null},
    "seconds": 63.2}
 ]}
```

`status` is one of passed/failed/timeout/error/invalid. Run:

```bash
python3 scripts/summarize.py results.json
python3 scripts/summarize.py --self-test
```

Invocation example: `$fair-agent-benchmarks compare Codex CLI and LeanPI on DeepSeek v4.1 Flash; score cost per verified task`

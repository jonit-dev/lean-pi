# LeanPi versus stock Pi: next steps

**Decision:** Stop paid cost experiments until a specific cause of LeanPi's extra model calls is demonstrated from saved attempts. The goal remains at least 20% lower cost per externally verified completion, with both arms on the same DeepSeek v4.1 Flash model and billed JEV on LeanPi.

## What we know

- Both arms use Pi's agent loop. The stock arm loads no LeanPi extension; the LeanPi arm adds its prefix, tools, routing, JEV, context features, and verification. The extra calls show different agent behavior, not a proven defect in Pi's loop or the benchmark harness.
- In two uncapped, externally verified task pairs, LeanPi spent `$0.034737` versus stock Pi's `$0.023050` and made 84 versus 49 model calls. JEV was 4.2% of LeanPi's spend. The extra model turns and their tokens are the main observed cost gap. This subset is too small for a reliability claim.
- A four-task pair passed 4/4 tasks in both arms, but four attempts hit the time ceiling, leaving the true cost ratio unknown. Tool-name changes, prompt trims, source-file selection, and other screened candidates have not produced a repeatable 20% saving. Five older paired slugify traces show no single read, search, execute, or edit family with at least five extra LeanPi calls in three pairs.

## Do this next

1. **Locate the first divergence.** Use the saved paired attempts and full tool-call artifacts. Align each LeanPi and stock Pi trajectory by task phase: locate target, inspect source/tests, edit, test, repair, finish. Mark the first extra LeanPi model turn and its immediate trigger. Check at least three pairs; report call numbers and artifact paths. Do not infer intent from redacted trace labels alone.
2. **Name one repeated cause.** Advance only if the same cause accounts for at least 70% of excess LeanPi calls in multiple pairs, or if a measured token component alone is large enough to support the 20% target. If saved outputs cannot establish this, add the smallest privacy-safe trace field needed and run one bounded diagnostic pair. Do not modify agent behavior yet.
3. **Fix that cause once.** Make one reversible change at the responsible extension boundary, preserving the same model, JEV, tool safety, and external verifier. First run focused correctness checks, then one predeclared paired screen with a spend cap. Reject it if either arm fails external verification, costs are censored, or LeanPi does not reach the 0.80 cost-ratio gate.
4. **Prove reliability only after the screen passes.** Run the fixed four-task paired sample in PRD-044, count failed and timed-out spend in cost per verified completion, require complete billed usage, and compute the task-stratified paired confidence interval. Claim the goal only if its upper bound is at most `0.80`.

**Status after executing step 1 (2026-09-23).** Nine saved paired traces were
phase-aligned by first edit. The first divergence is located in each pair, but
the step-2 gate is **not met**: no single cause accounts for ≥70% of excess
LeanPi calls in multiple pairs (largest labeled share: flask's `search` calls,
12/16; largest unlabeled share: a pre-edit run of `shell_kind: other` turns).
Steps 3–4 are blocked on that name, so no behavior changed and no paid trial
ran. Full call numbers and artifact paths:
[`2026-09-23-cost-first-divergence.md`](2026-09-23-cost-first-divergence.md).

**Current status:** Goal not met. No paid benchmark is running. The detailed experiment history and commands remain in `.worktrees/benchmark-stock-pi/docs/PRDs/v1/PRD-044-reliable-stock-pi-cost-benchmark.md`; bring that PRD into the main checkout before executing its final sample.

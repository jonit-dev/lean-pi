# PRD-010 — Proof Gate

**Status:** DONE (verified 2026-09-19)
**Complexity:** 3 (MEDIUM)
**Owner:** joao
**Depends on:** PRD-002, PRD-009, PRD-011

**Risk override:** MEDIUM instead of the scored LOW. This gate is the single place where LeanPi converts evidence into the claim "done". A false pass here silently invalidates every completion statement the product makes, so the mode is promoted to get a reviewer at both checkpoints and explicit rejection controls.

## Context
**Covers:** FR-016, FR-017, FR-124, FR-125, FR-126, FR-127; ROADMAP §36, §37, §38, §39, §40, §41, §51 (Core Orchestration, Verification).

ROADMAP §36 names the proof-sufficiency layer a core LeanPi requirement: after implementation and deterministic checks, JEV evaluates whether the available evidence actually supports each requested feature or acceptance criterion. §39 draws the line that makes this safe — *JEV answers whether the evidence supports the claim; it does not establish the underlying fact* — and therefore LeanPi application logic, not JEV, makes the final decision.

The repository is greenfield; the only file under `docs/PRDs/v1/` is `ROADMAP.md`. There is no `src/`, no test runner, no gate of any kind. PRD-009 builds the deterministic layer: an `EvidenceStore` with a measured-results channel, a separate model-assertion channel, workspace-hash freshness, per-criterion attribution (`criterion`, `scope`) on every record, and an `aggregate()` status that the gate cannot raise. PRD-002 builds the JEV client (`ask(siteId, questions, state)` returning typed `Choice`/`Score`/`Noul` results) and the decision-site registry. PRD-011 builds the reviewer lane: its `QUICK_REVIEW`/`STRONG_REVIEW` levels are the two rungs of the §41 ladder and its verdict is the `review.status` the §39 PASS rule requires, so it is a completion-blocking dependency here, not a nicety. This PRD is the consumer of all three.

The failure mode that matters is not a gate that blocks too much — it is a gate that never rejects. A gate which answers PASS for a claim with no supporting evidence is worse than no gate, because it launders an unverified claim into a verified-looking one. Everything below is shaped by that: per-criterion isolation (FR-124) so one well-proved criterion cannot carry an unproved sibling, contradiction as a hard fail (FR-125), structured actions instead of prose (FR-017/126), a bounded loop (FR-127), and a false-completion fixture as a standing acceptance criterion.

## Solution
One module, `src/proof/`, entered once per task from the executor's completion path:

```
runTurn() [src/commands/session.ts, PRD-001]
  → runExecutor(contract, deps)           src/executor/lane.ts  (PRD-007)
        → verifyTask()                    src/verify/index.ts   (PRD-009)
        → ExecutorOutcome { status, changedFiles, evidence, ... }
  → evaluateProofGate(criteria, outcome)  src/proof/gate.ts     (this PRD)
        for each criterion:
          buildPacket(criterion, store)   src/proof/packet.ts   §37  (store.forCriterion)
          ask(siteId, questions, packet)  src/jev/client.ts     §38  (PRD-002)
          decideCriterion(...)            src/proof/decide.ts   §39
        recover(gaps)                     src/proof/recover.ts  §40/§41
          → review(packet, level, mode)   src/review/lane.ts    §41  (PRD-011)
  → turn.proof { decision, criteria[], attempts, actions[] }
```

**Packet (§37).** `buildPacket(criterion, store)` emits the compact YAML-shaped object from §37 — `criterion`, `changes` (path + one-line description), `evidence` (per verifier kind: `status` + `scope`), `review.status`, `known_gaps` — populated *only* from the records PRD-009 attributed to **this** criterion (`store.forCriterion(id)`, keyed on `EvidenceRecord.criterion`) plus review state. A record covering a sibling criterion is not in this packet and therefore cannot evidence this one; that filter is the FR-124 mechanism, and it is why `criterion`/`scope` are fields on the record rather than a convention. Model assertions are excluded from `evidence` by construction; if the executor's claim is relevant it appears under a separate `claims` key that the questions treat as hearsay. Absent checks appear as `not_run`; stale records appear under `known_gaps` as `stale: <kind>`; and `unavailable` records — the verifier's facility was missing, so no measurement exists — appear under `known_gaps` as `unavailable: <kind> (<reason>)` and never under `evidence`, so "no browser was available" reads as a gap instead of passing silently.

**Atomic questions (§38).** Four `Choice` questions, asked as a set, never as one prose request:

1. Does the evidence directly demonstrate this criterion? → `YES | PARTIAL | NO`
2. Is any evidence contradictory? → `YES | NO`
3. Is the evidence primarily static where runtime behavior is required? → `YES | NO`
4. Is there an important execution path with no evidence? → `YES | NO`

then the evidence-gap `Choice` enum verbatim from §38: `NONE`, `TARGETED_TEST_REQUIRED`, `BUILD_REQUIRED`, `TYPECHECK_REQUIRED`, `RUNTIME_TEST_REQUIRED`, `UI_VERIFICATION_REQUIRED`, `REGRESSION_TEST_REQUIRED`, `DIFF_INSPECTION_REQUIRED`, `REVIEW_REQUIRED`, `USER_CONFIRMATION_REQUIRED`, `MORE_CONTEXT_REQUIRED`. JEV writes no prose about what to do; `src/proof/actions.ts` holds the one table that maps each member to a concrete action — PRD-009 verifier kinds for the first six, PRD-022's runtime/browser capability for `UI_VERIFICATION_REQUIRED`, PRD-011's reviewer lane for `REVIEW_REQUIRED`, an owner-lane prompt for `USER_CONFIRMATION_REQUIRED`, and PRD-014's context retrieval for `MORE_CONTEXT_REQUIRED`. Unmapped-in-MVP members resolve to `unavailable` with the reason recorded as a known gap; they are never silently treated as `NONE`.

**Decision (§39), by code.** `decideCriterion` is pure, and every input it reads is scoped to the one criterion — the deterministic aggregate is `aggregate(store.forCriterion(id))`, never the task-wide status:

```
PASS            if this criterion's deterministic aggregate is pass
                AND no record for this criterion is stale
                AND Q2 = NO
                AND Q1 = YES
                AND required review has passed
FAILED          if this criterion's aggregate is deterministic_failure  (PRD-009, non-raisable)
                OR Q2 = YES                                             (FR-125)
                OR deterministic contradiction detection fires          (FR-125)
MISSING_PROOF   if Q1 ∈ {PARTIAL, NO} OR Q3 = YES OR Q4 = YES
                OR this criterion's aggregate is incomplete
                   (a mandatory check is not_run or unavailable)
BLOCKED         if the selected gap action is unavailable, or the loop limit is reached
```

`evaluateProofGate` folds the per-criterion results with a strict rule: the task decision is the worst outcome across criteria, and every criterion keeps its own result and reasons in the output. No task-wide aggregate feeds a per-criterion decision and there is no "overall" JEV question, so neither one optimistic answer nor one passing typecheck can carry the set. A JEV answer alone can never produce PASS — PASS additionally requires this criterion's own deterministic aggregate, which JEV does not influence.

**Recovery and bound (§40, §41).** `recover` runs the cheapest action for the highest-severity gap, updates the evidence store (PRD-009 writes the new record), and re-enters the gate. The bound is `contract.limits.semantic_review_rounds` (§8, always set by PRD-004) — one ceiling, owned by the compiler's per-task routing decision. A task routed `semantic_review_rounds: 0` therefore performs zero gathering rounds and goes straight to the §41 ladder, instead of silently buying two rounds the §29 quick path was routed to avoid. `LeanPiConfig.proof.maxAttempts` (default 2) survives only as the compiler-side default for a contract that omits the field; `recover` never reads it, so there is exactly one authoritative ceiling at runtime. On exhaustion the §41 ladder runs once per rung — `review(packet, 'QUICK_REVIEW', mode)` then `review(packet, 'STRONG_REVIEW', mode)` through PRD-011's `src/review/lane.ts` — and then returns `BLOCKED` to the user with the specific unproved criterion and gap category. LeanPi never synthesizes an evidence record to satisfy the gate: the only writer of `records` is PRD-009's verifier runner, and `src/proof/` imports no binding that can write to that channel.

Relevant ROADMAP §58 non-goals restated: no correctness claims without evidence — this gate exists to enforce that; no unbounded autonomy — the loop is bounded and terminates at a user-visible `BLOCKED`; no JEV requirement for basic operation — with JEV off, the deterministic fallback below still gates; no generative model replacing JEV's typed answers with prose.

Risks: (a) an over-eager gate stalling ordinary tasks — mitigated by the contract's `limits.semantic_review_rounds` bound (0 on the §29 quick path) and by `NONE` short-circuiting with zero extra runs; (b) a criterion with no mapped evidence kind — returns `BLOCKED` with the category, never `PASS`.

## External Skill Dependencies
None. The gate reads PRD-009 evidence and calls the PRD-002 JEV client; it consumes no installed global skill or plugin. Per-PRD criterion evaluation against the installed `prd-creator`/`prd-manager` skills is PRD-012's site, not this one.

## JEV Decision Sites
Two sites, both registered in PRD-002's decision-site registry.

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| Proof sufficiency (`proof.sufficiency`) | The four §38 questions: direct demonstration; contradiction; static-where-runtime-required; unevidenced execution path | `Choice` per question (`YES/PARTIAL/NO`, `YES/NO`) | Coverage rule over the packet alone: PASS only if this criterion's deterministic aggregate is `pass`, no record attributed to it is stale, and every evidence kind the criterion's contract marks required has a fresh `pass` record attributed to it; an `unavailable` or `not_run` mandatory record yields `MISSING_PROOF`. Strictly more conservative than the JEV path — it can never pass something JEV would reject for absent evidence. | ★★★★★ |
| Missing-proof classification (`proof.missing_proof_category`) | Which single evidence category would most directly close this gap? | `Choice` over the §38 evidence-gap enum | First unsatisfied required kind from the same coverage rule, mapped through the identical `actions.ts` table (e.g. missing required runtime kind → `RUNTIME_TEST_REQUIRED`). | ★★★★★ |

Both sites declare `fallbackUsed` on their telemetry row (PRD-015) and appear in `/route` output (PRD-016). Each registry row carries `consequence: high`; the numeric confidence floor that consequence maps to lives in `src/jev/confidence.ts` (PRD-002), not on the row. An answer below that floor routes to the fallback rather than to a guess.

## Acceptance Criteria
- [x] AC-1 [local; actor: agent]: A task with two acceptance criteria — one covered by a fresh passing targeted test, one with no relevant evidence — yields `turn.proof.criteria` with the first `PASS` and the second `MISSING_PROOF`, and the task decision `MISSING_PROOF`; the first criterion's result is unchanged by the second's outcome, and the packet built for each criterion contains only the records attributed to it — Evidence: tests/proof/gate.test.ts — a two-criterion split yields `[AC-1 PASS, AC-2 MISSING_PROOF]` with each packet holding only its own records, and AC-1 judged alone is byte-identical to its result in the pair.
- [x] AC-2 [local; actor: agent]: A false-completion fixture (executor asserts "feature implemented and working", evidence channel empty apart from `git_status`) is rejected: the decision is `MISSING_PROOF` or `BLOCKED`, never `PASS`, and the returned action names a concrete verification category rather than prose — Evidence: tests/proof/gate.test.ts — the standing false-completion fixture is rejected (never PASS) with a structured category and target, and its evidence channel is asserted to be exactly `[git_status]` so the control is not vacuous.
- [x] AC-3 [local; actor: agent]: A packet whose evidence contradicts itself — an **advisory** `full_suite` `fail` next to a **mandatory** `targeted_test` `pass` over the same `scope`, so the deterministic aggregate is `pass` and no §39 aggregate clause fires — yields `FAILED` with the contradicting record pair identified, even when JEV is scripted to answer Q1 = `YES` and Q2 = `NO`; the identical fixture with the conflicting record removed yields `PASS`, so the decision is caused by contradiction detection rather than by a failing check — Evidence: tests/proof/gate.test.ts — an advisory full-suite failure beside a passing mandatory targeted test over the same scope yields FAILED with the record pair identified, while the same packet minus the conflicting record yields PASS.
- [x] AC-4 [local; actor: agent]: A JEV gap answer of `RUNTIME_TEST_REQUIRED` causes the mapped `runtime_smoke` verifier to actually run (new `EvidenceRecord` in PRD-009's store, attributed to this criterion) and the gate to be re-entered with the updated packet, ending in `PASS`; an answer of `NONE` on the same input runs no additional verifier — Evidence: tests/proof/recover.test.ts — a `RUNTIME_TEST_REQUIRED` gap runs the mapped runtime verifier (a real shell verifier), a new record appears in PRD-009's store, and re-entering the gate ends PASS; a NONE answer runs zero verifiers and spends zero rounds.
- [x] AC-5 [local; actor: agent]: With evidence that stays insufficient, the gate performs exactly `contract.limits.semantic_review_rounds` gathering rounds, then escalates `QUICK_REVIEW` → `STRONG_REVIEW` through PRD-011's `review()` → returns `BLOCKED` naming the unproved criterion and gap category; the same fixture with `semantic_review_rounds: 0` performs zero gathering rounds and enters the ladder immediately; the round count and both ladder rungs are observable in `turn.proof.attempts`, and the evidence store's `records` channel gains no entry across either ladder — Evidence: tests/proof/recover.test.ts — `semantic_review_rounds: 2` performs exactly two rounds then walks QUICK_REVIEW → STRONG_REVIEW → BLOCKED naming criterion and category, and `0` enters the ladder immediately even with `maxAttempts: 5` present.
- [x] AC-6 [local; actor: agent]: With JEV disabled in config, the same false-completion fixture from AC-2 is still rejected via the deterministic coverage rule with `fallbackUsed: true` on both sites; and a scripted JEV answer of Q1 = `NO` on an otherwise fully-evidenced criterion changes the decision from `PASS` to `MISSING_PROOF`, proving the JEV answer is consumed rather than ignored — Evidence: tests/proof/gate.test.ts — with JEV disabled the false completion is still rejected through the coverage rule with `fallback_used: true` on both rows, and a scripted NO flips PASS → MISSING_PROOF with aggregate and coverage identical.
- [x] AC-7 [local; actor: agent]: A criterion whose only runtime evidence is an `unavailable` record (PRD-022's browser facility absent) never reaches `PASS`: the record appears under the packet's `known_gaps` and never under `evidence`, this criterion's aggregate is `incomplete`, and the decision is `MISSING_PROOF` or `BLOCKED` naming the missing capability — asserted with JEV scripted to answer every question affirmatively — Evidence: tests/proof/gate.test.ts — an unavailable runtime record never appears under `evidence`, appears under `known_gaps` with its reason read from the artifact, and the criterion is BLOCKED naming the gap category with no round spent.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Final completion decision for a task | `runTurn()` in `src/commands/session.ts` (PRD-001 owns the file) calls `evaluateProofGate()` from `src/proof/gate.ts` (created in Phase 1) on the `ExecutorOutcome` returned by `runExecutor()` (`src/executor/lane.ts`, PRD-007), and returns `turn.proof` | New capability; replaces the implicit "executor said done" completion that has no implementation in this greenfield repo | AC-1 / AC-2 / AC-7 |
| Structured missing-proof action execution | `recover()` in `src/proof/recover.ts` (created in Phase 2) dispatches through the `actions.ts` table into PRD-009's verifier runner and PRD-011's reviewer lane | New capability; the enum table is the only mapping, so no prose-parsing path exists to retire | AC-4 |
| Proof-gate decision sites | `evaluateProofGate()` resolves `proof.sufficiency` and `proof.missing_proof_category` through PRD-002's registry; fired/fallback rows reach `/route` (PRD-016) and telemetry (PRD-015) | New capability; the coverage rule is the declared fallback, not a second gate | AC-6 |
| Goal-loop completion input | `evaluateGoal()` (PRD-013) consumes `turn.proof.decision` rather than re-judging evidence | New capability; defines the contract PRD-013 depends on | AC-1 |

## Execution Phases

#### Phase 1: Per-criterion packet, atomic questions, and a decision made by code
**Status:** DONE
**ACs:** AC-1, AC-2, AC-3, AC-6, AC-7
**Files:** `src/proof/packet.ts` (`buildPacket`), `src/proof/questions.ts` (the four §38 questions + gap enum), `src/proof/decide.ts` (`decideCriterion`, `foldTaskDecision`, `coverageFallback`, `detectContradiction`), `src/proof/gate.ts` (`evaluateProofGate`), `tests/proof/gate.test.ts`, `tests/proof/fixtures/false-completion.ts`
**Implementation:** `buildPacket(criterion, store)` reads only the records PRD-009 attributed to that criterion (`store.forCriterion(id)`) out of the fresh deterministic view, plus review state; assertions land under `claims`, and stale and `unavailable` records land under `known_gaps` with their kind and reason. Register both decision sites in PRD-002's registry with question sets, `Choice` return types, `consequence: high`, and `coverageFallback` as the declared fallback (the numeric floor lives in `src/jev/confidence.ts`, not on the row); JEV off or below the floor calls the fallback and marks `fallbackUsed`. `decideCriterion` implements the §39 table as a pure function whose inputs are this criterion's own deterministic aggregate, its staleness flags, the four answers and review status — with no parameter by which a JEV answer can produce `PASS` without the aggregate, and with `incomplete` (mandatory `not_run` or `unavailable`) forced to `MISSING_PROOF`. `detectContradiction` is deterministic pre-work over records sharing a `scope` with conflicting statuses, OR-ed with Q2, so a contradiction fails the gate even when JEV misses it and even when no mandatory record failed. `foldTaskDecision` takes the worst per-criterion outcome and preserves every criterion's own result and reasons; it computes no task-wide aggregate that could feed back into a criterion.
**Verification:** E1 — `npx vitest run tests/proof/gate.test.ts`: the two-criterion split yields independent `PASS`/`MISSING_PROOF`, with each packet asserted to contain none of the sibling's records (AC-1); the false-completion fixture is rejected with a structured category, asserted both with JEV scripted optimistically and with JEV disabled (AC-2, AC-6 first half); the advisory-fail/mandatory-pass same-scope packet yields `FAILED` with the record pair while JEV answers Q1 = `YES`, Q2 = `NO`, and the same packet minus the conflicting record yields `PASS` (AC-3); a criterion whose only runtime record is `unavailable` yields a non-`PASS` decision with the record under `known_gaps` and the missing capability named, under all-affirmative JEV answers (AC-7); and a fully-evidenced criterion flips `PASS` → `MISSING_PROOF` when the scripted Q1 answer changes to `NO` (AC-6 second half). Distinct risks covered: a gate that never rejects (the false-completion fixture is the standing negative control, and it must contain no evidence for the feature — assert the fixture's evidence channel is empty so the control is not vacuous); a JEV answer being ignored (the Q1 flip is the differential control); `PASS` reachable from JEV alone (all-affirmative answers over a `deterministic_failure` aggregate must return non-`PASS`); one shared aggregate leaking a sibling's evidence onto a criterion (the cross-criterion packet assertion detects it); and contradiction detection that only echoes an already-failing check (the AC-3 fixture has no mandatory failure at all).
**Checkpoint:** done

#### Phase 2: Enum→action mapping, bounded gathering loop, escalation ladder
**Status:** DONE
**ACs:** AC-4, AC-5
**Files:** `src/proof/actions.ts` (gap enum → concrete action table), `src/proof/recover.ts` (`recover`, attempt accounting, §41 ladder), `src/proof/gate.ts` (loop wiring), `tests/proof/recover.test.ts`
**Implementation:** `actions.ts` is a single exhaustive record keyed by the §38 enum; the compiler enforces exhaustiveness so a new member cannot be added without a mapping. Each entry names the executor of the action — a PRD-009 verifier kind, with `RUNTIME_TEST_REQUIRED` → `runtime_smoke` and `UI_VERIFICATION_REQUIRED` → `browser_test` (both registered by PRD-022), a PRD-011 reviewer level, an owner-lane prompt, or a PRD-014 context fetch — plus a cost rank; `recover` runs the cheapest action for the highest-severity gap, lets PRD-009 write the resulting record, and re-enters the gate. `attempts` increments per gathering round and is capped by `contract.limits.semantic_review_rounds`; `LeanPiConfig.proof.maxAttempts` is the compiler-side default for a contract that omits the field and is not read here, so exactly one ceiling exists at runtime. Zero is a legal bound and skips straight to the ladder. On exhaustion, run the ladder once per rung — `review(packet, 'QUICK_REVIEW', mode)` then `review(packet, 'STRONG_REVIEW', mode)` from PRD-011's `src/review/lane.ts` — and return `BLOCKED` with the unproved criterion and its gap category. Unmapped/unavailable action → `BLOCKED` with the reason; `src/proof/` imports no `EvidenceStore.record` binding, so the gate has no write path into the evidence `records` channel.
**Verification:** E2 — `npx vitest run tests/proof/recover.test.ts`: `RUNTIME_TEST_REQUIRED` runs the mapped `runtime_smoke` verifier, a new record attributed to the criterion appears in the store and the re-entered gate returns `PASS`, while `NONE` on the same input executes no verifier (AC-4); a permanently-insufficient fixture with `limits.semantic_review_rounds: 2` performs exactly two rounds then walks `QUICK_REVIEW` → `STRONG_REVIEW` → `BLOCKED` with the criterion and category, the same fixture with `semantic_review_rounds: 0` performs zero rounds and enters the ladder immediately, and the store's record count is unchanged across both ladders (AC-5). Distinct risks covered: an unbounded loop (assert the exact round count, not merely termination); two competing ceilings (the `0` case fails if `proof.maxAttempts` is still being read); a mocked-out action that never runs the real verifier (assert the spawned command and the resulting record, not a call count); a stub standing in for the reviewer (assert PRD-011's `review()` was invoked at each rung with the matching `ReviewLevel`); and evidence manufactured to satisfy the gate (the unchanged record count during the ladder, with AC-4's run as the positive control proving the count does move when a real recovery action runs).
**Checkpoint:** done

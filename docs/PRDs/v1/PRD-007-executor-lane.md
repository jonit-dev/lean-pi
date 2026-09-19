# PRD-007 — Executor Lane

**Status:** NOT STARTED
**Complexity:** 5 (MEDIUM)
**Risk override:** none — no security boundary, no destructive migration, no cross-release compatibility surface.
**Owner:** joao
**Depends on:** PRD-004, PRD-008

## Context

**Covers:** FR-019, FR-060, FR-063, FR-065, FR-066, FR-067; ROADMAP §28, §29, §33, §34.

LeanPi is greenfield; the only file in the repository is `docs/PRDs/v1/ROADMAP.md`. Every path named below is created by the phases of this PRD or by the PRD it is attributed to.

Current behavior: none. PRD-004 produces an `ExecutionContract` (`src/compiler/contract.ts`) describing the route for a turn; PRD-008 provides backend workers that turn a task packet into workspace changes plus a structured result. Nothing today consumes the contract and drives implementation work, so a routed turn dies at the compiler.

Three requirements from the ROADMAP are unmet and cannot be satisfied by prompt text alone:

- §28: the Executor receives objective, active acceptance criteria, selected context, selected capabilities, budget and retry limit — and SHOULD NOT receive the routing process that produced them.
- §33: retry ceilings SHALL be enforced in code, not requested in prompts. Retry state tracks `attempt`, `strategy`, `failure_signature`, `new_evidence`, `model`; the policy rejects a repeated attempt with the same failure and same strategy, may retry the same failure when new evidence arrives, reassesses on a new failure, and sends multiple failed strategies to the escalation gate.
- §34: JEV may classify the escalation category; **application code performs the escalation**. §29 additionally requires the quick path to run with no mandatory PRD, PRD manager, strong model, reviewer, subagent, broad skill scan or broad MCP disclosure.

Inspected for this plan: ROADMAP §28 (lines 1024–1049), §29 (1051–1093), §33 (1178–1202), §34 (1205–1223), §49 (JEV must never be a single point of failure), and the FR blocks at 1711–1733 (FR-019) and 1797–1814 (FR-060…FR-067).

## Solution

One module, three small files, no new abstraction layers.

`src/executor/lane.ts` exposes `runExecutor(contract, deps): Promise<ExecutorOutcome>`. It projects the `ExecutionContract` into an `ExecutorTask` with an explicit allow-list — `objective`, `acceptanceCriteria`, `context`, `capabilities`, `budget`, `retryLimit` — and nothing else. Routing fields (classifier scores, JEV decisions, backend-selection reasons, the contract's own `route` block) are dropped at that boundary, so no downstream prompt can leak them. The projection is a whitelist because a blacklist silently admits every field PRD-004 adds later.

`src/executor/retry.ts` holds the bounded retry state machine. State is the §33 record (`attempt`, `strategy`, `failureSignature`, `newEvidence`, `model`) appended to a per-turn history. `nextAttempt(history, failure)` returns `retry | reject | escalate` from the §33 policy table implemented as a plain switch. `failureSignature` is a `node:crypto` SHA-1 over the verifier kind plus the normalized first failing diagnostic (absolute paths, line/column numbers, durations and temp dir names stripped), so a genuinely identical failure hashes identically across attempts. The ceiling is a loop condition in this file, not an instruction to a model.

`src/executor/escalation.ts` asks JEV a single atomic `classify_escalation` Choice question over the eight §34 categories via `src/jev/client.ts#ask` (PRD-002) and then **performs** the chosen action in application code: `GET_MORE_CONTEXT` widens the context selection (PRD-014), `ENABLE_CAPABILITY` re-runs the capability router for one named capability (PRD-005/PRD-006), `INCREASE_REASONING` raises the effort level on the current role, `SWITCH_MODEL` steps the role ladder `quick → balanced → strong` (FR-067), `SWITCH_BACKEND` asks the PRD-008 registry for the next enabled backend, `STRONG_REVIEW` hands off to the PRD-011 reviewer at `review_strong`, `USER_INPUT` returns a question to the session, `STOP_BLOCKED` terminates with a blocked outcome and its evidence. JEV is advisory (FR-019 is SHOULD): when JEV is unavailable or low-confidence, the lane falls back to a deterministic ladder — one `SWITCH_MODEL`, then `STOP_BLOCKED` — so §49 holds.

The lane owns four JEV decision sites (failure classification, retry usefulness, escalation reason, user-clarification need). Each registers itself with the PRD-002 decision-site registry at module load — id, question set, return type, confidence threshold, deterministic fallback, telemetry tag — so FR-020 logging and the §56 metrics are per-site. Every site has a non-null deterministic fallback, and the loop's termination guarantee never depends on JEV answering.

Zero-model review (FR-063) is a predicate, not a lane: when `review_risk` is low and every active acceptance criterion is covered by a passing deterministic evidence record (PRD-009), `runExecutor` returns `review: 'none'` and no reviewer model is ever spawned. The §29 quick path is the same code path with an empty capability set: the lane never calls the capability registry's broad scan, never touches PRD machinery, and never spawns a subagent when the contract says `prd: false, complexity: low`.

Consumer flow: user message → `src/commands/session.ts#runTurn` (PRD-001) → PRD-004 compiler → `src/executor/lane.ts#runExecutor` → PRD-008 backend worker → workspace change + evidence → outcome rendered in the session transcript.

Reused rather than rebuilt: `ExecutionContract` (PRD-004), `ask` (PRD-002), backend selection and spawning (PRD-008), `EvidenceRecord` (PRD-009), working state and artifacts (PRD-014). No executor interface with one implementation, no strategy plugin registry — strategies are a string in the retry record.

Risks: a too-loose failure normalizer makes distinct failures collide and rejects a legitimate retry; a too-tight one never detects the repeat (FR-066). The normalizer is therefore asserted directly on a fixture of two same-cause and two different-cause failures within AC-5's evidence.

Non-goals restated from ROADMAP §58: no unbounded autonomy (the ceiling is hard), no correctness claims without evidence (a blocked outcome stays blocked), no default multi-agent swarms (the quick path spawns no subagent), and no JEV requirement for basic operation (escalation degrades to the deterministic ladder).

## External Skill Dependencies

None. The executor lane invokes no installed skill: the quick path deliberately runs with no PRD machinery and no broad skill scan (ROADMAP §29), and the capability router that reaches the user's global skill roots is owned by PRD-005. When an escalation returns `ENABLE_CAPABILITY`, this PRD calls PRD-005's router rather than resolving any skill path itself, so no skill root is referenced in this PRD's code.

## JEV Decision Sites

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| Failure classification | "Which category best describes this failure: syntax, assertion, environment, dependency, likely-logic-bug?" | Choice | Rule table over the verifier kind and diagnostic code (typecheck/parse → syntax; test assertion → assertion; non-zero spawn/ENOENT/network → environment; resolver/install error → dependency; otherwise likely-logic-bug) | ★★★★★ |
| Retry usefulness | "Given this failure history and the new evidence gathered, is another attempt with strategy X likely to change the outcome?" | Score (0–1, retry when above threshold) | §33 policy alone: retry only when the failure signature is new or new evidence arrived; otherwise reject | ★★★★★ |
| Escalation reason | "Is the blocking deficiency missing context, insufficient reasoning, or a missing capability?" (then the §34 category) | Choice | Ladder: one `SWITCH_MODEL`, then `STOP_BLOCKED` | ★★★★★ |
| User-clarification need | "Is this ambiguity material enough that guessing risks the wrong outcome?" | Choice | Do not ask; proceed with the stated assumption recorded in the outcome, and `STOP_BLOCKED` if the attempt fails | ★★★★☆ |

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: A session turn whose compiled contract carries routing metadata reaches the backend worker with a task packet containing the objective, active ACs, selected context, selected capabilities, budget and retry limit, and containing no routing field (no classifier scores, no JEV decision records, no backend-selection rationale) — asserted against the payload the stub harness actually receives. — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: A routed turn run through `runTurn` edits the workspace and returns a structured executor outcome in the session transcript naming the changed files and the evidence collected; a turn whose backend reports it is blocked returns a blocked outcome instead of a success. — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: A turn with `prd: false, complexity: low, review_risk: low, executor: quick, skills: [], mcps: []` completes with exactly one executor backend invocation on the `quick` role and zero calls to PRD creator/manager, zero reviewer invocations, zero subagent spawns and zero broad capability-registry scans. — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: A low-risk turn whose deterministic verifiers pass for every active AC completes with `review: none` and zero reviewer model invocations; the same turn with one AC lacking passing deterministic evidence does invoke the reviewer. — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: When the backend returns the identical failure twice under the same strategy with no new evidence, the second attempt is rejected without a backend invocation; when the same failure returns accompanied by new evidence the loop retries, and a different failure causes strategy reassessment — observable in the per-turn retry history and the backend invocation count. — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: A backend that fails on every attempt stops at the configured retry limit — backend invocations never exceed the limit regardless of what the model output requests, and the turn ends at the escalation gate rather than looping. — Evidence: pending.
- [ ] AC-7 [local; actor: agent]: After multiple failed strategies, JEV's classified escalation category is executed by application code — a `SWITCH_BACKEND` classification causes the next attempt to run on a different backend, and `STOP_BLOCKED` ends the turn blocked; with JEV unavailable the turn still terminates via the deterministic fallback ladder. — Evidence: pending.
- [ ] AC-8 [local; actor: agent]: Repeated failure under the `quick` role escalates the executor role to `balanced` and then `strong` for subsequent attempts, visible as a changed model role in the retry history and in the backend invocation record. — Evidence: pending.
- [ ] AC-9 [local; actor: agent]: The retry-loop JEV sites change observable behavior and degrade safely — a `failure_classification` of `environment` makes the next attempt use a different strategy than the same failure classified `likely-logic-bug`, and a `retry_usefulness` score below threshold ends the turn before the retry ceiling is reached; with JEV disabled the same two turns still terminate through the deterministic rule table and the §33 policy, and the run record marks every site `fallback_used: true`. — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Executor lane execution | User message → `src/commands/session.ts#runTurn` (created in PRD-001; wired to the lane in Phase 1) → `src/executor/lane.ts#runExecutor` (created in Phase 1) | New capability; the compiler no longer terminates a turn at the contract | AC-1, AC-2 |
| Quick path (no PRD, reviewer, subagent or broad capability scan) | Same session turn with a low-complexity contract → `runExecutor` quick branch (Phase 2) | First implementation of ROADMAP §29; no prior path | AC-3, AC-4 |
| Bounded retry and escalation | Failed executor attempt → `src/executor/retry.ts#nextAttempt` → `src/executor/escalation.ts#escalate` (Phase 3, Phase 4), calling `src/jev/client.ts#ask` (PRD-002) and registering four sites in PRD-002's decision-site registry | New; the only loop control for executor attempts | AC-5, AC-6, AC-7, AC-8, AC-9 |

## Execution Phases

#### Phase 1: Executor lane invocation and task-packet isolation
**Status:** NOT STARTED
**ACs:** AC-1, AC-2
**Files:** `src/executor/lane.ts` (new — `ExecutorTask`, `ExecutorOutcome`, `toExecutorTask` whitelist projection, single-attempt `runExecutor`); `src/commands/session.ts` (edit — call the lane with the compiled contract and render the outcome)
**Implementation:** Define `ExecutorTask` with exactly the six §28 fields. `toExecutorTask(contract)` copies those fields by name and asserts at runtime (cheap object-key check, thrown as a programming error) that no additional key is present, so a later contract field cannot leak silently. `runExecutor` resolves the backend for the contract's executor role through the PRD-008 registry, submits the packet, and normalizes the worker's structured result into `ExecutorOutcome { status: 'completed' | 'blocked', changedFiles, evidence, retryHistory, review }`. A blocked worker result maps to `status: 'blocked'` with its reason preserved; it is never coerced to success. Session rendering lists changed files and evidence kinds.
**Verification:** E1 — vitest spec driving `runTurn` end to end with the PRD-008 stub harness backend and a recording JEV stub; asserts the exact key set of the JSON the stub received (present: objective/ACs/context/capabilities/budget/retryLimit; absent: every routing key present on the input contract), the workspace file written by the stub, and that a stub configured to report blocked yields a blocked outcome. Covers AC-1 (packet isolation), AC-2 (reachable consumer produces workspace change and honest blocked path). Distinct risks: field leakage at the projection boundary, and success coercion of a blocked worker.
**Checkpoint:** pending

#### Phase 2: Quick path and zero-model review
**Status:** NOT STARTED
**ACs:** AC-3, AC-4
**Files:** `src/executor/lane.ts` (edit — quick branch and the `reviewNeeded` predicate)
**Implementation:** For a contract with `prd: false` and `complexity: low`, `runExecutor` uses the capabilities already listed on the contract and never calls the capability registry's scan entry point; no PRD creator/manager call and no subagent spawn exist on this path (they are absent, not disabled by a flag). `reviewNeeded(contract, evidence)` returns false when `review_risk === 'low'` and every active AC id appears in a passing `EvidenceRecord` (PRD-009); otherwise the lane hands the compact evidence packet to the PRD-011 reviewer. Wire the counters the spec observes: the lane records each backend invocation with its role in `ExecutorOutcome.invocations`.
**Implementation note:** the "no broad scan" property is proved by a spy on the capability registry's scan function, because absence of a call cannot be proved from output alone.
**Verification:** E2 — vitest spec running the ROADMAP §29 worked example (`rename parseFoo to parseBar`) through `runTurn` with the stub harness, spies on the PRD-005/PRD-006 registry scan, PRD-012 PRD entry points and the PRD-011 reviewer; asserts one `quick` invocation and zero calls to each spy, then re-runs the same turn with one AC's deterministic evidence failing and asserts the reviewer is invoked exactly once. Covers AC-3 and AC-4. The second run is the negative control for AC-4: it distinguishes "review correctly skipped" from "reviewer never wired".
**Checkpoint:** pending

#### Phase 3: Bounded retry state machine
**Status:** NOT STARTED
**ACs:** AC-5, AC-6, AC-9
**Files:** `src/executor/retry.ts` (new — retry record, `failureSignature`, `nextAttempt` policy); `src/executor/lane.ts` (edit — attempt loop driven by `nextAttempt`)
**Implementation:** `failureSignature(failure)` = SHA-1 (`node:crypto`) over `kind` plus the failing diagnostic normalized by stripping absolute paths, line/column numbers, durations, temp directory names and ANSI codes. `nextAttempt(history, failure)` implements §33 exactly: same signature + same strategy + no new evidence → `reject`; same signature + new evidence → `retry` on the same strategy; new signature → `retry` with strategy reassessment; two or more distinct exhausted strategies, or `attempt === retryLimit` → `escalate`. The lane's loop calls `nextAttempt` as its only continuation condition, so the ceiling holds whatever the model asks for; a `reject` result consumes no backend invocation.
**JEV sites:** `failure_classification` (Choice over syntax/assertion/environment/dependency/likely-logic-bug) selects the next strategy; `retry_usefulness` (Score) can stop the loop early. Both register with the PRD-002 registry with their deterministic fallbacks — the diagnostic rule table and the bare §33 policy respectively — and the loop's termination proof holds with both answers absent.
**Verification:** E3 — vitest spec driving `runTurn` against a scripted stub harness that replays a fixed failure sequence (identical failure ×2; identical failure with new evidence; a different failure; then persistent failure), asserting the retry history rows and the backend invocation count at each step, plus a direct assertion that two same-cause failures with different paths/line numbers share a signature while two different-cause failures do not. Red: re-run the ceiling case with the loop condition replaced by a plain counter that trusts the worker's "retry again" flag — invocations must exceed `retryLimit`, proving the assertion is sensitive to the in-code ceiling. E3b — same spec file, two turns with a scripted JEV stub: one classifying `environment` and one `likely-logic-bug` for the identical failure, asserting different next strategies in the retry history; one returning a below-threshold `retry_usefulness`, asserting the turn ends before `retryLimit`; both turns re-run with JEV disabled assert termination via the fallback and `fallback_used: true` on each site row. Covers AC-5 (policy branches, FR-066 detection), AC-6 (FR-065 ceiling) and AC-9 (sites act, then degrade). Distinct risks: a normalizer too loose or too tight, and a JEV answer logged but never acted on.
**Checkpoint:** pending

#### Phase 4: Escalation gate
**Status:** NOT STARTED
**ACs:** AC-7, AC-8
**JEV sites:** `escalation_reason` (Choice: missing context / insufficient reasoning / missing capability, then the §34 category) and `user_clarification_need` (Choice) — the latter gates `USER_INPUT`, defaulting to "do not ask, record the assumption" when JEV is off.
**Files:** `src/executor/escalation.ts` (new — `classifyEscalation` JEV call, `escalate` action dispatch, deterministic fallback ladder); `src/executor/lane.ts` (edit — route `escalate` from `nextAttempt` into `escalate`)
**Implementation:** `classifyEscalation` asks one atomic Choice question over the eight §34 categories through `src/jev/client.ts#ask` (PRD-002), passing the compact failure history, not the transcript. `escalate` switches on the returned category and performs the action in application code: context widening (PRD-014), single-capability enablement (PRD-005/PRD-006), effort increase on the current role, role step `quick → balanced → strong` (FR-067), next enabled backend from the PRD-008 registry, strong review handoff (PRD-011), a user question returned through the session, or a blocked outcome. Unknown/low-confidence/unavailable JEV → deterministic ladder: one `SWITCH_MODEL`, then `STOP_BLOCKED`. Each escalation appends a row to the retry history with the new `model` and backend.
**Verification:** E4 — vitest spec driving `runTurn` with a persistently failing stub harness and a JEV stub scripted to return `SWITCH_BACKEND`, then `STOP_BLOCKED`; asserts the second backend actually ran (different stub records the invocation) and the turn ends blocked with its evidence intact. A third run with the JEV stub throwing asserts the turn still terminates through the fallback ladder. A fourth run with `SWITCH_MODEL` asserts the recorded role advances `quick → balanced → strong` across attempts. Covers AC-7 (application code performs the escalation, JEV-optional) and AC-8 (FR-067 role escalation). Distinct risk covered by the JEV-throwing run: JEV becoming a single point of failure (§49).
**Checkpoint:** pending

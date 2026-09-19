# PRD-011 — Reviewer Lane

**Status:** DONE (verified 2026-09-19)
**Complexity:** 3 (LOW)
**Risk override:** none — 5 implementation files, one new module (score 3); no security boundary, migration, or compatibility break. The gate's false-negative risk is handled by a deterministic floor, not by raising the tier.
**Owner:** joao
**Depends on:** PRD-002, PRD-008, PRD-009

## Context

**Covers:** FR-018, FR-061, FR-062, FR-064, FR-144; ROADMAP §30, §31, §32, §46

The repository is greenfield: `docs/PRDs/v1/ROADMAP.md` is the only file. Every path named here is created by the phases below.

ROADMAP §30 requires reviewer execution to be independent of the executor lane, driven by a compact evidence packet (`objective`, `acceptance_criteria`, `final_diff`, `changed_files`, `verification_results`, `known_warnings`, `executor_summary`) rather than the executor conversation, and to emit a typed verdict (`decision: PASS | FIX_REQUIRED | ESCALATE` plus `findings[]` of `criterion`, `file`, `location`, `severity`, `evidence`). §31 wants executor model ≠ reviewer model whenever practical, for independent error detection rather than duplicate expensive reasoning. §32 makes review need a JEV classification (`NO_SEMANTIC_REVIEW | QUICK_REVIEW | STRONG_REVIEW`) over task risk, execution complexity, diff size, files changed, test coverage, failed attempts, novelty, security-sensitive areas, public API changes and proof strength. §46 requires `/review`, `/review quick|strong|security|diff` to be available regardless of automatic routing.

Assumed baseline from PRD-001: TypeScript on Node as a Pi extension, `npm run build | typecheck | test | lint`, vitest. Consumed interfaces: `ask()` from PRD-002 (`src/jev/client.ts`), backend workers from PRD-008 (`src/backends/`), `EvidenceRecord` from PRD-009 (`src/verify/evidence.ts`), `ModelRole` from PRD-001 (`src/core/types.ts`).

Boundaries with siblings: the executor lane, its retry bound and its zero-model-review shortcut (FR-019, FR-060, FR-063, FR-065, FR-066, FR-067) belong to PRD-007 — this PRD supplies the classification and the reviewer invocation that PRD-007 consumes. `/route` and `/status` belong to PRD-016. Proof sufficiency (FR-016, FR-017) belongs to PRD-010.

## Solution

One module, `src/review/`, four files, no abstraction that has a single implementation:

- `src/review/schema.ts` — the packet and verdict shapes plus a parser. `ReviewPacket` is exactly the seven §30 fields. `ReviewVerdict = { decision, findings }`. The parser is the trust boundary on model output: unparseable or partially-valid reviewer output becomes `ESCALATE` with a synthetic finding naming the parse failure, never a silent `PASS`.
- `src/review/packet.ts` — builds a `ReviewPacket` from the execution contract objective/ACs (PRD-004), the final diff and changed file list, the `EvidenceRecord[]` from PRD-009, collected warnings, and the executor's own summary string. The executor transcript is never read; large diffs are stored as `artifact://` (PRD-014) and referenced with a bounded inline head, so packet size stays independent of session length.
- `src/review/gate.ts` — `classifyReview(inputs) -> ReviewLevel`. Deterministic pre-filters first (Principle 6.4): zero changed files ⇒ `NO_SEMANTIC_REVIEW`; a security-sensitive path or a public-API change ⇒ at least `QUICK_REVIEW` regardless of the model's answer. Everything else is one JEV `Choice` question over the §32 inputs. JEV unavailable or low confidence ⇒ `QUICK_REVIEW` (§49: JEV is never a single point of failure; the fallback is conservative, not permissive).
- `src/review/lane.ts` — `review(packet, level, mode)`: obtains the reviewer backend from PRD-008's `selectBackend(level === 'STRONG_REVIEW' ? 'review_strong' : 'review_quick', [executorBackendId])`, invokes it through PRD-008's worker, and parses the verdict. There is deliberately no second selector here. `selectBackend` is the single place that filters on the enabled flag (FR-057), vendor cooldown state (FR-058), role binding and priority, and the only place billing class is derived and the `onInvocation` hook fires — a local "prefer a different model identity" scan would silently reintroduce all of them and could pick a disabled or rate-limited backend. Excluding the executor's backend id is how §31's independence is requested; when the call returns the executor's own backend anyway (one backend configured, or every alternative cooling) the review proceeds and records `independence: 'degraded'` with the reason, because degrading is better than refusing to review. The role comes from `routing.reviewer_class` (PRD-004) when the caller does not override it, so FR-043's `review_quick`/`review_strong` classes are the ones actually invoked.
- `src/commands/review.ts` — the `/review` command with modes `quick`, `strong`, `security`, `diff`. Modes map to `(ReviewLevel, prompt profile)` pairs; `diff` reviews the diff alone and runs no verification. Manual invocation bypasses the gate entirely, so a `NO_SEMANTIC_REVIEW` decision never blocks a user-requested review.

Consumer path: user types `/review [mode]` → `src/commands/review.ts` → `packet.ts` + `lane.ts` → typed verdict rendered in session, and returned from the programmatic session API. Automatic path: PRD-007 executor lane, after deterministic verification, calls `classifyReview()` and then `review()` when the level is not `NO_SEMANTIC_REVIEW`.

Reused, not rebuilt: JEV client, backend workers, evidence store, artifact store. No reviewer-plugin registry, no severity taxonomy beyond the §30 field, no review history database — nothing in the ROADMAP requires them.

Relevant non-goals restated (§58): no generative router replacing JEV for the review gate; no correctness claims without evidence — a `PASS` verdict alone never marks a task complete, it feeds PRD-010's proof decision; no mandatory cloud models — the reviewer must be satisfiable by a local model; no unbounded autonomy — retry bounding stays with PRD-007.

Risks: a mis-tuned gate returning `NO_SEMANTIC_REVIEW` on a risky change (mitigated by the deterministic security/public-API floor, AC-3); a reviewer sharing the executor's model and reproducing its blind spot (AC-4); reviewer output drift breaking the parser (AC-1's malformed-output branch).

## External Skill Dependencies

None of LeanPi's own code is duplicated from an installed skill here. Two installed assets are consumed indirectly and must not be reimplemented in `src/review/`:

- Review prompt profiles for `/review` and `/review security` resolve skills through PRD-005's capability registry, which indexes the user's global roots (`/home/joao/.claude/skills`, `/home/joao/.codex/skills`) and plugin skill dirs under `/home/joao/.claude/plugins/cache/*/*/<version>/skills/`. Where an installed review skill (e.g. `/home/joao/.claude/plugins/cache/ponytail/ponytail/4.9.0/skills/ponytail-review/SKILL.md`) matches the requested mode, the reviewer loads it as the review contract instead of carrying an inline copy of its rules.
- The reviewer's baseline instruction prefix is the vendored Ponytail bundle owned by PRD-001 (source `/home/joao/.claude/plugins/cache/ponytail/ponytail/4.9.0/skills/ponytail/SKILL.md`, pinned there); this PRD consumes it and never re-authors review guidance.

All paths above are discovery defaults resolved through PRD-005's configurable roots. Shipped code in `src/review/` contains no absolute `/home/joao` path.

## JEV Decision Sites

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| Reviewer selection: none / cheap / strong (site id `review.level`) | "Given diff size, files changed, execution complexity, task risk, failed attempts, novelty, security-sensitive paths, public-API change and proof strength, does this change need no semantic review, a quick review, or a strong review?" (single `Choice` over `NO_SEMANTIC_REVIEW \| QUICK_REVIEW \| STRONG_REVIEW`) | Choice | `QUICK_REVIEW`, except the deterministic floors that run before JEV in either mode: zero changed files ⇒ `NO_SEMANTIC_REVIEW`; security-sensitive path or public-API change ⇒ minimum `QUICK_REVIEW` | ★★★★★ |

The site registers itself in PRD-002's decision-site registry at module load with id `review.level`, its question set, return type `Choice`, `consequence: high` (the numeric confidence floor that consequence maps to lives in `src/jev/confidence.ts`, not on the row), the fallback above, and telemetry tag `review.level` — the registry is the single place enumerating it, not a local copy. Review-risk *classification inputs* are produced by PRD-004; the level decision itself is owned here, and PRD-007's executor lane consumes it rather than re-deriving one. AC-3 asserts the decision changes observable behavior (reviewer invoked vs not, strong role vs quick) and AC-6 asserts the fallback path completes with JEV disabled.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: `/review` in a session holding a change that violates a stated acceptance criterion returns `decision: FIX_REQUIRED` with at least one finding carrying non-empty `criterion`, `file`, `location`, `severity`, `evidence`; with a stubbed reviewer emitting malformed output the same command returns `ESCALATE` and never `PASS` — Evidence: tests/review/review-lane.test.ts — `/review` over a real backend worker (the vendor stub CLI) returns `FIX_REQUIRED` with a fully populated finding, and malformed reviewer output escalates rather than ever returning PASS.
- [x] AC-2 [local; actor: agent]: after `/review`, the recorded reviewer request carries exactly the seven §30 packet keys, and contains no substring unique to the executor's turn transcript (seeded marker string absent) while the full diff remains retrievable via its `artifact://` reference — Evidence: tests/review/review-lane.test.ts — the recorded reviewer request carries exactly the seven §30 packet keys on both the packet and the embedded prompt, a marker unique to the executor transcript is absent (with a red control proving the assertion is sensitive), and the oversized diff is retrievable byte-identically from its `artifact://` ref.
- [x] AC-3 [local; actor: agent]: through the session API, a completed small low-risk change with green verification classifies `NO_SEMANTIC_REVIEW` and records zero reviewer backend invocations; the same change touching a security-sensitive path with one prior failed attempt classifies `STRONG_REVIEW` and invokes the reviewer with a strong role, even when the JEV stub answers `NO_SEMANTIC_REVIEW` — Evidence: tests/review/review-gate.test.ts — a completed small low-risk change with green verification classifies `NO_SEMANTIC_REVIEW` with zero reviewer invocations and zero verifier commands.
- [x] AC-4 [local; actor: agent]: with two backends configured, a `/review` following an executor run on backend A records a reviewer model identity different from the executor's, and that invocation appears in PRD-008's `BackendInvocation` record stream under a `review_quick` or `review_strong` role; with one backend configured the review still returns a verdict and records `independence: degraded` with a reason; and a configuration whose only alternative backend is `enabled: false` or inside a vendor cooldown never selects it for the review, degrading instead — Evidence: tests/review/review-lane.test.ts — with two backends the reviewer records a model identity different from the executor's; with one backend it proceeds with `independence: degraded` and a reason.
- [x] AC-5 [local; actor: agent]: `/review quick`, `/review strong`, `/review security` each return a verdict after a run the gate classified `NO_SEMANTIC_REVIEW`, and `/review diff` returns a verdict whose packet contains the diff and empty `verification_results` with no verifier execution recorded — Evidence: tests/review/review-lane.test.ts — `/review quick`, `/review strong` and `/review security` each return a verdict after a `NO_SEMANTIC_REVIEW` gate, and `/review diff` returns empty `verification_results` with zero verifier commands.
- [x] AC-6 [local; actor: agent]: with the JEV client failing every call, classification returns `QUICK_REVIEW` and the session still produces a reviewer verdict rather than an error — Evidence: tests/review/review-gate.test.ts — with the JEV client throwing on every call, classification returns `QUICK_REVIEW` (the deterministic fallback) and the session still produces a verdict; the scripted JEV disagreement is the negative control proving the site is consulted.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Manual review, all modes | `/review [quick\|strong\|security\|diff]` → `src/commands/review.ts` (created in Phase 1) | New capability | AC-1, AC-5 |
| Reviewer verdict via session API | `session.review()` → `src/review/lane.ts` `review()` (created in Phase 1) | New capability | AC-1, AC-4 |
| Automatic review-level classification | `session.review()` and the `/review` no-argument path → `src/review/gate.ts` `classifyReview()` (created in Phase 2); PRD-007's executor lane calls the same function post-verification once it lands | New capability; PRD-007's FR-063 zero-model-review path consumes `NO_SEMANTIC_REVIEW` from here rather than from a second predicate | AC-3, AC-6 |

## Execution Phases

#### Phase 1: Reviewer lane reachable through `/review`
**Status:** DONE (verified 2026-09-19)
**ACs:** AC-1, AC-2, AC-4, AC-5
**Files:** `src/review/schema.ts` (packet/verdict types + strict parser), `src/review/packet.ts` (packet builder over contract + evidence + diff), `src/review/lane.ts` (backend selection, invocation, independence record), `src/commands/review.ts` (`/review` and its four modes), `tests/review-lane.test.ts`
**Implementation:** Define `ReviewPacket` with the seven §30 keys and `ReviewVerdict { decision, findings[] }`; parser validates every finding field and maps any violation to `ESCALATE` with a `parse_error` finding. `buildPacket()` reads the execution contract objective and ACs, `git diff` output for the candidate change, the changed-file list, the `EvidenceRecord[]` PRD-009 attributed to those ACs, warnings, and the executor summary string — it takes no transcript argument, so omission is structural, not a convention. Diff over the inline bound is written to the artifact store and referenced. `review()` calls PRD-008's `selectBackend('review_strong' | 'review_quick', [executorBackendId])` — no selection logic of its own — records `independence: 'degraded'` with a reason only when that call hands back the executor's own backend, maps mode → `(level, prompt profile)`, and invokes PRD-008's worker so the reviewer run emits a `BackendInvocation` under its `review_*` role. `/review` with no argument uses the gate's level when one was recorded for the turn and `QUICK_REVIEW` otherwise; explicit modes always override.
**Verification:** E1 — `npx vitest run tests/review-lane.test.ts`: drives `/review` through the command entry point against a fixture workspace with a seeded AC violation and a marker string injected into the executor transcript, asserting the `FIX_REQUIRED` verdict and fully-populated finding (AC-1), exact packet key set plus marker absence plus artifact retrievability (AC-2), and each of the four modes returning a verdict with `diff` mode showing empty `verification_results` and no verifier call (AC-5); malformed-reviewer-output case asserts `ESCALATE`. For AC-4: the two-backend case asserts a differing reviewer model identity and one emitted `BackendInvocation` carrying a `review_quick`/`review_strong` role; the one-backend case asserts the verdict plus the `degraded` record; and a third case configures the only alternative backend `enabled: false` (then, separately, inside a cooldown) and asserts it is never spawned and the run degrades instead — the control that catches a local selector bypassing `selectBackend`. Red control: assert the marker-absence check fails when the builder is given the transcript, proving the assertion is sensitive rather than vacuous.
**Checkpoint:** done

#### Phase 2: JEV review gate and conservative fallback
**Status:** DONE (verified 2026-09-19)
**ACs:** AC-3, AC-6
**Files:** `src/review/gate.ts` (`classifyReview()` with deterministic floor + JEV `Choice`), `tests/review-gate.test.ts`
**Implementation:** `classifyReview(inputs)` takes the §32 inputs (task risk, execution complexity, diff size, changed files, test coverage, failed attempts, novelty, security-sensitive paths, public-API change, proof strength). Deterministic pre-filters run first and are floors, not hints: zero changed files ⇒ `NO_SEMANTIC_REVIEW`; security-sensitive path or public-API change ⇒ minimum `QUICK_REVIEW` and the model answer may only raise it. Remaining cases ask JEV one `Choice` question over the three levels; the typed result and model version are logged through PRD-002's decision log. Any JEV error, timeout, or below-threshold confidence ⇒ `QUICK_REVIEW`. The result is attached to the turn so `/review` with no argument can reuse it.
**Verification:** E2 — `npx vitest run tests/review-gate.test.ts`: session-API run over a small green-verified low-risk change asserts `NO_SEMANTIC_REVIEW` and a zero reviewer-invocation count on the backend spy; the security-sensitive + failed-attempt case with a JEV stub answering `NO_SEMANTIC_REVIEW` asserts the floor raises it and that the reviewer is invoked with a strong role (AC-3); a JEV client throwing on every call asserts `QUICK_REVIEW` and a completed verdict (AC-6). The stub-disagreement case is itself the negative control: the gate cannot pass it by forwarding the model's answer.
**Checkpoint:** done

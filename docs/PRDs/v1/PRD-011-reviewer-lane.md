# PRD-011 — Reviewer Lane

**Status:** NOT STARTED
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
- `src/review/lane.ts` — `review(packet, level, mode)`: picks a backend/model for the reviewer, invokes it through PRD-008, parses the verdict. Selection prefers any configured backend whose model identity differs from the executor's; when only one is configured it proceeds and records `independence: 'degraded'` with the reason, because degrading is better than refusing to review.
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

The site registers itself in PRD-002's decision-site registry at module load with id `review.level`, its question set, return type `Choice`, its confidence threshold, the fallback above, and telemetry tag `review.level` — the registry is the single place enumerating it, not a local copy. Review-risk *classification inputs* are produced by PRD-004; the level decision itself is owned here. AC-3 asserts the decision changes observable behavior (reviewer invoked vs not, strong role vs quick) and AC-6 asserts the fallback path completes with JEV disabled.

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: `/review` in a session holding a change that violates a stated acceptance criterion returns `decision: FIX_REQUIRED` with at least one finding carrying non-empty `criterion`, `file`, `location`, `severity`, `evidence`; with a stubbed reviewer emitting malformed output the same command returns `ESCALATE` and never `PASS` — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: after `/review`, the recorded reviewer request carries exactly the seven §30 packet keys, and contains no substring unique to the executor's turn transcript (seeded marker string absent) while the full diff remains retrievable via its `artifact://` reference — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: through the session API, a completed small low-risk change with green verification classifies `NO_SEMANTIC_REVIEW` and records zero reviewer backend invocations; the same change touching a security-sensitive path with one prior failed attempt classifies `STRONG_REVIEW` and invokes the reviewer with a strong role, even when the JEV stub answers `NO_SEMANTIC_REVIEW` — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: with two backends configured, a `/review` following an executor run on backend A records a reviewer model identity different from the executor's; with one backend configured the review still returns a verdict and records `independence: degraded` with a reason — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: `/review quick`, `/review strong`, `/review security` each return a verdict after a run the gate classified `NO_SEMANTIC_REVIEW`, and `/review diff` returns a verdict whose packet contains the diff and empty `verification_results` with no verifier execution recorded — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: with the JEV client failing every call, classification returns `QUICK_REVIEW` and the session still produces a reviewer verdict rather than an error — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Manual review, all modes | `/review [quick\|strong\|security\|diff]` → `src/commands/review.ts` (created in Phase 1) | New capability | AC-1, AC-5 |
| Reviewer verdict via session API | `session.review()` → `src/review/lane.ts` `review()` (created in Phase 1) | New capability | AC-1, AC-4 |
| Automatic review-level classification | Executor lane post-verification hook (PRD-007) → `src/review/gate.ts` `classifyReview()` (created in Phase 2) | New capability; PRD-007's FR-063 zero-model-review path consumes `NO_SEMANTIC_REVIEW` | AC-3, AC-6 |

## Execution Phases

#### Phase 1: Reviewer lane reachable through `/review`
**Status:** NOT STARTED
**ACs:** AC-1, AC-2, AC-4, AC-5
**Files:** `src/review/schema.ts` (packet/verdict types + strict parser), `src/review/packet.ts` (packet builder over contract + evidence + diff), `src/review/lane.ts` (backend selection, invocation, independence record), `src/commands/review.ts` (`/review` and its four modes), `tests/review-lane.test.ts`
**Implementation:** Define `ReviewPacket` with the seven §30 keys and `ReviewVerdict { decision, findings[] }`; parser validates every finding field and maps any violation to `ESCALATE` with a `parse_error` finding. `buildPacket()` reads the execution contract objective and ACs, `git diff` output for the candidate change, the changed-file list, `EvidenceRecord[]` from PRD-009, warnings, and the executor summary string — it takes no transcript argument, so omission is structural, not a convention. Diff over the inline bound is written to the artifact store and referenced. `review()` selects a backend by preferring a differing model identity, falls back with `independence: 'degraded'` and a reason, maps mode → `(level, prompt profile)`, and invokes PRD-008's worker. `/review` with no argument uses the gate's level when one was recorded for the turn and `QUICK_REVIEW` otherwise; explicit modes always override.
**Verification:** E1 — `npx vitest run tests/review-lane.test.ts`: drives `/review` through the command entry point against a fixture workspace with a seeded AC violation and a marker string injected into the executor transcript, asserting the `FIX_REQUIRED` verdict and fully-populated finding (AC-1), exact packet key set plus marker absence plus artifact retrievability (AC-2), differing reviewer model identity in the two-backend case and the `degraded` record in the one-backend case (AC-4), and each of the four modes returning a verdict with `diff` mode showing empty `verification_results` and no verifier call (AC-5); malformed-reviewer-output case asserts `ESCALATE`. Red control: assert the marker-absence check fails when the builder is given the transcript, proving the assertion is sensitive rather than vacuous.
**Checkpoint:** pending

#### Phase 2: JEV review gate and conservative fallback
**Status:** NOT STARTED
**ACs:** AC-3, AC-6
**Files:** `src/review/gate.ts` (`classifyReview()` with deterministic floor + JEV `Choice`), `tests/review-gate.test.ts`
**Implementation:** `classifyReview(inputs)` takes the §32 inputs (task risk, execution complexity, diff size, changed files, test coverage, failed attempts, novelty, security-sensitive paths, public-API change, proof strength). Deterministic pre-filters run first and are floors, not hints: zero changed files ⇒ `NO_SEMANTIC_REVIEW`; security-sensitive path or public-API change ⇒ minimum `QUICK_REVIEW` and the model answer may only raise it. Remaining cases ask JEV one `Choice` question over the three levels; the typed result and model version are logged through PRD-002's decision log. Any JEV error, timeout, or below-threshold confidence ⇒ `QUICK_REVIEW`. The result is attached to the turn so `/review` with no argument can reuse it.
**Verification:** E2 — `npx vitest run tests/review-gate.test.ts`: session-API run over a small green-verified low-risk change asserts `NO_SEMANTIC_REVIEW` and a zero reviewer-invocation count on the backend spy; the security-sensitive + failed-attempt case with a JEV stub answering `NO_SEMANTIC_REVIEW` asserts the floor raises it and that the reviewer is invoked with a strong role (AC-3); a JEV client throwing on every call asserts `QUICK_REVIEW` and a completed verdict (AC-6). The stub-disagreement case is itself the negative control: the gate cannot pass it by forwarding the model's answer.
**Checkpoint:** pending

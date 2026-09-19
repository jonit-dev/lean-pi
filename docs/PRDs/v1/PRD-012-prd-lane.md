# PRD-012 — PRD Lane

**Status:** NOT STARTED
**Complexity:** 5 (MEDIUM)
**Risk override:** none — 5 implementation files (1) + new module (+2) + complex persistent criterion/dependency state with reopen transitions (+2) = 5; no security boundary or schema migration, so MEDIUM stands.
**Owner:** joao
**Depends on:** PRD-004

## Context

**Covers:** FR-030, FR-031, FR-032, FR-033, FR-034, FR-035; ROADMAP §11, §11.1, §11.2, §43

The repository is greenfield: `docs/PRDs/v1/ROADMAP.md` is the only file. Every path named here is created by the phases below.

ROADMAP §11 routes a task through `PRD Creator → PRD Manager → Execution` when the planning gate returns `PRD_REQUIRED`. §11.1 requires the Creator to turn the objective plus repository evidence into problem statement, goals, non-goals, functional requirements, architecture constraints, acceptance criteria, verification requirements, dependencies and unresolved risks, favouring machine-verifiable criteria. §11.2 requires the Manager to convert the PRD into executable work units, maintain dependencies, track completed requirements and criteria, expose only the current work unit to the executor, keep references to the complete PRD outside model context, reopen requirements when verification disproves completion, and decide when the next unit may begin — "the executor SHOULD NOT need the entire PRD on every turn". §43 derives the goal from the remaining required acceptance criteria so the user never hand-writes `/goal`.

Assumed baseline from PRD-001: TypeScript on Node as a Pi extension, `npm run build | typecheck | test | lint`, vitest. Consumed interfaces: `ExecutionContract` and its `prd_required` / `required_capability` fields from PRD-004 (`src/compiler/contract.ts`), `EvidenceRecord` from PRD-009 (`src/verify/evidence.ts`), the `artifact://` store and `WorkingState` from PRD-014 (`src/context/artifacts.ts`), `ask()` from PRD-002 (`src/jev/client.ts`).

Boundaries with siblings: the `/goal` engine itself is PRD-013 — this PRD produces the goal descriptor it consumes (FR-035). Proof sufficiency for a whole task is PRD-010; this PRD decides per-PRD-criterion satisfaction. Work-unit *execution* and retry bounding are PRD-007. The model catalog behind `required_capability` is PRD-024.

## Solution

`src/prd/`, four files, adapters over installed tooling rather than a second PRD implementation:

- `src/prd/creator.ts` — loads the installed `prd-creator` skill as the authoring contract (see External Skill Dependencies) and drives one generative pass that fills the nine §11.1 sections into the repository's PRD file convention. Its only hard validation is the machine-verifiable rule: every acceptance criterion must carry a runnable verification command; a criterion without one is rejected back to the model once, then surfaced as a named gap instead of being written as prose.
- `src/prd/state.ts` — the structured criterion store (FR-033/034). One record per criterion: `{ id, text, verifyCommand, status: PENDING|VERIFIED|REOPENED|BLOCKED, evidenceRef, unitId }`, plus a per-PRD `required_capability` copied from the contract so work units route to an adequate model (PRD-024/PRD-020 consume it). Status transitions are the only writer: evidence in, status out. The PRD body itself is stored once as an `artifact://` reference and never held in model context.
- `src/prd/manager.ts` — work units, dependency gating, dispatch. `nextUnit()` returns the single ready unit whose dependencies are all `VERIFIED`; `unitContext(unitId)` returns the executor payload — unit objective, its criteria, its verification commands, the PRD artifact reference — and nothing else, so scoping is structural rather than a prompt-writing convention. `applyEvidence()` asks the requirement-status decision (below) whether the accumulated evidence satisfies a criterion, flips status, and reopens a criterion whose fresh evidence disproves it, re-queueing its unit.
- `src/prd/goal.ts` — `deriveGoal()` returns the descriptor PRD-013 consumes: the remaining required criteria and their verification commands, recomputed from `state.ts` on every read so it cannot drift.
- `src/commands/prd.ts` — `/prd create`, `/prd status`, `/prd close`. `close` delegates to the installed `prd-manager` closure helper.

Full skip (FR-032): the compiler's `prd_required=false` path never imports `src/prd/*`. The lane is reached through one lazy `await import()` inside the `PRD_REQUIRED` branch, so the quick path costs zero PRD state, zero files and zero module initialisation — and the absence is observable as a module-load counter, not a promise.

Reused, not rebuilt: the installed prd-creator/prd-manager skills and closure script, the evidence store, the artifact store, the JEV client. No PRD database, no template engine, no workflow DSL, no dependency solver beyond "all dependencies VERIFIED".

Relevant non-goals restated (§58): no unbounded autonomy — the Manager decides unit order, never approves its own completion; no correctness claims without evidence — a criterion becomes `VERIFIED` only from an `EvidenceRecord`, never from an executor assertion; no JEV requirement for basic operation — with JEV off the deterministic evidence rule governs criterion status; no generative router replacing deterministic dependency gating.

Risks: a criterion marked `VERIFIED` on stale evidence (mitigated by the freshness check in AC-5's fallback rule); executor context leaking the full PRD (AC-3); the installed skill layout changing under us (AC-1 and AC-8 both assert the degraded path).

## External Skill Dependencies

LeanPi consumes the user's already-installed skills; it does not reimplement them. Verified discovery defaults on this machine:

- **PRD authoring contract** — `/home/joao/.claude/skills/prd-creator/SKILL.md` (mirror `/home/joao/.codex/skills/prd-creator/`). This file is the source of truth for plan structure, complexity scoring, the lane model, closability budgets, the Integration Ledger and verification selection. `src/prd/creator.ts` loads it and passes it to the authoring model; LeanPi keeps no inline copy of those rules.
- **PRD management + closure** — `/home/joao/.claude/skills/prd-manager/SKILL.md` and `/home/joao/.claude/skills/prd-manager/scripts/` (closure helper `prd-close.mjs`). `/prd close` invokes the installed `prd-close.mjs` with the PRD path rather than reimplementing status reconciliation and the move to `done/`.
- **Phase execution conventions** — `/home/joao/.claude/skills/prd-executor/SKILL.md`, read by the Manager when composing a work unit so unit shape matches what the executor lane (PRD-007) expects.

Resolution order is configurable (`config.skillRoots`, default: project-local `.claude/skills` and `.codex/skills` → `/home/joao/.claude/skills` → `/home/joao/.codex/skills` → plugin dirs under `/home/joao/.claude/plugins/cache/*/*/<version>/skills/`), resolved through PRD-005's registry where available. Shipped code in `src/prd/` contains no hard-coded absolute path; the paths above are defaults, and every load has a named degraded path (built-in minimal contract for authoring, internal status-write + `git mv` for closure) that is recorded, not silent.

## JEV Decision Sites

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| PRD requirement status, scoped to one criterion (site id `prd.criterion_satisfied`) | "Criterion X states <text>. The collected evidence is <evidence records>. Does this evidence satisfy the criterion?" — asked once per criterion, never batched, so one weak answer cannot carry a sibling | Choice (`SATISFIED` \| `NOT_SATISFIED` \| `INSUFFICIENT_EVIDENCE`) | Criterion is `VERIFIED` only when its own `verifyCommand` has a fresh passing `EvidenceRecord` for the current workspace hash; anything else stays `PENDING`. The fallback can never mark a criterion satisfied more liberally than JEV | ★★★★★ |

Registered in PRD-002's decision-site registry at module load with id `prd.criterion_satisfied`, question set, return type, confidence threshold, the fallback above and telemetry tag `prd.criterion_satisfied`. This site pairs with PRD-010's whole-task proof gate but is scoped per PRD criterion and never overrides it. AC-5 asserts the decision changes observable behavior (status flip and next-unit dispatch) and that the deterministic fallback still progresses the session with JEV disabled.

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: `/prd create "<objective>"` in a fixture repo writes a PRD file containing all nine §11.1 sections where every acceptance criterion carries a runnable verification command; an authoring response with a command-less criterion is rejected and reported as a named gap rather than written; with `config.skillRoots` pointing at a missing directory the command still produces a PRD and records `skill_source: builtin-fallback` — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: `/prd status` after evidence for one criterion shows that criterion `VERIFIED` while its siblings remain `PENDING`, with per-criterion evidence references — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: during PRD execution, the executor context payload for a turn contains the current work unit's objective, criteria and verification commands plus the PRD `artifact://` reference, and contains no text unique to any other work unit and no PRD section body (seeded marker strings in other units and in the PRD body are absent); the full PRD is still retrievable through the artifact reference — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: a work unit whose dependency is unverified is never dispatched (`nextUnit()` returns the dependency's unit); after the dependency's criterion is verified the dependent unit is dispatched next, and its dispatched context carries the PRD's `required_capability` value — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: with JEV enabled, a `SATISFIED` answer for criterion X flips it to `VERIFIED` and dispatches the next unit while an `INSUFFICIENT_EVIDENCE` answer leaves it `PENDING` and re-dispatches the same unit; with JEV disabled the same session marks X `VERIFIED` only when a fresh passing evidence record exists for its `verifyCommand` and otherwise leaves it `PENDING`, and execution continues either way — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: submitting a failing `EvidenceRecord` for a criterion previously `VERIFIED` moves it to `REOPENED` in `/prd status` and re-queues its work unit as the next dispatch — Evidence: pending.
- [ ] AC-7 [local; actor: agent]: a task the compiler marks `prd_required=false` completes with no PRD state created (no criterion store, no PRD artifact) and with the `src/prd/*` module-load counter at zero for the whole session — Evidence: pending.
- [ ] AC-8 [local; actor: agent]: `/prd close` on a PRD whose required criteria are all `VERIFIED` invokes the installed `prd-manager` helper `prd-close.mjs` with the PRD path (observed invocation, not a literal success flag) and the PRD ends up at the repository's `done/` location; with the helper path absent the command performs the internal status write plus move and records the degradation instead of reporting success silently — Evidence: pending.
- [ ] AC-9 [local; actor: agent]: after PRD creation, `deriveGoal()` through the session API returns exactly the remaining required criteria and their verification commands, and drops a criterion from the list once it is `VERIFIED`, with no manual `/goal` input — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| PRD authoring | `/prd create` → `src/commands/prd.ts` → `src/prd/creator.ts` (created in Phase 1), authoring contract loaded from the installed `prd-creator` skill | New capability; delegates rules to the installed skill rather than copying them | AC-1 |
| Per-criterion status surface | `/prd status` → `src/prd/state.ts` (created in Phase 2) | New capability | AC-2, AC-6 |
| Scoped work-unit context for the executor | Executor turn assembly (PRD-007) → `src/prd/manager.ts` `unitContext()` (created in Phase 3) | New capability; the only path by which PRD content reaches a model context | AC-3, AC-4 |
| Derived goal descriptor | `/goal` engine (PRD-013) → `src/prd/goal.ts` `deriveGoal()` (created in Phase 3) | New capability; replaces manual goal authoring for PRD tasks | AC-9 |
| Quick-path skip | Compiler `prd_required=false` branch (PRD-004) → no `src/prd/*` import (enforced in Phase 4) | Disposition: PRD machinery absent, not merely unused | AC-7 |
| PRD closure | `/prd close` → installed `/home/joao/.claude/skills/prd-manager/scripts/prd-close.mjs` (wired in Phase 4) | Replaces writing a parallel closure implementation | AC-8 |

## Execution Phases

#### Phase 1: PRD Creator over the installed authoring skill
**Status:** NOT STARTED
**ACs:** AC-1
**Files:** `src/prd/creator.ts` (skill load, authoring pass, machine-verifiable validation), `src/commands/prd.ts` (`/prd create` subcommand), `tests/prd-creator.test.ts`
**Implementation:** Resolve the authoring contract through `config.skillRoots` (default order in External Skill Dependencies) and read `prd-creator/SKILL.md`; on resolution failure fall back to a built-in minimal contract covering only the nine §11.1 sections and record `skill_source`. Run one authoring pass, then validate: all nine sections present, ≥1 acceptance criterion, every criterion carrying a runnable verification command. One targeted re-ask for command-less criteria, then report the remaining gap by criterion id and refuse to write it as prose. Write the file under the repository's PRD convention without overwriting an existing id.
**Verification:** E1 — `npx vitest run tests/prd-creator.test.ts`: drives `/prd create` through the command entry point in a temp fixture repo with a stubbed authoring model; asserts the nine sections and per-criterion verification commands in the written file, that a stubbed command-less criterion produces a named gap and no written prose criterion, and that a missing `skillRoots` directory still yields a PRD with `skill_source: builtin-fallback` (AC-1). Negative control: assert the skill-load path actually read the resolved file (contract content observable in the model request), so the fallback case is distinguishable from the primary case.
**Checkpoint:** pending

#### Phase 2: Criterion store, satisfaction decision, reopen
**Status:** NOT STARTED
**ACs:** AC-2, AC-5, AC-6
**Files:** `src/prd/state.ts` (criterion records, `required_capability`, transitions), `src/prd/manager.ts` (`applyEvidence()` and the JEV site registration), `src/commands/prd.ts` (`/prd status`), `tests/prd-state.test.ts`
**Implementation:** Criterion records as described in Solution; the PRD body is written once to the artifact store and only its reference is retained. `applyEvidence(criterionId, records)` registers and asks the `prd.criterion_satisfied` site (one question per criterion) and maps `SATISFIED` → `VERIFIED`, `NOT_SATISFIED`/`INSUFFICIENT_EVIDENCE` → `PENDING` with the reason. With JEV disabled or below threshold, the deterministic rule governs: `VERIFIED` only on a fresh passing `EvidenceRecord` matching the criterion's `verifyCommand` and the current workspace hash. A failing record for a `VERIFIED` criterion sets `REOPENED` and marks its unit re-queueable. `/prd status` renders id, status, and evidence reference per criterion.
**Verification:** E2 — `npx vitest run tests/prd-state.test.ts`: asserts independent per-criterion status in `/prd status` output (AC-2); with a JEV stub, `SATISFIED` vs `INSUFFICIENT_EVIDENCE` producing different observable dispatch outcomes, and with JEV disabled the freshness rule allowing `VERIFIED` only on a matching fresh passing record while the session still progresses (AC-5); and the failing-record path flipping `VERIFIED` → `REOPENED` with the unit re-queued (AC-6). Negative control: a stale-workspace-hash passing record must leave the criterion `PENDING` — this is the assertion that would pass with the freshness check absent.
**Checkpoint:** pending

#### Phase 3: Work units, dependency gating, scoped context, derived goal
**Status:** NOT STARTED
**ACs:** AC-3, AC-4, AC-9
**Files:** `src/prd/manager.ts` (work-unit derivation, `nextUnit()`, `unitContext()`), `src/prd/goal.ts` (`deriveGoal()`), `tests/prd-manager.test.ts`
**Implementation:** Derive work units from the PRD's phases/criteria and read `prd-executor/SKILL.md` for unit shape. `nextUnit()` returns the single ready unit — all dependency units' required criteria `VERIFIED` — preferring a re-queued `REOPENED` unit. `unitContext()` builds the executor payload from the unit's own fields plus the PRD artifact reference and the PRD-level `required_capability`; it has no parameter through which the PRD body or a sibling unit could be passed. `deriveGoal()` recomputes the remaining-required-criteria list from `state.ts` per call.
**Verification:** E3 — `npx vitest run tests/prd-manager.test.ts`: fixture PRD with three units, marker strings seeded in sibling units and in the PRD body; asserts the dispatched context contains the current unit's fields and the artifact reference and none of the markers, while the artifact reference still resolves to the full PRD (AC-3); asserts an unverified dependency blocks dispatch, that verifying it makes the dependent unit next, and that the dispatched context carries `required_capability` (AC-4); asserts `deriveGoal()` lists exactly the remaining required criteria and shrinks when one is verified (AC-9). Negative control: the marker-absence assertion is shown to fail when `unitContext()` is fed the whole PRD, proving it is sensitive.
**Checkpoint:** pending

#### Phase 4: Quick-path skip and closure through the installed helper
**Status:** NOT STARTED
**ACs:** AC-7, AC-8
**Files:** `src/prd/manager.ts` (lazy entry point), `src/commands/prd.ts` (`/prd close`), `tests/prd-skip-close.test.ts`
**Implementation:** Reach the lane only through one `await import('./prd/manager.js')` inside the compiler's `PRD_REQUIRED` branch, with an instrumentable module-load counter, so `prd_required=false` initialises nothing. `/prd close` verifies all required criteria are `VERIFIED`, then spawns the resolved `prd-manager` closure helper (`scripts/prd-close.mjs <prd-path> --yes`) and reports its result; a helper rejection is reported as a rejection, never bypassed. When no helper resolves under the configured roots, perform the internal status reconciliation plus move to the repository's `done/` location and record `closure_source: builtin-fallback`.
**Verification:** E4 — `npx vitest run tests/prd-skip-close.test.ts`: a `prd_required=false` session asserts zero PRD state artifacts and a zero module-load counter for `src/prd/*` (AC-7); a fully-verified fixture PRD asserts the closure helper process was actually invoked with the PRD path and that the file is gone from its old path and present under `done/`, and with the helper path removed asserts the internal fallback performs the move and records the degradation (AC-8). Negative control: with the helper stubbed to reject, `/prd close` must report failure and leave the PRD in place — the assertion that fails if the command reports a literal success.
**Checkpoint:** pending

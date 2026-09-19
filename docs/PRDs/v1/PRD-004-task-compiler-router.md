# PRD-004 — Task Compiler & Router

**Status:** NOT STARTED
**Complexity:** 4 (MEDIUM)
**Owner:** joao
**Depends on:** PRD-002, PRD-003

Risk override: none. No security boundary, no data migration, no external credential. The routing decisions are recoverable per task and every JEV site has a deterministic fallback.

## Context

**Covers:** FR-003, FR-004, FR-005, FR-006, FR-012, FR-013; ROADMAP §8, §10, §12, §13, §14, §49, §50, §62–§64, §65.

ROADMAP §8 requires that every substantive task is compiled into an internal execution contract *before* substantial generative work begins, and states the constraint that makes LeanPi cheap: **JEV SHALL NOT generate this whole object directly** — individual atomic JEV decisions are composed into the contract by ordinary application code. §10 defines the first semantic decision (does this task need a PRD?) as a set of atomic signals rather than one "is this complex?" prompt, with the low-confidence defaults in §10 and the asymmetric confidence rule in §50. §12 and §13 make execution complexity (LOW/MEDIUM/HIGH, internally E0–E3) and review risk (R0–R3) *independent* axes — "this separation is mandatory" — and §14 gives the default routing matrix plus the inputs on which the router may deviate. §65 restates the whole thing as the central decision policy, and §62–§64 give three worked tasks with their expected routes.

This PRD is the junction of the architecture in §7: scout packet in, execution contract out, everything downstream (capability disclosure, executor lane, verification, proof gate, review gate) reads the contract rather than re-deriving the task.

Repository state inspected: `/home/joao/projects/lean-pi` contains only `docs/PRDs/v1/ROADMAP.md`. PRD-001 establishes the TypeScript/Node Pi extension skeleton, `src/core/types.ts` (`ModelRole`, `BackendRef`, `LeanPiConfig`), `src/commands/session.ts` `runTurn()`, npm scripts and vitest. PRD-002 establishes `src/jev/client.ts` with `ask(siteId, questions, state)` — the site id is the first positional argument and is looked up in the decision-site registry before anything is serialized — returning typed Choice/Score/Noul results, plus the registry itself, whose row carries `consequence` (`low|normal|high`) rather than a numeric threshold. PRD-003 establishes `scoutTask()` and `TaskPacket`. Every path named below is created by this PRD's phases.

## Solution

Six small modules under `src/compiler/`, composed by one public function `compileTask(request, packet, deviations?) → ExecutionContract` in `src/compiler/index.ts`, re-exported from the package entry `src/index.ts`. That three-argument form in that module is the single compile entry point; no other module exposes a second one.

Consumer flow: user submits a task in a LeanPi session → session bootstrap runs `scoutTask()` (PRD-003) → `compileTask()` asks the atomic JEV questions, combines the answers in code, and returns the contract → the contract is what the executor, verifier and reviewer lanes consume, and what `/route` (PRD-016) prints back to the user. The observable result of this PRD is the compiled contract for a given task.

- `src/compiler/contract.ts` — the `ExecutionContract` type, exactly the §8 shape (`task`, `routing`, `reasoning`, `capabilities`, `context`, `verification`, `limits`) plus `task.required_capability` and `routing.deviation`. Owned here; every other PRD imports it.
- `src/compiler/gate.ts` — the §10 planning gate: the six atomic questions, combination in code into `PRD_REQUIRED | DIRECT_EXECUTION | UNCERTAIN`, and the §10/§50 low-confidence resolution (a low-risk bounded task resolves to direct execution with review risk raised one level; a high-risk or architectural task resolves to PRD creation).
- `src/compiler/classify.ts` — execution complexity (`LOW|MEDIUM|HIGH`, internal `E0..E3`) and review risk (`R0..R3`) computed from **separate** question sets, never one from the other. The cross cases in §13 (mechanical codemod = LOW execution / high review risk; well-tested hard algorithm = HIGH execution / R0) are the test fixtures that prove the axes did not collapse.
- `src/compiler/route.ts` — the §14 matrix as a literal table keyed by `(prd_required, execution_complexity)` — the resolved six rows below, one class per cell, not the ROADMAP's alternatives — plus the deviation step that takes the §14 deviation inputs (model availability, subscription availability, quota reserves, historical task performance, language specialization, latency, current backend failures) and records `routing.deviation = { from, to, reason }` whenever it departs from the matrix default. A deviation that is not recorded is a bug: the user must be able to see why they did not get the default.
- `src/compiler/state.ts` — FR-004: four separate containers, `PlanningState`, `ExecutionState`, `VerificationState`, `ReviewState`, held in one `TaskState` record. Separation is enforced by construction (each container is only reachable through its own accessor and the contract snapshot is frozen), not by convention, so an executor retry cannot silently rewrite the planning record the proof gate will later be judged against.
- `src/compiler/index.ts` — `compileTask`, the composition point. Every JEV answer that enters it is a scalar, enum or score; the object is assembled here in ordinary code.

**The resolved §14 matrix.** `route.ts` holds exactly these six rows as data. ROADMAP §14 offers alternatives in three cells ("Quick or Balanced", "Balanced/Strong", "None if deterministic proof is sufficient"); this PRD resolves each to one value so the table is comparable against an assertion:

| `prd_required` | `execution_complexity` | `routing.executor_class` | `routing.reviewer_class` |
|---|---|---|---|
| false | LOW | `quick` | `none` when `review_risk === R0`, otherwise the R-band reviewer |
| false | MEDIUM | `balanced` | `review_quick` |
| false | HIGH | `strong` | `review_strong` |
| true | LOW | `quick` | `review_quick` |
| true | MEDIUM | `balanced` | `review_strong` |
| true | HIGH | `strong` | `review_strong` |

The R-band reviewer mapping used by the first row (and by PRD-011 when it selects the concrete reviewer) is fixed here too: `R0 → none`, `R1`/`R2` → `review_quick`, `R3` → `review_strong`. The first row is the only cell where the reviewer depends on the review-risk axis rather than on complexity, which is exactly §13's point: a LOW-complexity change with wide blast radius still gets a reviewer.

`task.required_capability` is `{ min_coding_index: number, specialization?: string }` — a numeric floor, never a tier enum — produced by the capability classifier and carried on the contract as a **routing annotation**. PRD-024 compares `min_coding_index` against its catalog's `coding_score` to pick a concrete model; this PRD neither fetches nor caches any ranking and names no model. The same annotation shape appears on PRD-012's PRD work unit. It is never a field inside the executor task packet — PRD-007's six-field §28 whitelist is unchanged by this PRD. Likewise `routing.executor_backend` is emitted as the logical class plus `'unresolved'`, and the backend registry (PRD-008) resolves it against its `type: native | external_harness` entries.

Capability slots are declared, not filled: `capabilities { skills: [], mcps: [], lsp, rtk }` with a `CapabilityProvider` interface that PRD-005 (skills), PRD-006 (MCP), PRD-018 (LSP) and PRD-019 (RTK) register against. With no provider registered, `skills` and `mcps` are empty, `lsp` mirrors the scout's `lsp_available`, `rtk` is `auto`. This PRD implements no capability routing — one interface, four future implementations already named, no speculative abstraction beyond it.

JEV-off behaviour is first-class, not a degraded mode (§49, and non-goal "no JEV requirement for basic operation"): with the client unavailable the gate falls back to deterministic heuristics, complexity falls back to conservative MEDIUM/balanced, and review risk falls back to its **own** deterministic signals — never to a function of the complexity band, because §13's separation is mandatory and must hold with JEV off exactly as it holds with JEV on. Those signals, all readable from the scout packet and the request without any complexity input, are: (a) does the change touch an externally visible surface (public API, CLI, wire format, config schema, migration, UI); (b) is the blast radius wide relative to the tested surface (breadth of `changed_files`/`likely_modules` against detected `test_runners` and changed test files); (c) is deterministic verification sufficient for this change class (a runner exists and the change is confined to a covered module). Zero signals → `R0`; one → `R1`; two → `R2`; three, or any migration/security marker, → `R3`; the gate's `elevate_review` flag raises the result one level. Compilation still returns a usable contract with `fallback_used` flags per site for telemetry (PRD-015) and for `/route` (PRD-016).

Relevant non-goals restated from §58: **no generative router replacing JEV** — no free-form prompt produces the contract; the router is a table and the JEV answers are atomic. No unbounded autonomy — `limits.execution_attempts` and `limits.semantic_review_rounds` are always set. No correctness claims without evidence — the compiler emits the required verification set, it never asserts a task is done. No default multi-agent swarms — the contract routes one executor.

Risks: (1) axis collapse, where review risk silently becomes a function of complexity — covered by AC-4's cross cases; (2) contract drift from §8 — the contract type mirrors the §8 keys and AC-9 compiles the three worked examples; (3) a JEV question broad enough to be a generative prompt in disguise — covered by AC-7, which asserts every recorded question's answer is a scalar/enum/score.

## External Skill Dependencies

The compiler loads no skill itself, but its `PRD_REQUIRED` outcome is a handoff into the installed PRD tooling, which PRD-012 adapts:

| Skill / plugin | Verified path | How this PRD relates |
|---|---|---|
| prd-creator | `/home/joao/.claude/skills/prd-creator/SKILL.md` (mirror `/home/joao/.codex/skills/prd-creator/`) | Target of the `PRD_REQUIRED` branch. The gate's output is the trigger; the adapter that loads this SKILL.md as the authoring contract is PRD-012's. This PRD asserts only that the branch dispatches to the PRD lane. |
| prd-manager | `/home/joao/.claude/skills/prd-manager/SKILL.md` + `/home/joao/.claude/skills/prd-manager/scripts/` | Consumer of the compiled contract for PRD-derived work units (PRD-012). Not invoked here. |

Skill discovery itself (global roots `/home/joao/.claude/skills`, `/home/joao/.codex/skills`, plugin dirs, project-local) is PRD-005's registry; the compiler only exposes the empty `capabilities.skills` slot it fills. Paths above are the default discovery order, configurable — no absolute path is hard-coded in product code.

## JEV Decision Sites

All four sites register in PRD-002's decision-site registry with id, question set, return type, `consequence` class, fallback and telemetry tag — numeric thresholds are `src/jev/confidence.ts`'s, never a registry field.

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| `gate.prd_required` — does this task need a PRD before implementation (§10) | Requires choosing or changing architecture? / Alters multiple externally visible behaviors? / Materially ambiguous requirements? / Multiple dependent implementation stages? / Would acceptance criteria materially reduce execution risk? / Is this a localized fix with a clear expected result? | Choice (per question) + Score (confidence) | Heuristics over the scout packet and request: multi-module change surface or architectural verbs → `PRD_REQUIRED`; single-module, explicit expected result → `DIRECT_EXECUTION`; otherwise `PRD_REQUIRED` on high-risk work per §50 | ★★★★★ |
| `classify.execution_complexity` — E0–E3 → LOW/MEDIUM/HIGH (§12) | Mechanical/rename-scale edit? / Expected result explicit? / Spans several modules? / Subsystem unfamiliar or highly coupled? / Concurrency, compiler/runtime or performance-critical? | Choice + Score | Conservative `MEDIUM` / balanced executor (§49) | ★★★★★ |
| `classify.required_capability` — the numeric coding-index floor and specialization the task needs | Does correctness here depend on domain specialization (language/runtime/native)? / What minimum coding capability is sufficient? | Choice (specialization tag) + Score (index floor) | `min_coding_index` floor derived from the complexity band; specialization from the scout's detected dominant language | ★★★★★ |
| `classify.review_risk_input` — R0–R3 inputs (§13); the reviewer *selection* gate is PRD-011's | Is deterministic verification sufficient for this change class? / Does the change alter externally visible behavior? / Is the blast radius wide relative to the tested surface? | Choice + Score | The same three signals computed deterministically from the scout packet and request (externally visible surface, blast radius vs tested surface, deterministic-verification sufficiency), counted into R0–R3 and raised one level by the gate's `elevate_review` flag. **The complexity band is not an input** — it is not passed to the fallback any more than to the JEV path | ★★★★★ |

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: `compileTask()` called through the package entry on the §62 fixture ("change the button text from Deploy to Publish") yields `prd_required: false`, and on the §64 fixture ("replace the networking implementation while maintaining compatibility") yields `prd_required: true` with the PRD lane as the dispatched next stage — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: With JEV answers rejected by `accept()` for their registered `consequence` class, a low-risk bounded fixture task compiles to `prd_required: false` with `review_risk` one level above the deterministic review-risk result for the same packet, while an architectural fixture task compiles to `prd_required: true` (§10 low-confidence behavior, §50 asymmetry) — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: With the JEV client unavailable (constructor throws on `ask`), `compileTask()` still returns a complete contract — gate resolved by heuristics, `execution_complexity: MEDIUM`, executor `balanced` — with `fallback_used: true` recorded for each of the four sites, and no exception reaches the caller (§49) — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: The mechanical-codemod fixture compiles to `execution_complexity: LOW` (E0) with `review_risk: R2` or higher, and the exhaustively-tested-algorithm fixture compiles to `execution_complexity: HIGH` (E3) with `review_risk: R0`, proving the axes vary independently (§13). The same two fixtures are then compiled with the JEV client throwing on every `ask()`, and the axes still diverge — LOW with `review_risk >= R2` and HIGH with `R0` — so the deterministic fallback cannot be a function of the complexity band either — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: For all six `(prd_required × complexity)` combinations, the compiled contract's `routing.executor_class` and `routing.reviewer_class` equal the resolved six-row table in §Solution cell for cell, with no deviation inputs supplied; the `false/LOW` row is asserted twice — once with `review_risk: R0` expecting `none` and once with `R2` expecting `review_quick` — so the one risk-dependent cell is proved rather than assumed — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: Supplying a deviation input (the matrix-default executor class marked unavailable) compiles to a different `executor_class` than the matrix default and records `routing.deviation` naming the departed-from default and the reason; with no deviation input the field is absent — Evidence: pending.
- [ ] AC-7 [local; actor: agent]: The recorded JEV transcript for one full compile contains only atomic questions — every answer is a scalar, enum or score, no answer carries a contract-shaped object, and the number of distinct question ids matches the four registered sites (§8: JEV never generates the contract) — Evidence: pending.
- [ ] AC-8 [local; actor: agent]: After a compile, mutating `ExecutionState` (recording an attempt) leaves `PlanningState`, `VerificationState` and `ReviewState` byte-identical, and an attempt to write the contract snapshot throws rather than mutating it (FR-004) — Evidence: pending.
- [ ] AC-9 [local; actor: agent]: The three worked examples compile end-to-end to their documented routes: §62 → quick executor, no skills, no MCP, no semantic review; §63 → balanced executor, debugging skill slot requested, quick reviewer; §64 → PRD lane then strong executor, strong independent reviewer, staged verification (§62–§64, §65). The `lsp` field is deliberately not asserted here — AC-10 already pins it to the scout packet's `lsp_available`, and LSP policy belongs to PRD-018 — Evidence: pending.
- [ ] AC-10 [local; actor: agent]: With no capability provider registered, the contract's `capabilities` are `skills: []`, `mcps: []`, `lsp` equal to the scout packet's `lsp_available`, `rtk: auto`; registering a stub provider that returns one skill and one MCP makes both appear in the next compiled contract unchanged, proving the slot interface is consumed and not bypassed — Evidence: pending.
- [ ] AC-11 [local; actor: agent]: Each compiled contract carries `task.required_capability` as `{ min_coding_index: <number>, specialization?: <string> }` derived from the classifier — the §62 fixture's `min_coding_index` strictly below the §64 fixture's — the value is a number and not a tier enum, and the compiler resolves no concrete model (the field stays an annotation PRD-024 compares against its `coding_score`). The executor task packet built from the same contract carries no `required_capability` field at all, keeping PRD-007's §28 whitelist intact — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Task compilation into the §8 execution contract | LeanPi session bootstrap → `compileTask(request, packet)` re-exported from the package entry `src/index.ts` (wired in Phase 3); printed to the user by `/route` in PRD-016 | New capability — replaces implicit, per-turn model improvisation of scope and model choice | AC-5, AC-9 |
| Planning gate decision (FR-012) | Same entry; `PRD_REQUIRED` dispatches to the PRD lane adapter in PRD-012, `DIRECT_EXECUTION` to the executor lane in PRD-007 | Replaces a single broad "is this complex?" prompt with six atomic questions combined in code | AC-1, AC-2 |
| Separated task state containers (FR-004) | `TaskState` from `src/compiler/state.ts` (Phase 3), consumed by the executor lane (PRD-007), verifier (PRD-009) and reviewer (PRD-011) | New — replaces one mutable task blob | AC-8 |
| Capability slots | `ExecutionContract.capabilities` + `CapabilityProvider` registered by PRD-005/006/018/019 (interface only, Phase 4) | New interface; no capability routing implemented here | AC-10 |
| `required_capability` annotation | Same contract field and PRD-012's work unit, consumed by PRD-024's ranking (`min_coding_index` vs `coding_score`) and PRD-020's quota-aware preference | New — replaces hand-picked model classes; deliberately absent from the executor task packet | AC-11 |

## Execution Phases

#### Phase 1: Planning gate decides PRD vs direct execution

**Status:** NOT STARTED
**ACs:** AC-1, AC-2, AC-3
**Files:**
- `src/compiler/gate.ts` (new) — the six §10 questions, code-side combination, low-confidence resolution, deterministic heuristics.
- `src/compiler/contract.ts` (new, partial) — `PlanningDecision` and the `task` block of `ExecutionContract`.
- `tests/compiler/gate.spec.ts` (new) — §62/§64 fixtures, low-confidence fixtures, JEV-off fixture.

**Implementation:**
1. Register `gate.prd_required` in PRD-002's decision-site registry with its question set, `consequence` class, fallback and telemetry tag — the registry row carries the class, never a numeric threshold (those live in `src/jev/confidence.ts`).
2. Ask the six §10 questions in one `ask('gate.prd_required', questions, state)` batch — site id first, scout packet as state. Combine in code: any of {architecture change, multiple externally visible behaviors, multiple dependent stages} above threshold → `PRD_REQUIRED`; localized-with-clear-result above threshold and none of the former → `DIRECT_EXECUTION`; otherwise `UNCERTAIN`.
3. Resolve `UNCERTAIN` per §10/§50: low-risk bounded → `DIRECT_EXECUTION` with an `elevate_review` flag consumed by the risk classifier; high-risk or architectural → `PRD_REQUIRED`. Thresholds live in `LeanPiConfig` so §10's calibration-from-real-data requirement has somewhere to land; they are not hardcoded literals in the branch.
4. JEV unavailable or `ask()` throwing → heuristics over the scout packet (change surface breadth, architectural verbs in the request, ambiguity markers), `fallback_used: true`, no rethrow.
5. Error handling: a malformed/partial answer set is treated as low confidence, never as a `false`.

**Verification:** E1 — `npx vitest run tests/compiler/gate.spec.ts`; asserts the §62 and §64 fixtures reach their documented gate outcomes with a scripted JEV stub (AC-1), that below-threshold answers produce the two asymmetric defaults (AC-2), and that a throwing client still yields a decision with `fallback_used` (AC-3). Distinct risks: wrong decision, wrong low-confidence direction, and hard dependence on JEV. Negative control: the fixtures are written before `gate.ts` exists, so the first run reds on missing behavior; additionally the JEV-off case asserts the heuristic path ran by checking the `fallback_used` flag rather than only a non-throw.
**Checkpoint:** pending

#### Phase 2: Independent complexity and review-risk classification

**Status:** NOT STARTED
**ACs:** AC-4, AC-11
**Files:**
- `src/compiler/classify.ts` (new) — `classifyExecution` (E0–E3 → LOW/MEDIUM/HIGH), `classifyReviewRisk` (R0–R3), `deriveRequiredCapability`.
- `src/compiler/contract.ts` (edited) — `execution_complexity`, `review_risk`, `required_capability` fields.
- `tests/compiler/classify.spec.ts` (new) — the two §13 cross-case fixtures plus capability-tier fixtures.

**Implementation:**
1. Register `classify.execution_complexity`, `classify.required_capability` and `classify.review_risk_input` as three distinct sites; each has its own question set and its own fallback.
2. `classifyExecution` maps answers to E0–E3 using the §12 examples as the calibration anchors, then to LOW/MEDIUM/HIGH. `classifyReviewRisk` takes its own answers plus the gate's `elevate_review` flag; it must not read the complexity result as an input — the function signature does not receive it, which is the cheapest structural guarantee that §13's mandatory separation holds.
3. `deriveRequiredCapability` returns `{ min_coding_index: number, specialization?: string }` from the capability-need answers, with the numeric floor derived from the complexity band when JEV is off and specialization defaulting to the scout's dominant language. No catalog lookup, no model name, no tier enum.
4. Fallbacks: complexity → MEDIUM. Review risk → the three deterministic signals in §Solution counted into R0–R3, raised one level by `elevate_review`; `classifyReviewRisk(answersOrNull, packet, request, elevateReview)` receives neither the complexity result nor the complexity band on either path, so the structural guarantee in step 2 holds with JEV off as well as on.

**Verification:** E2 — `npx vitest run tests/compiler/classify.spec.ts`; the mechanical-codemod fixture asserts `LOW`/`E0` with `review_risk >= R2` and the tested-algorithm fixture asserts `HIGH`/`E3` with `R0` (AC-4) — a collapsed implementation that derives risk from complexity cannot satisfy both — and both fixtures are re-run with a throwing JEV client asserting the same divergence, which is the control that catches a complexity-derived *fallback* (the JEV-on cases alone cannot see it). Capability fixtures assert the §62 task's `min_coding_index` is strictly below the §64 task's, that the value is a number, and that no model id appears on the contract (AC-11). Covers the axis-collapse, fallback-collapse and scope-creep-into-PRD-024 risks that E1 cannot see.
**Checkpoint:** pending

#### Phase 3: Routing matrix, contract assembly, and separated state

**Status:** NOT STARTED
**ACs:** AC-5, AC-6, AC-7, AC-8
**Files:**
- `src/compiler/route.ts` (new) — the §14 matrix table, deviation application, `routing.deviation` record, and `selectRoute(contract, candidates)` — the single selection entry point PRD-020 edits in every phase rather than the router being replaced.
- `src/compiler/state.ts` (new) — `PlanningState`, `ExecutionState`, `VerificationState`, `ReviewState`, `TaskState`.
- `src/compiler/index.ts` (new) — `compileTask` composition, contract freeze, per-site telemetry rows.
- `src/index.ts` (edited) — re-export `compileTask`, `ExecutionContract`, `TaskState`.
- `tests/compiler/route.spec.ts`, `tests/compiler/state.spec.ts` (new).

**Implementation:**
1. `route.ts` holds the resolved six rows from §Solution as data, not branches, including the `R0 → none`, `R1`/`R2` → `review_quick`, `R3` → `review_strong` band mapping the `false/LOW` cell consults. `applyDeviations(defaults, inputs)` consumes the §14 deviation inputs and returns the chosen classes plus a `deviation` record `{ from, to, reason }`; with an empty input set it returns the defaults and no record.
2. `compileTask` composes: scout packet + gate + classifiers + route + capability slots + `context` strategy/budget + `verification.required` + `limits`. `reasoning.effort` and the budgets follow the complexity band (§8's example values are the LOW row). The assembled contract is deep-frozen before return.
3. Telemetry: each site contributes a row `{ site_id, answer, confidence, fallback_used, tokens }` on the compile record, which is the shape PRD-015 aggregates and PRD-016 prints. This PRD emits the rows; it does not build the telemetry store.
4. `state.ts`: `TaskState` exposes the four containers through separate accessors, each returning its own frozen snapshot on read and mutating only its own slice on write. No shared mutable object graph between lanes.
5. Error handling: an unknown deviation input is recorded and ignored rather than failing the compile — routing must always produce a contract.

**Verification:** E3 — `npx vitest run tests/compiler/route.spec.ts tests/compiler/state.spec.ts`; a table-driven case per resolved §Solution row asserting executor and reviewer classes, with the `false/LOW` row run twice at `review_risk: R0` and `R2` to prove the risk-dependent reviewer cell (AC-5); a deviation case asserting both the changed class and the recorded reason, plus the no-deviation case asserting the field is absent (AC-6); a transcript assertion over the recording JEV stub that every answer is a scalar/enum/score and that the distinct question-id count equals the four registered sites (AC-7); and a state case mutating `ExecutionState` then comparing serialized snapshots of the other three plus asserting the frozen contract throws on write (AC-8). Distinct risks: wrong defaults, an unresolved alternative cell passing on either value, invisible deviations, a broad prompt sneaking back in, and cross-lane state bleed. Negative control: the table cases are written from the §Solution table before `route.ts` exists, so a missing row reds rather than defaulting.
**Checkpoint:** pending

#### Phase 4: Worked examples compile to their documented routes

**Status:** NOT STARTED
**ACs:** AC-9, AC-10
**Files:**
- `src/compiler/contract.ts` (edited) — `CapabilityProvider` interface and default empty slots.
- `src/compiler/index.ts` (edited) — provider registration point.
- `tests/compiler/examples.spec.ts` (new) — the §62/§63/§64 fixtures as end-to-end acceptance, plus the stub-provider case.

**Implementation:**
1. `CapabilityProvider = { kind: 'skills'|'mcps'|'lsp'|'rtk', supply(contractDraft, packet) => slotValue }`. One interface, four named future implementations (PRD-005/006/018/019) — nothing else abstracted.
2. Default slot values with no provider: `skills: []`, `mcps: []`, `lsp: packet.workspace.lsp_available`, `rtk: 'auto'`.
3. Fixtures: each worked example is a scout packet plus a request plus the scripted atomic answers implied by §62–§64; the expected contract is written from the ROADMAP's documented route (executor class, capability flags, reviewer, verification set, limits). These become the regression fixtures every later routing change is measured against.
4. §63's "debugging skill" expectation is asserted as a *requested* skill slot, since resolution belongs to PRD-005 — the fixture asserts the slot is requested and left to the provider, not that a skill was loaded.

**Verification:** E4 — `npx vitest run tests/compiler/examples.spec.ts`; each of the three examples compiles through the public `compileTask` entry and is compared field-by-field against its documented route (AC-9); the capability case asserts the empty-slot defaults and then, with one stub provider registered, that the supplied skill and MCP appear unchanged in the next compiled contract (AC-10). One real-entry-point run covers behavior, wiring and regression for the whole compiler, so no separate demo or CLI check is added. Negative control: the stub-provider case is first run with the provider unregistered and must fail the "skill appears" assertion, proving the slot is actually consumed rather than populated elsewhere.
**Checkpoint:** pending

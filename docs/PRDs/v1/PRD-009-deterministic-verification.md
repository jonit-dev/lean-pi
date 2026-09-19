# PRD-009 — Deterministic Verification

**Status:** NOT STARTED
**Complexity:** 4 (MEDIUM)
**Owner:** joao
**Depends on:** PRD-001, PRD-007

**Risk override:** none — score 4 (6 implementation files, new module) lands in MEDIUM on its own. No security boundary, no migration, no external API; the whole layer runs local commands and hashes files.

## Context
**Covers:** FR-120, FR-121, FR-122, FR-123; ROADMAP §6.4, §6.5, §35, §51 (Verification).

LeanPi's completion decision is only as good as the facts underneath it. ROADMAP §6.4 requires that any fact ordinary code can establish reliably — exit code, compile success, failing test count, git dirty status, timeout — is never decided by model inference, and §6.5 requires evidence before completion. Today the repository is greenfield: the only file under `docs/PRDs/v1/` is `ROADMAP.md`. There is no `src/`, no `package.json`, no test runner, and no evidence type anywhere in the tree.

PRD-001 establishes the Pi extension harness, the npm scripts (`npm run build`, `npm run typecheck`, `npm test`, `npm run lint`), and `src/core/types.ts`. PRD-007 establishes the executor lane and the programmatic entry point that runs a task to completion. This PRD owns the layer between them: the deterministic evidence that the proof gate (PRD-010) and the reviewer lane (PRD-011) later consume.

Three failure modes drive the requirements. First, model assertions and measured results blur together, so "the executor said the tests pass" becomes indistinguishable from "the tests passed" (FR-120). Second, evidence outlives the workspace it described, so a check run before the last three edits is presented as current (FR-121). Third — the one that makes the whole system dishonest — a semantic judgement is allowed to overrule a measurement, and a JEV `pass` closes a task whose build is broken (FR-123).

## Solution
A single module, `src/verify/`, exporting one entry function that the executor calls after execution:

```
runTurn() [src/commands/session.ts] → runExecutor() [src/executor/lane.ts, PRD-007]
  → verifyTask(contract, workspaceRoot)          src/verify/index.ts
      → selectVerifiers(contract)                src/verify/select.ts
      → runVerifier(descriptor)                  src/verify/run.ts
      → EvidenceStore.record(EvidenceRecord)     src/verify/evidence.ts
  → outcome.evidence { status, records, assertions }
```

**Evidence shape.** `src/verify/evidence.ts` owns `EvidenceRecord { kind, status, workspaceHash, startedAt, exitCode, artifactRef }` per the shared contract, plus `EvidenceStore`. `status` is one of `pass | fail | not_run | error`. Two channels live in the store and never merge: `records` holds deterministic results produced by `runVerifier` only, and `assertions` holds model/executor claims (`ModelAssertion { source, text, recordedAt }`). The store has no API that can write a `ModelAssertion` into `records`; that type separation is the FR-120 mechanism, not a naming convention.

**Freshness.** `workspaceHash(root)` hashes the tracked+dirty file set (path + size + mtime + content hash of files under the task's touched paths, via `node:crypto`) and stamps every record. `EvidenceStore.current(hash)` returns only records whose `workspaceHash` equals the hash computed at read time; everything else is reported as `stale`, never silently dropped. A stale mandatory record makes the aggregate status non-pass. That is FR-121, and it is also what lets PRD-010's `§39` "no evidence is stale" clause be evaluated by code instead of by JEV.

**Verifier adapters, lazily.** Per §35, "the exact verifier set is derived from task requirements". One `runVerifier` implementation shells a command and maps exit code + parsed counts into an `EvidenceRecord`; the verifiers are table rows, not classes:

| kind | command | mandatory when |
|---|---|---|
| `typecheck` | `npm run typecheck` | any code change |
| `targeted_test` | `npx vitest run <pattern>` | contract names test scope |
| `full_suite` | `npm test` | contract marks broad/regression risk |
| `lint` | `npm run lint` | any code change |
| `build` | `npm run build` | contract crosses a build boundary |
| `smoke` | configured CLI invocation | contract requires runtime behavior |
| `git_status` | `git status --porcelain` | always (cheap, proves dirty state) |

Selection reads the PRD-004 `ExecutionContract` verification fields (§8 `verification` block) and returns descriptors; unknown/unsupported kinds return a `not_run` record with a reason rather than being omitted, so PRD-010 can see the gap. Deferred deliberately and not planned here: formatter, static analysis, package validation, benchmark, screenshot comparison. LSP diagnostics belong to PRD-018 and browser/runtime verification to PRD-022; both register through the same descriptor table when they land, so nothing about this design needs to change for them. Building ten adapters the MVP cannot select would be speculative work the ROADMAP does not require.

**The invariant.** `aggregate(records)` is pure and total: if any mandatory record is `fail`, `error`, or stale, the status is `deterministic_failure`, and `verifyTask` returns that regardless of any `ModelAssertion` present. PRD-010's gate takes this status as an input it cannot raise — the gate may lower `pass` to `MISSING_PROOF`, never lift `deterministic_failure` to `PASS`. FR-123 is therefore a property of the type flow plus one guard clause, asserted by a test in which a scripted JEV `pass` sits next to a failing typecheck.

Relevant ROADMAP §58 non-goals restated: no correctness claims without evidence — an absent check is recorded as `not_run`, never inferred as pass; no generative router or model judgement replacing a deterministic result; no requirement for JEV or a cloud model for basic operation, since this entire layer runs with zero inference.

Risks: (a) hashing a large workspace on every record — mitigated by hashing only the contract's touched paths plus `git status` output, with the whole-root path available behind config; (b) a verifier command absent from the host project — surfaces as `error` with the failing command string, not a crash.

## External Skill Dependencies
None. This layer runs commands and hashes files with Node stdlib; it consumes no installed global skill or plugin. Verifier commands are configuration (`LeanPiConfig.verify.commands`), so a host project overrides them without code changes and no absolute path is hard-coded.

## JEV Decision Sites
This PRD owns one site, registered in PRD-002's decision-site registry (id `verify.regression_scope`, telemetry tag `verify/regression_scope`).

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| Regression scope — are targeted tests sufficient, or does the diff justify the broader suite? | 1. Does the diff touch only code covered by the named targeted tests? 2. Does the diff change a shared/exported contract with other callers? | `Choice{ TARGETED_SUFFICIENT, BROADER_SUITE_REQUIRED }` | Deterministic rule from the diff alone: broader suite when the diff touches >N files, edits an exported symbol, or changes config/build files; otherwise targeted only. Selection runs unchanged with JEV disabled. | ★★★★★ |

The site is a *selection* input only. It can add a verifier, never remove a mandatory one and never alter a recorded result, so a wrong answer costs test time and cannot fabricate a pass.

## Acceptance Criteria
- [ ] AC-1 [local; actor: agent]: Running a task through `runExecutor()` on a temp workspace whose typecheck fails yields `outcome.evidence.status === 'deterministic_failure'` and an `EvidenceRecord{ kind: 'typecheck', status: 'fail', exitCode !== 0 }` in the deterministic channel — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: An executor claiming "tests pass" with no test verifier run yields `outcome.evidence.records` containing no `pass` test record and the claim readable only under `outcome.evidence.assertions`; the aggregate status is not `pass` — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: A record collected before a workspace edit is reported as `stale` after the edit (same task, recomputed hash) and the aggregate status drops from `pass` to non-pass without re-running the verifier — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: Two contracts over the same workspace select different verifier sets — a narrow bugfix runs typecheck + targeted test + git status and does not invoke `npm test`; a broad refactor contract does invoke it — observed from the recorded `kind` set and the commands actually executed — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: With a scripted JEV answer of `pass` alongside a failing mandatory check, `verifyTask` still returns `deterministic_failure`; removing the failing check is the only way the same input returns `pass` — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: For a diff the deterministic rule scopes as targeted-only, a JEV answer of `BROADER_SUITE_REQUIRED` causes `npm test` to be executed (observable in the command list and a `full_suite` record); with JEV disabled in config, the same task selects and runs the targeted set only, with `fallbackUsed: true` on the decision row — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Deterministic evidence for a completed task | `runExecutor()` in `src/executor/lane.ts` (PRD-007, wired from `src/commands/session.ts#runTurn`) calls `verifyTask()` from `src/verify/index.ts` (created in Phase 1) and returns `outcome.evidence` | New capability; no incumbent verification path exists in this greenfield repo | AC-1 / AC-4 |
| Model-assertion channel, separated from measurements | `runExecutor()` records executor claims via `EvidenceStore.assert()` (`src/verify/evidence.ts`, created in Phase 1); surfaced as `outcome.evidence.assertions` | New capability; replaces nothing | AC-2 |
| Deterministic-failure precedence consumed by the proof gate | `evaluateProofGate()` in `src/proof/gate.ts` (PRD-010) receives the aggregate status from `verifyTask()` as a non-raisable input | New capability; defines the contract PRD-010 depends on | AC-5 |
| Regression-scope decision site | `selectVerifiers()` in `src/verify/select.ts` (created in Phase 2) resolves site `verify.regression_scope` through PRD-002's registry; the fired/fallback row reaches `/route` (PRD-016) and telemetry (PRD-015) | New capability; the deterministic `regressionScopeRule` is the declared fallback, not a parallel implementation | AC-6 |

## Execution Phases

#### Phase 1: Evidence records with a freshness stamp and two channels
**Status:** NOT STARTED
**ACs:** AC-2, AC-3
**Files:** `src/verify/evidence.ts` (`EvidenceRecord`, `ModelAssertion`, `EvidenceStore`), `src/verify/hash.ts` (`workspaceHash`), `src/verify/index.ts` (`verifyTask` skeleton returning the store view), `tests/verify/evidence.test.ts`
**Implementation:** Define `EvidenceRecord` exactly as the shared contract states and `EvidenceStore` with `record()` (deterministic only, accepts a `VerifierResult` produced by Phase 2's runner), `assert()` (model claims only), and `view(hash)` returning `{ records, staleRecords, assertions }`. `workspaceHash` hashes sorted `(path, size, mtime, sha256)` tuples over the contract's touched paths plus `git status --porcelain` output, using `node:crypto`; missing path is part of the hash input, not an error. `view()` recomputes the hash and classifies each record fresh/stale by equality. No setter allows an assertion into `records`. Errors: hash failure returns an `error` record with the cause; it never throws into the executor.
**Verification:** E1 — `npx vitest run tests/verify/evidence.test.ts`: records a passing check, mutates a touched file, re-reads the store, asserts the record moved to `staleRecords` and the aggregate is non-pass (AC-3); records a model claim of passing tests and asserts it is absent from `records` and that no `pass` test record exists (AC-2). Distinct risks: freshness comparison silently no-op (control: assert the pre-edit read reports the record as fresh, so the post-edit stale result is not vacuous), and channel leakage.
**Checkpoint:** pending

#### Phase 2: Requirement-driven verifier selection and execution
**Status:** NOT STARTED
**ACs:** AC-1, AC-4, AC-6
**Files:** `src/verify/descriptors.ts` (kind → command/parse table), `src/verify/select.ts` (`selectVerifiers(contract, jev)` + `regressionScopeRule(diff)`), `src/verify/run.ts` (`runVerifier` via `node:child_process`), `src/verify/index.ts` (wire selection → run → store), `tests/verify/select.test.ts`
**Implementation:** `selectVerifiers` maps the `ExecutionContract` verification block to descriptors and marks each mandatory or advisory; commands come from `LeanPiConfig.verify.commands` with the table as defaults. Register the `verify.regression_scope` site in PRD-002's registry with its two atomic questions, `Choice` return type, and `regressionScopeRule(diff)` as the declared fallback; when JEV is disabled or below confidence threshold, call the rule and set `fallbackUsed: true` on the decision row. `BROADER_SUITE_REQUIRED` only adds the `full_suite` descriptor — it can never drop a mandatory one. `runVerifier` executes with a timeout, captures exit code and trimmed output to an artifact ref, and maps timeout → `error`. An unsupported or unavailable kind produces `not_run` with a reason so the gap is visible to PRD-010. Wire `verifyTask` to select, run in sequence, stamp each result with the hash captured at run start, and store it.
**Verification:** E2 — `npx vitest run tests/verify/select.test.ts` plus one integration test driving `runExecutor()` with a stub backend on a temp workspace containing a genuine type error: asserts the failing `typecheck` record with non-zero exit (AC-1); asserts the selected `kind` set and executed command list differ between the bugfix and refactor contracts, with `npm test` absent in the first (AC-4); and runs one targeted-only diff twice — once with JEV scripted to `BROADER_SUITE_REQUIRED` (asserts `npm test` executed) and once with JEV disabled (asserts targeted commands only and `fallbackUsed: true`) (AC-6). Distinct risks: selection reading a field the contract never sets (control: assert the executed command list, not just the descriptor list, so a selected-but-never-run verifier fails); the JEV answer being ignored (the disabled/enabled pair is the differential control); and a verifier passing on a stale artifact.
**Checkpoint:** pending

#### Phase 3: Deterministic failure outranks any semantic pass
**Status:** NOT STARTED
**ACs:** AC-5
**Files:** `src/verify/aggregate.ts` (`aggregate(records) → VerificationStatus`), `src/verify/index.ts` (return the aggregate as the only status the gate consumes), `tests/verify/precedence.test.ts`
**Implementation:** `aggregate` is pure: any mandatory record `fail`/`error`/stale → `deterministic_failure`; any mandatory `not_run` → `incomplete`; otherwise `pass`. `verifyTask` returns `{ status, records, staleRecords, assertions }` and exposes no override parameter, so PRD-010 has no API by which a JEV answer can raise the status. Document the one-way contract in a comment on the exported type.
**Verification:** E3 — `npx vitest run tests/verify/precedence.test.ts`: with a scripted JEV client answering `pass` and a failing mandatory typecheck, asserts `status === 'deterministic_failure'`; then, with the failing check replaced by a passing one and the same JEV answer, asserts `status === 'pass'` — the pair proves the failure drove the outcome rather than a constant (AC-5). Distinct risk: the assertion would already hold with the guard absent — the second half is the negative control that rejects that reading.
**Checkpoint:** pending

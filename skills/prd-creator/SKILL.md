---
name: prd-creator
description: Rigorous engineering planning and PRD implementation standards. Use when creating implementation plans, working through PRD phases, or executing multi-phase development tasks.
---

# PRD Implementation Standards

Act as a Principal Software Architect. Produce a plan explicit enough to implement, then execute it on the shortest safe path to a verified correct result.

Priority order:

1. Protect safety, data, security, compatibility, and explicit user/repository constraints.
2. Make the requested outcome actually work through its intended consumer path.
3. Minimize elapsed time and token/tool/test cost together — remove ceremony, choose the cheapest sufficient proof, and never re-derive a fact already established or duplicate an equivalent check. Neither speed nor token thrift justifies weakening 1 or 2.

One obligation, one evidence record. Every additional check must cover a distinct failure mode. A faster path is better only when it gives the same required confidence. Repository instructions and user requirements take precedence. Planning-only requests authorize a plan, not implementation, deployment, or closure.

---

## The Integration Litmus

> Through the intended entry point, can the consumer exercise the behavior, and what observable result distinguishes correct execution from a broken or bypassed implementation?

A helper test alone does not establish integration. Trace the reachable consumer and assert the promised output or state. Registration needs invocation; a success envelope does not prove persistence, rendering, or delivery.

A new integration test through the real entry point is valid proof. Neither a pre-existing test failure nor an arbitrary edit to an existing file is required. Preserved regression behavior is useful evidence; not every passing gate needs a manufactured failure. Use the targeted controls in §6.

---

## Step 0: Complexity Assessment

Score before planning; update only when scope or risk materially changes.

| Factor | Points |
|---|---|
| Implementation files: 0 / 1–5 / 6–10 / 11+ | 0 / 1 / 2 / 3; choose one |
| New system/module | +2 |
| Complex state or concurrency | +2 |
| Crosses an independent build/release boundary | +2 |
| Database schema change | +1 |
| External API integration | +1 |

Exclude tests, documentation, generated files, and the PRD from file counts. Two package directories are not necessarily separate build/release boundaries. Security boundaries, destructive migrations, and high-impact compatibility changes promote the mode to HIGH; record why.

| Score | Mode | Process |
|---|---|---|
| 0–3 | LOW | Compact plan, ACs, affected checks, self-review. |
| 4–6 | MEDIUM | Add diagrams where they clarify boundaries and one reviewer at substantive checkpoints when available. |
| 7+ | HIGH | MEDIUM plus verification of named high-impact risks and required platforms. |

State `Complexity: <score> → <mode>; risk override: <reason or none>`. No minimum number of tests, diagrams, or agents. Manual/human gates follow the property being proved, not the complexity score.

---

## Step 0.5: Can This PRD Close Here?

Give each acceptance criterion a lane and actor on its own line:

| Lane | Meaning and action |
|---|---|
| `local` | Runnable by the agent in the current approved environment. Execute and record the result. |
| `shared` | Reachable through CI, staging, a queue, or a scheduled runner. Name the job, triggering actor, required environment, and result reference. |
| `owner` | Requires a named human's action or sign-off. Default is zero; retain only when necessary. Flag it in the header and record the expected result. |
| `unreachable` | Required hardware, access, or actor is currently unavailable. Record the blocker; do not treat it as satisfied. |

Check available tools and equivalent environments before declaring a blocker. A substitute counts only for the property it actually proves: a simulator cannot silently replace required physical-device evidence, nor a mock replace required live-service validation. State remaining gaps.

Start approved shared checks when their inputs are ready and continue independent phases. Their results remain required for acceptance. Every `local` box being green does not imply that shared checks, implementation elsewhere, or the PRD itself are complete.

The lane rule comes from a source-supplied audit across three unrelated repos (a native game framework, a TypeScript game API, and a CLI tool): 700+ PRDs and 240 rejected completion attempts. The criteria that stayed unticked were disproportionately the ones requiring evidence the author could not reach:

| Repo's out-of-reach thing | Share of OPEN PRDs | Share of CLOSED PRDs |
|---|---|---|
| physical device (native framework) | 40% | 17% |
| e2e / live pilot run (game API) | 24% | 9% |
| e2e / live run (its client) | 50% | 8% |
| deploy / staging (game API client) | 53% | 23% |
| hosted CI run, publish, release tag | 3-4% | 1% |

Treat these figures as design evidence for the lane model, not as repository facts to re-prove during normal execution.

For `unreachable` qualification work, split into a linked qualification PRD only when its scope is genuinely separable. During execution, moving an agreed AC requires authorization. A qualification dependency needed to satisfy this PRD remains completion-blocking; splitting or relabeling it never counts as verification.

### Owner lane

This skill does not authorize deploying, publishing, rotating credentials, or changing production. Keep those actions out of autonomous phase steps. A separate explicit request must use the applicable authorization/workflow; the lane itself grants no permission.

For a required human gate, name the owner, action/result to confirm, and an applicable header flag: `POST-DEPLOY-EVALUATION-REQUIRED`, `POST-RELEASE-EVALUATION-REQUIRED`, or `POST-DEVICE-EVALUATION-REQUIRED`. Use the repository's equivalent for other human sign-offs. Keep the flag near the top; do not add it speculatively.

Ask once at the end, after agent-executable work is verified; combine outstanding human gates into one request. While working, surface blockers in status updates without repeated action requests. Do not perform the owner action or approve it on their behalf. Record an owner result only from attributable confirmation/evidence. Pending owner acceptance keeps the PRD open.

### Closability budget

| Mode | Target maximum phases | Target maximum required boxes | Typical external gates |
|---|---|---|---|
| LOW | 2 | 8 | No speculative shared/owner gates. |
| MEDIUM | 4 | 16 | At most one shared/qualification dependency; no speculative owner gate. |
| HIGH | 6 | 24 | At most one shared dependency and one necessary, flagged owner gate. |

These are planning budgets, not permission to remove required validation. Consolidate duplicate boxes or split genuinely independent scope first. If required coverage still exceeds a budget, preserve it and explain the exception; never weaken an AC, disguise several outcomes as an untestable box, or raise the tier merely to allow a human gate. Every box must establish a distinct required fact.

The same source audit found more boxes on open PRDs than closed ones (7 vs 12 in one repo, 23 vs 31 in another, 30 vs 38 in a third), while PRDs that never closed carried 46, 54, and 67 boxes. That is why the budgets are binding planning pressure: over budget means consolidate duplicate proof or split independent scope, not silently add ceremony. Required facts still win over the budget.

---

## Pre-Planning

For a new PRD, inspect repository instructions and naming/location conventions, then create the file with its header and phase outline before extended research. Fill it as findings land; do not overwrite an existing PRD or invent an ID that collides. For an existing PRD, update that file instead of creating a duplicate. The requested plan must exist on disk, not only in chat.

Use targeted reads of entry points, incumbent implementations, utilities, schemas, tests, configuration loaders, and build/CI scripts. Batch independent discovery instead of exploring unrelated areas one after another. Discover real commands; never assume yarn, pnpm, cargo, or any other runner. Prefer configuration schemas and `.env.example`; never print or copy secrets into a PRD.

Identify changed behavior, consumer/trigger, replacement paths, affected files, and risks. Resolve ambiguity from the repository first; ask only for decisions blocking correctness or authorization. State safe, reversible assumptions otherwise.

User-facing does not necessarily mean a new screen: the access path may be a UI, CLI, API, or SDK. Internal work needs a runtime/build trigger. Record the full path: consumer action → entry point → implementation → observable result.

### Integration Ledger

Use one row per changed integration boundary or consumer-visible capability, not per helper, exported symbol, test, or gate. For no wiring change, write `Integration: unchanged — <reason>`.

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Invoice creation | Checkout route → billing service; fill actual `file:line` | Legacy handler delegates | AC-1 / E1 |

Fill actual non-test entry-point locations before the owning phase completes; do not invent line numbers. Public libraries and auto-discovered routes may use a consumer fixture or real request through their public entry point. A unit test importing an internal helper is not a live consumer.

Delete or delegate obsolete paths. Temporary coexistence needs explicit migration/rollout scope, routing ownership, cutover/removal conditions, and tracked remaining work. Prove the new path runs rather than falling back. A removal required by this PRD cannot be postponed merely to close it.

---

## Plan Structure

Keep the repository's organization and these tooling-facing field names:

```markdown
# PRD-<id> — <title>

**Status:** NOT STARTED
**Complexity:** <score> (<LOW|MEDIUM|HIGH>)
**Owner:** <owner>
**Depends on:** <PRD ids or None>

## Context
Problem, current behavior, relevant files inspected.

## Solution
Approach, consumer flow, reused components, data changes, risks.
Architecture/sequence diagram only where it resolves real ambiguity.

## Acceptance Criteria
- [ ] AC-1 [local; actor: agent]: <consumer action → observable result, platform/threshold> — Evidence: pending.

## Integration Ledger
<Applicable rows, or Integration: unchanged — reason.>

## Execution Phases
#### Phase 1: <one working outcome>
**Status:** NOT STARTED
**ACs:** AC-1
**Files:** <new/edited paths and purpose>
**Implementation:** <steps, contracts, error handling>
**Verification:** E1 — <command/flow, assertion, ACs and distinct risks covered>
**Checkpoint:** pending
```

Add required owner flags near `**Status:**`; omit absent flags rather than filling them with `None`. Allowed status values: `NOT STARTED`, `PROPOSED`, `PARTIAL`, `IN PROGRESS`, `BLOCKED`, `DONE`, `REOPENED`. Keep status values exact; put explanations on a separate line:

```markdown
**Status:** PARTIAL
**Blocker:** Implementation verified; awaiting <owner>'s <named check> for AC-3.
```

Preserve `**Progress:**` where tooling uses it. Checkboxes are for required work/ACs, not examples, alternatives, or optional follow-ups. Reuse existing required checklists instead of creating parallel copies. The closure helper's parser is authoritative for syntax; inspect it when conventions are unclear.

---

## 4. Execution Phases

Each phase delivers a coherent, testable vertical slice. Prefer roughly five implementation files or fewer, but do not fragment a working slice to satisfy a file cap. Documentation/refactor phases may prove correct consumption or preserved contracts rather than new UI behavior.

Phases are ordered by dependency, not by numbering: a dependent phase waits only for the prerequisite it actually needs, and independent phases with stable contracts and non-conflicting write surfaces may run in the same wave. Orchestrating that execution is `prd-executor`'s job, not this skill's.

Prove capabilities on a production-representative subject exercising the hard requirements — not an easy toy. If an AC names an actual production subject, use that subject. An intermediate smaller fixture must list omitted requirements and the phase that closes each gap; final acceptance cannot retain those gaps.

Implement scope, run selected affected checks, record evidence and integration locations, then perform the checkpoint. Reuse coverage; add or extend tests only for uncovered behavior or plausible regressions. Follow existing naming conventions.

Store evidence once, on the owning AC or existing phase box. Reference it elsewhere:

```markdown
- [x] AC-1 [local; actor: agent]: Invoice appears after checkout — E1: <actual command>, <passed/collected counts>, exit <code>; <tested source snapshot>, <environment>; asserts persisted invoice through checkout. Red: <cause, when required>.
- [x] AC-2 [local; actor: agent]: Repeated checkout is idempotent — E1, assertion <test name>.
```

Identify the tested revision including relevant uncommitted changes; a commit hash alone does not identify a dirty worktree. For shared evidence, link the actual run/artifact and relevant job result. Keep output concise, inspect failure details, and retain the useful artifact reference — not a full log dump or a separate report per phase unless tooling/user requirements need one. A tool exit code alone does not establish the asserted outcome.

---

## 5. Checkpoint Protocol

Self-verification is mandatory after every phase: compare the diff to ACs, inspect reachability and failure handling, then evaluate actual execution evidence. No checklist or reviewer verdict substitutes for running the selected checks.

LOW uses self-review. MEDIUM/HIGH use one `prd-work-reviewer` or equivalent at substantive checkpoints when available. An equivalent orchestrator review of the same scope satisfies this requirement; do not spawn a duplicate. If unavailable, perform and label self-review. An explicitly required independent review stays outstanding until actually completed.

Pass the reviewer the PRD path, phase/AC IDs, changed paths, tested snapshot, concise evidence, and unresolved risks. Use the harness's available delegation tool; do not assume a particular Task API exists.

Review the diff and supplied evidence first. Check AC alignment, reachable consumers, incumbent routing, required platforms, and assertion quality. Rerun only a named coverage gap, stale result, or suspected false positive. Report `PASS`, `NEEDS CORRECTION`, or `BLOCKED` with actionable locations. Do not run the full suite merely because you are the reviewer.

Fix findings, rerun affected checks, and review the correction/delta only. Independent reviewer findings whose fixes do not overlap may be handled concurrently; related findings stay with one root-cause investigation. Required shared/owner acceptance may remain pending while independent work continues; do not mark its ACs or owning phase DONE early. Do not request generic "reply continue" approvals after verified phases. Human checkpoints use the owner lane, not an additional checklist.

---

## 6. Verification Strategy

### Select checks by marginal value

Before adding any test or verification step, answer:

> Which plausible failure does this catch that the selected checks do not?

If none, omit it. Extend an existing test/fixture before creating a new harness. Select the cheapest reliable instrument at the relevant boundary. Distinct layers earn their cost by detecting distinct failures.

| Risk | Suitable evidence |
|---|---|
| Pure logic/validation | Focused unit tests and affected regressions. |
| API/job/persistence wiring | Real-entry-point integration test asserting resulting state. |
| UI interaction | Existing component/E2E flow; visual observation for properties assertions cannot establish. |
| Native/rendering/export | Required target execution on representative inputs and observable output. |
| Performance | Comparable measurements against the AC's workload, environment, and threshold. |
| Docs/config/build tooling | Relevant parser, build, link, consumer, or smoke check; no dummy unit-test quota. |

One real-entry-point integration test may prove behavior, wiring, and regression safety together. Do not additionally require curl, a demo, or another E2E for the same property. A mocked helper test cannot claim that integration coverage; typechecking alone cannot prove runtime behavior.

### Minimum sufficient proof and the stop condition

For each AC, choose the smallest evidence set that would reliably reject a broken implementation. Prefer the highest useful consumer boundary: one strong observation may cover behavior, wiring, persistence, and regression. Add another check only for a distinct plausible failure, needed failure localization, or a high-impact invariant the primary proof cannot establish. High-risk security, data, billing, concurrency, compatibility, recovery, or irreversible changes may therefore need complementary evidence; choose the cheapest *sufficient*, not merely the cheapest, proof.

Stop verification when every in-scope AC has current evidence, the required consumer path is exercised, material changed risks are covered by checks capable of detecting them, required repository/user gates are green (or explicitly pending externally), and no observed failure, reviewer finding, or material uncertainty remains unresolved. Then stop adding tests, equivalent reruns, reviewers, or demos unless new information introduces a distinct risk or a requirement demands them. Run independent required checks concurrently when they do not contend for mutable resources.

### Negative controls: targeted, not universal

For new/changed behavior with an automated test harness, use test-first red → green. The red must arise from the missing behavior or bug, not an unrelated syntax/import/environment error. An already-observed valid red counts; do not disable the feature again for equivalent proof.

When no valid red exists, use a safe targeted negative control for a distinct behavior claim that could pass with the implementation absent or bypassed. A control can cover several ACs only when the observed assertions actually distinguish them. Exercise the real caller for integration claims.

No manufactured red for unchanged regression checks, lint/type/build checks, or behavior-preserving refactors whose contracts should pass before and after. Refactors still need evidence the new path is reached and the old path has the planned disposition.

When one of these false-pass risks is plausible, use the matching detection method rather than adding a generic extra test:

| Silent-pass mechanism | Negative control that catches it |
|---|---|
| **Test never collected by the runner** (excluded target, missing `mod`/import, wrong glob, `autotests = false`) | Insert a deliberate failing assertion and confirm the run reports it. Check the runner's file list and test count, not just exit 0. |
| **Both sides of a comparison resolve to the same thing** (a "differential" test whose two imports are the same module; a report diffed against a copy of itself) | Log the resolved identity of each side — module path, artifact hash, object id — and assert they differ. |
| **Assertion already satisfied by the pre-change baseline** | Run the gate with the feature disabled, or at the previous commit. It MUST fail. If it passes, it proves nothing about your change. |
| **Gate reads a stale or generated artifact** | Delete the artifact and re-run. It must regenerate or fail loudly — never pass on the old copy. |
| **Real implementation mocked out** | Assert the production path actually ran: a call count, a side effect, a log line emitted from the real code. |
| **Assertion kind silently ignored** by the harness (unknown key, typo'd field) | Assert something you know is false and confirm the harness reports failure rather than skipping. |

These controls are conditional diagnostics, not a universal checklist. Use a row only when that silent-pass mechanism is plausible and the selected evidence does not already exclude it. An already-observed valid red still counts.

Investigate specific false-pass risks: uncollected tests, self-comparisons, stale artifacts, ignored assertions, vacuous fixtures, and mocks bypassing production. Prefer runner/provenance output and existing coverage. Inject a deliberate failure only where cheaper inspection cannot establish collection or sensitivity. A call count alone does not prove the promised end state.

Temporary mutations must be isolated and reversible. Preserve user changes, restore the exact candidate, and rerun the affected check to green. Never mutate production, disable real security controls, or commit the negative control. When a required proof cannot run safely, leave that claim `UNVERIFIED` — not passed.

### Reuse valid evidence

Reuse evidence while its relevant code, dependencies, configuration, inputs, environment, and platform are unchanged and the observed state remains applicable. Later edits invalidate affected evidence, not every result in the PRD. CI evidence must match the candidate's relevant scope and show that required tests actually ran; a skipped/cancelled job is not a passing check.

Run focused checks during iteration. Run required broader gates once at final verification unless an applicable matching result already exists; run earlier when risk warrants. Never weaken repository/user-required checks to meet a token budget. Do not rerun unrelated suites after status-only edits; verify affected links/metadata and honor required CI policy.

Missing execution/access means `UNVERIFIED` or `BLOCKED`. Existing red CI is not a passing gate; use only an explicit authorized waiver process, never an invented exception.

---

## 7. Acceptance Criteria and Required Closure

Write criteria about consumers and observable outcomes, not mere artifact existence: "invoice appears in billing after checkout," not just "endpoint returns 200." Compatibility, correct artifact consumption, security invariants, or documentation usability can also be valid outcomes.

When every in-scope AC is implemented and verified, all required gates/reviews and completion-blocking dependencies are satisfied, and no required work remains, you MUST mark the PRD DONE and move it to the repository's `done/` location in the same implementation task. Do not stop at "ready to close" or merely recommend the move.

This includes required `local`, `shared`, and `owner` evidence. An open owner check means `PARTIAL` with a separate blocker explanation, not `DONE`. Unreachable required qualification also blocks closure. "Code complete" is a qualified implementation statement, not completed acceptance.

Never tick, delete, weaken, or relabel a required AC to make closure succeed. Not-applicable items need a factual scope explanation; changes to agreed requirements need authorization. Preserve the decision rather than falsely checking the item. Optional follow-ups do not block closure; unfinished required work does.

Closure consumes existing evidence; it is not another test suite or review cycle.

Reconcile existing AC/task boxes, phase statuses, `**Status:**`, and `**Progress:**` from recorded evidence. Required proof gaps and unresolved placeholders keep the PRD open.

Use the repository's `prd-manager` closure helper when available; inspect its usage and destination. For installations with this layout:

```sh
node "$HOME/.claude/skills/prd-manager/scripts/prd-close.mjs" "<prd-path>" --yes
```

If the helper is unavailable, update fields and use `git mv` to the established done directory, or `done/` under the PRD root when no convention exists. Use a normal move for an untracked file or outside Git. Preserve filename/ID and never overwrite a collision. A helper rejection for unmet requirements is not permission to bypass it manually.

Verify the destination exists, the old path is gone, and status/phase/progress fields are accurate. Update affected board/index links and PR references. Use one relevant closure audit when provided; no unrelated repository-wide audit is required.

Include the move/status/link changes in the finishing commit or PR when authorized. Do not merge or deploy merely to close a PRD. If the repository requires merge/release before DONE, retain the verified intermediate state until that gate is satisfied.

Report verified implementation separately from incomplete archival if a move/status write fails. Final output names completed ACs, concise evidence, final PRD path — or the exact remaining gap. Never claim a move or successful run without observing it.

---

## Guardrails and Isolation Anti-Patterns

Do not ship orphan code, mocked-only integration proof, unread contracts, uncollected tests, self-comparisons, manufactured success, stale artifacts, vacuous fixtures, or success responses without the promised state change. Investigate concrete risks rather than adding another generic checklist.

These are the concrete diff signatures of "implemented but not integrated." Scan the changed surface for the applicable signatures during self-review/checkpoint; do not mechanically prove every row when the diff cannot exhibit it. Finding one fails the affected phase until the wiring/evidence is corrected.

| Smell | What it looks like in the diff |
|---|---|
| **Orphan module** | New file whose only importers are its own tests — or zero importers at all |
| **Additive migration** | The new implementation lands and the old one is still the one running. Two or three copies of the behavior, none sharing a source. |
| **Dead-code marker** | `#![allow(dead_code)]`, `eslint-disable no-unused`, unused-export suppression added so the new code compiles |
| **Unread contract** | A types/contract/schema/descriptor file the implementation never consults |
| **Listed-but-absent test** | A test name promised in the PRD with no body in the repo |
| **Uncompiled test** | A test file the build excludes: missing `mod`/import, excluded target, non-matching glob |
| **Self-comparison** | A differential or parity gate whose two sides resolve to the same module, file, or artifact |
| **Toy proof** | The capability proved on the one input that needs none of the hard requirements |
| **Twin constants** | PRD says "derived from one owner"; the code has two hardcoded literals with nothing tying them |
| **Registered but unspawned** | Plugin/handler/route registered, nothing ever invokes it |
| **Manufactured evidence** | The report emits `status: "applied"` / `ok: true` as a literal instead of measuring anything |
| **Vacuous fixture** | The gate's fixture does not contain the feature under test (an overlay-packaging gate whose fixture has no overlays) |
| **Envelope ≠ state** | The call returns success and the persisted state is unchanged — `changed: true` written next to an empty object |
| **Pure function stands in for the loop** | The evidence harness calls the function directly; the frame loop / request path never does |

The measured audit figures in §0.5 are retained inline so this skill has no dangling `references/` dependency. They are source-supplied historical rationale; active execution rules remain the sections above.

# PRD-025 — Task Todo List

**Status:** DONE (verified 2026-09-19)
**Complexity:** 5 (MEDIUM)
**Risk override:** none — 5 implementation files (1) + new module (+2) + persisted item state with evidence-driven reopen transitions (+2) = 5; no security boundary, no schema migration, no external release surface.
**Owner:** joao
**Depends on:** PRD-013, PRD-014

## Context

**Covers:** none (new slice, product-owner request); ROADMAP §20, §42, §43, §51 (/goal block, consumed not owned)

The ROADMAP does not slice a todo list. It slices `/goal` (§42), PRD-derived goals (§43) and the external working state (§20) — and between them there is a hole the product owner asked to close: `/goal` decides *whether to keep going*, but nothing in the harness enumerates *what is left*. Today the only answer to "what remains" is the model's own recollection of the transcript, which is exactly the self-asserted completion §43's evidence rule exists to refuse.

A todo list fills the hole cheaply, provided it is not the usual one. The incumbent pattern LeanPi must be cheaper than is a model-maintained checklist re-emitted into context every turn: it grows without bound, it duplicates state that already exists in the PRD store, and the model that writes "done" is the same model whose completion claim the proof gate is supposed to distrust. This PRD builds the opposite: a small structured record that is *derived* where a PRD exists, *evidence-governed* where criteria exist, and *bounded* in what reaches the prompt.

Repository state inspected: the repository contains only `docs/PRDs/v1/` markdown. There is no source tree, package manifest or test harness; PRD-001 creates the TypeScript/Pi harness skeleton, `npm run build | typecheck | test | lint`, vitest and `src/core/types.ts`. Every path named below is created by this PRD's phases.

Contracts consumed, owned elsewhere, never redefined here:

- PRD-014 `src/context/working-state.ts` — the `WorkingState` record and its session persistence. The list lives inside it. This PRD adds **no store**.
- PRD-014 `src/context/prompt.ts` — `assemble()`, the single prompt assembler. The list is one compact block it emits; this PRD never builds a prompt.
- PRD-013 `src/goal/boundary.ts` — per-boundary evaluation and the five stop conditions (`GOAL_MET`, `GOAL_IMPOSSIBLE`, `BLOCKED`, `BUDGET_EXCEEDED`, `USER_STOPPED`). This PRD supplies a predicate that engine reads; it defines no stop condition.
- PRD-012 `src/prd/manager.ts` — work units and per-criterion status, one unit exposed at a time. The source the list is derived from.
- PRD-010 `src/proof/` — the per-criterion proof gate returning PASS / MISSING_PROOF / FAILED / BLOCKED. The only authority that may mark a derived item done.
- PRD-009 `src/verify/evidence.ts` — `EvidenceRecord { kind, status, workspaceHash, startedAt, exitCode, artifactRef, criterion, scope }`; read only through PRD-010, never interpreted here.
- PRD-016 `src/commands/registry.ts` — `/todo` registers here like every other command; this PRD does not own the registry.
- PRD-002 `src/jev/client.ts` — `ask(siteId, questions, state)` and the decision-site registry, for the one site below.
- PRD-004 `src/compiler/contract.ts` — `ExecutionContract.execution_complexity`, read for the deterministic fallback.
- PRD-005/PRD-006 `src/capabilities/router.ts` — the capability router that admits the executor-facing tool.

## Solution

`src/todo/`, four files plus one command handler. No plugin system, no external tracker sync, no daemon, no storage engine.

**The record.** `TodoItem { id, text, status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'dropped', phase?, criterion?, blockedReason? }`, held as an ordered array on PRD-014's `WorkingState`. Order is insertion order and is the only priority notion; `phase` is an optional flat label for grouping in the rendered view, not a tree — nested phases buy nothing a label does not. Persistence is whatever PRD-014 already does with `WorkingState`, so resume and fork inherit the list for free and there is nothing new to keep in sync.

**Transitions** (`src/todo/state.ts`) are plain code, no state-machine library:

- At most one item is `in_progress`. `start <id>` on a second item returns the active item's id instead of silently creating a second one.
- `done` on the active item promotes the **next `pending` item in order** to `in_progress`. `blocked`, `dropped` and `done` items are skipped, and a `blocked` item is never promoted by any transition — it re-enters the order only through `unblock`, which returns it to `pending`.
- `block <id> [reason]` stores `blockedReason` (default `"unspecified"`); `drop` is terminal and keeps the item visible in state but out of every remaining-work calculation.
- `clear` empties the list; on a derived list it clears only manual items, because the derived ones would regenerate on the next sync anyway.

**Derivation, not duplication** (`src/todo/derive.ts`). With an active PRD the list is *not* hand-maintained: `syncFromPrd()` asks PRD-012 for the remaining work units and their criteria and reconciles them into items carrying `criterion`. Reconciliation is by criterion id, so a sync is idempotent and never duplicates an item. Status then follows the proof gate, not the author:

- a criterion PRD-010 reports `PASS` → its item becomes `done`;
- a criterion previously `done` whose gate verdict is no longer `PASS` — fresh contradicting evidence — flips **back to `pending`** and re-enters the order at its original position;
- `MISSING_PROOF` / `FAILED` leave the item actionable; `BLOCKED` sets `blocked` with the gate's reason.

And the rule this feature exists for: **`/todo done <id>` on a derived item does not mark it done.** The command consults the gate and, on anything other than `PASS`, refuses with the verdict and the missing evidence kind — `cannot mark AC-3 done: MISSING_PROOF (no fresh evidence for `npm test -- tests/foo.spec.ts`)`. A model marking its own work complete is the precise failure LeanPi is built to prevent; allowing it here would reintroduce it through the back door. AC-2 asserts the refusal as a negative control, not as a nicety.

**Goal pairing** (`src/todo/goal.ts`). `remainingWork(list)` returns `{ actionable: TodoItem[], blocked: TodoItem[] }` — `actionable` is every item that is neither `done` nor `dropped` nor `blocked`. PRD-013's boundary reads it as its "useful work remains" input (ROADMAP §42 step 4): non-empty `actionable` means continue; empty `actionable` with a non-empty `blocked` means the engine returns `BLOCKED` naming those items' `blockedReason`s; empty both lets the engine's own evaluation proceed to `GOAL_MET`. **PRD-013 owns those stop conditions** — this PRD hands it a predicate and a blocker list and nothing else. The value is that the loop now drains a list instead of terminating on a model's assertion that it is finished.

**Context cost** (`src/todo/render.ts`). The list reaches the prompt as one compact block in PRD-014's VOLATILE layer, hard-capped at `todo.promptBudgetBytes` (default 2048). It is structured state, never a transcript: `done` items are collapsed to a count line (`done: 7`), `dropped` items are omitted entirely, and only `in_progress`, `pending` and `blocked` items are enumerated. On overflow the tail of the pending list collapses to `+N more pending`; the active item and every blocked item with its reason always survive, because those are the two things the next turn actually needs. The rendered block is deterministic — same list, same bytes — so it does not defeat the prefix caching §22 buys.

```text
todo (12 items · done 7)
  > implement syncFromPrd            [in_progress]  AC-2
  - collapse completed items to a count            AC-4
  ! wire boundary predicate  blocked: PRD-013 boundary hook not landed
  +3 more pending
```

**Ad-hoc mode.** With no active PRD the list is user- and executor-managed: the user drives `/todo`, and the executor may append items through a single `todo_add` tool that the capability router admits **only** when the task is multi-step (see the decision site). Single-step tasks never see the tool, so the common quick path pays nothing — no tool schema in context, no list, no block in the prompt.

**Consumer path:** user types `/todo …` → `src/commands/todo.ts` → `src/todo/state.ts` mutates `WorkingState` → PRD-014 persists it → `assemble()` emits the compact block next turn → PRD-013's boundary calls `remainingWork()` → the session either takes another turn or stops with the engine's condition.

Reused rather than rebuilt: PRD-014's persistence and assembler, PRD-016's registry, PRD-012's units, PRD-010's gate, PRD-002's registry and telemetry. This PRD adds no persistence format, no command dispatcher, no scheduler and no second notion of "remaining work".

Relevant non-goals (ROADMAP §58): no unbounded autonomy — the list bounds the goal loop, it does not extend it; no correctness claims without evidence — a derived item reaches `done` only through PRD-010; no JEV requirement for basic operation — with JEV off the deterministic fallback decides whether a list is warranted and everything downstream is unchanged; no everything-exposed capability surface — `todo_add` is router-gated like any other tool.

Risks: (1) a derived list that drifts from the PRD — mitigated by re-syncing at every boundary rather than snapshotting once (AC-2); (2) a list that grows into the transcript it was meant to replace — mitigated by the byte ceiling and the done-count collapse (AC-4); (3) an all-blocked list spinning the goal loop forever — mitigated by `blocked` never being auto-promoted and by the engine's `BLOCKED` path (AC-3).

## External Skill Dependencies

None.

No module in this PRD reads a skill, plugin or script file. Remaining PRD work units and criteria are obtained exclusively through PRD-012's adapter, which owns discovery of the installed `prd-manager` / `prd-creator` skills and their configurable roots (`skills.roots`, `prd.managerSkillPath`). Consequently, on a machine where no skill root exists, `/todo` behaves exactly as it does in ad-hoc mode: PRD-012 reports no active PRD, the list is user-managed, and nothing in `src/todo/` has an absolute path to be wrong about.

## JEV Decision Sites

This PRD owns one site, registered with PRD-002's decision-site registry (id, question set, return type, confidence threshold, consequence class, deterministic fallback, telemetry tag).

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| `todo.needed` — is this task multi-step enough to warrant a list at all? | "Does `<request>` require several distinct, separately verifiable steps?" → `yes` / `no` | Choice (consequence: `low`) | A list is created when the contract's `execution_complexity` is `MEDIUM` or `HIGH`, **or** a PRD is active; otherwise no list and no `todo_add` tool. | ★★★☆☆ |

Three stars, not five, and the consequence class is deliberately `low`: a wrong answer costs one unused list or one missing convenience, never a wrong completion verdict. Everything else in this PRD is deterministic bookkeeping and **must not** call a model — transitions, promotion order, derivation, gate reconciliation, the remaining-work predicate and rendering are all plain code. In particular, *is this item done* is never a JEV question; it is PRD-010's gate answer, and routing it through inference would be both more expensive and less trustworthy.

Sites owned elsewhere and merely consumed: proof sufficiency per criterion (PRD-010), per-criterion requirement status (PRD-012), semantic goal completion (PRD-013), retention relevance (PRD-014).

## Acceptance Criteria

- [x] - [ ] AC-1 [local; actor: agent]: In a live session, `/todo add a`, `/todo add b`, `/todo add c`, `/todo start <a>`, `/todo block <b> waiting on review`, `/todo done <a>` produce, in `/todo`'s listing, `a: done`, `b: blocked (waiting on review)` and `c: in_progress` — proving completing the active item promotes exactly the next `pending` item in order and skips the blocked one; a subsequent `/todo start <b>` is refused while `c` is active, and `/todo unblock <b>` returns `b` to `pending` without displacing `c` — Evidence: tests/todo/state.spec.ts — the real command registry drives add/start/block/done in order: the listing shows `a: done`, `b: blocked (waiting on review)`, `c: in_progress`, exactly one item is in progress, a second `start` is refused naming the active id, `unblock` returns `b` to pending without displacing `c`, and a JSON round-trip preserves the list.
- [x] - [ ] AC-2 [local; actor: agent]: With an active PRD exposing three remaining criteria through PRD-012, `/todo` lists exactly three derived items carrying those criterion ids with no manual authoring; when the proof gate reports `PASS` for one criterion the next sync flips that item to `done`, and when fresh contradicting evidence makes the gate stop reporting `PASS` the item returns to `pending` at its original position. `/todo done <id>` on a derived item whose gate verdict is `MISSING_PROOF` leaves the item unchanged and reports the verdict and the missing evidence kind — Evidence: tests/todo/derive.spec.ts — against a real PRD fixture, `syncFromPrd()` derives exactly the three remaining criteria keyed by id and is idempotent; a PASS verdict flips its item done, withdrawing PASS reopens it to pending at its original index, and `/todo done` with MISSING_PROOF is refused naming the verdict and the missing evidence kind while the same command with PASS succeeds.
- [x] - [ ] AC-3 [local; actor: agent]: A goal run over a session whose list has two actionable items continues at the PRD-013 boundary without user input; with the same run's list drained (all items `done` or `dropped`) the next boundary stops `GOAL_MET`; with every remaining item `blocked` the boundary stops `BLOCKED` and the reported reason names at least one item's `blockedReason` — Evidence: tests/todo/goal.spec.ts — three boundaries against PRD-013's real `evaluateGoal`: two actionable items continue, an all-blocked list stops BLOCKED with the blocked reason in the text, and a drained list with a proved clause stops GOAL_MET.
- [x] - [ ] AC-4 [local; actor: agent]: For a session with 7 `done`, 1 `in_progress`, 12 `pending` and 2 `blocked` items, the prompt produced by PRD-014's `assemble()` contains the todo block at or below `todo.promptBudgetBytes` (2048), shows `done` as a count with no completed item's text present, enumerates the active item and both blocked items with their reasons, and renders the overflowing pending tail as a `+N more pending` line; two consecutive assemblies of the unchanged list produce byte-identical blocks — Evidence: tests/todo/prompt.spec.ts — a 22-item list renders ≤ 2048 bytes with `done 7` as a count and no completed item text, the active item and both blocked reasons present, the pending tail collapsed to `+N more pending`, two assemblies byte-identical, and an empty list contributes no bytes.
- [x] - [ ] AC-5 [local; actor: agent]: With JEV disabled in config, a `MEDIUM`-complexity task still forms a list through the deterministic fallback and that list still drives the PRD-013 boundary to the same continue/stop outcomes as AC-3, with the `todo.needed` decision logged `fallback_used: true`; a `LOW`-complexity task with no active PRD forms no list, emits no todo block into the assembled prompt, and exposes no `todo_add` tool — Evidence: tests/todo/prompt.spec.ts — with JEV disabled, a MEDIUM task still forms a list through the deterministic fallback, the decision row for `todo.needed` records `fallbackUsed: true`, and that list drives the continue/drained/all-blocked outcomes; a LOW task with no PRD forms no list and no todo block.
- [x] - [ ] AC-6 [local; actor: agent]: With no active PRD on a multi-step task, the executor's `todo_add` tool call appends an item that appears in the next `/todo` listing and in the next assembled prompt; on a single-step task the same tool is absent from the executor's tool set and an attempted call is refused by the capability router rather than silently creating a list — Evidence: tests/todo/prompt.spec.ts — a HIGH/no-PRD admission exposes the `todo_add` tool, an admitted call appends an item visible in the next listing and the assembled prompt, and an unadmitted call is refused leaving the list empty.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `/todo` command surface (list, `add`, `start`, `done`, `block`, `unblock`, `drop`, `clear`) | User types `/todo …` → PRD-016 `dispatch()` → `src/commands/todo.ts` (created in Phase 1) → `src/todo/state.ts` (created in Phase 1) | New capability; registers through PRD-016's registry, which this PRD does not modify | AC-1 |
| Todo list persisted with the session | Any `/todo` mutation → `WorkingState` field written through PRD-014's persistence (field added in Phase 1) | New field on an existing record; no new store, no second id space | AC-1 |
| PRD-derived list and evidence-governed status | Each execution boundary and each `/todo` read → `syncFromPrd()` in `src/todo/derive.ts` (created in Phase 2) over PRD-012's units and PRD-010's gate | New; replaces hand-maintained checklists for PRD tasks. A manual `done` on a derived item is rejected, not honored | AC-2 |
| Remaining-work predicate for the goal loop | PRD-013 boundary evaluation → `remainingWork()` in `src/todo/goal.ts` (created in Phase 3) | New input to an existing engine; PRD-013 keeps ownership of every stop condition | AC-3 |
| Compact todo block in the assembled prompt | Every model request → PRD-014 `assemble()` → `renderTodo()` in `src/todo/render.ts` (created in Phase 4) | New VOLATILE-layer block; replaces re-emitting checklist prose into the transcript | AC-4 |
| `todo_add` executor tool and the `todo.needed` site | Executor tool call → capability router (PRD-005/PRD-006) admitting `todo_add` from `src/todo/render.ts`; site entry declared in `src/todo/goal.ts` against PRD-002's registry (both created in Phase 4) | New tool and new site; registry and router are owned elsewhere | AC-5, AC-6 |

## Execution Phases

#### Phase 1: The list, its transitions and `/todo`
**Status:** NOT STARTED
**ACs:** AC-1
**Files:**
- `src/todo/state.ts` (new) — `TodoItem`, the ordered list on `WorkingState`, `add` / `start` / `complete` / `block` / `unblock` / `drop` / `clear`, promotion rule.
- `src/commands/todo.ts` (new) — the `/todo` handler registered through PRD-016's registry; default action is the listing.
- `src/context/working-state.ts` (edited) — one `todo: TodoItem[]` field on the existing record.
- `tests/todo/state.spec.ts` (new) — live-session fixture driving the command surface.

**Implementation:** Ids are short stable slugs derived from insertion index, so a user can type them. Every mutation goes through one `applyTransition()` writer — the single-writer shape is what makes "at most one `in_progress`" and "blocked is never auto-promoted" structural rather than a convention repeated in eight handlers. `complete()` finds the next item whose status is exactly `pending`, scanning forward from position zero in list order, and promotes it; if none exists the list simply has no active item, which is a valid state and not an error. `start` on a second item returns the active item's id in its message instead of mutating. `clear` on a list containing derived items removes only items without a `criterion`. Persistence is a field write on `WorkingState` — no serializer, no migration for a shape that has never shipped. Unknown ids produce a message naming the valid ids rather than throwing.

**Verification:** E1 — `npx vitest run tests/todo/state.spec.ts`: in one real session, dispatches the AC-1 command sequence through PRD-016's `dispatch()` and asserts the resulting listing item-by-item, that exactly one item is `in_progress` after the `done`, that the promoted item is `c` and not the blocked `b`, that `/todo start <b>` while `c` is active leaves `c` active and names it, and that `unblock` returns `b` to `pending` with `c` still active; then reloads the session's `WorkingState` and asserts the list round-trips. Covers AC-1 and the distinct risks of promotion picking a blocked item, of two concurrently active items, and of a list that exists only in memory.
**Checkpoint:** done

#### Phase 2: Derivation from the PRD and evidence-governed status
**Status:** NOT STARTED
**ACs:** AC-2
**Files:**
- `src/todo/derive.ts` (new) — `syncFromPrd()`: reconcile PRD-012 units/criteria into items by criterion id, apply PRD-010 verdicts, reopen on lost `PASS`.
- `src/commands/todo.ts` (edited) — `done` on a derived item consults the gate and may refuse.
- `tests/todo/derive.spec.ts` (new) — PRD fixture with three criteria and a swappable gate verdict.

**Implementation:** Reconciliation is keyed on `criterion`, so repeated syncs are idempotent and a criterion PRD-012 reopens re-enters the list rather than duplicating. Verdict mapping is total and explicit: `PASS` → `done`; `MISSING_PROOF` and `FAILED` → `pending` (or leave `in_progress` if it is the active item); `BLOCKED` → `blocked` with the gate's reason as `blockedReason`. Reopening preserves position, so the order the PRD implies is stable across syncs. The refusal path is the point of this phase: `complete()` on an item carrying a `criterion` calls the gate first and, on anything but `PASS`, returns a refusal naming the verdict and the evidence the gate said was missing, leaving the item's status untouched. No code path anywhere in `src/todo/` can set a derived item to `done` without a `PASS`, and the test asserts that by driving the command, not by reading the source.

**Verification:** E2 — `npx vitest run tests/todo/derive.spec.ts`: with a PRD fixture exposing three remaining criteria, asserts `/todo` lists exactly those three derived items with their criterion ids; flips the gate to `PASS` for one and asserts the next sync marks only that item `done`; withdraws the `PASS` (fresh contradicting evidence) and asserts the item returns to `pending` at its original index; then calls `/todo done <id>` on an item whose verdict is `MISSING_PROOF` and asserts the status is unchanged **and** the message carries the verdict and the missing evidence kind. That last assertion is the negative control for model-asserted completion: with the gate consultation removed the command would succeed and the assertion fails. Covers AC-2 and the distinct risks of snapshot-once derivation, duplicated items on re-sync, and a completion path that bypasses the proof gate.
**Checkpoint:** done

#### Phase 3: The goal loop drains the list
**Status:** NOT STARTED
**ACs:** AC-3
**Files:**
- `src/todo/goal.ts` (new) — `remainingWork(list) -> { actionable, blocked }`.
- `src/goal/boundary.ts` (edited) — one call site reading the predicate as its "useful work remains" input and its blocker names.
- `tests/todo/goal.spec.ts` (new) — three-boundary fixture: actionable, drained, all-blocked.

**Implementation:** `remainingWork()` is a pure function over the list — no evidence reads, no gate calls, no session access — because everything it needs was already decided in Phase 2. The boundary hook is a single call: a non-empty `actionable` set means useful work remains and PRD-013 continues; an empty `actionable` set with a non-empty `blocked` set is handed to PRD-013 together with the blockers' reasons, and **PRD-013** turns that into `BLOCKED`; both empty leaves PRD-013's own evaluation untouched so a fully drained list reaches `GOAL_MET` through the engine's existing path. This PRD adds no stop condition, changes no precedence order, and never short-circuits the engine's budget or user-stop checks — the predicate is one input among the ones §42 already specifies.

**Verification:** E3 — `npx vitest run tests/todo/goal.spec.ts`: drives a real goal run over three boundaries against a session list, asserting (a) with two actionable items the session takes a further turn with no user input, (b) with the list drained the next boundary stops `GOAL_MET`, (c) with every remaining item `blocked` the boundary stops `BLOCKED` and the reason text contains a blocked item's `blockedReason`. The three cases differ only in list contents, which is itself the control that the list — not the model's self-report — decided the outcome. Covers AC-3 and the distinct risks of a loop that keeps running with nothing left to do and of an all-blocked list spinning instead of stopping.
**Checkpoint:** done

#### Phase 4: Bounded prompt block, the executor tool and the `todo.needed` site
**Status:** NOT STARTED
**ACs:** AC-4, AC-5, AC-6
**Files:**
- `src/todo/render.ts` (new) — `renderTodo(list, budgetBytes)` and the `todo_add` tool definition registered with the capability router.
- `src/todo/goal.ts` (edited) — `todo.needed` registry entry: question, `Choice`, threshold, `consequence: 'low'`, the deterministic fallback, telemetry tag.
- `src/context/prompt.ts` (edited) — emit the block in the VOLATILE layer.
- `tests/todo/prompt.spec.ts` (new) — oversized-list fixture, JEV-off fixture, single-step fixture.

**Implementation:** `renderTodo` builds the block in fixed order — header with total and done count, the active item, blocked items with reasons, then pending items — and truncates only the pending tail, replacing it with `+N more pending`, so the ceiling is met by dropping the least useful lines rather than by truncating mid-record. Completed items contribute a number and nothing else; dropped items contribute nothing. Output is a pure function of the list, giving byte-identical renders for an unchanged list. Registration of `todo.needed` supplies the fallback (`execution_complexity` ≥ `MEDIUM` or an active PRD) so PRD-002's log, PRD-015's telemetry and PRD-016's `/route` pick the site up with no further work here; with JEV disabled the fallback decides and `fallback_used: true` is recorded by PRD-002's client, not by this module. `todo_add` is handed to the capability router only when that decision says a list is warranted, so a single-step task carries no extra tool schema.

**Verification:** E4 — `npx vitest run tests/todo/prompt.spec.ts`: (a) assembles a prompt for the AC-4 fixture through PRD-014's `assemble()` and asserts the block's byte length is at most 2048, that no completed item's text appears while the done count does, that the active item and both blocked reasons are present, that the pending tail is a `+N more pending` line, and that a second assembly is byte-identical; (b) with JEV disabled, asserts a `MEDIUM` task still forms a list, that re-running E3's boundary cases yields the same continue/`GOAL_MET`/`BLOCKED` outcomes, and that the decision log row carries `fallback_used: true`; (c) with a `LOW`-complexity, no-PRD task, asserts no list forms, the assembled prompt contains no todo block, and `todo_add` is absent from the executor tool set while a forced call is refused by the router; (d) on a multi-step no-PRD task, asserts an executor `todo_add` call appears in the following `/todo` listing and in the next assembled prompt. Covers AC-4, AC-5, AC-6 and the distinct risks of an unbounded list leaking into the prompt, a cache-defeating non-deterministic render, a feature that silently requires JEV, and a tool exposed on the quick path it was supposed to stay off.
**Checkpoint:** done

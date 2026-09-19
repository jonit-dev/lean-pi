# PRD-022 — Runtime Verification & Workspace Isolation

**Status:** NOT STARTED
**Complexity:** 6 (HIGH)
Risk override: promoted MEDIUM→HIGH by score-independent risk. Score = 2 (6–10 implementation files) + 2 (new workspace-isolation module) + 2 (concurrent bounded executions and crash-path cleanup). Promotion reason: worktree teardown issues **destructive git operations against the operator's own repository** — a cleanup bug can delete uncommitted work that no test would restore. The skill's rule ("security boundaries, destructive migrations, and high-impact compatibility changes promote the mode to HIGH") applies. The promotion buys verification depth on the destructive path, not a human gate: this PRD has no owner-lane AC.
**Owner:** joao
**Depends on:** PRD-009, PRD-017
**Runtime prerequisites (not slicing dependencies):** PRD-010 (proof gate outcomes — required for AC-5), PRD-014 (`artifact://` store backing `EvidenceRecord.artifactRef`), PRD-007 (executor bounded-run boundary — required for AC-6). PRD-010 shares this PRD's PRD-009 prerequisite, so the slicing order holds transitively.

## Context

**Covers:** none (ROADMAP §35, §40, §47, §60)

Two P1 items from ROADMAP §60 — `worktrees` and `browser/runtime verification` — have no functional requirement and therefore no owning PRD. Both are load-bearing for the proof gate, which is why they are sliced together here rather than left as unowned roadmap bullets.

Repository state: `/home/joao/projects/lean-pi` contains exactly one file, `docs/PRDs/v1/ROADMAP.md`. There is no source tree. Every path below is a **planned** path created by this PRD or by a dependency PRD; no existing `file:line` is cited because none exists.

What the roadmap fixes:

- §35 lists the deterministic verifier set. PRD-009 delivers the static half (compile, typecheck, targeted test, full suite, lint, formatter, static analysis, build, git diff/status, package validation). Four verifiers in that list need a *running program* and are unowned: **runtime smoke test**, **browser test**, **screenshot comparison**, **CLI invocation**. §35 also states the exact verifier set is derived from task requirements — so these are selected, not always-on.
- §40 makes the gap concrete: unit tests pass, no browser evidence, JEV returns `UI_VERIFICATION_REQUIRED`, and "LeanPi then exposes/uses the appropriate browser capability". Today there is no such capability, so that recovery branch dead-ends: the loop would re-request evidence it cannot collect until §41's loop limit fires and the task is reported BLOCKED for a reason that is actually a missing implementation.
- §41 forbids manufacturing evidence to satisfy the gate. A runtime verifier that reports `pass` without running the program is exactly the failure this PRD must not ship.
- §60 lists `worktrees` because bounded executions should not mutate the operator's live checkout — especially external harness workers (Claude Code, Codex) which run their own edit loops in the working directory.
- §47 lists `destructive git operations` as a first-class permission scope, and PRD-017 owns it. `git worktree remove --force` and branch deletion are exactly that scope.

The two halves belong in one PRD because they share the same seam: an `EvidenceRecord`'s `workspaceHash` must identify the workspace the evidence was actually collected in. Runtime evidence gathered inside an isolated worktree and stamped with the main checkout's hash is stale evidence wearing a fresh label — the gate would accept proof from a tree that no longer exists.

## Solution

Two capabilities, both small, both plugged into seams PRD-009 and PRD-017 already own.

**1. Runtime verifiers.** Four functions with PRD-009's existing verifier signature, registered into PRD-009's verifier map. No plugin framework, no verifier base class, no lifecycle hooks — PRD-009 already has a map from verifier kind to function, and this PRD adds four entries.

- `runtime_smoke` — start the task's run command, wait for a configured readiness signal (log pattern or TCP port) with a timeout, then terminate. Evidence: pass/fail, exit code, captured stdio in `artifactRef`.
- `cli_invocation` — run the task's binary with recorded argv and stdin, compare exit code and stdout against the expectation declared in the execution contract.
- `browser_test` — drive a headless browser to a URL, assert named selectors/text are present, capture a trace.
- `screenshot_compare` — capture a screenshot and compare it against a stored baseline with a pixel-difference threshold, writing the diff image as an artifact.

Ponytail on the browser stack: LeanPi is a Pi extension and the Pi harness already exposes a Chromium automation facility (`browser.open` → tab handles with `observe`/`click`/`screenshot`/`evaluate`). `browser_test` and `screenshot_compare` drive **that**, not a second bundled Playwright install. The only new dependency is a PNG comparison (`pixelmatch` + `pngjs`); hand-rolling a PNG decoder is not laziness, it is a second bug. If Pi's browser facility is unavailable at runtime, the verifier returns `unavailable` — a distinct status from `fail` — so the gate reports "could not obtain browser evidence" instead of "the UI is broken".

**Selection stays deterministic-first.** The verification planner picks the verifier set from the execution contract's declared surface: an acceptance criterion describing rendered UI selects `browser_test`; one describing a command's output selects `cli_invocation`; one describing a service starting selects `runtime_smoke`. PRD-010's `UI_VERIFICATION_REQUIRED` / `RUNTIME_TEST_REQUIRED` classification refines that selection during missing-proof recovery; it does not create it. With JEV off, the deterministic rule alone still reaches the browser verifier — the runtime verification path must never require JEV (§58: JEV is not required for basic operation; §49: JEV must never be a single point of failure).

**2. Worktree isolation.** One module wrapping `git worktree` via `child_process`. No isolation abstraction layer, no container runtime, no second VCS backend.

`runIsolated(runId, opts)` creates `.leanpi/worktrees/<runId>` on a detached HEAD at the current commit, hands the executor that path as its working directory, and on completion produces a deterministic patch (`git diff` against the base commit, plus a manifest of untracked files) keyed by `runId`. The session surfaces that patch; applying it to the main checkout is a separate, explicit step. Cleanup removes the worktree and prunes its administrative entry.

Three properties the implementation must actually hold, because each has a plausible destructive failure:

- **Cleanup is idempotent and crash-safe.** A worktree orphaned by a killed executor is reclaimable on the next run: startup prunes `.leanpi/worktrees/*` entries with no live run. Orphan reclamation is the reason cleanup cannot simply live in a `finally` block.
- **Cleanup never destroys work it did not create.** Removal refuses if the worktree contains changes not represented in the surfaced patch; it reports them rather than forcing. `--force` is used only after the patch has been written and verified to reproduce the worktree's tracked state.
- **Every destructive git call routes through PRD-017.** Worktree creation, removal and pruning request the `destructive git operations` scope. Under `DENY` the isolated run is refused before any directory is created; under `ASK` the prompt names the scope and the concrete path.

**Evidence provenance.** Verifiers running inside a worktree stamp `EvidenceRecord.workspaceHash` with **that worktree's** state, not the main checkout's. This is what lets PRD-009's staleness rule and §39's "no evidence is stale" clause mean something once isolation exists.

**Relevant §58 non-goals restated.** No correctness guarantee without external evidence: an `unavailable` verifier result never upgrades to `pass`, and §41's ban on manufactured evidence is enforced by the negative controls in every phase below. No unbounded autonomy: runtime verifiers carry explicit timeouts and terminate the processes they start; worktree runs are bounded executions with a cleanup obligation. No requirement for cloud models or JEV: every verifier here is deterministic and runs with JEV disabled. No blanket capability exposure: the browser capability is exposed to a run only when the verifier set selects it.

**Risks.** (a) Flaky browser/screenshot evidence producing false failures — mitigated by a configurable pixel threshold, a fixed viewport, and reporting `unavailable` distinctly from `fail`. (b) Worktree cleanup deleting operator work — mitigated by the refuse-on-unrepresented-changes rule and the AC-8 crash-path test. (c) Runtime verifiers leaking processes — mitigated by process-group termination and an AC assertion that no child survives the verifier.

## External Skill Dependencies

LeanPi consumes the operator's already-installed skills; it does not reimplement them. Paths below are the **discovery defaults**, not hard-coded absolutes — product code resolves them through the configured discovery order (project-local `.claude/skills` / `.codex/skills` → user global roots → plugin skill dirs), and a missing skill degrades to the deterministic behaviour named in each row.

| Skill | Verified path | How this PRD uses it |
|---|---|---|
| `git-worktree` | `/home/joao/.claude/skills/git-worktree/SKILL.md` (mirror `/home/joao/.codex/skills/git-worktree/SKILL.md`) | Source of truth for worktree layout, reuse of task checkouts, disk auditing and post-task cleanup conventions. `src/workspace/worktree.ts` follows this skill's directory placement and cleanup discipline rather than inventing a private convention; when the skill is absent the module falls back to its documented defaults (`.leanpi/worktrees/<runId>`, prune-on-start). |
| `visual-feedback-loop` | `/home/joao/.codex/skills/visual-feedback-loop/SKILL.md` | Conventions for screenshot capture, responsive checks and visual diffing that `screenshot_compare` follows — viewport handling, baseline storage, diff thresholds. |
| `screenshot-match-component` | `/home/joao/.codex/skills/screenshot-match-component/SKILL.md` | The iterative capture/compare loop this PRD's `screenshot_compare` verifier mechanises for the gate's `UI_VERIFICATION_REQUIRED` branch. |
| `e2e-testing-patterns` | `/home/joao/.codex/skills/e2e-testing-patterns/SKILL.md` | Selector strategy and flake-avoidance conventions for `browser_test` assertions. |
| `local-self-verification` | `/home/joao/.codex/skills/local-self-verification/SKILL.md` | What counts as acceptance evidence for a locally runnable app/CLI — shapes the `runtime_smoke` and `cli_invocation` readiness and assertion contracts. |
| `prd-creator` | `/home/joao/.claude/skills/prd-creator/SKILL.md` (mirror `/home/joao/.codex/skills/prd-creator/SKILL.md`) | Authoring contract for this PRD document itself. Not consumed by product code. |

## JEV Decision Sites

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| None — this PRD owns no decision site. | — | — | — | — |

This PRD is a **capability provider** for decisions owned elsewhere: PRD-010's missing-proof classification (`UI_VERIFICATION_REQUIRED` / `RUNTIME_TEST_REQUIRED`) and proof-sufficiency site, and PRD-009's regression-scope site. It registers no new call site, so nothing is added to PRD-002's decision-site registry by this PRD.

The obligation that falls on this PRD instead is the **fallback path**: verifier selection is deterministic-first (declared surface in the execution contract → verifier kind), so with JEV disabled the browser and runtime verifiers are still selected and still run. AC-5 asserts both directions — JEV-driven recovery flips the gate, and the same fixture with JEV off still acquires browser evidence through the deterministic rule. Per-run verifier invocations are tagged so PRD-015's telemetry can attribute them to the PRD-010 site that requested them.

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: Runtime smoke — for a fixture service task, the session's verification run starts the service, observes its readiness signal, and stores an `EvidenceRecord{kind:'runtime_smoke', status:'pass'}` retrievable from PRD-009's evidence store with captured stdio at `artifactRef`; the same verifier against a fixture whose service exits on boot records `status:'fail'` with the boot stderr in the artifact, and no child process survives either run. — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: CLI invocation — running the fixture CLI task's verification produces an `EvidenceRecord{kind:'cli_invocation'}` whose artifact contains the real captured stdout and exit code; changing the contract's expected output to a value the binary does not emit flips the record to `fail` and names the mismatch. — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: Browser test — for a fixture web page task, the verifier drives Pi's browser facility, asserts the declared selector, and records `kind:'browser_test', status:'pass'` with a trace artifact; removing that element from the fixture yields `fail` naming the selector, and with the browser facility disabled the record is `unavailable` — distinct from both `pass` and `fail` — and the gate reports missing browser evidence rather than a UI defect. — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: Screenshot comparison — the verifier captures the fixture page and compares against its stored baseline at the configured threshold: an unchanged page passes, a fixture with a deliberately shifted element exceeds the threshold and fails, and the diff image is retrievable through the recorded `artifact://` reference. Deleting the baseline produces an explicit `unavailable` (baseline missing), never a pass on an absent comparison. — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: Gate closure through the real loop — for a fixture UI task whose unit tests pass but whose acceptance criterion is UI-observable, one session run records the proof gate returning `UI_VERIFICATION_REQUIRED` on the first evaluation, the recovery loop selecting and running the browser verifier, and the second evaluation returning PASS with the browser evidence in the packet; both gate results are recorded in the same run so the flip is observable. Re-running the identical fixture with JEV disabled still acquires browser evidence via the deterministic verifier-selection rule and reaches the same PASS. — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: Worktree isolation — a bounded execution started with `isolation: worktree` edits files and completes; during and after the run `git status` in the main checkout reports no modifications from that run, and the session surfaces a patch keyed by the run id that contains exactly the executor's changes including untracked files. — Evidence: pending.
- [ ] AC-7 [local; actor: agent]: Deterministic surfacing — applying the surfaced patch to a clean main checkout produces file contents byte-identical to the worktree's, verified by comparing content hashes of every changed path; applying it twice is rejected rather than silently duplicating. — Evidence: pending.
- [ ] AC-8 [local; actor: agent]: Cleanup, including the crash path — after a normal completion `git worktree list` shows only the main checkout, the run directory under `.leanpi/worktrees/` is gone, and no leftover branch remains. After a run whose executor is killed mid-edit, the next session start reclaims the orphaned worktree and reaches the same clean state; a worktree holding changes not represented in the surfaced patch is refused for removal with those paths named, not force-deleted. — Evidence: pending.
- [ ] AC-9 [local; actor: agent]: Permission scope — with PRD-017 policy `destructive git operations: DENY`, starting a worktree-isolated run is refused with an error naming that scope and no directory is created under `.leanpi/worktrees/`; under `ASK` the prompt names both the scope and the concrete worktree path before creation, and declining leaves the filesystem unchanged. — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Runtime and CLI verification | Session verification run → PRD-009's verifier map in `src/verify/registry.ts`, entries `runtime_smoke` and `cli_invocation` implemented in `src/verify/runtime/{smoke,cli}.ts` (registered in Phase 1) | Extends PRD-009's verifier set; the §35 static verifiers are unchanged | AC-1, AC-2 |
| Browser and screenshot verification | Same verifier map, entries `browser_test` and `screenshot_compare` in `src/verify/runtime/{browser,screenshot}.ts`, driving Pi's browser facility (registered in Phase 2) | New; no bundled second browser automation stack | AC-3, AC-4 |
| Missing-proof recovery reaching runtime evidence | PRD-010's gate result `UI_VERIFICATION_REQUIRED` / `RUNTIME_TEST_REQUIRED` → `src/verify/planner.ts` `selectVerifiers()` → the runtime verifiers (wired in Phase 3) | Closes §40's currently dead-ending recovery branch; the deterministic selection rule remains primary so the path works with JEV off | AC-5 |
| Isolated bounded execution | Executor run with `isolation: worktree` → `src/workspace/worktree.ts` `runIsolated()`, invoked from PRD-007's executor run boundary (wired in Phase 4) | New; the in-place execution path remains the default and is unchanged | AC-6, AC-7, AC-8 |
| Destructive git permission enforcement | `src/workspace/worktree.ts` → PRD-017's permission check for the `destructive git operations` scope (wired in Phase 4) | Reuses PRD-017's scope; no parallel permission logic | AC-9 |

## Execution Phases

#### Phase 1: Runtime smoke and CLI invocation verifiers
**Status:** NOT STARTED
**ACs:** AC-1, AC-2
**Files:** `src/verify/runtime/smoke.ts` (start command, readiness signal, timeout, process-group teardown); `src/verify/runtime/cli.ts` (argv/stdin invocation, exit code and stdout comparison); `src/verify/registry.ts` (two new map entries — PRD-009 owns the file); `tests/fixtures/runtime/` (a service fixture, a boot-failure fixture, a CLI fixture).
**Implementation:** Both verifiers take the execution contract's declared run command, readiness signal and expectation; neither infers them. Readiness is a log pattern or TCP port with an explicit timeout; on timeout the record is `fail` with the captured output, never `pass`. Children are started in their own process group and terminated by group so a hung server cannot outlive the verifier. Each record carries `workspaceHash` for the workspace the verifier actually ran in, `exitCode`, and an `artifactRef` to captured stdio.
**Verification:** E1 — run the session's verification over the service fixture and the CLI fixture; assert the stored records are `pass` with real captured stdio, and that the boot-failure fixture and the mismatched-expectation fixture record `fail` with the cause named (AC-1, AC-2). Negative control for the "manufactured evidence" and "envelope ≠ state" smells: assert the artifact contains the fixture's actual emitted marker string — a verifier returning a literal `pass` without executing cannot produce it. Assert no child process from either run remains after the verifier returns.
**Checkpoint:** pending

#### Phase 2: Browser and screenshot verifiers
**Status:** NOT STARTED
**ACs:** AC-3, AC-4
**Files:** `src/verify/runtime/browser.ts` (navigate, assert selectors/text, capture trace); `src/verify/runtime/screenshot.ts` (capture, baseline compare, diff artifact); `src/verify/registry.ts` (two further entries); `tests/fixtures/runtime/web/` (page fixture, element-removed variant, shifted-element variant, stored baseline).
**Implementation:** Both drive Pi's existing browser facility through a tab handle; no browser engine is bundled. Viewport and device scale are fixed in the verifier so screenshots are comparable across runs. Comparison is `pixelmatch` over decoded PNGs with a configurable ratio threshold defaulting conservatively; the diff image is written to PRD-014's artifact store and its `artifact://` reference recorded. Absent browser facility → `unavailable`; absent baseline → `unavailable` with the expected baseline path named. `unavailable` is a first-class status distinct from `fail`, and the gate treats it as missing evidence.
**Verification:** E2 — run the browser verifier over the page fixture (assert `pass` with a trace artifact), the element-removed variant (assert `fail` naming the selector), and with the browser facility disabled (assert `unavailable`, and that the gate reports missing evidence rather than a UI defect) (AC-3). E3 — screenshot verifier over the unchanged fixture (`pass`), the shifted-element variant (`fail`, diff image retrievable via its `artifact://` reference), and with the baseline deleted (`unavailable`) (AC-4). The deleted-baseline case is the "stale/absent artifact" control: the gate must not pass on a missing comparison.
**Checkpoint:** pending

#### Phase 3: Missing-proof recovery reaches runtime evidence
**Status:** NOT STARTED
**ACs:** AC-5
**Files:** `src/verify/planner.ts` (map declared acceptance-criterion surface and PRD-010 gate classifications to verifier kinds); `tests/fixtures/runtime/ui-task/` (a task whose unit tests pass and whose acceptance criterion is UI-observable).
**Implementation:** `selectVerifiers()` derives the verifier set deterministically from the execution contract's declared surface, then augments it from PRD-010's missing-proof classification when the gate has returned one — `UI_VERIFICATION_REQUIRED` → `browser_test` (+ `screenshot_compare` when a baseline exists), `RUNTIME_TEST_REQUIRED` → `runtime_smoke` or `cli_invocation` by declared surface. Selection never depends on JEV being enabled. §41's loop limit still bounds the recovery loop; a verifier returning `unavailable` ends recovery with a BLOCKED result naming the missing capability instead of retrying indefinitely or upgrading to a pass.
**Verification:** E4 — run the UI fixture task end-to-end through the session; assert the run records the first gate evaluation as `UI_VERIFICATION_REQUIRED`, the browser verifier executing, and the second evaluation as PASS with browser evidence in the packet — the two gate results captured in one run so the flip is observed rather than inferred (AC-5). Negative control for "self-comparison" and "assertion already satisfied by baseline": assert the two recorded gate evaluations carry different evidence-packet hashes, and confirm that with the browser verifier unregistered the same fixture ends BLOCKED, not PASS — proving the pass is caused by the acquired evidence. Then re-run the identical fixture with JEV disabled and assert browser evidence is still acquired and the run still reaches PASS via the deterministic rule.
**Checkpoint:** pending

#### Phase 4: Worktree isolation, surfacing, cleanup and permission scope
**Status:** NOT STARTED
**ACs:** AC-6, AC-7, AC-8, AC-9
**Files:** `src/workspace/worktree.ts` (`runIsolated`, `surfacePatch`, `cleanup`, `pruneOrphans`); `src/executor/run.ts` (honour `isolation: worktree` — PRD-007 owns the file); `tests/fixtures/workspace/` (a scratch repository fixture).
**Implementation:** `runIsolated` requests PRD-017's `destructive git operations` scope **before** creating anything; on `DENY` it throws a named-scope error and the filesystem is untouched. It then creates `.leanpi/worktrees/<runId>` on a detached HEAD at the base commit and runs the executor there. `surfacePatch` emits `git diff` against the base commit plus a manifest of untracked file contents, keyed by run id; applying it records the applied run id so a second apply is rejected. `cleanup` compares the worktree's tracked state against the surfaced patch and refuses removal — naming the unrepresented paths — if they disagree; only after agreement does it remove the worktree and prune the administrative entry. `pruneOrphans` runs at session start and reclaims `.leanpi/worktrees/*` entries with no live run, which is what makes the crash path recoverable rather than a leak. Verifier records produced inside a worktree stamp that worktree's `workspaceHash`.
**Verification:** E5 — on the scratch repository fixture, run a bounded execution with `isolation: worktree` that edits a tracked file and adds an untracked one; assert the main checkout's `git status` is unchanged and the surfaced patch contains both changes (AC-6). Apply the patch to a clean copy and assert per-path content hashes match the worktree's exactly; apply again and assert rejection (AC-7). E6 — assert `git worktree list` shows only the main checkout after completion and no leftover branch; kill an executor mid-edit, restart the session, and assert the orphan is reclaimed to the same clean state; stage an unrepresented change in a worktree and assert removal is refused with that path named rather than forced (AC-8). E7 — with the scope set to `DENY`, assert the isolated run is refused with the scope named and `.leanpi/worktrees/` contains no new directory; with `ASK`, assert the prompt text contains both the scope and the concrete path and that declining leaves the filesystem unchanged (AC-9). E6's crash and refusal cases are the destructive-path evidence the HIGH risk override exists to require; they run against the scratch fixture only, never the operator's repository.
**Checkpoint:** pending

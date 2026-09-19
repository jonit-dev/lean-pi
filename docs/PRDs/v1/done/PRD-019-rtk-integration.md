# PRD-019 — RTK Integration

**Status:** DONE (verified 2026-09-19)
**Complexity:** 4 (MEDIUM)
**Risk override:** none — no security boundary, no destructive migration; the one high-impact risk (silently losing tool output) is covered by the byte-identical recovery assertion in AC-1.
**Owner:** joao
**Depends on:** PRD-002, PRD-009, PRD-014, PRD-015

## Context

**Covers:** FR-110, FR-111, FR-112, FR-113; ROADMAP §19, §21, §50, §57, §60.

Problem. Shell and test commands produce the largest single class of tokens a coding harness pays for. RTK (or an equivalent tool-output reducer) shrinks that text before it reaches a model context. ROADMAP §19 records the counter-evidence: an independent JetBrains 2026 benchmark measured *no* end-to-end cost benefit at high reasoning effort and a cost *increase* in its low-reasoning configuration, even though command output shrank. Byte savings at the shell boundary are not the same quantity as session cost.

Current behavior. The repository is greenfield: `docs/PRDs/v1/ROADMAP.md` is the only file. Nothing reduces tool output today because nothing runs tool calls yet. PRD-014 establishes `src/context/artifacts.ts` (the `artifact://` store and `WorkingState`), which is the single place every large tool result already passes through; PRD-009 establishes `src/verify/evidence.ts` (`EvidenceRecord`), which is how a benchmark run decides whether a task was actually solved; PRD-002 establishes the JEV client and the decision-site registry this PRD registers its one (low-value, default-off) site with.

This PRD therefore does two separable things: make reduction *available and safe* (optional, reversible, never a hard dependency), and make its promotion to default *conditional on a recorded measurement*. FR-112 is a gate, not a goal. A measurement showing no benefit is a valid, PRD-closing outcome — it simply keeps RTK non-default, and the gate is what prevents the default from ever being flipped on intuition.

Files inspected: `docs/PRDs/v1/ROADMAP.md` §19 (modes and the JetBrains counter-evidence), §21 (reversible context pruning, artifact semantics), §50 (asymmetric use of JEV confidence), §52 (telemetry record shape), §57 (the seven RTK A/B metrics), §60 (P1: "RTK experimentation"), §51 RTK FR block (FR-110–113).

## Solution

Reduction plugs into the boundary PRD-014 already owns, not into each tool. Every large tool result routes through `capture()` in `src/context/artifacts.ts`; RTK becomes one optional reducer call inside that function. Consequence: one wiring point covers shell, test runners, build output and any future tool, and the raw-retention guarantee (FR-113) is the store's existing behavior rather than new bookkeeping.

Consumer flow:

> user issues a task → executor runs a shell/test tool → tool result reaches `capture()` (PRD-014) → `reduceToolOutput()` (`src/context/rtk.ts`) applies or skips reduction per mode → executor context receives the compact text plus an `artifact://` reference → the executor (or the user, via the artifact store) expands that reference and gets the exact original bytes back.

Modes, per ROADMAP §19 `rtk: off | on | auto | experiment`:

| Mode | Behavior |
|---|---|
| `off` | No reducer process is spawned; output is stored and surfaced unchanged. |
| `on` | Reduce every tool output above the minimum-size floor. |
| `auto` | Reduce per the deterministic output-class rule (tool kind + byte size + line count). Default during evaluation. |
| `experiment` | Deterministic A/B: arm chosen by hash of the task id, both arms recorded, so ordinary sessions generate FR-112 evidence without a dedicated benchmark run. |

RTK is invoked as an external process over stdin/stdout with a timeout. Absence, non-zero exit, timeout, or malformed output all degrade to raw passthrough — RTK is never on a critical path (FR-111). `reduceToolOutput()` is a plain function, not a reducer interface: there is exactly one implementation and speculative pluggability would be dead flexibility.

The FR-112 gate is structural rather than procedural. `bench/rtk-ab.ts` runs the §57 comparison (identical tasks, identical models, RTK OFF vs ON) and writes `src/core/rtk-measurement.json` containing the seven metrics for both arms plus a derived `verdict`. Cost per success for each arm comes from PRD-015's records through `src/telemetry/store.ts` (`cost.effective_cost` over `result.success`), not from a second measurement. The verdict rule itself is one exported function, `verdictFromArms(off, on)`, beside `resolveRtkDefault(report)` — so there is exactly one implementation of "did RTK help" in the repository. The shipped default is *computed from that file* — `resolveRtkDefault(report)` returns `'on'` only when the recorded verdict is an improvement, otherwise `'auto'`. There is no second literal to drift: the measurement is the single owner of the default. A no-benefit verdict is the expected initial state and closes this PRD with RTK non-default.

Scope boundary: this PRD owns the RTK profile, the report schema, the verdict rule and the gate. The suite-wide run over the full 50–100 task benchmark and subscription backends belongs to PRD-021, which imports `verdictFromArms()` and regenerates the same `src/core/rtk-measurement.json` in this PRD's schema rather than computing a second verdict; because the default is derived from that file, the later run re-decides the default with no code change here. The fixture set used for acceptance is the repository's own shell-heavy build/test commands — representative for the property being measured (raw output volume → context tokens → retries → wall time), and deliberately not a toy string.

Relevant non-goals restated from ROADMAP §58: no correctness claims without evidence — RTK's default cannot move without a recorded end-to-end measurement; no unbounded autonomy — the gate is code, not a prompt instruction; no mandatory cloud models — RTK is an optional local binary and its absence changes nothing about session behavior; no JEV requirement for basic operation — the one JEV site below is off by default and the deterministic rule is primary.

## External Skill Dependencies

None.

## JEV Decision Sites

| Decision | Atomic question(s) | Return type (Choice/Score/Noul) | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| `rtk.reduction_policy` — whether to reduce a specific tool output whose size falls in the ambiguous band | "Given tool kind `<k>`, `<n>` bytes, `<l>` lines, structured=`<bool>`: is reducing this output more likely to lower total task cost than to cause a re-read?" | Choice (`reduce` \| `keep_raw`) with confidence | Output-class rule table (tool kind + byte/line thresholds) — primary path, used whenever the site is disabled (the default), JEV is unavailable, or confidence is below threshold | ★★☆☆☆ |

The rating is deliberately weak, so the deterministic rule is the shipped behavior and the site is **off by default** (`rtk.jev_policy: false`). The site registers with PRD-002's decision-site registry (id, question set, return type, `consequence` class `low`, non-null fallback, telemetry tag) so its accuracy is measurable by PRD-021 before anyone considers enabling it.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: With `rtk: on`, a session shell tool producing >64 KB of output shows the executor a reduced summary ending in an `artifact://` reference, and expanding that reference returns bytes identical to the command's original stdout/stderr (SHA-256 match) together with its exit status and timestamp — Evidence: tests/rtk/rtk.test.ts — `rtk: on` over a 104 KB output shortens the text, ends in the `artifact://` pointer, and the store expands to bytes whose sha256 equals the original; exit code and timestamp survive on the store record.
- [x] AC-2 [local; actor: agent]: With `rtk: off`, the same tool call places the unmodified raw output in the executor context and spawns no reducer process (assert on the process-spawn count, not only on the text) — Evidence: tests/rtk/rtk.test.ts — `rtk: off` returns the text byte-identical with a null artifact and zero reducer spawns (the counter wraps the real spawn), and matches PRD-014's own capture text byte-for-byte at a compacting threshold.
- [x] AC-3 [local; actor: agent]: With `rtk: on` and the reducer binary absent, failing, or exceeding its timeout, the tool call still returns raw output to the executor, the session reports no error to the user, and the run's working state records the reduction as unavailable — Evidence: tests/rtk/rtk.test.ts — ENOENT, non-zero exit and timeout each return the raw output without throwing, record `unavailable` with its reason, and leave the raw bytes expandable byte-identically.
- [x] AC-4 [local; actor: agent]: With `rtk: auto`, output below the deterministic rule's threshold reaches the executor untouched while output above it is reduced, and each tool call's mode/decision/bytes-in/bytes-out is queryable from the run's working state — Evidence: tests/rtk/rtk.test.ts — `auto` leaves below-floor output untouched with zero spawns and reduces a large test log with one, the experiment arm is stable per task id and differs across arms, and every record is readable via `rtkCallsOf()` on a real `buildWorkingState()`.
- [x] AC-5 [local; actor: agent]: With `rtk.jev_policy` enabled, an ambiguous-band output that the deterministic rule would keep raw is reduced when the `rtk.reduction_policy` site answers `reduce` above its confidence threshold, and the working-state record attributes the call to the site; with the site at its default (disabled) the same output follows the deterministic rule, the record shows the fallback was used, and no JEV call is issued — Evidence: tests/rtk/rtk.test.ts — an ambiguous-band output is `keep_raw` by rule, a stub answering reduce at 0.9 flips it with `decided_by: site`, disabled JEV and a 0.2-confidence answer both fall back to the rule with exactly zero JEV calls.
- [x] AC-6 [local; actor: agent]: The A/B runner over the shell-heavy fixture task set produces `src/core/rtk-measurement.json` carrying all seven ROADMAP §57 metrics (shell-output size, context tokens, model calls, retries, solve rate, wall time, cost per success) for both the OFF and ON arms, with solve rate taken from PRD-009 evidence records rather than executor self-report — Evidence: tests/rtk/rtk-default.test.ts — the A/B runner writes both arms with all seven §57 metrics, `cost_per_success` re-derived from the telemetry store equals the report, and `solve_rate` stays 1 while one ON run reports `result.success=false`.
- [x] AC-7 [local; actor: agent]: The resolved default RTK mode is derived from that recorded measurement in both directions — a no-benefit report yields a non-`on` default (RTK stays non-`on`; `auto` still applies the deterministic rule per ROADMAP §19, so a below-threshold output spawns no reducer while an above-threshold one is reduced), and a report whose verdict records an improvement yields `on`; the verdict comes from the single exported `verdictFromArms()`, and no independently editable default constant exists — Evidence: tests/rtk/rtk-default.test.ts — a recorded no-benefit report resolves to `auto`, a synthetic improving report to `on`, and a missing, garbage or absent file to `auto` without throwing, with explicit config winning.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Tool-output reduction | Session shell/test tool call → `capture()` in `src/context/artifacts.ts` (created in PRD-014, reducer hook added in Phase 1) → `reduceToolOutput()` in `src/context/rtk.ts` (created in Phase 1) | Replaces raw tool text in executor context; no prior reducer exists. Raw bytes continue to be the store's canonical copy | AC-1 |
| Raw-output recovery | Executor/user artifact expansion → `artifact://` reference resolved by `src/context/artifacts.ts` (created in PRD-014) | Unchanged store contract; this PRD only guarantees reduction never bypasses it | AC-1, AC-3 |
| RTK mode configuration | Session startup → `LeanPiConfig.rtk` in `src/core/config.ts` (created in PRD-001, field added in Phase 1) | Replaces an absent setting; no legacy flag to migrate | AC-2, AC-4 |
| `rtk.reduction_policy` JEV site | Ambiguous-band tool output → `reduceToolOutput()` (created in Phase 1) → site registered with the decision-site registry in `src/jev/registry.ts` (created in PRD-002, registration added in Phase 2) | Adds an optional, default-off override above the deterministic rule; the rule remains the shipped path | AC-5 |
| Measurement-gated default | Config resolution → `resolveRtkDefault()` reading `src/core/rtk-measurement.json` (both created in Phase 3), written by `bench/rtk-ab.ts` (created in Phase 3) and regenerated by PRD-021's suite run, which imports this PRD's exported `verdictFromArms()` rather than deriving its own | Replaces a hand-set default constant — the constant is deleted, not shadowed; one verdict rule, one file | AC-6, AC-7 |

## Execution Phases

#### Phase 1: Optional reduction with guaranteed raw recovery
**Status:** DONE (verified 2026-09-19)
**ACs:** AC-1, AC-2, AC-3
**Files:** `src/context/rtk.ts` (new — `reduceToolOutput()`, process invocation, timeout, failure fallback); `src/context/artifacts.ts` (edit — call the reducer inside `capture()` after the raw bytes are persisted, never before); `src/core/config.ts` (edit — `rtk: 'off' | 'on' | 'auto' | 'experiment'` plus output-class thresholds and binary path/timeout settings); `tests/rtk.test.ts` (new).
**Implementation:** Persist raw bytes, exit status and timestamp to the artifact store first, then attempt reduction; the compact text always carries the resulting `artifact://` reference. Invoke the configured reducer command over stdin/stdout with a timeout; treat spawn failure (ENOENT), non-zero exit, timeout and empty/invalid output as "unavailable" and return the raw text unchanged while recording the reason. Never throw into the tool-call path. Binary path is configurable with a bare command name as the discovery default; no absolute path is hard-coded.
**Verification:** E1 — vitest through `capture()` with a fixture command emitting >64 KB: assert the executor-visible text is smaller and ends in an `artifact://` reference, assert SHA-256 of the expanded artifact equals SHA-256 of the original bytes (AC-1); assert `rtk: off` yields identical text and zero reducer spawns using a spawn counter, which also proves the reducer is genuinely exercised in the `on` case rather than mocked away (AC-2); assert the ENOENT, non-zero-exit and timeout paths each return raw output and mark unavailability (AC-3). Red comes from the missing reducer hook before Phase 1 lands.
**Checkpoint:** done

#### Phase 2: `auto`/`experiment` modes, per-call decision records, and the default-off JEV policy site
**Status:** DONE (verified 2026-09-19)
**ACs:** AC-4, AC-5
**Files:** `src/context/rtk.ts` (edit — deterministic output-class rule, deterministic task-id-hash arm selection for `experiment`, optional `rtk.reduction_policy` consultation); `src/context/working-state.ts` (edit — per-tool-call reduction records: mode, arm, decision, decided-by, fallback-used, bytes in/out, duration); `src/core/config.ts` (edit — `rtk.jev_policy` defaulting to `false`).
**Implementation:** The output-class rule is the primary decision: tool kind plus byte/line thresholds. `experiment` selects its arm from a stable hash of the task id so a resumed session keeps its arm and both arms accumulate comparable data during ordinary use. The JEV site is consulted only when enabled *and* the raw size falls in the configured ambiguous band; below-threshold confidence, an unavailable JEV, or a disabled site all take the rule's answer and set `fallback_used`. Register the site with PRD-002's registry (id, questions, return type, `consequence: low`, non-null fallback, telemetry tag) rather than calling the JEV client ad hoc. Records live in `WorkingState` (PRD-014), not in a new store.
**Verification:** E2 — vitest driving tool calls below threshold, above threshold and in `experiment` mode through the real store: assert the below-threshold output is byte-identical to raw, the above-threshold output is reduced, the `experiment` arm is stable across two runs with the same task id and differs for an id hashing to the other arm, and that each call's record is readable from the run's working state with matching byte counts (AC-4). E3 — same entry point with an ambiguous-band output and a stubbed registry answer `reduce`: assert the output is reduced and attributed to the site; then with the site at its default assert the rule's answer wins, `fallback_used` is set, and the JEV client received zero calls (AC-5). The zero-call assertion is the negative control against a site that silently fires when disabled.
**Checkpoint:** done

#### Phase 3: §57 A/B measurement and the measurement-derived default
**Status:** DONE (verified 2026-09-19)
**ACs:** AC-6, AC-7
**Files:** `bench/fixtures/shell-heavy.json` (new — the repository's own shell-heavy build/test/grep tasks); `bench/rtk-ab.ts` (new — runs each fixture task twice, OFF then ON, identical model role and seed, collects the seven §57 metrics from PRD-015's records via `src/telemetry/store.ts`, writes the report); `src/core/rtk-measurement.json` (new — generated, committed); `src/core/config.ts` (edit — exported `verdictFromArms(off, on)` and `resolveRtkDefault(report)`; delete any interim literal default); `tests/rtk-default.test.ts` (new).
**Implementation:** Solve rate is read from PRD-009 `EvidenceRecord` results, never from an executor's own claim; cost per success comes from PRD-015's stored `cost.effective_cost` over `result.success` in `src/telemetry/store.ts`, not from a second measurement. The report stores both arms' raw metrics plus the `verdict` returned by `verdictFromArms()` (ON must improve cost per verified success *and* not regress solve rate); that function is exported so PRD-021's suite-wide run applies the identical rule instead of restating it. `resolveRtkDefault()` returns `'on'` only for an improving verdict, otherwise `'auto'`. Record the initial measured verdict as-is — a no-benefit result is recorded and kept, not re-run until favorable.
**Verification:** E4 — run the A/B script over the fixture set; assert the emitted report contains both arms with all seven metrics populated and non-placeholder, that cost per success for each arm equals the figure recomputed from the telemetry store, and that deleting the report and re-running regenerates it rather than passing on the stale copy (AC-6). E5 — vitest calling `resolveRtkDefault()` with the recorded report and with a synthetic improving report: assert non-`on` and `on` respectively; under the no-benefit-resolved default assert an output below the deterministic rule's threshold spawns no reducer while one above it is reduced (the property separating `auto` from `on`); and grep the source to assert `verdictFromArms()` is the only verdict computation and no other assignment of a default RTK mode exists (AC-7). E5's two-direction assertion is itself the negative control: a stub always returning one value fails one branch.
**Checkpoint:** done

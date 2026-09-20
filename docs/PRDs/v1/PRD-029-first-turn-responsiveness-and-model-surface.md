# PRD-029 — First-Turn Responsiveness, Readable `/models`, and Runnable Gates

**Status:** IN PROGRESS
**Complexity:** 4 (MEDIUM); risk override: none. ~8 implementation files (2) + bounded async fan-out in `compileTask` (2); no schema, release boundary or new external integration.
**Owner:** production-hardening lane (branch `fix/production-hardening`)
**Depends on:** None (diagnoses surfaces owned by PRD-001/004/016/024)
**Lane:** single isolated worktree `/home/joao/projects/lean-pi/.worktrees/production-hardening`, base `a914b140aae94e584b9554712fb3002d0eeb2664`; no subagents.
**Cleanup:** after this PRD merges, remove this exact worktree and its `node_modules`; preserve other lanes' changes and any untracked benchmark artifacts. Do not create a separate report/ledger file; evidence lives on the ACs below.

## Context

Three production-facing defects on a stock auto-configured machine
(`quick/balanced/review_quick = opencode-go/deepseek-v4.1-flash`,
`strong/specialist/review_strong = claude/opus[1m]`), as diagnosed read-only in
the first report:

1. **A silent 1–2 s pause before the first question acts.** On a native backend
   Pi's own loop is the executor, so `before_agent_start` (`src/index.ts:713`)
   compiles first: `runLanes` → `compilerLane` (`src/commands/turn-lanes.ts:86`)
   → `compileTask` (`src/compiler/index.ts:140`). `compileTask` awaits four
   independent JEV sites sequentially (`src/compiler/index.ts:150-157`), then the
   capability-provider loop awaits skill disclosure (`src/capabilities/skill-select.ts:160,189`)
   inline. Each request carries its own `JEV_REQUEST_TIMEOUT_MS = 20_000`
   (`src/jev/client.ts:110`) and there is no per-turn budget. No
   `ctx.ui.setStatus` fires on the native path until `runLanes` returns
   (`src/index.ts:771`), so the pause is silent.
2. **`/models` is opaque.** `renderModels` (`src/commands/model.ts:61`) emits one
   six-field row per configured role. The bundled ranking (`src/capability/models.json`,
   revision 1) lists none of the vendor-reported ids the auto-config writes, so
   every row is the `undefined` branch: `coding_score: unavailable  price: unknown
   roles: unlisted  evidence: none`, while an `external_harness` probe reports
   `ok — authentication not probed` from mere executable presence
   (`src/commands/surface.ts:210`). Six near-identical walls of missing metadata
   say nothing a person can act on.
3. **The repository's own documented gates do not run.** `pnpm-workspace.yaml`
   still holds pnpm's interactive placeholders (`allowBuilds: { esbuild: set this
   to true or false, … }`); on pnpm 11.25 every `pnpm <script>` ends
   `ERR_PNPM_IGNORED_BUILDS` and exits 1, and `pnpm.onlyBuiltDependencies` in
   `package.json` is ignored by pnpm 11. Bypassing verify-deps makes the scripts
   pass, so the scripts themselves are fine — the setting home is wrong.

## Solution

Minimum truthful changes, each proven through its real consumer.

1. **Gates:** resolve `allowBuilds` in its pnpm-11 home (`pnpm-workspace.yaml`)
   from installed metadata — approve the packages whose install lifecycle is
   actually required (`esbuild`), explicitly decline the rest — and drop the
   pnpm-11-ignored `pnpm.onlyBuiltDependencies` from `package.json`. No bypass
   flags in the gates.
2. **Readable `/models`, no invented ranking data.** Do **not** add records,
   aliases, scores or prices for ids whose identity is unproven; vendor `opus[1m]`
   is not shown to be `claude-opus-4-1`. The default output becomes a short
   human-readable assignment view: configured roles grouped by their
   backend/model, each role's assignment preserved, with *one* actionable
   explanation when ranking information is missing. The detailed per-role rows,
   ranking contents and backend diagnostics move behind `--details`
   (`src/commands/model.ts`), preserving existing machine-parseable detail and
   the reachability-vs-authentication wording.
3. **Responsive, bounded first turn.** Emit a LeanPi status immediately on the
   native `before_agent_start` path *before* any JEV work, keep it through skill
   selection, and clear/replace it on success, error and cancellation; nothing is
   sent to the model. Keep the compiler's JEV sites and capability providers in
   their original dependency order and strictly sequential — the JEV client's
   `fallbackCount()` and `lastUsage()` are shared per-client state, so overlapping
   asks let one site's fallback flip a sibling to heuristics and attribute another
   site's tokens to it. Bound the whole compile with one per-turn wall-clock budget
   (~5 s) created by `runLanes` and threaded as an `AbortSignal` into `JevClient.ask`
   and its transport. On budget, every site keeps its documented deterministic
   fallback (§49). Underlying fetch and timers are cancelled; a late resolution
   after abort produces no decision-log or usage side effects and cannot surface as
   an unhandled rejection.

Reused, not new: `probeBackends`/`ProbeResult`, `capabilityRows`/`renderModelRow`,
`JevClient.ask` fallback path, `bootSession`/`startStubBackend`/`startStubJev`,
the existing `before_agent_start`/`input` hooks and `runTurn` deadline seam.
Risks: a misbehaving test transport may ignore `AbortSignal`, so `ask` must also
enforce the budget itself rather than rely on transport cooperation, and must
observe the abandoned work so a pre-aborted signal cannot leave an unhandled
rejection; progress text must not enter the LLM context (`ui.setStatus`, never
`sendMessage`). The user asked for responsiveness, not parallelism: sequential
sites plus immediate progress and a 5 s bound deliver the UX without the shared
state hazard a fan-out introduced.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: `pnpm test`, `pnpm typecheck` and `pnpm lint` each exit 0 from a clean checkout of this branch, with no bypass flags and no new warnings; skipped tests are reported. (Single gate AC — replaces the duplicate old AC-1/AC-10.) — Evidence: `pnpm test` → 106 files passed / 2 skipped, 617 passed / 7 skipped; `pnpm typecheck` exit 0; `pnpm lint` exit 0 with 35 warnings, the identical count to base `a914b14` (no new warnings). No bypass flags used.
- [x] AC-2 [local; actor: agent]: `pnpm build` exits 0 and the built CLI smoke `node bin/leanpi.js --help` prints Pi's help and exits 0 — Evidence: `pnpm build` exit 0; `node bin/leanpi.js --help` exit 0, prints `pi - AI coding assistant …`.
- [x] AC-3 [local; actor: agent]: `/models` default output is human-readable: configured roles are grouped by their *effective* assignment (`surface.bindingFor`, so a session override wins over the static config entry), repeated models are not repeated, every configured role is present, a short legend explains the role labels, missing ranking information is stated once with an actionable explanation, and the compact view performs no backend probe — Evidence: `tests/commands/model-doctor.spec.ts` "renders a readable assignment view with a role legend and no hidden probe" (grouped `quick → stub/claude-haiku-4-5`, `balanced, strong, specialist, review_quick → stub/gpt-5`; legend; no `backend:`/`reachable at`); "shows the session override as the effective assignment and explains it in --details" (override wins; `--details` adds `override:`/`configured:`); `tests/commands/model-surface.spec.ts` "states missing ranking information once…" (`not in the bundled ranking` exactly once, no probe) and "renders the auto-config model ids…" (`opencode-go/deepseek-v4.1-flash`, `claude/opus[1m]`). Red on base `a914b14`: default was the detailed row wall — `expected 'ranking revision 1 …' to contain 'Model assignments (role → backend/model):'` (5 red assertions total).
- [x] AC-4 [local; actor: agent]: `/models --details` preserves the detailed per-role rows, the ranking revision/staleness and backend diagnostics, distinguishes reachability from authentication for both backend types (`reachable at host:port; authentication not verified` for a TCP connect; `command found …; authentication not probed` for an executable), contains no credential value, and `src/capability/models.json` is byte-unchanged — Evidence: `tests/commands/model-doctor.spec.ts` "keeps the detailed ranking rows and truthful backend diagnostics behind --details": revision/staleness, per-role score/price, effective `strong → stub/gpt-5` with `configured: stub/not-a-ranked-model`, `reachable at 127.0.0.1` + `authentication not verified`, no secret. `git diff --stat src/capability/models.json` is empty. Red on base: `expected false to be true` (`--details` did not exist).
- [x] AC-5 [local; actor: agent]: on the native (`before_agent_start`) entry, against a genuinely blocked JEV transport a LeanPi status is observed while the turn is still pending, a final status replaces it on success, and the status is cleared when a registered lane throws; no message is injected into the model context — Evidence: `tests/first-turn.spec.ts` "sets a status while a compiler site is genuinely blocked, then replaces it on success" (status present and `settled === false` before the gate is released) and "clears the progress status when a registered lane throws" (last status `undefined`). Red on base: `expected 0 to be greater than 0` (no status before JEV).
- [x] AC-6 [local; actor: agent]: the compiler's JEV sites and capability providers run strictly sequentially in dependency order (gate → complexity → capability → risk), so the shared `client.fallbackCount()`/`lastUsage()` cannot contaminate a sibling's decision or token attribution; mixed success/failure with distinguishable per-site usage yields the sequential decisions and usage — Evidence: `tests/compiler/classify.spec.ts` "AC-6 (serial): a failing sibling cannot contaminate decisions or token usage": complexity usage 111 and capability 222 are each attributed to their own site, the failed risk site falls back with 0 tokens, and the successful siblings are not marked as fallbacks. Reviewer rationale: the user asked for responsiveness, not parallelism; immediate progress plus the 5 s budget deliver that, and the previous concurrent candidate's only gain was a few hundred ms at the cost of the shared-state contract. This test is the regression guard for that candidate (base `a914b14` was already sequential, so it is green on both).
- [x] AC-7 [local; actor: agent]: a transport that never resolves (or resolves only after the budget) cannot hold a turn past one per-turn budget of at most 5 s; the turn returns a contract with fallback decisions recorded with the budget reason, and a late resolution after the budget produces no additional decision row, no unhandled rejection and no state mutation — Evidence: `tests/first-turn.spec.ts` "returns within the budget when the transport never answers, with fallback decisions" (all rows `fallbackUsed`, at least one reason containing `budget`) and "drops a transport that resolves after the budget, leaving no late decision" (row count unchanged, no `jev-stub` model version, no `unhandledRejection`). Fake timers advance the 5 s budget; the transport is a synthetic hang, labelled as such, not provider timing. Red on base: no `ask(signal)`/budget exists, so the never-answering transport holds the turn until the test timeout.
- [x] AC-8 [local; actor: agent]: a compile that exhausts the per-turn wall-clock budget recovers — the turn returns fallback decisions recorded with the budget reason, and the next turn on a healthy control plane makes real, non-fallback calls because the budget is created per `runLanes` invocation and never reused — Evidence: `tests/first-turn.spec.ts` "recovers the next turn on a healthy control plane after a timed-out compile": turn 1 rows all `fallbackUsed`, turn 2 appends rows with `fallbackUsed === false`. This is a budget/timeout recovery, not user cancellation; the extension does not observe Pi's own turn cancellation (see AC-10). Red on base: the hang holds the turn until the test timeout.
- [x] AC-9 [local; actor: agent]: the new `/models` and first-turn tests fail on base `a914b14` for the stated cause and pass after the fix, with the red assertions recorded — Evidence: with `src/` stashed and the new tests in place, `tests/commands/model-surface.spec.ts` + `tests/commands/model-doctor.spec.ts` gave 5 failed / 3 passed (the five red assertions are recorded on AC-3/AC-4); the first-turn tests are new files that exercise `ask(signal)`, which base does not have, so they cannot pass there.
- [x] AC-10 [local; actor: agent]: an audit of the touched surfaces names, for each of command registration/invocation, success/streaming, cancellation, provider timeout/failure recovery, persistence/restart and repeated turns, which existing test proves it and where real external dependencies are substituted; concrete gaps get a regression test, not a speculative framework; boundaries with no test are stated as gaps — Evidence: audit table below.
- [x] AC-11 [local; actor: agent]: an honest live validation, separate from the fake process/network tests, using existing credentials in a read-only isolated temp workspace, makes at most one tiny end-to-end prompt through `leanpi` on an available configured backend and reports the sanitized result and the real decision log; or reports the exact sanitized failure with no retries or extra spend — Evidence: live check below.

## Real-entry audit (AC-10)

Each row names the property, the test that proves it with its assertion, and the substituted dependency. "Real" means the production entry (`activate`/`createLeanPiSession`, the registered handler, the real client) is the code under test; only the network/process peer is a stub or loopback server.

| Property | Proving test (this branch) — assertion | Real path exercised | Substituted dependency |
|---|---|---|---|
| Command registration + invocation | `tests/extension-surface.spec.ts` "registers every command in its registry with Pi…" — the real registry's commands are dispatched through Pi's registered handlers; `tests/commands/surface.spec.ts` | `activate()` → Pi `registerCommand` → real handlers | none (in-memory registry) |
| `/models` default + `--details` | `tests/commands/model-doctor.spec.ts` (AC-3/AC-4), `tests/commands/model-surface.spec.ts` — grouped effective assignment, override precedence, no default probe, truthful reachability wording | `registry.dispatch("/models")` → `renderModels`/`renderModelDetails` | backend probe loopback (native stub); temp config |
| Prompt success + streaming | `tests/backends/native.spec.ts` "AC-3: a native turn writes the requested file through the Pi agent loop" — the file exists after a real agent loop; `tests/wiring.spec.ts` | real Pi agent loop → `startStubBackend` SSE | loopback OpenAI-compatible stub |
| Provider timeout / failure recovery | `tests/backends/native.spec.ts` "a provider error is a typed worker failure, never a throw" and "ends a stalled loop at the wall-clock ceiling and reports what it spent"; `tests/backends/fallback.spec.ts` AC-8 (rate-limit, hang, chain exhaustion → blocked with each reason); `tests/first-turn.spec.ts` AC-7 | real worker/lane; real `JevClient.ask` | loopback backend; abort-ignoring/hanging JEV transport |
| Missing / unreachable backend | `tests/commands/model-doctor.spec.ts` "/doctor" (missing `PATH` command → `unavailable`; reachable loopback → `ok`; signed-out harness → `degraded`); `tests/backends/fallback.spec.ts` "exhausting the chain ends blocked with every backend's reason" | real `/doctor` probe; real executor chain | temp `PATH`; loopback stub |
| Cancellation | **Gap.** The extension never observes Pi's user cancellation of a turn: the compile budget is a wall-clock `AbortController`, and its timeout path is proven by `tests/first-turn.spec.ts` AC-7/AC-8. Process teardown is covered by `tests/process-safety.spec.ts` (group signal / `child.kill` fallback). No test proves that a user Ctrl-C stops an in-flight JEV ask; that boundary is untested and stated as a residual risk. | real `before_agent_start`, real budget `AbortSignal`; real child-signal helper | hanging JEV transport; fake child |
| Persistence / restart | `tests/telemetry/run-record.spec.ts` AC-4 — a fresh process reads the run by `task_id`; `tests/jev-privacy.spec.ts`; `tests/goal/goal-state.test.ts` AC-1 — a fresh store instance deserializes exactly | real decision/telemetry stores on disk | temp filesystem |
| Repeated turns | `tests/wiring.spec.ts` "carries the todo list into the next request…"; `tests/first-turn.spec.ts` AC-8 — turn 2 after a timed-out turn makes non-fallback calls | real session, two sequential turns | loopback/JEV stub |

Concrete gaps found and closed by this PR: (a) no test asserted a status on the native entry *while a site was genuinely blocked* — added (AC-5); (b) no test observed the sequential per-site decision/usage attribution under mixed success/failure — added (AC-6, the regression guard for the withdrawn concurrent candidate); (c) no test bounded the whole compile or proved an abort-ignoring transport is still bounded and its late result dropped — added (AC-7); (d) no test proved the budget is per-invocation and the next turn recovers non-fallback — added (AC-8); (e) no test asserted the status clears when a lane throws — added (AC-5). No speculative framework was added. The user-cancellation boundary above is explicitly **not** claimed.

## Live validation (AC-11)

Read-only isolated temp workspace (`/tmp/leanpi-live-cron`), existing credential store, native `opencode-go` backend, no production writes. Sanitized results:

- **One tiny end-to-end prompt** through the built `bin/leanpi.js --print --no-tools`: prompt "Reply with exactly the token LIVE-OK and nothing else." → stdout `LIVE-OK`, exit 0. The turn's real decision log recorded 5 JEV rows (`gate.prd_required`, `classify.execution_complexity`, `classify.required_capability`, `classify.review_risk_input`, `skill.disclosure`), all `fallbackUsed: false`, model `jev-1.13.0` — the serial order is the wire order.
- The prior standalone `validateKey` decision call (ok, 210 ms, model `jev-1.13.0`, cost `$0.000011634`) is unchanged and was not repeated.
- No retries or extra spend were made. No secrets or unrelated prompts appear in this report. The `apiKey: LIVE_KEY` placeholder is not a real key (Pi read its own credential; the shell warning is expected); nothing was written outside the temp workspace.



## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Documented dev gates | developer/CI `pnpm <script>` | repairs the existing scripts; no new runner | AC-1, AC-2 |
| `/models` default view | interactive `/models` → `src/index.ts:830` bridge | edits `src/commands/model.ts`; ranking data untouched | AC-3, AC-4 |
| First-turn progress | Pi `before_agent_start` (`src/index.ts:713`) | adds the status the owned `input` path already has | AC-5 |
| Compiler JEV order + budget | `compileTask` (`src/compiler/index.ts:140`) | keeps the sequential dependency order, same fallback contract; adds `AbortSignal` to `ask` | AC-6, AC-7, AC-8 |
| Real-entry audit | `tests/commands/*`, `tests/extension-surface.spec.ts`, `tests/cli-bootstrap.spec.ts` | reuses and extends existing real-path tests | AC-9, AC-10 |

## Execution Phases

#### Phase 1: Make the documented gates run
**Status:** DONE
**ACs:** AC-1, AC-2
**Files:** `pnpm-workspace.yaml`, `package.json`.
**Implementation:** set `allowBuilds` values from installed metadata (`esbuild: true`; decline packages that need no install lifecycle) and drop the ignored `pnpm.onlyBuiltDependencies`.
**Verification:** E1 — `pnpm test`/`typecheck`/`lint` exit 0; E2 — `build` + `node bin/leanpi.js --help` exit 0.
**Checkpoint:** done

#### Phase 2: Truthful, readable `/models`
**Status:** DONE
**ACs:** AC-3, AC-4
**Files:** `src/commands/model.ts` (default grouping + `--details`), tests.
**Implementation:** add a grouped human-readable default that preserves assignments and states missing ranking data once; move the existing detailed rows + backend evidence wording behind `--details`; leave `models.json` untouched.
**Verification:** E1 — fixture with the auto-config model set (plus one ranked id and one absent id) asserts grouping, a single missing-ranking explanation, every role present, and detailed/negative-control output under `--details`.
**Checkpoint:** done

#### Phase 3: Responsive first turn and bounded JEV
**Status:** DONE
**ACs:** AC-5, AC-6, AC-7, AC-8
**Files:** `src/index.ts` (progress + cleanup on both entries), `src/commands/session.ts` (`runLanes` owns the budget), `src/commands/turn-lanes.ts` (compiler lane reads `context.budget`), `src/compiler/index.ts`, `src/jev/client.ts` (`ask` signal/budget/race), `src/compiler/contract.ts` (provider options), `src/capabilities/skill-select.ts`, `src/mcp/select.ts`.
**Implementation:** status before JEV; sites stay in dependency order and sequential (gate → complexity → capability → risk; providers sequential) so the shared fallback/usage state cannot contaminate a sibling; one `AbortController` budget created per `runLanes` invocation, threaded through the classifier client and skill selection; `ask` enforces the budget even if the transport ignores the signal, observes abandoned work, and drops late results.
**Verification:** E1 — genuinely blocked JEV: status observed while pending; mixed success/failure keeps per-site decisions/usage; hanging/abort-ignoring transport returns within budget with fallback decisions; next turn succeeds non-fallback; throwing lane clears the status.
**Checkpoint:** done

#### Phase 4: Regression net, audit and gates
**Status:** DONE
**ACs:** AC-9, AC-10, AC-11
**Files:** `tests/commands/model-doctor.spec.ts` or new surface spec, new real-entry runtime spec, existing real-path suites.
**Implementation:** write assertions first against base and record the red cause; extend the real-entry coverage list; run the authorized live check separately.
**Verification:** E1 — red on `a914b14`, green on the branch; E2 — AC-1/AC-2 gates plus the audit table.
**Checkpoint:** done

## Correction round outcome (review resolved)

Both appended review blocks are resolved and deleted as instructed; the outcomes are recorded on the ACs above:

- **Concurrency withdrawn.** The concurrent candidate's shared `client.fallbackCount()`/`lastUsage()` contamination is removed by restoring the sequential dependency order (AC-6), with the mixed success/failure usage-attribution regression guard. The user asked for responsiveness, not parallelism; immediate progress plus the 5 s budget deliver it.
- **`/models` effective truth.** The default now shows `bindingFor` (session override wins) and never probes; `--details` adds the configured-vs-effective notes and truthful reachability wording (AC-3/AC-4).
- **`raceBudget` observes abandoned work** even for a pre-aborted signal, and the native/input handlers clear progress on post-`runLanes` failures (AC-5/AC-7).
- **Grouping no longer hides a role.** A configured role that resolves to nothing renders `unresolved` (`tests/commands/model-surface.spec.ts` "keeps a configured role visible as unresolved…"). A truly empty `models:` block never reaches the renderer — `loadConfig` rejects it — so the unresolved case is the reachable one.
- **Test proof defects fixed.** The progress test blocks a real site and proves the turn is pending; the timeout test is named as budget recovery and asserts decision-log fallback/non-fallback; a late-resolving ignored-abort regression and a lane-throw cleanup test were added; the 5 s waits are replaced with fake timers (AC-5/AC-7/AC-8).
- **Budget scope.** `runLanes` owns the per-turn budget so the native `before_agent_start` and owned `input` paths are both bounded; the unused `TurnDeps`/`TurnLaneDeps` budget plumbing was removed.

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
   sent to the model. Trace site dependencies first, then run only independent
   asks concurrently (`gate` → {`classifyExecution`, `classifyReviewRisk`} →
   `deriveRequiredCapability`; capability providers concurrently), bounded by one
   per-turn wall-clock budget (~5 s) threaded as an `AbortSignal` into `JevClient.ask`
   and its transport. On budget, every site keeps its documented deterministic
   fallback (§49). Underlying fetch and timers are cancelled; late resolutions
   after abort produce no decision-log or usage side effects.

Reused, not new: `probeBackends`/`ProbeResult`, `capabilityRows`/`renderModelRow`,
`JevClient.ask` fallback path, `bootSession`/`startStubBackend`/`startStubJev`,
the existing `before_agent_start`/`input` hooks and `runTurn` deadline seam.
Risks: parallel asks reorder decision-log rows (rows are per-site, so order is not
load-bearing); a misbehaving test transport may ignore `AbortSignal`, so `ask`
must also enforce the budget itself rather than rely on transport cooperation;
progress text must not enter the LLM context (`ui.setStatus`, never
`sendMessage`).

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: `pnpm test`, `pnpm typecheck` and `pnpm lint` each exit 0 from a clean checkout of this branch, with no bypass flags and no new warnings; skipped tests are reported. (Single gate AC — replaces the duplicate old AC-1/AC-10.) — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: `pnpm build` exits 0 and the built CLI smoke `node bin/leanpi.js --help` prints Pi's help and exits 0 — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: `/models` default output is human-readable: configured roles are grouped by backend/model so repeated models are not repeated, each configured role's assignment is present, and missing ranking information is stated once with an actionable explanation — never six bare `unlisted/unknown/none` rows — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: `/models --details` preserves the detailed per-role rows, the ranking revision/staleness and backend diagnostics, distinguishes reachability from authentication for both backend types, contains no credential value, and `src/capability/models.json` is byte-unchanged — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: on the native (`before_agent_start`) entry, against a deferred JEV transport a LeanPi status is observed before the slowest JEV site resolves, a final status replaces it on success, and the status is cleared on error/cancellation; no message is injected into the model context — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: independent compiler JEV sites are in flight concurrently (observed overlap) while dependent sites stay ordered, and the compiled contract is byte-identical to the sequential result for the same stub answers — Evidence: pending.
- [ ] AC-7 [local; actor: agent]: a transport that never resolves (or resolves only on `abort`) cannot hold a turn past one per-turn budget of at most 5 s; the turn returns a contract with fallback decisions, and late resolution after the budget produces no additional side effect — Evidence: pending.
- [ ] AC-8 [local; actor: agent]: caller cancellation of a turn stops its in-flight JEV work without late side effects, and the next turn on the same session compiles and succeeds against a healthy JEV — the aborted context is not reused — Evidence: pending.
- [ ] AC-9 [local; actor: agent]: the new AC-3/AC-5/AC-6/AC-7 tests fail on base `a914b14` for the stated cause and pass after the fix, with the red assertions recorded — Evidence: pending.
- [ ] AC-10 [local; actor: agent]: an audit of the touched surfaces names, for each of command registration/invocation, success/streaming, cancellation, provider timeout/failure recovery, persistence/restart and repeated turns, which existing test proves it and where real external dependencies are substituted; concrete gaps get a regression test, not a speculative framework — Evidence: pending.
- [ ] AC-11 [local; actor: agent]: an honest live validation, separate from the fake process/network tests, using existing credentials in a read-only isolated temp workspace, makes at most two JEV decision calls and one tiny end-to-end prompt through `leanpi` on an available configured backend, measuring time-to-visible-status, JEV and first backend output; or reports the exact sanitized failure with no retries or extra spend. No production writes, no secrets or unrelated prompts in output — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Documented dev gates | developer/CI `pnpm <script>` | repairs the existing scripts; no new runner | AC-1, AC-2 |
| `/models` default view | interactive `/models` → `src/index.ts:830` bridge | edits `src/commands/model.ts`; ranking data untouched | AC-3, AC-4 |
| First-turn progress | Pi `before_agent_start` (`src/index.ts:713`) | adds the status the owned `input` path already has | AC-5 |
| Compiler JEV fan-out + budget | `compileTask` (`src/compiler/index.ts:140`) | parallelizes independent sites, same fallback contract; adds `AbortSignal` to `ask` | AC-6, AC-7, AC-8 |
| Real-entry audit | `tests/commands/*`, `tests/extension-surface.spec.ts`, `tests/cli-bootstrap.spec.ts` | reuses and extends existing real-path tests | AC-9, AC-10 |

## Execution Phases

#### Phase 1: Make the documented gates run
**Status:** READY
**ACs:** AC-1, AC-2
**Files:** `pnpm-workspace.yaml`, `package.json`.
**Implementation:** set `allowBuilds` values from installed metadata (`esbuild: true`; decline packages that need no install lifecycle) and drop the ignored `pnpm.onlyBuiltDependencies`.
**Verification:** E1 — `pnpm test`/`typecheck`/`lint` exit 0; E2 — `build` + `node bin/leanpi.js --help` exit 0.
**Checkpoint:** pending

#### Phase 2: Truthful, readable `/models`
**Status:** READY
**ACs:** AC-3, AC-4
**Files:** `src/commands/model.ts` (default grouping + `--details`), tests.
**Implementation:** add a grouped human-readable default that preserves assignments and states missing ranking data once; move the existing detailed rows + backend evidence wording behind `--details`; leave `models.json` untouched.
**Verification:** E1 — fixture with the auto-config model set (plus one ranked id and one absent id) asserts grouping, a single missing-ranking explanation, every role present, and detailed/negative-control output under `--details`.
**Checkpoint:** pending

#### Phase 3: Responsive first turn and bounded JEV
**Status:** READY
**ACs:** AC-5, AC-6, AC-7, AC-8
**Files:** `src/index.ts` (progress + cleanup on both entries), `src/compiler/index.ts`, `src/jev/client.ts` (`ask` signal/budget), `src/compiler/contract.ts` (provider options), `src/capabilities/skill-select.ts`.
**Implementation:** status before JEV; gate → parallel complexity/risk → capability; providers concurrent; one `AbortController` budget threaded through the classifier client and skill selection; `ask` enforces the budget even if the transport ignores the signal and guards against late side effects.
**Verification:** E1 — deferred JEV: status observed before completion; overlap observed; patched/abort-only transport returns within budget with fallback contract; next turn succeeds.
**Checkpoint:** pending

#### Phase 4: Regression net, audit and gates
**Status:** READY
**ACs:** AC-9, AC-10, AC-11
**Files:** `tests/commands/model-doctor.spec.ts` or new surface spec, new real-entry runtime spec, existing real-path suites.
**Implementation:** write assertions first against base and record the red cause; extend the real-entry coverage list; run the authorized live check separately.
**Verification:** E1 — red on `a914b14`, green on the branch; E2 — AC-1/AC-2 gates plus the audit table.
**Checkpoint:** pending

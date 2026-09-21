# PRD-029 — First-Turn Responsiveness, Readable `/models`, and Runnable Gates

**Status:** PARTIAL — the gate, model-surface, first-turn-progress and bounded-JEV phases are verified; the PRD is not production-ready. Two items remain open: (1) **SDK cancellation blocker.** A stop during the deferred `before_agent_start` preflight still starts the model request — the installed Pi 0.85.1 has no preflight abort path (`abort()` only reaches `activeRun`, which does not exist until `_runAgentPrompt`), and source inspection of 0.86.1 shows the same window. An in-repo pnpm patch was attempted and is **rejected and removed**: the documented `npm install` bypasses `patchedDependencies` (`private: true` does not mean there are no local npm users), and the patch did not prove the behavioural contract (`prompt()` resets the global abort flag on every invocation before slash-command handling, so an abort followed by a `/models` submission before release erases the stop, and concurrent preparing prompts race the boolean). (2) **External Claude model surface — Opus 5 configuration verified; `opus[1m]` root cause and 1M operation unresolved.** A successful controlled `runHarness` probe (the fourth and latest call) gives a working configuration: the vendor CLI `@anthropic-ai/claude-code` 2.1.267 (not a wrapper, requires ≥2.1.219 for Opus 5) accepts the explicit id `claude-opus-5`, returning `modelUsage["claude-opus-5"]` (`canonicalModel: claude-opus-5`, `provider: firstParty`, `contextWindow: 200000` reported for that run). This working route does **not** explain the earlier `opus[1m]` 404 — the underlying alias/access/provider/CLI cause remains unresolved, and no account entitlement is inferred. The user config (ignored `~/.config/leanpi/leanpi.config.yaml`, backup `leanpi.config.yaml.bak-opus5`) was changed for the three Claude roles from `opus[1m]` to `claude-opus-5`; the application itself still preserves arbitrary model ids. See "Open blockers" below.
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

4. **External Claude failure diagnostic, not an alias rewrite.** The
   auto-config copies the user's Claude Code `model` setting verbatim
   (`opus[1m]`) into LeanPi's config, and `runHarness` passes it as `--model`.
   `opus[1m]` is a valid vendor alias and is preserved — stripping it would
   silently downgrade the explicitly requested 1M context and make `/models`
   misreport what runs. A controlled read-only run with the alias preserved
   captured the real failure: the CLI reaches the API and the structured stdout
   result is `{ is_error: true, api_error_status: 404, result: "There's an issue
   with the selected model (opus[1m]). It may not exist or you may not have
   access to it." }`. The stderr line `[claude-code:unrecognized_model] …
   "query_source":"sdk"` is a non-fatal warning, and LeanPi's `failureReason`
   was surfacing that warning instead of the structured error. Fix only the
   diagnostic selection (`src/backends/harness.ts`, claude `parse`): when the
   envelope reports `is_error: true`, surface its `result` as the failure text.
   The model id, `/models` output and the user's `~/.claude/settings.json` are
    untouched. Remaining gap (external to LeanPi): the non-interactive path does
    not serve `opus[1m]`; the exact alias/access/provider/CLI cause is unresolved;
    LeanPi now reports the actual 404 rather than guessing at an alias.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: `pnpm test`, `pnpm typecheck` and `pnpm lint` each exit 0 from a clean checkout of this branch, with no bypass flags and no new warnings; skipped tests are reported. (Single gate AC — replaces the duplicate old AC-1/AC-10.) — Evidence: `pnpm test` → 107 files passed / 2 skipped, 623 passed / 7 skipped; `pnpm typecheck` exit 0; `pnpm lint` exit 0 with 35 warnings, the same count as base `a914b14` (35, no new warnings). No bypass flags used. Measured on the accepted final candidate with the rejected SDK patch removed and `node_modules` reinstalled unpatched (`pnpm install --frozen-lockfile`). This full-suite evidence belongs to the prior implementation; the later config-only correction reran no full gates (see Open blocker 2).
- [x] AC-2 [local; actor: agent]: `pnpm build` exits 0 and the built CLI smoke `node bin/leanpi.js --help` prints Pi's help and exits 0 — Evidence: `pnpm build` exit 0; `node bin/leanpi.js --help` exit 0, prints `pi - AI coding assistant …`.
- [x] AC-3 [local; actor: agent]: `/models` default output is human-readable: configured roles are grouped by their *effective* assignment (`surface.bindingFor`, so a session override wins over the static config entry), repeated models are not repeated, every configured role is present, a short legend explains the role labels, missing ranking information is stated once with an actionable explanation, and the compact view performs no backend probe — Evidence: `tests/commands/model-doctor.spec.ts` "renders a readable assignment view with a role legend and no hidden probe" (grouped `quick → stub/claude-haiku-4-5`, `balanced, strong, specialist, review_quick → stub/gpt-5`; legend; no `backend:`/`reachable at`); "shows the session override as the effective assignment and explains it in --details" (override wins; `--details` adds `override:`/`configured:`); `tests/commands/model-surface.spec.ts` "states missing ranking information once…" (`not in the bundled ranking` exactly once, no probe) and "renders the auto-config model ids…" (`opencode-go/deepseek-v4.1-flash`, `claude/opus[1m]`). Red on base `a914b14`: default was the detailed row wall — `expected 'ranking revision 1 …' to contain 'Model assignments (role → backend/model):'` (5 red assertions total).
- [x] AC-4 [local; actor: agent]: `/models --details` preserves the detailed per-role rows, the ranking revision/staleness and backend diagnostics, distinguishes reachability from authentication for both backend types (`reachable at host:port; authentication not verified` for a TCP connect; `command found …; authentication not probed` for an executable), contains no credential value, and `src/capability/models.json` is byte-unchanged — Evidence: `tests/commands/model-doctor.spec.ts` "keeps the detailed ranking rows and truthful backend diagnostics behind --details": revision/staleness, per-role score/price, effective `strong → stub/gpt-5` with `configured: stub/not-a-ranked-model`, `reachable at 127.0.0.1` + `authentication not verified`, no secret. `git diff --stat src/capability/models.json` is empty. Red on base: `expected false to be true` (`--details` did not exist).
- [x] AC-5 [local; actor: agent]: on the native (`before_agent_start`) entry, against a genuinely blocked JEV transport a LeanPi status is observed while the turn is still pending, a final status replaces it on success, and the status is cleared when a registered lane throws; no message is injected into the model context — Evidence: `tests/first-turn.spec.ts` "sets a status while a compiler site is genuinely blocked, then replaces it on success" (status present and `settled === false` before the gate is released) and "clears the progress status when a registered lane throws" (last status `undefined`). Red on base: `expected 0 to be greater than 0` (no status before JEV).
- [x] AC-6 [local; actor: agent]: the compiler's JEV sites and capability providers run strictly sequentially in dependency order (gate → complexity → capability → risk), so the shared `client.fallbackCount()`/`lastUsage()` cannot contaminate a sibling's decision or token attribution; mixed success/failure with distinguishable per-site usage yields the sequential decisions and usage — Evidence: `tests/compiler/classify.spec.ts` "AC-6 (serial): a failing sibling cannot contaminate decisions or token usage": complexity usage 111 and capability 222 are each attributed to their own site, the failed risk site falls back with 0 tokens, and the successful siblings are not marked as fallbacks. Reviewer rationale: the user asked for responsiveness, not parallelism; immediate progress plus the 5 s budget deliver that, and the previous concurrent candidate's only gain was a few hundred ms at the cost of the shared-state contract. This test is the regression guard for that candidate (base `a914b14` was already sequential, so it is green on both).
- [x] AC-7 [local; actor: agent]: a transport that never resolves (or resolves only after the budget) cannot hold a turn past one per-turn budget of at most 5 s; the turn returns a contract with fallback decisions recorded with the budget reason, and a late resolution after the budget produces no additional decision row, no unhandled rejection and no state mutation — Evidence: `tests/first-turn.spec.ts` "returns within the budget when the transport never answers, with fallback decisions" (all rows `fallbackUsed`, at least one reason containing `budget`) and "drops a transport that resolves after the budget, leaving no late decision" (row count unchanged, no `jev-stub` model version, no `unhandledRejection`). Fake timers advance the 5 s budget; the transport is a synthetic hang, labelled as such, not provider timing. Red on base: no `ask(signal)`/budget exists, so the never-answering transport holds the turn until the test timeout.
- [x] AC-8 [local; actor: agent]: a compile that exhausts the per-turn wall-clock budget recovers — the turn returns fallback decisions recorded with the budget reason, and the next turn on a healthy control plane makes real, non-fallback calls because the budget is created per `runLanes` invocation and never reused — Evidence: `tests/first-turn.spec.ts` "recovers the next turn on a healthy control plane after a timed-out compile": turn 1 rows all `fallbackUsed`, turn 2 appends rows with `fallbackUsed === false`. This is a budget/timeout recovery, not user cancellation; the extension does not observe Pi's own turn cancellation (see AC-10). Red on base: the hang holds the turn until the test timeout.
- [x] AC-9 [local; actor: agent]: the new `/models` and first-turn tests fail on base `a914b14` for the stated cause and pass after the fix, with the red assertions recorded — Evidence: with `src/` stashed and the new tests in place, `tests/commands/model-surface.spec.ts` + `tests/commands/model-doctor.spec.ts` gave 5 failed / 3 passed (the five red assertions are recorded on AC-3/AC-4); the first-turn tests are new files that exercise `ask(signal)`, which base does not have, so they cannot pass there.
- [x] AC-10 [local; actor: agent]: an audit of the touched surfaces names, for each of command registration/invocation, success/streaming, cancellation, provider timeout/failure recovery, persistence/restart and repeated turns, which existing test proves it and where real external dependencies are substituted; concrete gaps get a regression test, not a speculative framework; boundaries with no test are stated as gaps — Evidence: audit table below.
- [x] AC-11 [local; actor: agent]: an honest live validation, separate from the fake process/network tests, using existing credentials in a read-only isolated temp workspace, makes at most one tiny end-to-end prompt through `leanpi` on an available configured backend and reports the sanitized result and the real decision log; or reports the exact sanitized failure with no retries or extra spend — Evidence: live check below (native `opencode-go`, one prompt). The separate external Claude diagnostic used four calls in total, in this order: (1) initial warning-only `opus[1m]` failure; (2) a temporary plain-`opus` call that returned `LIVE-OK` but only via a rejected blanket suffix-stripping change (reverted); (3) a controlled `opus[1m]`-preserved call that returned the structured 404; (4) the accepted explicit `claude-opus-5` call that succeeded. No further calls or spend were made (see the AC-11 live section and Open blocker 2).
- [x] AC-12 [local; actor: agent]: LeanPi surfaces the vendor's actual failure message when the Claude CLI exits non-zero with a structured `is_error` result, instead of standing in the non-fatal `unrecognized_model` stderr warning; the user's model id is preserved unchanged (no alias normalization) and other vendors are unaffected. A fixture regression test (non-fatal stderr warning + failing structured result) is red before the fix and green after. — Evidence: `tests/backends/harness.spec.ts` "AC-12: a non-fatal vendor warning does not mask the real structured failure" — red on base `expected 'exit 1: [claude-code:unrecognized_mod…' to contain 'may not exist or you may not have acc…'`, green after the claude `parse` reads the `result` of an `is_error: true` envelope. One controlled read-only external call with the original id `opus[1m]` preserved (unique private temp cwd, `allowedTools: []`, 45 s deadline, vendor's own auth, no secrets printed) returned exit 1 with structured `{ is_error: true, subtype: "success", api_error_status: 404, num_turns: 1, result: "There's an issue with the selected model (opus[1m]). It may not exist or you may not have access to it." }` and stderr `[claude-code:unrecognized_model] {"model":"opus[1m]","query_source":"sdk"}`. The alias itself was not changed.

## Real-entry audit (AC-10)

Each row names the property, the test that proves it with its assertion, and the substituted dependency. "Real" means the production entry (`activate`/`createLeanPiSession`, the registered handler, the real client) is the code under test; only the network/process peer is a stub or loopback server.

| Property | Proving test (this branch) — assertion | Real path exercised | Substituted dependency |
|---|---|---|---|
| Command registration + invocation | `tests/extension-surface.spec.ts` "registers every command in its registry with Pi…" — the real registry's commands are dispatched through Pi's registered handlers; `tests/commands/surface.spec.ts` | `activate()` → Pi `registerCommand` → real handlers | none (in-memory registry) |
| `/models` default + `--details` | `tests/commands/model-doctor.spec.ts` (AC-3/AC-4), `tests/commands/model-surface.spec.ts` — grouped effective assignment, override precedence, no default probe, truthful reachability wording | `registry.dispatch("/models")` → `renderModels`/`renderModelDetails` | backend probe loopback (native stub); temp config |
| Prompt success + streaming | `tests/backends/native.spec.ts` "AC-3: a native turn writes the requested file through the Pi agent loop" — the file exists after a real agent loop; `tests/wiring.spec.ts` | real Pi agent loop → `startStubBackend` SSE | loopback OpenAI-compatible stub |
| Provider timeout / failure recovery | `tests/backends/native.spec.ts` "a provider error is a typed worker failure, never a throw" and "ends a stalled loop at the wall-clock ceiling and reports what it spent"; `tests/backends/fallback.spec.ts` AC-8 (rate-limit, hang, chain exhaustion → blocked with each reason); `tests/first-turn.spec.ts` AC-7 | real worker/lane; real `JevClient.ask` | loopback backend; abort-ignoring/hanging JEV transport |
| Missing / unreachable backend | `tests/commands/model-doctor.spec.ts` "/doctor" (missing `PATH` command → `unavailable`; reachable loopback → `ok`; signed-out harness → `degraded`); `tests/backends/fallback.spec.ts` "exhausting the chain ends blocked with every backend's reason" | real `/doctor` probe; real executor chain | temp `PATH`; loopback stub |
| Cancellation | `tests/cancellation-runtime.spec.ts` characterizes the real installed SDK session (`createLeanPiSession`): (1) `session.abort()` during **deferred preflight** does **not** stop the model — `backend.requests.length` is greater than 0, because there is no agent signal during preflight, and a later prompt still works; (2) `session.abort()` while **streaming** still closes the response and leaves the session idle. Test (1) is a documented boundary, not proof of a working cancel: the installed Pi 0.85.1 has no preflight abort path (see Open blocker 1). The compile budget's own timeout path is separately proven by `tests/first-turn.spec.ts` AC-7/AC-8; process teardown by `tests/process-safety.spec.ts`. | real `before_agent_start`, real budget `AbortSignal`, real SDK `session.abort()`; real child-signal helper | hanging JEV transport; loopback backend; fake child |
| Persistence / restart | `tests/telemetry/run-record.spec.ts` AC-4 — a fresh process reads the run by `task_id`; `tests/jev-privacy.spec.ts`; `tests/goal/goal-state.test.ts` AC-1 — a fresh store instance deserializes exactly | real decision/telemetry stores on disk | temp filesystem |
| Repeated turns | `tests/wiring.spec.ts` "carries the todo list into the next request…"; `tests/first-turn.spec.ts` AC-8 — turn 2 after a timed-out turn makes non-fallback calls | real session, two sequential turns | loopback/JEV stub |

Concrete gaps found and closed by this PR: (a) no test asserted a status on the native entry *while a site was genuinely blocked* — added (AC-5); (b) no test observed the sequential per-site decision/usage attribution under mixed success/failure — added (AC-6, the regression guard for the withdrawn concurrent candidate); (c) no test bounded the whole compile or proved an abort-ignoring transport is still bounded and its late result dropped — added (AC-7); (d) no test proved the budget is per-invocation and the next turn recovers non-fallback — added (AC-8); (e) no test asserted the status clears when a lane throws — added (AC-5); (f) no test characterized user cancellation on the real SDK session — added `tests/cancellation-runtime.spec.ts`, which measures the preflight-abort boundary (a stop during deferred preflight still starts the model) and confirms streaming abort works; that boundary is an open blocker (Open blocker 1), not a closed gap. No speculative framework was added.

## Live validation (AC-11)

Read-only isolated temp workspace (`/tmp/leanpi-live-cron`), existing credential store, native `opencode-go` backend, no production writes. Sanitized results:

- **One tiny end-to-end prompt** through the built `bin/leanpi.js --print --no-tools`: prompt "Reply with exactly the token LIVE-OK and nothing else." → stdout `LIVE-OK`, exit 0. The turn's real decision log recorded 5 JEV rows (`gate.prd_required`, `classify.execution_complexity`, `classify.required_capability`, `classify.review_risk_input`, `skill.disclosure`), all `fallbackUsed: false`, model `jev-1.13.0` — the serial order is the wire order.
- The prior standalone `validateKey` decision call (ok, 210 ms, model `jev-1.13.0`, cost `$0.000011634`) is unchanged and was not repeated.
- The additional Claude diagnostic calls are recorded below. No secrets or unrelated prompts appear in this report. The `apiKey: LIVE_KEY` placeholder is not a real key (Pi read its own credential; the shell warning is expected); nothing was written outside the temp workspace.
- **External Claude harness diagnostic (four calls, measured sequence):** through LeanPi's real `runHarness` adapter with the configured `claude` backend (`external_harness`, vendor `claude`), `allowedTools: []`, a unique temp cwd and the vendor CLI's own auth. (1) The first run with the configured `opus[1m]` exited non-zero but exposed only the non-fatal `unrecognized_model` stderr warning — the masking bug AC-12 fixes. (2) A temporary plain-`opus` call returned `LIVE-OK`, but only because a rejected blanket suffix-stripping change made the descriptor send `--model opus`; that change is reverted. (3) A controlled read-only call with the id `opus[1m]` preserved captured the full structured result: exit 1, `api_error_status: 404`, `is_error: true`, `result: "There's an issue with the selected model (opus[1m]). It may not exist or you may not have access to it."` So the request reached the API and was refused at the model-access layer; the exact alias/access/provider/CLI cause remains unresolved. (4) A later controlled read-only probe with the explicit id `claude-opus-5` succeeded (`modelUsage` canonical `claude-opus-5`, `contextWindow: 200000` reported for that run), giving a working configuration for the requested Opus 5 route — it is **not** the cause of (3)'s 404. The fallback chain was not walked.
- **No alias-downgrade validation is claimed.** The `LIVE-OK` result in (2) required changing the model id; that change is rejected and reverted. LeanPi's code preserves arbitrary configured model ids (no normalization) and reports the real 404 (AC-12); only the ignored user config's three Claude roles were changed to `claude-opus-5`.

## Open blockers (not production-ready)

1. **Pi preflight cancellation — open SDK boundary, no in-repo fix.** Measured on the installed 0.85.1: `prompt()` awaits `emitBeforeAgentStart` then runs `_runAgentPrompt` unconditionally (`dist/core/agent-session.js:915,949`); `abort()` only reaches `activeRun`, which does not exist until `_runAgentPrompt` (`:773`), so a stop during the deferred preflight cannot stop the model; Escape is gated on `isStreaming` (`dist/modes/interactive/interactive-mode.js:2253`), false during preflight. Source inspection of the 0.86.1 tarball (not release notes) shows the same window: the new `_agentRunAbortRequested` is set only when `_isAgentRunActive` (`agent-session.js:1334`) and that flag is still set only inside `_runAgentPrompt` (`:862`). An in-repo pinned pnpm patch of 0.85.1 was attempted and is **rejected and removed**: (a) the README documents `npm install`, which does not apply `patchedDependencies`, so npm/link installs get the unpatched SDK, and `private: true` does not mean there are no local npm users; (b) `prompt()` resets the global `_preflightAbortRequested` on every invocation before slash-command handling, so aborting the first deferred prompt and then submitting `/models` before release erases the stop and the model work starts, and concurrent preparing prompts race the boolean — a patch whose red test only checks the missing `isPreparing` flag does not prove this behavioural contract; (c) wrapping only `before_agent_start` misses async input/owned preparation. The durable fix belongs upstream; the characterization test records the boundary and is not evidence of a working cancel.
2. **External Claude model surface — Opus 5 route verified; `opus[1m]` root cause and 1M operation unresolved.** Historical evidence, kept: the configured alias `opus[1m]` reached the API via the non-interactive CLI and returned 404 "may not exist or you may not have access to it"; the `unrecognized_model` stderr line is a non-fatal warning and AC-12 surfaces the real message. The successful explicit-id probe gives a working configuration, not the cause of that 404. (a) Runtime is the genuine vendor CLI, not a wrapper — `/home/joao/.nvm/versions/node/v22.22.0/bin/claude` → `.../@anthropic-ai/claude-code/bin/claude.exe`, version 2.1.267 (≥2.1.219, so `opus`/explicit Opus 5 are available). (b) One controlled read-only `runHarness` probe (unique private temp cwd, `allowedTools: []`, 45 s, no fallback/retry, vendor's own auth) with the explicit provider id `claude-opus-5` returned `status: ok` and `modelUsage = { "claude-opus-5": { …, canonicalModel: "claude-opus-5", provider: "firstParty", contextWindow: 200000 } }` — the actual model identifier read from `modelUsage`, not a self-report. The reported `contextWindow: 200000` is what metadata returned **for that run**; it is **not** an account limit and does not prove a smaller window than 1M. Per https://platform.claude.com/docs/en/models/overview the model supports a 1M-token context, but actual 1M operation through this route is **unverified**; the earlier generic "plain opus = smaller window" statement was too broad and is not conclusively disproved here. Official provider/settings documentation (https://code.claude.com/docs/en/model-config) notes the effective window depends on provider and settings. (c) Routing source: `detectModels("claude")` copies `model` from `~/.claude/settings.json` (`opus[1m]`) into the auto-written `~/.config/leanpi/leanpi.config.yaml` roles `strong`/`specialist`/`review_strong`; the project `leanpi.config.yaml` at the repo root overrides every role to `opencode-go`, so the corrected Claude values apply only where no project config shadows them. Correction (reversible): the ignored `~/.config/leanpi/leanpi.config.yaml` `model: opus[1m]` → `model: claude-opus-5` for those three roles; backup `leanpi.config.yaml.bak-opus5`. The global `~/.claude/settings.json`, credentials, providers and other backends are untouched; the project-level all-DeepSeek override is preserved. No source change: the harness passes `packet.model` through verbatim and existing tests cover that passthrough. The working Opus 5 route does **not** fix the SDK cancellation boundary (Open blocker 1) and does not make the app production-ready. Validation was proportional: `loadConfig` was exercised to confirm the user/default bindings and the project effective bindings; no source changes and no full gates were rerun — the 623-test suite evidence is the prior implementation's, recorded on AC-1.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Documented dev gates | developer/CI `pnpm <script>` | repairs the existing scripts; no new runner | AC-1, AC-2 |
| `/models` default view | interactive `/models` → `src/index.ts:830` bridge | edits `src/commands/model.ts`; ranking data untouched | AC-3, AC-4 |
| First-turn progress | Pi `before_agent_start` (`src/index.ts:713`) | adds the status the owned `input` path already has | AC-5 |
| Compiler JEV order + budget | `compileTask` (`src/compiler/index.ts:140`) | keeps the sequential dependency order, same fallback contract; adds `AbortSignal` to `ask` | AC-6, AC-7, AC-8 |
| Real-entry audit | `tests/commands/*`, `tests/extension-surface.spec.ts`, `tests/cli-bootstrap.spec.ts` | reuses and extends existing real-path tests | AC-9, AC-10 |
| External Claude failure diagnostic | `runHarness` → claude `parse` (`src/backends/harness.ts`) | surfaces the structured `is_error` result instead of the non-fatal stderr warning; model id preserved | AC-12 |

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

#### Phase 5: External Claude failure diagnostic
**Status:** DONE
**ACs:** AC-12
**Files:** `src/backends/harness.ts` (claude `parse`), `tests/backends/harness.spec.ts`.
**Implementation:** when the parsed Claude envelope has `is_error: true`, use its structured `result` as the failure text so the real API message is not masked by the non-fatal stderr warning. The model alias, `detectModels`, `/models` and the user's global settings are untouched.
**Verification:** E1 — fixture regression test red (`expected 'exit 1: [claude-code:unrecognized_mod…' to contain 'may not exist or you may not have acc…'`) then green; E2 — a controlled read-only live call with `opus[1m]` preserved returned the structured 404 message; a later controlled call with the explicit `claude-opus-5` id succeeded (working configuration, not the 404 cause).
**Checkpoint:** done

## Correction round outcome (review resolved)

Both appended review blocks are resolved and deleted as instructed; the outcomes are recorded on the ACs above:

- **Concurrency withdrawn.** The concurrent candidate's shared `client.fallbackCount()`/`lastUsage()` contamination is removed by restoring the sequential dependency order (AC-6), with the mixed success/failure usage-attribution regression guard. The user asked for responsiveness, not parallelism; immediate progress plus the 5 s budget deliver it.
- **`/models` effective truth.** The default now shows `bindingFor` (session override wins) and never probes; `--details` adds the configured-vs-effective notes and truthful reachability wording (AC-3/AC-4).
- **`raceBudget` observes abandoned work** even for a pre-aborted signal, and the native/input handlers clear progress on post-`runLanes` failures (AC-5/AC-7).
- **Grouping no longer hides a role.** A configured role that resolves to nothing renders `unresolved` (`tests/commands/model-surface.spec.ts` "keeps a configured role visible as unresolved…"). A truly empty `models:` block never reaches the renderer — `loadConfig` rejects it — so the unresolved case is the reachable one.
- **Test proof defects fixed.** The progress test blocks a real site and proves the turn is pending; the timeout test is named as budget recovery and asserts decision-log fallback/non-fallback; a late-resolving ignored-abort regression and a lane-throw cleanup test were added; the 5 s waits are replaced with fake timers (AC-5/AC-7/AC-8). The caller-budget abort test now waits for the loopback server to actually receive the request before aborting, then asserts that exact socket is destroyed, so it can no longer pass by aborting before connect (`tests/jev-client.spec.ts`).
- **Budget scope.** `runLanes` owns the per-turn budget so the native `before_agent_start` and owned `input` paths are both bounded; the unused `TurnDeps`/`TurnLaneDeps` budget plumbing was removed.
- **Alias stripping withdrawn (review).** The `baseModelId()` normalization and its downgrade test were reverted; the model id is preserved. The real cause is an API 404 for `opus[1m]` on the non-interactive path (cause unresolved: alias/access/provider/CLI), now surfaced by an evidence-backed diagnostic fix (AC-12), with the unresolved gap recorded as Open blocker 2 rather than normalized away.
- **SDK cancellation patch rejected and removed.** The pinned Pi 0.85.1 pnpm patch is reverted (`pnpm-workspace.yaml`, `pnpm-lock.yaml`, `patches/`), and `tests/cancellation-runtime.spec.ts` is restored to `cc069fe` (except the accepted removal of the unused `JevTransportRequest` import) so it documents the preflight boundary rather than claiming a cancel that the rejected patch only appeared to prove. Reasons recorded in Open blocker 1: npm delivery bypass and an unproven behavioural contract (`prompt()` resets the global abort flag before slash-command handling; concurrent preparing prompts race it). The accurate three-call Claude sequence is retained, the `opus[1m]` alias is preserved, and the 0.86.1 finding cites inspected source. The remaining not-production-ready items are the open SDK cancellation boundary (Open blocker 1) and the external `opus[1m]` 404 (Open blocker 2).

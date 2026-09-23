# Refactor suggestions — 2026-09-22

**Scope:** tracked `src/`, `tests/`, `bin/`, `scripts/`, `bench/`, `extensions/` (464 files) in the
primary checkout. Excluded `.claude/worktrees`, `.worktrees`, `dist`, `node_modules`, `vendor`,
`bench/out`, generated `skills/` copies. Bound with `git ls-files`; no source/test/PRD edits made.
**Stack:** TypeScript (Node ≥22.19), Vitest, oxlint. `pnpm test`, `pnpm typecheck`, `pnpm lint`,
`pnpm build`.
**Method:** `git ls-files` inventory + `wc -l` hotspot ranking; complexity scanner on `src/` (80 hits, 79
`nested-or-callback-loop`, all in 6 files); then manual reads of the flagged files and the
surrounding call paths/tests. Scanner output triaged — most loop hits are bounded `.map`/`.filter`
over content parts or config maps, not real complexity.
**Limitations:** report-only; the full suite was not run. Complexity estimates use collection sizes
stated per finding. "Proven" below means verified by reading the code, not by a failing test.

---

## Ranked findings

### F1. O(D×P) path membership scan when pruning a worktree — `src/runtime/worktree.ts:578`
- **Principle:** algorithmic complexity.
- **Observed:** `dirty.filter((entry) => !patch.paths.includes(entry) || patch.hashes[entry] === undefined)`
  scans the `patch.paths` array once per dirty path. `dirty` comes from
  `git status --porcelain … --untracked-files=all` (line 566); `patch.paths` is every path the
  surfaced patch represents (`surfacePatch`, line 414).
- **Impact:** repo-wide rename/codemod or a large monorepo turn makes both lists thousands–tens of
  thousands of entries. Before **O(|dirty| × |patch.paths|)** (~10⁸ string compares at 10⁴ each);
  after **O(|dirty| + |patch.paths|)**.
- **Smallest refactor:** build `const represented = new Set(patch.paths)` once, then
  `!represented.has(entry) || patch.hashes[entry] === undefined`.
- **Risk:** low — membership semantics should remain unchanged; check duplicate-path behavior.
- **Verification:** `pnpm vitest run tests/runtime/worktree.test.ts tests/runtime/worktree-safety.test.ts`.

### F2. Quadratic ledger folding in bench reporting — `src/bench/metrics.ts:250-264`
- **Principle:** algorithmic complexity.
- **Observed:** `foldReport` calls `input.ledger.filter((a) => a.config_id === row.id)` once per
  config (250) and again per (config, task) pair inside the pairing map (253-255).
- **Impact:** with T tasks, C configs, L ledger rows (L ≈ T·C) the fold is **O(T·C·L) = O(L²)**.
  Seed suite T=10, C=9, L=90 → ~8.1k compares per fold; §55's 50–100 task target pushes L≈900 →
  ~810k. Every `recompute` repeats it.
- **Smallest refactor:** one `O(L)` pass into `Map<config_id, rows>` and
  `Map<"config\u0000task", rows>`, then index; preserves task-major/config-major order.
- **Risk:** low — pure fold; `harness.spec.ts`/`recompute` exercise it end-to-end.
- **Verification:** `pnpm vitest run tests/bench/harness.spec.ts` plus a fold-order assertion.

### F3. Whole telemetry store re-read and re-parsed per attempt — `src/bench/runner.ts:246`
- **Principle:** algorithmic complexity / system design.
- **Observed:** each attempt calls `readRuns(dir, { taskId }, { telemetry_path: storePath })`;
  `readStore` (`src/telemetry/store.ts:83-104`) does `readFileSync(path).split("\n")` and
  `JSON.parse` on **every** line before filtering. The same full read recurs at `runner.ts:151`,
  `:176`, `:251`.
- **Impact:** L attempts parsing a store that grows one row per attempt → **O(L²) parses and bytes**
  read from disk (≈8.1k parses at L=90), independent of measured work.
- **Smallest refactor:** read the store once, index by `task_id`, append each attempt's record after
  `executor()` returns, pass the index to `writeReport`; or track a byte offset.
- **Risk:** medium — the §52 join is what makes an attempt "not a free success"
  (`runner.ts:250-253`); keep the index exact and add a red/green join test.
- **Verification:** `pnpm vitest run tests/bench/adjudicate.spec.ts` + the new join test.

### F4. Completion `PASS` ignores two sufficiency answers it treats as blocking elsewhere — `src/proof/decide.ts:187-195`
- **Principle:** system design / correctness consistency.
- **Observed:** the `PASS` predicate requires `demonstrates === "YES"`, `reviewPassed` and
  `coverage.satisfied`, but never consults `answers.staticForRuntime` or `answers.unevidencedPath`.
  The same function lists those answers as `MISSING_PROOF` reasons (lines 201-202), which are
  unreachable once `PASS` fires. JEV can answer them (`gate.ts:276-292`), and the coverage fallback
  always sets `staticForRuntime: "NO"` (`decide.ts:101`).
- **Impact:** a JEV sufficiency answer of `staticForRuntime: "YES"` (static evidence where runtime
  behavior is required) or `unevidencedPath: "YES"` alongside `demonstrates: "YES"` still yields
  `PASS` — a potential false completion. No test exercises this: all fixtures hard-code both
  answers `"NO"` (`tests/proof/gate.test.ts:37-38`, `recover.test.ts:45-46`,
  `tests/runtime/gate-loop.test.ts:31`).
- **Smallest refactor:** decide intent — either add `answers.staticForRuntime !== "YES" &&
  answers.unevidencedPath !== "YES"` to the PASS guard, or document why they are advisory only.
- **Risk:** medium — tightening PASS changes completion gating; needs the gate-loop tests updated.
- **Verification:** new gate test with `{demonstrates:"YES", staticForRuntime:"YES", unevidencedPath:"NO"}`
  asserting `decision !== "PASS"` (fails today), plus a `contradiction:"YES"` case.

### F5. Dead exports: retry helpers and escalation category set — `src/executor/retry.ts:118-124`, `src/executor/escalation.ts:35-42`
- **Principle:** KISS / YAGNI / dead code.
- **Observed:** `spendAttempt`/`spendEscalation` have no caller in `src` or `tests`; the lane mutates
  the budget directly (`lane.ts:365` `budget.attemptsUsed += 1`, `lane.ts:548`
  `budget.escalationsUsed += 1`). `CONTINUING_CATEGORIES` is read nowhere; `lanes.ts` uses
  `action.continues` from `escalate` (`lane.ts:571`). Both are re-exported from
  `src/executor/index.ts:30-31,39` (and `src/index.ts:1546` re-exports the barrel).
- **Impact:** two ways to spend a retry budget invite divergence; an unused category set implies a
  continuation rule that does not exist.
- **Smallest refactor:** delete the three symbols and their re-exports.
- **Risk:** public-surface removal via the barrel export — check no external consumer imports them.
- **Verification:** `pnpm typecheck && pnpm vitest run tests/executor/retry.spec.ts`.

### F6. Dead plumbing: `AdapterDeps.rubricJudge` is declared, never read — `src/bench/adapters.ts:714`
- **Principle:** YAGNI / dead code.
- **Observed:** `AdapterDeps.rubricJudge` (import at line 56) is never referenced by
  `attemptExecutorFor` (721-738). The working rubric path is `runner.ts:52`/`:259` and `cli.ts:194`,
  which carry a separate option.
- **Impact:** a caller passing `rubricJudge` through `adapterDeps` is silently ignored — a no-op in a
  measurement harness whose purpose is auditable cost.
- **Smallest refactor:** delete the field and its now-unused type import.
- **Risk:** low — removal is compile-checked; behavior unchanged.
- **Verification:** `pnpm typecheck && pnpm vitest run tests/bench/baselines.spec.ts`.

### F7. `activate()` is an ~820-line single function — `src/index.ts:471-1294`
- **Principle:** SRP / KISS.
- **Observed:** one function wires providers, permission guard, MCP/LSP tools, artifact store,
  command bridges, statusline, and ~15 Pi event hooks (`before_provider_request`,
  `tool_result`, `session_start`, `input`, `before_agent_start`, `agent_end`, …). Helper seams
  already exist (`registerBackends`, `installArtifactTool`, `installToolOutputPipeline`,
  `bridgeCommands`), so the pattern is established.
- **Impact:** a hook's ordering constraints (e.g. guard after baseline tools, pipeline after
  redaction) are implicit in a long body; a change to one concern requires scanning the whole.
- **Smallest refactor:** extract the session-lifecycle hooks (`session_start`→`session_shutdown`,
  lines ~870-920) and the per-turn hooks (~940-1220) into named `installSessionHooks(pi, ctx)` /
  `installTurnHooks(pi, ctx)` functions taking an explicit context object. No behavior change.
- **Risk:** medium — closures capture many locals; the context object must be built deliberately.
- **Verification:** `pnpm typecheck && pnpm vitest run tests/bootstrap.spec.ts tests/wiring.spec.ts`.

### F8. Duplicated exclusion expression in executor routing — `src/executor/lane.ts:327-331`
- **Principle:** DRY.
- **Observed:** two identical `filter(...).map(...)` expressions differ only by the excluded backend
  name (`pin.backend` vs `routed.candidate.backend`).
- **Impact:** low, but two copies of dispatch precedence can drift when a third route source appears.
- **Smallest refactor:** `const preferred = pin?.backend ?? routed?.candidate.backend;` then one
  guarded `deps.registry.backends.filter((b) => b.name !== preferred).map((b) => b.name)`.
- **Risk:** low — both values are plain backend names.
- **Verification:** `pnpm vitest run tests/executor/routing.spec.ts`.

---

## Testing gaps (consequential paths)

### G1. `src/core/config.ts` block validators are largely untested (insufficiently tested)
`tests/config.spec.ts` (289 lines) covers models/backends/verify/specialists negatives only
(e.g. `:98`, `:190`, `:218`). No test asserts the failure of `parseJev` (`config.ts:176`),
`parseLaya` (`:148`), `parseRecap` (`:351`), `parseMcp` (`:364`), `parseSkills` (`:269`),
`parseBench` (`:279`), `parseThresholds` (`:289`), `parseLsp` (`:308`), `parseCapability` (`:318`),
`parseContext` (`:374`). Config is the documented fail-closed boundary, so a validator regression
could silently accept an invalid value. **Smallest test:** one table case per parser reusing `fromFile`, asserting `ConfigError`
with the dotted path (e.g. `{jev:{mode:"sometimes"}}`, `{skills:{maxLoaded:-1}}`,
`{lsp:{mode:"sometimes"}}`).

### G2. `src/proof/decide.ts` has no direct test (untested)
Only `tests/proof/gate.test.ts`, `recover.test.ts` and `tests/runtime/gate-loop.test.ts` reach it
transitively, all with `staticForRuntime`/`unevidencedPath` pinned `"NO"`. The PASS-vs-answers
interaction in F4, plus `gapCategoryFallback`'s `REVIEW_REQUIRED` branch (`decide.ts:116`), are
unexercised. **Smallest test:** the F4 gate case above.

### G3. Executor clarification path untested (untested)
`tests/executor/` drives failures via `retry.spec.ts`/`lane.spec.ts` but never reaches the
`USER_INPUT` branch (`lane.ts:562-569`) or `needsClarification` (`escalation.ts:225-236`) — the only
`CLARIFICATION_SITE_ID` reference (`retry.spec.ts:195`) is in a `throwOn` list. This path decides
whether the agent blocks for the user or proceeds on a recorded assumption. **Smallest test:** one
lane case with JEV `USER_INPUT` at `ESCALATION_SITE_ID` and `ask` at `CLARIFICATION_SITE_ID`,
asserting `outcome.question`, plus a `proceed` variant asserting `outcome.assumption`.

### G4. MCP client failure branches untested (insufficiently tested)
`tests/mcp/client.test.ts` covers lazy connect, auth, health and a refresh **success**
(`:249`). Untested: refresh error (`client.ts:476-481`), `callResultOf` `isError:true`
(`:221-224`, all assertions are `toBe(false)`), and `getClient` single-flight dedup
(`:432-443`, where duplicate concurrent connects spawn duplicate subprocesses). **Smallest test:**
`/mcp refresh` a `command:/nonexistent` server, assert `tools: 0` + `error`; one tool response with
`isError:true`.

---

## State

Only `docs/architecture/refactor-suggestions-2026-09-22.md` was created. No source, test, config or
PRD file was modified. Scanner guesses were not promoted to findings; F1–F8 were each verified by
reading the cited code and, for test gaps, the cited test files.

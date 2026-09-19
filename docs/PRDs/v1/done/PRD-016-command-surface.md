# PRD-016 — Command & Session Surface

**Status:** DONE (verified 2026-09-19)
**Complexity:** 4 (MEDIUM)
**Risk override:** none — read-mostly command handlers over facilities owned elsewhere; session persistence delegates to Pi rather than introducing new durable state.
**Owner:** joao
**Depends on:** PRD-002, PRD-004, PRD-015

## Context

**Covers:** FR-140, FR-141, FR-142, FR-148, FR-150, FR-151; ROADMAP §44, §45

§44 requires LeanPi to provide "the common functionality expected from modern coding harnesses": the core command list, session features (persisted sessions, resume, fork/branch, names, task history, compact, context inspection) and model features (switch model, inspect current route, inspect reasoning level, list models, force executor, force reviewer, backend health). §45 fixes `/route`'s output and its four overrides. FR-140/141/142/148/151 name the individual commands; FR-150 requires resume/new/branching **through Pi facilities**, and §44 states explicitly that Pi already provides a strong session/tree model LeanPi SHOULD retain.

Current behavior: none. The repository is greenfield — `docs/PRDs/v1/ROADMAP.md` is the only file — so there is no command dispatcher, no session surface, and nothing registering slash commands. Every path named below is created by this PRD's phases, except the contracts it consumes.

Consumed contracts (owned elsewhere, read not re-implemented):

- Pi's session tree and session store (PRD-001 establishes LeanPi as a Pi extension/SDK consumer, FR-001): persistence, ids, names, parent/child links, history, compaction hook.
- `src/compiler/contract.ts` — `ExecutionContract` and the classifier outputs (PRD-004): every value `/route` prints and every field its overrides set.
- `src/jev/registry.ts` — JEV decision-site registry (PRD-002): the site list `/route` renders as fired vs fallback.
- `src/telemetry/store.ts` (PRD-015): the cost figures `/status` summarizes, joined by the record's `session_id` — a field PRD-015 declares as an addition to §52 and this PRD only consumes; `/cost` itself is PRD-015's command.
- `src/backends/registry.ts` (PRD-008): backend list, `quota_class`, health probe used by `/doctor` and `/models`.
- `src/capability/*` (PRD-024): the bundled static model ranking `/models` annotates rows with; `src/capabilities/*` (PRD-005/PRD-006), `src/context/*` (PRD-014), `src/goal/*` (PRD-013), `src/review/*` (PRD-011), `src/permissions/*` (PRD-017): the facilities behind the commands those PRDs own.

## Solution

One registry plus twelve thin handlers. The commands this PRD owns are `/help`, `/status`, `/model`, `/models`, `/route`, `/context`, `/compact`, `/tree`, `/config`, `/doctor`, `/new`, `/resume`. `/goal`, `/review`, `/prd`, `/skills`, `/mcp`, `/permissions`, `/jev` and `/cost` are owned by PRD-013, PRD-011, PRD-012, PRD-005, PRD-006, PRD-017, PRD-002 and PRD-015 respectively: they **register** through this registry — the one in `src/commands/registry.ts`, which every PRD extends rather than standing up a second dispatcher — and appear in `/help`, but this PRD neither defines their behavior nor claims their FRs.

**Registry.** `src/commands/registry.ts` is a `Map<string, Command>` where `Command = { name, summary, usage, run(args, session) }`, plus `register()` and `dispatch(line, session)`. It is deliberately a map and not a plugin framework: no lifecycle hooks, no middleware chain, no per-command permission layer (permissions are PRD-017's, enforced at the tool boundary where they belong). Dispatch splits on whitespace, looks up the name, and on a miss returns "unknown command `/x` — did you mean `/y`?" using the nearest registered name by Levenshtein distance over the registry keys. `src/commands/index.ts` performs registration of the owned handlers and exposes the registry to the other PRDs' modules.

**Session surface — retain Pi, do not rebuild it (FR-150).** `/new`, `/resume`, `/tree` and `/compact` are wrappers over Pi's session tree: `/new [name]` creates a Pi session, `/resume <name|id>` reattaches to one, `/tree` renders Pi's existing parent/child structure (id, name, created-at, message count, current marker) and `/tree fork [name]` creates a child session from the current head so a branch inherits the prefix. `/compact` invokes Pi's compaction with PRD-014's custom compactor and then prints the before/after context accounting. LeanPi stores no session records of its own — no second id space, no mirrored history, nothing to keep in sync. `ponytail:` if Pi's session-name lookup turns out to be id-only, `/resume <name>` resolves names by scanning the session list; replace with an index only if the list ever gets big enough to notice.

**Model surface.** `/models` (rendered by `src/commands/model.ts`) lists configured models grouped by role with backend, availability, whether the role binding came from config or was overridden this session, and — from PRD-024's bundled static ranking — each model's `coding_score`, price and the role(s) it fills, via `capabilityRows()`. A model absent from the ranking renders `coding_score: unavailable` rather than dropping the row. The ranking ships with the harness as a file, so `/models` also prints its `revision` and the staleness of the oldest `updated_at` it relies on; there is no `--refresh`, no fetch and no cache to invalidate — freshness moves by a maintainer PR. `/model <role|name>` switches the active binding for the session and echoes the resulting route line; `/model` with no argument prints the active bindings and the current reasoning level. Role→backend resolution itself is PRD-001's and selection is PRD-020's — this PRD renders what those report and never picks a model itself.

**`/doctor` (FR-151).** Iterates the backend registry and the capability registries, probing each: is the external harness command on `PATH`, does it authenticate, is the local provider reachable, is JEV configured and answering, how many skills/MCP servers were indexed and from which roots. Each row is `ok | degraded | unavailable` with a one-line reason; the summary line reports the worst status. `/doctor` never mutates anything and never prints credentials — probe results only.

**`/route` (FR-142, §45).** Prints exactly the §45 lines for the current or next task — `PRD`, `complexity`, `review risk`, `executor`, `review`, `skills`, `MCP`, `LSP`, `reasoning`, `budget` — sourced from the `ExecutionContract`, plus a JEV line listing which decision sites fired and which fell back (see JEV Decision Sites). Overrides `/route executor <class>`, `/route reviewer <class>`, `/route prd force` and `/route prd skip` write session-scoped pins that the compiler reads when it builds the next contract; `/route` then shows the pinned value marked `(forced)`, and `/route reset` clears the pins. Pins are session state, not config writes: a forced route must not silently outlive the session that asked for it.

**`/status` (FR-140).** One screen: session name/id and parent, active role bindings and reasoning level, backend availability counts, active goal/PRD if any, and session cost totals read from PRD-015's store. It composes existing readouts rather than computing anything — a divergence between `/status` and `/cost` or `/route` should be impossible by construction.

**`/context` (FR-148) and `/config`.** `/context` prints the working-state breakdown from PRD-014 (static prefix, working state, artifact references, live tool output, message history) with token counts per section and the pruned/artifact-backed share. `/config` prints the resolved configuration with, per key, the source that won (built-in default / user / project) and the absolute path of that file. `/config` is read-only: config edits happen in the file, where they are diffable and reviewable — skipped a `/config set` writer; add one only if editing the file proves genuinely painful in practice.

**Relevant non-goals (§58).** This surface does not automatically expose every installed integration — `/skills` and `/mcp` show what their disclosure-gated registries report, and listing is not enabling; it does not require JEV for basic operation, so every command here works with JEV disabled (`/route` shows fallback, `/doctor` reports it unavailable); it does not require cloud models; and it creates no multi-agent swarm by default — `/route` exposes routing, it does not fan work out.

## External Skill Dependencies

None.

No command handler in this PRD reads a skill or plugin file. The paths below are shown by `/doctor` and `/skills` as *data reported by PRD-005's registry*, which owns discovery and precedence (project > user global > plugin); this PRD renders the counts and roots that registry returns and contains no absolute path of its own:

- `/home/joao/.claude/skills` (27 skills) and `/home/joao/.codex/skills` (211 skills) — user global roots.
- `/home/joao/.claude/plugins/cache/*/*/<version>/skills/` — plugin-provided roots, e.g. the Ponytail bundle at `/home/joao/.claude/plugins/cache/ponytail/ponytail/4.9.0/skills/ponytail/SKILL.md` (vendored into the static prefix by PRD-001) and `/home/joao/.claude/skills/prd-creator/SKILL.md` + `/home/joao/.claude/skills/prd-manager/scripts/` (adapted by PRD-012).
- Project-local `.claude/skills` and `.codex/skills`.

Consequently `/doctor`'s skill/MCP rows are driven by configurable discovery roots (PRD-005 config), so this command surface behaves identically on a machine where none of the above exists — it reports zero indexed skills instead of failing.

## JEV Decision Sites

None — consumes decisions owned by PRD-002 (site registry), PRD-004, PRD-005, PRD-006, PRD-007, PRD-009, PRD-010, PRD-011, PRD-012, PRD-013, PRD-014, PRD-018, PRD-019, PRD-020 and PRD-023. No command here asks JEV anything; dispatch, session handling and rendering are fully deterministic.

This PRD owns the **display** obligation: `/route` enumerates PRD-002's registry for the current task and shows, per site, whether JEV answered or the deterministic fallback decided — the user-visible counterpart of PRD-015's `jev_decisions[]` rows:

```text
jev: prd_gate fired (choice PRD_REQUIRED, conf 0.86) · complexity fired (choice MEDIUM, conf 0.71)
     skill_disclosure fallback (deterministic rule) · review_risk fallback (jev disabled)
```

Site ids, question sets, return types and thresholds are read from the registry, never restated here, so a site registered by another PRD appears in `/route` with no edit to this module. With JEV off, every site prints `fallback` and the rest of `/route` is unchanged — routing transparency must not depend on the thing it reports about.

## Acceptance Criteria

- [x] - [ ] AC-1 [local; actor: agent]: `/help` in a live session lists every registered command with its one-line summary, including the commands registered by other PRDs through the same `src/commands/registry.ts` (`/goal`, `/review`, `/prd`, `/skills`, `/mcp`, `/permissions`, `/jev`, `/cost`) alongside this PRD's twelve; `/halp` returns "unknown command" naming `/help` as the nearest match — Evidence: tests/commands/surface.spec.ts — `/help` lists the twelve owned commands plus a foreign stub and the eight peer commands registered by their own modules in a booted real Pi session; `/halp` answers with the nearest match `/help`.
- [x] - [ ] AC-2 [local; actor: agent]: `/status` prints the current session name and id, the active role→model bindings, the reasoning level, backend availability counts, and a session cost total equal to the value `/cost` reports for the same session after one fixture run — both read from PRD-015's store filtered on the record's `session_id`, so the two figures cannot be computed from different populations — Evidence: tests/commands/surface.spec.ts — `/status`'s session cost equals `/cost`'s session total ($3.000000) for the same `session_id` after one run emitted through PRD-015's own emitter; both read `readRuns(cwd, { sessionId })`.
- [x] - [ ] AC-3 [local; actor: agent]: With a project config setting `models.quick.model`, `/config` shows that value, the losing user/default value, and the absolute path of the project file that won; editing the project file and re-running `/config` in a new session shows the new value — Evidence: tests/commands/surface.spec.ts — `/config` shows the winning project value, the losing default and the project file's absolute path, and re-reads an edited file in a new session.
- [x] - [ ] AC-4 [local; actor: agent]: `/models` lists each configured model grouped by role with its backend, availability, `coding_score`, price and role-fill from PRD-024's bundled ranking, plus that ranking's `revision` and staleness, and shows `coding_score: unavailable` for a model missing from the ranking; `/models --refresh` is not a recognized flag (the ranking is a shipped file, not a fetched cache); `/model strong` switches the active executor binding and the following `/status` and `/route` both report the new model, while `/model` with no argument shows the bindings and the current reasoning level — Evidence: tests/commands/model-doctor.spec.ts — `/models` shows revision/staleness plus `coding_score`/price/role-fill per role, `coding_score: unavailable` for an unranked model, rejects `--refresh`, and `/model strong` is visible in both `/status` and `/route`.
- [x] - [ ] AC-5 [local; actor: agent]: With one external-harness backend's command absent from `PATH`, `/doctor` reports that backend `unavailable` with the missing-command reason, reports a reachable backend `ok`, reports JEV and the skill/MCP registries with their indexed counts and roots, and its summary line reflects the worst row; no credential value appears in the output — Evidence: tests/commands/model-doctor.spec.ts — `/doctor` reports the PATH-missing harness `unavailable` naming the command, the reachable backend `ok`, JEV probed live, skill/MCP counts with roots, a summary reflecting the worst row, and no credential value.
- [x] - [ ] AC-6 [local; actor: agent]: For a classified task, `/route` prints all ten §45 lines (`PRD`, `complexity`, `review risk`, `executor`, `review`, `skills`, `MCP`, `LSP`, `reasoning`, `budget`) with values matching the task's `ExecutionContract` — Evidence: tests/commands/route.spec.ts — all ten §45 lines in order with values equal to the compiled contract.
- [x] - [ ] AC-7 [local; actor: agent]: `/route executor strong` then `/route` shows `executor: strong … (forced)`, and the next task's contract carries the forced executor class; `/route reviewer strong` does the same for the reviewer lane; `/route reset` returns both to the classifier's values — Evidence: tests/commands/route.spec.ts — `/route executor strong` and `/route reviewer strong` render `(forced)` and the next `compileTask` carries those classes; `/route reset` restores the classifier's values.
- [x] - [ ] AC-8 [local; actor: agent]: On a task the gate would route without a PRD, `/route prd force` makes `/route` show `PRD: yes (forced)` and the next run enter the PRD lane; on a task the gate would send to the PRD lane, `/route prd skip` shows `PRD: no (forced)` and the run proceeds without one — Evidence: tests/commands/route.spec.ts — `/route prd force` on a no-PRD task makes the next run enter the PRD lane, and `/route prd skip` on a PRD-required task proceeds without one.
- [x] - [ ] AC-9 [local; actor: agent]: `/route` lists each JEV site registered for the task as fired (with its answer and confidence) or fallback; with JEV disabled the command still renders all ten §45 lines and every site shows `fallback` — Evidence: tests/commands/route.spec.ts — every registered site is listed fired with its answer and confidence, or `fallback`; with JEV disabled all ten lines still render and every site shows `fallback`.
- [x] - [ ] AC-10 [local; actor: agent]: After a message in session `alpha`, `/new beta` starts an empty session and `/resume alpha` restores the earlier history (the first message is present and the session id matches the original), proving persistence comes from Pi's session store and survives the switch — Evidence: tests/commands/session.spec.ts — a message in session `alpha`, `/new beta`, then `/resume alpha` restores the original message and session id.
- [x] - [ ] AC-11 [local; actor: agent]: `/tree fork side` creates a child session whose history contains the parent's messages and whose subsequent messages do not appear in the parent; `/tree` renders both sessions with names, the parent/child relation and a current-session marker — Evidence: tests/commands/session.spec.ts — `/tree fork side` produces a child whose history contains the parent's messages and whose own messages do not appear in the parent, with `/tree` rendering both and marking the current session.
- [x] - [ ] AC-12 [local; actor: agent]: `/context` prints per-section token counts summing to the reported total; after `/compact`, `/context` reports a strictly lower total while the working state and artifact references are still listed — Evidence: tests/commands/session.spec.ts — `/context` section counts sum to its total, and after `/compact` the total is strictly lower with working state and artifact references still listed.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Slash-command dispatch | User types `/<name>` in the session → `dispatch()` in `src/commands/registry.ts` (created in Phase 1) | New capability; single registration point for every LeanPi command, including other PRDs' handlers | AC-1 |
| Session/route/cost status readout | `/status` → `src/commands/status.ts` (created in Phase 1) composing PRD-004 contract, PRD-008 registry and PRD-015 store | New capability; no parallel accounting of its own | AC-2 |
| Model switching and listing | `/model`, `/models` → `src/commands/model.ts` (created in Phase 2) over PRD-001's role resolver, annotated from PRD-024's bundled ranking via `capabilityRows()` | New capability; satisfies FR-141 | AC-4 |
| Backend/capability diagnostics | `/doctor` → `src/commands/doctor.ts` (created in Phase 2) probing PRD-008 backends and PRD-005/006 registries | New capability; satisfies FR-151 | AC-5 |
| Routing transparency and overrides | `/route [executor\|reviewer\|prd\|reset] …` → `src/commands/route.ts` (created in Phase 3) reading the contract and writing session pins consumed by PRD-004's compiler | New capability; satisfies FR-142 and §45 | AC-6 / AC-7 / AC-8 |
| JEV fired/fallback display | `/route` → PRD-002 `src/jev/registry.ts` enumeration rendered by `src/commands/route.ts` (created in Phase 3) | New capability; user-facing counterpart of PRD-015's `jev_decisions[]` | AC-9 |
| Session persistence, resume, fork, tree | `/new`, `/resume`, `/tree`, `/tree fork` → `src/commands/session-commands.ts` (created in Phase 4) wrapping Pi's session tree | Delegates to Pi; LeanPi adds no session store — satisfies FR-150. Distinct from PRD-001's `src/commands/session.ts` (`runTurn()`), which this PRD neither creates nor edits | AC-10 / AC-11 |
| Context inspection and compaction | `/context`, `/compact` → `src/commands/context.ts` (created in Phase 4) over PRD-014 working state and Pi compaction | New surface only; compaction logic stays PRD-014's — satisfies FR-148 | AC-12 |

## Execution Phases

#### Phase 1: Commands dispatch, and `/help` / `/status` / `/config` answer
**Status:** NOT STARTED
**ACs:** AC-1, AC-2, AC-3
**Files:**
- `src/commands/registry.ts` (new) — `Command` type, `register()`, `dispatch()`, nearest-name suggestion.
- `src/commands/index.ts` (new) — registers this PRD's handlers; exported for other PRDs to register theirs.
- `src/commands/help.ts` (new) — renders the registry.
- `src/commands/status.ts` (new) — composed session/model/backend/cost readout.
- `src/commands/config.ts` (new) — resolved config with winning source and file path.
- `tests/commands/surface.spec.ts` (new) — live-session fixture driving `/help`, `/status`, `/config`.

**Implementation:** Registration is explicit and eager at session start; `dispatch` returns a rendered string plus a status so a handler error becomes a message rather than a crashed session. Unknown-name suggestion uses a plain Levenshtein over registry keys — no fuzzy-search dependency. `/status` reads only existing accessors (contract, backend registry, telemetry store); if the telemetry store is empty it prints a zero total rather than an error. `/config` reports provenance from the config loader's own resolution result (PRD-001), so it cannot drift from what the loader actually applied; secrets are rendered as `<set>`/`<unset>`, never their values.

**Verification:** E1 — `npx vitest run tests/commands/surface.spec.ts`: opens a real session with a project config fixture and a stub command registered under a foreign-PRD name, dispatches `/help`, `/halp`, `/status` and `/config` through `dispatch()`, and asserts the help listing contains all owned plus the foreign command, the suggestion names `/help`, `/status`'s cost total equals the store's session sum for the fixture run, and `/config` shows the project value with the losing default and the fixture's absolute path. Covers AC-1 (registration and dispatch reachability), AC-2 (composition without divergence), AC-3 (provenance) — distinct risks: a command registered but never dispatchable, `/status` recomputing and disagreeing with `/cost`, config provenance guessed rather than read. Negative control: test-first red — before the registry exists `dispatch` cannot resolve `/help`; the foreign stub proves the listing is registry-driven rather than a hardcoded command list.
**Checkpoint:** done

#### Phase 2: Model surface and backend health
**Status:** NOT STARTED
**ACs:** AC-4, AC-5
**Files:**
- `src/commands/model.ts` (new) — `/model`, `/models`; session-scoped binding override.
- `src/commands/doctor.ts` (new) — backend/JEV/registry probes with per-row status and reason.
- `tests/commands/model-doctor.spec.ts` (new) — fixture with one reachable and one PATH-missing backend.

**Implementation:** `/model` writes a session-scoped binding the role resolver consults first; it never edits config on disk. `/models` reports availability from the backend registry's last probe, refreshing it on demand, marks overridden bindings, and joins each row against PRD-024's bundled ranking through `capabilityRows()` for `coding_score`, price and role-fill — printing the ranking's `revision` and staleness, `unavailable` for an unlisted model, and accepting no refresh flag because there is nothing to fetch. `/doctor` probes concurrently with a short per-probe timeout (a dead harness must not hang the command), treats a missing command or failed auth as `unavailable` with the reason, a reachable-but-degraded probe as `degraded`, and prints indexed skill/MCP counts with their discovery roots. No probe mutates state, installs anything, or prints credential values.
**Verification:** E2 — `npx vitest run tests/commands/model-doctor.spec.ts`: drives `/models`, `/model strong`, `/status`, `/route` and `/doctor` in one session against a fixture where one external-harness command is absent from `PATH` and one native backend is reachable; asserts the switch is reflected by both later commands, that `/models` shows `coding_score`, price, role-fill and the ranking `revision`/staleness for a listed model and `unavailable` for an unlisted one, that `/models --refresh` is rejected as an unknown flag, that the `unavailable` backend row names the missing command, the `ok` row is present, skill/MCP counts and roots appear, the summary reflects the worst row, and no configured secret value appears in the output. Covers AC-4 (switch observable through other commands, not just an echo), AC-5 (honest health reporting) — distinct risks: a switch that only changes the echo, a probe that reports `ok` without probing, credential leakage in diagnostics. Negative control: the missing-command row must differ from the reachable row — a `/doctor` that emitted a literal status would fail the asymmetry assertion.
**Checkpoint:** done

#### Phase 3: `/route` shows the routing decision and accepts overrides
**Status:** NOT STARTED
**ACs:** AC-6, AC-7, AC-8, AC-9
**Files:**
- `src/commands/route.ts` (new) — §45 renderer, `executor`/`reviewer`/`prd` overrides, `reset`, JEV site lines.
- `src/compiler/pins.ts` (new) — session-scoped route pins read by PRD-004's compiler when building the next contract.
- `tests/commands/route.spec.ts` (new) — classified fixture tasks for both PRD-gate directions, JEV on and off.

**Implementation:** The renderer maps `ExecutionContract` fields to the ten §45 lines one-to-one; a pinned field renders with `(forced)` so a forced route is never mistaken for a classification. Pins live in session state with an explicit `reset`, and the compiler treats a pin as the decided value while still recording that the site was overridden — so telemetry and `/route` agree about what actually decided. `prd force`/`prd skip` pin the gate outcome, not the classifier's confidence. JEV lines come from enumerating PRD-002's registry for the current task; an empty registry prints `jev: no sites registered` rather than nothing, and a disabled JEV prints every site as `fallback`.

**Verification:** E3 — `npx vitest run tests/commands/route.spec.ts`: for a low-complexity fixture task asserts all ten §45 lines with values equal to the contract's; applies `/route executor strong`, `/route reviewer strong` and asserts both the `(forced)` display and the forced classes in the *next* compiled contract, then `/route reset` restores classifier values; applies `/route prd force` on a no-PRD task and `/route prd skip` on a PRD-required task, asserting the gate outcome and the lane the run enters in each case; re-renders with JEV disabled asserting ten lines intact and all sites `fallback`. Covers AC-6 (transparency), AC-7 and AC-8 (overrides reach the compiler, not just the display), AC-9 (site display and JEV-off path) — distinct risks: a display-only override, a pin leaking across reset, `/route` breaking or silently emptying when JEV is down. Negative control: both PRD-gate directions are exercised, so a hardcoded `PRD: no` cannot pass; asserting the next contract (not the printed line) distinguishes a real pin from an echo.
**Checkpoint:** done

#### Phase 4: Session tree and context surface over Pi
**Status:** NOT STARTED
**ACs:** AC-10, AC-11, AC-12
**Files:**
- `src/commands/session-commands.ts` (new) — `/new`, `/resume`, `/tree`, `/tree fork`. PRD-001's `src/commands/session.ts` (`runTurn()`) is a different file and is not touched here.
- `src/commands/context.ts` (new) — `/context` breakdown, `/compact` invocation plus before/after accounting.
- `tests/commands/session.spec.ts` (new) — two-session, one-fork fixture with a compaction-triggering transcript.

**Implementation:** Every operation calls Pi's session API — create, list, load, fork, compact — and LeanPi keeps no session records: `/tree` renders Pi's returned structure, `/resume` resolves a name or id against Pi's session list, `/tree fork` uses Pi's fork/branch primitive so the child inherits the parent prefix. The four handlers register through `src/commands/registry.ts` like every other command; they live in `src/commands/session-commands.ts` so the turn entry point PRD-001 owns in `src/commands/session.ts` stays a single-purpose file with one creator. `/context` groups the current prompt into the §22 layers with token counts and a total, and flags the artifact-backed share (PRD-014). `/compact` calls Pi compaction with PRD-014's compactor, then prints the before/after totals so the user sees what compaction bought; it refuses with a message when there is nothing to compact instead of reporting a no-op as a success.

**Verification:** E4 — `npx vitest run tests/commands/session.spec.ts`: in one run, sends a message in session `alpha`, `/new beta`, `/resume alpha` and asserts the original message and session id are back; `/tree fork side`, sends a message, and asserts the child history contains the parent prefix while the parent lacks the child's message and `/tree` shows names, relation and current marker; then on a transcript large enough to compact, asserts `/context` section counts sum to its total, `/compact` reports a reduction, and the post-compaction `/context` total is strictly lower with working state and artifact references still listed. Covers AC-10 (persistence via Pi), AC-11 (fork semantics and tree rendering), AC-12 (context accounting and real compaction) — distinct risks: a resume that returns an empty or new session, a fork that shares state with its parent, a `/compact` that reports success while the context is unchanged. Negative control: the parent-lacks-child-message assertion is the self-comparison guard — a fork implemented as an alias of the same session would fail it; the strictly-lower post-compaction total rejects an envelope-only `/compact`.
**Checkpoint:** done

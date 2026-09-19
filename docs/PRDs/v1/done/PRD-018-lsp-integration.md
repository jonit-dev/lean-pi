# PRD-018 — LSP Integration

**Status:** DONE (verified 2026-09-19)
**Complexity:** 4 (MEDIUM)
**Risk override:** none — no security boundary, no destructive migration, no compatibility break. Score 4 comes from 1 (1–5 implementation files) + 2 (new module) + 1 (external API integration: language servers over LSP/JSON-RPC).
**Owner:** joao
**Depends on:** PRD-002, PRD-004

## Context

**Covers:** FR-090, FR-091, FR-092, FR-093, FR-094; ROADMAP §15, §18, §51 (LSP block)

ROADMAP §18 requires LSP support that is explicitly *not* globally mandatory. LeanPi must choose among four modes — `LSP_OFF`, `LSP_DIAGNOSTICS`, `LSP_NAVIGATION`, `LSP_FULL` — based on repository language, task type, project configuration, and expected value, with the roadmap naming two anchor cases outright: a trivial Markdown change gets `LSP_OFF`, a large TypeScript rename gets `LSP_NAVIGATION`.

The roadmap's reasoning is a cost argument, not an enthusiasm argument: it cites OpenCode's warning that language servers consume memory, go stale, and slow workflows, and that direct lint/typecheck tools are sometimes superior. FR-094 makes that a requirement — prefer targeted compiler/typecheck feedback when it beats LSP. FR-092 makes "stay off" a first-class outcome, not a degraded one. ROADMAP §15 lists LSP as one of the progressively disclosed capability categories, so LSP tools must not sit in the executor's capability list by default.

Available operations (ROADMAP §18): go to definition, references, hover/types, document symbols, workspace symbols, call hierarchy, diagnostics.

Repository state inspected: the repository is greenfield — `docs/PRDs/v1/ROADMAP.md` is the only file. There is no source tree and no `package.json`. Every path named below is created by this PRD's phases or by a dependency PRD, as marked. Baseline from PRD-001: TypeScript on Node, Pi extension, `npm run build` / `npm run typecheck` / `npm test` (vitest) / `npm run lint`. `ExecutionContract` is owned by PRD-004 (`src/compiler/contract.ts`); this PRD adds and populates its `lsp` field. The evidence/verifier machinery that *runs* a typecheck command is PRD-009's; this PRD only selects it.

Not in scope: skill and MCP disclosure (PRD-005, PRD-006), the deterministic verifier implementations (PRD-009), and file/search exploration ranking (PRD-023).

## Solution

### Approach: a deterministic table, then a lazily started server

Mode selection is a pure function over four cheap inputs, in strict precedence order:

1. **Project configuration** — `lsp: off | diagnostics | navigation | full | auto` in `LeanPiConfig`. Anything but `auto` is final. No model, no heuristic, no override.
2. **Changed-language set** — derived from the task's target paths and the repository manifest. If no file in a language with a detected server is in scope, the answer is `LSP_OFF`. A Markdown-only change lands here, which is the roadmap's first anchor case.
3. **Task type** — from PRD-004's classifier. A symbol-level task (rename, find-callers, refactor-across-files, API change) needs navigation; a correctness task needs diagnostics; a prose/config/doc task needs neither. This is a lookup table of task type × language availability, not a scoring model. No row in that table yields `LSP_FULL`: **`LSP_FULL` is reachable only through explicit `lsp: full` project configuration** (step 1), which is how AC-6 and AC-7 reach it.
4. **FR-094 override** — when the selection would be `LSP_DIAGNOSTICS` and the repository exposes a cheaper *type-checking* command (`typecheck` / `check` script, `tsc --noEmit`, `cargo check`, `go vet`, a configured `mypy`), the diagnostics bit is dropped and that verifier kind is marked mandatory in the contract's `verification` block instead. A one-shot compiler invocation with a full, authoritative error list beats holding a language server resident for a diagnostics stream LeanPi would poll once. A `lint` script does **not** qualify: eslint/oxlint report style, not types, so substituting it would trade type feedback for something that cannot replace it — FR-094 says *compiler/typecheck*. If the repository has no type-checking command, `LSP_DIAGNOSTICS` stands.

Only when steps 2–4 leave a genuine tie — mixed-language change set where one language wants navigation and the task type is ambiguous — is the JEV tie-breaker consulted (see the JEV table below). With JEV off, the tie breaks toward the cheaper mode. **LSP never depends on JEV**: every anchor case resolves before the tie-breaker is reached, which is asserted directly by AC-1 and AC-2 running identically with JEV enabled and disabled.

### Detection and lifecycle

`detectServers(root)` probes a small static table of language → server command (`typescript-language-server`, `rust-analyzer`, `gopls`, `pyright-langserver`, `clangd`) against `PATH` and the project's local `node_modules/.bin`. A language with no server on the machine is simply absent from the availability set, which feeds step 2 above — a missing server degrades the mode, never raises an error. There is no installer, no bundled server, no download: LeanPi uses what the user already has.

Servers start **lazily on first LSP tool use**, not at session open, so `LSP_OFF` provably never spawns one, and a navigation-mode session that happens not to use navigation costs nothing. Each server is one child process per root per language, shut down with the session.

The wire protocol is not hand-rolled: `vscode-jsonrpc` plus `vscode-languageserver-protocol` (the reference client packages the ecosystem already standardises on) handle framing, request correlation, and the message types. Writing a JSON-RPC content-length framer would be new code duplicating a maintained dependency for no gain.

### Capability exposure

Per ROADMAP §15, LSP tools are not in the executor's default capability list. Mode selection decides which group is registered for the turn:

| Mode | Tools exposed to executor |
|---|---|
| `LSP_OFF` | none; no server started |
| `LSP_DIAGNOSTICS` | `lsp_diagnostics` |
| `LSP_NAVIGATION` | `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_call_hierarchy` |
| `LSP_FULL` | navigation set + `lsp_diagnostics` |

### Consumer flow

```
user asks the session to rename an exported TypeScript symbol
        → PRD-004 task compiler → selectLspMode(...) = LSP_NAVIGATION
        → ExecutionContract.lsp = LSP_NAVIGATION
        → PRD-004's CapabilityProvider (kind: 'lsp') registers the navigation tool group
        → executor calls lsp_references
        → typescript-language-server starts on first call
        → real cross-file reference list returned in the session
```

### Staleness

Diagnostics are re-requested after LeanPi's own edits rather than served from a pre-edit cache — the roadmap names staleness as a specific LSP failure mode, and a stale diagnostic is worse than none because it sends the executor chasing a fixed error. AC-8 asserts the cleared-after-fix behaviour.

### Risks

- **Server absent or crashing mid-session.** Every LSP tool call degrades to a returned "unavailable" result the executor can act on, never a session failure. AC-5 asserts the PATH-stripped path.
- **Mode too generous.** The failure is cost, not incorrectness, and the table's bias is toward `LSP_OFF`. FR-092 makes that the intended posture.

### Non-goals (ROADMAP §58)

No blanket capability exposure — LSP tools reach the executor only in the mode that needs them. No correctness claims without evidence — LSP diagnostics are input to the executor, never proof of task completion; that gate is PRD-009 and PRD-010. No JEV requirement for basic operation — LSP mode selection is fully deterministic with JEV off. No unbounded autonomy — LSP is read-only inspection, it applies no edits.

### Lanes

Every AC is `local; actor: agent`. No shared or owner gate: language servers used in the fixtures are npm devDependencies installed locally, so all detection, degradation, and navigation proofs run in the agent's own environment.

## External Skill Dependencies

None.

This PRD consumes no installed skill or plugin. Its external dependencies are *language servers* (`typescript-language-server` and friends), which are detected executables on `PATH` or in `node_modules/.bin`, not entries in the skill roots at `/home/joao/.claude/skills`, `/home/joao/.codex/skills`, or the plugin skill directories under `/home/joao/.claude/plugins/cache/*/*/<version>/skills/`. Those roots are indexed by PRD-005 and trust-classified by PRD-017; LSP has no relationship to them. Server command paths are configurable (`LeanPiConfig.lsp.servers`) with the detection table as the default discovery order — no absolute path is hard-coded in product code.

## JEV Decision Sites

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| `lsp.usefulness` — break a tie between candidate LSP modes when the deterministic table is ambiguous (mixed-language change set with an unclear task type) | Given the changed-language set, task summary, and the candidate modes the table could not separate: which mode is worth its cost for this task? | `Choice` over `{LSP_OFF, LSP_DIAGNOSTICS, LSP_NAVIGATION, LSP_FULL}` restricted to the tied candidates | Pick the cheapest tied candidate (ordering `LSP_OFF < LSP_DIAGNOSTICS < LSP_NAVIGATION < LSP_FULL`). Non-null, always available, no error path | ★★★☆☆ |

Registered in PRD-002's decision-site registry as site id `lsp.usefulness` with its question set, `Choice` return type, confidence threshold, the fallback above, and telemetry tag `lsp.usefulness` (so PRD-015 records the per-site row and PRD-016's `/route` shows whether it fired or fell back).

The ★★★☆☆ rating is binding on the design: **the deterministic rule is primary and JEV is only the tie-breaker.** The site is reached only after project config, language availability, task type, and the FR-094 override have all failed to produce a single answer. Below the confidence threshold the answer is discarded and the cheapest-candidate fallback is used. Both roadmap anchor cases resolve deterministically and never reach the site — AC-1 and AC-2 assert byte-identical outcomes with JEV enabled and disabled, which is the concrete guarantee that LSP does not depend on JEV.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: A Markdown-only task in a TypeScript repository compiles to an execution contract carrying `lsp: LSP_OFF`, and the session spawns zero language-server processes; the result is identical with JEV enabled and with JEV disabled — Evidence: tests/lsp/mode.spec.ts — a Markdown-only task compiles to LSP_OFF and the session spawns zero servers.
- [x] AC-2 [local; actor: agent]: A TypeScript exported-symbol rename task in the same repository compiles to an execution contract carrying `lsp: LSP_NAVIGATION`; the result is identical with JEV enabled and with JEV disabled — Evidence: tests/lsp/mode.spec.ts — a TypeScript exported-symbol rename compiles to LSP_NAVIGATION.
- [x] AC-3 [local; actor: agent]: With `lsp: off` in project configuration, the rename task of AC-2 compiles to `lsp: LSP_OFF` with zero server spawns and no LSP tools exposed — project configuration overrides the otherwise-navigation outcome — Evidence: tests/lsp/mode.spec.ts — `lsp: off` in project config keeps the AC-2 task at LSP_OFF with zero spawns and no LSP tools offered.
- [x] AC-4 [local; actor: agent]: In a fixture repository exposing `npm run typecheck`, a diagnostics-shaped task compiles to `lsp: LSP_OFF` with the `typecheck` verifier kind marked mandatory in the contract's `verification` block (the command itself comes from `LeanPiConfig.verify.commands`, PRD-009), PRD-009 runs that verifier for the turn, and a `kind: 'typecheck'` `EvidenceRecord` exists afterwards; the same task in a fixture with no type-checking script but a detected server compiles to `lsp: LSP_DIAGNOSTICS` with no `typecheck` entry and no such record — Evidence: tests/lsp/mode.spec.ts — a diagnostics-shaped task in a repo exposing `npm run typecheck` compiles to LSP_OFF with `typecheck` in `verification.required`, and PRD-009 turns that into a real typecheck evidence record (asserted end-to-end).
- [x] AC-5 [local; actor: agent]: With `typescript-language-server` resolvable, detection reports it available for the TypeScript fixture and AC-2's task selects navigation; with the server removed from `PATH` and `node_modules/.bin`, detection reports it unavailable, the same task degrades to `lsp: LSP_OFF`, and the session completes without an error or unhandled rejection — Evidence: tests/lsp/detect.spec.ts — detection reports `typescript-language-server` available for the fixture and the AC-2 task selects navigation; the negative control (server absent) reports an explicit unavailable reason with zero spawns.
- [x] AC-6 [local; actor: agent]: With `lsp: full` set in project configuration (the only way `LSP_FULL` is reached), a session request for references to an exported symbol returns the real cross-file location set for the fixture (all known referencing files present, non-referencing file absent), and a hover request returns the symbol's declared type string — Evidence: tests/lsp/tools.spec.ts — with `lsp: full`, references to an exported symbol return every referencing file and omit the non-referencing one, and hover returns the declared type, against a real language server.
- [x] AC-7 [local; actor: agent]: With `lsp: full` set in project configuration, document symbols for a fixture file list its declared symbols, a workspace symbol query returns the matching symbol from a different file, and a call hierarchy query on a fixture function returns its known caller — Evidence: tests/lsp/tools.spec.ts — document symbols list the fixture file's declared symbols and a workspace symbol query resolves across files.
- [x] AC-8 [local; actor: agent]: Under `LSP_DIAGNOSTICS`, introducing a type error in the fixture surfaces a diagnostic in the session with file, line, and message; after LeanPi edits the file to fix it, the next diagnostics request reports the error cleared rather than replaying the pre-edit result — Evidence: tests/lsp/tools.spec.ts — a seeded type error surfaces with file, line and message under LSP_DIAGNOSTICS and is cleared after the fix.
- [x] AC-9 [local; actor: agent]: For an ambiguous fixture task (mixed Markdown + TypeScript change set, unclassified task type) the `lsp.usefulness` site fires: with JEV enabled and answering `LSP_NAVIGATION` the contract carries `LSP_NAVIGATION`; with JEV disabled the same task carries the cheapest tied candidate, the session still completes, and the telemetry row for the turn records `site: lsp.usefulness, fallback_used: true` — Evidence: tests/lsp/mode.spec.ts — the ambiguous mixed change set fires `lsp.usefulness`; the scripted answer changes the selected mode while the deterministic cheapest-candidate fallback decides when JEV is off.
- [x] AC-10 [local; actor: agent]: In a live turn compiled to `LSP_NAVIGATION`, the tool names the executor can actually invoke include the six navigation tools and exclude `lsp_diagnostics`, and invoking `lsp_references` returns a result while invoking `lsp_diagnostics` is rejected as unavailable; the contrast turn compiled to `LSP_DIAGNOSTICS` exposes `lsp_diagnostics` and none of the navigation tools — Evidence: tests/lsp/tools.spec.ts — a live navigation turn offers exactly the six navigation tools and a diagnostics turn inverts the set.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| LSP mode on the execution contract | LeanPi session → `compileTask` in `src/compiler/index.ts` (PRD-004) → `selectLspMode` in `src/capabilities/lsp/mode.ts` (created in Phase 1), writing `ExecutionContract.lsp` in `src/compiler/contract.ts` (PRD-004, field added in Phase 1) | New field; no prior LSP behavior exists. Sole selection point — no other module chooses a mode | AC-1, AC-2, AC-3, AC-9 |
| FR-094 targeted-check preference | Same compiler path → `preferTargetedCheck` in `src/capabilities/lsp/mode.ts` (created in Phase 1), marking the `typecheck` verifier kind mandatory in the contract's `verification` block, which PRD-009's `selectVerifiers` turns into a descriptor with the command from `LeanPiConfig.verify.commands` | Replaces resident-diagnostics-by-default with a one-shot type check where one exists | AC-4 |
| Language-server detection and lifecycle | First LSP tool call in a session → `detectServers` / `getClient` in `src/capabilities/lsp/detect.ts` and `src/capabilities/lsp/client.ts` (created in Phase 2) | New; lazy start is the disposition that makes `LSP_OFF` provably free | AC-5 |
| LSP navigation and diagnostics tools | Executor tool call → `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_document_symbols` / `lsp_workspace_symbols` / `lsp_call_hierarchy` / `lsp_diagnostics` registered by `registerLspTools` in `src/capabilities/lsp/tools.ts` (created in Phase 3), supplied through PRD-004's `CapabilityProvider` (`kind: 'lsp'`) registration point in `src/compiler/index.ts` and gated by the turn's mode | New capability group; registered per-mode, never by default (ROADMAP §15), through the one registration interface PRD-005/006/018/019 share. Subject to PRD-017's permission guard like any other tool | AC-6, AC-7, AC-8, AC-10 |

## Execution Phases

#### Phase 1: Deterministic mode selection, config precedence, and the FR-094 override
**Status:** DONE
**ACs:** AC-1, AC-2, AC-3, AC-9
**Files:**
- `src/capabilities/lsp/mode.ts` (new) — `LspMode` union, `selectLspMode(input)`, `preferTargetedCheck(root)`, the task-type × language table, and the tied-candidate resolution that consults the `lsp.usefulness` site.
- `src/compiler/contract.ts` (PRD-004, edited) — add the `lsp: LspMode` field to `ExecutionContract`.
- `src/compiler/index.ts` (PRD-004, edited) — `compileTask` calls `selectLspMode` during compilation and populates the `lsp` field plus any mandatory `typecheck` verifier entry.
- `src/core/types.ts` (PRD-001, edited) — add `lsp` to `LeanPiConfig` (`mode`, `servers` overrides).
- `src/jev/registry.ts` (PRD-002, edited) — register site `lsp.usefulness` with its question set, `Choice` return type, `consequence: low`, non-null cheapest-candidate fallback, and telemetry tag (numeric thresholds live in `src/jev/confidence.ts`).
- `tests/lsp/mode.spec.ts` (new), `tests/fixtures/ts-repo/`, `tests/fixtures/ts-repo-no-typecheck/` (new).

**Implementation:** `selectLspMode` is a pure function taking `{ projectConfig, changedLanguages, availableServers, taskType, targetedCheck }` and returning `{ mode, targetedCheck? , jevSiteUsed? }`. Precedence exactly as in Solution: explicit config (the only source of `LSP_FULL`) → no available server for any changed language → task-type table → FR-094 override → tie-break. The tie-break calls the JEV client only when the table yields more than one candidate; below the confidence threshold or with JEV disabled it takes the cheapest candidate and marks `fallback_used`. `preferTargetedCheck` reads `package.json` scripts and the project manifest for a *type-checking* command only — `typecheck` / `check`, `tsc --noEmit`, `cargo check`, `go vet`, or a configured `mypy`; `lint` is deliberately excluded because style output cannot stand in for type feedback. On a hit it marks the `typecheck` verifier kind mandatory in the contract's `verification` block rather than writing a literal command string, since PRD-009 owns command resolution. The detection list is a table in this file, not a plugin system. Nothing in this phase starts a process.

**Verification:** E1 — `npx vitest run tests/lsp/mode.spec.ts` drives the real PRD-004 compiler over the fixtures, asserting the compiled contract rather than calling the selector directly, so the wiring is covered with the logic: Markdown-only → `LSP_OFF` with a `child_process.spawn` spy at zero (AC-1); TS rename → contract `lsp: LSP_NAVIGATION` (AC-2 — the executor-visible tool list is Phase 3's AC-10, because nothing registers a tool until then); `lsp: off` config overriding it (AC-3); and the ambiguous fixture with a stubbed JEV client answering `LSP_NAVIGATION` versus JEV disabled yielding the cheapest candidate plus a `fallback_used: true` telemetry row (AC-9). AC-1 and AC-2 are each run twice — JEV enabled and disabled — and asserted equal; that pair is the control proving the deterministic path does not route through JEV. A `lint`-only fixture asserts `LSP_DIAGNOSTICS` still stands, the control against `lint` sneaking back into the substitute set. Tests written red first, the red arising from the missing `lsp` field and selector.
**Checkpoint:** done

#### Phase 2: Language-server auto-detection and lazy lifecycle
**Status:** DONE
**ACs:** AC-4, AC-5
**Files:**
- `src/capabilities/lsp/detect.ts` (new) — language → server-command table, `PATH` and `node_modules/.bin` probing, `detectServers(root, config)` returning the availability set, config overrides honored first.
- `src/capabilities/lsp/client.ts` (new) — `getClient(root, language)`: lazily spawns the server, performs `initialize`/`initialized` with the workspace root, keeps one client per root+language, shuts down with the session; built on `vscode-jsonrpc` and `vscode-languageserver-protocol`.
- `package.json` (PRD-001, edited) — add `vscode-jsonrpc`, `vscode-languageserver-protocol`, and `typescript-language-server` (devDependency, for fixtures).
- `tests/lsp/detect.spec.ts` (new).

**Implementation:** Detection returns a plain set; an absent server is an absent entry, never a thrown error, which is what lets step 2 of selection degrade cleanly. `getClient` is called only from tool handlers, never from selection or session startup, so `LSP_OFF` cannot spawn a server by construction. Server startup failure and post-start crashes are recorded once and turn the language unavailable for the remainder of the session; pending requests resolve to an `unavailable` result the executor can read.

**Verification:** E2 — `npx vitest run tests/lsp/detect.spec.ts`: with the fixture's `node_modules/.bin/typescript-language-server` resolvable, detection reports TypeScript available and AC-2's task selects navigation; with `PATH` and the local bin dir stripped for the call, detection reports unavailable, the same task compiles to `LSP_OFF`, and the session completes with no error or unhandled rejection (AC-5). The stripped-PATH half is the negative control: it must change the outcome, otherwise detection is not being consulted. AC-4's typecheck-present and typecheck-absent fixtures are re-run here against real detection results rather than a stubbed availability set, closing the gap left by Phase 1's fixture.
**Checkpoint:** done

#### Phase 3: Navigation and diagnostics tools exposed under mode gating
**Status:** DONE
**ACs:** AC-6, AC-7, AC-8, AC-10
**Files:**
- `src/capabilities/lsp/tools.ts` (new) — `registerLspTools(session, mode)`: the seven tool handlers mapping to `textDocument/definition`, `references`, `hover`, `documentSymbol`, `workspace/symbol`, `callHierarchy/incomingCalls`, and `textDocument/diagnostic`; exposes only the group the mode names to the turn's tool set.
- `src/compiler/index.ts` (PRD-004, edited) — register the LSP `CapabilityProvider` (`kind: 'lsp'`) so the turn's `ExecutionContract.lsp` field selects which tool group `registerLspTools` exposes; no separate capability-router module is created by this or any other PRD.
- `tests/lsp/tools.spec.ts` (new), `tests/fixtures/ts-repo/src/` extended with a cross-file symbol, a caller, and a non-referencing file.

**Implementation:** Handlers translate LeanPi's path/position arguments to LSP positions and return compact results (path, line, column, and for hover the type string) rather than raw protocol payloads, keeping tool output small per ROADMAP §15's context argument. Diagnostics are requested fresh after any LeanPi edit to the file — the client invalidates its per-file diagnostic result on `didChange`, so a fixed error cannot be replayed. All handlers pass through PRD-017's permission guard as ordinary tool calls; no bypass is added.

**Verification:** E3 — `npx vitest run tests/lsp/tools.spec.ts` runs a real `typescript-language-server` against the fixture through the session's tool path: references returns every known referencing file and omits the non-referencing one, hover returns the declared type (AC-6); document symbols, a workspace symbol query resolving to a different file, and call hierarchy returning the known caller (AC-7); a seeded type error reported with file/line/message and cleared after the fix on re-request (AC-8); and a live `LSP_NAVIGATION` turn exposes exactly the six navigation tools to the executor with `lsp_diagnostics` rejected as unavailable, while an `LSP_DIAGNOSTICS` turn inverts that set (AC-10). The omitted non-referencing file, the cleared-after-fix assertion and AC-10's inverted contrast turn are the controls against a vacuous pass — a stub returning a fixed list, a cached result, or a registration that ignores the mode fails them. Real-implementation control: the assertion set includes the server's own reported type string, which no mock in this suite produces.
**Checkpoint:** done

# PRD-053 — Auto mode picks the model you configured, once, and says why

**Closed:** 2026-10-02 at `97e223d`, archived to `done/`.

**Status:** DONE — 2026-10-02. Every phase and acceptance box verified.
**Complexity:** 4 (MEDIUM)
**Owner:** Joao
**Depends on:** PRD-048 (model modes), PRD-052 (session-model fallback)

## Context

Operator report (2026-10-01): "no matter which task, it always selects deepseek v4.1 flash" in Auto mode. Fix `413402e` (v0.1.9) made a routed `strong → claude/*` turn actually install the CLI model; that was 14 of 349 recorded turns. The rest come from three behaviours a code trace and the operator's telemetry (349 rows, 313 MEDIUM / 21 LOW / 14 HIGH, all but one on `opencode-go/deepseek-v4.1-flash`) confirmed:

1. **The ranking overrides `models:`.** `resolveRole` (`src/core/roles.ts:39`) asks `resolveRoleViaRanking` first; it picks the cheapest model bound to *any* role that clears the role's floor. deepseek-v4-1-flash scores 74 at $0.525/Mtok, so `balanced: claude/opus[1m]` silently resolves to deepseek. Only `capability.roles.<role>.pin` stops it.
2. **Unsure classifications collapse to MEDIUM.** The JEV client drops low-confidence answers (`src/jev/client.ts:383`); `classifyExecution` reads a missing `explicit_result` as "no" → E2/MEDIUM → `balanced`. The `results.every(accept)` fallback check can never fire on the already-filtered list. Nothing tells the operator.
3. **The model is re-decided every message.** `before_agent_start` (`src/index.ts:784-803`) calls `setModel` per turn, so "now run the tests" after an Opus turn drops back to flash and switches providers mid-conversation.

Also found: a repo `leanpi.config.yaml` replaces the global config wholesale (`src/core/config-path.ts`), an unavailable class falls to `quick` first (`src/compiler/route.ts:46`), `/route reset` wipes a `/model` pin (`clearRoutePins`), and `docs/systems/model-modes.md` promises review + proof gate in Auto that a native/mixed config never runs.

## Solution

Decisions from the 2026-10-01 interview, implemented at the shared seams so every caller (session boot, `before_agent_start`, subagent routing, `/route`) inherits them:

- `resolveRole` returns the configured binding when the role (or its fallback chain entry) is bound; the ranking only fills an unbound role.
- A per-session **floor class**: the first compiled turn sets it; a later turn installs `max(routed, floor)` on the executor ladder `quick < balanced < strong`. `/route executor` pins override it; `/new` (session switch) clears it.
- A classification whose JEV answers were dropped falls back to `heuristicBand` and marks the contract `fallbackUsed`; the Auto footer shows it.
- Config loading layers: global file as base, the walked-up project file deep-merged over it (project keys win).
- Unavailable-class deviation steps down one rung (`strong → balanced → quick`) before jumping.
- `/route reset` clears route pins only, leaving a `/model` pin intact.
- Docs state that Auto on a native/mixed config classifies and picks a model only.

## Acceptance Criteria

- [x] AC-1 [local]: A role bound in `models:` boots and routes to exactly that model even when the ranking knows a cheaper one that clears the floor. proof: `pnpm vitest run tests/capability` — 39 passed @ edc1a68; red on the old `roles.ts`: the booted session dispatched `local/ranked-quick` instead of the bound `metered/ranked-balanced`. The ranking still fills an unbound role (same spec).
- [x] AC-2 [local]: In a real session, a HIGH first message installs `strong`; a following LOW message keeps `strong`; after `/new` a LOW message installs `quick`. proof: `pnpm vitest run tests/backends/auto-ratchet.spec.ts` — 3 passed @ 5c1e0ac; red before: the LOW follow-up dropped to `local/leanpi-test-flash` (spec line 73).
- [x] AC-3 [local]: `/route executor strong` dispatched as a slash command in a real session makes the next message run on the strong model. proof: `pnpm vitest run tests/backends/auto-ratchet.spec.ts` — passes; one `claude` CLI invocation. Already working since `413402e`; this is its regression guard.
- [x] AC-4 [local]: When JEV drops a complexity answer, the turn's band comes from the heuristic, the contract records the fallback, and the Auto footer says so. proof: `pnpm vitest run tests/compiler/classify-fallback.spec.ts` — 2 passed @ b970e89; red before: a race-condition task with a dropped `explicit_result` compiled MEDIUM.
- [x] AC-5 [local]: With a global config binding `strong` and a project config setting only `balanced`, the loaded config carries both — and a project can never pair the user's stored key with its own endpoint. proof: `pnpm vitest run tests/config.spec.ts` — 26 passed @ 97e223d; red before: `strong` undefined; review found the deep merge leaked `sk-or-LITERAL` to a repo-chosen `baseUrl` (red), fixed by entry-level merge with `jev` replaced whole (green).
- [x] AC-6 [local]: An unavailable `strong` deviates to `balanced`, not `quick`. proof: `pnpm vitest run tests/backends/subscriptions.spec.ts tests/routing` — 35 passed; red before: `strong → quick`.
- [x] AC-7 [local]: `/route reset` after `/model <pick>` leaves the pin in place. proof: `pnpm vitest run tests/commands/route.spec.ts` — 6 passed; red before: pin wiped.
- [x] AC-8 [local]: `docs/systems/model-modes.md` describes Auto on native/mixed configs as classify + model pick, with the ratchet; full gate green. proof: `pnpm test && pnpm typecheck && pnpm lint` — 1122 passed / 11 skipped, typecheck 0, lint 0 @ 97e223d.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Binding-first role resolution | `resolveRole` (`src/core/roles.ts:39`) → `selectRoleModel` (`src/capability/roles.ts`), used by session boot and `before_agent_start` | ranking-first order, replaced in place | AC-1 |
| Session floor class | `compilerLane` records it (`src/commands/turn-lanes.ts`), `compileTask` applies it before deviations (`src/compiler/index.ts:190`) | per-turn independent class | AC-2, AC-3 |
| Visible classifier fallback | `classifyExecution` (`src/compiler/classify.ts`) → compile record → `statusLine` chip | silent MEDIUM | AC-4 |
| Layered config | `loadConfig` (`src/core/config.ts`) | first-file-wins read; writers still target `configPathFor` | AC-5 |

## Decisions

- 2026-10-01 (Joao): bindings in `models:` are final; ranking fills unbound roles only.
- 2026-10-01 (Joao): the first message decides; later messages may only escalate; `/new` resets.
- 2026-10-01 (Joao): an unsure classification uses the heuristic and is shown in the footer.
- 2026-10-01 (Joao): review/proof gate in Auto on native configs — fix the docs, not the code.
- 2026-10-01 (Joao): config layers — global base, project overrides the keys it sets.
- 2026-10-01 (agent, unobjected assumption): unavailable class steps down one rung; `/route reset` keeps a `/model` pin. Subscription availability reading the static binding is moot once bindings win.
- 2026-10-01 (agent, from review): the `guessed` chip shows only when JEV is enabled — with JEV off every band is the heuristic's by design. Config layers merge per entry, not per field, and `jev:` is replaced whole: a field-level merge let an untrusted repo pair the user's stored `apiKey` with its own endpoint.

## Execution Phases

#### Phase 1: The configured model, decided once
**Status:** DONE
**Files:** `src/core/roles.ts`, `src/index.ts`, `src/compiler/route.ts`, `src/compiler/pins.ts` / `src/commands/route.ts`
**Implementation:** binding-first `resolveRole`; session floor class applied in `before_agent_start`, cleared on session switch; step-down deviation; `/route reset` scope.
- [x] **Verification:** AC-1, AC-2, AC-3, AC-6, AC-7 red before / green after (evidence on the ACs).

#### Phase 2: Unsure classification is visible
**Status:** DONE
**Files:** `src/compiler/classify.ts`, `src/cli/statusline.ts`
**Implementation:** treat a dropped complexity answer as unknown → `heuristicBand`, `fallbackUsed: true`; footer marker.
- [x] **Verification:** AC-4 red/green (evidence on the AC).

#### Phase 3: Layered config and honest docs
**Status:** DONE
**Files:** `src/core/config.ts` / `src/core/config-path.ts`, `docs/systems/model-modes.md`
**Implementation:** load global then project, deep-merge; docs rewrite of the Auto section.
- [x] **Verification:** AC-5 red/green, key-leak red/green, AC-8 full gate (evidence on the ACs).

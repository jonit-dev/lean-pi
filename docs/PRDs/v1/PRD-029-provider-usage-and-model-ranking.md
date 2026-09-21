# PRD-029 — Provider Usage Inventory & Model Ranking Honesty

**Status:** NOT STARTED
**Complexity:** 4 (MEDIUM)
**Owner:** unassigned
**Depends on:** None

Complexity factors: 7 implementation files (2) + new adapter module (2). Both the
`extensions/` Pi-compiled path and the `dist/` tsc path ship in the same package,
so there is no independent RELEASE boundary (not counted); no database schema, no
new external API. Risk override: none — it only reuses the existing sanitized
`probeVendor`/`probeBackend` probes. Exact implementation file count: 7
implementation files plus the new adapter module, 8 changed paths total, all named
in the Execution Phases below.

## Context

Two user-visible readouts contradict the machine they run on.

**1. `/usage` is owned by the bundled extension, and a second `/usage` breaks it.**
`@hk_net/pi-usage-bars@0.6.0` registers `pi.registerCommand("usage", …)`
(`.../extensions/usage-bars/index.ts:759`), a `usage` CLI flag (`:452`), status-bar
polling (`:707-739`) and emits `@hk_net/pi-usage-bars:update` on Pi's shared
`EventBus` (`:666`). It is attached by the launcher
(`src/cli/launch.ts:46-56`). Pi collects one command map per extension and, when
two extensions register the same name, renames *both* to `usage:1`/`usage:2`
(`@earendil-works/pi-coding-agent` `dist/core/extensions/runner.js:446-476`), so
plain `/usage` resolves to neither (`runner.js:486`, `dist/core/agent-session.js:959`).
LeanPi's `bridgeCommands` registers every registry command into Pi
(`src/index.ts:355-377`); adding another `usage` command therefore collides and
silently disables `/usage` rather than shadowing it.

**2. The extension cannot see LeanPi's subscriptions.** Its provider set is a fixed
12-vendor list (`.../index.ts:46-59`) resolved through the extension's own
model-registry auth (`:584-605`). LeanPi writes Codex and Claude as
`external_harness` backends it spawns itself; OpenCode (native `opencode-go`) is
absent from that fixed provider set. Config declaring these backends does not prove
Pi holds no credential: the extension only sees its own registry auth, which need not
include CLI logins, so actual local auth remains unverified from config alone. With no
matching registry auth the extension renders "No matching configured providers"
(`.../index.ts:366`). LeanPi's honest inventory — `detectSubscriptions`/`probeVendor`
(`src/backends/subscriptions.ts:133-183`) — reaches only `/doctor`
(`src/commands/doctor.ts:32-39`) and bootstrap readiness (`src/cli/bootstrap.ts:200-213`).

**3. `/models` age, readiness and provenance.** `ageDaysOf` subtracts the record's
UTC midnight from an unfloored `now` (`src/capability/index.ts:32-34`, applied
`:108-110`): the printed age is an elapsed-day count whose value flips at the UTC
calendar boundary, not the local one, so on a machine behind UTC the display can
advance a calendar day before the local date changes. `renderModels` never passes
the existing `now` seam (`src/commands/model.ts:62`). Native health is a bare TCP
connect (`src/commands/surface.ts:170-183,222-224`) shown as `ok`.
`renderModelRow` never names the binding source or the missing-record fact
(`src/commands/model.ts:29-58`).

**Baseline.** Inspected clean source revision HEAD `694de8c` (no implementation tests
were run).

## Solution

### Flow 1 — one deterministic `/usage` owner that preserves the extension's real quota views

No safe *command-level* composition exists (no `unregisterCommand` in
`ExtensionAPI`, no extension callback, duplicate names renamed), and editing
`node_modules` is forbidden. The smallest supported mechanism is a launcher
registration adapter that wraps the bundled extension's public default export.

**Adapter** — new shipped Pi extension entry `extensions/usage/index.ts`
(LeanPi-owned, outside the `tsc` `src` build so Pi compiles it, exactly as the
launcher already attaches the bundled `.ts`):

1. `import usageBars from "@hk_net/pi-usage-bars/extensions/usage-bars/index.ts"`
   — that package's declared `pi.extensions` entry, the same public path the
   launcher already uses (`src/cli/launch.ts:50`).
2. Call it with a `Proxy` over Pi's `ExtensionAPI` that forwards every member
   (`on`, `registerFlag`, `events`, `getFlag`, …) to the real `pi` but intercepts
   `registerCommand("usage", …)`: it **captures that handler and does not
   forward it**. Status-bar polling, the `usage` flag and the `:update` events
   are preserved; the original `/usage` registration (`.../index.ts:759`) is
   superseded, so exactly one `usage` command is ever registered and Pi's
   duplicate rename never fires. *Disposition of original registration:* dropped
   at the adapter boundary; its handler is retained by the adapter.
3. Register the single `/usage` handler:
   - **Default `/usage`** (no argument) **immediately renders the LeanPi
     inventory** — configured backends, detected subscription/vendor diagnostics,
     and the latest supported provider quota snapshots already received from the
     extension's `:update` events — each snapshot labelled with its freshness and
     source. No modal and no upstream empty-state is shown first. Pending initial
     polling renders as pending, never as an empty account; a usage-fetch failure
     is reported as `unavailable` for that provider and never turned into zero
     balance or a missing provider. A provider whose snapshot is available from
     Pi's own model-registry auth stays visible even when LeanPi has no config or
     vendor discovery for it. This reuses the upstream polling/events only — no
     new fetch subsystem.
   - **`/usage details`** delegates to the captured bundled handler — the
     complete original quota/balance selector that fetches every supported
     provider and renders session/weekly/reset metadata. This explicit argument is
     the only path that invokes it, so the extension's false "No matching
     configured providers" empty state never appears on the default. The default
     render advertises `details` as the action for full quota details/refresh. In
     non-TUI the inventory is notified and the details view is described as
     interactive.
4. Subscribe to the shared bus for live numbers
   (`pi.events.on("@hk_net/pi-usage-bars:update", …)`, payload `{ provider, …UsageData }`,
   `.../index.ts:666`, `UsageData` at `.../core.ts:46-70`) and include the latest
   session/weekly/reset values for providers already polled.

**Inventory** reuses `detectSubscriptions`/`detectVendors`/`probeVendor`
(`src/backends/subscriptions.ts:133-183`) and `probeBackend`
(`src/commands/surface.ts:200`), imported from LeanPi's built entry
`../../dist/index.js` (package `type: module`, `main: ./dist/index.js`; the file
exists only after `pnpm build`, and `extensions` must be added to `package.json`
`files`). Public-export findings: `loadConfig(cwd, overrides, env)` is already
exported (`src/index.ts:1077` from `src/core/config.js`) and is the production
config-loading path; the registry is constructed as `new BackendRegistry(config,
options?)` where `config` is a `LeanPiConfig` (surface does `new
BackendRegistry(deps.config)`), not `BackendRegistry(config)`. `probeBackend` is
**not** currently exported by any barrel, so adding `export { probeBackend } from
"./surface.js"` to `src/commands/index.ts` is required; `detectVendors`/`probeVendor`
are added to the backend barrel (`src/backends/index.ts`). `probeVendor` gains
`loginProbe: "confirmed" | "refused" | "unknown" | "not-probed"` exposing the
tri-state `askVendor` already computes (`src/backends/subscriptions.ts:79-109,143`)
— the same probe, no new one. Dedup by `vendor` is used only to fold an aggregate
detected row into its single matching configured row; two explicitly distinct
configured backend IDs/accounts are never collapsed merely because the vendor
matches. If no safe identity to merge exists, distinct configured rows are retained
and the detection is labelled as an aggregate. No new credential/account scraping:
LeanPi adds none; the vendor status CLI may read its own auth store
(`src/backends/subscriptions.ts:64-109`).

**Rows:** configured `external_harness` + `loginProbe: confirmed` → `authenticated;
quota <snapshot | unknown | unavailable>` — login confirms authentication only, never
an active paid subscription, model availability, or remaining quota. `refused` →
`reauth-required — run <login command>`; `unknown` (timeout/error/unrecognized
output) → `unknown (status probe: <evidence>)`, never reauth; not on PATH →
`unavailable (<evidence>)`; detected but unconfigured → `detected (not configured)`,
a config state orthogonal to its login state; installed-but-signed-out → a
diagnostic row, not proof of subscription. Native connected → `reachable at
host:port; authentication not probed` (never `ok`/`ready`; TCP is not auth proof);
native disconnected/timeout → `unreachable`. Supported providers keep their real
session/weekly/reset numbers; a subscription with no supported usage source →
`quota: unavailable offline`. Per-provider probes are isolated. `no providers` is
emitted only when `backends:` is empty **and** no detected usable subscription/auth
signal exists **and** no supported Pi-provider signal or pending snapshot inventory
remains; installed-but-signed-out alone, or polling still pending, is not that
state. The literal "no configured providers" is never emitted. No credential value
is printed.

**Launcher** (`src/cli/launch.ts`): remove the usage-bars `index.ts` from
`BUNDLED_EXTENSIONS` (`:46-51`) and append the adapter
`join(root, "extensions", "usage", "index.ts")` to `launchPlan().args` after
LeanPi's own extension; ship `extensions` via `package.json` `files`. The adapter
is the sole `usage` registrant; the bundled factory still runs inside it.

```mermaid
flowchart LR
  AD[extensions/usage adapter] -->|Proxy drops usage, forwards on/flag/events| PI[Pi ExtensionAPI]
  AD -->|calls default export| BU[@hk_net/pi-usage-bars index.ts]
  BU -->|poll + :update events| PI
  AD -->|default: inventory + latest snapshots| PI
  AD -->|/usage details: captured selector| PI
  AD -->|detectVendors/probeVendor/probeBackend| LP[leanpi dist]
```

### Flow 2 — `/models` freshness, readiness, provenance

- **Calendar age at the display boundary.** Keep `ageDaysOf`/`age_days`/`stale`
  as elapsed-day (`src/capability/index.ts:32-34,109-110`) so the staleness policy
  and `tests/capability/ranking.spec.ts:84-97` are untouched. Add a local
  calendar-day formatter in `src/commands/model.ts`: parse `YYYY-MM-DD` as a date
  (never shift UTC midnight into the prior local day), compare the record's and
  `now`'s local calendar dates, render singular `1 day old` / plural otherwise, and
  never print a bogus `0` for a date that cannot be parsed (`age unknown`) or a
  future record date (`future-dated`, no negative age). Thread the existing seam:
  `CommandSurfaceDeps.clock?: () => Date` (`src/commands/surface.ts:92-100`,
  default `() => new Date()`); `renderModels` passes `clock()` to
  `loadRanking({ now })` and to the formatter. `oldest_updated_at` is metadata
  freshness of the record's `updated_at` date — not live backend validation and
  not a last-download time.
- **Provenance.** One line names the binding source (`config` vs `ranking`/session)
  and, when the configured binding and the resolved fallback differ, both remain
  visible. When the shown model has no ranking record, one concise coverage line
  ("ranking has no record for `<model>` — score/price/evidence unavailable")
  replaces six unexplained fields. Existing scores/prices/evidence stay visible
  when present; never fabricate, never silently change the model, and never use the
  literal "(not fabricated)" in user-facing copy.
- **Readiness.** Native rows read `backend: reachable at host:port; authentication
  not probed`; the verified harness wording (`src/commands/surface.ts:216-219`) is
  unchanged. Login/status confirms authentication only — not model availability or
  remaining quota.

**Non-goals:** ranking data maintenance (absent metadata is a recorded fact);
any new quota subsystem; credential/account scraping; hidden config changes;
status-bar redesign.

**Risk:** the adapter uses the bundled package's declared entry and Pi's public
`ExtensionAPI` only; probes are the existing sanitized `probeVendor`/`probeBackend`.
Risk override: none.

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: The real launcher plan attaches the adapter and exactly one `usage` command is registered, so Pi's resolution yields `usage` (never `usage:1`/`usage:2`). Default `/usage` immediately renders a row per configured backend and per detected subscription plus latest supported quota snapshots with freshness/source, without first showing the upstream "No matching configured providers" empty state; `/usage details` is advertised as the full quota details/refresh action. — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: A configured harness with `loginProbe: confirmed` renders `authenticated; quota <snapshot|unknown|unavailable>` (not a paid-subscription/model-availability claim); `refused` renders `reauth-required` and the login command; `unknown` renders `unknown (status probe: …)`, not reauth; absent command renders `unavailable` with PATH evidence; a detected-but-unconfigured provider keeps its config state orthogonal to login state. — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: For a supported provider with an available snapshot, `/usage` shows the latest real session/weekly/reset numbers with freshness/source; a usage-fetch failure renders `unavailable` for that provider (never zero balance or a dropped provider); a pending first poll renders as pending (not empty); a subscription with no supported usage source shows `quota: unavailable offline`; no credential value appears. — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: A mixed native + external_harness + detected-vendor fixture renders each provider's state independently (one failure/timeout does not suppress another); a provider authenticated only through Pi's own registry stays visible with no LeanPi config or vendor discovery; a connected native renders `reachable … authentication not probed` (never `ok`/`ready`) and a disconnected one renders `unreachable`. — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: `/usage` prints an actionable empty state only when `backends:` is empty, no detected usable subscription/auth signal exists, and no supported Pi-provider signal or pending snapshot inventory remains; with only an installed-but-signed-out vendor, or with initial polling pending, it prints that diagnostic/pending row, not "no providers"; "no configured providers" is never emitted. — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: With the injected local clock at `2026-09-20` and record `2026-09-19`, `/models` prints `1 day old`; same day prints `0 days old`; UTC-vs-America/Vancouver and a DST boundary render the local calendar-day age; a malformed date renders `age unknown` (not `0`) and a future date renders `future-dated` with no negative age; `age_days`/`stale` stay the elapsed-day policy. — Evidence: pending.
- [ ] AC-7 [local; actor: agent]: `/models` states the binding source (config vs ranking/session) and keeps both the configured binding and the resolved fallback visible when they differ; for an unlisted configured model it shows one coverage line saying the ranking has no record (no literal "(not fabricated)"); a ranked model still shows score/price/evidence; six roles on one model still list all six; explicit `models:` entries are neither rewritten nor dropped. — Evidence: pending.
- [ ] AC-8 [local; actor: agent]: A vendor-confirmed harness probe keeps its authenticated wording (`command found at …; signed in`), distinct from native reachability wording, and neither is presented as verified model availability or remaining quota. — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Single `/usage` owner | `launchPlan().args` → `extensions/usage/index.ts` adapter (`src/cli/launch.ts`) → Pi `registerCommand` | Supersedes the bundled `index.ts:759` registration; default renders inventory + snapshots, `/usage details` delegates to the captured original handler; flag/poll/events preserved | AC-1/2/4/5 |
| Supported quota/balance numbers | adapter default `/usage` → latest `:update` snapshots; `/usage details` → captured bundled selector (`.../index.ts:666`) | No replacement; the extension's own fetches/renders are reused, freshness/source shown | AC-3 |
| Subscription inventory | adapter `/usage` → `loadConfig` + `new BackendRegistry(config)` + `detectSubscriptions`/`detectVendors`/`probeVendor` (`src/backends/subscriptions.ts:133-183`) | Extends `/doctor`'s inventory to `/usage` | AC-2/5 |
| Ranking freshness | `/models` → `renderModels` (`src/commands/model.ts:62`) → `loadRanking({ now })` / calendar formatter | Fixes display age (unknown/future-dated ≠ 0); `clock` seam threaded | AC-6 |
| Selection provenance | `/models` row from config map (`src/commands/model.ts:30-36`) and ranking (`:63`) | Keeps configured binding + resolved fallback visible; adds missing-record line | AC-7 |
| Backend readiness wording | `/models` row → `probeBackend` (`src/commands/surface.ts:200`) | Reachability no longer presented as readiness | AC-8 |

## Execution Phases

#### Phase 1: `/usage` single-owner adapter, inventory and supported quota
**Status:** NOT STARTED
**ACs:** AC-1, AC-2, AC-3, AC-4, AC-5
**Files:** `extensions/usage/index.ts` (new adapter); `src/cli/launch.ts` (drop the
raw bundled entry, attach the adapter); `package.json` (`files` gains `extensions`);
`src/backends/index.ts` (export `detectVendors`/`probeVendor`);
`src/backends/subscriptions.ts` (expose `loginProbe`); `src/commands/index.ts`
(export `probeBackend`, currently absent from every barrel).
**Implementation:** Call the bundled default export through a forwarding `Proxy`
that captures and drops `registerCommand("usage")`; register one `/usage` whose
default argument renders the inventory + latest `:update` snapshots with
freshness/source, and whose `details` argument delegates to the captured bundled
selector; subscribe to the `:update` bus. Build the inventory from
`loadConfig(cwd)` + `new BackendRegistry(config)` +
`detectSubscriptions`/`detectVendors`/`probeVendor({ verify: true })` +
`probeBackend` (imported from `../../dist/index.js`), fold only an aggregate
detected row into its single matching configured row, map
`loginProbe`/PATH/reachability to the rows above, and apply the empty-state rule.
Print no credential.
**Verification:** E1 — natural red first: on the current revision the raw bundled
entry is attached, so the adapter's single `usage` command is not resolved and the
default `/usage` output has no subscription rows; assert that failure, then green.
Runnable: `pnpm test tests/extensions/usage-adapter.spec.ts tests/cli/launch.spec.ts
tests/extension-surface.spec.ts`. The new spec at
`tests/extensions/usage-adapter.spec.ts` drives the real `launchPlan` wiring and
the adapter factory with the actual installed bundled factory and Pi's real
extension registration resolution; only external I/O (vendor status runner, network,
filesystem home) is stubbed, never `ui.custom`→`done()` merely to assert the selector
was called. Default `/usage` asserts subscription rows, a latest numeric snapshot
with freshness, mixed per-provider failure isolation, and no inherited "No matching
configured providers" message; `/usage details` drives the captured selector's actual
render and asserts real quota/reset output from a synthetic provider response (no
live accounts). Add a package/launcher smoke test to the existing packaging/launcher
specs that imports the shipped `extensions/usage/index.ts` after `pnpm build`, to
catch `files`/export omissions as a distinct runtime risk.
**Checkpoint:** pending — MEDIUM: one `prd-work-reviewer` (or equivalent orchestrator review of the same scope).

#### Phase 2: `/models` freshness, readiness and provenance
**Status:** NOT STARTED
**ACs:** AC-6, AC-7, AC-8
**Files:** `src/commands/model.ts` (clock seam, calendar-age formatter,
source/missing-record line, native readiness wording); `src/commands/surface.ts`
(add `clock?: () => Date` to `CommandSurfaceDeps`).
**Implementation:** Thread `clock()` through `renderModels` → `loadRanking({ now })`
and the formatter; compute whole local calendar days from date components (0 same
day, 1 next day; malformed date → `age unknown`, future date → `future-dated`, never
a bogus/negative 0; singular/plural); add the binding-source line keeping the
configured binding and the resolved fallback both visible when they differ, plus the
single missing-record coverage line while keeping existing score/price/evidence;
render native probes as reachability; keep all six rows and explicit `models:`
entries. Leave `ageDaysOf`/`age_days`/`stale` as the elapsed-day policy.
**Verification:** E2 — red first for the changed display using an explicit injected
clock and timezone that reproduces the bug, e.g. `now = 2026-09-20T00:30:00Z` at
`America/Vancouver` against record `2026-09-19`, where the current UTC-boundary
elapsed count disagrees with the local calendar day. `pnpm test
tests/commands/model-doctor.spec.ts tests/capability/ranking.spec.ts` plus the
UTC-vs-America/Vancouver and DST boundary cases and malformed/future-date cases;
assert `age_days`/`stale` unchanged.
**Checkpoint:** pending — MEDIUM: one `prd-work-reviewer` (or equivalent orchestrator review of the same scope).

**Final:** `pnpm test`, `pnpm typecheck`, `pnpm lint` once across the finished change.

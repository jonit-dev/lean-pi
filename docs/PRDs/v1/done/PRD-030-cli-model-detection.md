# PRD-030 — Bug report: subscription model selection for Claude Code and Codex

**Status:** DONE
**Progress:** 100% — all five roots fixed and tested. Roots 1-3 (discovery,
ranking records, the JEV ballot) shipped in `367167f`; root 4 (the user-facing
inventory and the missing binding writer) in this change. Root 5 (Pi's own
`/model` picker) stays out of scope, restated below.
**Complexity:** 2 (LOW-MEDIUM) as implemented.
**Owner:** LeanPi maintainers
**Depends on:** None. Related: PRD-029 (provider usage / ranking) as a related plan; its implementation status is not checked here.
**Reported:** 2026-09-20
**Closed:** 2026-09-21

## Context

**Lead diagnosis: this is a model-selection gap, not a detection gap.** LeanPi
already detects the installed Claude Code and Codex CLIs and their logins. The
incomplete parts are: discovering the *set* of models a subscription exposes,
automatic ranking/binding of those vendor-native ids, and a user-facing way to
choose a variant ("opus 5", "sonnet", "astra", "sol", "luna"). Detection of
executables is already working on the inspected machine.

**Required by the user:** JEV's automatic model selection must receive data for
**every discovered provider configured on the OS**, including providers with no
role binding. This covers the full supported provider inventory, including
OpenCode/native providers; Claude and Codex are the reproduced examples.
Provide each provider's discovered models, readiness, execution route, and known
or explicitly unknown model metadata. Keep credentials out of this data.

**There is a working workaround, for workers only.** A per-role entry in the
config file (`models.<role>.backend` / `.model`) is read by `resolveRole`
([src/core/roles.ts:38-48](../../../../src/core/roles.ts#L38-L48)) and worker turns
forward it as `--model`
([src/backends/registry.ts:324](../../../../src/backends/registry.ts#L324)). So a
user who hand-edits YAML can bind a worker role to a vendor-native id today.
What is missing is discovery of the choices, ranking, and a user-facing
selector. The main Pi chat model picker is a separate surface
([src/cli/bootstrap.ts:470-481](../../../../src/cli/bootstrap.ts#L470-L481)) and is
not fixed by the per-role workaround.

Terminology kept distinct below: **account** (Claude Code / ChatGPT
subscription), **backend/provider** (`claude`, `codex` = `external_harness`;
`opencode-go` = `native`), **model id** (`claude-opus-5`, `gpt-6-astra`),
**CLI alias** (`opus`, `sonnet`, `haiku` for `claude --model`).

## Findings and reproduction

Detection is healthy — rule it out. `detectVendors({verify:true})` reports
`claude`, `codex`, `opencode` with `onPath:true, signedIn:true`; `/doctor`
agrees. Expected: a user can list and select any model their subscription
exposes. Actual: only one configured default per CLI is visible, no Codex role
exists, and Claude rows render with unknown metadata.

Safe, local reproductions. **Prerequisite:** a built tree (`pnpm build`
producing `dist/`) or importing the runner from an installed copy; the `node`
commands below import `dist/`, so without a build they fail to resolve the
module, not the model. No paid inference, no credential printed. The recorded
output below is from the prior arm log
`/tmp/leanpi-model-detection.UMFH5i/arm.log` (lines 644-658); it was not re-run
for this prose-only revision.

```sh
# 1. detection works
node --input-type=module -e "const {detectVendors}=await import('./dist/backends/subscriptions.js'); for(const s of detectVendors({verify:true})) console.log(s.vendor,s.onPath,s.signedIn)"
# claude true true / codex true true / opencode true true
# 2. discovery returns ONE configured id for claude/codex, not the available set.
#    Note the returned JSON includes `vendor`; these are the recorded objects.
node --input-type=module -e "const {detectModels}=await import('./dist/cli/allocate.js'); for(const v of ['claude','codex','opencode']) console.log(v, JSON.stringify(detectModels(v)))"
# claude [{"vendor":"claude","model":"opus[1m]","source":"claude settings"}]
# codex  [{"vendor":"codex","model":"gpt-6-astra","source":"codex config.toml"}]
# opencode [{"vendor":"opencode","model":"opencode-go/deepseek-v4.1-flash","source":"opencode models"},{"vendor":"opencode","model":"opencode-go/muse-spark-1.3-contributor","source":"opencode models"}]
# 3. /models lists role rows only: no Codex row; Claude rows unranked
node --input-type=module -e "const {loadConfig}=await import('./dist/core/config.js'); const {createCommandSurface}=await import('./dist/commands/surface.js'); const {renderModels}=await import('./dist/commands/model.js'); const cwd='/tmp/leanpi-probe'; const config=loadConfig(cwd); const host={current:()=>({}),agent:()=>undefined,adopt:()=>{},sessionDir:()=>'/tmp'}; console.log(await renderModels(createCommandSurface({cwd,config,host})))"
# strong claude/claude-opus-5  coding_score: unavailable  price: unknown  roles: unlisted
# ... no codex row at all
```

Observed config: `backends = claude, codex, opencode-go`; `models` has no Codex
role binding. Pi's catalog (`pi --list-models --offline`) exposes only
`opencode`/`opencode-go`; `piProviderReady('anthropic')`/`('openai-codex')` false.

### Confirmed roots

1. **P1 — discovery reads a configured default, not the available models.**
   `detectModels` for Claude reads `~/.claude.json` or `~/.claude/settings.json`;
   Codex reads `~/.codex/config.toml`. Each returns one configured model
   ([src/cli/allocate.ts:93-99](../../../../src/cli/allocate.ts#L93-L99)).
   Alternatives to that saved default do not enter the inventory.
   Fix: enumerate through supported installed interfaces —
   Codex app-server `model/list` (`includeHidden:false`, cursor pagination;
   metadata only, **not** entitlement proof) and Claude's documented `--model`
   aliases ([Claude Code model configuration](https://code.claude.com/docs/en/model-config))
   plus current/configured exact ids when no supported enumeration API is
   present; mark discovery incomplete rather than inventing a flag. Add each
   discovered model as its own candidate with unknown metadata.

2. **P1 — the ranking lacks records for the detected current ids, swallows the gap,
   and is stale.** These are one defect: there is no bridge from discovery to
   ranking and no record to land on. Binding matches only exact
   `model_id`/`aliases` ([src/capability/index.ts:48](../../../../src/capability/index.ts#L48));
   the bundled `models.json` (revision 1) lacks `claude-opus-5`, `gpt-6-astra`,
   `deepseek-v4.1-flash`; `selectRoleModel` then returns `ref:null` with a
   `capability_gap` ([src/capability/roles.ts:150-158](../../../../src/capability/roles.ts#L150-L158)),
   which `resolveRole` discards and silently static-falls-back
   ([src/core/roles.ts:39-47](../../../../src/core/roles.ts#L39-L47)). No test joins
   `detectModels`/auto-config ids to `models.json`. Fix: add ranking records for
   CLI-backed models with `price_blended_per_mtok` and `coding_score` left null
   when unmeasured (never aliased across model generations, never a fabricated
   score/price; canonical aliases for the *same* model are allowed), bump
   `revision`, surface the gap instead of hiding it, and add a join test.

3. **P1 — JEV's role-allocation ballot is built only from the incomplete
   discovery inventory, so JEV never sees the subscription set.** The complete
   traced flow is below. `detectModels` returns a single candidate for
   claude/codex (root 1), and that short array is the *entire* enum JEV is asked
   to choose from. JEV therefore receives `claude:opus[1m]`,
   `codex:gpt-6-astra`, `opencode-go:…`; other Claude and Codex choices are absent.
   Candidates also carry only
   `vendor/backend/model/source` ([src/cli/allocate.ts:25-33](../../../../src/cli/allocate.ts#L25-L33)),
   so JEV gets no installed/authenticated availability, no explicit
   `external_harness` vs `native` marker beyond the backend string, no
   capability/price, and no explicit "unknown". Signed-out vendors are dropped
   before candidates exist ([src/cli/bootstrap.ts:237](../../../../src/cli/bootstrap.ts#L237),
   [259-265](../../../../src/cli/bootstrap.ts#L259-L265)), so an unsupported vs an
   unknown-to-JEV model are indistinguishable. The plumbing is not the bug; the
   input to it is. Fix: discovery returns the full inventory with the fields
   above, and the ballot is built from it.

4. **P1 — user-facing selection is incomplete.** `/models` iterates configured
   roles and session bindings only
   ([src/commands/model.ts:68](../../../../src/commands/model.ts#L68));
   `surface.bindings` is declared and read but has no writer anywhere
   ([src/commands/surface.ts:75-76](../../../../src/commands/surface.ts#L75-L76));
   `bindings.set` has zero matches in `src/`. `/route` pins classes, not models
   ([src/commands/route.ts:118-128](../../../../src/commands/route.ts#L118-L128)).
   The per-role YAML workaround above is the current answer; a selector must
   write the config binding (persisted, deterministic) and optionally a session
   override, and the persisted value must actually reach runtime dispatch.
   Pi's `/model` sees only Pi-registered providers, not external CLI harnesses.

5. **P2 — external CLI backends are deliberately absent from Pi's registry, so
   the main-session picker cannot reach them.**
   [src/index.ts:150](../../../../src/index.ts#L150) registers `native` backends
   only. For role workers this is correct; the main Pi chat model is Pi's own.
   Fix (scope/contract, not a menu row): label `native` API vs CLI-backed models
   separately and state that a main-session Pi bridge for CLI-backed models is
   implementation needed — there is no available workaround today. This is
   explicitly separate from the minimum per-role/JEV fix: **a per-role binding
   does not make Pi's `/model` select the main CLI model.**

### JEV data flow, traced

**Bootstrap-time role allocation.** `autoConfigure` builds
`candidates = usable.flatMap(detectModels)` ([src/cli/bootstrap.ts:259-265](../../../../src/cli/bootstrap.ts#L259-L265)),
then either `ladderAllocation` (no client) or `allocateRoles(client, candidates)`
([src/cli/bootstrap.ts:266-269](../../../../src/cli/bootstrap.ts#L266-L269)).
`allocationQuestions` turns each candidate into one Choice option keyed by
`candidateKey` = `${backend ?? vendor}:${model}` with label `${vendor} ${model}`
([src/cli/allocate.ts:105-131](../../../../src/cli/allocate.ts#L105-L131)).
`allocateRoles` asks `client.ask(ALLOCATE_SITE_ID, questions, { candidates })`
([src/cli/allocate.ts:198](../../../../src/cli/allocate.ts#L198)). The wire shape
places the candidate enum in `questions[id].criteria`
([src/jev/client.ts:128-137](../../../../src/jev/client.ts#L128-L137)); `applyPrivacy`
hashes only `state` in `metadata-only` mode, never `questions`, so the enum
reaches JEV intact in every mode except `disabled`
([src/jev/privacy.ts:86-97](../../../../src/jev/privacy.ts#L86-L97)). The returned
`choice` is a `candidateKey`, matched back to `candidates`
([src/cli/allocate.ts:210-218](../../../../src/cli/allocate.ts#L210-L218)) and
written as `models.<role>.backend/model` in the generated config
([src/cli/bootstrap.ts:166-170](../../../../src/cli/bootstrap.ts#L166-L170)).

**Existing connection, stated precisely:** candidates → `criteria` enum →
JEV `choice` → persisted role config → `resolveRole` → `modelFor`/`--model` is
wired end to end. It is not bypassed or dropped. The missing connection is
**breadth of input**: one model for claude/codex, and none of the availability /
execution-type / capability / price / explicit-unknown fields.

**Persistence and runtime effect.** The persisted binding is the per-role YAML
already used; `resolveRole` ([src/core/roles.ts:38-48](../../../../src/core/roles.ts#L38-L48))
returns it and `modelFor` reads the backend's role map
([src/backends/worker.ts:185-187](../../../../src/backends/worker.ts#L185-L187));
worker dispatch forwards it ([src/backends/registry.ts:324](../../../../src/backends/registry.ts#L324)),
each descriptor emitting `--model` ([src/backends/harness.ts:195](../../../../src/backends/harness.ts#L195),
[237](../../../../src/backends/harness.ts#L237), [264](../../../../src/backends/harness.ts#L264)).
Session overrides exist as a read path only
([src/commands/surface.ts:118-126](../../../../src/commands/surface.ts#L118-L126)).
An explicit pin must not be silently overwritten by ranking: `resolveRole`
consults `resolveRoleViaRanking` first ([src/core/roles.ts:39-40](../../../../src/core/roles.ts#L39-L40)),
so a pinned role needs the ranking to defer to the explicit binding, not outrank
it.

**Runtime JEV model selection is a separate path.** `selectRoute`'s
`quota_preference` site offers JEV the `finalists` and may only reorder inside
the tie band ([src/routing/router.ts:321-340](../../../../src/routing/router.ts#L321-L340)).
Those finalists come from `defaultClearingSource` →
`selectCheapestClearing(ranking, …)`
([src/routing/candidates.ts:51-76](../../../../src/routing/candidates.ts#L51-L76),
[src/capability/select.ts:102-131](../../../../src/capability/select.ts#L102-L131)),
i.e. the committed `models.json`, **not** the bootstrap `detectModels`
inventory. A record with a null `coding_score` is not a candidate at all
([src/capability/select.ts:79](../../../../src/capability/select.ts#L79)).
The fix must supply the complete OS-discovered inventory as JEV decision data
at both selection sites, separately from the eligible candidate enum. Runtime
capability floors, auth checks, and tie-band constraints still apply: retain
excluded providers/models in the data with their exclusion reasons. Unknown
scores stay unknown; adding null-score ranking records alone does not make a
model eligible. `resolveRoleOrNull` in the same path reads the persisted role
config ([src/routing/router.ts:105-112](../../../../src/routing/router.ts#L105-L112)).

Candidate details placed only in `state` are hashed in `metadata-only` privacy
mode. Put the allowlisted, nonsecret provider/model facts in the transmitted
selection question or another privacy-permitted field; test the final wire
request in that mode. Do not weaken privacy or send raw OS config/credentials.

**Refresh.** Discovery runs only inside `autoConfigure`, which returns early
when any config exists ([src/cli/bootstrap.ts:230-232](../../../../src/cli/bootstrap.ts#L230-L232));
there is no existing refresh lever. The fix should re-invoke the existing
`detectModels`/`allocateRoles` path explicitly after an inventory refresh,
login, or config change — reusing that path, not adding a watcher/daemon.

### Model → CLI forwarding

Forwarding already exists: `runWorkerTurn` resolves `packet.model ?? modelFor(...)`
([src/backends/registry.ts:324](../../../../src/backends/registry.ts#L324)) and each
descriptor emits `--model <packet.model>` — claude
[harness.ts:195](../../../../src/backends/harness.ts#L195), codex
[harness.ts:237](../../../../src/backends/harness.ts#L237), opencode
[harness.ts:264](../../../../src/backends/harness.ts#L264). The gap is upstream:
bootstrap writes only choices from its incomplete inventory, and there is no
user-facing model-binding writer afterwards. Provider prefixes differ
(opencode wants `opencode-go/<id>`; claude/codex take bare ids
or aliases). The minimum integrated fix is inventory → JEV selection →
persisted binding → `modelFor` → existing `--model` argv, with per-vendor id
normalization. A menu row alone does not reach the CLI.

## Affected surfaces

`/models` ([src/commands/model.ts](../../../../src/commands/model.ts)), `/route`
([src/commands/route.ts](../../../../src/commands/route.ts)), `/status`
(`bindingFor`), `/doctor` probes ([src/commands/surface.ts:200-240](../../../../src/commands/surface.ts#L200-L240)),
first-run auto-config ([src/cli/bootstrap.ts:236-269](../../../../src/cli/bootstrap.ts#L236-L269)),
discovery + JEV ballot + persistence
([src/cli/allocate.ts](../../../../src/cli/allocate.ts)), JEV wire/privacy
([src/jev/client.ts:128-137](../../../../src/jev/client.ts#L128-L137),
[src/jev/privacy.ts:86-97](../../../../src/jev/privacy.ts#L86-L97)),
role resolution ([src/core/roles.ts](../../../../src/core/roles.ts),
[src/capability/](../../../../src/capability/index.ts)), runtime routing + runtime
JEV site ([src/routing/router.ts](../../../../src/routing/router.ts),
[src/routing/candidates.ts](../../../../src/routing/candidates.ts)), worker argv
([src/backends/harness.ts](../../../../src/backends/harness.ts),
[src/backends/registry.ts](../../../../src/backends/registry.ts)) and Pi provider
registration ([src/index.ts:139-200](../../../../src/index.ts#L139-L200)).

## Limitations and unsupported assumptions

- Installed CLI + `signedIn` proves a login, **not** which models the account is
  entitled to. No entitlement claim is made here; no paid inference was run.
- Codex `model/list` returns metadata, not entitlement proof
  ([Codex app-server](https://learn.chatgpt.com/docs/app-server#list-models-modellist)).
  Claude aliases (`opus`/`sonnet`/`haiku`) are documented selectors; allowlists
  can restrict them ([Claude Code model configuration](https://code.claude.com/docs/en/model-config)),
  so discovery may be incomplete and must say so. Unknown metadata does **not**
  automatically mean auth is unavailable; the two are separate fields.
- Fixes must reuse the existing CLI adapters and preserve CLI-owned auth
  (Keychain/config), including Claude Code's own login ownership
  ([Claude Code authentication](https://code.claude.com/docs/en/authentication)).
  **No exporting subscription OAuth tokens to direct API adapters.**
- No quota-telemetry claim is made; if such data is unavailable the fields stay
  explicitly unknown. PRD-029 is referenced as the related ranking/usage plan,
  nothing more.
- Snapshot: evidence (detection, discovery, `/models`) was gathered at `4e45ba9`
  and recorded in `/tmp/leanpi-model-detection.UMFH5i/arm.log`. This document was
  reviewed later at `40489a8`. Anchors above were re-read at the review revision;
  the tree is concurrently dirty (another agent's `.gitignore` edit), which does
  not touch the cited model path. No detection or test run is re-executed for
  this prose-only revision.

## Solution (proposed)

Ship discovery → JEV selection → persisted binding → dispatch as two phases;
keep the main-session bridge explicitly out of the minimum fix. Reuse
`detectVendors`, `detectModels`, `allocateRoles`, `runHarness` and the existing
`--model` argv; add no new provider and no watcher. Native API models keep Pi
provider registration; CLI-backed models keep CLI auth and dispatch through
`external_harness`.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: Discovery covers every found provider configured
      on the OS, independent of role bindings, and its discoverable models (via
      injected fixtures for Claude, Codex, and OpenCode/native providers), each record carrying
      backend/vendor id, model id/alias, installed/authenticated availability
      with unsupported distinguished from unknown, execution type
      (`external_harness` vs `native`), and available capability/price info or
      an explicit unknown — ≥2 distinct Claude and ≥2 distinct Codex entries, no
      invented `--list-models`. Evidence: `tests/cli-bootstrap.spec.ts:359,384` —
      13 models on the maintainer's machine (4 Claude, 7 Codex, 2 OpenCode).
- [x] AC-2 [local; actor: agent]: The complete inventory reaches JEV. Using the
      existing mock/interception seams — the `client` mock in
      `tests/cli-bootstrap.spec.ts:64` and the request-capturing stub in
      `tests/helpers/stub-jev.ts` — the test inspects JEV's actual request
      candidate enum/prompt in metadata-only privacy mode and asserts data for
      every fixture provider, ≥2 Claude and ≥2 Codex candidates plus an OpenCode
      candidate, including a configured-but-unbound Codex backend; JEV chooses
      a **non-default** Codex candidate; the persisted per-role YAML binding and
      the forwarded CLI argv (`--model <codex id>`) are asserted through the
      existing spawn seam. No real model call. Evidence: `tests/cli-bootstrap.spec.ts:397`.
- [x] AC-3 [local; actor: agent]: Runtime JEV receives the same complete inventory
      as decision data, with eligibility/exclusion reasons and a separately
      constrained choice enum. A persisted binding actually affects runtime:
      `resolveRole` returns it and `runWorkerTurn` forwards it; an explicit pin
      is not overwritten by ranking. Evidence: `tests/routing/router.test.ts:229`,
      `tests/capability/resolve.spec.ts:163`.
- [x] AC-4 [local; actor: agent]: New/unmeasured CLI models are their own
      ranking records with null price/coding_score, never aliased across model
      generations, and `resolveRole` reports `capability_gap` instead of
      silently falling back. Evidence: `src/capability/models.json` revision 2;
      `tests/capability/resolve.spec.ts:163`.
- [x] AC-5 [local; actor: agent]: The targeted discovery→JEV→binding, join and
      model→argv tests pass, and the repo gates `pnpm test`, `pnpm typecheck`,
      `pnpm lint` exit 0. Evidence: 110 files / 642 tests passed, typecheck and lint
      exit 0 (below).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Subscription model inventory | `/models` (or new surface) → discovery | Extends role-only listing | AC-1 |
| JEV role allocation input | `autoConfigure` → `allocateRoles` → JEV criteria enum | Fills the incomplete ballot | AC-2 |
| Per-role model selection | selection command → persisted binding → `runWorkerTurn --model` | Adds missing writer for `surface.bindings`/config | AC-3 |
| Native vs CLI dispatch | selection → `external_harness` vs Pi provider | Preserves CLI auth boundary | AC-3, AC-4 |
| Main-session Pi picker | Pi `/model` | Out of minimum fix; separate bridge | Root 5 |

Integration: wired. `/models` lists the inventory and `/models use` writes the
binding that `resolveRole` → `modelFor` → `--model` already dispatched.

## Execution Phases

#### Phase 1: Discover all configured providers and supply their models to JEV

**Status:** DONE (`367167f`)
**ACs:** AC-1, AC-2, AC-3
**Files:** `src/cli/allocate.ts` (enumerate via Codex `model/list` + Claude aliases; carry availability/execution-type/capability fields into candidates and the JEV ballot), `src/cli/bootstrap.ts` (persist the selected per-role binding; re-invoke on explicit refresh), `src/jev/client.ts` (only if the wire question shape needs the extra fields), `src/commands/model.ts` (inventory/selection surface), `src/commands/surface.ts` (binding writer), `src/backends/harness.ts` (id normalization).
**Implementation:** enumerate all supported providers found/configured on the OS, without requiring a role binding; add model records with explicit unknowns; include the full nonsecret inventory in JEV's transmitted decision data and runnable candidates in its choice enum; validate the response; persist the per-role YAML binding so it reaches runtime; dispatch through the existing adapters; keep CLI auth in the CLI.
**Verification:** E1 — a `tests/cli-bootstrap.spec.ts` test that intercepts the JEV request enum (stub seam), drives a non-default Codex pick, and asserts persisted binding + `--model` argv via the spawn seam; AC-1/2/3.
**Checkpoint:** passed — `tests/cli-bootstrap.spec.ts:347,396`.

#### Phase 2: Bind ranking and make the gap visible

**Status:** DONE (`367167f`)
**ACs:** AC-4, AC-5
**Files:** `src/capability/models.json` (records + revision bump), `src/capability/index.ts` / `roles.ts` (matching, gap reporting, explicit-pin deference), `src/core/roles.ts`, `src/routing/router.ts` / `candidates.ts` (runtime candidate inventory), tests under `tests/capability/` and `tests/backends/`.
**Implementation:** add records with truthful metadata; surface `capability_gap` from `resolveRole`; never alias across generations; pass the full inventory and exclusion reasons into runtime JEV while preserving eligibility/tie-band constraints; add discovery→ranking and final-wire-request tests.
**Verification:** E2 — `npx vitest run tests/capability tests/backends/subscriptions.spec.ts tests/commands/model-doctor.spec.ts tests/cli-bootstrap.spec.ts` plus `pnpm typecheck`/`pnpm lint`; AC-4/5.
**Checkpoint:** passed — `tests/capability/resolve.spec.ts:163`, `tests/routing/router.test.ts:229`.

**Future full gate (repo rules):** `pnpm test`, `pnpm typecheck`, `pnpm lint`. The
targeted future invocation is
`npx vitest run tests/cli-bootstrap.spec.ts tests/jev-client.spec.ts tests/capability/resolve.spec.ts tests/capability/select.spec.ts tests/routing/router.test.ts tests/backends/harness.spec.ts`.

## Resolution

#### Phase 3: Show the inventory and let a role be bound to it

**Status:** DONE
**ACs:** AC-1 (surface), AC-3 (persistence)
**Files:** `src/commands/model.ts` (inventory section + `/models use`),
`src/core/config.ts` (`writeRoleBinding`), `tests/commands/model-bind.spec.ts`.
**Implementation:** `/models` appends the `discoverInventory()` listing under the
role rows, and `/models use <role> <backend>:<model>` writes the role — and the
`external_harness` backend entry when the config has none — key by key like
`writeSkillsState`, then updates the running session's config and
`surface.bindings`. That map was declared and read with no writer anywhere; this
is the writer. No new provider, no new dependency: the CLI adapters, the
inventory and the `--model` argv already existed.
**Verification:** E3 — `npx vitest run tests/commands/model-bind.spec.ts`, red
before the change (`expected '…' to contain 'claude:opus[1m]'`, and
`/models use` refused as an unknown flag), green after.
**Checkpoint:** passed.

Root 4's diagnosis held exactly: discovery was healthy on the reporting machine
(13 models — 4 Claude, 7 Codex, 2 OpenCode) and **invisible**, because `/models`
listed configured roles only and `autoConfigure` returns early once a config
exists. A user with three subscriptions saw the one model their config named and
concluded nothing was detected.

Third-party routes were considered and rejected: `pi-harness-delegate`,
`oh-my-subscriptions` and `cli-bridge` all implement the architecture LeanPi
already has — detect the installed CLI, spawn it, leave its login in it
(`detectVendors` → `discoverInventory` → `runHarness --model`). Installing one
would add a dependency for behaviour this repository ships.

**Still out of scope (root 5):** Pi's own `/model` picker reaches Pi-registered
providers only ([src/index.ts:150](../../../../src/index.ts#L150)); `/models use`
binds LeanPi's *roles*, not the main chat model. A main-session bridge for
CLI-backed models remains implementation needed, with no workaround.

## Checks actually run

- `npx vitest run tests/commands/model-bind.spec.ts` → red before the Phase 3
  change (2 failed), green after (2 passed).
- `pnpm test` → 110 files / 642 tests passed, 2 files / 10 tests skipped, exit 0.
- `pnpm typecheck` → exit 0; `pnpm lint` → exit 0 (warnings only, pre-existing).
- `/models` re-run against the built tree on the reporting machine: 13 discovered
  models listed, all `external_harness, ready`.
- Prior run at `4e45ba9` (recorded, not re-run): `npx vitest run tests/backends/subscriptions.spec.ts tests/commands/model-doctor.spec.ts tests/cli-bootstrap.spec.ts tests/capability` → 7 files / 77 tests passed, exit 0.

## Unresolved questions

1. ~~Which surface did the user actually invoke~~ — answered: LeanPi's `/models`,
   which listed configured roles only. Fixed in Phase 3. Pi's `/model` remains
   root 5, out of scope.
2. Does the installed Claude CLI expose a supported model-enumeration interface
   (e.g. `supportedModels`) on this version? Not confirmed; if absent, Phase 1
   ships aliases + configured ids and labels discovery incomplete.

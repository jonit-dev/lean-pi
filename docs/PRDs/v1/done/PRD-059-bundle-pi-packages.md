# PRD-059 — Bundle pi.dev packages: web search, context view (cache optimizer measured out)

**Closed:** 2026-10-27 at `d74b154`, archived to `done/`.

**Status:** DONE — 2026-10-27. Every phase and acceptance box verified.
**Complexity:** 3 (LOW); risk override: none. Each package is pinned, attached only at launch, and removable by deleting one line.
**Owner:** LeanPi maintainers
**Depends on:** None

## Context

João picked three packages from the pi.dev catalog scan (2026-10-26). Each one fills a gap in the LeanPi proposal:

| Package | Gap it fills | Risk found in the source audit |
|---|---|---|
| `pi-web-search@1.7.0` | LeanPi has no web search. It runs on providers the user is already signed in to, so it needs no new key. | It supports only the `anthropic-messages`, `openai-responses`, Google and Ollama APIs. LeanPi's shipped `opencode-go` backend uses `openai-completions`, so the tool fails on the default model (`src/providers/config.ts:getProviderKind`). |
| `pi-context-view@0.8.0` | Shows what fills the context: base prompt, tool schemas, extension injections. This proves "lean context". | It registers `/context`, which LeanPi already owns (`src/commands/context.ts:145`). Pi would rename both to `context:1`/`context:2`. It adds per-turn capture hooks, a possible cost to the startup and turn KPIs. It makes no model calls. |
| `pi-cache-optimizer@2.10.4` | Stable tool order in the payload, Anthropic cache-TTL order repair, cache stats in the footer. | LeanPi already ships its main lever, `PI_CACHE_RETENTION=long` plus `prompt_cache_key` (PRD-046, FR-152, measured 24% cheaper). Its retention gate can strip `prompt_cache_retention` on non-official OpenAI hosts such as `opencode.ai`, which would undo PRD-046. It writes `models.json` only through its own `/cache-optimizer` command. |

How bundled packages ship today: `scripts/build-extensions.mjs` precompiles each listed package into `dist/extensions/<name>/`, `src/cli/extension-loader.ts` maps the imports, and `src/cli/launch.ts:bundledExtensions()` attaches them with `--extension`. `extensions/usage/index.ts` is the existing pattern for taking over a bundled package's command name.

## Solution

1. Add the three packages to the build `groups` and attach each in `bundledExtensions()`.
2. `extensions/context-view/index.ts` runs the `pi-context-view` factory and registers its `context` command as `context-view`, so LeanPi's `/context` stays the only owner.
3. Web search runs on the cheapest supported model the user already has. When the operator has no `PI_WEB_SEARCH_CONFIG` and no `~/.pi/agent/web-search.json`, `launchEnv()` points `PI_WEB_SEARCH_CONFIG` at a bundled `opencode-go/claude-haiku-5-5` config ($0.10/$0.50 per Mtok, the cheapest `anthropic-messages` model in Pi's `opencode-go` catalog).
4. The cache optimizer ships only if an A/B shows that cost per verified completion does not go up, the same rule as FR-152. If it does go up, it is not attached, and the result goes in Decisions.

New ROADMAP requirement: **FR-154 — SHOULD:** Bundle `pi-web-search` on the cheapest search-capable model of a login the user already holds, and `pi-context-view` as `/context-view` so `/context` keeps one owner.

## Acceptance Criteria

- [x] AC-1 [local]: A real `leanpi --print` turn on the shipped config answers with a `web_search` tool call that returns sources. proof: `node bin/leanpi.js --print "Call the web_search tool exactly once …"` — Evidence: exit 0; the session log's `web_search` tool result has `isError: false`, `modelId: claude-haiku-5-5`, 9 sources, native search used. The first try failed ("model was not found": registering the `opencode-go` backend replaces Pi's catalog); `registerBackends` now keeps the configured search model's catalog entry. Red/green: `tests/cli-bootstrap.spec.ts` "keeps the catalog entry `pi-web-search` is pointed at" fails without the fix (`expected undefined to be 'anthropic-messages'`), passes with it.
- [x] AC-2 [local]: The launch args attach web search and the context view, and the view registers `context-view`, never `context`. proof: `pnpm vitest run tests/cli/launch.spec.ts` — Evidence: 26 passed, "attaches web search and the context view, the view as `/context-view`".
- [x] AC-3 [local]: `launchEnv()` sets `PI_WEB_SEARCH_CONFIG` only when the operator has no search config of their own and holds an `opencode-go` credential. proof: `pnpm vitest run tests/cli/launch.spec.ts` — Evidence: "points web search at the opencode-go login only when the operator decided nothing" passes.
- [x] AC-4 [local]: Startup time to ready does not regress by more than 10%. proof: `node scripts/bench-startup.mjs --runs 8`, with and without the two extensions — Evidence: the "extensions + runtime" phase p50 is 1533 ms with, 1519 ms without (+0.9%). Total p50 (4111 ms with, 4910 ms without) is noise: desktop load average 58 on 12 cores.
- [x] AC-5 [local]: The cache optimizer A/B decides its ship by measurement. proof: final provider payload captured by a last-loaded `before_provider_request` logger on a real `leanpi --print` turn, with and without `--extension pi-cache-optimizer/index.ts` — Evidence: identical keys, `prompt_cache_key` present and `prompt_cache_retention: "24h"` in both, same tool order. Pi chains handler results (`runner.js:1074-1078`), and the optimizer ran (it wrote its stats shards). Not shipped; see Decisions.
- [x] AC-6 [local]: No regression. proof: `pnpm test`, `pnpm typecheck`, `pnpm lint` in a clean worktree off `main` — Evidence: 1187 passed / 12 skipped (`main`: 1184 + the 3 new tests), typecheck exit 0, lint exit 0. A first full run under load average 58 failed 30 tests in 9 files. Those failures did not reproduce: the 9 files passed 86/86 alone, and a full rerun passed.

## Decisions
- 2026-10-26 (agent, under João's "go with 1, 3, 4" and the ship-by-measurement rule above): `pi-cache-optimizer` is not bundled. On LeanPi's default route it changes nothing in the request (AC-5): PRD-046 already sends the cache key, 24h retention and a stable tool order. It would add about 30 source files of load for no saving. FR-154 drops it.
- 2026-10-26 (agent): AC-5's instrument is a payload capture, not `pnpm bench`. `pnpm bench` boots `createLeanPiSession()`, which loads no bundled extensions, and a one-trial cost A/B has a measured 2.4× within-arm swing (`docs/benchmarks/2026-09-21-four-way-harness-cost.md`).
- 2026-10-26 (agent): `tests/cli/launch.spec.ts` no longer lists `pi-context-view` as a duplicate of a LeanPi subsystem. It is attached only through the adapter that renames its command, and the test asserts that.
- 2026-10-26 (agent): `THIRD_PARTY_NOTICES.md` is unchanged. It lists no npm runtime dependencies (both packages are MIT and ship with their own LICENSE in `node_modules`).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Web search tool | `leanpi` → `launch.ts:bundledExtensions()` → `pi-web-search` `web_search` | New | AC-1 |
| Context view | `/context-view` → `extensions/context-view/index.ts` | New; LeanPi `/context` kept | AC-2 |
| Cache optimizer | — | Not attached (Decisions) | AC-5 |

## Execution Phases

#### Phase 1: Web search and context view ship
**Status:** DONE
**Files:** `package.json`, `scripts/build-extensions.mjs`, `src/cli/launch.ts`, `src/cli/bootstrap.ts` (agent-dir helpers moved to `launch.ts`), `src/cli/context-view.ts`, `src/index.ts` (`registerBackends` keeps the search model), `extensions/context-view/index.ts`, `extensions/web-search/opencode-go.json`
- [x] **Verification:** AC-1, AC-2, AC-3, AC-4. — evidence on the ACs above.

#### Phase 2: Cache optimizer, by measurement
**Status:** DONE
**Files:** none shipped; the measurement is AC-5
- [x] **Verification:** AC-5. — evidence on the ACs above.

#### Phase 3: Gates and docs
**Status:** DONE
**Files:** `docs/PRDs/v1/ROADMAP.md` (FR-154), `docs/usage.md`
- [x] **Verification:** AC-6. — evidence on the ACs above.

# PRD-046 — One-hour prompt-cache retention on the native path

**Status:** DONE
**Complexity:** 1 (LOW); risk override: none — reversible env default, but AC-2 guards the shipped `opencode-go` path.
**Owner:** LeanPi maintainers
**Depends on:** None

## Context

Borrowed from `unreallabsai/unreal-agent` (`harness/llm/clients/openrouter/client.go`): it sends `cache_control: {type: ephemeral, ttl: 1h}` plus an `x-session-id` header, arguing a 1h TTL survives the gaps an agent session produces (long tool calls, long reasoning turns) at 2x write cost instead of 1.25x, and saves a full-prefix rewrite per gap.

Pi already implements both halves; LeanPi turns on neither explicitly:

- Retention: `pi-ai/dist/api/anthropic-messages.js:21-35` and `api/openai-completions.js:142,570-579,792-796` read `options.cacheRetention` or `PI_CACHE_RETENTION=long`. Long → `ttl: "1h"` on Anthropic-format `cache_control`, and `prompt_cache_key` + `prompt_cache_retention: "24h"` on OpenAI-compatible endpoints whose compat has `supportsLongCacheRetention` (default true except Together and a few others, line 1296). Default is `short`. Pi's own cache warmer reads the same env (`pi-coding-agent/dist/core/cache-warmer.js:27`).
- Session affinity: **already on.** Pi passes `sessionId` on every request (`pi-coding-agent/dist/core/agent-session.js:3081`) and pi-ai sends `x-session-id` to OpenRouter by default (`openai-completions.js:541-543`, `types.d.ts:581`). Out of scope.

LeanPi spawns Pi with `launchEnv()` (`src/cli/launch.ts:341`), the single place the child's environment is decided.

Only the native API-key path benefits. Subscription runs through the Claude Code / Codex / OpenCode CLIs cache on their own terms.

## Solution

`launchEnv()` adds `PI_CACHE_RETENTION: "long"` unless the operator's environment already sets `PI_CACHE_RETENTION` (any value, including `short`/`none`, wins).

Risks, each owned by an AC:

1. The shipped `opencode-go` endpoint may reject the extra `prompt_cache_retention` / `prompt_cache_key` fields → AC-2.
2. A 1h write costs more than a 5m write; short sessions could get *more* expensive → AC-3 decides the default by measurement, not by argument.

New ROADMAP requirement: **FR-152 — SHOULD:** Launch Pi with long prompt-cache retention unless the operator sets `PI_CACHE_RETENTION`, when measurement shows it does not raise cost per verified completion.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: `leanpi` launched with no `PI_CACHE_RETENTION` sends a model request carrying long retention; with `PI_CACHE_RETENTION=short` set it does not — Evidence: E1, `tests/cli/launch.spec.ts` boots a real Pi session against the stub provider with `launchEnv()`'s env and asserts the request body carries `prompt_cache_retention: "24h"` + `prompt_cache_key`, and neither when the operator sets `short`.
- [x] AC-2 [local; actor: agent]: A real `leanpi --print` turn on the shipped `opencode-go` config completes with long retention on (no 4xx from the extra fields). Needs `OPENCODE_API_KEY`; without it this AC is `unreachable`, not passed — Evidence: E2, `node bin/leanpi.js --print "reply with exactly: ok"` exited 0 with reply `ok` on `leanpi.config.yaml`'s `opencode-go`/`deepseek-v4.1-flash`, retention on.
- [x] AC-3 [local; actor: agent]: `pnpm bench` on the four-way suite's tasks, LeanPi arm, `short` vs `long`, same model; cost per verified completion for both recorded in `docs/benchmarks/`. The default ships `long` only if it is not more expensive; otherwise `launchEnv()` reverts to Pi's default and the finding is recorded — Evidence: E3, `docs/benchmarks/2026-09-22-cache-retention.md`; `short` $0.031927 vs `long` $0.024343 per verified completion, both 4/4 — `long` is not more expensive, so the default ships.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Long cache retention | `leanpi` → `launchEnv()` (`src/cli/launch.ts:341`) → Pi child env → pi-ai request builder | Pi's `short` default, overridable by env | AC-1 / E1, AC-2 / E2, AC-3 / E3 |

## Execution Phases

#### Phase 1: Launch with long retention
**Status:** DONE
**ACs:** AC-1
**Files:** `src/cli/launch.ts` (one spread entry + doc comment line); `tests/commands/jev-provider.spec.ts` or the existing launch spec (extend); `docs/PRDs/v1/ROADMAP.md` (FR-152).
**Implementation:** `...(base.PI_CACHE_RETENTION === undefined ? { PI_CACHE_RETENTION: "long" } : {})` in `launchEnv()`.
**Verification:** E1 — red first: a test that points a Pi session at a local HTTP stub provider (the `stock-pi` adapter's `models.json` custom-provider path, `src/bench/adapters.ts`) with the env from `launchEnv()`, captures the request body, and asserts `prompt_cache_retention`/`prompt_cache_key` present; a second case with `PI_CACHE_RETENTION=short` in `base` asserts them absent. Asserting only `launchEnv()`'s return value is not enough: that would not prove Pi reads the variable.
**Checkpoint:** passed

#### Phase 2: Live probe and cost decision
**Status:** DONE
**ACs:** AC-2, AC-3
**Files:** `docs/benchmarks/<date>-cache-retention.md` (new); `src/cli/launch.ts` only if AC-3 reverts.
**Implementation:** Run one `leanpi --print "reply ok"` on the shipped config; then the bench arms at both settings. Record per-arm cost from the §52 records, not console output.
**Verification:** E2 — exit 0 and a non-empty reply from the live turn. E3 — bench report rows for both arms, with the decision rule applied as written.
**Checkpoint:** passed

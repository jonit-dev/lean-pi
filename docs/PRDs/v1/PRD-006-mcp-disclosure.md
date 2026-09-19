# PRD-006 — MCP Disclosure

**Status:** NOT STARTED
**Complexity:** 7 (HIGH)
**Risk override:** None beyond the score — 7 already lands HIGH (6–10 files, new module, connection/process lifecycle state, remote HTTP + OAuth). The trust and allow/ask/deny boundary is PRD-017's engine, consumed here; AC-7 proves enforcement at the MCP invocation site rather than redefining the rules.
**Owner:** joao
**Depends on:** PRD-002, PRD-004, PRD-017

## Context

**Covers:** FR-015, FR-080, FR-081, FR-082, FR-083, FR-084, FR-086, FR-087, FR-146; ROADMAP §15, §17, §22, §48, §49, §51 (MCP, UX/Commands), §59 P0 / §60 P1.

Current behavior: none. `/home/joao/projects/lean-pi` is greenfield — `docs/PRDs/v1/ROADMAP.md` is the only file. Every path below is created by this PRD's phases or by a dependency PRD.

ROADMAP §17 makes MCP first class (stdio, HTTP, OAuth, project and user scope, enable/disable, health/status) while refusing the usual cost: MCP tool schemas are permanently resident context in most harnesses, and OpenCode explicitly advises installing only the servers you need for that reason. §15 forbids handing the executor every installed capability. §17's worked example is 50 installed tools → metadata only → JEV → 4 relevant tools → executor sees 4 schemas, plus a mid-task path where an executor *requests* capability through the capability router instead of everything being exposed up front.

Inspected: ROADMAP §15, §17, §22 (prompt layering), §48 (project-local MCP configuration requires trust), §49 (JEV-off fallback = pinned/project-default servers), §51 MCP block + FR-146, §59 (MCP relevance/disclosure is P0; advanced OAuth is P1 in §60). Dependencies consumed: PRD-002 `src/jev/client.ts` and its decision-site registry; PRD-004 `src/compiler/contract.ts` (`ExecutionContract.capabilities.mcps`) and the compile step; PRD-017's `assertTrusted()` inside `loadConfig` (`src/core/config.ts`), which drops an untrusted project-local `.leanpi/mcp.json` before this PRD's catalog is built, plus its allow/ask/deny engine; PRD-001 `LeanPiConfig` and the prompt/tool assembler.

## Solution

Reuse the official `@modelcontextprotocol/sdk` client and its transports (`StdioClientTransport`, `StreamableHTTPClientTransport`) and OAuth provider. LeanPi implements the *disclosure* layer only — no bespoke protocol code, no transport abstraction beyond what the SDK already gives.

**Catalog, out of band.** `src/capabilities/mcp/catalog.ts` merges user-scope `~/.leanpi/mcp.json` and project-scope `<project>/.leanpi/mcp.json` (project shadows user for the same server name). Trust is not handled here: PRD-017's `assertTrusted()` runs inside `loadConfig` and drops an untrusted project-local `.leanpi/mcp.json` before the catalog sees it (ROADMAP §48), so this PRD defines no trust logic and no trust prompt of its own. The catalog produces a compact record per tool — `server, transport, scope, tool, one-line summary, risk` — and nothing else. Full JSON schemas stay on disk in `<project>/.leanpi/cache/mcp-catalog.json`, written after any successful connect and refreshable with `/mcp refresh`. A server that has never connected contributes the `tools` hints from its config entry, so **catalog construction never opens a connection** (FR-087).

**Selection.** `src/capabilities/mcp/select.ts` sends the compact catalog to JEV: is any external capability needed, which servers are relevant, which tools within them. Only confirmed tools' full schemas are hydrated from cache into `ExecutionContract.capabilities.mcps`, and the prompt/tool assembler exposes exactly those to the executor (`mcp.maxTools` cap, default 6). Unselected servers contribute zero bytes and are never connected.

**Lazy connect.** `src/capabilities/mcp/client.ts` holds a connection pool keyed by server name. `getClient(server)` spawns the stdio child process or opens the HTTP session on **first actual tool use**, not at session start, not at catalog build. Health (`connected` / `disconnected` / `error` / `auth_required`) and the last error are recorded for `/mcp`. HTTP servers use the SDK OAuth provider with tokens stored via the same config store; a missing or expired token surfaces as `auth_required` plus an authorization URL from `/mcp`, and the task continues without that server rather than failing (advanced OAuth flows are §60 P1 and out of scope). Every invocation passes through PRD-017's permission engine first.

**Mid-task router.** `requestCapability(query, state)` in `select.ts` is the §17 capability router: an executor asking for a capability mid-task gets the same JEV selection run over the compact catalog, and at most the newly admitted tool's schema is added to the live tool set. A query matching nothing returns a typed refusal and admits nothing. This is the only way schemas enter context after compile.

Consumer path: user task in a LeanPi session → compile (PRD-004) → `selectMcpTools()` → contract → assembled executor tool set → first call to a selected tool → lazy connect → MCP response. Plus: `/mcp` for inspection and control, `requestCapability()` for mid-task admission.

**JEV off.** Per §49, selection falls back to manually pinned and project-default servers only — never the full catalog.

Restated non-goals (ROADMAP §58) binding on this PRD: no blanket capability exposure; no generative router replacing JEV (selection is typed `Choice`/`Score`); no unbounded autonomy (mid-task admission is routed and capped, and permission checks are not bypassed); no JEV requirement for basic operation; no vendor-limit bypass — OAuth uses the server's own flow and stores nothing outside the configured store.

## External Skill Dependencies

None. MCP servers are user-configured external processes and endpoints, not Agent Skills; no installed skill under `/home/joao/.claude/skills`, `/home/joao/.codex/skills`, or the plugin cache implements or is consumed by this PRD. Agent Skill discovery and indexing of those roots belongs to PRD-005.

## JEV Decision Sites

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| MCP disclosure (site id `mcp.disclosure`, registered with PRD-002's decision-site registry; telemetry tag `mcp.disclosure`) | Q1 "Does this task require any external MCP capability?" · Q2 per server "How relevant is this server to the task?" (Q1+Q2 share one request over the compact catalog) · Q3 per tool of the selected servers "Is this tool needed for this task?" | Q1 `Choice` (yes/no) · Q2 `Score` · Q3 `Choice` | Manually pinned servers plus project-default servers only, never the full catalog (ROADMAP §49); `mcp.maxTools` cap still applies | ★★★★★ |
| Mid-task capability request (same site id, `phase: request`) | "Which catalog entry, if any, satisfies this capability request?" | `Choice` over catalog entries including an explicit *none* option | Lexical match of the request text against tool name/summary within pinned and project-default servers; no match → typed refusal | ★★★★★ |

No other site is claimed here: PRD-005 owns skill disclosure, PRD-004 owns compiler classification, PRD-023 owns file/search exploration, PRD-002 owns the registry mechanism.

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: `/mcp` in a session lists servers merged from user scope (`~/.leanpi/mcp.json`) and project scope (`<project>/.leanpi/mcp.json`) showing transport, scope, enabled state, health, and tool count; a server name present in both scopes appears once with `scope: project`. Fixture: one stdio server and one HTTP server. — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: `/mcp disable <server>` removes that server's tools from the catalog and from any subsequent executor tool set, and the server is never connected; the state survives a session resume; `/mcp enable <server>` restores it. — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: For a fixture catalog of ≥50 tools across ≥6 servers, the executor tool set assembled after compile contains schemas for only the JEV-selected tools (≤ `mcp.maxTools`) and zero schemas — zero bytes — from unselected servers; a task JEV answers "no external capability needed" yields an executor tool set with no MCP tools. — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: Starting a session and compiling a task starts no MCP server process and opens no HTTP session; the stdio fixture server's process appears (observed via the marker file it writes on startup) only when a selected tool is first invoked, and unselected servers' markers never appear. — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: An executor mid-task capability request routed through `requestCapability()` adds exactly the one newly admitted tool's schema to the live tool set (diffed before/after) and nothing else; a request matching no catalog entry returns a refusal and leaves the tool set unchanged. — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: The HTTP fixture server requiring bearer auth is callable when a stored token is present; with the token removed, `/mcp` reports that server as `auth_required` with an authorization URL, the server stays disconnected, and the task completes using the remaining servers instead of erroring. — Evidence: pending.
- [ ] AC-7 [local; actor: agent]: A selected MCP tool covered by a `deny` rule in PRD-017's permission engine is refused at the invocation site — the executor receives a refusal and the fixture server records no inbound request; an `ask` rule prompts before the request is sent. — Evidence: pending.
- [ ] AC-8 [local; actor: agent]: With `jev.enabled=false`, the AC-3 fixture task exposes only pinned/project-default servers' tools (not the full catalog), the session completes, and the telemetry decision row for site `mcp.disclosure` records `fallback_used: true`; with JEV enabled the same task's exposed tool set differs, proving the JEV answer determines exposure. — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| MCP servers are inspectable and controllable | `/mcp`, `/mcp enable\|disable\|refresh\|login <server>` → `src/commands/mcp.ts` (created in Phase 1) → `src/capabilities/mcp/catalog.ts` (Phase 1) | New; greenfield, no incumbent | AC-1, AC-2, AC-6 |
| Only selected MCP schemas reach the executor | User task in session → compile step `src/compiler/compile.ts` (PRD-004; edited Phase 3) → `selectMcpTools()` in `src/capabilities/mcp/select.ts` (Phase 3) → `ExecutionContract.capabilities.mcps` → tool/prompt assembler `src/core/prompt.ts` (PRD-001; edited Phase 3) | New; the "all MCP schemas resident" default is never shipped | AC-3, AC-8 |
| MCP servers connect only when used | First invocation of a selected tool → `getClient()` in `src/capabilities/mcp/client.ts` (Phase 2) | New | AC-4, AC-6 |
| Mid-task capability admission is routed | Executor capability request during execution → `requestCapability()` in `src/capabilities/mcp/select.ts` (Phase 4) → live tool set update | New; replaces the alternative of pre-exposing everything | AC-5 |
| MCP calls obey the permission engine | Tool invocation → `src/capabilities/mcp/client.ts` (Phase 4 edit) → PRD-017 allow/ask/deny engine | Consumes PRD-017; no parallel rule set defined here | AC-7 |

## Execution Phases

#### Phase 1: Scoped configuration, compact catalog, and `/mcp`
**Status:** NOT STARTED
**ACs:** AC-1, AC-2
**Files:** `src/capabilities/mcp/catalog.ts` (new: scope merge, enable/disable state, compact records, schema cache file); `src/commands/mcp.ts` (new: `/mcp`, `/mcp enable|disable|refresh <server>`); `tests/mcp-catalog.test.ts` (new); `tests/fixtures/mcp/**` (new: stdio fixture server script, HTTP fixture server, two scope config files).
**Implementation:** Read the trusted server entries from `LeanPiConfig.capabilities.mcpConfigPaths` — user-scope `~/.leanpi/mcp.json` then project-scope `<project>/.leanpi/mcp.json`, resolved from `os.homedir()` / project root, already filtered by PRD-017's `assertTrusted()` in `loadConfig` (ROADMAP §48). Merge by server name, project wins. Build compact records `{server, transport, scope, tool, summary, risk}` from the cached schema file when present, else from the config entry's `tools` hints; never connect here. Persist enable/disable per server in `LeanPiConfig.mcp.state` (runtime knob, distinct from the trust-gated `capabilities.mcpConfigPaths` discovery input). `/mcp` renders server rows (transport, scope, enabled, health, tool count) and `/mcp <server>` expands its tools.
**Verification:** E1 — `npx vitest run tests/mcp-catalog.test.ts`: `/mcp` output through the real command entry point asserts scope shadowing (duplicate name once, `scope: project`) and per-server rows (AC-1); `/mcp disable` → reload → tools absent from `catalog()` and the server's marker file absent (AC-2). Negative control: an empty config pair yields zero rows, so the assertions are sensitive to the merge actually running.
**Checkpoint:** pending

#### Phase 2: Lazy transports, health, and OAuth
**Status:** NOT STARTED
**ACs:** AC-4, AC-6
**Files:** `src/capabilities/mcp/client.ts` (new: connection pool, `@modelcontextprotocol/sdk` stdio + streamable-HTTP transports, SDK OAuth provider, health tracking, schema-cache refresh on connect); `tests/mcp-client.test.ts` (new); `tests/fixtures/mcp/**` (edit: startup marker + request log in both fixture servers).
**Implementation:** `getClient(server)` creates and memoizes a connection on first call; session start and catalog build never call it. On successful connect, list tools and write full schemas to `<project>/.leanpi/cache/mcp-catalog.json`. Health transitions recorded for `/mcp`: `disconnected` → `connected` | `error` | `auth_required`. HTTP servers wrap the SDK OAuth provider with tokens read from the configured store; a 401 or missing token sets `auth_required` with the provider's authorization URL, leaves the server disconnected, and returns a typed non-fatal result so the task continues. Stdio child processes are terminated on session end; connect failures never throw into the executor loop.
**Verification:** E2 — `npx vitest run tests/mcp-client.test.ts`: after session start and a full compile, assert neither fixture server's startup marker exists; invoke one selected tool and assert only that server's marker appears (AC-4). Remove the stored token and assert `/mcp` reports `auth_required` with a URL, the server stays disconnected, and a task using the other server still completes (AC-6). The marker files are written by the real fixture servers, so a mocked-out transport cannot produce a pass.
**Checkpoint:** pending

#### Phase 3: JEV selection into the executor tool set
**Status:** NOT STARTED
**ACs:** AC-3, AC-8
**Files:** `src/capabilities/mcp/select.ts` (new: `selectMcpTools()`, pinned/project-default fallback); `src/compiler/compile.ts` (edit: call selection, fill `capabilities.mcps`); `src/core/prompt.ts` (edit: expose only contract-listed MCP tool schemas); `tests/mcp-select.test.ts` (new).
**Implementation:** Register site `mcp.disclosure` with PRD-002's decision-site registry (question set, return types, confidence threshold, fallback `pinned-default`, telemetry tag). One `ask()` carries the compact catalog with Q1 (any external capability needed) and per-server relevance `Score`; a `no`, or confidence below threshold, selects nothing. Q3 confirms individual tools of the top servers. Hydrate only confirmed tools' schemas from the cache into `ExecutionContract.capabilities.mcps`, capped by `mcp.maxTools` (default 6). The assembler builds the executor tool set strictly from that list. JEV error or `jev.enabled=false` → pinned plus project-default servers only, telemetry row marked `fallback_used: true`.
**Verification:** E3 — `npx vitest run tests/mcp-select.test.ts`: compile a fixture task against a ≥50-tool / ≥6-server catalog with a scripted JEV transport and assert the assembled tool set contains only the selected tool names and that no unselected server's schema text appears anywhere in the assembled context; a "no capability needed" answer yields no MCP tools (AC-3). E4 — rerun the same fixture with `jev.enabled=false`: only pinned/project-default tools exposed, session completes, telemetry `fallback_used: true`, and the exposed set differs from E3's (AC-8) — the differential is the negative control that the JEV answer, not the catalog order, drives exposure.
**Checkpoint:** pending

#### Phase 4: Mid-task capability router and permission enforcement
**Status:** NOT STARTED
**ACs:** AC-5, AC-7
**Files:** `src/capabilities/mcp/select.ts` (edit: `requestCapability()`); `src/capabilities/mcp/client.ts` (edit: permission check before every invocation); `tests/mcp-router.test.ts` (new).
**Implementation:** `requestCapability(query, state)` runs the registered site in `phase: request` mode — one `Choice` over compact catalog entries plus an explicit *none* option — and on a hit hydrates that single tool's schema into the live tool set, respecting `mcp.maxTools` (evicting the lowest-scored admitted tool when full) and disabled-server exclusions (untrusted project config never reaches the catalog, per PRD-017). A *none* answer, or a below-threshold confidence, returns a typed refusal that admits nothing. Before any `callTool`, `client.ts` consults PRD-017's engine with the tool's capability id: `deny` returns a refusal without sending a request, `ask` prompts and only then sends, `allow` proceeds. No permission semantics are defined in this PRD.
**Verification:** E5 — `npx vitest run tests/mcp-router.test.ts`: snapshot the executor tool set, issue a matching capability request, and assert exactly one added tool schema and no other change; issue a non-matching request and assert a refusal with an unchanged tool set (AC-5). E6 — with a `deny` rule for one selected tool, invoke it and assert the executor gets a refusal and the fixture server's request log is empty; with an `ask` rule, assert the prompt fires before the logged request (AC-7). The fixture server's request log is the production-path evidence that a denied call was never sent.
**Checkpoint:** pending

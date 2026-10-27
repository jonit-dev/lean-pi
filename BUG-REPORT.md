# LeanPi bug report

✅ **TLDR:** Nine bugs reproduced: five high priority and four medium priority. The existing suite passes, but it misses these cases. Fix the permission and privacy failures first.

**Next action:** Add regression tests for bugs 1–3 before changing their shared permission/privacy code.

## Scope and checks

What this repo does: LeanPi adds task compilation, model routing, tool selection, verification, and cost accounting to Pi. It also manages goals, PRDs, subagents, and terminal UI extensions. The assumed load is one developer running local sessions with bounded concurrent workers.

| Item | Audited state |
| --- | --- |
| Date | 2026-10-26 |
| Revision | `e7f3dd7dc84cf28a36f0a4582b1c8a482da4a59d` |
| Package | `leanpi@0.1.15` |
| Runtime | Node `v22.22.0`; Corepack-provided pnpm `11.25.0` |
| Starting checkout | `main`, one commit ahead of `origin/main`; untracked `.playwright-mcp/` preserved |
| Method | Feature inventory from README, usage docs, source modules, command registration, and tests; full existing test suite; targeted source review and local reproduction probes |

The feature matrix below distinguishes automated coverage from live verification. Passing existing tests does not mean a feature has no bugs. This is a report-only audit; application code and tests were left unchanged.

| Command/check actually run | Result |
| --- | --- |
| `pnpm test`, `pnpm typecheck`, `pnpm lint` | ⚠️ Initial attempts could not start: `pnpm` was absent from `PATH`. Used Corepack for the checks below. |
| `corepack pnpm build` | ✅ Exit 0 |
| `corepack pnpm typecheck` | ✅ Exit 0 |
| `corepack pnpm lint` | ⚠️ Exit 0 with warnings, including unused imports and redundant spreads; these are not counted as bugs |
| `corepack pnpm test --reporter=dot` | ✅ 173 files passed, 4 files skipped; 1,161 tests passed, 12 tests skipped; 26.79 seconds |
| `node bin/leanpi.js --version` | ✅ Exit 0; printed upstream Pi version `1.4.0` |
| `node dist/bench/lane.js --list` | ✅ Exit 0; listed 10 seed tasks and configurations |
| `corepack pnpm bench:cost-gate` | ⚠️ Skipped by its opt-in guard; exit 0 is **not** a measured cost-gate pass |
| Targeted `node --input-type=module` probes | ✅ Reproduced the nine findings below using freshly built modules, temporary repositories, synthetic text, an injected JEV transport, and local MCP/LSP stubs |

The test run emitted missing-source-map warnings for packaged files and the vendored thinking-fold extension. It still completed successfully. No live provider cost, visual correctness, or production-readiness claim follows from this run.

## Must fix

### 1. P1 — Metadata-only mode sends private text inside questions

**Location:** [src/jev/privacy.ts:90](src/jev/privacy.ts#L90), [src/jev/client.ts:305](src/jev/client.ts#L305), [src/goal/boundary.ts:36](src/goal/boundary.ts#L36), [src/exploration/sites.ts:117](src/exploration/sites.ts#L117).

**What this is:** `metadata-only` promises to replace user content with metadata before hosted JEV requests leave the machine.

**Problem:** The privacy transform processes `body.state` only. Dynamic questions also contain goal text, objectives, snippets, and paths. Those question instructions, choices, and identifiers remain unchanged.

**Reproduction:** Construct a real JEV client in `metadata-only` mode with an injected transport. Ask `goal.semantic_completion` using `semanticQuestion()` with the synthetic goal `CONFIDENTIAL-AUDIT-GOAL-7831`. Inspect the request body captured by that transport.

```text
privateTextInState: false
privateTextInQuestions: true
instructions: Given this evidence, is the goal clause
              "CONFIDENTIAL-AUDIT-GOAL-7831" satisfied?
```

**Expected:** User content is absent from the entire outbound request under this mode. The probe intercepted the actual serialized request; it sent no private data to a remote service.

**Smallest fix:** Keep question templates static and carry dynamic content in the privacy-transformed state. Use opaque question/choice identifiers where paths currently appear, with local mapping back to paths. Add an outbound-request regression test using a real dynamic question builder.

**If skipped:** A user selecting metadata-only mode can still disclose confidential work to the hosted control plane.

### 2. P1 — A harmless first Git command hides later forbidden operations

**Location:** [src/permissions/rules.ts:242](src/permissions/rules.ts#L242), [src/permissions/rules.ts:431](src/permissions/rules.ts#L431).

**What this is:** Shell calls must satisfy each relevant permission, including destructive Git and network scopes.

**Problem:** `gitInvocation()` finds only the first `git` token and subcommand in the whole shell string. Later Git invocations contribute no destructive/network scopes.

**Reproduction:** Use `builtinPermissions()`, set `shell` to `allow` and `network` to `deny`, then pass each string through `classifyScopes()` and `resolveAll()`. Destructive Git remains denied by the built-in default.

| Input to the classifier; commands were not executed | Actual scopes | Actual decision |
| --- | --- | --- |
| `git reset --hard` | `shell`, `git_destructive` | `deny` |
| `git status; git reset --hard` | `shell` | `allow` |
| `git fetch origin` | `shell`, `network` | `deny` |
| `git status && git fetch origin` | `shell` | `allow` |

**Expected:** Both compound forms are denied, just like their standalone operations. The same classifier serves `execute`, `bash`, `bash_bg`, and command-based `monitor` calls.

**Smallest fix:** Classify every Git invocation in supported shell command segments and combine the required scopes. Refuse ambiguous compound forms when their scope cannot be established. Add both destructive and network compound-command tests.

**If skipped:** Allowing routine shell work can also allow commands that discard edits or use the network despite explicit denials.

### 3. P1 — LSP tools bypass read and external-directory denials

**Location:** [src/permissions/rules.ts:506](src/permissions/rules.ts#L506), [src/lsp/tools.ts:202](src/lsp/tools.ts#L202), [src/lsp/client.ts:220](src/lsp/client.ts#L220).

**What this is:** LSP tools read files for navigation and diagnostics. They are ordinary guarded tools, and their schema accepts absolute file paths.

**Problem:** No LSP name is classified as a read tool. The permission engine treats it as `shell:<tool-name>` and ignores its file argument. The LSP implementation then resolves and reads that path without a root-boundary check.

**Reproduction:** Create a temporary repository and a sibling `external.ts` containing `export const outsideAudit = 7831;`. Configure a local stub language server. Set `shell: allow`, `read: deny`, and `external_dir: deny`. Run the installed permission hook followed by the real `lsp_hover` tool definition in `LSP_FULL` mode.

```text
readPolicy: deny
externalDirPolicy: deny
guardBlocked: false
returned contents: export const outsideAudit = 7831;
```

**Expected:** The guard blocks the call before the file is read or sent to the language server. A regular `read` request for that external path correctly resolves to `deny` in the control case.

**Smallest fix:** Classify file-based LSP tools under `read` and classify their file arguments under `external_dir` when necessary. Give workspace-symbol queries the read scope too. Add a guard-to-handler test for an external file.

**If skipped:** Read restrictions can be bypassed through navigation tools. Conversely, denying shell access also blocks otherwise permitted read-only LSP work.

### 4. P1 — Closing a PRD can overwrite an archived plan

**Location:** [src/prd/commands.ts:54](src/prd/commands.ts#L54), [src/prd/commands.ts:152](src/prd/commands.ts#L152).

**What this is:** The built-in `/prd close` fallback moves a verified plan into `done/` when an installed closure helper is unavailable.

**Problem:** If `git mv` fails, the catch block unconditionally calls `renameSync()` on the same destination. On this Linux environment, rename replaces an existing file. A destination collision therefore becomes a successful destructive overwrite.

**Reproduction:** In a temporary repository, create both `docs/PRDs/v1/PRD-001-same.md` containing `NEW PLAN` and `docs/PRDs/v1/done/PRD-001-same.md` containing `ORIGINAL ARCHIVE`. Persist a PRD state with its criterion verified, configure an empty skill root, and invoke the real PRD handler with `close`.

```text
closeOk: true
archiveContent: NEW PLAN
oldArchiveLost: true
```

**Expected:** Refuse the collision and retain both files. No existing project PRDs were moved during this probe.

**Smallest fix:** Refuse an occupied archive destination before attempting either move. Restrict fallback handling to cases where a plain filesystem move is appropriate, while preserving the no-overwrite rule. Add a collision test for the fallback path.

**If skipped:** Previously completed plans can be lost. Bug 6 makes collisions more likely by reusing their identifiers.

### 5. P1 — Different clean revisions receive the same evidence freshness hash

**Location:** [src/verify/hash.ts:23](src/verify/hash.ts#L23), [src/verify/index.ts:117](src/verify/index.ts#L117), [src/verify/index.ts:197](src/verify/index.ts#L197).

**What this is:** Evidence records carry a workspace hash. Equality makes a stored measurement eligible to be treated as fresh.

**Problem:** The hash includes Git's dirty listing and the contents of dirty or explicitly touched paths. It includes neither the clean tracked tree nor its revision. With no explicit touched paths, two clean commits hash identically even when source changes. `verifyTask()` defaults to an empty touched-path list, and `/verify` does not supply one.

**Reproduction:** Initialize a temporary Git repository. Commit `app.js` with working source, calculate `workspaceHash(root)`, and record a passing check in `EvidenceStore`. Replace the source with a throwing implementation and commit it. Calculate the hash again and read the store using that hash.

```text
differentCommits: true
sameHash: true
oldPassStillFresh: 1
stale: 0
```

**Expected:** Changed tracked source invalidates the old evidence, including when the workspace is clean before and after the change.

**Smallest fix:** Include a tracked-tree identity in the hash, alongside dirty/touched contents. A Git tree identity preserves equality for commits with identical source bytes. Handle Git-unavailable calls without a known file scope conservatively. Add a committed-change freshness test.

**If skipped:** Reused evidence, or a revision change during verification, can be associated with source bytes that were not checked. A new `/verify` still runs checks; this finding concerns the freshness guarantee, not an unconditional skip of verification.

## Other confirmed bugs

### 6. P2 — New PRD identifiers ignore completed plans

**Location:** [src/prd/creator.ts:208](src/prd/creator.ts#L208).

**What this is:** `allocatePrdId()` promises to allocate the next unused `PRD-NNN` identifier.

**Problem:** It scans only immediate entries in `docs/PRDs/v1/`, excluding `done/`. Closing the highest-numbered plan makes its identifier available again.

**Reproduction:** Create only `docs/PRDs/v1/done/PRD-001-example.md` in a temporary directory and call `allocatePrdId(root)`.

```text
expected: PRD-002
actual:   PRD-001
```

The audited checkout also returns `PRD-055`, despite already containing completed plans numbered 055, 056, and 057.

**Smallest fix:** Include the active directory and its `done/` directory in the identifier scan. Add a test where the highest identifier exists only in the archive.

**If skipped:** New plans duplicate historical identifiers and their references. Repeating an objective can also trigger bug 4. This allocation defect and the unsafe archive move need separate safeguards.

### 7. P2 — HTTP MCP connections require a bearer token even when none is needed

**Location:** [src/mcp/client.ts:296](src/mcp/client.ts#L296).

**What this is:** The MCP client supports HTTP servers and configured request headers.

**Problem:** `connectHttp()` throws before initialization whenever its token store/environment lookup returns no token. That prevents public HTTP servers from working. It also rejects a server whose configured `headers.Authorization` already supplies its credential.

**Reproduction:** Start a local MCP HTTP stub that accepts initialization and lists one `echo` tool without requiring authentication. Call `createMcpPool(...).refresh('audit')` with no token, then with an explicit Authorization header, then with an unnecessary synthetic environment token as a control.

| Configuration | Actual result |
| --- | --- |
| Public server; no token | `requires authorization`; only OAuth metadata discovery reached the server |
| Explicit `headers.Authorization`; no token-store entry | `requires authorization` |
| Same public server with a synthetic `tokenEnv` value | One tool listed successfully |

**Expected:** Public servers initialize without a bearer token. Explicit authentication headers are usable without a duplicate token-store entry.

**Smallest fix:** Make the bearer header conditional, preserve configured headers, and attempt initialization. Enter the authorization-required path when the server actually refuses authentication. Add public-server and explicit-header cases.

**If skipped:** Valid HTTP MCP configurations cannot refresh or execute tools without unrelated credential setup.

### 8. P2 — HTTP MCP authentication is dropped when handed to vendor CLIs

**Location:** [src/mcp/tools.ts:196](src/mcp/tools.ts#L196), [src/backends/worker.ts:24](src/backends/worker.ts#L24), [src/backends/harness.ts:49](src/backends/harness.ts#L49).

**What this is:** Selected MCP servers are converted into Claude Code, Codex, or OpenCode configuration for an external-harness turn.

**Problem:** The HTTP projection carries only server name, URL, and allowed tool names. It drops configured headers and token information. All three vendor serializers consequently emit an HTTP endpoint without LeanPi's configured authentication.

**Reproduction:** Create an allowed HTTP catalog entry with an explicit synthetic Authorization header and `tokenEnv`. Run `resolveVendorServers()` and all three vendor serializers. Inspect only the presence of the synthetic credential in their outputs.

```text
projected server: { name, transport: http, url, tools }
claudeHasHeader: false
codexHasHeader: false
opencodeHasHeader: false
```

**Expected:** The supported authentication needed by the selected server survives the projection. Token/header values must remain out of telemetry and model prompts.

**Smallest fix:** Carry supported HTTP authentication through `WorkerMcpServer` and the vendor serializers. Resolve token references at the spawn boundary as needed. Add projection tests with authenticated HTTP entries instead of empty-header fixtures alone.

**If skipped:** An authenticated MCP server that works through LeanPi's own pool can fail in a vendor CLI unless that CLI has separate working authentication. Configuration loss was reproduced; live vendor authentication was not exercised.

### 9. P2 — `/cost` ignores the configured telemetry path

**Location:** [src/index.ts:1155](src/index.ts#L1155), [src/telemetry/cost.ts:133](src/telemetry/cost.ts#L133).

**What this is:** `cost.telemetry_path` changes where run accounting is stored. `/cost` and `/status` should read the same session records.

**Problem:** Activation passes a resolved cost config to the command surface and telemetry writer, but omits it from `registerCostCommand()`. `/cost` falls back to `.leanpi/telemetry.jsonl`.

**Reproduction:** Activate the real extension against a temporary workspace with `cost.telemetry_path: .leanpi/custom-cost.jsonl`. Append one $1 record for that activation's session to the configured store, then dispatch `/status` and `/cost` through its command registry.

```text
/status: session cost: $1.000000 over 1 run
/cost:   no telemetry recorded yet in <fixture>/.leanpi/telemetry.jsonl
```

**Expected:** Both commands read the custom store and show the same session total.

**Smallest fix:** Pass `cost: resolveCostConfig(config)` when registering `/cost`. Add a real-activation regression test with a custom telemetry path.

**If skipped:** `/cost` can show no spend, or read unrelated older records from the default store, while `/status` reports a different total.

## Feature coverage

“Existing tests passed” below means the applicable tests ran successfully in the full suite. It does not claim every branch was inspected or every integration was exercised live. Feature groups cover the documented command surface and runtime modules; source review was targeted, rather than a line-by-line review of all 220 tracked `src/` files.

### Startup and model selection

| Feature group | Checks and result |
| --- | --- |
| Launcher, CLI flags, local wrapper, packaging, precompiled extensions, build/vendoring | ✅ Build, binary version smoke, and existing `tests/cli/*`, `bootstrap`, `cli-bootstrap`, `dev-build`, and extension-surface tests passed. Actual installation into a new machine was not performed. |
| First-run onboarding, subscription detection, role allocation, auth warnings | ✅ Existing onboarding, bootstrap, allocation, subscription, and startup-warning coverage passed. External logins were represented by fixtures; real account access remains unverified. |
| Configuration discovery, defaults, overrides, persistence, project trust | ✅ Existing config and permission/trust tests passed. ⚠️ Custom telemetry path command wiring fails: bug 9. |
| Automatic/manual model selection, role binding, capability ranking, adaptive routing, calibration, reasoning effort, cooldown/fallback | ✅ Existing capability, routing, compiler classification, model-picker, manual-mode, role-binding, ratchet, and backend-selection tests passed. Live provider/model availability remains unverified. |

### Task execution and proof

| Feature group | Checks and result |
| --- | --- |
| Scout, task compiler, immutable contracts, PRD gate, turn lanes | ✅ Existing scout/compiler/session/wiring tests passed; source registration and lane entry points inspected. |
| Native workers, vendor workers, retries, escalation, aborts, deadlines, process cleanup | ✅ Existing executor/backend/process-safety tests passed against local fixtures and stubs. Paid end-to-end vendor turns were not run. |
| Reviewer lane, review levels, independent reviewer packets, proof decisions/recovery | ✅ Existing review/proof tests passed. The audit does not treat a model's completion statement as proof. |
| Deterministic verifier selection, scope injection protection, command execution, evidence freshness, `/verify` | ✅ Existing verification tests passed. ❌ Committed-change freshness probe fails the intended invariant: bug 5. |

### Tools, context, and boundaries

| Feature group | Checks and result |
| --- | --- |
| Baseline tools, permissions, safety profiles, shell/network/destructive scopes, secrets | ✅ Existing permission and secret tests passed. ❌ Compound Git classification and LSP read boundaries fail: bugs 2–3. |
| Skills registry, selection, progressive disclosure, trust, bundled pack integrity/sync | ✅ Existing fixture-based skill and pack tests passed. Machine-specific real-skill checks were skipped. |
| MCP catalog, stdio/HTTP pool, discovery/cache, mid-turn requests, tool surface, vendor projection | ✅ Existing MCP tests passed. ❌ Public/header-auth HTTP connections and vendor auth projection fail: bugs 7–8. Local HTTP stubs reproduced the connection failure. |
| LSP detection, trust, per-turn mode, navigation, diagnostics | ✅ Existing detection/mode/trust coverage passed; guarded stub-LSP probe reproduced bug 3. ⚠️ Four real-language-server tool tests were skipped because their required server was unavailable. |
| Artifact capture/expansion, context assembly, working state, deterministic compaction, RTK reduction and measurement defaults | ✅ Existing context/artifact/compaction/RTK tests passed; storage and reduction paths inspected. No new confirmed defect in this group. |

### Goals, plans, and state

| Feature group | Checks and result |
| --- | --- |
| Todo commands/tools, progress derivation, proof-gated completion, goal handoff | ✅ Existing todo tests passed, including state and prompt coverage. |
| Goal persistence, limits, stop precedence, semantic/machine clauses, PRD-derived goals | ✅ Existing goal tests passed. ❌ A real dynamic goal question exposes bug 1 under metadata-only mode. |
| PRD authoring, decomposition, execution manager, criterion state, closure/archive | ✅ Existing PRD fixture tests passed. ❌ Archive collision and archived-ID allocation probes reproduce bugs 4 and 6. |
| Worktree isolation, patch capture/apply, user-file protection, retention and cleanup | ✅ Existing runtime worktree, safety, isolation, and retention tests passed. No product worktrees were created for this report. |

### UI, accounting, and supporting tools

| Feature group | Checks and result |
| --- | --- |
| Slash commands, help, status, route, role/model, config, doctor, context, session commands | ✅ Existing command-surface and session tests passed. ⚠️ `/cost` diverges from `/status` with a custom store: bug 9. |
| Subagent registration/deduplication, concurrency limit, routing, native/external runners, cards; background-task adapter | ✅ Existing subagent, background, and adapter tests passed. Live external-runner authentication remains unverified. |
| Compact/plain UI, thinking fold/cache, spinner, footer, todo/recap widgets, recap generation, update notice and usage adapters | ✅ Existing UI/recap/usage/update tests passed. ⚠️ Interactive terminal appearance, keyboard behavior, and real quota endpoints were not manually exercised. |
| Runtime smoke, CLI checks, browser assertions, screenshot comparison | ✅ Existing runtime verifier tests passed using their available fixtures/adapters. ⚠️ No live browser visual inspection was performed. |
| Telemetry, pricing, per-run outcomes, UX KPI script/dashboard; benchmark harness, report/adjudication and cost regression gate | ✅ Existing telemetry, KPI, and benchmark tests passed; benchmark listing worked. ❌ Cost command path wiring fails: bug 9. ⚠️ Live cost gate skipped. The seed listing reports 10/16 categories and six golden commands without recorded end-to-end execution; this audit did not rerun those upstream tasks. |

## Limits and disposition

**Verdict:** The existing checks are green, but the permission/privacy boundaries and PRD archive behavior need fixes before they can be relied on. The nine probes demonstrate bugs missed by current coverage.

**Not checked:** Hosted JEV, actual Laya model inference/setup, paid Claude/Codex/OpenCode runs, real account quotas/OAuth, skipped machine-specific skill integrations, the unavailable real LSP tool suite, manual terminal/browser visuals, live benchmark costs, and non-Linux behavior. The standalone `experiments/laya-vs-jev` research run and benchmark replay/output history were not re-executed. Third-party dependency internals and bundled skill prose were not exhaustively audited.

**Delivery:** Only this report was added. No fixes, commits, pushes, merges, deployments, account changes, or real PRD moves were performed. Reproduction fixtures were removed and local stub services were closed.

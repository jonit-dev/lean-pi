# LeanPi code-quality report

**Revision:** `e2749a2e20e48892cf69f1fd4843ef472cf202a2` (`feat/thinking-fold`), working tree dirty
(`.gitignore` modified; `docs/PRDs/v1/PRD-030`, `PRD-032` untracked; `.probe/` untracked).
**Date:** 2026-09-21 · **Node** v22.22.0 · **pnpm** 11.25.0
**Method:** read-only. Every claim below points at a `file:line` or a command that ran. No source,
test, config or lockfile was modified; no commit was made; no credential value is reproduced.

## Verdict

**Healthy, unusually disciplined codebase with a strong security posture and real documentation
debt at the edges.** All three gates pass on a clean checkout, the permission engine is the most
carefully-built part of the tree, and there are zero import cycles across 185 source modules. The
findings that matter are concentrated in three places: a small set of **spawn sinks that bypass the
permission guard and its env allowlist**, a **trust surface that does not cover `leanpi.config.yaml`
despite a comment claiming it does**, and **one 1,251-line module (`src/index.ts`) that is
simultaneously the extension entry point, the public barrel and a ~510-line `activate()` function**.

## 1. Health baseline (commands run this pass)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | ✅ exit 0 |
| Lint | `npx oxlint src tests` | ✅ exit 0 — 36 warnings (17 in `src/`), 0 errors |
| Tests | `npx vitest run` | ✅ 109 files, 640 passed, 10 skipped, 2 files skipped, 18.4 s |
| Runtime smoke | `node bin/leanpi.js --help` | ✅ exit 0 |
| Dependency audit | `pnpm audit --prod` | ✅ no known vulnerabilities |
| Import cycles | static graph over `src/**/*.ts` | ✅ 0 cycles |

Scale: **34,468 LOC** in `src/` across 185 `.ts` files, **24,058 LOC** in `tests/` across 140 files
(≈0.70 test:source ratio), 3,363 `expect(` assertions (~5.3 per test).

## 2. Strengths (do not regress these)

- **Permission engine.** One chokepoint (`src/permissions/guard.ts:103`) covers built-ins, MCP and
  subagents; the strictest decision wins across every implicated scope; refusals are returned tool
  errors, never thrown (`guard.ts:12-13`). Project config can only *tighten* policy —
  `mergePermissions` rejects every project grant at or below the user baseline
  (`src/permissions/trust.ts:423-476`), and a project cannot grant itself `trust` (`trust.ts:462`).
- **`escapesRoot` fails closed.** The deepest existing ancestor is canonicalized, dangling symlinks
  are resolved via `lstat`/`readlink`, a 40-hop bound stops link cycles, and an uncanonicalizable
  ancestor is treated as escaping (`src/permissions/rules.ts:336-387`). This closes the symlink
  fail-open that an earlier audit flagged.
- **Secrets are never logged and never written into config.** Credential resolution order is
  explicit, the store is `0600` in a `0700` dir outside the repo, and `describeCredential` reports
  the source, not the value (`src/jev/credentials.ts:107-118`).
- **Degrade-never-throw telemetry.** A missing file, a crashed partial line, or a newer record shape
  yields the rows that parse (`src/telemetry/store.ts:83-104`).
- **Traceability.** 29 distinct PRD ids appear in test `describe` names; every behaviour is meant to
  own a numbered FR (`src/CLAUDE.md`). Skipped tests are all deliberate owner/machine gates, each
  with a comment explaining why (e.g. `tests/backends/fallback.spec.ts:92-95`).
- **Documented ceilings.** Deliberate simplifications carry `ponytail:` comments naming the ceiling
  and the upgrade path (`src/telemetry/store.ts:14`, `src/cli/fold-cache.ts:16`,
  `src/permissions/secrets.ts:10`).

## 3. Findings, by leverage

| # | Finding | Category | Impact | Effort | Risk | Confidence | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Contract/derived **scope is interpolated unquoted into a `shell: true` command** | Security | High | S | Low | Medium | `src/verify/descriptors.ts:111-121`, `src/verify/run.ts:28`, `src/verify/select.ts:45-46,131-138` |
| S2 | Verifier commands and harness backends **inherit the full `process.env`**; the allowlist covers only the `execute` tool | Security | Medium | M | Medium | High | `src/permissions/guard.ts:213` vs `src/verify/run.ts:28`, `src/backends/harness.ts:305` |
| S3 | `leanpi.config.yaml` is **outside the trust surface**, so `backends[].command` / `verify.commands` execute un-gated — contradicting the comment at the call site | Security | Medium | M | Medium | High | `src/permissions/trust.ts:198-205`, `src/core/config.ts:352-361` |
| A1 | `src/index.ts` is entry point + barrel + 510-line `activate()` in one 1,251-line file | Tech debt | Medium | M | Medium | High | `src/index.ts:407-918`, `src/index.ts:1060-1251` |
| A2 | Four functions of 175–336 lines | Tech debt | Medium | M | Medium | High | `src/executor/lane.ts:221`, `src/exploration/governor.ts:253`, `src/routing/router.ts:201`, `src/jev/client.ts:176` |
| D1 | 17 `src/` lint warnings — 7 unused imports, 8 useless spreads, 2 `new Array` | DX | Low | S | Low | High | `npx oxlint src` (list in §4.6) |
| A3 | `fold-cache.ts` monkeypatches a vendored UI's prototype via a **third-party private symbol** | Tech debt | Medium | S | Low | High | `src/cli/fold-cache.ts:30-56` |
| C1 | Duplicated comment block in the launcher (botched-edit residue) | Correctness (cosmetic) | Low | S | Low | High | `bin/leanpi.js:57-63` |
| D2 | PRD bookkeeping drifted: INDEX claims "all 26 DONE" while 029–032 are in flight; **PRD-032 exists twice with different content** | Docs | Low | S | Low | High | `docs/PRDs/v1/INDEX.md:5`, `docs/PRDs/v1/PRD-032-jev-optional.md` vs `done/PRD-032-jev-optional.md` |
| D3 | No coverage tooling configured; test health is inferred from pass counts | DX | Low | S | Low | High | `vitest.config.ts` (no `coverage` block), `package.json` |
| W1 | Telemetry store is fully re-read and re-parsed on every routed turn | Performance (watch) | Low | M | Low | High | `src/telemetry/store.ts:14,74-104`; `.leanpi/telemetry.jsonl` 204 KB, `decisions.jsonl` 1.1 MB |

### Considered and rejected

- **Adaptive router is dead code** (prior audit F1, `src/routing/router.ts:201`) — **fixed**.
  `src/executor/lane.ts:265-271` now calls `selectRoute` and pins the routed candidate.
- **Reviewer verdict ignored** (prior F2) — the executor lane now branches on
  `verdict.decision`, tracks `reviewRounds` and escalates or blocks
  (`src/executor/lane.ts:402-426`).
- **`escapesRoot` symlink fail-open** (prior S1) — **fixed**, see §2.
- **Skipped tests** — all 10 are owner/machine gates with explanatory comments; not a gap.
- **`new Array<number>(n)`** (`src/commands/registry.ts:90-91`) — the explicit type parameter makes
  intent unambiguous; the oxlint rule is a false positive here. Cosmetic only.
- **`shell: true` in `verify/run.ts` and `runtime/proc.ts`** — running a project's own verifiers is
  inherently arbitrary code execution (`npm test` runs `package.json` scripts); the finding is the
  *unquoted interpolation*, not the shell itself.
- **Test helpers with no `expect(`** — they are fixtures/harnesses, not tests.
- **Long functions in `src/bench/*`** — benchmark-only, not on the runtime path.

## 4. Detail

### 4.1 S1 — unquoted scope interpolation into a shell command

`applyScope` substitutes `{{scope}}` verbatim:

```ts
// src/verify/descriptors.ts:111-116
function applyScope(template: string, scope: string): string {
	const trimmed = template.trim();
	if (!trimmed.includes("{{scope}}")) return trimmed;
	return scope.trim().length === 0 ? "" : trimmed.replaceAll("{{scope}}", scope).trim();
}
```

The default `targeted_test` template is `"npx vitest run {{scope}}"` (`descriptors.ts:45`), and the
resolved string is executed through the platform shell:

```ts
// src/verify/run.ts:28
const child = spawn(command, { cwd, shell: true, detached: true, stdio: [...] });
```

`scope` has two sources, both string concatenations with no quoting or validation:

- `contract.verification.criteria[].scope` — arbitrary text read straight off the contract
  (`src/verify/select.ts:100-119`, chosen at `select.ts:131-134`). For the PRD lane this is
  acceptance-criterion text, which can be model-authored.
- `targetedSurfaceOf(diff.files)` — changed test paths joined with a space
  (`src/verify/select.ts:45-46`), so a filename containing shell metacharacters lands in the command.

**Impact.** A scope such as `x; curl … | sh` (or a test file named accordingly) is executed with the
verifier's privileges. The verifier runs *outside* `installPermissionGuard`, so the permission engine
never sees it.

**Effort S · Risk of fix Low.** Validate `scope` against a conservative allowlist (paths, globs,
spaces) and reject anything else before substitution, or shell-quote each token. A one-line guard in
`applyScope` plus a test that a metacharacter-bearing scope produces `not_run` rather than a command
is the whole change.

### 4.2 S2 — spawned children do not all get the allowlisted environment

`secrets.ts` states the intent: "a process LeanPi spawns receives an allowlisted environment rather
than the parent's environment" (`src/permissions/secrets.ts:5-8`). `childEnv` is applied in exactly
one place — the `execute` tool's spawn hook:

```ts
// src/permissions/guard.ts:213
spawnHook: (context) => ({ ...context, env: childEnv(context.env, policy()) }),
```

Verifier commands (`src/verify/run.ts:28`) pass no `env`, inheriting the full parent environment; the
harness backend spawns with `env: request.env`, which is `process.env` by construction
(`src/backends/harness.ts:300-306`). Every secret-named variable in the shell is therefore visible to
a spawned vendor CLI and to any verifier command.

**This may be intentional for PRD-008** (the comment at `harness.ts:300-302` says so explicitly), but
it is in direct tension with PRD-017's stated containment and is not documented as a decision
anywhere a reader would look. **Effort M · Risk Medium** — decide and record: either route harness and
verifier children through `childEnv` (plus each backend's declared passthrough), or document why they
are exempt. Do not change this without an explicit call; it can break vendor auth.

### 4.3 S3 — the trust surface excludes `leanpi.config.yaml`

`surfaceFiles` hashes the project's `.leanpi/extensions`, MCP config paths and skill roots — and
nothing else:

```ts
// src/permissions/trust.ts:198-205
export function surfaceFiles(surface: ProjectSurface): Map<string, string> {
	const files = new Map<string, string>();
	hashTarget(surface.root, surface.extensionsDir, files);
	for (const configPath of surface.mcpConfigPaths) hashTarget(surface.root, configPath, files);
	for (const skillRoot of surface.skillRoots) hashTarget(surface.root, skillRoot, files);
	return files;
}
```

But `loadConfig` reads the project file and keeps its `backends`, `models` and `verify.commands`
regardless of trust, while its own comment claims otherwise:

```ts
// src/core/config.ts:354-361
// PRD-017: assertTrusted runs between load and use. An untrusted project keeps
// nothing executable and nothing project-local on the capability surface.
const trust = assertTrusted(cwd, env, { skillRoots: ..., mcpConfigPaths: ... });
const skillRoots = trust.trusted ? capabilities.skillRoots : capabilities.skillRoots.filter(...);
```

`trust.trusted` is consulted in only two places in the tree: `config.ts:361` (skill roots) and
`src/mcp/catalog.ts:216` (MCP catalog). `verify.commands` (shelled via `execShell`) and
`backends[].command` (spawned via `spawnProcess`) are neither stripped nor hashed. `SECURITY.md`
explicitly names "a checked-out `leanpi.config.yaml`" as untrusted input that must "never … grant
itself a capability".

**Impact.** In a cloned repo, the project config can name an arbitrary backend command or verifier
command and it will run without a trust prompt, and editing the config does not invalidate an
existing trust record.

**Effort M · Risk Medium.** Cheapest resolution is a decision, not code: either add
`leanpi.config.yaml` to `surfaceFiles` and strip `backends`/`verify` when untrusted, or amend the
comment and `SECURITY.md` to state that config-declared commands are trusted by construction. Do not
leave the code and its comment disagreeing.

### 4.4 A1 — `src/index.ts`

1,251 lines holding three responsibilities: the `activate()` extension entry (`:407-918`, ~510
lines), the library session factory (`:920-1058`), and a barrel of ~200 re-exports (`:1060-1251`).
`export * from` appears 16 times (`:1117-1156`), so the module's public surface is every symbol of
permissions, telemetry, lsp, mcp, review, proof, capability, routing, exploration, runtime, bench,
todo, goal and rtk.

**Effort M · Risk Medium.** Splitting `activate()` into the units it already contains (backend
registration, prefix install, tool pipeline, command bridge, artifact tool) is mechanical, but the
barrel is a published API — moving re-exports changes nothing observable only if every name is
preserved. Characterization tests should land first (there is already `tests/extension-surface.spec.ts`
and `tests/bootstrap.spec.ts` to lean on).

### 4.5 A2 — long functions

`runExecutor` 336 lines (`src/executor/lane.ts:221`), `explore` 325 (`src/exploration/governor.ts:253`),
`selectRoute` 185 (`src/routing/router.ts:201`), `createJevClient` 185 (`src/jev/client.ts:176`).
`runExecutor` and `explore` are the two hottest runtime paths and the hardest to review. Extracting
the retry/evidence bookkeeping in `runExecutor` is the highest-value split.

### 4.6 D1 — lint warnings in `src/` (17)

Unused imports/types: `src/lsp/client.ts` (`LeanPiConfig`), `src/commands/route.ts` (`RoutePins`),
`src/commands/session.ts` (`buildStaticPrefix`), `src/index.ts` (`runTurn`, `setActivePrefix`),
`src/todo/goal.ts` (`RemainingWork`), `src/cli/bootstrap.ts` (`ModelRole`), `src/jev/credentials.ts`
(unused `env` parameter at `:74`). Useless spreads: `src/routing/config.ts:93`,
`src/executor/lane.ts:350`, `src/index.ts:182`, `src/mcp/client.ts:487`,
`src/runtime/screenshot.ts:86`, `src/bench/runner.ts:111`. Plus `no-new-array`
(`src/commands/registry.ts:90-91`, false positive) and `no-control-regex`
(`src/cli/spinner.ts:34`, intentional). Unused imports are the residue of past refactors — removing
them is pure deletion and confirms nothing else references them.

### 4.7 A3 — vendored-UI prototype patch

`installFoldCacheInvalidation` replaces `AssistantMessageComponent.prototype.render` and reads the
compact UI's cache through a **string-keyed global symbol** owned by another package
(`Symbol.for("pi-claude-style-tools:message-render-cache")`, `src/cli/fold-cache.ts:30-56`). It is
guarded (`INSTALLED`, `session_start`, `typeof inner === "function"`) and carries a `ponytail:` exit
path, but a `pi-claude-code-ui` upgrade that renames the symbol or stops calling the captured
`updateContent` silently regresses Ctrl+T folding. There is a wiring test
(`tests/commands/thinking-fold.spec.ts:73`) that asserts the extension is attached, but nothing that
asserts the symbol still resolves. A one-line assertion in that spec that
`Symbol.for("pi-claude-style-tools:message-render-cache")` is the key the vendor actually uses would
turn a silent regression into a failing test.

### 4.8 C1 — duplicated comment

`bin/leanpi.js:57-63` repeats the same five-line comment twice. Harmless at runtime; it is evidence
that the file was edited without re-reading, in a file that is otherwise carefully commented.

### 4.9 D2 — PRD bookkeeping

`docs/PRDs/v1/INDEX.md:5` states "all 26 PRDs `DONE` (verified 2026-09-19)". PRDs 029–032 sit in
`docs/PRDs/v1/` in flight, and `PRD-032-jev-optional.md` exists **both** in the root (untracked) and
in `done/`, with different content. `AGENTS.md` says a finished PRD is `git mv`'d into `done/` in the
same commit that finishes it; this state violates that. Decide which PRD-032 is authoritative and
delete the other, then regenerate `INDEX.md`.

### 4.10 W1 — telemetry full scan (watch item)

`readRuns` reads and JSON-parses the entire `.leanpi/telemetry.jsonl` (`src/telemetry/store.ts:74-104`),
and `selectRoute` calls it on every turn when no history is supplied (`src/routing/router.ts:207`).
The local store is already 204 KB and `decisions.jsonl` is 1.1 MB. This is a **documented** ceiling
with a stated upgrade path; it is listed so the threshold is not crossed silently. Add a tail-read
only when a real turn's latency is attributable to it.

## 5. Recommended order

1. **S1** — smallest diff, real injection sink, no design decision required.
2. **D1 + C1 + D2** — pure deletion/hygiene, unblocks nothing but reduces noise for every later diff.
3. **S3** — needs a decision (extend the surface, or amend the comment and `SECURITY.md`); the code
   and its comment must stop disagreeing.
4. **S2** — decide the env policy for harness/verifier children; verify against a real vendor CLI
   before changing.
5. **A3** — add the symbol assertion; cheap insurance against a vendor upgrade.
6. **A1 / A2** — characterization tests first, then split `index.ts` and `runExecutor`.

## 6. What was not audited

- No live provider or vendor-CLI call; no benchmark run; no coverage measurement (no tool configured).
- `bench/` fixtures, `skills/` vendored pack contents, `vendor/` and `node_modules` were not reviewed
  line by line.
- The dirty working tree (`.gitignore`, untracked `PRD-030`/`PRD-032`, `.probe/`) was not reviewed as
  a change; findings describe the committed `e2749a2` baseline.
- Prompt-injection scan: no file in the audited tree contained instructions directed at the auditor.

# PRD-003 — Task Scout

**Status:** NOT STARTED
**Complexity:** 3 (LOW)
**Owner:** joao
**Depends on:** PRD-001

Risk override: none. No security boundary, no migration, no persisted state; the scout only reads the workspace.

## Context

**Covers:** no FR ids (deterministic substrate for the routing stages); ROADMAP §7, §9.

ROADMAP §9 specifies Stage 0: before any generative model is asked to look at the repository, LeanPi gathers a small deterministic task packet — languages, project type, package manager, dirty flag, changed files, likely modules, test runners, LSP availability, git branch. §7 places the scout upstream of the JEV planning gate, so every later routing decision (PRD-004) is made against facts rather than against a model's guess about the workspace.

The packet is a cost control as much as an accuracy control: §6.2 and §6.3 require that context is rented, not owned. §9 therefore forbids the scout from dumping directory trees, full package manifests, whole `AGENTS.md`/`CLAUDE.md` files, git history, or whole files. Prose alone cannot enforce that, so this PRD turns the prohibition into an asserted byte ceiling on the serialized packet, verified against a deliberately hostile repository.

Repository state inspected: `/home/joao/projects/lean-pi` currently contains only `docs/PRDs/v1/ROADMAP.md`. There is no source tree, no `package.json`, and no test harness yet; PRD-001 establishes the TypeScript/Node Pi extension skeleton, `npm` scripts (`build`, `typecheck`, `test` via vitest, `lint`), the `src/` layout, and the package public entry `src/index.ts`. Every path named below is created by this PRD's phases.

## Solution

One module, `src/scout/index.ts`, exporting `scoutTask(cwd: string, userRequest: string): TaskPacket` and the constant `SCOUT_PACKET_MAX_BYTES`. It is re-exported from the package entry `src/index.ts` so the session bootstrap and the task compiler (PRD-004) reach it through the public API.

Consumer flow: user submits a task in a LeanPi session → session bootstrap calls `scoutTask(cwd, request)` → the packet is handed to the task compiler → the compiled route is observable to the user. This PRD's observable result is the packet itself, exercised through the public entry point against real repositories on disk.

Approach, deliberately minimal:

- **Zero model inference.** `scoutTask` takes no model client, no JEV handle, and performs no network I/O. Its whole surface is Node `fs` plus `git` invocations. This is what keeps Stage 0 free and keeps LeanPi usable when JEV or any provider is down (§49 — no JEV requirement for basic operation).
- **Detection by existing signals, not by walking the tree.** Package manager from lockfile presence (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `Cargo.lock`, `uv.lock`); languages and test runners from the root manifest's declared fields and from the extensions of the *changed* files, not from a recursive scan; `project_type: 'single' | 'monorepo' | 'polyglot' | 'unknown'` — `monorepo` when a workspace/members declaration exists, `polyglot` when ≥2 languages and no workspace declaration, `single` when a manifest is present with one language, and `unknown` when there is no manifest to read at all (the declared fourth variant, so PRD-004 never receives a value outside the union); `dirty`, `changed_files`, and `git_branch` from `git status --porcelain=v1 -z` and `git rev-parse --abbrev-ref HEAD`; `likely_modules` derived by taking the common ancestor directories of the changed files plus any path fragments in the user request that resolve to a real directory; `lsp_available` from whether a server binary for a detected language resolves on `PATH`.
- **Caps enforced in code.** `SCOUT_PACKET_MAX_BYTES = 2048` (≈512 tokens). Manifest contents, instruction files, git log, and file bodies are never read into the packet. List fields are truncated in a fixed order with an explicit `+N more` marker until the serialized packet fits, then the builder asserts the ceiling. A truncation that still exceeded the ceiling would be a bug, not a silent pass.
- **Degradation is normal, not exceptional.** No git, no manifest, or no `PATH` entry yields a packet with the unknown fields absent/`null` rather than a throw. Routing must survive a bare directory.

Reused rather than built: `node:child_process` for git (no git library dependency), `node:fs` for existence checks, `JSON.stringify` + `Buffer.byteLength` for the size measurement. No cache, no watcher, no config surface — the scout is fast enough to run per task, and a stale cache would be worse than a re-run.

Relevant non-goals restated from ROADMAP §58: no correctness claims without evidence — the packet is deterministic fact collection and never asserts that anything works; no JEV requirement for basic operation — Stage 0 must run with every model provider offline; no blanket capability exposure — the packet reports whether an LSP exists, it does not enumerate or attach capabilities.

Risks: (1) git output parsing across rename/unmerged entries — mitigated by `--porcelain=v1 -z`, whose format is stable and NUL-delimited; (2) unbounded `changed_files` on a large rebase — this is exactly what the byte ceiling and the hostile-repo fixture cover; (3) a repository whose real state disagrees with the packet — every AC below asserts packet fields against a fixture repo whose state the test itself created, so a fabricated value cannot pass.

## External Skill Dependencies

None. The scout is pure code plus `git`; it loads no skill, plugin, or instruction bundle. It does not read `AGENTS.md`, `CLAUDE.md`, or any `SKILL.md` into the packet (§9 forbids it), and it does not index skill roots — skill discovery over `/home/joao/.claude/skills`, `/home/joao/.codex/skills`, the plugin cache, and project-local dirs is owned by PRD-005.

## JEV Decision Sites

None — consumes no JEV decisions and owns no site. Stage 0 is deliberately model-free (§9: "Before asking a generative model to inspect the repository"), so the scout registers nothing in PRD-002's decision-site registry. Its packet is the deterministic *input* to the sites owned by PRD-004 (PRD gate, execution complexity, model capability need, review-risk input). AC-3 asserts the model-free property behaviorally on both escape routes: `fetch` is stubbed to throw, and a spy over `child_process.execFileSync`/`spawnSync` asserts the only executable the scout invokes is `git` — so inference smuggled in through a spawned CLI or a non-`fetch` HTTP client fails the check too.

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: Calling `scoutTask(cwd, request)` through the package entry against a fixture repository built by the test (npm workspaces TypeScript+C++ monorepo, vitest configured, two tracked files modified, branch `feature/foo` checked out) returns a packet whose `languages`, `project_type: monorepo`, `package_manager: npm`, `dirty: true`, `changed_files`, `likely_modules`, `test_runners`, and `git_branch: feature/foo` each equal the state the fixture actually created — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: Against a hostile fixture (3,000 changed files, a 400 KB `package.json`, a 2,000-line `AGENTS.md`, 50 commits of history, nested directories 8 deep), the serialized packet is ≤ `SCOUT_PACKET_MAX_BYTES` (2048) and truncated list fields carry an explicit `+N more` marker with the true total. The fixture plants a distinctive sentinel in each forbidden source — `ZZ_MANIFEST_SENTINEL` in `package.json`, `ZZ_AGENTS_SENTINEL` in `AGENTS.md`, `ZZ_COMMITMSG_SENTINEL` in a commit message, `ZZ_FILEBODY_SENTINEL` in a tracked file body — and none of the four appears anywhere in the serialized packet; additionally every string field in the packet is at most 256 bytes, so no field can carry a body in truncated form. — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: With `globalThis.fetch` replaced by a throwing stub and `child_process.execFileSync`/`spawnSync` wrapped by a recording spy for the duration of the call, `scoutTask` still returns a complete packet, every recorded spawn's executable is `git` (no other binary, no shell), and two consecutive calls on an unchanged fixture produce byte-identical JSON. — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: On a directory that is not a git repository and has no manifest, `scoutTask` returns a packet (no throw) with `dirty: false`, `git_branch: null`, `changed_files: []`, `package_manager: null`, and a `project_type` of `unknown`, so downstream routing still receives a usable packet — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Deterministic Stage 0 task packet | LeanPi session bootstrap → `scoutTask()` re-exported from the package entry `src/index.ts` (wired in Phase 1); consumed by the task compiler in PRD-004 | New capability — replaces model-driven repository inspection at routing time (§6.4) | AC-1 / E1 |
| Packet size ceiling | Same entry point; `SCOUT_PACKET_MAX_BYTES` enforced inside `src/scout/index.ts` (Phase 2) before the packet is returned to any caller | New — makes the §9 "SHALL avoid dumping" prohibition an executable invariant | AC-2 / E2 |

## Execution Phases

#### Phase 1: Packet builder returns real workspace facts

**Status:** NOT STARTED
**ACs:** AC-1
**Files:**
- `src/scout/index.ts` (new) — `TaskPacket` type, `scoutTask(cwd, userRequest)`, git/lockfile/manifest detection helpers.
- `src/index.ts` (edited) — re-export `scoutTask`, `TaskPacket`, `SCOUT_PACKET_MAX_BYTES` from the package public entry.
- `tests/scout/packet.spec.ts` (new) — fixture-repo builder plus AC-1 assertions.

**Implementation:**
1. Define `TaskPacket` with the §9 field set: `repository { languages, project_type, package_manager, dirty }`, `task { user_request }`, `workspace { changed_files, likely_modules, test_runners, lsp_available, git_branch }`. Field names mirror §9 so the compiler and `/route` output read back against the ROADMAP directly.
2. Git facts via one `git status --porcelain=v1 -z` and one `git rev-parse --abbrev-ref HEAD`, run with `execFileSync('git', …, { cwd })`. Parse the NUL-delimited records; take the destination path of rename records; treat a non-zero exit as "not a repository" (handled in Phase 2).
3. Package manager from the first matching root lockfile; languages from the root manifest's declared toolchain fields unioned with the extension map of the changed files; `test_runners` from declared devDependencies/config files for known runners (vitest, jest, pytest, cargo test, ctest); `project_type: 'single' | 'monorepo' | 'polyglot' | 'unknown'` = `monorepo` when a workspaces/members declaration exists, `polyglot` when ≥2 languages and no workspace declaration, `single` when a manifest is present with fewer than two languages, and `unknown` when no manifest exists (set on the Phase 2 degradation path; the variant is declared here so the type never grows a fourth member later).
4. `likely_modules`: common ancestor directories of `changed_files` (depth-capped at 3 segments), unioned with directory-like tokens in the user request that resolve on disk. Deduplicated, sorted for determinism.
5. `lsp_available`: resolve a known server binary for each detected language on `PATH`; boolean union. No server is started.
6. Every list field is sorted before return so output is order-stable regardless of filesystem enumeration order.
7. The test builds the fixture with real `git init`, real commits, and real edits in a temp directory, then asserts against the values it wrote. No mocks of git.

**Verification:** E1 — `npx vitest run tests/scout/packet.spec.ts`; asserts each packet field equals the fixture state the test created (branch name, the exact two modified paths, `monorepo`, `npm`, `dirty: true`, both languages, `vitest` runner). Covers AC-1 and the risk that detection silently returns defaults: the fixture's branch is `feature/foo` and its manager is npm-with-workspaces, so a hardcoded or empty result fails. Negative control: the assertion set is written before the detection helpers exist (red from missing behavior, not from a missing import).
**Checkpoint:** pending

#### Phase 2: Enforced ceiling, determinism, and graceful degradation

**Status:** NOT STARTED
**ACs:** AC-2, AC-3, AC-4
**Files:**
- `src/scout/index.ts` (edited) — `SCOUT_PACKET_MAX_BYTES`, ordered truncation with `+N more` markers, the post-truncation size assertion, and the not-a-repository / no-manifest fallbacks.
- `tests/scout/limits.spec.ts` (new) — hostile fixture, offline/determinism run, bare-directory run.

**Implementation:**
1. `SCOUT_PACKET_MAX_BYTES = 2048`. After assembly, measure `Buffer.byteLength(JSON.stringify(packet))`. While over the ceiling, truncate in a fixed priority order — `changed_files` first, then `likely_modules`, then `languages` — replacing the removed tail with a `+N more` marker string carrying the true total. `user_request` is truncated last and only to a hard 256-byte prefix, so the request is never silently lost.
2. After truncation, assert the ceiling holds; an over-ceiling packet throws rather than being returned, because a silently oversized packet would defeat the whole cost control.
3. No code path reads manifest contents, instruction-file contents, `git log`, or any file body into the packet — manifests are parsed for declared fields only, and the parsed values that reach the packet are the enumerated scalars above.
4. Fallbacks: git failure → `dirty: false`, `git_branch: null`, `changed_files: []`; missing manifest → `package_manager: null`, `project_type: 'unknown'`, `test_runners: []`. No throw on either path.
5. Determinism: no timestamps, no absolute paths (all workspace paths are relative to `cwd`), no `Math.random`, no `Date`, all lists sorted.

**Verification:** E2 — `npx vitest run tests/scout/limits.spec.ts`; three assertions in one run: (a) hostile fixture → `Buffer.byteLength(JSON.stringify(packet)) <= 2048`, a `+N more` marker whose N matches the fixture's true changed-file count, a scan proving none of the four planted sentinels (`ZZ_MANIFEST_SENTINEL`, `ZZ_AGENTS_SENTINEL`, `ZZ_COMMITMSG_SENTINEL`, `ZZ_FILEBODY_SENTINEL`) appears in the serialized packet, and a per-field length assertion of ≤256 bytes on every string (AC-2); (b) with `globalThis.fetch` stubbed to throw and a spy over `child_process.execFileSync`/`spawnSync`, the call succeeds, every recorded executable is `git`, and two successive serializations are identical strings (AC-3); (c) bare temp directory → packet with the documented fallback values including `project_type: 'unknown'` and no throw (AC-4). Distinct risks covered: unbounded packet growth, forbidden source text reaching the packet, inference smuggled in through a spawned CLI or a non-`fetch` client, non-determinism, and crash-on-degenerate-workspace — none of which E1 can detect. Negative controls: the sentinel scan is re-run against a deliberately dumped manifest to prove it fires, and the spy case is re-run with a stub `curl` invocation to prove the executable assertion is not vacuous.
**Checkpoint:** pending

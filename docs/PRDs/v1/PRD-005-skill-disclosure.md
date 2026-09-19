# PRD-005 — Skill Disclosure

**Status:** NOT STARTED
**Complexity:** 3 (LOW)
**Risk override:** None — read-only filesystem scan plus metadata-only model calls; skill bodies are instructions, not executable extensions, and project-local *executable* trust is PRD-017's boundary.
**Owner:** joao
**Depends on:** PRD-002, PRD-004

## Context

**Covers:** FR-014, FR-070, FR-071, FR-072, FR-073, FR-074, FR-075, FR-076, FR-145; ROADMAP §5, §15, §16, §22, §49, §50, §51 (Skills, UX/Commands).

Current behavior: none. `/home/joao/projects/lean-pi` is greenfield — `docs/PRDs/v1/ROADMAP.md` is the only file. Every path named below is created by this PRD's phases or by a dependency PRD.

The user's machine already carries a large installed skill library (verified scan at plan time: 26 `SKILL.md` under `~/.claude/skills`, 196 under `~/.codex/skills`, 31 under `~/.claude/plugins/cache/*/*/*/skills`, total 253). Pasting that corpus into executor context is exactly the waste LeanPi exists to remove (ROADMAP §6.3: context is rented). ROADMAP §15 forbids handing the executor every installed capability; §16 specifies the out-of-context registry, the JEV rank → verify → load pipeline, and manual `/skills` control with pinning.

Inspected: ROADMAP §5 (TypeSafe skill-selection experiment), §15, §16, §22 (prompt layering), §49 (JEV-off fallback), §50 (asymmetric confidence), §51 Skills + FR-145. Dependencies consumed: PRD-002 `src/jev/client.ts` (`ask(questions, state)` → typed `Choice`/`Score`/`Noul`) and its decision-site registry; PRD-004 `src/compiler/contract.ts` (`ExecutionContract.capabilities.skills`) and the compile step that produces it; PRD-001 `LeanPiConfig` and the prompt assembler's SEMI-STABLE section.

## Solution

One registry, one selection function, one command. No plugin abstraction, no skill "provider" interface with a single implementation.

**Registry (out of context).** `src/capabilities/skills.ts` scans an ordered root list and reads only the YAML frontmatter of each `<root>/<name>/SKILL.md` — never the body — producing the ROADMAP §16 record: `name, description, tags, capabilities, risk, cost_hint, source, version`. `source` records the root class (`project` | `user` | `plugin`) and the absolute file path; `version` comes from frontmatter, falling back to the plugin cache path's version segment. Names dedupe with first-root-wins, giving precedence **project > user global > plugin**. Root order comes from `LeanPiConfig.capabilities.skillRoots` (declared by PRD-001, trust-filtered by PRD-017, consumed here); the *default* list is resolved from the project root and `$HOME` at runtime — no absolute path is hard-coded in product code. Standard Agent Skills layout is the only layout supported (FR-076); an unparsable frontmatter yields a listed entry marked `invalid` rather than an exception.

**Trust is not this PRD's job.** PRD-017's `assertTrusted()` runs inside `loadConfig` (`src/core/config.ts`) and drops untrusted project-local roots (`.claude/skills`, `.codex/skills`) before the registry is constructed, so `capabilities.skillRoots` only ever contains trusted entries. User-global roots and plugin skill dirs carry user-scope trust and are not gated. The registry adds no trust logic of its own.

**Disclosure pipeline.** `src/capabilities/skill-select.ts` implements ROADMAP §16 literally:

```text
full lightweight registry (name + description + tags, ~1 line each)
        ↓ JEV: "is any skill needed?" + per-candidate relevance Score  (one request)
top K candidates (K default 5) → full frontmatter detail, still no bodies
        ↓ JEV: "does this candidate actually fit?"  (Choice per candidate)
load 0–N full SKILL.md bodies (N capped by skills.maxLoaded, default 3)
```

JEV may answer *no skill required* (FR-073) — the normal, cheapest outcome. Per §50, confidence below the site threshold loads none. Pinned skills (FR-075) are injected unconditionally and never enter ranking. Disabled skills are dropped before stage 1.

**Reaching the executor.** Selection runs inside the PRD-004 compile step and fills `ExecutionContract.capabilities.skills` with resolved records (`{name, source, body}`). The PRD-001 prompt assembler renders those bodies — and only those — into the SEMI-STABLE section (ROADMAP §22). Consumer path: user task in a LeanPi session → compile → `selectSkills()` → contract → assembled executor context → the executor sees 0–N bodies.

**JEV off.** Per §49, selection degrades to lexical/tag routing over the same registry (token overlap between the task text and `name`/`description`/`tags`, same `maxLoaded` cap, pins still honored). Nothing in this PRD requires JEV to be reachable.

**Measurement.** `bench/skill-selection/` holds a labelled fixture set and reports wrong-load and unnecessary-load rates. ROADMAP §5 reports TypeSafe's 488-request experiment (incorrect loads 16.8% → 7.3%, unnecessary loads 9.8% → 4.0%) — recorded in this PRD as a **target to evaluate against, not a claim about LeanPi**.

Restated non-goals (ROADMAP §58) binding on this PRD: no blanket capability exposure; no generative router replacing JEV (selection is typed `Choice`/`Score`, never prose generation); no JEV requirement for basic operation; no correctness claims without evidence — the §5 figures are cited as targets only.

## External Skill Dependencies

LeanPi consumes the user's already-installed skills; it does not reimplement or vendor them. Verified absolute paths on this machine, used as the **default** discovery order (configurable via `LeanPiConfig.capabilities.skillRoots`; never hard-coded in product code):

| Root / skill | Absolute path | Role in this PRD |
|---|---|---|
| Project-local (Claude) | `<project>/.claude/skills` | Highest precedence root |
| Project-local (Codex) | `<project>/.codex/skills` | Second precedence root |
| User global (Claude) — 26 skills | `/home/joao/.claude/skills` | Third; source of truth for the installed corpus |
| User global (Codex) — 196 skills | `/home/joao/.codex/skills` | Fourth |
| Plugin-provided — 31 skills | `/home/joao/.claude/plugins/cache/*/*/<version>/skills/` | Lowest precedence; `version` segment feeds the registry `version` field |
| Ponytail bundle (plugin, pinned 4.9.0) | `/home/joao/.claude/plugins/cache/ponytail/ponytail/4.9.0/skills/ponytail/SKILL.md` (siblings `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`) | Indexed like any plugin skill here. The static-prefix vendoring of this bundle is PRD-001's, not this PRD's |
| `prd-creator` | `/home/joao/.claude/skills/prd-creator/SKILL.md` (mirror `/home/joao/.codex/skills/prd-creator/`) | Precedence fixture: the duplicate name MUST resolve to the `.claude` copy; also a labelled positive in the benchmark set |
| `prd-manager` | `/home/joao/.claude/skills/prd-manager/SKILL.md` (+ `scripts/`) | Labelled positive; its adapter behavior belongs to PRD-012 |
| `prd-executor` | `/home/joao/.claude/skills/prd-executor/SKILL.md` | Labelled positive |

## JEV Decision Sites

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| Skill disclosure (site id `skill.disclosure`, registered with PRD-002's decision-site registry; telemetry tag `skill.disclosure`) | Q1 "Does this task require any skill from the library?" · Q2 per shortlisted candidate "How relevant is this skill to the task?" (Q1+Q2 share one request over the lightweight registry) · Q3 per top-K candidate, given full frontmatter detail "Does this skill actually fit this task?" | Q1 `Choice` (yes/no) · Q2 `Score` · Q3 `Choice` | Lexical/tag routing over the same registry (ROADMAP §49): token overlap on `name`/`description`/`tags`, same `maxLoaded` cap, pins always loaded. Below-threshold confidence loads none (§50) | ★★★★★ |

No other site is claimed here: PRD-004 owns the compiler's classification sites, PRD-023 owns file/search exploration, PRD-002 owns the registry mechanism itself.

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: `/skills` in a LeanPi session lists the real installed library scanned from the default roots — ≥250 entries (observed 26 + 196 + 31 = 253 at plan time) each showing name, description, source class, and version — and the duplicate `prd-creator` appears exactly once, resolved to `/home/joao/.claude/skills/prd-creator/SKILL.md`, proving project > user global > plugin precedence. No `SKILL.md` body is read during the scan. — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: `/skills disable <name>` removes that skill from candidate selection and shows it as disabled in `/skills`; the state survives a session resume. `/skills enable <name>` restores it. — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: `/skills pin <name>` causes that skill's full body to appear in the assembled executor context for a task whose JEV relevance answer is "not relevant", proving pinned skills bypass relevance filtering. — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: For a fixture task run against a library of ≥200 skills, the assembled executor context contains the full bodies of exactly the selected skills (0–N, N ≤ `skills.maxLoaded`) and zero bytes of any unselected skill body; a task JEV answers "no skill required" yields an executor context with no skill block at all. — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: `npm run bench:skills` over a labelled fixture set (≥40 requests: ≥20 positives naming an expected skill, ≥20 negatives requiring none) emits `bench/skill-selection/report.json` with measured wrong-load and unnecessary-load rates against the ROADMAP §5 targets (≤7.3% / ≤4.0%, cited as targets not claims), and every negative-labelled request loads zero bodies. — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: With `jev.enabled=false`, the AC-4 fixture task still selects skills through lexical/tag routing, pins still load, the session completes, and the telemetry decision row for site `skill.disclosure` records `fallback_used: true`; with JEV enabled the loaded set differs from the lexical set on at least one labelled fixture, proving the JEV answer — not the lexical heuristic — determines what enters context. — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Installed skill library is inspectable | `/skills` slash command → `src/commands/skills.ts` (created in Phase 1) → `scanSkills()` in `src/capabilities/skills.ts` (Phase 1) | New; greenfield, no incumbent | AC-1 |
| Manual enable/disable/pin control | `/skills enable\|disable\|pin <name>` → `src/commands/skills.ts` (Phase 1) → state persisted in `LeanPiConfig.skills.state` (PRD-001 config store; distinct from the trust-gated `capabilities.skillRoots` discovery input) | New | AC-2, AC-3 |
| Only selected skill bodies reach the executor | User task in session → compile step `src/compiler/compile.ts` (PRD-004; edited Phase 2) → `selectSkills()` in `src/capabilities/skill-select.ts` (Phase 2) → `ExecutionContract.capabilities.skills` → prompt assembler `src/core/prompt.ts` (PRD-001; edited Phase 2) SEMI-STABLE block | New; the "all skills in the prompt" default is never shipped | AC-3, AC-4, AC-6 |
| Selection quality is measured, not asserted | `npm run bench:skills` → `bench/skill-selection/run.ts` (Phase 2) | New | AC-5 |

## Execution Phases

#### Phase 1: Out-of-context registry and `/skills` control
**Status:** NOT STARTED
**ACs:** AC-1, AC-2
**Files:** `src/capabilities/skills.ts` (new: root resolution, frontmatter-only scan, precedence dedupe, enable/disable/pin state, body loader); `src/commands/skills.ts` (new: `/skills`, `/skills enable|disable|pin <name>`); `tests/skills-registry.test.ts` (new); `tests/fixtures/skills/**` (new: small precedence fixture roots).
**Implementation:** Read `LeanPiConfig.capabilities.skillRoots` (already trust-filtered by PRD-017's `assertTrusted()` in `loadConfig`), defaulting to `[<project>/.claude/skills, <project>/.codex/skills, $HOME/.claude/skills, $HOME/.codex/skills, $HOME/.claude/plugins/cache/*/*/*/skills]` — computed from `process.cwd()` and `os.homedir()`, no literal `/home/joao` in product code. For each `<root>/<name>/SKILL.md`, read only up to the closing frontmatter `---` (streamed head read) and parse `name, description, tags, capabilities, risk, cost_hint, version`; attach `source = {class, path}` and, for plugin roots, take `version` from the cache path segment when frontmatter omits it. Dedupe by `name`, first root wins. Malformed frontmatter → entry with `status: 'invalid'` and the parse message; missing root → skipped silently. Persist `{enabled: false}` / `{pinned: true}` per name in `LeanPiConfig.skills.state` through PRD-001's config writer so resume rehydrates it.
**Verification:** E1 — `npx vitest run tests/skills-registry.test.ts`: (a) real scan of the machine's default roots asserts ≥250 entries and `prd-creator.source.path` ends with `.claude/skills/prd-creator/SKILL.md` (AC-1 precedence, the `.codex` mirror shadowed); (b) a read spy asserts no bytes past the frontmatter terminator of any `SKILL.md` (AC-1 out-of-context claim); (c) `/skills disable` → reload config → `/skills` shows disabled and the entry is absent from `candidates()` (AC-2). Negative control for the vacuous-fixture risk: pointing `capabilities.skillRoots` at an empty temp dir must yield zero entries, so the count assertion is sensitive to the scan actually running.
**Checkpoint:** pending

#### Phase 2: JEV rank → verify → load, executor context, and measurement
**Status:** NOT STARTED
**ACs:** AC-3, AC-4, AC-5, AC-6
**Files:** `src/capabilities/skill-select.ts` (new: pipeline, pin injection, lexical fallback); `src/compiler/compile.ts` (edit: call `selectSkills()`, fill `capabilities.skills`); `src/core/prompt.ts` (edit: render resolved skill bodies in the SEMI-STABLE block); `bench/skill-selection/run.ts` + `bench/skill-selection/fixtures.jsonl` (new); `tests/skill-select.test.ts` (new).
**Implementation:** Register site `skill.disclosure` with PRD-002's decision-site registry (question set, `Choice`/`Score` return types, confidence threshold, fallback `lexical`, telemetry tag). Stage 1: one `ask()` carrying the lightweight registry (name + description + tags per enabled, unpinned skill) with Q1 "any skill needed" plus per-candidate relevance `Score`; a `no` on Q1, or confidence below threshold, returns the pinned set only. Stage 2: take top K (default 5) by score, send their full frontmatter detail, ask Q3 fit `Choice` per candidate. Stage 3: read the bodies of confirmed skills, cap at `skills.maxLoaded` (default 3) by score order, prepend pins, and return `{name, source, body}[]` into `ExecutionContract.capabilities.skills`. On JEV error/disabled, `lexicalSelect()` scores token overlap against `name`/`description`/`tags` under the same cap and marks the telemetry row `fallback_used: true`. Benchmark runner replays `fixtures.jsonl` (`{request, expected: <skill name>|null}`) through `selectSkills()` against the installed corpus and writes `report.json` with `wrong_load_rate`, `unnecessary_load_rate`, per-case rows, and the §5 target values for comparison.
**Verification:** E2 — `npx vitest run tests/skill-select.test.ts`: compiles fixture tasks through the real session compile entry point with a scripted JEV transport and asserts on the *assembled prompt string* — selected bodies present verbatim, no unselected body substring present, "no skill required" produces no skill block (AC-4), and a pinned skill's body is present when its relevance answer is "not relevant" (AC-3). E3 — `npm run bench:skills`: report generated, negatives load zero bodies, measured rates recorded against the §5 targets (AC-5). E4 — rerun E2's fixture with `jev.enabled=false`: lexical selection still loads, pins honored, session completes, telemetry row shows `fallback_used: true`, and the loaded set differs from the JEV-enabled run on at least one labelled fixture (AC-6) — this differential doubles as the negative control proving the JEV answer, not the heuristic, drives context.
**Checkpoint:** pending

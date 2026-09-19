# PRD-014 — Context Engine

**Status:** NOT STARTED
**Complexity:** 5 (MEDIUM)
**Risk override:** none — no security boundary, no destructive migration; artifact storage is local, append-only and reversible.
**Owner:** joao
**Depends on:** PRD-001

## Context

**Covers:** FR-100, FR-101, FR-102, FR-103, FR-104, FR-105, FR-106, FR-107; ROADMAP §20, §21, §22, §51 (Context Efficiency), §6.3.

ROADMAP §6.3 states the governing constraint: anything placed into an LLM context has recurring cost, so LeanPi prefers references over duplicated content, structured state over transcripts, and reversible pruning over destructive summarization. §20 requires an external working-state record independent of chat history; §21 requires large tool results to be stored as artifacts and replaced by compact representations the executor can expand on demand, preserving source references, exact raw output, timestamps and exit status; §22 requires a STATIC / SEMI-STABLE / VOLATILE prompt layout so provider prefix caching actually hits.

Repository state inspected: the repository contains only `docs/PRDs/v1/ROADMAP.md`. There is no source tree, package manifest or test harness; PRD-001 creates the TypeScript/Pi harness skeleton, `npm` scripts (`build`, `typecheck`, `test`, `lint`) and `src/core/types.ts`. Every path named below is created by this PRD's phases.

This PRD owns `src/context/`: the `artifact://` store, the `WorkingState` record, prompt assembly and compaction. It is a dependency of PRD-009 (evidence records carry an `artifactRef`), PRD-019 (RTK must retain full raw output, FR-113) and PRD-016 (`/context` renders what this engine holds); it consumes only PRD-001.

## Solution

Four small pieces, no framework.

**`artifact://` store** (`src/context/artifacts.ts`). Every tool result above a configured byte threshold is written to a content-addressed file under the session directory and replaced in context by a compact record: exit status, timestamp, source ref, a deterministic head/tail/failure excerpt, and `[full output: artifact://<kind>/<id>]`. Storage is the filesystem plus a sha256 of the raw bytes — no database, no compression layer, no index service. `expand(ref)` returns the exact bytes back, which is what makes the reduction reversible (§21) rather than lossy.

**`WorkingState`** (`src/context/working-state.ts`) is the ROADMAP §20 record verbatim: `goal`, `acceptance`, `files_touched`, `current_failure`, `verification`, `attempts`, `unresolved`. It is assembled from the evidence store and session facts, never from the transcript, so clearing chat history does not change it. Serialized as YAML because that is what §20 shows and it is the densest readable form.

**Prompt assembly** (`src/context/prompt.ts`) concatenates three layers in §22 order:

```text
STATIC        LeanPi/Ponytail core, tool protocol, behavioral rules   (byte-identical every turn)
SEMI-STABLE   selected project instructions, selected skills, task contract
VOLATILE      working state, latest evidence, current diff, current failure
```

The STATIC layer is the pinned Ponytail prefix PRD-001 vendors; this PRD assembles it and must never mutate or re-author it, because byte-identity is exactly what the provider cache keys on. Dedup happens here: an exact content hash already present in the assembled prompt is emitted as its existing `artifact://` reference instead of a second copy.

**Compaction** (`src/context/compaction.ts`) is deterministic reduction first (FR-107): drop superseded tool results to their artifact refs, collapse duplicate reads, drop evidence records whose `workspaceHash` is stale. A preservation set — the original user requirements, every acceptance criterion, every active (unresolved) error — is never dropped, by construction rather than by instructing a model to keep it. Generative summarization is not implemented in this PRD; the deterministic path is sufficient for the volumes §20 describes, and adding a summarizer would violate both FR-107 and "no cloud model required".

**Consumer path:** any tool call in a session → store captures output → `assemble()` builds the prompt for every model request → executor issues an expand action → full raw bytes return in its next context. PRD-016's `/context` renders the same `WorkingState` read-only.

Restated non-goals (ROADMAP §58): this engine does **not** require cloud models — compaction and reduction run with every model disabled; it does **not** guarantee correctness without evidence — it stores and references evidence, never asserts it; it does **not** expose everything installed — only the skills PRD-005 selects reach the SEMI-STABLE layer.

Risks: (1) an artifact ref that outlives its file, breaking expansion — mitigated by storing artifacts under the session directory with the session's own lifetime and by `expand()` failing loudly rather than returning a placeholder; (2) a compaction that quietly drops an active error — mitigated by the preservation assertion in AC-5; (3) prefix drift from an accidentally mutated STATIC layer — mitigated by the byte-equality assertion in AC-6.

## External Skill Dependencies

LeanPi consumes the operator's already-installed skills and plugin bundles; this PRD re-implements none of them. Paths are the **default discovery order** held in configuration (`prompt.ponytailSource`, `skills.roots`), never hard-coded absolutes in product code.

| Skill / bundle | Verified path | How this PRD uses it |
|---|---|---|
| Ponytail instruction bundle (plugin, pinned 4.9.0) | `/home/joao/.claude/plugins/cache/ponytail/ponytail/4.9.0/skills/ponytail/SKILL.md` (siblings: `ponytail-review`, `ponytail-audit`, `ponytail-debt`) | Its vendored, version-pinned text **is** the STATIC prompt layer. PRD-001 owns the vendoring, pin and content hash; this PRD only places those bytes first and keeps them byte-identical across turns (AC-6). This PRD never edits, reflows or regenerates the prefix. |
| Installed skill roots (indexed by PRD-005) | `/home/joao/.claude/skills`, `/home/joao/.codex/skills`, plugin dirs under `/home/joao/.claude/plugins/cache/*/*/<version>/skills/`, project-local `.claude/skills` and `.codex/skills` | Skill bodies PRD-005 selects are placed in the SEMI-STABLE layer, ordered deterministically so selecting the same skill set twice produces the same bytes. This PRD does not scan or rank those roots — PRD-005 owns discovery and precedence. |

If the Ponytail source path is unset, assembly falls back to PRD-001's embedded copy; if no skills are selected, the SEMI-STABLE layer is empty and the prefix is still stable.

## JEV Decision Sites

This PRD owns one site, registered with PRD-002's decision-site registry (id, question set, return type, confidence threshold, deterministic fallback, telemetry tag).

| Decision | Atomic question(s) | Return type | Deterministic fallback when JEV off | Value rating |
|---|---|---|---|---|
| `context.retention_relevance` — is an old evidence item still relevant to the active task? | Per candidate item: "Is `<item summary>` still relevant to the active task `<working state goal>`?" → `keep` / `drop` | Choice | Deterministic retention rules decide alone: keep anything in the preservation set (user requirements, acceptance criteria, active errors) or referenced by the current `WorkingState`; drop evidence whose `workspaceHash` is stale and which nothing references; keep everything else. Because every drop leaves an `artifact://` ref, a wrong drop is recoverable by expansion rather than a data loss. | ★★★★☆ |

The site is consulted only for candidates the deterministic rules leave undecided, and only when JEV is enabled; compaction is never blocked on it. Sites owned elsewhere and merely referenced here: skill disclosure (PRD-005), proof sufficiency (PRD-010), output-reduction policy (PRD-019).

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: A tool call producing ≥ 100 KB of output lands in the assembled prompt as a compact record of ≤ 2 KB containing exit status, ISO timestamp, source ref and an `artifact://` ref; `expand()` on that ref returns bytes whose sha256 equals the sha256 of the original raw output (byte-identical round trip) — Evidence: pending.
- [ ] AC-2 [local; actor: agent]: An executor turn issuing the expand action for an `artifact://` ref receives the full raw output in its next prompt, and an expand for an unknown ref returns an explicit error rather than empty or placeholder content — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: Emitting the identical tool output twice in one session stores one artifact and assembles one copy: the second occurrence appears as the same `artifact://` ref and the assembled prompt grows by < 200 bytes between the first and second occurrence — Evidence: pending.
- [ ] AC-4 [local; actor: agent]: For the ROADMAP §20 representative task, the serialized `WorkingState` contains all seven fields (`goal`, `acceptance`, `files_touched`, `current_failure`, `verification`, `attempts`, `unresolved`) and is ≤ 3000 bytes (≈ 800 tokens); rebuilding it with the chat transcript emptied produces a byte-identical record, proving independence from chat history — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: After compaction is triggered at its configured threshold on a session holding a user requirement, three acceptance criteria and two unresolved errors, the assembled prompt still contains the original user requirement text verbatim, all three criteria and both active errors, while at least one superseded tool result has been reduced to an `artifact://` ref — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: Across two consecutive turns of one session with an unchanged skill selection, the assembled STATIC+SEMI-STABLE prefix is byte-identical (equal length and equal sha256) and all turn-specific content — working state, latest evidence, diff, current failure — appears strictly after that prefix; changing the skill selection changes only the SEMI-STABLE segment, leaving STATIC byte-identical — Evidence: pending.
- [ ] AC-7 [local; actor: agent]: With every model client and the JEV client stubbed to throw on invocation, capture, dedup, compaction and prompt assembly all complete and satisfy AC-3 and AC-5, proving deterministic reduction requires no inference — Evidence: pending.
- [ ] AC-8 [local; actor: agent]: With JEV enabled, a stale evidence item the deterministic rules leave undecided is resolved by one `ask()` at site `context.retention_relevance`, and the verdict changes observable output: `drop` removes the item from the assembled prompt while its `artifact://` ref still expands to the original bytes, `keep` leaves it inline. With JEV disabled the same session compacts with zero `ask()` calls and retains the item — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Tool-output capture as artifacts | Any session tool call → `capture()` in `src/context/artifacts.ts` (created in Phase 1) | Replaces raw tool output being pasted into the prompt by PRD-001's initial pass-through | AC-1 |
| `artifact://` expansion | Executor expand action → `expand()` in `src/context/artifacts.ts` (created in Phase 1) | New capability; the reversibility guarantee §21 requires | AC-2 |
| Structured working state | Every executor turn's prompt → `src/context/working-state.ts` (created in Phase 2); PRD-016's `/context` renders the same record read-only | Replaces transcript replay as the way the executor knows the task | AC-4 |
| Layered prompt assembly and dedup | Every model request → `assemble()` in `src/context/prompt.ts` (created in Phase 3) | Replaces PRD-001's naive message concatenation; sole builder of provider requests | AC-3, AC-6 |
| Deterministic compaction with preservation set | Context-budget threshold crossed during a turn → `compact()` in `src/context/compaction.ts` (created in Phase 4) | New; no generative summarizer is introduced or retained | AC-5, AC-7 |
| JEV site `context.retention_relevance` | Same `compact()` call → PRD-002 decision-site registry entry declared in `src/context/compaction.ts` (created in Phase 4) | New site; registry is PRD-002's, the entry is this PRD's | AC-8 |

## Execution Phases

#### Phase 1: `artifact://` store and reversible capture
**Status:** NOT STARTED
**ACs:** AC-1, AC-2
**Files:** `src/context/artifacts.ts` (`capture(result) -> CompactRecord`, `expand(ref) -> Buffer`, sha256 content addressing, session-scoped directory); `src/context/excerpt.ts` (deterministic head/tail/failure-line excerpt); `tests/context-artifacts.test.ts`.
**Implementation:** Write raw bytes verbatim to `<session>/artifacts/<kind>/<id>`; store nothing about them that the bytes and stat do not already say. The compact record carries `exitCode`, ISO `timestamp`, `sourceRef`, the excerpt and `artifact://<kind>/<id>` — the four things §21 names as mandatory plus the pointer. The excerpt is rule-based (first N lines, last N lines, lines matching a failure pattern), never model-generated. Threshold and excerpt size come from PRD-001's config with defaults; output under the threshold is passed through untouched rather than stored, so trivial commands cost nothing. `expand()` on a missing or malformed ref throws with the ref in the message — never returns empty bytes, which would silently look like "the command printed nothing".
**Verification:** E1 — `npm test -- tests/context-artifacts.test.ts`: capture a generated ≥ 100 KB output, assert the compact record is ≤ 2 KB and contains exit status, timestamp, source ref and an `artifact://` ref; assert `sha256(expand(ref)) === sha256(raw)`; drive one expand through the executor's real expand action and assert the full bytes reach the next prompt; assert an unknown ref throws. Covers AC-1, AC-2 and the distinct risks of a lossy round trip (the reversibility guarantee) and a silently empty expansion.
**Checkpoint:** pending

#### Phase 2: Structured working state
**Status:** NOT STARTED
**ACs:** AC-4
**Files:** `src/context/working-state.ts` (`WorkingState` type per ROADMAP §20, `build(session) -> WorkingState`, YAML serialization, byte-size guard); `tests/context-working-state.test.ts`.
**Implementation:** Build the record from session facts and the evidence store only — goal from PRD-013's goal state when active, acceptance from the active PRD or task contract, `files_touched` from the workspace diff, `current_failure` from the newest failing evidence record, `verification` from evidence status per kind, `attempts` from the retry counter, `unresolved` from the open-question list. Never read the chat transcript. Serialize with a fixed key order so the output is stable and diffable. Enforce the size ceiling at build time: when the record exceeds it, truncate the unbounded lists (`files_touched`, `unresolved`) with an explicit `+N more` marker rather than letting the record grow without limit or dropping a named field.
**Verification:** E2 — `npm test -- tests/context-working-state.test.ts`: build the record for the ROADMAP §20 fixture task, assert all seven fields present and serialized length ≤ 3000 bytes; empty the transcript and rebuild, assert byte-identical output; inflate `files_touched` past the ceiling and assert truncation with the marker while every named field survives. Covers AC-4 and the distinct risks of a transcript-derived record and of an unbounded state silently blowing the context budget.
**Checkpoint:** pending

#### Phase 3: Layered prompt assembly, stable prefix and dedup
**Status:** NOT STARTED
**ACs:** AC-3, AC-6
**Files:** `src/context/prompt.ts` (`assemble(parts) -> string`, §22 layer ordering, content-hash dedup); `tests/context-prompt.test.ts`.
**Implementation:** Emit STATIC (PRD-001's pinned Ponytail prefix and tool protocol, read once and cached as bytes), then SEMI-STABLE (project instructions, PRD-005-selected skill bodies in a deterministic order, task contract), then VOLATILE (working state, latest evidence, current diff, current failure) — dynamic content strictly last so the cacheable prefix is maximal (§22). Dedup keys on the sha256 of each content block already emitted in this prompt: a repeat is replaced by its existing `artifact://` ref or a one-line back-reference. Nothing in STATIC is templated or timestamped; anything that varies per turn belongs in VOLATILE by definition, and a unit assertion enforces that by hashing the prefix.
**Verification:** E3 — `npm test -- tests/context-prompt.test.ts`: assemble two consecutive turns of one session, assert equal prefix length and equal prefix sha256 and that all volatile markers appear after the prefix boundary; change the skill selection and assert STATIC unchanged while SEMI-STABLE differs; emit an identical large tool output twice and assert one stored artifact and < 200 bytes of prompt growth on the second occurrence. Covers AC-3, AC-6 and the distinct risks of a timestamp or counter leaking into the cacheable prefix and of dedup that dedups the reference but re-emits the body.
**Checkpoint:** pending

#### Phase 4: Deterministic compaction with preservation invariants
**Status:** NOT STARTED
**ACs:** AC-5, AC-7, AC-8
**Files:** `src/context/compaction.ts` (`compact(context) -> context`, preservation set, retention rules, `context.retention_relevance` registry entry); `tests/context-compaction.test.ts`.
**Implementation:** Compaction runs when the assembled size crosses the configured budget. Order: reduce superseded tool results to their `artifact://` refs; collapse duplicate reads; drop evidence records whose `workspaceHash` no longer matches the workspace and which nothing references. The preservation set — original user requirement text, every acceptance criterion, every unresolved error — is copied into the retained context before any reduction runs, so preservation is structural and cannot be forgotten by a reduction rule added later. For candidates the rules leave undecided, and only when JEV is enabled, ask one atomic `keep`/`drop` question per candidate at site `context.retention_relevance`, registered with PRD-002 along with the fallback in the table above; below-threshold confidence, transport failure or disabled JEV all take the fallback (retain). No generative summarizer is written; every reduction is a reference substitution, so the result stays expandable.
**Verification:** E4 — `npm test -- tests/context-compaction.test.ts`: build a session with one user requirement, three acceptance criteria, two unresolved errors and several superseded tool results; trigger compaction and assert the requirement verbatim, all three criteria and both errors survive while at least one tool result is now an `artifact://` ref that still expands to its original bytes; rerun the whole flow with every model client and the JEV client stubbed to throw and assert identical retained content and no throw; then with JEV enabled, feed one undecidable stale item and assert exactly one `ask()` at `context.retention_relevance`, that `drop` removes it from the assembled prompt while its ref still expands, and that `keep` leaves it inline. Covers AC-5, AC-7, AC-8 and the distinct risks of a compaction that drops an active error, a hidden dependency on inference for deterministic reduction, and a retention verdict that is logged but does not change the prompt.
**Checkpoint:** pending
